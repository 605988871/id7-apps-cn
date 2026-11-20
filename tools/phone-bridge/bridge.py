#!/usr/bin/env python3
"""Bridge a phone's screen into the CarLife Map app on the head unit.

The point of this tool is to find out, before anyone writes an Android app,
whether the phone-side route is worth taking:

  1. What does a map-only picture look like on the cluster, when nobody has to
     crop a head-unit mirror?  Crop it here instead, where the coordinates are
     stable and known - or not at all.
  2. Can the car's Wi-Fi carry raw NV12 at a usable rate?  If yes the car needs
     no decoder at all: the app already takes raw frames over TCP, which is what
     `kit/tools/carlife_frame_sender.py` uses.

Nothing here is installed on the car. The phone is captured with `adb` (the same
mechanism `scrcpy` and `screenrecord` use), decoded and scaled by `ffmpeg` on the
PC, and sent to the app's TCP frame source.

    python bridge.py probe
    python bridge.py run  --host 192.168.1.50 --crop 1080x2280+0+330 --fps 10
    python bridge.py file clip.mp4 --host 192.168.1.50
    python bridge.py selftest

Requires Python 3.8+ (no third-party modules), plus adb and ffmpeg on the PATH.

Frame format on the wire, little endian, same as the app's other sources:

    u32 magic = 0x464d4c43  ('CLMF')
    u32 len   = w * (h + h//2)
    u32 seq   = frame counter
    len bytes of 4:2:0 (NV12, which is the atlas layout the cluster wants)
"""

import argparse
import os
import shutil
import socket
import struct
import subprocess
import sys
import threading
import time

MAGIC = 0x464D4C43
HEAD = 12
W, H = 1088, 480           # the cluster map slot; the app's TCP source expects this
FRAME = W * (H + H // 2)   # 783360 bytes = 765 KB


def die(msg):
    sys.stderr.write('bridge: ' + msg + '\n')
    raise SystemExit(1)


def find_tool(name, explicit=None, extra=()):
    if explicit:
        if os.path.exists(explicit):
            return explicit
        die('%s does not exist: %s' % (name, explicit))
    p = shutil.which(name)
    if p:
        return p
    for c in extra:
        if os.path.exists(c):
            return c
    return None


def find_adb(explicit=None):
    cands = []
    if os.environ.get('ANDROID_HOME'):
        cands.append(os.path.join(os.environ['ANDROID_HOME'], 'platform-tools', 'adb.exe'))
    if os.environ.get('LOCALAPPDATA'):
        cands.append(os.path.join(os.environ['LOCALAPPDATA'],
                                  'Android', 'Sdk', 'platform-tools', 'adb.exe'))
    cands += ['C:/platform-tools/adb.exe', '/usr/local/bin/adb', '/opt/homebrew/bin/adb']
    p = find_tool('adb', explicit, cands)
    if not p:
        die('adb not found. Install Android platform-tools and put adb on the PATH, '
            'or pass --adb PATH.')
    return p


def find_ffmpeg(explicit=None):
    p = find_tool('ffmpeg', explicit, ['C:/ffmpeg/bin/ffmpeg.exe', '/usr/local/bin/ffmpeg'])
    if not p:
        die('ffmpeg not found. Install it (Windows: winget install Gyan.FFmpeg, '
            'macOS: brew install ffmpeg) or pass --ffmpeg PATH.')
    return p


def adb_run(adb, *a):
    return subprocess.run([adb] + list(a), capture_output=True, text=True)


# --------------------------------------------------------------------- probe

def probe(args):
    adb = find_adb(args.adb)
    ff = shutil.which('ffmpeg') or '(missing - file/run will not work)'

    print('tools')
    print('  adb    : ' + adb)
    print('  ffmpeg : ' + ff)
    print('  python : ' + sys.version.split()[0])
    print('  frame  : %dx%d = %d bytes (%.0f KB)' % (W, H, FRAME, FRAME / 1024))

    out = adb_run(adb, 'devices', '-l').stdout.strip()
    print('\ndevices')
    for line in out.splitlines()[1:]:
        print('  ' + line)
    if not any('\tdevice' in l for l in out.splitlines()):
        die('no authorised device. Enable USB debugging, then accept the prompt on the phone.')

    print('\nphone')
    for k in ('ro.product.model', 'ro.product.brand', 'ro.build.version.release',
              'ro.build.version.sdk'):
        print('  %-24s %s' % (k, adb_run(adb, 'shell', 'getprop', k).stdout.strip()))
    print('  %-24s %s' % ('wm size', adb_run(adb, 'shell', 'wm size').stdout.strip()))
    print('  %-24s %s' % ('wm density', adb_run(adb, 'shell', 'wm density').stdout.strip()))

    # A phone that drives a car screen usually does it from a second display.
    # Capturing that display alone is the difference between "the car's screen"
    # and "whatever the phone happens to be showing".
    d = adb_run(adb, 'shell', 'dumpsys', 'display')
    print('\ndisplays  (capture one with --display-id N)')
    shown = 0
    for line in d.stdout.splitlines():
        s = line.strip()
        if any(k in s for k in ('mDisplayId=', 'DisplayDeviceInfo', 'uniqueId', 'mBaseDisplayInfo')):
            print('  ' + s[:150])
            shown += 1
            if shown >= 24:
                print('  ...')
                break
    if not shown:
        print('  (dumpsys said nothing useful; --display-id 0 is the phone screen)')

    print('\nbandwidth, raw NV12 (a plain 2.4 GHz link is about 100-300 Mbit/s)')
    for fps in (5, 10, 15, 20):
        print('  %2d fps  %5.1f MB/s  %6.1f Mbit/s'
              % (fps, FRAME * fps / 1e6, FRAME * fps * 8 / 1e6))


# ------------------------------------------------------------------- ffmpeg

def ffmpeg_chain(args):
    """Crop first, then scale: cropping after scaling moves the edges.

    --fit is the whole argument of this experiment.
      cover  fill 1088x480 and cut the overflow (what the car-side crop does)
      fit    the whole rectangle, bars at the sides, nothing lost
      squash stretch into the slot: wrong geometry, but proves the pipe
    """
    parts = []
    if args.crop:
        parts.append('crop=' + args.crop.replace('x', ':').replace('+', ':'))
    w, h = args.size.lower().split('x')
    if args.fit == 'cover':
        parts.append('scale=%s:%s:force_original_aspect_ratio=increase' % (w, h))
        parts.append('crop=%s:%s' % (w, h))
    elif args.fit == 'fit':
        parts.append('scale=%s:%s:force_original_aspect_ratio=decrease' % (w, h))
        parts.append('pad=%s:%s:(ow-iw)/2:(oh-ih)/2' % (w, h))
    else:
        parts.append('scale=%s:%s' % (w, h))
    if args.fps:
        parts.append('fps=%d' % args.fps)
    return ','.join(parts)


def ffmpeg_cmd(ffmpeg, args, source_input):
    return [ffmpeg, '-hide_banner', '-loglevel', 'warning',
            '-fflags', 'nobuffer', '-flags', 'low_delay',
            '-f', 'h264', '-i', source_input,
            '-vf', ffmpeg_chain(args),
            '-pix_fmt', 'nv12', '-f', 'rawvideo', 'pipe:1']


def capture_cmd(adb, args):
    """screenrecord writes raw H.264 to stdout.

    It stops itself after --time-limit (180 s is the device maximum), so the
    caller restarts it: a second of black between chunks is the price of using
    the stock recorder instead of a purpose-built app.
    """
    cmd = [adb, 'exec-out', 'screenrecord', '--output-format=h264',
           '--bit-rate', args.bitrate, '--time-limit', str(args.chunk)]
    if args.display_id is not None:
        cmd += ['--display-id', str(args.display_id)]
    if args.capture_size:
        cmd += ['--size', args.capture_size]
    cmd += ['-']
    return cmd


# ------------------------------------------------------------------- sender

def connect(host, port, tries=30):
    last = None
    for _ in range(tries):
        try:
            s = socket.create_connection((host, port), timeout=5)
            s.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            return s
        except OSError as e:
            last = e
            time.sleep(1)
    die('cannot reach %s:%d (%s). The app must be running with Picture source = '
        'Network (TCP), and its carlife.json must say {"tcpListen": true}.'
        % (host, port, last))


def send_frames(stream, sock, seq=0, limit=None, preview=None, quiet=False):
    """Read fixed-size NV12 frames from `stream` and write them to the car."""
    sent = 0
    t0 = time.time()
    try:
        while True:
            frame = stream.read(FRAME)
            if not frame or len(frame) != FRAME:
                break
            sock.sendall(struct.pack('<III', MAGIC, FRAME, seq))
            sock.sendall(frame)
            if seq == 0 and preview:
                write_bmp(preview, frame, W, H)
                sys.stderr.write('first frame -> %s\n' % preview)
            seq += 1
            sent += 1
            if not quiet and sent % 30 == 0:
                dt = time.time() - t0
                sys.stderr.write('%d frames, %.1f fps, %.1f Mbit/s\n'
                                 % (sent, sent / dt, FRAME * sent * 8 / dt / 1e6))
            if limit and sent >= limit:
                break
    except (BrokenPipeError, ConnectionResetError) as e:
        sys.stderr.write('car went away: %s\n' % e)
    if not quiet:
        sys.stderr.write('sent %d frames\n' % sent)
    return seq


def write_bmp(path, frame, w, h):
    """Luma only: enough to judge framing, which is what this is for."""
    row = w * 3
    pad = (4 - row % 4) % 4
    data = bytearray((row + pad) * h)
    for y in range(h):
        src = y * w
        dst = (h - 1 - y) * (row + pad)
        for x in range(w):
            o = dst + x * 3
            v = frame[src + x]
            data[o] = data[o + 1] = data[o + 2] = v
    hdr = bytearray(54)
    hdr[0:2] = b'BM'
    struct.pack_into('<I', hdr, 2, 54 + len(data))
    struct.pack_into('<I', hdr, 10, 54)
    struct.pack_into('<I', hdr, 14, 40)
    struct.pack_into('<i', hdr, 18, w)
    struct.pack_into('<i', hdr, 22, h)
    struct.pack_into('<H', hdr, 26, 1)
    struct.pack_into('<H', hdr, 28, 24)
    struct.pack_into('<I', hdr, 34, len(data))
    with open(path, 'wb') as f:
        f.write(hdr)
        f.write(data)


# --------------------------------------------------------------------- modes

def do_run(args):
    adb = find_adb(args.adb)
    ffmpeg = find_ffmpeg(args.ffmpeg)
    cap_cmd = capture_cmd(adb, args)
    ff_cmd = ffmpeg_cmd(ffmpeg, args, 'pipe:0')
    if args.verbose:
        print('capture: ' + ' '.join(cap_cmd))
        print('decode : ' + ' '.join(ff_cmd))

    sock = connect(args.host, args.port)
    seq = 0
    try:
        while True:
            cap = subprocess.Popen(cap_cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
            ff = subprocess.Popen(ff_cmd, stdin=cap.stdout, stdout=subprocess.PIPE)
            cap.stdout.close()              # ffmpeg owns the read end now
            try:
                seq = send_frames(ff.stdout, sock, seq, args.frames, args.preview,
                                  args.quiet)
            finally:
                for p in (ff, cap):
                    if p.poll() is None:
                        p.kill()
            if not args.loop or (args.frames and seq >= args.frames):
                break
            if not args.quiet:
                sys.stderr.write('capture chunk ended, restarting\n')
            time.sleep(0.5)
    finally:
        sock.close()


def do_file(args):
    ffmpeg = find_ffmpeg(args.ffmpeg)
    ff_cmd = [ffmpeg, '-hide_banner', '-loglevel', 'warning', '-re',
              '-i', args.file, '-vf', ffmpeg_chain(args),
              '-pix_fmt', 'nv12', '-f', 'rawvideo', 'pipe:1']
    if args.verbose:
        print('decode : ' + ' '.join(ff_cmd))
    sock = connect(args.host, args.port)
    ff = subprocess.Popen(ff_cmd, stdout=subprocess.PIPE)
    try:
        send_frames(ff.stdout, sock, 0, args.frames, args.preview, args.quiet)
    finally:
        if ff.poll() is None:
            ff.kill()
        sock.close()


# ------------------------------------------------------------------ selftest

def selftest(args):
    """Run the sender against a receiver that parses frames the way the app
    does. This is the part that can be wrong without anyone noticing: a header
    one field out of step is a link that looks alive and shows nothing."""
    srv = socket.socket()
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(('127.0.0.1', 0))
    srv.listen(1)
    port = srv.getsockname()[1]
    got = []
    errors = []

    def server():
        c, _ = srv.accept()
        buf = b''
        try:
            while len(got) < 5:
                d = c.recv(1 << 20)
                if not d:
                    break
                buf += d
                while len(buf) >= HEAD:
                    magic, ln, seq = struct.unpack_from('<III', buf, 0)
                    if magic != MAGIC:
                        errors.append('magic %08x' % magic)
                        return
                    if ln != FRAME:
                        errors.append('len %d' % ln)
                        return
                    if len(buf) < HEAD + ln:
                        break
                    payload = buf[HEAD:HEAD + ln]
                    if payload[0] != (seq * 7) & 0xff:
                        errors.append('frame %d has the wrong first byte' % seq)
                        return
                    got.append(seq)
                    buf = buf[HEAD + ln:]
        finally:
            c.close()

    threading.Thread(target=server, daemon=True).start()

    class Fake:
        """Stands in for ffmpeg's stdout: frames whose first byte is derived
        from the sequence number, so a mis-sliced stream cannot pass."""
        def __init__(self):
            self.n = 0

        def read(self, size):
            if size != FRAME:
                errors.append('sender asked for %d, expected %d' % (size, FRAME))
                return b''
            if self.n >= 5:
                return b''
            b = bytearray(FRAME)
            for i in range(0, FRAME, 4093):
                b[i] = (self.n * 13 + i) & 0xff
            b[0] = (self.n * 7) & 0xff
            self.n += 1
            return bytes(b)

    send_frames(Fake(), connect('127.0.0.1', port), 0, limit=5, quiet=True)
    for _ in range(100):
        if len(got) >= 5 or errors:
            break
        time.sleep(0.05)
    if errors:
        die('selftest failed: ' + '; '.join(errors))
    if got != [0, 1, 2, 3, 4]:
        die('selftest failed: receiver saw %r' % (got,))
    print('selftest: 5 frames framed, sequenced and delivered intact')
    print('          %d bytes per frame (%.0f KB), %d byte header'
          % (FRAME, FRAME / 1024, HEAD))


# ---------------------------------------------------------------------- main

def add_common(p):
    p.add_argument('--host', required=True, help="the car's IP on the same network")
    p.add_argument('--port', type=int, default=20558)
    p.add_argument('--crop', help='WxH+X+Y (or W:H:X:Y), applied before scaling')
    p.add_argument('--size', default='%dx%d' % (W, H), help='output size, default 1088x480')
    p.add_argument('--fit', choices=['cover', 'fit', 'squash'], default='cover')
    p.add_argument('--fps', type=int, default=10)
    p.add_argument('--preview', help='also write the first frame to this .bmp')
    p.add_argument('--frames', type=int, help='stop after N frames')
    p.add_argument('--quiet', action='store_true')
    p.add_argument('--verbose', action='store_true')
    p.add_argument('--ffmpeg')


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest='cmd')

    p = sub.add_parser('probe', help='tools, phone, displays, bandwidth')
    p.add_argument('--adb')
    p.set_defaults(func=probe)

    p = sub.add_parser('run', help='phone screen -> car, live')
    add_common(p)
    p.add_argument('--display-id', type=int, help='capture this display, not the main one')
    p.add_argument('--capture-size', help='ask screenrecord for WxH (it scales, it cannot crop)')
    p.add_argument('--bitrate', default='24M')
    p.add_argument('--chunk', type=int, default=170, help='seconds per screenrecord run (max 180)')
    p.add_argument('--once', dest='loop', action='store_false', default=True)
    p.add_argument('--adb')
    p.set_defaults(func=do_run)

    p = sub.add_parser('file', help='a video file -> car, for testing the pipe')
    add_common(p)
    p.add_argument('file')
    p.set_defaults(func=do_file)

    p = sub.add_parser('selftest', help='check framing with no phone and no car')
    p.set_defaults(func=selftest)

    args = ap.parse_args()
    if not getattr(args, 'cmd', None):
        ap.print_help()
        return
    args.func(args)


if __name__ == '__main__':
    main()
