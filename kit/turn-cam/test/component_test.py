"""The manifest, checked against what the Store actually accepts - and against
the app that installs it.

The first install of a tool in this repository failed, and nothing on the car
said why: the Store only quotes the last line a hook printed, and it never got
that far. The cause was in component.json - fields that exist in no other
component (`activate`/`deactivate`, a `from` inside `files`), which is the one
kind of mistake a test can catch without a car. So this asserts the shape the
Store accepts, plus the things that are particular to this component:

  * the decoder is built from src/decode.c, which has to be here: a build that
    silently falls back to some other copy is exactly the drift nobody would
    notice on the car
  * the folder, the socket and the two report paths the unit and the app agree
    on are spelled the same in all four places (C, unit, app, hook)

    python3 test/component_test.py
"""

import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
KIT = os.path.dirname(HERE)                      # kit/turn-cam
REPO = os.path.dirname(os.path.dirname(KIT))     # the repository root
APP_DIR = os.path.join(REPO, 'apps', 'cn_turn_view')
APP = os.path.join(APP_DIR, 'app.json')
MAIN = os.path.join(APP_DIR, 'main.js')
MANIFEST = os.path.join(KIT, 'component.json')
DECODE_SRC = os.path.join(KIT, 'src', 'decode.c')

# The fields used by every tool this repository has actually installed with:
# kit/renderd/prebuilt, kit/renderd/inputgate/tool, kit/carlife-probe/tool.
KNOWN = {'id', 'kind', 'version', 'title', 'description', 'mguHmi', 'optional',
         'uninstallable', 'requires', 'files', 'units', 'enable', 'dropins',
         'recmgr', 'restart', 'keepRunning', 'postInstall'}

DIR = '/dev/shm/turn-view'


def main():
    bad = []

    def check(ok, what):
        if not ok:
            bad.append(what)

    spec = json.load(open(MANIFEST, encoding='utf-8'))
    app = json.load(open(APP, encoding='utf-8'))
    main_js = open(MAIN, encoding='utf-8').read()

    unknown = set(spec) - KNOWN
    check(not unknown, 'unknown fields (the Store will not run these): %s' % sorted(unknown))

    payload = []
    for f in spec.get('files', []):
        path = f.get('path', '')
        payload.append(path)
        check('/' not in path, 'payload in a subdirectory: %s' % path)
        check('from' not in f, '"from" is a dropins field, not a files one: %s' % path)
        full = os.path.join(KIT, path)
        check(os.path.isfile(full), 'payload file is missing: %s' % path)
        check(f.get('mode') in ('0644', '0755'), 'payload has no install mode: %s' % path)
        if path.endswith('decode') or path == 'turn-cam':
            check(f.get('mode') == '0755', 'a program is not installed executable: %s' % path)

    # A unit is found by name at the component's root; listing it in files as
    # well is what the failing first version did, and no other tool does it.
    units = []
    for u in spec.get('units', []):
        name = u['name']
        units.append(name)
        check('/' not in name, 'unit name has a directory: %s' % name)
        check(name not in payload, 'unit file is also listed as payload: %s' % name)
        up = os.path.join(KIT, name)
        check(os.path.isfile(up), 'unit file is missing: %s' % name)
        if not os.path.isfile(up):
            continue
        text = open(up, encoding='utf-8').read()
        m = re.search(r'^ExecStart=(\S+)(.*)$', text, re.M)
        check(bool(m), 'unit has no ExecStart: %s' % name)
        if m:
            exe, rest = m.group(1), m.group(2)
            check(exe.startswith('/var/opt/%s/current/' % spec['id']),
                  'unit does not start through the stable current path: %s' % exe)
            check(os.path.basename(exe) in payload,
                  'unit starts something that is not in the payload: %s' % exe)
            check(('%s' % DIR) in rest,
                  'unit does not run against %s: %s%s' % (DIR, exe, rest))
        check('StartLimitIntervalSec=0' in text,
              'unit gives up after a few restarts: %s' % name)

    for h in spec.get('postInstall', []):
        check(h in payload, 'postInstall script is not in the payload: %s' % h)
        check(os.access(os.path.join(KIT, h), os.X_OK), 'postInstall script is not executable: %s' % h)

    for e in spec.get('enable', []):
        check(e['unit'] in units, 'enable names a unit the component does not install: %s' % e['unit'])

    # The app asks for this exact version; the Store installs by that number.
    want = app.get('requires', {}).get(spec['id'])
    check(want == spec['version'],
          'the app asks for %s %s, this is %s' % (spec['id'], want, spec['version']))

    # The decoder is built here, from the source beside it: one copy of the
    # source, one binary. A binary built from an older source is caught by the
    # folder it no longer points at - the one thing a rebuild changes silently.
    check(os.path.isfile(DECODE_SRC), 'the decoder source is gone: %s' % DECODE_SRC)
    decode = os.path.join(KIT, 'turn-decode')
    if os.path.isfile(DECODE_SRC) and os.path.isfile(decode):
        src = open(DECODE_SRC, encoding='utf-8').read()
        m = re.search(r'#define DIR_DEFAULT "([^"]+)"', src)
        check(bool(m), 'the decoder has no DIR_DEFAULT to compare against')
        if m:
            with open(decode, 'rb') as f:
                blob = f.read()
            check(m.group(1).encode() in blob,
                  'turn-decode was not rebuilt from src/decode.c: it does not know %s '
                  '(./build-zig.sh decode)' % m.group(1))

    # One folder, one socket, two reports, named the same everywhere.
    check(("const DIR = '%s'" % DIR) in main_js, 'the app does not use %s' % DIR)
    check("DIR + '/live.sock'" in main_js, 'the app does not read live.sock from that folder')
    check("DIR + '/crop.json'" in main_js, 'the app does not write crop.json into that folder')
    check("DIR + '/turn-cam.txt'" in main_js, 'the app does not read the receiver\'s report')
    check("'/dev/shm/turn-view-decode.txt'" in main_js, 'the app does not read the decoder\'s report')
    cam_c = open(os.path.join(KIT, 'src', 'turn_cam.c'), encoding='utf-8').read()
    check('#define DIR_DEFAULT     "%s"' % DIR in cam_c, 'the receiver does not default to %s' % DIR)
    check('DIR_DEFAULT "/h264.sock"' in cam_c, 'the receiver\'s socket is not in the folder')
    check('DIR_DEFAULT "/turn-cam.txt"' in cam_c, 'the receiver\'s report is not in the folder')
    check('"%s/h264.sock", d' in cam_c and '"%s/turn-cam.txt", d' in cam_c,
          'the receiver\'s --dir does not move the socket and the report with it')

    # The app's own settings: what the code reads must exist in app.json (a
    # settings.get() of a key nobody can set is a feature nobody can reach).
    keys = {s['key'] for s in app.get('settings', [])}
    for used in sorted(set(re.findall(r"settings\.get\('([a-zA-Z]+)'\)", main_js))):
        check(used in keys, 'main.js reads a setting app.json does not have: %s' % used)

    if bad:
        for b in bad:
            print('FAIL %s' % b)
        print('%d problem(s)' % len(bad))
        return 1
    print('manifest ok: fields, payload, units, hooks, the app\'s requirement and the shared paths line up')
    return 0


if __name__ == '__main__':
    sys.exit(main())
