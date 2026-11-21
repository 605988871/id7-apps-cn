# CarLife Probe — 无需 SSH 的环境诊断

在车机 **MGU Store** 安装本应用，**只读**探测 CarLife 运行环境，结果直接显示在屏幕上，
截图即可。不修改车机状态，不碰 CarLife 进程。

## 为什么需要这个

写抓流程序前必须知道这台车机的真实情况：视频走 TCP 还是 USB、由哪个进程持有、
解码库叫什么、Cinemo 栈怎么配置。这些细节没有任何公开资料，不同固件也不同，
猜着写注定跑不通。

## 现在多了 root 那一半

应用跑在 `tm_oap_app`，在挂了 hidepid 的车机上**读不到别的 uid 的
`/proc/<pid>/fd` 和 `/proc/<pid>/maps`**——前两轮这两项都是 `UNREADABLE`。
所以本应用现在依赖 tool 组件 **CarLife probe (root)**（`kit/carlife-probe/tool`）：

- 它由 root 跑，把应用读不到的东西写进 `/dev/shm/carlife-probe-root.txt`
- 应用读到该文件时**优先显示它**，标题行会写 `[root report]`
- 没装 tool 时应用照常工作，只是显示自己的端口/USB 扫描，并提示去装

## 用法

1. MGU Store → 安装 **CarLife Probe**（会自动带上 root tool，无需 SSH）。
2. **先在车机上连上 CarLife**（中控屏正常流程），保持连接。
3. 打开应用。安装时 tool 已写过一份快照；**若显示的是旧快照，重启车机一次**，
   root tool 的服务会每 15 秒跟着会话刷新报告。
4. 按 **Rescan** 重新读报告，用 **Next / Prev** 翻页，每页**截图**。

顺序很重要：连着 CarLife 时才有会话可看。

## 前两轮实测结论（MGU / iDrive 7）

| 项目 | 结果 |
|---|---|
| 进程族 | `carlife`(13005)、`carplay`(13002)、`aapd`(13006)、`mdnsd`(13003)、`sdlpd`(13010)、`sdlp-cegateway`(13011)、`sdlp-ar`(13012)、`sdlp-touchcommand`(13013)、`sdlp-conman`(13014) |
| 7240 / 8240 / 9240 / 9340 | **全部无命中**，CarLife 自己的命名空间里也没有 ESTAB |
| USB | `vivo iQOO 12 Pro`，18d1:2d01，接口 `ff/42/01` = **AOA 配件**，`drv=usbfs`（用户态驱动） |
| usbmon | debugfs 已挂载，但 `/sys/kernel/debug/usb/usbmon` 无、`/dev/usbmon*` 无、模块未载、**`usbmon.ko` 不存在** |
| 运行时 | node v8.16.2、socat、nc、busybox、modprobe/insmod、iptables 在；python3、ss、tcpdump、ffmpeg 无 |
| GPU/解码 | `/dev/dri/renderD128`、`libmfxhw64.so` 在；`libva` 无 |

结论：**画面走 USB AOA 裸传输，不走 TCP**；`usbmon.ko` 缺失意味着**无法被动嗅探**，
抓流必须进到进程内部（hook）或找到 stack 自己写出的管道/文件。

## 每页看什么（root 报告）

| 区块 | 含义 |
|---|---|
| `--- FDS ---` | 每个 CarLife 进程的 fd 统计。**`usb=` 大于 0 即证明走 USB**，随后列出 `fdN -> /dev/bus/usb/001/00X` |
| `--- LIBS ---` | carlife 加载的解码/投屏库（`libNme*`、`libcarlife*`、`libmfx`…）。名字决定 hook 点 |
| `--- CINEMO CONFIG ---` | `/etc/cinemo` 清单 + `cinemo_options.xml` 里 display / sink / kombi / codec 相关行。**第二路输出若可配，就在这里** |
| `--- UNIX SOCKETS ---` | 本机 socket 总数与名字命中项；若 stack 自己把帧写进 socket，那是成本最低的抓法 |
| `--- TOOLCHAIN ---` | gcc/cc/clang/make/as/ld、python2/3、perl、strace/gdb/objdump/readelf、nft/iptables/socat。**决定能否在车机上现编 hook** |
| `--- USBMON ---` | `/lib/modules` 列表、`find usbmon*`、debugfs usb 目录、`/dev/usbmon*` 计数 |
| `--- DEV / BINARIES ---` | `/dev/fb0`、`/dev/dri/*` 权限，各二进制大小等 |

红色是 UNREADABLE / absent，读不到也是结论。

## 技术说明

- 应用侧全部来自 `/proc`、`/sys`；root 侧额外读 `/proc/<pid>/{fd,maps}` 与 `/etc/cinemo`。
- 两侧都**只读**：root 脚本不加载模块、不改防火墙、不发信号、不开设备。
- OAP app 非 root、无 CAP_NET_RAW，**不能自己抓包**，抓流只能由 root tool 承担。
- 界面全英文：动态技术文本不在车机中文字体内，避免显示成问号。

## 后续

按报告判读决定抓流方案（hook 进程 / 复用它写出的管道 / 配置第二路 sink）。
