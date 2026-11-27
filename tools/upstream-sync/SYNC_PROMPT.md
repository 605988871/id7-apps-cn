# 上游同步执行说明（可直接当提示词用）

**用法**：新开一个会话，把本文件整段贴给 AI；或者只说一句：

> 按 `D:\id7-apps-cn\tools\upstream-sync\SYNC_PROMPT.md` 执行一次上游同步。

**桌面副本**：`C:\Users\60598\Desktop\id7-apps-cn-上游同步.md`，方便随时打开复制。仓库里这份是源文件——**改了源文件要重新复制过去**，否则桌面那份会停在旧版本：

```bash
cp D:/id7-apps-cn/tools/upstream-sync/SYNC_PROMPT.md "C:/Users/60598/Desktop/id7-apps-cn-上游同步.md"
```

执行者动手前必须先读 `.upstream/config.json` 和 `git log -1`：本文件末尾的「当前快照」可能已经过期，**基线以配置文件为准，不要以本文为准**。

---

## 双上游（2026-11-27 起）

本仓库现在有**两个上游**，都记在 `.upstream/config.json` 的 `upstreams[]` 里；顶层的
`url`/`branch`/`baseline` 仍是 idrive7-apps，给 `upstream.py` 用（向后兼容）。

| 上游 | 类型 | 同步方式 |
|---|---|---|
| `cauliflowermossgrape/idrive7-apps` | 源码（main） | 本文下面的流程：`upstream.py status/merge`，源码合并 + 增量汉化。应用目录 `apps/cn_<name>` |
| `IterioDev/car-apps` | 预编译 tgz（main） | 见下方「car-apps 同步」：**不能**用 upstream.py 合并源码（仓库里只有 tgz），要解包→翻译→重打包 |

两者同步后都要：更新 `.upstream/config.json` 里对应上游的 `baseline`、跑测试、提交推送。

### car-apps 同步（预编译 app）

1. 克隆/更新 `IterioDev/car-apps`（网络不稳时要重试多次），基线记在 `upstreams[].baseline`。
2. 每个 app 在 `apps/<id>/` 只有 `app.json` + `<id>@<ver>.tgz` + 图标，没有源码。tgz 里的
   `renderer/screens.json` 是主要 UI（显示文本在 `opts.text/title/sub/tabs`），
   `src/*.js` 是应用逻辑，`renderer/kit/fonts/` 是字体图集。
3. 汉化流程：解包 tgz → 用 `kit/runtime/locales/zh-CN.json` 的现成译法 + 增量翻译
   翻译 screens.json 的显示字段 → **不要翻译 `src/*.js` 的字符串字面量**
   （里面有 `op:'stop'`、`'error'`、`typeof === 'number'`、`'driver'` 等协议/标识符，翻译会破坏功能）
   → 注入本仓库的 `kit/runtime/fonts/cjk.json` 并把 tgz 内的 `renderer/kit/fonts.js`
   换成 `kit/runtime/fonts.js`（支持中文自动选图集）→ 重打包为 `cn_iteriodev_<name>@<ver>.tgz`。
4. app.json：id 改为 `cn_iteriodev_<name>`，title/description 中文，`texts.zh-CN.title`，
   加 `"source": "IterioDev/car-apps"` 标记（build.py 与 test_zh.py 据此识别预构建 app）。
   `requires` 里的工具 id（如 `iteriodev-comfort`）**保持原样**。
5. 工具：复制到 `tools/cn_iteriodev_<name>/`，component.json **原样不动**
   （systemd/socket 依赖原 id），在 `mgu-repo.json` 的 `tools[]` 登记，
   id 用原名、path 指向新目录、title/description 写中文。
6. `build.py` 有预构建分支：看到 app 目录里的 `<id>@<ver>.tgz` 就直接复制到 dist，
   不需要 SDK、不走 kit 构建。`test_zh.py` 会跳过带 `source` 标记的 app。
7. 新增翻译补进 `kit/runtime/locales/zh-CN.tsv`（繁体由 OpenCC s2twp 生成），
   并重烘 cjk 图集（`kit/tools/bake_cjk.py`，本仓库用系统 Noto Sans SC VF +
   临时绕过 SHA 校验，因为网络下载官方字体不通）。

---

## 0. 任务

把上游 `cauliflowermossgrape/idrive7-apps` 的 `main` 分支上的新提交，同步进本地仓库 `id7-apps-cn`（本机 `D:\id7-apps-cn`，`origin` = `605988871/id7-apps-cn`），并且满足三条硬要求：

1. **保留全部简体中文汉化**：`apps/*/app.json` 的 `description`、`texts.zh-CN`，以及 `kit/runtime/locales/zh-CN.tsv` 里的每一条译文，都不能被上游英文覆盖。
2. **保留中文应用名**：商店里显示的名字和车机里显示的标题都必须是中文，且两处一致，不带「中文版」之类的后缀。
3. **上游的新功能要跟着汉化**：新增的英文串补进 `zh-CN.tsv`；上游新增的应用要改成 `cn_` 前缀并起中文名。**只补新增/变更的串，已有的 2600 多条译文一条都不重译。**

工作方式：**先只读体检并汇报，再合并**。如果上游没有新提交，直接报告并结束，不要制造空提交。

---

## 1. 事实底账（不要弄错的部分）

| 项 | 值 |
|---|---|
| 本地仓库 | `D:\id7-apps-cn`，分支 `master` |
| `origin` | `https://github.com/605988871/id7-apps-cn`（用户本人的仓库） |
| `upstream` | `https://github.com/cauliflowermossgrape/idrive7-apps.git`，分支 `main`（写成不带 `.git` 也行，是同一个仓库） |
| 同步基线 | `.upstream/config.json` 的 `baseline`（指向已同步到的上游提交） |
| 同步工具 | `tools/upstream-sync/upstream.py`，子命令 `status` / `merge` / `done` / `gaps` |
| 应用目录约定 | `apps/cn_<上游名>`，`app.json` 的 `id` 也是 `cn_` 开头（如 `cn_service`） |
| 构建产物 | `dist/cn_<id>`；`build.py` 接受裸名和 `cn_` 名，裸名产物仍落在 `dist/cn_<id>` |
| 汉化源文件 | `kit/runtime/locales/zh-CN.tsv`（唯一手工编辑处），JSON 由脚本生成 |
| 商店清单 | `mgu-repo.json`（`tools[]` 是可在商店安装的组件，应用不在这里登记） |

**账号事实**：`605988871` 是用户本人账号；`JackieZ123430` 是这套简体中文汉化的**原作者署名**（出现在 `credit.*.json`、`NOTICE.zh-CN.md`、`LICENSE`、上游 PR 里）。**不要**把署名改成 `605988871`，也不要删掉它；仓库链接已统一指向 `605988871/id7-apps-cn`，保持现状。

---

## 2. 执行流程

### 第 1 步：只读体检（不改任何文件）

```bash
cd /d/id7-apps-cn
git status -sb
git log --oneline -3
python3 tools/upstream-sync/upstream.py status
# status 走本地缓存，必要时用实时接口复核上游 HEAD：
git ls-remote https://github.com/cauliflowermossgrape/idrive7-apps.git refs/heads/main
```

判定：

- **status 说「上游没有新提交」** → 再跑一次 `gaps` 和下面的「中文名检查」，然后报告「无需同步」并**结束**。不要为了显得有产出而改代码。
- **有新提交** → 把提交列表、涉及文件数、是否动到 `apps/*/app.json`、`kit/tools/build.py`、`kit/runtime/locales/`、`mgu-repo.json` 先讲清楚，再进入第 2 步。

> 如果用户说「上游更新了」但 `status` 说没有：核对 `ls-remote` 的 SHA 与 `baseline` 是否一致，并提示可能是**未合并的 PR** 或别的仓库。不要凭感觉去合并。

### 第 2 步：合并

```bash
python3 tools/upstream-sync/upstream.py merge
```

- **不要加 `--merge-commit`**：会把上游 500+ 个提交作为祖先一起上传（约 30 MB），这台机器上行会卡十几分钟。默认压成普通提交，推送只要几秒。
- 合并成功时脚本会自动把 `baseline` 推到新的上游提交；如果停在冲突上，解完冲突 `git commit` 后再跑 `python3 tools/upstream-sync/upstream.py done` 手工记基线。
- 合并后**立刻**检查有没有出现 `apps/<裸名>/` 这样的新目录（上游新增应用）：

```bash
git status --short | grep -E '^\?\?|^A ' | grep 'apps/' | grep -v 'apps/cn_'
```

有的话 `git mv apps/<名字> apps/cn_<名字>`，并把 `app.json` 的 `id`、以及内部 `require('./...')` 之外所有按 id 写死的地方改成 `cn_`。

### 第 3 步：解冲突（按表，不要整份覆盖）

总原则：**中文以我们为准，上游新增的字段/设置项/版本号必须原样带过来。**

| 冲突文件 | 处理 |
|---|---|
| `README*.md`、`docs/*.md` | 保留我们的（`git checkout --ours -- <文件>`），上游英文改动不要 |
| `apps/*/app.json` | 逐块看。`description`、`texts` 用我们的中文；`version`、`settings`、`signals`、`config`、`screens` 用上游的（版本号最后按发布节奏定） |
| `kit/tools/build.py` | 默认语言 `zh-CN` 保留；上游新加的语言参数照收 |
| `kit/tools/sync_locales.py` | 保留我们的 LF 写法；上游加语言的改动要收 |
| `kit/runtime/locales/zh-CN.tsv` | 保留我们的中文条目；上游若也加了同键条目，用我们的译法，只把缺的键补进来 |
| `mgu-repo.json` | 我们工具条目的中文 `title`/`description` 保留；上游新增的工具条目要收 |
| `apps/cn_*/*` | git 改名检测通常能跟上；散落的新文件 `git mv` 进 `cn_` 目录 |

**禁止**：`git checkout --theirs -- apps/*/app.json` 这种整份覆盖（会一次性丢光中文），也不要 `git rebase` / `reset --hard` / 强推。

### 第 4 步：补译新功能（增量汉化）

```bash
python3 tools/upstream-sync/upstream.py gaps        # 界面可见、但 tsv 里没有译文的英文串
python3 tools/upstream-sync/upstream.py gaps --all  # 连设置项的取值一起看（数字/单位居多，一般不用）
```

补译步骤：

1. `grep -n "要译的英文" kit/runtime/locales/zh-CN.tsv`，先看**同一词根/同一功能**现有的译法，保持术语一致（例：`ambient` 一律「氛围灯」，`brightness`「亮度」，`dimmer`「减光」，`HUD` 不译）。
2. 按 `英文<TAB>中文` 追加到 `kit/runtime/locales/zh-CN.tsv`，**必须 LF 换行、不要加空行**。
3. `python3 kit/tools/sync_locales.py zh-CN` 重新生成 `zh-CN.json`（**绝不直接编辑 JSON**）。
4. 重跑 `gaps`，直到输出「界面上的英文串都已有中文」。

翻译口径：

- 界面动作用词统一：`Enable/Disable` → 开启/关闭，`Show` → 显示，`Settings` → 设置，`Default` → 默认，`Apply` → 应用。
- 中文标点用全角；单位、协议名、专有名词保留原文（`bar`、`ms`、`HUD`、`DME`、`SOME/IP`、`iDrive 7`、`BMW`）。
- 不要出现「中文版」后缀，不要把英文品牌名意译。

### 第 5 步：上游新增功能/应用的特殊处理

**新增应用**（同时改这几处，漏一处就会出现「商店中文、车机英文」）：

1. 目录 `apps/<name>` → `apps/cn_<name>`，`app.json` 的 `id` → `cn_<name>`；
2. `app.json` 的 `title` 保留上游英文（作为英文环境的显示名），新增 `texts.zh-CN.title` 写中文名；
3. `description` 译成中文；
4. `kit/runtime/locales/zh-CN.tsv` 加一行 `<英文 title>\t<中文名>`；
5. 若该应用带可安装组件，`mgu-repo.json` 的 `tools[]` 加条目，`title`/`description` 写中文；
6. 全仓库把 `apps/<name>` / `dist/<name>` / `'apps', '<name>'` 改成 `cn_` 形式（`build.py` 已兼容裸名，但测试与文档要一致）。

**新增设置项 / 屏幕 / 按钮**：`label`、屏幕 `title`、按钮标签、`items` 文本都进 `gaps`，逐条补；`select` 的**选项值**（写进配置的内部值）不能译，只译显示文本。

**新增信号/字段**：照收，不译；同时检查 `app.json` 的 `requires` 版本与 `mgu-repo.json` 组件 `version` 是否对得上（脚本见第 6 步）。

**版本号**：`app.json` 的 `version` 收上游的；`build.py` 的 `package_version()` 对 `zh-CN` 和 `en` **不发语言后缀**这一条必须保持，否则 `mgu-repo.json` 里 `dist/{id}@{version}.tgz` 会对不上。

### 第 6 步：验证（缺一项都要在报告里说明）

```bash
cd /d/id7-apps-cn

# 1) JSON 全部合法 + 应用 id 与目录一致 + requires 不悬空
python3 - <<'EOF'
import json, os, glob
bad = []
for f in [f for f in os.popen('git ls-files "*.json"').read().split('\n') if f]:
    try: json.load(open(f, encoding='utf-8'))
    except Exception as e: bad.append((f, str(e)[:70]))
sem = lambda v: tuple(int(x) for x in v.split('.'))
repo = json.load(open('mgu-repo.json', encoding='utf-8'))
comp = {}
for t in repo['tools']:
    comp[json.load(open(os.path.join(t['path'], 'component.json'), encoding='utf-8'))['id']] = \
        json.load(open(os.path.join(t['path'], 'component.json'), encoding='utf-8'))['version']
for f in sorted(glob.glob('apps/*/app.json')):
    d = os.path.basename(os.path.dirname(f)); s = json.load(open(f, encoding='utf-8'))
    if s.get('id') != d: bad.append((d, 'id != dir'))
    for rid, ver in (s.get('requires') or {}).items():
        if rid == 'idrive7-renderd': continue
        if rid not in comp: bad.append((d, 'requires missing ' + rid))
        elif sem(comp[rid]) < sem(ver): bad.append((d, '%s needs %s > %s' % (rid, ver, comp[rid])))
print('json/apps/tools:', len(glob.glob('apps/*/app.json')), '| problems:', len(bad))
for b in bad: print(' BAD', b)
EOF

# 2) 语法
python3 - <<'EOF'
import subprocess, os
bad = []
for f in [f for f in subprocess.check_output(['git', 'ls-files', '*.py']).decode().split('\n') if f]:
    try: compile(open(f, encoding='utf-8').read(), f, 'exec')
    except SyntaxError as e: bad.append((f, e.lineno))
for f in [f for f in subprocess.check_output(['git', 'ls-files', '*.js']).decode().split('\n') if f]:
    if '/emu/web/' in f.replace('\\', '/'): continue
    if subprocess.run(['node', '--check', f], capture_output=True).returncode: bad.append((f, 'js'))
print('syntax problems:', bad or 'none')
EOF

# 3) 中文名两处一致（商店名 == 车机 TITLE，且不含「中文版」）
python3 - <<'EOF'
import copy, glob, json, sys
sys.path.insert(0, 'kit/tools')
import build
from localize import localize_spec
bad = []
for m in sorted(glob.glob('apps/*/app.json')):
    spec = json.load(open(m, encoding='utf-8'))
    _, ui, strings, _ = build.build_ui(copy.deepcopy(localize_spec(spec, 'zh-CN')), 'zh-CN')
    title = strings.get(build.sid(spec['id'], 'TITLE'), '')
    zh = ((spec.get('texts') or {}).get('zh-CN') or {}).get('title', '')
    if not title or title != zh or '中文版' in title:
        bad.append((spec['id'], title, zh))
    print('%-20s %s' % (spec['id'], title))
print('name problems:', bad or 'none')
EOF

# 4) 缺译必须为 0
python3 tools/upstream-sync/upstream.py gaps

# 5) 语言与布局回归
(cd kit/tools && python3 test_zh.py && python3 test_id8_ui.py && python3 test_fit_to_unit.py)

# 6) 构建验证（挑这次动过的应用；至少一个）
python3 kit/tools/build.py --preview-only cn_service
```

已知环境限制（**不是代码问题**，跳过时在报告里写清楚）：

- `test_es.js` / `test_ko.js` / `test_zh_TW.js` / `test_atlas_pieces.js` 要重建 `dist/` 里多个应用，会触发批量删除保护 —— 不要绕过，报告跳过。
- `test_ambient_others.js` 在 Windows 上起不了 unix socket（EACCES）；`test_live_data.js` 需要 symlink 权限；`test_zh_TW.py` 需要 `opencc`。
- `test_diagnostic_ru.js` 要求 `dist/cn_dtc_scanner` 是俄语产物；先 `build.py --preview-only --language ru dtc_scanner`，跑完把产物移出仓库。

### 第 7 步：提交与推送

提交信息分两段写清楚：「同步上游 `<旧>..<新>`」+「补译 n 条 / 冲突取舍」。

```bash
cd /d/id7-apps-cn
git add -A -- . ':!dist'
git commit -F - <<'EOF'
同步上游 <旧短SHA>..<新短SHA>

上游改动：<一句话，例如 氛围灯 2.7.17、新增 xxx 设置项>
冲突取舍：app.json 保留中文 description/texts，收下 version 与新增 settings；
          README 全保留中文版。
汉化：gaps 补译 n 条（列出关键几条），zh-CN.tsv -> zh-CN.json 已重新生成。
验证：gaps 为 0；中文名 15/15 一致；test_zh.py / test_id8_ui / test_fit_to_unit 通过；
      cn_service preview 构建正常。
EOF

GIT_HTTP_LOW_SPEED_LIMIT=100 GIT_HTTP_LOW_SPEED_TIME=600 \
  timeout 900 git -c http.version=HTTP/1.1 push origin master

git fetch origin master -q
git log --oneline -1 origin/master
git status -sb | head -2      # 应为 ## master...origin/master，无 ahead/behind
```

**token 没有 `workflow` scope 时**，提交里只要带上 `.github/workflows/*.yml` 就会被整次拒绝。不要硬推，按 `tools/upstream-sync/README.md` 末尾的命令把这次新增的 workflow 文件从提交里摘掉再推，并在报告里说明「该 CI 文件没跟上上游」。

### 第 8 步：汇报格式

用一张表说清结果，不要只写「已完成」：

| 项 | 内容 |
|---|---|
| 上游区间 | `旧SHA .. 新SHA`，共 n 个提交 |
| 改动规模 | n 个文件，+x/−y 行 |
| 应用变化 | 新增/修改了哪些应用、哪些设置项 |
| 汉化补译 | n 条（列出英文 → 中文） |
| 冲突取舍 | 哪些文件保留了中文、哪些字段收了上游 |
| 中文名 | 15/15 商店与车机一致（或说明新增应用的名） |
| 验证 | 通过项 / 跳过项及原因 |
| 遗留 | 需要用户决定的事（版本号、要不要发版、CI 文件等） |

---

## 3. 禁止事项

1. 不 `git rebase`、不 `reset --hard`、不强推。
2. 不用 `--merge-commit`（默认压缩即可）。
3. 不整份 `checkout --theirs/--ours` 覆盖 `app.json`。
4. 不直接编辑 `kit/runtime/locales/zh-CN.json`（由 TSV 生成）。
5. 不改 `LICENSE` 的 Copyright 行，不删 `JackieZ123430` 署名。
6. 不在上游无更新时制造提交；不为「看起来完整」而重译已有条目。
7. 不删 `dist/`、`D:\_dist_hold` 等构建产物（除非用户明确要求）。
8. 不动用户的自定义设置与 `cn_` 前缀体系。

---

## 4. 当前快照（写于 2026-11-22，仅供对照，执行前请重新核对）

| 项 | 值 |
|---|---|
| 已同步上游 | `df4c5fcbdc37d6c153280ab54090ac17c031c560` |
| 本地 HEAD | `56aa5b6`（署名与仓库链接修正） |
| 应用数 | 15 个，全部 `cn_` 前缀 |
| 商店可安装工具 | `idrive7-renderd`、`mgu-inputgate` |
| 简体中文条目 | 2626 条（`zh-CN.tsv` 共 2642 行） |
| `gaps` | 0 条缺译 |
| 中文名 | 15/15 商店名与车机标题一致 |

> 自研应用（CarLife 投屏、转向影像、CarLife 诊断）已全部移除，本仓库现在只维护上游那 15 个应用的汉化。如果 `apps/` 下出现非 `cn_` 目录，那就是这次上游新加的应用，按第 5 步处理。
