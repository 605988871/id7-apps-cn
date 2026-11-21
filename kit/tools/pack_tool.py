#!/usr/bin/env python3
"""pack_tool.py - pack a component folder into a tool kit and write its catalog.

    python3 kit/tools/pack_tool.py                       # kit/carlife-tap -> dist/release/carlife-tap
    python3 kit/tools/pack_tool.py --dir kit/carlife-tap --out dist/release/carlife-tap

Output in --out:
    <id>@<version>.tgz   the tool kit the deploy tool installs (deploy/README.md, "Artifacts"):
                         component.json at the root, files/<path>, units/<name>, dropins/<unit>.d/<name>
    catalog.json         a schema-2 catalog naming that one artifact, for a source of its own
                         (docs/PUBLISHING.md, "Catalog")

Why a tool kit at all: this repository is read as a repo tree, and there a
tool is packed from its folder on the head unit. A catalog source instead
downloads one artifact whose size it states - a few tens of KB here - and
never the repository's tree, which is 62 MB and the reason an update of this
tool used to pull the whole project down.

The bytes are a function of the folder alone: fixed mtime, uid, gid and
names, files in sorted order, gzip with no name and no timestamp. Packing
the same tree twice gives the same sha256, which is what the catalog states
and the head unit checks before it installs.
"""
import argparse
import gzip
import hashlib
import io
import json
import os
import re
import sys
import tarfile

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SEMVER = re.compile(r'^\d+\.\d+\.\d+$')
ID = re.compile(r'^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$')


def die(msg):
    raise SystemExit('pack_tool: %s' % msg)


def manifest(comp_dir):
    path = os.path.join(comp_dir, 'component.json')
    if not os.path.isfile(path):
        die('%s: no component.json' % comp_dir)
    with open(path, encoding='utf-8') as f:
        c = json.load(f)
    if c.get('kind') != 'tool':
        die('component.json: kind must be "tool"')
    if not ID.match(c.get('id') or ''):
        die('component.json: needs an id')
    if not SEMVER.match(str(c.get('version') or '')):
        die('component.json: version must be x.y.z')
    if not c.get('files'):
        die('component.json: needs files')
    return c


def members(comp_dir, c):
    """[(name in the kit, source path, mode)] in a fixed order.

    component.json first, then files/ (sorted by path), then units/, then
    dropins/: a kit has one shape, and equal folders give equal bytes."""
    out = [('component.json', os.path.join(comp_dir, 'component.json'), 0o644)]
    for f in sorted(c['files'], key=lambda x: x['path']):
        rel = f['path']
        if rel.startswith('/') or '..' in rel.split('/'):
            die('files: %s stays inside the tool' % rel)
        src = os.path.join(comp_dir, f.get('from') or rel)
        if not os.path.isfile(src):
            die('files: %s is missing (%s)' % (rel, src))
        mode = f.get('mode', '0644')
        mode = int(str(mode), 8) if not isinstance(mode, int) else mode
        out.append(('files/' + rel, src, mode))
    for u in sorted(c.get('units') or [], key=lambda x: x['name']):
        src = os.path.join(comp_dir, u.get('from') or u['name'])
        if not os.path.isfile(src):
            die('units: %s is missing (%s)' % (u['name'], src))
        out.append(('units/' + u['name'], src, 0o644))
    for d in sorted(c.get('dropins') or [], key=lambda x: (x['unit'], x['name'])):
        src = os.path.join(comp_dir, d.get('from') or d['name'])
        if not os.path.isfile(src):
            die('dropins: %s is missing (%s)' % (d['name'], src))
        out.append(('dropins/%s.d/%s' % (d['unit'], d['name']), src, 0o644))
    return out


def pack(comp_dir, out_dir, repo=None, tag='catalog'):
    """Writes the kit and the catalog. Returns (kit path, catalog path, catalog)."""
    comp_dir = os.path.abspath(comp_dir)
    c = manifest(comp_dir)
    gift = '%s@%s.tgz' % (c['id'], c['version'])

    buf = io.BytesIO()
    with gzip.GzipFile(fileobj=buf, mode='wb', mtime=0, compresslevel=9) as gz:
        with tarfile.open(fileobj=gz, mode='w', format=tarfile.GNU_FORMAT) as tf:
            for name, src, mode in members(comp_dir, c):
                with open(src, 'rb') as f:
                    data = f.read()
                ti = tarfile.TarInfo(name)
                ti.size = len(data)
                ti.mode = mode
                ti.mtime = 0
                ti.uid = ti.gid = 0
                ti.uname = ti.gname = ''
                ti.type = tarfile.REGTYPE
                tf.addfile(ti, io.BytesIO(data))
    blob = buf.getvalue()

    os.makedirs(out_dir, exist_ok=True)
    kit = os.path.join(out_dir, gift)
    with open(kit, 'wb') as f:
        f.write(blob)

    url = None
    if repo:
        url = 'https://github.com/%s/releases/download/%s/%s' % (repo.strip('/'), tag, gift)
    entry = {
        'id': c['id'],
        'kind': 'tool',
        'title': c.get('title', c['id']),
        'description': c.get('description', ''),
        'version': c['version'],
        'artifact': {'name': gift, 'size': len(blob), 'sha256': hashlib.sha256(blob).hexdigest(), 'url': url or gift},
        'uninstallable': c.get('uninstallable', True),
        'mguHmi': c.get('mguHmi') or ['ID7'],
    }
    if c.get('title') or c.get('description'):
        entry['texts'] = {'zh': {'title': c.get('title', c['id']), 'description': c.get('description', '')}}
    if c.get('requires'):
        entry['requires'] = c['requires']
    catalog = {'schema': 2, 'components': [entry]}
    cat_path = os.path.join(out_dir, 'catalog.json')
    with open(cat_path, 'w', encoding='utf-8', newline='\n') as f:
        json.dump(catalog, f, ensure_ascii=False, indent=2)
        f.write('\n')

    # the folder is a source on its own: these two files at a repository's root
    # plus the release named catalog, or the same two files on a stick
    with open(os.path.join(out_dir, 'README.md'), 'w', encoding='utf-8', newline='\n') as f:
        f.write(SOURCE_README.format(id=c['id'], version=c['version'], gift=gift,
                                     size=len(blob), repo=(repo or '<owner>/<repo>'), tag=tag))
    return kit, cat_path, catalog


SOURCE_README = """# {id} 源

这是 `{id}` 的独立源：一个组件，一个 release 资产，安装包 {size} 字节。
不放源码，源码在 `id7-apps-cn` 的 `kit/{id}`，这里只放打包结果。

## 发布（每次版本更新）

```
python3 kit/tools/pack_tool.py --repo {repo}          # 在 id7-apps-cn 里跑
gh release create {tag} catalog.json {gift} \\
   -R {repo} --title {tag} --notes "{id} {version}"
```

已有 `{tag}` release 时替换资产：

```
gh release upload {tag} catalog.json {gift} -R {repo} --clobber
```

## 车机上怎么用

MGU Store → 源 → 添加 `{repo}`（有 release，走 Releases 布局）→
只列出 `{id}` 一项，更新时下载 {size} 字节。

U 盘也一样：把 `catalog.json` 和 `{gift}` 放到根目录，作为文件夹源添加。

`catalog.json` 里的 `size` 和 `sha256` 是安装前校验用的，改包必须一起改。
"""


def main(argv=None):
    ap = argparse.ArgumentParser(description='pack a component folder into a tool kit plus its catalog')
    ap.add_argument('--dir', default=os.path.join(ROOT, 'kit', 'carlife-tap'), help='the folder holding component.json')
    ap.add_argument('--out', default=None, help='where the kit and catalog.json go (default dist/release/<id>)')
    ap.add_argument('--repo', default='605988871/id7-tools-cn',
                    help='owner/name of the repository whose release serves the kit (the catalog\'s artifact url)')
    ap.add_argument('--tag', default='catalog', help='the release tag (the Store reads catalog.json from a release named catalog)')
    a = ap.parse_args(argv)
    c = manifest(a.dir)
    out = a.out or os.path.join(ROOT, 'dist', 'release', c['id'])
    kit, cat, catalog = pack(a.dir, out, a.repo, a.tag)
    art = catalog['components'][0]['artifact']
    print('%s %s: %s (%d KiB)' % (c['id'], c['version'], os.path.relpath(kit, ROOT), len(open(kit, 'rb').read()) // 1024))
    print('  sha256 %s' % art['sha256'])
    print('  catalog %s' % os.path.relpath(cat, ROOT))
    print('  artifact url %s' % art['url'])


if __name__ == '__main__':
    main()
