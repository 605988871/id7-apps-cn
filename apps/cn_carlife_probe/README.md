# CarLife Probe — 无需 SSH 的环境诊断

在车机 **MGU Store** 安装本应用，**只读**探测 CarLife 运行环境，结果直接显示在屏幕上，
截图发给开发者即可。不修改任何车机状态，不碰 CarLife 进程。

## 为什么需要这个

写抓流程序前必须知道这台车机的真实情况：CarLife 进程叫什么、uid 多少、视频走 TCP 还是 USB、
有没有可用的抓包/解码后端。这些 BMW 百度 CarLife 集成的细节**没有任何公开资料**，
不同固件可能不同。猜着写代码注定跑不通。

以前需要 SSH 才能看这些信息；本应用把它搬到了车机屏幕上。

## 用法

1. MGU Store → 安装 **CarLife Probe**（本应用，纯 JS，无需 root，无需 SSH）。
2. 打开应用，此时已自动完成第一次扫描。
3. **在车机上启动 CarLife 连接**（中控屏按正常流程连上手机），保持连接不要退出。
4. 回到本应用，按 **Rescan** 重新扫描。
5. 用 **Next / Prev** 翻页，把每一页**截图**发回。

顺序很重要：连接状态下扫描才能看到会话。

## 第一轮实测结论（MGU / iDrive 7）

| 项目 | 结果 |
|---|---|
| CarLife 主进程 | `pid 2823 uid 13005  /usr/bin/carlife` |
| CarLife 服务族 | uid **13000–13099**（13002、13005、13006、13012 各自监听端口） |
| 7240 / 8240 / 9240 / 9340 | **全部无命中，也没有任何 ESTAB 外连** |
| 网卡 | vlan144、vlan77、socnet0、p2p-wlan0-0、p2p-wlan0-1、vlan65/67/73/80/86、wlan0、wlan_bridge；**无 usb0 / eth0** |
| 工具 | `tcpdump` 无、`ffmpeg` 无、`nft` 在（/usr/sbin/nft） |
| 解码/GPU | `/dev/dri/renderD128` 在、`libmfxhw64.so` 在、`libva` 无 |

也就是说：**CarLife 的视频在这台车机上很可能不走 TCP**（否则连接时至少能看到 8240 的 socket）。
USB 载体的可能性最大，所以 v1.1 增加了下面这些检查。

## 每一页看什么

| 区块 | 含义 |
|---|---|
| CARLIFE PROCESSES | 名字匹配或 uid 落在 13000–13099 的进程，含 `ns`（网络命名空间） |
| CARLIFE FDS | 进程打开的文件描述符统计。**`usb=N` 大于 0 就证明走 USB**；`gpu=` 是渲染节点，`socket=` 是套接字数量 |
| CARLIFE NETNS TCP | 从 **CarLife 自己的网络命名空间** 读 socket（应用读 `/proc/net/tcp` 只看到自己的命名空间，这是第一轮漏掉会话的原因） |
| USB DEVICES | `/sys/bus/usb/devices` 全树。接口 `ff/42/01` 标 `<== AOA/ACCESSORY`，那是 CarPlay/Android Auto/CarLife 类配件的特征 |
| USBMON / DEBUGFS | `debugfs` 是否挂载、`/sys/kernel/debug/usb/usbmon` 是否可读、`usbmon` 模块是否加载、`usbmon.ko` 是否在。都在 → 可以零驱动被动抓 USB 裸流量 |
| RUNTIME | node 版本、python3 / ss / socat / nc / busybox / modprobe / insmod / iptables 是否存在（决定抓流程序用什么写、怎么起） |
| CARLIFE LIBS | CarLife 进程加载的、与视频相关的 .so（carlife/baidu/av/codec/h264/mfx/va/usb 等） |

黄色 `<==` / `HIT` 是命中项；红色是 UNREADABLE / absent（读不到也如实显示，这本身是诊断信息）。

## 怎么判读

- **FDS 里有 `/dev/bus/usb/*/*`** → 视频走 USB bulk 传输，抓流用 `usbmon`（若模块可用）或
  nft 之外的 USB 层方案，H.264 在裸流量里。
- **NETNS TCP 里出现 8240 的 ESTAB** → 走 TCP，可以用 nft REDIRECT + 本地代理复制流。
- **USBMON 全 absent** → 需要换思路：patch 车机端 CarLife 的解码入口，或复用它的解码输出。
- **LIBS 里有 `libcarlife*.so` / `libbd*.so`** → 解码在闭源库里，hook 点要看导出符号。

## 技术说明

- 全部数据来自 `/proc`、`/sys` 和 `fs.existsSync()` 检查。标准 Linux 下这些多为 0444 全局可读；
  若 MGU 挂了 `hidepid`，读不到会显示 `UNREADABLE`——同样是有效结论（说明必须走 root tool）。
- OAP app 是非 root uid，没有 CAP_NET_RAW，**不能自己抓包**。本应用只做只读探测；
  真正的抓流由后续 `kind:"tool"` 的 root 组件完成，结论经 `/dev/shm` 共享给应用显示。
- 界面全英文：动态技术文本不在车机中文字体内，用英文避免显示成问号。

## 后续

截图确认载体后，再做抓流 tool：取流 → 解码成 NV12 atlas（1088×480）→ 送
`cn_carlife_map` 投到仪表盘/HUD。做成 tool 组件，用户仍只需在商店安装。
