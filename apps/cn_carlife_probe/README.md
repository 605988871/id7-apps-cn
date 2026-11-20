# CarLife Probe — 无需 SSH 的环境诊断

在车机 **MGU Store** 安装本应用，**只读**探测 CarLife 运行环境，结果直接显示在屏幕上，
截图发给开发者即可。不修改任何车机状态，不碰 CarLife 进程。

## 为什么需要这个

写抓流程序前必须知道这台车机的真实情况：CarLife 进程叫什么、uid 多少、视频走的哪个端口、
有没有 tcpdump / 解码库 / GPU 渲染节点。这些 BMW 百度 CarLife 集成的细节**没有任何公开资料**，
不同固件可能不同。猜着写代码注定跑不通。

以前需要 SSH 才能看这些信息；本应用把它搬到了车机屏幕上。

## 用法

1. MGU Store → 安装 **CarLife Probe**（本应用，纯 JS，无需 root，无需 SSH）。
2. 打开应用，此时已自动完成第一次扫描。
3. **在车机上启动 CarLife 连接**（中控屏按正常流程连上手机）。
4. 回到本应用，按 **Rescan** 重新扫描。
5. 用 **Next / Prev** 翻页，把每一页**截图**发回。

## 每一页看什么

| 区块 | 含义 |
|---|---|
| CARLIFE PORT HITS | 命中 7240/8240/9240/9340 的连接。**8240 的 uid 是关键**——抓流 tool 要用它做 nft 放行 |
| PROCESSES | 名字含 carlife/baidu/apollo/welink 的进程、pid、uid |
| TCP (uid rows) | 所有 LISTEN 与非回环 ESTABLISHED 连接，uid。若 CarLife 用非标准端口，在这里找 |
| INTERFACES | 网卡名，带 `p2p` 标记的是无线投屏走的接口，抓包要指定它 |
| TOOLS / DECODER | tcpdump / nft / ffmpeg 是否存在，`/dev/dri/renderD128`、libmfx/libva 是否在 |

黄色 `<==` 行是命中项；红色是 UNREADABLE / absent（读不到也如实显示，这本身是诊断信息）。

## 技术说明

- 全部数据来自 `/proc/net/tcp{,6}`、`/proc/<pid>/{cmdline,status}`、`/proc/net/dev` 和
  `fs.existsSync()` 文件检查。标准 Linux 下这些多为 0444 全局可读；若 MGU 挂了 `hidepid`，
  读不到会显示 `UNREADABLE`——同样是有效结论（说明必须走 root tool）。
- OAP app 是非 root uid，没有 CAP_NET_RAW，**不能自己抓包**。本应用只做只读探测；
  真正的抓流由后续 `kind:"tool"` 的 root 组件完成，结论经 `/dev/shm` 共享给应用显示。
- 界面全英文：动态技术文本不在车机中文字体内，用英文避免显示成问号。

## 后续

拿到截图后，据此确定：真实视频端口、CarLife 进程 uid、抓包网卡、可用的解码后端。
然后实现方案 B：nft `nat output` REDIRECT 透明代理复制 H.264 流 → MSDK 解码成 NV12 →
CLMF 帧送 `cn_carlife_map` 投到仪表盘/HUD。做成 tool 组件，用户仍只需在商店安装。
