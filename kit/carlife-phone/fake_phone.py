#!/usr/bin/env python3
"""Play the phone for kit/carlife-shim's stand-in.

Run this on the machine at the other end of the ENET cable. The shim on the
unit is what makes carlife believe a phone is plugged in; this is what answers
on the wire afterwards. Three TCP listeners, one per CarLife channel:

    port 7240  channel 1   control   [chan][len] + [u16 len][u16 0][u32 type] + protobuf
    port 8240  channel 2   video     [chan][len] + [u32 len][u32 ts][u32 0x00020001] + h264
    port 9240  channel 3   media     counted, not parsed yet

Every write on these ports carries the same eight-byte [chan][len] header the
unit's USB link uses, because the shim forwards messages to TCP unchanged and
parses that header straight back out on the way in. Keeping the header here is
what lets the shim stay a byte pipe with no knowledge of any channel's inner
format - and the shim is the one part that cannot be tested off the car.

One consequence worth knowing: this makes the ports shim-shaped, not
CarLink-Lab-shaped. CarLink-Lab's client writes bare payload on 7240/8240
because the real wireless path has no USB framing; a real phone pointed at
these ports would need the eight bytes stripped, which is a job for the unit
side, not for this test double.

    python fake_phone.py                  handshake, log every command
    python fake_phone.py --h264 out.h264  ... and repeat that stream on video
    python fake_phone.py --selftest       check the packers without a unit

A note on what a successful run looks like: carlife sends HU_PROTOCOL_VERSION,
this answers MATCH_STATUS, then HU_INFO -> MD_INFO, then VIDEO_ENCODER_INIT ->
INIT_DONE, then VIDEO_ENCODER_START. The last one is the point where a real
phone would start encoding; without --h264 there is nothing to send and the
screen stays black by design, not by failure.

Making a stream to give it, if there is no phone recording at hand:

    python h264stream.py make out/test.h264 --seconds 10
    python fake_phone.py --h264 out/test.h264
"""

import argparse
import os
import socket
import struct
import sys
import tempfile
import threading
import time

import h264stream

CMD_PORT = 7240
VIDEO_PORT = 8240
MEDIA_PORT = 9240
PORTS = (CMD_PORT, VIDEO_PORT, MEDIA_PORT)

# Control channel message types, from the unit's own traffic and from
# CarLink-Lab's client. 0x0001xxxx is phone-to-head-unit, 0x00018xxx is the
# other way.
MSG_HU_PROTOCOL_VERSION = 0x00018001
MSG_MATCH_STATUS = 0x00010002
MSG_HU_INFO = 0x00018003
MSG_MD_INFO = 0x00010004
MSG_VIDEO_ENCODER_INIT = 0x00018007
MSG_VIDEO_ENCODER_INIT_DONE = 0x00010008
MSG_VIDEO_ENCODER_START = 0x00018009
MSG_VIDEO_DATA = 0x00020001

CHAN_NAME = {CMD_PORT: "cmd", VIDEO_PORT: "video", MEDIA_PORT: "media"}
CHAN_OF = {CMD_PORT: 1, VIDEO_PORT: 2, MEDIA_PORT: 3}
CHAN_PORT = {1: CMD_PORT, 2: VIDEO_PORT, 3: MEDIA_PORT}


def log(tag, text):
    print("%s %-5s %s" % (time.strftime("%H:%M:%S"), tag, text), flush=True)


# ---- wire format -----------------------------------------------------------

def pack_chan(chan, body):
    """[u32 chan][u32 len] + body, network order.

    The shim's idea of a message. It never looks inside, which is why it can
    carry the control channel's u16 length and the video channel's u32 one in
    the same code path.
    """
    return struct.pack(">II", chan, len(body)) + body


def recv_frame(sock):
    """Read one [chan][len][body] from a socket the shim is writing to."""
    chan, length = struct.unpack(">II", Phone.recv_exact(sock, 8))
    return chan, (Phone.recv_exact(sock, length) if length else b"")

def pack_cmd(service_type, payload=b""):
    """[u16 payload len][u16 unused][u32 type] + payload, network order."""
    return struct.pack(">HHI", len(payload), 0, service_type) + payload


def unpack_cmd_header(header):
    if len(header) != 8:
        raise ValueError("header must be 8 bytes")
    payload_len, _, service_type = struct.unpack(">HHI", header)
    return payload_len, service_type


def pack_video(data, ts_seconds):
    """[u32 len][u32 ts][u32 0x00020001] + one Annex-B NAL.

    ts is Unix seconds, not milliseconds. The unit's own traffic carried
    1795395829 while frames arrived 1-2 ms apart, which is 2026-11-23: a
    millisecond clock cannot hold that number, and a monotonic one would not
    land on today's date.
    """
    return struct.pack(">III", len(data), int(ts_seconds) & 0xFFFFFFFF,
                       MSG_VIDEO_DATA) + data


def video_messages(pictures, ts_seconds):
    """One message per NAL, every NAL of a picture sharing one timestamp.

    This is what the unit's traffic showed: a picture is not one message. A
    four-NAL keyframe arrived as four transfers, all with the same ts, and the
    decoder was fed NAL by NAL. Sending the picture whole instead is the
    tempting shortcut and looks identical on the wire until the screen stays
    black, because the unit's parser takes the first start code and drops the
    rest of the buffer.
    """
    out = []
    for picture in pictures:
        for nal in picture:
            out.append(pack_video(nal, ts_seconds))
    return out


def unpack_video_header(header):
    if len(header) != 12:
        raise ValueError("video header must be 12 bytes")
    return struct.unpack(">III", header)


# ---- protobuf, the little that the handshake needs -------------------------

def pb_varint(value):
    out = bytearray()
    value &= 0xFFFFFFFF
    while True:
        byte = value & 0x7F
        value >>= 7
        if value:
            out.append(byte | 0x80)
        else:
            out.append(byte)
            return bytes(out)


def pb_field_varint(number, value):
    return pb_varint(number << 3) + pb_varint(value)


def pb_field_string(number, text):
    raw = text.encode("utf-8")
    return pb_varint((number << 3) | 2) + pb_varint(len(raw)) + raw


def pb_parse(data):
    """Field number -> value, for varint and length-delimited fields only."""
    out = {}
    i = 0
    while i < len(data):
        tag = 0
        shift = 0
        while i < len(data):
            b = data[i]
            i += 1
            tag |= (b & 0x7F) << shift
            if not b & 0x80:
                break
            shift += 7
        number, wire = tag >> 3, tag & 7
        if wire == 0:
            value = 0
            shift = 0
            while i < len(data):
                b = data[i]
                i += 1
                value |= (b & 0x7F) << shift
                if not b & 0x80:
                    break
                shift += 7
            out[number] = value
        elif wire == 2:
            length = 0
            shift = 0
            while i < len(data):
                b = data[i]
                i += 1
                length |= (b & 0x7F) << shift
                if not b & 0x80:
                    break
                shift += 7
            out[number] = data[i:i + length]
            i += length
        else:
            break
    return out


# ---- the phone -------------------------------------------------------------

class Phone:
    def __init__(self, h264=None, fps=30, quiet=False):
        self.h264 = h264
        self.fps = fps
        self.quiet = quiet
        self.lock = threading.Lock()
        self.socks = {}
        self.video_stop = threading.Event()
        self.video_thread = None
        self.frames_sent = 0
        self.media_messages = 0
        self.media_bytes = 0
        self.width = 1920
        self.height = 720
        self.frame_rate = 30

    # -- plumbing --
    def send_on(self, port, data):
        with self.lock:
            sock = self.socks.get(port)
        if sock is None:
            return False
        try:
            sock.sendall(pack_chan(CHAN_OF[port], data))
            return True
        except OSError as error:
            log("send", "port %d failed: %s" % (port, error))
            return False

    def send_cmd(self, service_type, payload=b""):
        ok = self.send_on(CMD_PORT, pack_cmd(service_type, payload))
        if ok and not self.quiet:
            log("tx", "cmd 0x%08x len=%d" % (service_type, len(payload)))
        return ok

    # -- listeners --
    def serve_port(self, port):
        listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        listener.bind(("0.0.0.0", port))
        listener.listen(4)
        log("open", "%s listening on %d" % (CHAN_NAME[port], port))
        while True:
            conn, addr = listener.accept()
            conn.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            log(CHAN_NAME[port], "connected from %s:%d" % addr)
            with self.lock:
                old = self.socks.get(port)
                self.socks[port] = conn
            if old is not None:
                try:
                    old.close()
                except OSError:
                    pass
            # A reconnect after the stream has started means carlife restarted
            # or the cable blinked; it will not send START again, so pick the
            # stream back up here or the screen freezes on the last picture.
            if port == VIDEO_PORT and self.h264 and self.frames_sent:
                self.video_stop.clear()
                if not (self.video_thread and self.video_thread.is_alive()):
                    self.video_thread = threading.Thread(target=self.video_loop, daemon=True)
                    self.video_thread.start()
            threading.Thread(target=self.read_loop, args=(port, conn), daemon=True).start()

    def read_loop(self, port, conn):
        try:
            self.read_framed(port, conn)
        except (OSError, ValueError) as error:
            log(CHAN_NAME[port], "closed: %s" % error)
        finally:
            with self.lock:
                # Only the socket that is still current may stop the stream. A
                # superseded one closes late, after its replacement has already
                # been accepted, and would otherwise kill the new stream.
                current = self.socks.get(port) is conn
                if current:
                    self.socks.pop(port, None)
            try:
                conn.close()
            except OSError:
                pass
            if port == VIDEO_PORT and current:
                self.video_stop.set()

    @staticmethod
    def recv_exact(conn, count):
        buf = b""
        while len(buf) < count:
            chunk = conn.recv(count - len(buf))
            if not chunk:
                raise OSError("peer closed")
            buf += chunk
        return buf

    def read_framed(self, port, conn):
        """Strip the shim's header, then dispatch on the channel number.

        Reading the channel from the header rather than assuming it from the
        port is deliberate: if the shim ever hands a message to the wrong
        socket, this says so in the log instead of parsing it as the wrong kind
        and producing a puzzle to debug at the car.
        """
        while True:
            chan, length = struct.unpack(">II", self.recv_exact(conn, 8))
            if length > 512 * 1024:
                raise ValueError("implausible message length %d" % length)
            body = self.recv_exact(conn, length) if length else b""
            if chan == 1:
                self.handle_command_message(body)
            elif chan == 2:
                log("video", "unexpected %d bytes from unit" % len(body))
            elif chan == 3:
                self.media_bytes += len(body)
                if self.media_messages % 50 == 0 or self.media_messages < 3:
                    log("media", "%d bytes (%d total, %d messages)"
                        % (len(body), self.media_bytes, self.media_messages + 1))
                self.media_messages += 1
            else:
                log("shim", "message for unknown channel %d, ignored" % chan)
                continue
            if chan != CHAN_OF[port]:
                log(CHAN_NAME[port], "channel %d arrived on the %s port"
                    % (chan, CHAN_NAME[port]))

    def handle_command_message(self, body):
        if len(body) < 8:
            log("cmd", "short message (%d bytes), ignored" % len(body))
            return
        payload_len, service_type = unpack_cmd_header(body[:8])
        if payload_len > len(body) - 8:
            log("cmd", "length field %d exceeds message (%d), ignored"
                % (payload_len, len(body)))
            return
        self.handle_command(service_type, body[8:8 + payload_len])

    # -- control channel logic --
    def handle_command(self, service_type, payload):
        if not self.quiet:
            log("rx", "cmd 0x%08x len=%d %s" % (service_type, len(payload), payload[:48].hex()))

        if service_type == MSG_HU_PROTOCOL_VERSION:
            fields = pb_parse(payload)
            log("cmd", "protocol %d.%d" % (fields.get(1, 0), fields.get(2, 0)))
            self.send_cmd(MSG_MATCH_STATUS, b"\x08\x01")

        elif service_type == MSG_HU_INFO:
            log("cmd", "head unit wants identity")
            self.send_cmd(MSG_MD_INFO, self.md_info())

        elif service_type == MSG_VIDEO_ENCODER_INIT:
            fields = pb_parse(payload)
            self.width = int(fields.get(1, self.width))
            self.height = int(fields.get(2, self.height))
            self.frame_rate = int(fields.get(3, self.frame_rate))
            log("cmd", "encoder %dx%d@%d" % (self.width, self.height, self.frame_rate))
            self.send_cmd(MSG_VIDEO_ENCODER_INIT_DONE, payload)

        elif service_type == MSG_VIDEO_ENCODER_START:
            log("cmd", "start video")
            self.start_video()

        else:
            log("cmd", "unhandled 0x%08x" % service_type)

    @staticmethod
    def md_info():
        parts = [
            pb_field_string(1, "Android"),
            pb_field_string(13, "carlife-phone"),
            pb_field_string(14, "SM-G9730"),
            pb_field_varint(21, 29),
        ]
        return b"".join(parts)

    # -- video --
    def start_video(self):
        if self.h264 is None:
            log("video", "no --h264 given: handshake only, nothing to send")
            return
        self.video_stop.clear()
        if self.video_thread and self.video_thread.is_alive():
            return
        self.video_thread = threading.Thread(target=self.video_loop, daemon=True)
        self.video_thread.start()

    def video_loop(self):
        try:
            with open(self.h264, "rb") as handle:
                stream = handle.read()
        except OSError as error:
            log("video", "cannot read %s: %s" % (self.h264, error))
            return
        if not stream:
            log("video", "%s is empty" % self.h264)
            return

        info = h264stream.describe(stream)
        pictures = info["units"]
        if not pictures:
            log("video", "%s has no Annex-B start code; not a raw H.264 stream" % self.h264)
            return
        geometry = info["geometry"]
        if geometry:
            width, height = geometry[0], geometry[1]
            if (width, height) != (self.width, self.height):
                log("video", "WARNING stream is %dx%d but the unit asked for %dx%d"
                    % (width, height, self.width, self.height))
            else:
                log("video", "%dx%d, %d pictures, %d keyframes, %.1f KiB"
                    % (width, height, len(pictures), info["keyframes"],
                       info["bytes"] / 1024.0))
        else:
            log("video", "%d pictures, %d bytes (no SPS found, cannot check geometry)"
                % (len(pictures), info["bytes"]))

        interval = 1.0 / float(self.fps)
        index = 0
        next_at = time.monotonic()
        while not self.video_stop.is_set():
            picture = pictures[index]
            index += 1
            if index >= len(pictures):
                index = 0
                if self.frames_sent:
                    log("video", "stream wrapped, %d pictures so far" % self.frames_sent)
            # One timestamp per picture, and it is wall-clock seconds because
            # that is what the unit's own phone sent.
            stamp = int(time.time())
            for message in video_messages([picture], stamp):
                if not self.send_on(VIDEO_PORT, message):
                    log("video", "video channel gone, stopping")
                    return
            self.frames_sent += 1
            if self.frames_sent % 30 == 0:
                log("video", "%d pictures sent" % self.frames_sent)
            next_at += interval
            delay = next_at - time.monotonic()
            if delay > 0:
                time.sleep(delay)
            else:
                next_at = time.monotonic()   # fell behind: drop, do not catch up


# ---- selftest --------------------------------------------------------------

def selftest():
    ok = True

    def check(name, condition):
        nonlocal ok
        print("%-46s %s" % (name, "ok" if condition else "FAIL"))
        ok = ok and condition

    # Command frame: the length field is the payload only, type is at offset 4,
    # and the whole thing is network order - this is the layout the unit's own
    # traffic showed and the one CarLink-Lab writes.
    frame = pack_cmd(MSG_HU_PROTOCOL_VERSION, b"\x08\x02\x10\x00")
    check("cmd frame is 8-byte header + payload", len(frame) == 12)
    check("cmd header big-endian length", frame[0:2] == b"\x00\x04")
    check("cmd header type at offset 4", frame[4:8] == b"\x00\x01\x80\x01")
    check("cmd header round-trips", unpack_cmd_header(frame[:8]) == (4, MSG_HU_PROTOCOL_VERSION))

    # A real HU_PROTOCOL_VERSION from the unit: 0004 0001 | 00018001 | 08 02 10 00
    unit = bytes.fromhex("000400010001800108021000")
    length, kind = unpack_cmd_header(unit[:8])
    check("unit's own version packet parses", (length, kind) == (4, MSG_HU_PROTOCOL_VERSION))
    fields = pb_parse(unit[8:8 + length])
    check("protocol decodes as 2.0", (fields.get(1), fields.get(2)) == (2, 0))

    # Video frame: [len][ts][0x00020001] + data, which is what the unit's 970
    # byte channel-2 message looked like once the USB header was off.
    payload = bytes(range(16))
    video = pack_video(payload, 0x6B039101)
    check("video frame is 12-byte header + data", len(video) == 28)
    check("video header round-trips", unpack_video_header(video[:12]) == (16, 0x6B039101, MSG_VIDEO_DATA))
    check("video data intact", video[12:] == payload)

    # The unit's VIDEO_ENCODER_INIT payload: 08 80 0f 10 d0 05 18 1e = 1920x720@30
    init = bytes.fromhex("08800f10d005181e")
    fields = pb_parse(init)
    check("encoder init decodes 1920x720@30",
          (fields.get(1), fields.get(2), fields.get(3)) == (1920, 720, 30))

    # A picture is several messages, not one: the unit's keyframe arrived as
    # four, all carrying the same ts. Sending it whole is the shortcut that
    # leaves the screen black.
    def nal(kind, payload=b"\xaa" * 4):
        return b"\x00\x00\x00\x01" + bytes([0x60 | (kind & 0x1F)]) + payload

    picture = [nal(9), nal(7), nal(8), nal(5)]
    sent = video_messages([picture], 1795395829)
    check("4 NAL picture becomes 4 messages", len(sent) == 4)
    check("every message carries one NAL",
          [unpack_video_header(m[:12])[0] for m in sent]
          == [len(n) for n in picture])
    check("messages of a picture share one timestamp",
          len(set(unpack_video_header(m[:12])[1] for m in sent)) == 1)
    check("timestamp is Unix seconds",
          unpack_video_header(sent[0][:12])[1] == 1795395829)
    check("payload is Annex-B, byte for byte",
          b"".join(m[12:] for m in sent) == b"".join(picture))

    # MD_INFO must be readable the way CarLink-Lab reads it.
    md = Phone.md_info()
    fields = pb_parse(md)
    check("md_info carries a platform name", fields.get(1) == b"Android")

    print("\n%s" % ("all checks passed" if ok else "SOMETHING FAILED"))
    return 0 if ok else 1


def loopback(stream_path=None):
    """Drive the whole handshake against ourselves, over real sockets.

    The packers passing their own round-trip proves very little; this proves the
    listeners, the reply order and the video start actually work, which is what
    the first run against a unit would otherwise be testing. Given a real .h264,
    it does more: sends the whole file through the video channel and compares
    what came out against what went in, byte for byte, then decodes the result.
    A splitter that drops a start code or reorders a parameter set looks fine in
    the log and shows a black screen in the car; this catches it at the desk.
    """
    if stream_path:
        return _replay_check(stream_path)

    ok = True

    def check(name, condition):
        nonlocal ok
        print("%-46s %s" % (name, "ok" if condition else "FAIL"))
        ok = ok and condition

    def nal(kind, payload=b"\xaa" * 4):
        return b"\x00\x00\x00\x01" + bytes([0x60 | (kind & 0x1F)]) + payload

    # Two pictures, the first with parameter sets, so the loop is exercised the
    # way a real keyframe plus delta frame would be.
    stream = b"".join([nal(9), nal(7), nal(8), nal(5, b"\xbb" * 32),
                       nal(9), nal(1, b"\xcc" * 16)])

    handle, path = tempfile.mkstemp(suffix=".h264")
    with os.fdopen(handle, "wb") as tmp:
        tmp.write(stream)

    phone = Phone(h264=path, fps=30, quiet=True)
    for port in PORTS:
        threading.Thread(target=phone.serve_port, args=(port,), daemon=True).start()
    time.sleep(0.4)

    cmd = socket.create_connection(("127.0.0.1", CMD_PORT), timeout=3)
    vid = socket.create_connection(("127.0.0.1", VIDEO_PORT), timeout=3)
    time.sleep(0.2)

    def recv_cmd(sock):
        chan, body = recv_frame(sock)
        payload_len, service_type = unpack_cmd_header(body[:8])
        if chan != 1:
            raise ValueError("expected channel 1, got %d" % chan)
        return service_type, body[8:8 + payload_len]

    try:
        init = bytes.fromhex("08800f10d005181e")

        cmd.sendall(pack_chan(1, pack_cmd(MSG_HU_PROTOCOL_VERSION, bytes.fromhex("08021000"))))
        kind, body = recv_cmd(cmd)
        check("MATCH_STATUS answered", kind == MSG_MATCH_STATUS and body == b"\x08\x01")

        cmd.sendall(pack_chan(1, pack_cmd(MSG_HU_INFO, b"\x0a\x05Linux")))
        kind, body = recv_cmd(cmd)
        check("MD_INFO answered", kind == MSG_MD_INFO)
        check("MD_INFO names a platform", pb_parse(body).get(1) == b"Android")

        cmd.sendall(pack_chan(1, pack_cmd(MSG_VIDEO_ENCODER_INIT, init)))
        kind, body = recv_cmd(cmd)
        check("INIT_DONE echoes the init payload",
              kind == MSG_VIDEO_ENCODER_INIT_DONE and body == init)

        cmd.sendall(pack_chan(1, pack_cmd(MSG_VIDEO_ENCODER_START)))

        def recv_video(sock):
            chan, body = recv_frame(sock)
            if chan != 2:
                raise ValueError("expected channel 2, got %d" % chan)
            data_len, stamp, video_kind = unpack_video_header(body[:12])
            return body[12:12 + data_len], stamp, video_kind

        got = []
        for _ in range(6):                       # four NALs, then the wrap starts
            payload, stamp, kind = recv_video(vid)
            if kind != MSG_VIDEO_DATA:
                break
            got.append((payload, stamp))

        check("video arrives after START", len(got) >= 5)
        check("messages are NAL units, not pictures",
              [len(p) for p, _ in got[:4]] == [9, 9, 9, 37])
        check("a picture's NALs share one timestamp",
              len(set(s for _, s in got[:4])) == 1)
        check("second picture gets its own timestamp",
              got[4][1] >= got[0][1])
        check("first four messages are the first picture exactly",
              b"".join(p for p, _ in got[:4]) == stream[:64])
    finally:
        cmd.close()
        vid.close()
        try:
            os.unlink(path)
        except OSError:
            pass

    print("\n%s" % ("loopback ok" if ok else "LOOPBACK FAILED"))
    return 0 if ok else 1


def _replay_check(path):
    """Send a real file through the video channel and prove nothing was lost."""
    original = open(path, "rb").read()
    info = h264stream.describe(original)
    if not info["units"]:
        print("%s is not an Annex-B stream" % path)
        return 1

    # Pacing is not what is under test here, so run it far faster than 30 fps
    # and keep the check to a couple of seconds.
    phone = Phone(h264=path, fps=400, quiet=True)
    for port in PORTS:
        threading.Thread(target=phone.serve_port, args=(port,), daemon=True).start()
    time.sleep(0.3)

    cmd = socket.create_connection(("127.0.0.1", CMD_PORT), timeout=5)
    vid = socket.create_connection(("127.0.0.1", VIDEO_PORT), timeout=5)
    vid.settimeout(10)
    time.sleep(0.2)

    got = bytearray()
    messages = 0
    try:
        cmd.sendall(pack_chan(1, pack_cmd(MSG_VIDEO_ENCODER_START)))
        while len(got) < len(original):
            chan, body = recv_frame(vid)
            if chan != 2:
                print("message for channel %d arrived on the video port" % chan)
                return 1
            data_len, _, kind = unpack_video_header(body[:12])
            if kind != MSG_VIDEO_DATA:
                print("unexpected message type 0x%08x on the video channel" % kind)
                return 1
            got += body[12:12 + data_len]
            messages += 1
    finally:
        try:
            cmd.close()
            vid.close()
        except OSError:
            pass

    same = bytes(got[:len(original)]) == original
    print("%-46s %s" % ("all %d bytes came back unchanged" % len(original),
                        "ok" if same else "FAIL"))
    print("%-46s %s" % ("%d messages for %d pictures" % (messages, len(info["units"])),
                        "ok" if messages >= len(info["units"]) else "FAIL"))

    if same:
        handle, tmp = tempfile.mkstemp(suffix=".h264")
        with os.fdopen(handle, "wb") as out:
            out.write(bytes(got[:len(original)]))
        try:
            result = h264stream.decode_check(tmp)
            if result:
                good, frames = result
                expected = len(info["units"])
                print("%-46s %s" % ("reassembled stream decodes to %s frames" % frames,
                                    "ok" if good and frames == expected else "FAIL"))
                if not (good and frames == expected):
                    same = False
        finally:
            try:
                os.unlink(tmp)
            except OSError:
                pass

    print("\n%s" % ("replay ok" if same else "REPLAY FAILED"))
    return 0 if same else 1


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--h264", help="a raw H.264 stream to repeat on the video channel")
    parser.add_argument("--fps", type=int, default=30, help="video frames per second (default 30)")
    parser.add_argument("--quiet", action="store_true", help="only log events, not every command")
    parser.add_argument("--selftest", action="store_true", help="check the packers and exit")
    parser.add_argument("--loopback", nargs="?", const="", default=None, metavar="FILE",
                        help="run the handshake against our own listeners and exit; "
                             "give a .h264 to replay it and check nothing is lost")
    args = parser.parse_args()

    if args.selftest:
        return selftest()
    if args.loopback is not None:
        return loopback(args.loopback or None)

    if args.h264 and not os.path.exists(args.h264):
        print("no such file: %s" % args.h264, file=sys.stderr)
        return 2

    phone = Phone(h264=args.h264, fps=args.fps, quiet=args.quiet)
    threads = []
    for port in PORTS:
        thread = threading.Thread(target=phone.serve_port, args=(port,), daemon=True)
        thread.start()
        threads.append(thread)

    print("waiting for the unit; handshake needs no input, Ctrl-C to stop", flush=True)
    try:
        while True:
            time.sleep(1.0)
    except KeyboardInterrupt:
        print("\nstopped")
        return 0


if __name__ == "__main__":
    sys.exit(main())
