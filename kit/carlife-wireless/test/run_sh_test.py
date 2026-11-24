#!/usr/bin/env python3
"""End-to-end desk test for run.sh (the launcher the car runs as root).

The real carlife-link/carlife-decode are x86-64 Linux binaries, so stand-ins
stand in for them. Everything else is the shipping shell code. This pins the
two bugs that made the car report "stream not started":

  * the launcher must NOT delete link.txt when it (re)starts;
  * when one half of the pipeline dies, run.txt must name it and its rc.

    python3 kit/carlife-wireless/test/run_sh_test.py
"""
import os
import re
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
KIT = os.path.dirname(HERE)
failed = []


def check(name, ok, extra=''):
    print(('  ok   ' if ok else '  FAIL ') + name + (('  -> ' + extra) if extra else ''))
    if not ok:
        failed.append(name)


def posix(p):
    p = p.replace('\\', '/')
    m = re.match(r'^([A-Za-z]):/(.*)$', p)
    return '/' + m.group(1).lower() + '/' + m.group(2) if m else p


def write(path, data, mode=0o644):
    with open(path, 'w', encoding='utf-8', newline='\n') as f:
        f.write(data)
    os.chmod(path, mode)


class Fixture:
    def __init__(self, link_body=None, decode_body=None):
        self.dir = tempfile.mkdtemp(prefix='carlife-run-')
        self.state = os.path.join(self.dir, 'state')
        os.makedirs(self.state, exist_ok=True)
        for name in ('run.sh', 'find-phone.sh'):
            shutil.copyfile(os.path.join(KIT, name), os.path.join(self.dir, name))
        write(os.path.join(self.dir, 'crop.json'), '{}\n')
        # Defaults: the link records its argv and stays alive, the decoder
        # dies at once, which is what a unit without MSDK looks like.
        if link_body is None:
            link_body = ('printf "%s\\n" "$@" > "$MOCK_DIR/link.args"\n'
                         'sleep 8\n')
        if decode_body is None:
            decode_body = 'exit 7\n'
        write(os.path.join(self.dir, 'carlife-link'), '#!/bin/sh\n' + link_body, 0o755)
        write(os.path.join(self.dir, 'carlife-decode'), '#!/bin/sh\n' + decode_body, 0o755)
        # Git Bash honours chmod on its mounts; do it through sh as well.
        subprocess.run(['sh', '-c', 'chmod +x "$1" "$2"', 'sh',
                        posix(os.path.join(self.dir, 'carlife-link')),
                        posix(os.path.join(self.dir, 'carlife-decode'))],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.env = dict(os.environ)
        self.env.update({
            'CARLIFE_DIR': posix(self.state),
            'MOCK_DIR': posix(self.dir),
            'CARLIFE_HOST_FILE': posix(os.path.join(self.dir, 'no-host')),
            'CARLIFE_LEASE': posix(os.path.join(self.dir, 'no-lease')),
            'CARLIFE_ROUTE': posix(os.path.join(self.dir, 'no-route')),
            'CARLIFE_STATUS': posix(os.path.join(self.dir, 'no-status')),
            'CARLIFE_HOST': '192.168.43.1',
        })

    def run(self):
        return subprocess.run(['sh', posix(os.path.join(self.dir, 'run.sh'))],
                              env=self.env, stdout=subprocess.DEVNULL,
                              stderr=subprocess.DEVNULL, timeout=40)

    def read(self, name):
        try:
            with open(os.path.join(self.state, name), 'r', encoding='utf-8') as f:
                return f.read()
        except OSError:
            return ''

    def argv(self):
        try:
            with open(os.path.join(self.dir, 'link.args'), 'r', encoding='utf-8') as f:
                return f.read()
        except OSError:
            return ''

    def close(self):
        shutil.rmtree(self.dir, ignore_errors=True)


def main():
    if not shutil.which('sh'):
        print('sh is required (Git Bash on Windows)')
        return 1

    # 1. a pre-existing link report survives a launcher start/restart
    f = Fixture()
    write(os.path.join(f.state, 'link.txt'), 'state: sentinel\n')
    r = f.run()
    check('launcher exits 4 so systemd restarts it', r.returncode == 4, 'rc=%d' % r.returncode)
    check('link.txt is NOT deleted on restart', f.read('link.txt').strip() == 'state: sentinel',
          repr(f.read('link.txt').strip()))
    run = f.read('run.txt')
    check('run.txt names the dead half and its rc', 'carlife-decode exited (rc 7)' in run,
          repr(run.replace('\n', ' | ')))
    check('run.txt records the phone and its source',
          'phone: 192.168.43.1' in run and 'environment override' in run,
          repr(run.replace('\n', ' | ')))
    check('launcher dials the discovered address', '--host\n192.168.43.1' in f.argv(),
          repr(f.argv().replace('\n', ' ')))
    f.close()

    # 2. with no address at all the link still runs, in discovery mode
    f = Fixture()
    f.env.pop('CARLIFE_HOST')
    write(os.path.join(f.state, 'link.txt'), 'state: sentinel\n')
    r = f.run()
    check('no address uses --find (never a DNS lookup for "auto")',
          '--find' in f.argv() and '--host\nauto' not in f.argv(),
          repr(f.argv().replace('\n', ' ')))
    check('run.txt says discovery is the source', 'auto discovery' in f.read('run.txt'))
    check('link.txt still survives', f.read('link.txt').strip() == 'state: sentinel')
    f.close()

    # 3. the stream itself crosses from link to decoder
    #
    # 0.7.1 shipped link and decode as two sibling subshells with no pipe
    # between them. The decoder's stdin was the launcher's (on the unit:
    # /dev/null), so it exited rc 2 "stream ended" instantly and the car
    # showed only that. Every older check passed anyway, because the mock
    # decoder never read stdin. This one sends real bytes and looks for them.
    payload = 'CARLIFE-STREAM-OK\n'
    f = Fixture(link_body='printf "%s\\n" "$@" > "$MOCK_DIR/link.args"\n'
                          "printf 'CARLIFE-STREAM-OK\\n'\n"
                          'sleep 3\n',
                decode_body='head -c %d > "$MOCK_DIR/decode.in"\nexit 0\n' % len(payload))
    r = f.run()
    got = ''
    try:
        with open(os.path.join(f.dir, 'decode.in'), 'rb') as fh:
            got = fh.read().decode('latin-1')
    except OSError:
        pass
    check('link output reaches the decoder over the FIFO', got == payload, repr(got))
    f.close()

    # 4. when the decoder goes first the link is named, not the decoder
    #
    # The link is the half that owns the socket and the phone, so its death
    # is the cause and the decoder's rc 2 is only the symptom. The launcher
    # polls once a second; a link that dies just after a poll must still be
    # what run.txt names.
    f = Fixture(link_body='printf "%s\\n" "$@" > "$MOCK_DIR/link.args"\n'
                          'sleep 1.5\nexit 3\n',
                decode_body='exit 0\n')
    r = f.run()
    run = f.read('run.txt')
    check('a late link death is still reported as the link', 'carlife-link exited (rc 3)' in run,
          repr(run.replace('\n', ' | ')))
    f.close()

    # 5. the real cascade: the link goes away, the decoder reads EOF and exits 2
    #
    # This is exactly what the car showed in 0.7.1 - "carlife-decode exited
    # (rc 2)" plus "stream ended" - except there the link was healthy and
    # there was no pipe at all. Decode status 2 is the decoder saying "my
    # stdin closed", so the link has to be the one named.
    f = Fixture(link_body='printf "%s\\n" "$@" > "$MOCK_DIR/link.args"\n'
                          'sleep 0.5\nexit 3\n',
                decode_body='cat > /dev/null\nexit 2\n')
    r = f.run()
    run = f.read('run.txt')
    check('decode rc 2 (stdin closed) blames the link', 'carlife-link exited (rc 3)' in run,
          repr(run.replace('\n', ' | ')))
    f.close()

    # 6. a decoder that failed on its own must not be hidden behind the link
    #
    # The decoder exits 1 when there is no MSDK. Insisting on the link for
    # every restart would turn that into "carlife-link exited (rc 141)" the
    # moment the link's next write hits a closed pipe.
    f = Fixture(link_body='printf "%s\\n" "$@" > "$MOCK_DIR/link.args"\n'
                          'sleep 2\nexit 3\n',
                decode_body='exit 1\n')
    r = f.run()
    run = f.read('run.txt')
    check('decode rc 1 (no MSDK) names the decoder', 'carlife-decode exited (rc 1)' in run,
          repr(run.replace('\n', ' | ')))
    f.close()

    print()
    if failed:
        print('%d check(s) failed' % len(failed))
        return 1
    print('all run.sh checks passed')
    return 0


if __name__ == '__main__':
    sys.exit(main())
