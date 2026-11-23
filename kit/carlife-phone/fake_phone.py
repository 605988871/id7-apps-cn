#!/usr/bin/env python3
"""Play the phone for kit/carlife-shim's stand-in.

Run this on the machine at the other end of the ENET cable. The shim on the
unit is what makes carlife believe a phone is plugged in; this is what answers
on the wire afterwards. Three TCP listeners, one per CarLife channel:

    port 7240  channel 1   control   [u16 len][u16 0][u32 type] + protobuf
    port 8240  channel 2   video     [u32 len][u32 ts][u32 0x00020001] + h264
    port 9240  channel 3   media     counted, not parsed yet

The shim carries the USB framing (the eight-byte [channel][length] header);
nothing here has to know that a bulk transfer is not a message.

    python fake_phone.py                  handshake, log every command
    python fake_phone.py --h264 out.h264  ... and repeat that stream on video
    python fake_phone.py --selftest       check the packers without a unit

A note on what a successful run looks like: carlife sends HU_PROTOCOL_VERSION,
this answers MATCH_STATUS, then HU_INFO -> MD_INFO, then VIDEO_ENCODER_INIT ->
INIT_DONE, then VIDEO_ENCODER_START. The last one is the point where a real
phone would start encoding; without --h264 there is nothing to send and the
screen stays black by design, not by failure.
"""

import argparse
import os
import socket
import struct
import sys
import threading
import time

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


def log(tag, text):
    print("%s %-5s %s" % (time.strftime("%H:%M:%S"), tag, text), flush=True)


# ---- wire format -----------------------------------------------------------

def pack_cmd(service_type, payload=b""):
    """[u16 payload len][u16 unused][u32 type] + payload, network order."""
    return struct.pack(">HHI", len(payload), 0, service_type) + payload


def unpack_cmd_header(header):
    if len(header) != 8:
        raise ValueError("header must be 8 bytes")
    payload_len, _, service_type = struct.unpack(">HHI", header)
    return payload_len, service_type


def pack_video(data, timestamp_ms):
    return struct.pack(">III", len(data), timestamp_ms & 0xFFFFFFFF, MSG_VIDEO_DATA) + data


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
            sock.sendall(data)
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
            threading.Thread(target=self.read_loop, args=(port, conn), daemon=True).start()

    def read_loop(self, port, conn):
        try:
            if port == CMD_PORT:
                self.read_commands(conn)
            elif port == VIDEO_PORT:
                self.read_video_ack(conn)
            else:
                self.read_media(conn)
        except (OSError, ValueError) as error:
            log(CHAN_NAME[port], "closed: %s" % error)
        finally:
            with self.lock:
                if self.socks.get(port) is conn:
                    self.socks.pop(port, None)
            try:
                conn.close()
            except OSError:
                pass
            if port == VIDEO_PORT:
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

    def read_commands(self, conn):
        while True:
            header = self.recv_exact(conn, 8)
            payload_len, service_type = unpack_cmd_header(header)
            if payload_len > 512 * 1024:
                raise ValueError("implausible payload length %d" % payload_len)
            payload = self.recv_exact(conn, payload_len) if payload_len else b""
            self.handle_command(service_type, payload)

    def read_video_ack(self, conn):
        # The head unit has nothing to say on the video channel; reading it is
        # only here so a close is noticed instead of blocking a dead socket.
        while True:
            chunk = conn.recv(4096)
            if not chunk:
                raise OSError("peer closed")
            log("video", "unexpected %d bytes from unit" % len(chunk))

    def read_media(self, conn):
        total = 0
        while True:
            chunk = conn.recv(65536)
            if not chunk:
                raise OSError("peer closed")
            total += len(chunk)
            log("media", "%d bytes from unit (%d total)" % (len(chunk), total))

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

        interval = 1.0 / float(self.fps)
        log("video", "sending %d bytes as one frame, %d fps" % (len(stream), self.fps))
        next_at = time.monotonic()
        while not self.video_stop.is_set():
            stamp = int(time.monotonic() * 1000)
            if not self.send_on(VIDEO_PORT, pack_video(stream, stamp)):
                log("video", "video channel gone, stopping")
                return
            self.frames_sent += 1
            if self.frames_sent % 30 == 0:
                log("video", "%d frames sent" % self.frames_sent)
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

    # MD_INFO must be readable the way CarLink-Lab reads it.
    md = Phone.md_info()
    fields = pb_parse(md)
    check("md_info carries a platform name", fields.get(1) == b"Android")

    print("\n%s" % ("all checks passed" if ok else "SOMETHING FAILED"))
    return 0 if ok else 1


def loopback():
    """Drive the whole handshake against ourselves, over real sockets.

    The packers passing their own round-trip proves very little; this proves the
    listeners, the reply order and the video start actually work, which is what
    the first run against a unit would otherwise be testing.
    """
    import tempfile

    ok = True

    def check(name, condition):
        nonlocal ok
        print("%-46s %s" % (name, "ok" if condition else "FAIL"))
        ok = ok and condition

    handle, path = tempfile.mkstemp(suffix=".h264")
    with os.fdopen(handle, "wb") as tmp:
        tmp.write(b"\x00\x00\x00\x01\x67\x42\x00\x1e" + b"\xaa" * 64)

    phone = Phone(h264=path, fps=30, quiet=True)
    for port in PORTS:
        threading.Thread(target=phone.serve_port, args=(port,), daemon=True).start()
    time.sleep(0.4)

    cmd = socket.create_connection(("127.0.0.1", CMD_PORT), timeout=3)
    vid = socket.create_connection(("127.0.0.1", VIDEO_PORT), timeout=3)
    time.sleep(0.2)

    def recv_cmd(sock):
        payload_len, service_type = unpack_cmd_header(Phone.recv_exact(sock, 8))
        return service_type, (Phone.recv_exact(sock, payload_len) if payload_len else b"")

    try:
        init = bytes.fromhex("08800f10d005181e")

        cmd.sendall(pack_cmd(MSG_HU_PROTOCOL_VERSION, bytes.fromhex("08021000")))
        kind, body = recv_cmd(cmd)
        check("MATCH_STATUS answered", kind == MSG_MATCH_STATUS and body == b"\x08\x01")

        cmd.sendall(pack_cmd(MSG_HU_INFO, b"\x0a\x05Linux"))
        kind, body = recv_cmd(cmd)
        check("MD_INFO answered", kind == MSG_MD_INFO)
        check("MD_INFO names a platform", pb_parse(body).get(1) == b"Android")

        cmd.sendall(pack_cmd(MSG_VIDEO_ENCODER_INIT, init))
        kind, body = recv_cmd(cmd)
        check("INIT_DONE echoes the init payload",
              kind == MSG_VIDEO_ENCODER_INIT_DONE and body == init)

        cmd.sendall(pack_cmd(MSG_VIDEO_ENCODER_START))
        data_len, _, video_kind = unpack_video_header(Phone.recv_exact(vid, 12))
        data = Phone.recv_exact(vid, data_len)
        check("a video frame arrives after START", video_kind == MSG_VIDEO_DATA and data_len > 0)
        check("frame payload is the file we gave it", data[:4] == b"\x00\x00\x00\x01")
    finally:
        cmd.close()
        vid.close()
        try:
            os.unlink(path)
        except OSError:
            pass

    print("\n%s" % ("loopback ok" if ok else "LOOPBACK FAILED"))
    return 0 if ok else 1


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--h264", help="a raw H.264 stream to repeat on the video channel")
    parser.add_argument("--fps", type=int, default=30, help="video frames per second (default 30)")
    parser.add_argument("--quiet", action="store_true", help="only log events, not every command")
    parser.add_argument("--selftest", action="store_true", help="check the packers and exit")
    parser.add_argument("--loopback", action="store_true",
                        help="run the handshake against our own listeners and exit")
    args = parser.parse_args()

    if args.selftest:
        return selftest()
    if args.loopback:
        return loopback()

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
