#!/usr/bin/env python3
"""The tool kit pack_tool.py writes, read the way the deploy tool reads it.

What it checks, and why each one would have cost a car-side install:

  * the kit holds component.json at its root, files/<path> and units/<name> -
    not the tool's own folder names, not a top folder of its own;
  * an executable comes out executable and a library not;
  * the catalog states the artifact's real size and sha256 (a mismatch is
    refused before anything installs) and names <id>@<version>.tgz;
  * the catalog is schema 2, one component, kind tool, for iDrive 7;
  * the same folder packs to the same bytes, or "the catalog says 50120
    bytes" would stop being true on the next build;
  * a manifest naming a file that is not there fails the pack, not the car.

    python3 kit/tools/test_pack_tool.py
"""
import gzip
import hashlib
import io
import json
import os
import sys
import tarfile
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, HERE)
import pack_tool  # noqa: E402

COMP = os.path.join(ROOT, 'kit', 'carlife-tap')
problems = []


def check(cond, what):
    if not cond:
        problems.append(what)


def members_of(path):
    with gzip.open(path, 'rb') as gz, tarfile.open(fileobj=gz, mode='r') as tf:
        return {m.name: m for m in tf.getmembers()}


def main():
    with tempfile.TemporaryDirectory() as tmp:
        kit, cat, catalog = pack_tool.pack(COMP, tmp, '605988871/id7-tools-cn', 'catalog')
        name = os.path.basename(kit)
        blob = open(kit, 'rb').read()
        src = json.load(open(os.path.join(COMP, 'component.json'), encoding='utf-8'))

        # the kit's shape
        check(name == '%s@%s.tgz' % (src['id'], src['version']), 'kit name %s' % name)
        members = members_of(kit)
        want = {'component.json'} | {'files/' + f['path'] for f in src['files']}
        want |= {'units/' + u['name'] for u in src.get('units') or []}
        check(set(members) == want, 'kit members %s' % sorted(set(members) ^ want))
        check(not any(m.startswith(('carlife-tap/', './')) for m in members), 'kit has a top folder')
        for m in members.values():
            check(m.mtime == 0 and m.uid == 0 and m.gid == 0 and not m.uname and not m.gname,
                  '%s carries a timestamp or an owner' % m.name)

        # the manifest inside is the folder's, byte for byte
        with gzip.open(kit, 'rb') as gz, tarfile.open(fileobj=gz, mode='r') as tf:
            inside = tf.extractfile('component.json').read()
        check(inside == open(os.path.join(COMP, 'component.json'), 'rb').read(), 'component.json differs inside the kit')
        check(json.loads(inside.decode('utf-8'))['version'] == src['version'], 'version inside the kit')

        # modes: what the unit runs is executable, the preloaded library is not
        check(members['files/carlife-decode'].mode & 0o777 == 0o755, 'carlife-decode is not 0755')
        check(members['files/install.sh'].mode & 0o777 == 0o755, 'install.sh is not 0755')
        check(members['files/libcarlife-tap.so'].mode & 0o777 == 0o644, 'libcarlife-tap.so is not 0644')

        # the unit is in the kit, so install.sh's /var/opt/<id>/current path exists after an install
        unit = members['units/carlife-decode.service']
        check(unit.size > 0, 'the unit is empty')

        # the catalog
        doc = json.load(open(cat, encoding='utf-8'))
        check(doc.get('schema') == 2 and len(doc.get('components') or []) == 1, 'catalog schema/components')
        e = doc['components'][0]
        art = e['artifact']
        check(e['id'] == src['id'] and e['kind'] == 'tool', 'catalog id/kind')
        check(e['version'] == src['version'], 'catalog version')
        check(art['name'] == name, 'catalog artifact name %s' % art['name'])
        check(art['size'] == len(blob), 'catalog size %d, file %d' % (art['size'], len(blob)))
        check(art['sha256'] == hashlib.sha256(blob).hexdigest(), 'catalog sha256')
        check(art['url'] == 'https://github.com/605988871/id7-tools-cn/releases/download/catalog/' + name,
              'catalog url %s' % art['url'])
        check(e.get('mguHmi') == src.get('mguHmi'), 'catalog mguHmi')
        check(e.get('uninstallable') is True, 'catalog uninstallable')
        check((e.get('texts') or {}).get('zh', {}).get('title') == src['title'], 'catalog zh title')

        # equal folders, equal bytes: the catalog's sha256 stays true across builds
        twice = os.path.join(tmp, 'again')
        kit2, _, _ = pack_tool.pack(COMP, twice, '605988871/id7-tools-cn', 'catalog')
        check(open(kit2, 'rb').read() == blob, 'packing twice gave different bytes')

        # a manifest naming a file that is not there stops the pack here
        broken = os.path.join(tmp, 'broken')
        os.makedirs(broken)
        bad = dict(src)
        bad['files'] = [{'path': 'not-there.so', 'mode': '0644'}]
        json.dump(bad, open(os.path.join(broken, 'component.json'), 'w', encoding='utf-8'))
        try:
            pack_tool.pack(broken, os.path.join(tmp, 'out-broken'))
            problems.append('a missing file did not stop the pack')
        except SystemExit:
            pass

        # the deploy tool extracts with the system tar, which reads what the store
        # does (files, no top folder); the shape checked above is that contract

        print('%d KiB kit, %d bytes catalog' % (len(blob) // 1024, len(open(cat, 'rb').read())))
        if problems:
            print('pack_tool: %d problem(s)' % len(problems))
            for p in problems:
                print('  - ' + p)
            return 1
        print('pack_tool ok: kit layout, modes, catalog size and sha256, determinism')
        return 0


if __name__ == '__main__':
    sys.exit(main())
