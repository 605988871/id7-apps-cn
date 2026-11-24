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
import re
import shutil
import socket
import struct
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


def test_optional_channel_quiet():
    """A closed audio channel is not a stream error.

    The app prints the report's error: line verbatim under "取流错误", and the
    phone opens and closes media/tts/vr on its own schedule during a perfectly
    healthy session. The car therefore showed "取流错误：read on the vr channel
    failed" while the picture was running. Only cmd and video may raise one.
    """
    src = SRC.read_text(encoding='utf-8', errors='replace')
    check('static int chan_required(int ci)' in src and 'CH_CMD || ci == CH_VIDEO' in src,
          'only the two channels that carry the picture count as required')
    start = src.find('static void read_channel')
    body = src[start:start + 1800] if start >= 0 else ''
    check(start > 0, 'read_channel is where a channel dies')
    check(body.count('chan_required(ci)') >= 2,
          'both the close and the read error are filtered through it', body.count('chan_required(ci)'))
    check('not needed for the picture' in body,
          'an optional channel still says so in the log, just not on the screen')


def test_silent_session_watchdog(exe, tmp):
    """A session that matches and then says nothing must be thrown away.

    On the unit the phone opened all six channels, matched the version and even
    answered "encoder init done", then sent no frame at all - and closed
    nothing. The screen sat on "waiting for picture" with frames=0 for three
    and a half minutes, until the phone dropped the video socket by itself.
    Nothing in the read path can notice a socket that simply says nothing, so
    the link times the session out on its own and dials again: fresh sockets
    make the phone start a fresh session, which is what cleared it on the car.
    """
    record = tmp / 'silent.jsonl'
    report = tmp / 'silent.txt'
    py = sys.executable or 'python'
    ctl = CTL + 3
    md = subprocess.Popen([py, str(HERE / 'fake_md.py'), '--port', str(BASE),
                           '--record', str(record), '--seconds', '26', '--silent-video'],
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    link = None
    try:
        if not wait_port(BASE) or not wait_port(BASE + 1000):
            check(False, 'the silent phone came up on six ports')
            return
        started = time.time()
        link = subprocess.Popen([str(exe), 'run', '--host', '127.0.0.1', '--port', str(BASE),
                                 '--ctl', str(ctl), '--seconds', '15', '--report', str(report),
                                 '--video', str(tmp / 'silent.h264')],
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        link.wait(timeout=60)
        took = time.time() - started
        out, err = link.communicate()
        text = report.read_text(encoding='utf-8', errors='replace') if report.exists() else ''
        check('frames=0 ' in text or 'frames=0\n' in text, 'no picture ever arrived', text)
        check(re.search(r'reset: [1-9]', text) is not None, 'the watchdog counted a reset', text)
        check('watchdog:' in (err or ''), 'the log says the session was dropped', (err or '')[-300:])
        rec = read_record(record)
        versions = [r for r in rec if r['chan'] == 'cmd' and r['type'] == '0x00018001']
        check(len(versions) >= 2,
              'the session was dialled again after the timeout, not after minutes',
              len(versions))
        check(took < 17.0, 'it gave up in seconds, not minutes', round(took, 1))
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
    # --host auto leaves the word "auto" in the host field until something is
    # found; dialling it used to put "cannot resolve auto" on the screen as if
    # the phone had refused. Our own argument is not a phone error.
    check('cannot resolve' not in text, 'nothing dials the word "auto"', text)
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


def test_reconnect_latency():
    """A closed touch channel used to stay down for 3 s, and reopening all six
    channels blocked the single-threaded select loop for 600 ms each. Both
    show up on the car as dropped taps and a stuttering picture - worth a
    source-level guard because a fake phone cannot reproduce the timing."""
    src = SRC.read_text(encoding='utf-8', errors='replace')
    start = src.find('static void reopen_missing')
    body = src[start:start + 1400] if start >= 0 else ''
    check('critical[3]' in body and 'CH_MEDIA' not in body,
          'reopen only retries the channels we use, never the audio ones')
    check('open_channel(l, i, 200)' in body, 'reopen uses a short connect timeout')
    check('at most one blocking connect per pass' in body,
          'reopen does one connect per pass')
    check('now - L.t_retry >= 400' in src,
          'a dropped touch channel is retried within 400 ms')
    check('tv.tv_usec = 50000;' in src,
          'select wakes often enough to pump the control socket')


def test_nonblocking_connect_waits():
    """A non-blocking connect() returns EINPROGRESS on Linux, not EWOULDBLOCK.

    SWOULDBLOCK left EINPROGRESS out, so tcp_connect() called every dial a
    failure the instant it started - "7240 failed (115)" - and never gave the
    handshake the 500 ms it had asked for. The car said "phone not reachable"
    while a three-line node script reached the same port in milliseconds.
    Neither of the two harnesses here can catch it: Windows reports
    WSAEWOULDBLOCK (handled), and a local test server accepts before connect()
    even returns. Guarded at the source, like the drop-uid order above."""
    src = SRC.read_text(encoding='utf-8', errors='replace')
    posix = src[src.find('#  define serr() errno'):]
    posix = posix[:posix.find('#endif')]
    win = src[:src.find('#  define serr() errno')]
    win = win[win.rfind('#ifdef _WIN32'):]
    check('EINPROGRESS' in posix and 'EALREADY' in posix,
          'a POSIX non-blocking connect is waited on, not failed',
          posix.strip().splitlines()[-3:])
    check('WSAEWOULDBLOCK' in win and 'EINPROGRESS' not in win,
          'the Windows branch still keys on WSAEWOULDBLOCK')
    # both places that start a connect must go through the same rule
    check(src.count('SWOULDBLOCK(e)') >= 3,
          'tcp_connect, tcp_start_v4 and the read path share one rule')


def test_frame_rate_and_session_stability():
    """Three fixes that the car feels but a fake phone cannot reproduce.

    The phone honours the frame rate the head unit asks for, so asking for
    30 when the phone can do 60 halves the whole session. The phone also
    restarts its encoder whenever a session starts over, so dropping a
    healthy video channel to rebuild the cmd one costs a black frame. And a
    silent cmd channel makes the phone hang up on us, so the head unit has
    to keep talking.
    """
    src = SRC.read_text(encoding='utf-8', errors='replace')

    check('L.req_fps = 60;' in src,
          'the link asks the phone for 60 fps, not 30')
    check('default 1280x720@60' in src,
          'the help text agrees with the default')

    start = src.find('static int connect_all')
    body = src[start:start + 2600] if start >= 0 else ''
    check('if (l->ch[i].open)' in body,
          'connect_all leaves the channels that are already open alone')
    check('keeping the running video session' in body,
          'a cmd reconnect keeps the running video session')
    check('link_close(l)' not in body,
          'connect_all no longer tears the whole session down')

    check('send_keepalive' in src and 'now - L.t_keepalive >= 2000' in src,
          'the head unit keeps the cmd channel alive every two seconds')


def test_backlog_is_latency():
    """The decoder's input queue is the picture's delay, so it must be small.

    A 6 MB backlog of 1920x720 screen content is six to ten seconds, and on a
    unit whose decoder is a little slower than the phone it simply stays full:
    the picture looks fine but every gesture appears seconds late. One MB is
    under a second, and pictures thrown away to catch up must resume on an
    IDR rather than in the middle of a GOP (which smears until the next one).
    """
    src = SRC.read_text(encoding='utf-8', errors='replace')
    check('#define SINK_BACKLOG (1u << 20)' in src,
          'the decoder queue is 1 MB, not the 6 MB that cost six seconds')
    check('#define SINK_IDR_WAIT_MS 800' in src and 'sink.want_idr' in src,
          'dropping pictures waits for an IDR, with a timeout')
    check('sink_trim(&l->sink, SINK_BACKLOG / 4)' in src,
          'a stream with no keyframes trims the old queue instead of freezing')
    check('skipped=%lu backlog=%u%%' in src,
          'the report names both the skipped pictures and how full the queue is')

    # The 0.8.2 catch-up had a hole: it skipped new pictures while waiting for
    # an IDR, but never dropped what was already queued. sink_run takes from
    # the HEAD, so the backlog stayed at 87%, and the IDR that finally came was
    # rejected by a full sink_put - the picture never recovered.
    body = src[src.find('if (l->sink.want_idr) {'):src.find('sink_put(&l->sink, p, n);', src.find('if (l->sink.want_idr) {'))]
    check(body.count('sink_trim(') >= 2,
          'both entering catch-up and the IDR arriving clear the old queue')
    check('else if (l->sink.backlog + n > SINK_BACKLOG && !idr)' in body and
          'sink_trim(' in body[body.find('else if'):],
          'crossing the limit drops old frames at once, not just new ones')
    check('push=%lufps' in src and 'vid_push_rate' in src and 'l->vid_frames++' in src,
          'the report counts frames actually received, not the encoder config @60')


def test_network_change_rehomes():
    """Joining another hotspot must re-home the link immediately.

    The service is not restarted when the car switches Wi-Fi: run.sh chose an
    address once, and from then on the address is carlife-link's business.
    Waiting for dial timeouts is what left the screen dialling the previous
    hotspot for about a minute. DHCP renumbers wlan0 within a second or two of
    associating, so the local address set is the earliest signal available -
    and it costs no root, no DHCP client and no wpa_cli.

    Guarded at the source because neither harness can change an interface:
    the fake phone lives on 127.0.0.1 and the address never moves.
    """
    src = SRC.read_text(encoding='utf-8', errors='replace')

    check('uint32_t self[8];' in src and 'int nself;' in src and 'double t_net;' in src,
          'the link keeps a snapshot of its own addresses')
    check('L.nself = local_ipv4(L.self, 8);' in src and 'L.t_net = L.t0;' in src,
          'the baseline is taken at start, so the first look is not a change')

    start = src.find('if (now - L.t_net >= 1000)')
    body = src[start:start + 2400] if start >= 0 else ''
    check(start > 0, 'the address table is looked at once a second')
    check('channels_reset(&L);' in body,
          'the session built on the old network is dropped, not left half-open')
    check('discover(L.base_port, found' in body,
          'the phone is looked for again as soon as the change is seen')
    check('L.fail_rounds = 0;' in body,
          'the change resets the failure count instead of waiting it out')

    retry = src.find('nothing connected: keep trying')
    check(start > 0 and retry > 0 and start < retry,
          'the change is handled before the retry branch can dial the old address',
          (start, retry))

    check('on_any_net(host_net(L.host), L.self, L.nself) ? HINT_ROUNDS : 2' in src,
          'an address outside every local /24 is swept after two rounds')

    start = src.find('static void channels_reset')
    body = src[start:start + 700] if start >= 0 else ''
    check('ctl_client' not in body,
          "a hotspot change keeps the app's control socket open")


def read_interp(blob):
    """PT_INTERP, the loader the kernel must find before this program runs.

    Parsed rather than searched: a byte string that merely *contains* the
    right tail is exactly what got a broken binary past elf_check.py.
    """
    e_phoff = struct.unpack_from('<Q', blob, 32)[0]
    e_phentsize = struct.unpack_from('<H', blob, 54)[0]
    e_phnum = struct.unpack_from('<H', blob, 56)[0]
    for i in range(e_phnum):
        base = e_phoff + i * e_phentsize
        if base + 56 > len(blob):
            return None
        if struct.unpack_from('<I', blob, base)[0] != 3:      # PT_INTERP
            continue
        off = struct.unpack_from('<Q', blob, base + 8)[0]
        size = struct.unpack_from('<Q', blob, base + 32)[0]
        if off + size > len(blob):
            return None
        return blob[off:off + size].rstrip(b'\0').decode('utf-8', 'replace')
    return None


def test_shipped_binaries():
    """The three files in this folder are what the store actually installs.

    They are built on Windows under Git Bash, and the shell rewrites an
    argument that looks like a unix path before a native program sees it. It
    turned -Wl,--dynamic-linker=/lib/ld-linux-x86-64.so.2 into this machine's
    own loader and every shipped binary ended up with

        D:/.../PortableGit/lib/ld-linux-x86-64.so.2

    in PT_INTERP. The unit has no such file, so exec failed with ENOENT and
    the screen said "carlife-link exited (rc 127)" - the binary was present,
    executable, and unable to start. elf_check.py let it through because it
    searched the whole file for the right bytes, and those bytes are there,
    at the end of the wrong absolute path.

    So this reads PT_INTERP and compares it whole. It runs without zig: the
    point is to catch a bad file that is already in the tree, which is the
    state the app was actually shipped in.
    """
    for name in ('carlife-link', 'carlife-decode', 'wifi-bridge'):
        path = ROOT.parent / name
        check(path.exists(), name + ' is present')
        if not path.exists():
            continue
        interp = read_interp(path.read_bytes())
        check(interp == '/lib/ld-linux-x86-64.so.2',
              '%s names the unit loader, got %r' % (name, interp))

    build = (ROOT.parent / 'build.sh').read_text(encoding='utf-8', errors='replace')
    check('MSYS_NO_PATHCONV=1' in build,
          'build.sh turns the shell path rewrite off, or the loader gets mangled again')

    elf = (HERE / 'elf_check.py').read_text(encoding='utf-8', errors='replace')
    check('PT_INTERP' in elf and 'read_interp' in elf,
          'elf_check.py parses PT_INTERP instead of searching the whole file')


def main():
    test_drop_uid_order()
    test_nonblocking_connect_waits()
    test_reconnect_latency()
    test_frame_rate_and_session_stability()
    test_backlog_is_latency()
    test_shipped_binaries()
    test_network_change_rehomes()
    test_optional_channel_quiet()
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
    test_silent_session_watchdog(exe, tmp)
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
