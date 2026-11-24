#!/usr/bin/env python3
"""Check the component the way the Store reads it, before it is packed.

The Store takes a flat payload (one file name per entry, no directories), starts
what `units` names through /var/opt/<id>/current, and installs the app only if
its `requires` names this exact version. Every one of those is a silent failure
when it is wrong: the app installs, the tool does not run, and the screen says
"no report" for ever.

usage: python test/component_test.py
"""
import json
import subprocess
import sys
from pathlib import Path

# This file lives with the native tools (link/test/) but checks the component
# directory above them. Walking up to component.json instead of counting
# parents keeps it working from either place - it spent a while failing with
# "No such file: link/component.json", i.e. doing no checking at all.
HERE = Path(__file__).resolve().parent
while HERE != HERE.parent and not (HERE / 'component.json').exists():
    HERE = HERE.parent
ELF_CHECK = Path(__file__).resolve().parent / 'elf_check.py'
ROOT = HERE.parent.parent
APP = ROOT / 'apps/cn_carlife_wireless/app.json'
problems = []


def check(ok, what):
    print(('  ok   ' if ok else '  FAIL ') + what)
    if not ok:
        problems.append(what)


def main():
    spec = json.loads((HERE / 'component.json').read_text(encoding='utf-8'))
    check(spec.get('id') == HERE.name, 'the component id is the directory name')
    check(spec.get('kind') == 'tool', 'the component is a tool')
    check(isinstance(spec.get('version'), str) and spec['version'].count('.') == 2, 'the version is x.y.z')

    files = {f['path']: f.get('mode') for f in spec.get('files', [])}
    for name, mode in files.items():
        check((HERE / name).exists(), 'payload file exists: ' + name)
        check(mode in ('0644', '0755'), 'payload mode is set: ' + name + ' (' + str(mode) + ')')
    check(files.get('carlife-link') == '0755', 'the binary is executable in the payload')

    units = [u['name'] for u in spec.get('units', [])]
    check(bool(units), 'the component ships a unit')
    launcher = HERE / 'run.sh'
    run_txt = launcher.read_text(encoding='utf-8') if launcher.exists() else ''
    for unit in units:
        path = HERE / unit
        check(path.exists(), 'unit file exists: ' + unit)
        if path.exists():
            text = path.read_text(encoding='utf-8')
            stable = '/var/opt/%s/current/' % spec['id']
            check(stable in text, 'the unit starts a payload file through the Store\'s stable path')
            if unit == 'carlife-wireless.service':
                # Since 0.5.0 the stream unit runs run.sh, which owns the whole
                # two-process pipeline; the binary is started by the launcher,
                # not by systemd. This used to assert the old direct ExecStart
                # and had been red ever since - a check nobody could see fail.
                check(stable + 'run.sh' in text, 'the stream unit runs the launcher')
                check('--report "$DIR/link.txt"' in run_txt and
                      'DIR=${CARLIFE_DIR:-/dev/shm/carlife-wireless}' in run_txt,
                      'the launcher writes its report where the app reads it')
    check(any(e.get('unit') in units for e in spec.get('enable', [])), 'the unit is enabled at install time')
    check(bool(spec.get('postInstall')), 'a postInstall script runs after every install')
    for script in spec.get('postInstall', []):
        check(script in files, 'postInstall names a payload file: ' + script)

    res = subprocess.run([sys.executable, str(ELF_CHECK), str(HERE / 'carlife-link')],
                         capture_output=True, text=True)
    check(res.returncode == 0, 'the payload is a binary the unit can start')
    if res.returncode:
        print('        ' + (res.stderr or res.stdout).strip())

    if APP.exists():
        app = json.loads(APP.read_text(encoding='utf-8'))
        req = app.get('requires', {}).get(spec['id'])
        check(req == spec['version'], 'the app requires this exact version (%s)' % req)
    else:
        check(False, 'the app that uses this tool is present')

    repo = json.loads((ROOT / 'mgu-repo.json').read_text(encoding='utf-8'))
    entry = [t for t in repo.get('tools', []) if t.get('id') == spec['id']]
    check(len(entry) == 1, 'the repository lists the tool once')
    if entry:
        check(Path(entry[0].get('path', '')) == HERE.relative_to(ROOT), 'the listed path is this directory')

    print('\n%d checks failed' % len(problems) if problems else '\nall checks passed')
    return 1 if problems else 0


if __name__ == '__main__':
    sys.exit(main())
