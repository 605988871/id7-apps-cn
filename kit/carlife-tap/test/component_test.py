"""The manifest, checked against what the Store actually accepts.

The first install of this tool failed, and nothing on the car said why: the
Store only quotes the last line a hook printed, and it never got that far. The
cause was in component.json - fields that exist in no other component of this
repository (`activate`/`deactivate`, a `from` inside `files`), which is the one
kind of mistake a test can catch without a car.

So this asserts the shape every working component in the repo has, plus the few
things that made this one fail or would have made it fail quietly:

  * only the fields the other tools use - no invented hooks
  * every payload file at the component's root, plain name, no subdirectory
  * the unit starts a file that is actually in the payload, through the Store's
    stable /var/opt/<id>/current path
  * the unit does not give up after a few restarts (a decoder that restarts
    while the app is on the cluster reads as a failed install)
  * the app's `requires` names this exact version

    python3 test/component_test.py
"""

import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
KIT = os.path.dirname(HERE)                      # kit/carlife-tap
REPO = os.path.dirname(os.path.dirname(KIT))     # the repository root
APP = os.path.join(REPO, 'apps', 'cn_carlife_map', 'app.json')
MANIFEST = os.path.join(KIT, 'component.json')

# The fields used by every tool this repository has actually installed with:
# kit/renderd/prebuilt, kit/renderd/inputgate/tool, kit/carlife-probe/tool.
KNOWN = {'id', 'kind', 'version', 'title', 'description', 'mguHmi', 'optional',
         'uninstallable', 'requires', 'files', 'units', 'enable', 'dropins',
         'recmgr', 'restart', 'keepRunning', 'postInstall'}


def main():
    bad = []

    def check(ok, what):
        if not ok:
            bad.append(what)

    spec = json.load(open(MANIFEST, encoding='utf-8'))

    unknown = set(spec) - KNOWN
    check(not unknown, 'unknown fields (the Store will not run these): %s' % sorted(unknown))

    payload = []
    for f in spec.get('files', []):
        path = f.get('path', '')
        payload.append(path)
        check('/' not in path, 'payload in a subdirectory: %s' % path)
        check('from' not in f, '"from" is a dropins field, not a files one: %s' % path)
        check(os.path.isfile(os.path.join(KIT, path)), 'payload file is missing: %s' % path)
        check(f.get('mode') in ('0644', '0755'), 'payload has no install mode: %s' % path)

    # A unit is found by name at the component's root; listing it in files as
    # well is what the first version did, and no other tool does it.
    for u in spec.get('units', []):
        name = u['name']
        check('/' not in name, 'unit name has a directory: %s' % name)
        check(name not in payload, 'unit file is also listed as payload: %s' % name)
        up = os.path.join(KIT, name)
        check(os.path.isfile(up), 'unit file is missing: %s' % name)
        if not os.path.isfile(up):
            continue
        text = open(up, encoding='utf-8').read()
        m = re.search(r'^ExecStart=(\S+)', text, re.M)
        check(bool(m), 'unit has no ExecStart: %s' % name)
        if m:
            exe = m.group(1)
            check(exe.startswith('/var/opt/%s/current/' % spec['id']),
                  'unit does not start through the stable current path: %s' % exe)
            check(os.path.basename(exe) in payload,
                  'unit starts something that is not in the payload: %s' % exe)
        # without this a decoder that cannot load its library stops being
        # restarted, and a unit that failed is what the Store reports
        check('StartLimitIntervalSec=0' in text,
              'unit gives up after a few restarts: %s' % name)

    for h in spec.get('postInstall', []):
        check(h in payload, 'postInstall script is not in the payload: %s' % h)
        check(os.access(os.path.join(KIT, h), os.X_OK), 'postInstall script is not executable: %s' % h)

    for e in spec.get('enable', []):
        check(e['unit'] in [u['name'] for u in spec.get('units', [])],
              'enable names a unit the component does not install: %s' % e['unit'])

    app = json.load(open(APP, encoding='utf-8'))
    want = app.get('requires', {}).get(spec['id'])
    check(want == spec['version'],
          'the app asks for %s %s, this is %s' % (spec['id'], want, spec['version']))

    if bad:
        for b in bad:
            print('FAIL %s' % b)
        print('%d problem(s)' % len(bad))
        return 1
    print('manifest ok: fields, payload, units, hooks and the app\'s requirement all line up')
    return 0


if __name__ == '__main__':
    sys.exit(main())
