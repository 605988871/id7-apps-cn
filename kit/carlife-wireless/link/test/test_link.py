#!/usr/bin/env python3
"""What carlife-link must do, checked against a phone that is a Python file.

Three things are proven here, and all three are things that would otherwise
cost a drive to find out:

  * the handshake - the version frame goes out first with the documented bytes,
    and the video is only asked for after the phone matches;
  * the video channel - 12-byte headers are walked frame by frame, SPS/PPS/IDR
    are recognised, and every payload byte is accounted for;
  * touch - a normalised point from the app arrives at the phone as an
    encoded-picture pixel (0.5, 0.5 of 1280x720 is 640,360).

It also builds the unit's binary and refuses one that names the wrong loader:
the unit has no /lib64, and a program that asks for it fails with ENOENT while
looking perfectly fine (carlife-tap 0.4.4 shipped exactly that).

usage: python test/test_link.py        (zig must be on PATH or in ZIG=)
"""
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
SRC = ROOT / 'src/link.c'
IS_WIN = os.name == 'nt'


def free_port():
    """A port nothing else is using: the preview window keeps a control port
    open on this machine, and a test that cannot bind it would pass by
    accident without ever sending a touch."""
    s = socket.socket()
    s.bind(('127.0.0.1', 0))
    port = s.getsockname()[1]
    s.close()
    # the tests add channel offsets to it, so leave room below 65535
    return port if port < 60000 else 40000 + port % 20000


BASE = free_port()
CTL = free_port()
failures = []


def check(ok, what, detail=''):
    print(('  ok   ' if ok else '  FAIL ') + what + (('  [' + str(detail) + ']') if detail and not ok else ''))
    if not ok:
        failures.append(what)


def find_zig():
    for cand in (os.environ.get('ZIG'), shutil.which('zig'),
                 r'D:/zig/zig-x86_64-windows-0.14.1/zig.exe', '/d/zig/zig-x86_64-windows-0.14.1/zig.exe'):
        if cand and Path(cand).exists():
            return str(cand)
    return None


def build(zig, out, linux=False):
    cmd = [zig, 'cc', '-O2', '-Wall', '-Wextra', '-o', str(out), str(SRC)]
    if linux:
        cmd[2:2] = ['-target', 'x86_64-linux-gnu.2.27',
                    '-Wl,--dynamic-linker=/lib/ld-linux-x86-64.so.2']
        cmd += ['-lpthread']
    elif IS_WIN:
        cmd += ['-lws2_32', '-liphlpapi']
    res = subprocess.run(cmd, capture_output=True, text=True)
    return res.returncode == 0, (res.stderr or '').strip()


def wait_port(port, timeout=5.0):
    end = time.time() + timeout
    while time.time() < end:
        try:
            with socket.create_connection(('127.0.0.1', port), 0.2):
                return True
        except OSError:
            time.sleep(0.05)
    return False


def read_record(path):
    if not path.exists():
        return []
    out = []
    for line in path.read_text(encoding='utf-8').splitlines():
        try:
            out.append(json.loads(line))
        except ValueError:
            pass
    return out


def test_session(exe, tmp):
    record = tmp / 'record.jsonl'
    report = tmp / 'report.txt'
    py = sys.executable or 'python'
    md = subprocess.Popen([py, str(HERE / 'fake_md.py'), '--port', str(BASE),
                           '--record', str(record), '--seconds', '12'],
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    link = None
    try:
        if not wait_port(BASE) or not wait_port(BASE + 1000):
            check(False, 'the simulated phone came up')
            return
        check(True, 'the simulated phone came up on six ports')

        link = subprocess.Popen([str(exe), 'run', '--host', '127.0.0.1', '--port', str(BASE),
                                 '--ctl', str(CTL), '--seconds', '5',
                                 '--report', str(report), '--video', str(tmp / 'stream.h264')],
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)

        # wait until the handshake is done, then tap the middle of the picture
        deadline = time.time() + 6
        matched = False
        while time.time() < deadline:
            if report.exists() and 'match=yes' in report.read_text(encoding='utf-8', errors='replace'):
                matched = True
                break
            time.sleep(0.1)
        check(matched, 'the version frame was answered and the link matched')

        replies = []
        try:
            ctl = socket.create_connection(('127.0.0.1', CTL), 1.0)
            ctl.settimeout(1.0)
            for line in (b'down 5000 5000\n', b'move 5100 5200\n', b'up 5000 5000\n', b'key 20\n'):
                ctl.sendall(line)
                try:
                    replies.append(ctl.recv(64))
                except OSError:
                    replies.append(b'')
                time.sleep(0.15)
            ctl.close()
        except OSError as e:
            check(False, 'the app could reach the control port', e)
        check(replies.count(b'ok\n') >= 3, 'the control port answered the app', replies)

        link.wait(timeout=20)
        out, err = link.communicate()

        text = report.read_text(encoding='utf-8', errors='replace') if report.exists() else ''
        check('frames=' in text and 'frames=0 ' not in text, 'pictures arrived', text)
        check('sps=yes' in text and 'pps=yes' in text and 'idr=yes' in text,
              'the stream starts with SPS, PPS and an IDR', text)
        check('match=yes' in text, 'the report says the phone matched', text)

        rec = read_record(record)
        versions = [r for r in rec if r['chan'] == 'cmd' and r['type'] == '0x00018001']
        check(len(versions) == 1, 'exactly one version frame reached the phone', len(versions))
        check(versions and versions[0]['body'] == '08011000',
              'the version frame is {1,0} as documented', versions[0]['body'] if versions else '')
        types = [r['type'] for r in rec if r['chan'] == 'cmd']
        check('0x00018027' in types, 'statistics went out after the match', types)
        check('0x00018007' in types, 'the encoder was asked for a size', types)
        check(types and types[0] == '0x00018001', 'nothing goes out before the version frame', types)
        check(types.index('0x00018007') > types.index('0x00018027') if '0x00018007' in types else False,
              'the size is asked for after the statistics, not before', types)
        check('0x00018009' in types, 'the encoder was started', types)

        touches = [r for r in rec if r['chan'] == 'touch' and r['type'] == '0x00068001']
        downs = [t for t in touches if t.get('action') == 0]
        check(len(touches) >= 2, 'touch events reached the phone', len(touches))
        check(bool(downs) and downs[0]['x'] == 640 and downs[0]['y'] == 360,
              'a tap at 0.5,0.5 of 1280x720 arrives as 640,360', downs[:1])
        keys = [r for r in rec if r['chan'] == 'touch' and r['type'] == '0x00068008']
        check(bool(keys) and keys[0].get('key') == 20, 'a hard key arrives as its key code', keys[:1])

        stream = tmp / 'stream.h264'
        check(stream.exists() and stream.stat().st_size > 10000,
              'the H.264 payload was written out', stream.stat().st_size if stream.exists() else 0)
        check(link.returncode == 0, 'the link exits 0 when it delivered pictures', link.returncode)
    finally:
        for p in (link, md):
            if p and p.poll() is None:
                p.terminate()
                try:
                    p.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    p.kill()


def test_unreachable(exe, tmp):
    report = tmp / 'unreachable.txt'
    res = subprocess.run([str(exe), 'run', '--host', '127.0.0.1', '--port', '19240',
                          '--ctl', str(CTL + 1), '--seconds', '2', '--report', str(report)],
                         capture_output=True, text=True, timeout=30)
    text = report.read_text(encoding='utf-8', errors='replace') if report.exists() else ''
    check(res.returncode != 0, 'no phone means a non-zero exit', res.returncode)
    check('phone not reachable' in text or 'timed out' in text or 'refused' in text,
          'the report says why there is no picture', text)
    check('crash' not in (res.stderr or '').lower(), 'nothing crashed on the way there', res.stderr[-200:])


def test_probe(exe, tmp):
    py = sys.executable or 'python'
    md = subprocess.Popen([py, str(HERE / 'fake_md.py'), '--port', str(BASE + 100), '--seconds', '8'],
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        if not wait_port(BASE + 100):
            check(False, 'the simulated phone came up for the probe')
            return
        res = subprocess.run([str(exe), 'probe', '--host', '127.0.0.1', '--port', str(BASE + 100)],
                             capture_output=True, text=True, timeout=30)
        check('6 of 6 channels open' in res.stdout, 'probe finds all six channels', res.stdout)
        check('0x00010002' in res.stdout or 'answered' in res.stdout,
              'probe sends the version and reads the answer', res.stdout)
    finally:
        md.terminate()
        try:
            md.wait(timeout=5)
        except subprocess.TimeoutExpired:
            md.kill()


def test_find_without_phone(exe, tmp):
    """The loop that runs in a car park: look, find nothing, say so, look again.
    It must not spin, crash, or claim a link it does not have."""
    report = tmp / 'find.txt'
    started = time.time()
    res = subprocess.run([str(exe), 'run', '--find', '--port', '18240',
                          '--ctl', str(CTL + 2), '--seconds', '8', '--report', str(report)],
                         capture_output=True, text=True, timeout=90)
    took = time.time() - started
    text = report.read_text(encoding='utf-8', errors='replace') if report.exists() else ''
    check(res.returncode != 0, 'looking for a phone that is not there ends without a picture', res.returncode)
    check(any(s in text for s in ('looking for the phone', 'no phone on the network', 'no phone answered')),
          'the report says it is looking, not that it is connected', text)
    check('match=yes' not in text, 'nothing pretends to have matched', text)
    check(took < 60, 'the search does not hang', '%.1f s' % took)


def report_field(path, key):
    """One field of the report, or '' if the file is mid-rewrite."""
    try:
        for line in path.read_text(encoding='utf-8', errors='replace').splitlines():
            if line.startswith(key + ':'):
                return line.split(':', 1)[1].strip()
    except OSError:
        pass
    return ''


def frames_so_far(path):
    field = report_field(path, 'video')
    for word in field.split():
        if word.startswith('frames='):
            try:
                return int(word.split('=', 1)[1])
            except ValueError:
                return -1
    return -1


def test_slow_reader(exe, tmp):
    """A decoder that cannot keep up must not stall the session.

    Writing the picture straight to a pipe blocks the moment the reader falls
    behind, and the same loop is what answers the phone on the control channel:
    the phone would then sit on its launch page, waiting for a head unit that
    had gone quiet, while the window showed the last picture it had.  So the
    write happens on its own thread, and stale pictures are dropped."""
    base = BASE + 40
    ctl = CTL + 40
    report = tmp / 'slow.txt'
    md = subprocess.Popen([sys.executable or 'python', str(HERE / 'fake_md.py'),
                           '--port', str(base), '--seconds', '25'],
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    run = None
    try:
        check(wait_port(base), 'the simulated phone is up for the slow-reader test')
        run = subprocess.Popen([str(exe), 'run', '--host', '127.0.0.1', '--port', str(base),
                                '--video', '-', '--ctl', str(ctl), '--report', str(report),
                                '--seconds', '16'],
                               stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        got = [0]

        def trickle():
            # 1 KB every 400 ms against a ~21 KB/s stream: the pipe fills, and
            # a tool that writes the picture inline would stop here
            while True:
                try:
                    chunk = run.stdout.read(1024)
                except (OSError, ValueError):
                    return
                if not chunk:
                    return
                got[0] += len(chunk)
                time.sleep(0.4)

        pump = threading.Thread(target=trickle, daemon=True)
        pump.start()

        time.sleep(6)
        first = frames_so_far(report)
        time.sleep(3)
        second = frames_so_far(report)
        check(got[0] > 0, 'the pictures do reach the slow reader', got[0])
        check(first > 0 and second > first,
              'the phone keeps being read while the pipe is backed up',
              'frames %d then %d' % (first, second))
        check(report_field(report, 'video').find('dropped=') > 0,
              'the report says how many pictures were dropped',
              report_field(report, 'video'))
    finally:
        if run is not None:
            run.kill()
            run.wait(timeout=10)
        md.kill()
        try:
            md.wait(timeout=5)
        except subprocess.TimeoutExpired:
            pass


def test_drop_uid_order():
    """The mgu-uplink whitelist uid must be parsed before setuid() runs, and
    setuid() before any socket is opened. Getting this order wrong silently
    keeps root (firewall drops it) - which only shows up on the car."""
    src = SRC.read_text(encoding='utf-8', errors='replace')
    parse = src.find('--drop-uid')
    # the second occurrence is the argument parser; the first is usage text
    parse2 = src.find('--drop-uid', parse + 1)
    drop = src.find('setgroups(0, NULL)')
    # only consider the socket() calls in main(), after the arg loop
    main_pos = src.find('int main(')
    sockets = [i for i in range(main_pos, len(src)) if src.startswith('socket(AF_INET', i)]
    check(parse2 > 0 and drop > 0 and parse2 < drop,
          '--drop-uid is parsed before setuid runs', (parse2, drop))
    check(bool(sockets) and drop < sockets[0],
          'setuid runs before the first socket in main', (drop, sockets[:1]))


def main():
    test_drop_uid_order()
    zig = find_zig()
    if not zig:
        print('zig not found: set ZIG= or put it on PATH')
        return 2
    tmp = Path(tempfile.mkdtemp(prefix='carlife-link-'))
    exe = tmp / ('link.exe' if IS_WIN else 'link')

    ok, err = build(zig, exe)
    check(ok, 'the tool builds for this machine', err[-400:])
    if not ok:
        return 1

    test_session(exe, tmp)
    test_unreachable(exe, tmp)
    test_probe(exe, tmp)
    test_find_without_phone(exe, tmp)
    test_slow_reader(exe, tmp)

    unit = tmp / 'link-unit'
    ok, err = build(zig, unit, linux=True)
    check(ok, 'the tool builds for the unit (glibc 2.27)', err[-400:])
    if ok:
        blob = unit.read_bytes()
        check(blob[:4] == b'\x7fELF' and blob[4] == 2 and int.from_bytes(blob[18:20], 'little') == 62,
              'the unit binary is 64-bit little-endian x86-64')
        check(b'/lib/ld-linux-x86-64.so.2\x00' in blob,
              'the unit binary names the loader the unit actually has')

    print('\n%d checks failed' % len(failures) if failures else '\nall checks passed')
    return 1 if failures else 0


if __name__ == '__main__':
    sys.exit(main())
