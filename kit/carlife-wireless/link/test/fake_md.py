#!/usr/bin/env python3
"""A phone, for testing carlife-link without a car or a phone.

Speaks the MD (mobile device) side of CarLife over TCP the way the real app
does on Wi-Fi: six listeners, the cmd handshake, the video channel pumping
H.264 Annex-B, and the touch channel reading back what the head unit sends.

It records everything it receives as JSON lines so a test can assert on the
bytes rather than on a log message:

    {"chan": "cmd",   "type": "0x00018001", "body": "08011 000"}
    {"chan": "touch", "type": "0x00068001", "action": 0, "x": 640, "y": 360}

usage: fake_md.py [--port 7240] [--record FILE] [--seconds N] [--size 1280x720]
"""
import argparse
import json
import socket
import struct
import threading
import time

CH = [('cmd', 0), ('video', 1000), ('media', 2000), ('tts', 2001), ('vr', 2002), ('touch', 2100)]

MSG_HU_VERSION = 0x00018001
MSG_MATCH_STATUS = 0x00010002
MSG_MD_INFO = 0x00010004
MSG_VIDEO_INIT = 0x00018007
MSG_VIDEO_INIT_DONE = 0x00010008
MSG_VIDEO_START = 0x00018009
MSG_FOREGROUND = 0x0001001B
MSG_STATISTIC = 0x00018027
MSG_VIDEO_DATA = 0x00020001
MSG_TOUCH_ACTION = 0x00068001
MSG_TOUCH_HARD_KEY = 0x00068008


def varint(v):
    out = bytearray()
    while True:
        b = v & 0x7F
        v >>= 7
        out.append(b | (0x80 if v else 0))
        if not v:
            return bytes(out)


def pb_uint(field, value):
    return varint(field << 3) + varint(value)


def pb_string(field, text):
    data = text.encode()
    return varint((field << 3) | 2) + varint(len(data)) + data


def pb_get_uint(body, want):
    """First varint of `want` in a protobuf message, or None."""
    i = 0
    while i < len(body):
        key, shift = 0, 0
        while True:
            if i >= len(body):
                return None
            c = body[i]
            i += 1
            key |= (c & 0x7F) << shift
            shift += 7
            if not c & 0x80:
                break
        field, wire = key >> 3, key & 7
        if wire == 0:
            v, shift = 0, 0
            while True:
                if i >= len(body):
                    return None
                c = body[i]
                i += 1
                v |= (c & 0x7F) << shift
                shift += 7
                if not c & 0x80:
                    break
            if field == want:
                return v
        elif wire == 2:
            n, shift = 0, 0
            while True:
                if i >= len(body):
                    return None
                c = body[i]
                i += 1
                n |= (c & 0x7F) << shift
                shift += 7
                if not c & 0x80:
                    break
            i += n
        elif wire == 1:
            i += 8
        elif wire == 5:
            i += 4
        else:
            return None
    return None


def annex_b_stream(width, height):
    """A picture in the shape the phone sends it: SPS, PPS and an IDR first,
    then slices. Not a decodable picture - the head unit's framing and its
    SPS/PPS/IDR detection are what this exercises - but every start code and
    every NAL type is where a real stream has it."""
    sps = bytes.fromhex('000000016742001f') + bytes([0xE5, 0x80, 0x50])      # 1280x720-ish
    pps = bytes.fromhex('0000000168CE3C80')
    idr = bytes.fromhex('00000001658884') + bytes((i * 7) & 0xFF for i in range(900))
    slice_ = bytes.fromhex('0000000141') + bytes((i * 13) & 0xFF for i in range(700))
    yield sps + pps + idr
    while True:
        yield slice_


class FakeMD:
    def __init__(self, base, record, size):
        self.base = base
        self.width, self.height = size
        self.record = record
        self.lock = threading.Lock()
        self.stop = threading.Event()
        self.serving = threading.Event()      # VIDEO_START seen: pump pictures
        self.recv = []                        # every message, in order

    # ---- recording ----
    def note(self, chan, typ, body=b'', **extra):
        entry = {'chan': chan, 'type': '0x%08x' % typ, 'body': body.hex()}
        entry.update(extra)
        with self.lock:
            self.recv.append(entry)
            if self.record:
                with open(self.record, 'a', encoding='utf-8') as f:
                    f.write(json.dumps(entry) + '\n')

    def sent(self, count=1):
        with self.lock:
            return len(self.recv)

    # ---- wire helpers ----
    @staticmethod
    def read_exact(conn, n):
        buf = b''
        while len(buf) < n:
            chunk = conn.recv(n - len(buf))
            if not chunk:
                raise ConnectionError('closed')
            buf += chunk
        return buf

    def send_cmd(self, conn, typ, body=b''):
        conn.sendall(struct.pack('>HHI', len(body), 0, typ) + body)

    def send_video(self, conn, payload, ts):
        conn.sendall(struct.pack('>III', len(payload), ts, MSG_VIDEO_DATA) + payload)

    # ---- the cmd channel ----
    def cmd_loop(self, conn):
        while not self.stop.is_set():
            head = self.read_exact(conn, 8)
            length, _pad, typ = struct.unpack('>HHI', head)
            body = self.read_exact(conn, length) if length else b''
            self.note('cmd', typ, body)
            if typ == MSG_HU_VERSION:
                major = pb_get_uint(body, 1) or 0
                self.major = major
                self.send_cmd(conn, MSG_MATCH_STATUS, pb_uint(1, 1))
                self.send_cmd(conn, MSG_MD_INFO, pb_string(1, 'Android') + pb_string(2, 'test') + pb_uint(5, 29))
                self.send_cmd(conn, MSG_FOREGROUND)
            elif typ == MSG_VIDEO_INIT:
                w = pb_get_uint(body, 1) or self.width
                h = pb_get_uint(body, 2) or self.height
                fps = pb_get_uint(body, 3) or 30
                self.note('cmd', MSG_VIDEO_INIT_DONE, b'', w=w, h=h, fps=fps)
                self.send_cmd(conn, MSG_VIDEO_INIT_DONE,
                              pb_uint(1, w) + pb_uint(2, h) + pb_uint(3, fps if 1 <= fps <= 60 else 30))
            elif typ == MSG_VIDEO_START:
                self.serving.set()

    # ---- the video channel ----
    def video_loop(self, conn):
        conn.settimeout(0.2)
        stream = annex_b_stream(self.width, self.height)
        frame = 0
        while not self.stop.is_set():
            if not self.serving.wait(0.1):
                continue
            try:
                self.send_video(conn, next(stream), int(time.time()))
                frame += 1
            except (ConnectionError, OSError):
                return
            time.sleep(1.0 / 30)

    # ---- the touch channel ----
    def touch_loop(self, conn):
        while not self.stop.is_set():
            head = self.read_exact(conn, 8)
            length, _pad, typ = struct.unpack('>HHI', head)
            body = self.read_exact(conn, length) if length else b''
            if typ == MSG_TOUCH_ACTION:
                self.note('touch', typ, body, action=pb_get_uint(body, 1),
                          x=pb_get_uint(body, 2), y=pb_get_uint(body, 3))
            else:
                self.note('touch', typ, body, key=pb_get_uint(body, 1))

    # ---- the audio channels: one PCM block a second, enough to prove the
    #      head unit drains them instead of stalling the phone ----
    def audio_loop(self, conn):
        conn.settimeout(0.2)
        blob = bytes(2560)
        while not self.stop.is_set():
            try:
                conn.sendall(struct.pack('>III', len(blob), int(time.time()), 0x00030006) + blob)
            except (ConnectionError, OSError):
                return
            time.sleep(1.0)

    def serve(self, name, port):
        srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        srv.bind(('127.0.0.1', port))
        srv.listen(4)
        srv.settimeout(0.2)
        print('fake md: %s on %d' % (name, port), flush=True)
        while not self.stop.is_set():
            try:
                conn, _ = srv.accept()
            except socket.timeout:
                continue
            except OSError:
                break
            conn.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            handler = {'cmd': self.cmd_loop, 'video': self.video_loop, 'touch': self.touch_loop,
                       'media': self.audio_loop, 'tts': self.audio_loop, 'vr': self.audio_loop}[name]
            threading.Thread(target=self.guard, args=(handler, conn), daemon=True).start()
        srv.close()

    @staticmethod
    def guard(handler, conn):
        try:
            handler(conn)
        except (ConnectionError, OSError):
            pass
        finally:
            try:
                conn.close()
            except OSError:
                pass

    def start(self):
        self.major = 0
        for name, offset in CH:
            threading.Thread(target=self.serve, args=(name, self.base + offset), daemon=True).start()

    def send_beat(self):
        pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', type=int, default=7240)
    ap.add_argument('--record')
    ap.add_argument('--seconds', type=float, default=30)
    ap.add_argument('--size', default='1280x720')
    args = ap.parse_args()
    w, h = (int(x) for x in args.size.split('x'))
    if args.record:
        open(args.record, 'w', encoding='utf-8').close()
    md = FakeMD(args.port, args.record, (w, h))
    md.start()
    try:
        time.sleep(args.seconds)
    except KeyboardInterrupt:
        pass
    md.stop.set()


if __name__ == '__main__':
    main()
