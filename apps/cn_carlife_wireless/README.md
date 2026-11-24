# CarLife 无线投屏（cn_carlife_wireless）

把手机百度 CarLife 的**完整画面**通过 WiFi 热点投到 iDrive 7/8 中控屏，**画面上可以直接触摸/拖拽**（0.8.0 起，手势经 `carlife-link` 的控制通道回传给手机）。

## 和旧方案的区别

旧方案走 USB AOA：伪装成 USB 设备把数据喂给原车 `carlife` 进程。这台车上会导致车机重启，已放弃并回滚。

本方案**完全不碰原车 CarLife、不碰 USB**：
- 手机开热点，运行百度 CarLife（不是 vivo 智能车载，不需要蓝牙配对）
- **热点在 MGU 商店的 Wi-Fi 页连接**：本应用没有 Wi-Fi 界面，也不该有（见下）
- 一个独立的原生链路连到手机的 6 个 TCP 端口，握手、取 H.264 流、解码、显示
- 原车 `carlife` 进程始终没有被触碰

## 热点由 MGU 商店连接（本应用不做 Wi-Fi 界面）

iDrive 7 的 BCM4359 只有 `wlan0` 一个 station 接口，车的 `wpa_supplicant` 用它挂热点、
跑无线 CarPlay。MGU 商店的「设置 → Wi-Fi」背后的 `mgu-uplink` 已经把这件最难的事做完了：
通过 D-Bus 在同一个接口上 `AddNetwork`（`id_str=mgu-uplink`）加入手机热点，不打断原车
连接，并把租约写进 `/run/mgu-uplink/lease.json`。**两个地方都能连热点只会互相抢
`wlan0`**，所以 0.7.9 起本应用把 Wi-Fi 界面整块删了：连热点只走商店。

本应用只从 uplink 拿两样东西，都不需要改它：

- `lease.json` 的 `router`（= 手机 IP）与 `status.json` 的 `wifi` 状态——`run.sh` 用前者
  找手机，状态页用后者告诉用户"热点还没连"还是"连了但没租约"；
- 防火墙白名单：`mgu-uplink` 只让白名单 uid 从 WiFi 发包，root 永远不在里面。所以
  `carlife-link` 用 `--drop-uid 65534` 在二进制内降到该 uid，`component.json` 用
  `internet:true` + `uids:[65534]` 让 Store 把该 uid 写进白名单。解码器不联网，保持
  root 以用车的 MSDK/GPU。

`wifi-bridge`（root 代理，转发 enable/scan/connect 给 uplink）与 `carlife-wifi.service`
仍在组件里，但本应用已经不再调用它们；保留是因为它们不占资源、以后要做独立 Wi-Fi 页
时不用重写。

## 可行性：已在 PC 上用真机验证（2026-11-23）

| 环节 | 结果 |
|---|---|
| 手机热点上 6 个 CarLife 端口 | 7240/8240/9240/9241/9242/9340 **全开** |
| 版本握手 | cmd 7240 返回 `MATCH_STATUS status=1`（手机接受车机身份） |
| H.264 取流 | 20 秒收到 287 帧 / 2.2 MB，SPS/PPS/IDR 齐全 |
| 画面 | 解码后确认是完整 CarLife 界面（地图 + 音乐卡 + 语音卡），颜色正确 |
| 显示链路 | 0.8.0 起画面不再经 JS：`carlife-decode` 把 I420 写进 MGVF 视频文件，渲染器读文件自己画（桌面用 `kit/tools/test_video.js` 钉住协议） |

## 组成

| 组件 | 作用 |
|---|---|
| `kit/carlife-wireless/carlife-link` | 连手机 6 端口、握手、收 H.264，裸流写到 stdout，并把触摸回传给手机 |
| `kit/carlife-wireless/carlife-decode` | 从 stdin 读流，用车的 Intel MSDK 硬解，把整幅画面按手机原始尺寸写进渲染器的视频文件 `/dev/shm/mgu-video-carlife`（MGVF + I420） |
| `kit/carlife-wireless/run.sh` | 把上面两个用管道串起来，任一退出则整组重启 |
| `kit/carlife-wireless/carlife-wireless.service` | systemd 常驻，未连手机时循环重试 |
| `kit/carlife-wireless/wifi-bridge` | root 代理：Wi-Fi 请求 → mgu-uplink 的 root-only socket（本应用已不再调用） |
| `apps/cn_carlife_wireless/` | JS app：向渲染器声明视频文件、claim 画面区域、把触摸归一化后回传 |

## 安装

1. 重新编译三个原生组件（在本机，需要 zig；产物必须是 glibc ≤ 2.27、解释器 `/lib/ld-linux-x86-64.so.2`）：

   ```bash
   cd D:/id7-apps-cn/kit/carlife-wireless
   ZIG=/d/zig/zig-x86_64-windows-0.14.1/zig.exe ./build.sh
   ```

2. 把 `mgu-repo.json` 作为源加到车机 MGU Store，安装「CarLife 无线投屏」应用。应用会带 `carlife-wireless` 组件一起装（install.sh 验证三个二进制能执行、创建 `/dev/shm/carlife-wireless`、启动两个 service）。

3. 完整 OAP 安装包需要本机的 BMW oap-sdk（`--preview-only` 只能做离线预览，不能上车安装）。
4. 确认车机已装 `mgu-uplink`（MGU Store 里能看到 Wi-Fi 设置页）。本组件安装时
   Store 会依据 `component.json` 自动把 uid 65534 写入 uplink 白名单。

## 使用

1. 手机开热点，打开**百度 CarLife**，停在等待连接界面、保持屏幕点亮
2. 在 **MGU 商店 → 设置 → Wi-Fi** 里连上手机热点（第一次要输密码，之后自动连）
3. 打开「CarLife 无线投屏」：service 从 `lease.json` 读到手机 IP 自动取流，画面直接铺满
4. 若是先开应用、后连热点也没有关系：link 每秒看一次车机自己的接口地址，网段一变就
   立刻在新网段重找手机

> 回退：若车机没装 `mgu-uplink`，可把手机 IP 写到 `/dev/shm/carlife-wireless/host`
> （本应用不再提供设置项），前提是车机已用别的办法连上该热点。

## 上车验证清单（按成本从低到高）

**第一步：mgu-uplink 是否存在、Wi-Fi 是否连上（决定整个方案是否成立）**
```sh
cat /run/mgu-uplink/status.json     # wifi.link: connected=仅关联, online=已拿到 DHCP 租约
cat /run/mgu-uplink/lease.json      # router = 手机 IP（只有 online 时才生成）
cat /proc/net/route                 # wlan0 的默认网关，lease 缺失时的备用手机地址
cat /var/opt/mgu-uplink/uids.d/carlife-wireless   # 应为 65534（Store 安装的白名单）
```
- 0.7.4 起 `find-phone.sh` 依次尝试：设置里手填地址 → `lease.json` 的 router（**且该网关
  仍在 `/proc/net/arp` 里，即它确实还是邻居**）→ `/proc/net/route` 默认网关 →
  `status.json` 的 `wifi.ip` 推算网关（同样要 ARP 确认）→ `auto` 局域网发现。
  租约会"过期"：mgu-uplink 在 DHCP 时写 `lease.json`，Wi-Fi 掉了并不删，所以换过热点的车
  可能拿**上一个路由器**的地址去拨号（实测：车已在 10.92.100.115，却一直拨 192.168.88.1）。
  校验不过就落到局域网发现；0.7.6 起 `carlife-link` **每秒看一眼车机自己的接口地址**，
  DHCP 一换网段就立刻丢掉旧连接、在新网段重扫（`link.txt` 的 `net:` 记车机当前地址，
  `scan:` 记扫过哪些 /24）。所以换热点后 1～3 秒就能用新地址，不必等拨号超时累积。
- 在车机 UI 上：**MGU 商店 → Wi-Fi** 连热点；本应用的状态页只显示它读到的东西
- `status.json` 的 `wifi.link` 若为 `unavailable`，看 `error`——通常是车的 Wi-Fi 被关掉或车自身占用 `wlan0`
- 本项目不需要车机"能否做 STA"的额外前提：`mgu-uplink` 已经通过车的 `wlan0` 解决

**第二步：组件是否装好**
```sh
cat /dev/shm/carlife-wireless-boot.txt    # install.sh 的自检结果（含 bridge exec 行）
systemctl status carlife-wireless.service
systemctl status carlife-wifi.service     # root Wi-Fi 代理，必须 active
ls -l /dev/shm/carlife-wireless/wifi.sock # 应为 root:tm_oap_app，0660
```
- 「连热点」页若提示"Wi-Fi 服务未启动"，先查 `carlife-wifi.service` 和这个 socket 的权限
- 代理只转发 Wi-Fi 五个操作；`status.json` 是 uplink 直接写的，与代理无关

**第三步：链路是否连上**
```sh
cat /dev/shm/carlife-wireless/run.txt            # 启动/重启原因、手机地址来源、哪一半退出
cat /dev/shm/carlife-wireless/link.txt          # 看 state / match / frames
cat /dev/shm/carlife-wireless-decode.txt        # 看 frames / in bytes / error
```

- `link.txt`: `state: streaming`、`match: yes`、`frames` 增长 → 取流成功
- `decode.txt`: `frames` 增长、`errors: 0` → 解码成功
- `state: phone not reachable` 且 `error: <ip>:7240 failed (115)`：0.7.3 及更早的 link 把
  Linux 非阻塞 `connect()` 的 `EINPROGRESS`（115，"还在握手"）当成失败，**连接刚开始就被判错**，
  从没等过那 500 ms。本地测试服务器会立刻 accept 所以测不出来，Windows 上是 `WSAEWOULDBLOCK`
  也测不出来；只有真手机在 Wi-Fi 上才暴露。0.7.4 起 115 被正确当作"等 select"，同一地址要么
  连上，要么显示 `timed out`（真超时）或 `refused`（端口没人听）。
- 应用主页面会把以上状态直接画出来，不用 SSH 也能定位卡在哪一步：
  「热点：已关联…（尚未获取 IP 租约）」= mgu-uplink 只关联成功；
  「取流服务：反复重启 · carlife-decode exited (rc N)」= 先退出的是解码器；
  `rc 2` 且下面一行写「取流链路已断开」时，是上游的 link 先没了，看「取流链路」那行；
  「取流服务：未检测到，请重装…」= 组件没装或服务没起来。

**第四步：画面出来的第一眼要看的两件事（0.7.5）**

画面能出来只说明链路通了，还要看它是不是**整幅**、是不是**在动**。这两点各有一个独立的坑，
0.7.4 及更早都会踩：

- **只有一部分画面 / 下面一大条黑**：app 的画布是 1600×720，而 kit 的 full 布局默认只显示画布
  的 `(12, 38, 1576, 482)` 那一块（它是为 1600×520 的普通页面设计的）。画布第 520 行以下
  **从来没有被画到屏幕上**，1280×720 的画面只露出了上面 2/3。0.7.5 起 app 在 `app.json` 的
  screen 里用 `"src": {"x":0,"y":0,"w":1600,"h":720}` 声明"我的整块画布都是画面"，布局按 1:1
  显示整幅（屏幕 1920×720 上 `scale 1, oy 0`，`display: renderer placement` 日志可核对）。
- **停在第一帧不动、点了也没反应**：`ui.image` 送去的像素图（`setImage`）在录制里**只是一条绘制
  指令**，id、位置、尺寸每帧都一样，变的只有像素。kit 的"相同帧不重发"去重比的是指令字，
  于是把视频当成静止画面，**每秒才发一帧**——画面冻在第一帧，手机其实一直在解码。0.7.5 把每个
  像素图的版本号纳入比较，视频每帧都发，静止页面仍然照旧去重。

16:9 的画面在 1920×720（8:3）的屏幕上，等比满高时只能占约 67% 宽，两边留黑是**比例决定的**，
不是 bug。要真正满屏得让手机按车机的横向比例编码（`carlife-link --width/--height`，当前默认
1280×720），那需要手机端接受非标准分辨率，留作下一步。

**0.8.0：画面走渲染器的视频通道，于是也就能触摸了**

0.7.9 之后车上还剩五个问题：连接慢（半分钟）、画面卡（手机移动后好几秒才变）、点不动、
画面糊、点画面底部会点到被画面盖住的 HMI 按钮。这五个其实是**同一件事**的五个面：画面是
由 app 自己"搬"上屏的。

- 0.7.9 的通路：解码器 → CLMF 帧 → `unix socket` → app（JS 里 YUV→RGBA，1280×480 约 30 ms）
  → 每帧 2.4 MB 的像素图消息 → 渲染器。**每个进程之间都有一个缓冲区**，而手机一直以 30 fps
  生产：只要某一段稍微慢一点，帧就在队列里堆积，画面"平均能看"却永远晚几秒。同时这条通路
  用的是 upstream 方言，而那个方言下像素图与触摸 claim 互斥（`CLAIM` 和 `IMAGE` 共用 9 号
  消息），所以点不动。

- 0.8.0 换成 mgu-render 的**视频通道**（`mgu-render/1` 的 `VIDEO` 消息 + 绘制 op 19）：
  解码器把整幅画面写进 `/dev/shm/mgu-video-carlife`（64 字节头 + 3 个 I420 槽位，写者和
  读者永远隔两帧），渲染器**自己每 5 ms 看一次文件头**、有新帧就重画。队列消失了，
  任何一帧被读到都必然是**最新的那一帧**，所以"晚几秒"这个问题从结构上不存在了；app 只发
  一条 `VIDEO` 消息和每秒一帧的保活，卡顿、CPU、带宽一起消失。

- **糊**是因为中间被缩了两次：0.7.9 的解码器把 1920×720 用**最近邻**缩到 1280×480，渲染器
  再放大 1.434 倍到屏幕。现在解码器**不缩放**（VPP 只做拷贝），画面按 1920×720 原样交给
  GPU，由它一次性双线性缩到 1835×688（0.956 倍），只降不升。

- **点不动 / 点到底部系统按钮**：视频通路不再发像素图，连接就是 `mgu-render/1`，于是
  `CLAIM`（9 号消息）可用了。app 把画面覆盖的整块区域（84..1920 × 0..720，逻辑坐标）claim
  给自己：落在这块里的手势由渲染器**转给本应用**（`TOUCH`），再由 `carlife-link` 的 7399
  控制口发给手机；落在返回箭头列的手势仍归 HMI。被画面盖住的那条 HMI 按钮栏**再也收不到
  触摸**——这正是"点画面底部打开车机设置"的原因。

- **连接慢半分钟**：解码器的 MSDK 会话（`MFXInit` + VA display + DRI 节点）原来是在**第一帧
  到达时**才建立的，那几十秒就挂在"正在接收画面"上。现在 `carlife-decode` 启动时就把会话
  建好（车机等手机的时间本来也是空等），`decode.txt` 也多两行计时可以核对：
  `first: session <ms>, byte->frame <ms>`（会话建立耗时、从收到第一个字节到出第一帧的耗时）。

- **顺手清掉约 1500 行死代码**：删掉旧像素通路的全部（`carlife_source.js`、`atlas.js`、
  `hud_convert.js`、`wait_policy.js`）和两个这份代码里已经没人 require 的模块
  （`cluster_render_client.js`、`speller.js`）。build.py 把 app 目录下每个 `.js` 都拷进安装包，
  所以它们一直在车上；现在包里只剩 `app.js` 和 `kit/`，`test/` 目录也不再打包（`buildOnly`）。

- **命名视频文件的两道闸**：`_ensureVideo` 要求渲染器**既**说 `mgu-render/1` **又**在 caps
  里报 16——`X_READY` 版本 3 是 native 但还没有视频，在那种连接上命名一条 `VIDEO` 只会收到
  ERROR（检查 caps 之前漏了这一条）。另外它**等解码器真的写出文件之后**才发第一条：
  提前发一次 ERROR，这条连接就再也拿不到画面。两种情况都只发一次，不按帧发。

- 车机渲染器必须支持视频通道：`app.json` 的 `requires.idrive7-renderd` 已是 MGU 商店的
  GPU 渲染器（mgu-render）。若某台车上是别的渲染器，状态页会写「渲染器不支持视频通道」，
  而不是留一张黑屏。
- `run.sh` **不再删除** `link.txt`：0.5.0 每当 pipeline 有一半退出就删一次报告，
  车上只会看到"取流：尚未启动"，真实原因被抹掉。

**换热点后多久能取到新地址（0.7.6）**

服务不会因为换热点而重启：`run.sh` 只在启动时定一次地址，之后的地址由 `carlife-link`
自己维护。0.7.4 及更早是靠**拨号失败累积**才发现地址错了（20 轮 × 3 秒 ≈ 一分钟），
这段时间屏幕上的「取流错误」一直写着旧热点的 IP，看起来像"IP 根本没切换"，其实是还在
一遍遍拨旧地址。

0.7.6 把**车机自己的接口地址**当成第一信号：手机热点关联后 DHCP 一两秒内就会给 wlan0
换网段，link 每秒读一次本机地址表，一变就丢掉旧网络上的连接、立刻在新网段扫描并重连
（屏幕上显示「正在查找手机」和「地址：…（按当前网络重新查找）」）。同时，一个不属于
本机任何 /24 的提示地址只等两轮拨号就被扫网替换——这正好覆盖"在设置里手填过旧热点 IP"
的情况。`link.txt` 多了一行 `net:`，记录车机当前地址，用来确认换网真的生效。

**0.8.4：追赶逻辑的死循环，队列一直停在 87%**

0.8.2 把队列从 6 MB 压到 1 MB，车上仍是"不跟手"，画面上的数字是
`DEC 24/60fps BUF 87% SKIP 209`。这里有两个错误叠在一起：

1. **`@60` 是手机上报的编码器配置，不是实际推帧率。** 实际收到的帧率现在是
   `link.txt` 里 `push=Nfps`（按收到的帧数每秒统计）。车上那张图里 `SKIP` 才
   209，说明手机实际推的也就 24 帧上下——队列满不是"手机太快"，是下面这个 bug。
2. **0.8.2 的追赶只丢新帧、不清旧帧。** `sink_run` 是从队头按 FIFO 写的：进入
   "等 IDR"后新帧全丢，但已经排在队列里的旧帧一帧没少，写线程继续慢慢写它们；
   等 IDR 真的来了，队列还是满的，`sink_put` 又把它拒掉。于是队列永远停在 87%，
   解码的永远是几秒前的帧，`skipped` 却一直在涨——看起来一切正常，就是不动。

现在**一发现落后就立刻把队头的积压 trim 到 1/4**（`sink_trim`，和 800 ms 等不到
IDR 时的兜底是同一条路）；等 IDR 的帧来了，写入前再 trim 一次腾出位置。这样等
关键帧是真的能恢复，而不是永远在满队列上撞墙。

诊断行现在读 `push=Nfps`（真实推帧率）而不是 `@60`。**打开设置里的「显示状态」，
这行会一直显示**，正常时：`DEC 24/24fps BUF 5% SKIP 0`。若 `BUF` 又长期高、
`SKIP` 一直涨，就是解码器（24fps）确实跟不上手机推的帧率，要看 `decode.txt` 的
`rate` 与 `copy=`；两者都低仍不跟手，才轮到手机侧。

**0.8.3：手机断开后回到状态页，不再停在最后一帧**

0.8.2 之前，手机离开热点或关闭 CarLife 后，解码器不再写新帧，但视频文件还在、
`seq` 停在最后一帧上——渲染器据此一直画那张旧画面，看起来像卡死。应用只看文件头，
没有"链路断了"这回事。

现在应用的循环每秒读一次原生侧的报告：
- `link.txt`：`state` 变成 `reconnecting` / `connecting` / `phone closed …` /
  `phone not reachable` / `looking for the phone`，或 `error` 非 none；
- `run.txt`：`state: restarting`——取流或解码任一进程退出、服务正在重启；
  这条优先，因为进程崩掉时 `link.txt` 可能还残留崩前一刻的 `streaming`；
- `decode.txt`：`state` 含 `stream ended`。

判定为断开后等 **3 秒**宽限期（握手抖动、短暂重连不该闪一下黑屏），
然后回到状态页，把断开原因（"手机没有回画面，正在重新连接"、"取流服务：反复重启"等）
直接写在页面上。手机回来、新的帧落盘后自动回到画面，无需操作。

**0.8.2：六七秒的延迟在 link 的 6 MB 输入队列**

0.8.1 上车后颜色对了，但滑动/点击仍旧要六到七秒才有反应。这一处不在解码器、
也不在渲染器——`carlife-link` 给解码器准备了一个 **6 MB** 的有界输入队列
（`SINK_BACKLOG = 6u << 20`），写队列的线程和读触摸的是同一份数据、不同线程，
所以主线程不会被卡住，**画面看着正常，但每一帧都要在队列里排六到七秒**。
1920x720 的屏幕编码大约 1 MB/s，6 MB 正好是这么长；解码器只要比手机慢一点点，
队列就会满着不降，延迟也就固定在那儿。

- 上限从 6 MB 降到 **1 MB**（不到一秒）。
- 超限时不随机丢半帧：`on_video()` 先记下"正在追赶"，丢弃后续画面直到一帧带
  **IDR**（可独立解码的关键帧）才恢复，画面会跳一下但不会花。800 ms 等不到
  关键帧就丢掉最旧的积压继续写，宁可花一下也不能一直停在几秒前。
- `link.txt` 的 `video:` 行新增 `skipped=N`（为追赶丢掉的帧）与 `backlog=N%`；
  `decode.txt` 的 `queue:` 仍是 FIONREAD 测得的、解码器前面还剩多少字节。
- 只有确实跟不上时，画面左上角才出现一行黄色小字
  `DEC 解码fps/手机fps BUF 队列% SKIP 丢帧数`，正常时画面保持干净。

**注意**：1 MB 不是让帧率变高，是不让旧的帧排队。若解码器确实只有 20 fps，
新的表现是画面跳到最新、仍不跟手；这时要看 `link.txt` 的 `video:` 行——
`backlog` 长期高且 `skipped` 一直涨，说明瓶颈在解码器（再看 `decode.txt` 的
`rate`/`copy=`）；两者都低却仍慢，才轮到手机侧。

**0.8.1：颜色（I420 布局）与"十几秒"（把帧率要低了）**

0.8.0 在车上露了两件事，各自都有明确的原因，0.8.1 修掉：

- **画面发灰、颜色不对（看着像黑白）**：`carlife-decode` 写视频槽位时复用了
  `blit()`，而 `blit()` 写的是**图集布局**——每行前半是 U、后半是 V，那是旧 CLMF
  图集（`carlife_source` / 仪表盘 `cluster-render`）约定；渲染器读槽位用的是
  **标准 I420**：先整个 Y 平面，再整块 U，再整块 V（`proto.h` 的
  `struct mgu_video_head`）。两种布局一错位，色度就成了逐像素的噪声，一张地图
  看起来就是灰白。现在 `vid_copy_i420()` 按渲染器的布局单独写，不再复用 `blit`。

- **拖动后十几秒才有反应**：0.8.0 给 link 加了 `--fps 30`。link 源码里早有实测
  记录："手机照请求的帧率编码，要 30 时整条会话被压在 12 fps，要 60 时 28–38 fps"。
  帧率一低，手机侧发送队列就堆起来——画面和**触摸**一起晚，晚的是整条会话，
  不是某一段。现在**不再传 `--fps`**（回到 link 自己的 60）。真要观察降载，
  用环境变量 `CARLIFE_FPS=20`（run.sh 里转成 `--fps 20`），不要写死在脚本里。

- `decode.txt` 多了两行，专门用来判断"慢的是谁"：
  `queue: N KB in front of this program`——非 0 就是解码器跟不上（链路在等它，
  手机在那头堵着）；`video: … copy=平均/最大ms`——一帧拷进视频文件花多久。
  两个数都小、画面却仍旧陈旧的，才轮到渲染器。

**0.7.9：删掉应用内的 Wi-Fi 界面，并把画面铺满**

用户的决定：热点统一在 MGU 商店里连。于是 `WIFI` 菜单、底栏的「连接热点」、
`wifi_page.js`、自动重连、`host` / `wifi_ssid` / `wifi_psk` 三个设置项全部删除；
没有画面时画布上只剩一张状态页，第一行就写「请在 MGU 商店里连接手机热点」。

同一版修掉"等半天出第一帧、然后定格、而且没铺满"：

- **画布从 1600×720 改成手机画面的原始比例 1280×480**。1600×720 是一层"包装"，
  每帧都要把整块 4.6 MB 画布重新上传；现在画布就是那一帧（2.4 MB），渲染器再按
  1836/1280 = 1.434 倍放大到屏幕的应用区（84..1920 × 0..720），所以画面**铺满**，
  只留 HMI 的返回箭头列（84 px）和上下各 16 px。
- **解码器输出改成 1280×480**（`crop.json` 的 `mapW/mapH`，与 1920×720 等比 1.5 倍）。
  之前是 1920×720 → stretch 到 1280×720，把手机的 8:3 界面横向压扁了 1.5 倍，所以
  圆形图标看起来是竖长的椭圆。
- **只在新帧到达时重绘**。原来循环跟着渲染器的 tick 跑，60 次/秒把**同一张**画布传过去
  （像素图的 `ver` 每次都变，去重永远命中不了），app 的事件循环全花在拷贝上，取流
  socket 饿死——`decode.txt` 里 `drops=1598+0`（1599 帧只读出 1 帧）就是它。现在
  静止画面每秒只发一次，视频按到达的帧数发。
- **kit 侧加了背压**（`display.js` 的 `_send`）：渲染器还没 TICK 回上一帧就不再发新的，
  一帧在途。慢渲染器只会让帧率下降，不会再堆出几百 MB 的 socket 队列。

**Wi-Fi 界面为什么曾经是车机原生菜单（0.7.7，历史）**

0.7.6 及更早把"连接热点"画成画布中央一个蓝色大按钮，配上自绘的热点列表。**那个按钮在
车上永远点不动**：画面用 renderd 的像素图（op 18）送屏，而像素图只在 upstream 方言里有，
该方言下渲染器拒绝触摸 claim（`CLAIM` 与 `IMAGE` 共用 9 号消息，协议层面互斥），触摸全部
交给 HMI。于是「点按钮没反应、也没有列表」——不是回调写错，是**根本收不到那次点击**。

0.7.7 把 Wi-Fi 页改成 `app.json` 里的 `kind: "menu"` 状态（`WIFI`）：开启/关闭 Wi-Fi、
扫描、输入热点密码、8 个热点行、返回画面，全是 HMI 组件；主屏底栏放一个原生「连接热点」
按钮打开它。`cn_doom` 用同一套底栏按钮在同类屏幕上操作，这条路径是通的。画布上那个框
只剩"指示牌"作用，文案是「点下方「连接热点」」，不再假装可以点。

`wifi_page.js` 因此只负责 `bind()`（绑定点击）和 `paint()`（把状态写进组件），
`simulate_car.js` 的 D 组用例检查 `app.json` 的组件名与 `MAX_ROWS` 始终一致——名字写错
在车上是完全静默的（`ui.comp()` 返回 null，点击绑不到任何东西）。

**第四步：画面**
打开应用，应显示完整 CarLife 画面。若黑屏，先看上面两个报告，不要猜。

状态行里的两个地址不要混：`热点：已连接 iQOO 12 Pro（本机 10.92.100.115）` 是**车机自己**
在手机热点里拿到的地址；真正的手机地址写在「正在接收画面 · 手机 10.92.100.136」后面，
来源是 `link.txt` 的 `host:`。0.7.8 之前把本机地址光秃秃地摆在 SSID 后面，看起来像
"手机在 .115、IP 没切"，其实手机一直在 .136。

## 已知限制（第一阶段）

- **无音频**：CarLife 的音频走独立通道，车机音频被 Cinemo 独占。音频/通话后续版本处理（可能需要蓝牙 A2DP）。
- **触摸**：回传坐标的代码是完整的（归一化点 → `carlife-link` 的 ctl socket → 手机），
  但**当前屏幕上收不到触摸**：见上面 0.7.7 那节——像素图与触摸 claim 在同一连接上互斥。
  所以投屏目前是"只看"，操作手机需要另想办法（原生方言没有视频通路；双连接、旋钮光标
  都是未验证的方向）。回传逻辑本身按手机实际编码尺寸换算，PC 侧已用音乐暂停键验证过
  一次完整手势可被手机接受（补 move、保证 ≥170 ms 按压；拖动松开立即发送），
  一旦打通触摸通道可直接复用。
- **链路保活**：手机会周期性关闭 media/tts/vr 三个音频通道（本方案不播音频）。
  `carlife-link` 不再重连它们，只每 400 ms 检查 cmd/video/touch，且每轮最多做
  一次 200 ms 的 connect，`select` 唤醒间隔也从 200 ms 降到 50 ms——避免单线程
  循环被阻塞造成画面卡顿、触摸指令堆积或丢失。
  这些通道关闭**不算取流错误**：屏幕上那句「取流错误」直接来自 `link.txt` 的
  `error:`，之前手机每关一次 vr 通道，屏幕就写着 `read on the vr channel failed`，
  画面却是好的。
- **手机会留下"半死会话"**：六个端口都通、版本也匹配、`encoder init done` 都回了，
  然后一帧不发，也不关闭连接。这种会话在读取路径上完全没有错误可抓——实测在车上
  挂了 **三分半**，直到手机自己把 video socket 丢掉。0.7.8 起 `carlife-link` 有
  **10 秒看门狗**：cmd/video 开着却 10 秒没收到任何字节（没有帧、没有 cmd 消息），
  就把整个会话丢掉、重新拨号（新连接会让手机起一个新会话；实测重启服务即刻恢复）。
  `link.txt` 多了一行 `reset: N last: 原因`，一眼能看出是看门狗动的手。
- **帧率由握手决定**：手机会照车机请求的帧率编码。早期默认请求 30 fps，把
  整条会话压在 12 fps（手机本身支持 60）。现在默认请求 60 fps，PC 实测
  12 fps → 28–38 fps。手机上「智能车载」的帧率设置也要选 60 帧，两边都要对。
  `link.txt` 的 `video:` 行会显示手机实际回报的分辨率与帧率。
- **会话不能频繁重建**：手机在每次会话重建时重启编码器，画面会黑一下并卡住。
  现在 cmd 通道掉线时**保留正在工作的 video 通道**，只补 cmd 并重发版本号，
  不再把整个会话拆掉；同时车机每 2 秒发一条统计消息，避免手机因 cmd 静默
  而主动断开会话。
- **二进制必须用 build.sh 构建**：在 Windows 的 Git Bash 里直接调 zig 时，外壳会把
  `-Wl,--dynamic-linker=/lib/ld-linux-x86-64.so.2` 当成路径改写成构建机自己的加载器，
  写进 ELF 的 `PT_INTERP`：

  ```
  D:/.../PortableGit/lib/ld-linux-x86-64.so.2
  ```

  车机上没有这个文件，exec 返回 ENOENT，屏幕显示「反复重启 · carlife-link exited
  (rc 127)」——文件在、权限对、就是永远起不来，热点已连也连不上手机。0.6.0 和 0.7.0
  装的都是这种二进制。`elf_check.py` 当时放行它，是因为它做的是**全文件子串匹配**，
  而 `…/PortableGit/lib/ld-linux-x86-64.so.2` 的尾部正好含有待查的
  `/lib/ld-linux-x86-64.so.2`。现在三重防护：`build.sh` 关掉路径改写（改用相对路径
  以免连带破坏其它参数）、`elf_check.py` 解析 `PT_INTERP` 精确比对、`test_link.py`
  直接校验仓库里这三个二进制，坏文件进不了提交。
- **`run.sh` 用 FIFO 连接两半，不是两个独立 subshell**：0.7.0/0.7.1 为了分别记录
  各自的退出码，把原来的 `link | decode` 拆成两个并列的 subshell，管道也就没了：
  `carlife-link` 把流写进启动脚本自己的 stdout（进 journal），`carlife-decode` 读的
  是启动脚本的 stdin（在车机上就是 `/dev/null`），于是它一启动就 `read` 到 EOF、
  `rc 2` 退出，屏幕显示「反复重启 · carlife-decode exited (rc 2)」+「解码：stream
  ended」——而 link 那边其实还在正常拨号、还在写字句通顺的报告。真崩的是管道，不是
  解码器。现在用 `$DIR/stream.fifo` 把两端接回去（`open()` 会等对端就位，所以不会
  出现半边先跑），两半仍各自写 `.rc`，`run_sh_test.py` 里加了"字节必须真的送达"
  的用例把它钉住。
- **装了不等于能解码：`decode probe:` 这一行要看**：解码器真正依赖的是车机自带的
  MSDK、libva 和 `/dev/dri/renderD128`，这三样只有车机上有，PC 上验不了。
  `install.sh` 现在会在装完那一刻以 root 跑一次 `carlife-decode --probe`，把结果
  写进 `/dev/shm/carlife-wireless-boot.txt`：

  ```
  decode probe: mfx=libmfxhw64.so.1 api=124 va=libva display=yes reading the stream from stdin
  ```

  没有这一行里的 `mfx=…` 就是没找到 MSDK 库；`display=no` 说明 VA 没起来（MSDK 可能
  改用自带设备，仍能解码）；整行以 `probe: ` 开头的错误才是真的不能解码。之前这类
  失败要等取流跑起来、看到黑屏才知道，现在安装时就写在纸上。MSDK 的返回码同时打印
  名字（`-3 (unsupported)`、`-17 (device failed)`），不再是看不懂的数字。
- **`sink` 每帧 flush**：`carlife-link` 把流写到管道时，stdio 是全缓冲的：不 flush
  的话每帧末尾几 KB 会一直留在 link 的用户态缓冲里，直到下一帧把它挤出去——白送一
  帧延迟。现在每帧写完立刻 `fflush`。
- **车型**：解码依赖车机自带的 Intel MSDK 2017（`libmfxhw64.so` API 1.24）+ libva；若车型不同可能缺失（install.sh 的 probe 会报告，不再是盲区）。
- **网络白名单依赖 mgu-uplink**：`carlife-link` 降到 uid 65534 才能从车机 WiFi 发包；这依赖 Store 在装本组件时写好 `uids.d/carlife-wireless`。若白名单没写进去，link 会连不上手机——按上面"第一步"检查该文件。

##  desk 回归测试（PC，不需要车）

```bash
# 协议层：握手字节、6 通道、触摸编码、车机 ABI
python3 kit/carlife-wireless/link/test/test_link.py
# 解码几何：裁剪/尺寸/色度布局（含 1920x1080 全画面）
python3 kit/carlife-wireless/decode_math_test.py
# 手机地址发现：手填 / lease / 默认路由 / status 推算 / auto
python3 kit/carlife-wireless/test/find_phone_test.py
# 启动器：不删 link.txt、崩溃时写 run.txt、无地址也启动链路
python3 kit/carlife-wireless/test/run_sh_test.py
# 车机模拟：占位帧、按钮、触摸、诊断显示（纯 Node，无需车机）
node apps/cn_carlife_wireless/test/simulate_car.js
# 视频通道：claim 整块画面、只在 caps 有 16 且文件已存在时命名一次（不需要 socket）
node kit/tools/test_video.js
# 渲染器运行时（需要能建 unix socket；Windows 上常见 listen EACCES）
node kit/tools/test_runtime.js
```
