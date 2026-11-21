#!/usr/bin/env python3
"""Pull the upstream repository's changes into this Chinese fork.

Why not a plain `git pull`: this repository was started from a snapshot of the upstream
tree (the first commit imports all 700-odd files, with no upstream history behind it), so
the two histories share no ancestor. The first merge therefore has to be told where the
snapshot came from (`git replace --graft`); the merge commit that comes out of it carries
the upstream commit as a parent, and from then on the fork has real ancestry and a plain
`git merge upstream/main` works.

Why it downloads files itself: GitHub will not hand out objects by blob SHA - the lazy
fetch a partial clone relies on answers "upload-pack: not our ref" - so we fetch the
trees only (`--filter=blob:none`, which is quick: no file contents), then fetch the
handful of files that actually changed from raw.githubusercontent, write them into the
object store with `git hash-object -w`, and let `git merge` run entirely offline.

    python3 tools/upstream-sync/upstream.py status   # is there anything new, and what would it touch
    python3 tools/upstream-sync/upstream.py merge    # fetch the changes and merge them
    python3 tools/upstream-sync/upstream.py gaps     # after merging: which English strings are untranslated
"""
import json
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CONFIG = ROOT / '.upstream' / 'config.json'
RAW = 'https://raw.githubusercontent.com/{owner}/{repo}/{sha}/{path}'
APPS = ROOT / 'apps'
LOCALE = ROOT / 'kit' / 'runtime' / 'locales' / 'zh-CN.json'
CJK = re.compile('[\u4e00-\u9fff]')
DEFAULTS = {
    'url': 'https://github.com/cauliflowermossgrape/idrive7-apps',
    'branch': 'main',
    'baseline': '',
}


# --------------------------------------------------------------------------- git

def git(*args, check=True, data=None):
    r = subprocess.run(['git', '-C', str(ROOT)] + list(args), input=data,
                       capture_output=True)
    if check and r.returncode:
        raise SystemExit('git %s 失败：%s' % (' '.join(args), r.stderr.decode('utf-8', 'replace').strip()))
    return r


def text(*args, check=True):
    return git(*args, check=check).stdout.decode('utf-8', 'replace')


def tree(rev):
    """path -> blob sha, from a commit's tree (no file contents are read)."""
    out = text('ls-tree', '-r', rev)
    d = {}
    for line in out.splitlines():
        meta, path = line.split('\t', 1)
        d[path] = meta.split()[2]
    return d


def changed(base, target):
    """[(status, path)], no rename detection: git would want blob contents for it."""
    out = text('diff', '--no-renames', '--name-status', base, target)
    rows = []
    for line in out.splitlines():
        parts = line.split('\t')
        rows.append((parts[0][0], parts[-1]))
    return rows


def has_merge_base(a, b):
    return git('merge-base', a, b, check=False).returncode == 0


# ------------------------------------------------------------------------ config

def load():
    cfg = dict(DEFAULTS)
    if CONFIG.exists():
        cfg.update(json.loads(CONFIG.read_text(encoding='utf-8')))
    if not cfg.get('baseline'):
        raise SystemExit('缺少基线：先在 .upstream/config.json 里填 baseline（上游提交 SHA）')
    return cfg


def save(cfg):
    CONFIG.parent.mkdir(exist_ok=True)
    CONFIG.write_text(json.dumps(cfg, ensure_ascii=False, indent=2) + '\n', encoding='utf-8', newline='\n')


def remote_head(cfg):
    out = text('ls-remote', cfg['url'], 'refs/heads/' + cfg['branch']).strip()
    if not out:
        raise SystemExit('上游没有分支 %s：%s' % (cfg['branch'], cfg['url']))
    return out.split()[0]


# ------------------------------------------------------------------------ remote

def fetch_trees(cfg):
    """The upstream branch's commits and trees, no file contents."""
    print('取上游树（不含文件内容）……')
    git('fetch', '--no-tags', '--filter=blob:none', cfg['url'],
        '%s:refs/remotes/upstream/main' % cfg['branch'])
    return text('rev-parse', 'refs/remotes/upstream/main').strip()


def download(cfg, sha, path):
    m = urllib.parse.urlparse(cfg['url'])
    parts = [p for p in m.path.strip('/').split('/') if p]
    repo = parts[-1][:-4] if parts[-1].endswith('.git') else parts[-1]
    owner = parts[-2]
    url = RAW.format(owner=owner, repo=repo, sha=sha, path=urllib.parse.quote(path))
    last = None
    for attempt in range(3):
        try:
            with urllib.request.urlopen(url, timeout=90) as r:
                return r.read()
        except (urllib.error.URLError, OSError) as e:
            last = e
            time.sleep(2 * (attempt + 1))
    raise SystemExit('下载失败 %s：%s' % (path, last))


def have(sha):
    return git('cat-file', '-e', sha, check=False).returncode == 0


def ensure(cfg, rev, path, want):
    """Put one file's content for rev into the object store."""
    if have(want):
        return False
    data = download(cfg, rev, path)
    got = git('hash-object', '-w', '-t', 'blob', '--stdin', data=data).stdout.decode().strip()
    if got != want:
        raise SystemExit('%s@%s 的内容与上游不一致（上游 %s，取回 %s）' % (path, rev[:8], want[:8], got[:8]))
    return True


def inject(cfg, base, target):
    """Fetch the contents of every file that changed between base and target.

    Both sides: the merge needs the base version three-way, and our copy of it is the
    localized one, so the base blob is usually missing too."""
    rows = [(s, p) for s, p in changed(base, target) if s != 'D']
    if not rows:
        return 0
    base_tree = tree(base)
    target_tree = tree(target)
    done = 0
    for status, path in rows:
        if status == 'M':
            done += ensure(cfg, base, path, base_tree[path])
        done += ensure(cfg, target, path, target_tree[path])
    print('取回 %d 个文件（其余未变的文件用本地已有的对象）' % done)
    return done


# ------------------------------------------------------------------------ report

def fork_path(path, ours):
    """Where an upstream path lives here: the apps were renamed with a cn_ prefix."""
    if path in ours:
        return path
    if path.startswith('apps/'):
        cand = 'apps/cn_' + path[len('apps/'):]
        if cand in ours:
            return cand
    return None


def classify(cfg, target):
    base_tree = tree(cfg['baseline'])
    target_tree = tree(target)
    ours = tree('HEAD')
    auto, manual, gone = [], [], []
    for status, path in changed(cfg['baseline'], target):
        if status == 'D':
            gone.append(path)
            continue
        mine = fork_path(path, ours)
        if mine is None:
            if not path.startswith('apps/'):
                auto.append((path, path))       # a new file outside the apps: nothing to clash with
                continue
            hint = ''
            parent, _, name = path[len('apps/'):].rpartition('/')
            if parent and (ROOT / 'apps' / ('cn_' + parent)).is_dir():
                hint = '，应该放到 apps/cn_%s/%s' % (parent, name)
            manual.append((path, status, '上游新文件' + hint))
            continue
        if path not in base_tree:
            manual.append((path, status, '上游新增'))
            continue
        if ours[mine] == base_tree[path]:
            auto.append((path, mine))
        else:
            manual.append((path, status, '我们也改过，三方合并'))
    return auto, manual, gone, ours


def report(cfg, target):
    print('上游 %s  %s：%s' % (cfg['url'], cfg['branch'], target[:8]))
    print('本仓库当前基线：%s' % cfg['baseline'][:8])
    log = text('log', '--oneline', '--no-decorate', '%s..%s' % (cfg['baseline'], target))
    lines = log.strip().splitlines()
    print('落后 %d 个提交：' % len(lines))
    for line in lines:
        print('  ' + line)
    auto, manual, gone, _ = classify(cfg, target)
    print('\n上游改了 %d 个文件：' % (len(auto) + len(manual) + len(gone)))
    print('  我们没动过，直接采用上游：%d' % len(auto))
    if gone:
        print('  上游删除：%d（%s）' % (len(gone), ', '.join(gone[:4])))
    if manual:
        print('  我们也动过，走三方合并（可能冲突）：%d' % len(manual))
        for path, status, why in manual:
            print('    %-52s %s' % (path, why))
        print('\n  这些多半是汉化过的文件（README、app.json 的描述、build.py 的默认语言），')
        print('  合并时保留中文，把上游新增的字段、设置项、版本号带过来。')


# ----------------------------------------------------------------------- command

def cmd_status(_args):
    cfg = load()
    head = remote_head(cfg)
    if head == cfg['baseline']:
        print('上游没有新提交（%s）。' % head[:8])
        return 0
    fetch_trees(cfg)
    report(cfg, head)
    return 0


def cmd_merge(_args):
    cfg = load()
    head = remote_head(cfg)
    if head == cfg['baseline']:
        print('上游没有新提交（%s），不用合并。' % head[:8])
        return 0
    fetch_trees(cfg)
    inject(cfg, cfg['baseline'], head)

    root = text('rev-list', '--max-parents=0', 'HEAD').strip().splitlines()[0]
    if not has_merge_base('HEAD', 'refs/remotes/upstream/main'):
        # First merge only: tell git the snapshot came from the upstream commit we synced.
        # The replace ref stays local (git never pushes refs/replace) and says what is true
        # once the merge commit exists: that upstream commit is an ancestor of ours.
        print('首次合并：把根提交 %s 接到上游 %s 上（git replace --graft）' % (root[:8], cfg['baseline'][:8]))
        git('replace', '--graft', root, cfg['baseline'])

    r = git('merge', '--no-ff', '--no-edit', '-m',
            'Merge upstream %s (%s)' % (cfg['branch'], head[:8]), 'refs/remotes/upstream/main', check=False)
    sys.stdout.write(r.stdout.decode('utf-8', 'replace'))
    sys.stdout.write(r.stderr.decode('utf-8', 'replace'))
    if r.returncode:
        conflicts = text('diff', '--name-only', '--diff-filter=U', check=False).split()
        print('\n合并停在冲突上（%d 个）：' % len(conflicts))
        for c in conflicts:
            print('  ' + c)
        print('\n改完 `git add` 后 `git commit`，再跑 `upstream.py done` 记下新基线。')
        return 1
    cfg['baseline'] = head
    save(cfg)
    print('\n已合并，基线更新为 %s。' % head[:8])
    print('接下来：`upstream.py gaps` 看哪些英文串还没翻，然后构建自测、提交、推送。')
    return 0


def cmd_done(_args):
    cfg = load()
    head = text('rev-parse', 'refs/remotes/upstream/main', check=False).strip()
    if not head:
        raise SystemExit('还没有取过上游：先跑 status')
    cfg['baseline'] = head
    save(cfg)
    print('基线更新为 %s。' % head[:8])
    return 0


def cmd_gaps(args):
    """English strings the interface shows that zh-CN.tsv has no Chinese for.

    Setting labels, screen titles, buttons and rows by default; option values only with
    --all, because most of them are figures ("100-0 / 200-0 km/h", "2.5 bar / 36 psi")
    that read the same in Chinese."""
    words = json.loads(LOCALE.read_text(encoding='utf-8'))
    everything = '--all' in args
    missing = {}
    for manifest in sorted(APPS.glob('*/app.json')):
        spec = json.loads(manifest.read_text(encoding='utf-8'))
        want = set()

        def note(s):
            # Already Chinese (our own apps write their labels in Chinese) or nothing to
            # translate: not a gap.
            if isinstance(s, str) and s.strip() and s not in words and not CJK.search(s):
                want.add(s)

        for s in spec.get('settings', []):
            note(s.get('label'))
            if everything:
                for option in s.get('options', []):
                    note(option[1] if len(option) > 1 else None)
        for screen in spec.get('screens', []):
            note(screen.get('title'))
            for button in screen.get('buttons', []):
                note(button[1] if len(button) > 1 else None)
            for item in screen.get('items', []):
                note(item[2] if len(item) > 2 else None)
        if want:
            missing[manifest.parent.name] = sorted(want)
    total = sum(len(v) for v in missing.values())
    if not total:
        print('界面上的英文串都已有中文（%d 条）。' % len(words))
        return 0
    print('%d 个应用共 %d 条英文串还没有中文：' % (len(missing), total))
    for app, rows in missing.items():
        print('\n%s（%d 条）' % (app, len(rows)))
        for s in rows:
            print('  ' + s)
    print('\n翻好后写进 kit/runtime/locales/zh-CN.tsv（英文<TAB>中文），再跑')
    print('  python3 kit/tools/sync_locales.py zh-CN')
    if not everything:
        print('（设置项的取值没算进来，多数是数字和单位；要看全量加 --all）')
    return 1


def main(argv):
    commands = {'status': cmd_status, 'merge': cmd_merge, 'done': cmd_done, 'gaps': cmd_gaps}
    if not argv or argv[0] not in commands:
        print(__doc__)
        return 2
    return commands[argv[0]](argv[1:])


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
