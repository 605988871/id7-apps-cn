#!/usr/bin/env python3
"""Send raw NV12 frames to the CarLife Map app on the head unit.

Reads NV12 frames from stdin (width * height * 3/2 bytes each) and writes them
to the head unit as frames the app understands:

    u32 magic = 0x464d4c43
    u32 len   = frame bytes (must be w * (h + h//2))
    u32 seq   = frame number
    len bytes of YUV 4:2:0 (NV12 layout, which is the atlas layout)

Example:

    ffmpeg -i capture.mp4 -vf scale=1088:480 -pix_fmt nv12 -f rawvideo - \\
      | python3 carlife_frame_sender.py --host 10.0.0.2 --port 20558

Run `ffmpeg ... -re` for a live source so frames arrive at real-time speed.
"""

import argparse
import socket
import struct
import sys

MAGIC = 0x464D4C43


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=20558)
    ap.add_argument("--width", type=int, default=1088)
    ap.add_argument("--height", type=int, default=480)
    args = ap.parse_args()

    size = args.width * (args.height + args.height // 2)
    if args.height % 2:
        ap.error("height must be even")

    sock = socket.create_connection((args.host, args.port), timeout=10)
    seq = 0
    try:
        while True:
            frame = sys.stdin.buffer.read(size)
            if not frame:
                break
            if len(frame) != size:
                sys.stderr.write("short frame: %d of %d bytes\n" % (len(frame), size))
                break
            sock.sendall(struct.pack("<III", MAGIC, size, seq) + frame)
            seq += 1
    except (BrokenPipeError, ConnectionResetError) as exc:
        sys.stderr.write("connection lost: %s\n" % exc)
    finally:
        sock.close()
    sys.stderr.write("sent %d frames\n" % seq)


if __name__ == "__main__":
    main()
