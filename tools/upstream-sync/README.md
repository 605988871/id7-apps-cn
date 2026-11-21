# 把上游更新并进这个中文仓库

上游是 [`cauliflowermossgrape/idrive7-apps`](https://github.com/cauliflowermossgrape/idrive7-apps)
（`main` 分支）。本仓库是它的中文分支：应用加了 `cn_` 前缀、界面与文档换成中文、并加了
CarLife 地图和转向影像两个自研应用。

## 和普通 fork 不一样的两个地方

**一、没有共同祖先。** 本仓库的第一个提交是整包导入（732 个文件，没有上游历史）。
`git merge upstream/main` 会直接拒绝：*refusing to merge unrelated histories*。
所以第一次合并要用 `git replace --graft` 告诉 git「这份快照来自上游的哪个提交」；
合并提交出来以后，上游那个提交就成了我们的祖先，血缘是真的，以后每次都和普通 fork 一样。

**二、GitHub 不给按对象取文件。** 只取树（`--filter=blob:none`）很快，但 partial clone 之后
按需取文件时会报 `upload-pack: not our ref`——GitHub 不接受按 blob SHA 索取。所以脚本自己
把这次真正变了的那些文件从 `raw.githubusercontent.com` 取回来、`git hash-object -w`
写进对象库，再让 `git merge` 在本地算。没变的文件用的还是本地已有的对象，不用下载。

## 一次性准备

`.upstream/config.json` 记着上游地址、分支和**基线**（我们上次同步到的上游提交）：

```json
{
  "url": "https://github.com/cauliflowermossgrape/idrive7-apps",
  "branch": "main",
  "baseline": "6c28deea76383b22faa35903207fbef182e01749"
}
```

基线现在是上游的 `e35c3c1`（2026-11-20 上午），也就是提交
`a011790 同步上游 6c28dee..e35c3c1` 同步到的那一个。基线的含义只有一条：
**从这个上游提交到现在的上游改动，都还没进本仓库。** 基线选错的后果是重复合并
已经合过的东西，所以每次合并成功后脚本会自动把它推到新的上游提交。

核对基线对不对：拿它和本仓库的 `HEAD` 比（`apps/x` 要映射成 `apps/cn_x`），
差异应该都是汉化层——README、各 `app.json` 的描述与 `texts`、`build.py`
的默认语言、`kit/runtime/locales/zh-CN.*`、`mgu-repo.json`，而不是应用逻辑。

## 每次同步

```bash
# 1. 上游有没有更新，会动哪些文件（只取树，不下载文件内容）
python3 tools/upstream-sync/upstream.py status

# 2. 取回改动并合并
python3 tools/upstream-sync/upstream.py merge

# 3. 解冲突（见下表），然后：
git add -A && git commit

# 4. 哪些新英文串还没翻
python3 tools/upstream-sync/upstream.py gaps

# 5. 自测 + 推送
python3 kit/tools/build.py --preview-only cn_ambient_config
node kit/tools/test_turn_view.js
GIT_HTTP_LOW_SPEED_LIMIT=1000 GIT_HTTP_LOW_SPEED_TIME=15 \
  git -c http.version=HTTP/1.1 push origin master
```

`merge` 成功时会自动把 `.upstream/config.json` 的 `baseline` 推到新的上游提交；
如果停在冲突上，解完冲突、`git commit` 之后跑一次
`python3 tools/upstream-sync/upstream.py done` 手工记下基线。

## 冲突怎么解

先记住一条：**中文以我们为准，但上游新增的字段、设置项、版本号必须原样带过来。**
冲突几乎总出现在「我们也改过」的那些文件里。

| 文件 | 处理 |
|---|---|
| `README.md`、`README.zh-CN.md`、`README.en.md`、`docs/*.md` | 整份保留我们的（`git checkout --ours`），上游的英文改动不要 |
| `apps/*/app.json` | 逐块看：`description`、`texts` 用我们的中文；`version`、`settings`、`signals`、`config` 用上游的（版本号最后按发布节奏自己定） |
| `kit/tools/build.py` | 默认语言 `zh-CN` 保留（`--language` 的 default）；上游新加的 `--language zh-TW` 之类照收 |
| `kit/tools/sync_locales.py`、`zh-CN.tsv` | 保留我们的 LF 写法和中文翻译；上游对 `sync_locales.py` 的改动通常是加语言，要收 |
| `mgu-repo.json` | 工具的中文标题/简介保留；上游新增的工具条目要收 |
| `apps/<名字>/*`（我们的 `apps/cn_<名字>/*`） | git 的改名检测通常能跟上；新文件会提示「应该放到 apps/cn_xxx/」，`git mv` 过去即可。**注意 app 的 `id` 也是 `cn_` 开头的** |

`status` 里「上游新文件」如果不在 `apps/` 下（新的语言包、新的测试、新的 CI 文件），
直接收下就好，不会冲突。

合并之后顺手检查 `app.json` 里 `requires` 引用的工具版本、以及 `mgu-repo.json` 的
`tools[].title`，这两处最容易漏。

## 汉化层包括哪些文件

改动这些文件是「我们的」，上游动了同一处就要按上表保留中文：

- `kit/runtime/locales/zh-CN.tsv`（翻译源，`zh-CN.json` 由 `kit/tools/sync_locales.py` 生成，
  别直接改 JSON）；`kit/localization/credit.zh-CN.json`；`kit/localization/fonts/`
- `kit/tools/build_diagnostic_zh.py`、`docs/diagnostic-chinese.md`（中文故障库）
- `apps/*/app.json` 的 `description` 与 `texts.zh-CN`（商店和车机显示的中文名）
- `README.md`、`README.zh-CN.md`、`README.en.md`、`NOTICE.zh-CN.md`
- `apps/cn_*`：目录名、`app.json` 的 `id`、以及构建脚本里按 id 判断的地方

## `gaps` 报出来的英文串怎么翻

1. 打开 `kit/runtime/locales/zh-CN.tsv`，按 `英文<TAB>中文` 追加；
2. `python3 kit/tools/sync_locales.py zh-CN` 重新生成 JSON（会自动用 LF 写）；
3. 重新跑 `gaps`，直到为 0。

没有翻译的串不会崩，只是界面上显示英文。

## 上游新加的语言包

上游已经把繁体中文（`--language zh-TW`）合进去了。合并会带来
`kit/runtime/locales/zh-TW.*`、`kit/localization/credit.zh-TW.json`、`kit/tools/test_zh_TW.*`。
这些我们照收即可，不影响简体包；`build.py` 里 `package_version()` 对 `zh-CN` 和 `en`
不发版本后缀这一条要保持不变，否则 `mgu-repo.json` 里 `dist/{id}@{version}.tgz` 会对不上。

## 为什么不在 GitHub 网页上直接合并

网页上的合并、或者 `git pull upstream`，都要求两边有共同祖先。本仓库没有，
所以只能按上面的方式在本地做一次「嫁接 + 合并」。做完这一次，以后就正常了。
