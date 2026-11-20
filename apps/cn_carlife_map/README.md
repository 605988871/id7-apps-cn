# CarLife Map on Cluster / HUD

把手机 CarLife 的导航画面显示在 iDrive 7 仪表盘中央地图区，实验性地也能显示在 HUD。

> 这是**车机侧**应用。它不负责从手机抓 CarLife 画面——那一步必须由单独的捕获程序完成（见下文"帧源"）。没有帧源时可以用内置测试画面验证整条显示链路。

## 原理

```
手机 CarLife 导航画面
   │  由捕获程序取到，缩放到 1088×480，转成 YUV 4:2:0
   ▼
帧源（TCP 流 / 本地 FIFO / 内置测试画面）
   │  一帧一个 4:2:0 atlas，字节数 = 1088 × 720 = 783360
   ▼
本应用 main.js
   │  cluster_render_client.js → /dev/shm/cluster-render/render.sock
   ▼
cluster-render（从 MGU Store 安装的独立服务）
   │  RAMSES + DCSM/SOME/IP，slot 0x100（仪表）/ 0x323（HUD）
   ▼
KOMBI 的 GPU 做 YUV→RGB，上屏
```

画面数据和地图数据无关：车机只显示"一块屏幕"，导航仍由手机运行。这与 `robertnisipeanu/idrive-apps`
的 CarPlay 投屏思路一致；差别在于 CarLife 是百度私有协议，不走 CarPlay 的 AVB 视频管道，
所以那边的二进制补丁无法直接搬过来用。

## 前置条件

1. iDrive 7 / MGU（与 id7-apps-cn 同代固件）。iDrive 8 未验证。
2. 车上要有 **cluster-render**（`/dev/shm/cluster-render/render.sock`）。多数车的包里有，也可以
   从 `robertnisipeanu/idrive-apps` 源装。它**不**写在 `requires` 里：仓库里没有这个组件，写成
   硬依赖会让安装停在计划阶段（`needs cluster-render ... which no source has`），比运行时连不上
   更难查。没连上时应用状态页显示 `not connected`。
3. 想投 HUD 的车需要有 HUD；HUD 上仅中间一块区域可见，用设置里的位置和尺寸微调。
4. 想显示手机画面，还需要 CarLife 在跑（工具会随应用一起装，见"安装"）。

> 这个应用只是"播放器"：它把帧送进 cluster-render 的 map / hud 槽位，自己不解码。
> 选 `CarLife (live)` 时，画面由工具 `carlife-tap` 从 carlife 进程里复制出来、写进
> `/dev/shm/carlife-map/live.sock`；那个工具是 `requires` 里的一项，装应用时会一并装上。

## 安装

商店里装 **CarLife Map** 即可，`requires` 会带上：

| 组件 | 作用 |
|---|---|
| `idrive7-renderd` | 应用自己的 GPU 渲染器 |
| `carlife-tap` | 从 carlife 进程复制 H.264，随应用安装、随应用卸载 |

两件事必须做对，否则装完没效果：

1. **装之前先在车上打开一次 CarLife**（插手机、进到导航页）。取流件的安装脚本要从正在运行的
   进程里认出是哪个 unit 启动了 carlife，进而把库追加到它的 `LD_PRELOAD`。CarLife 没在跑时，
   它会退回到读 unit 文件、再退回到按文件名匹配；三者都不中时安装会失败并说明原因——那时打开
   CarLife 再装一次即可。
2. **装完重启车机**。库只在 carlife 启动时加载；安装脚本不会重启服务（单独重启 carlife 而
   Cinemo 其余进程还在跑，风险更大且没有收益）。

本地构建：

```sh
python3 kit/tools/build.py cn_carlife_map
```

产出 `dist/cn_carlife_map@<version>.tgz` / `.mgu`，用 mgu-store 或 `deploy/push-to-car.sh` 安装。
应用默认自启动（`autostart: true`）。

版本号必须提升才能让车机端 mgu-deploy 真正重装（它按版本号判断 `current`）。

## 设置

| 设置 | 说明 |
|---|---|
| Show map on | Off / 仅仪表 / 仅 HUD / 仪表和 HUD |
| Picture source | Test picture 测试画面 / CarLife 实时画面 / TCP 网络 / 本地管道 |
| Frame rate | 5–30 fps。地图变化慢，15 fps 通常够，也能减轻簇的上传负担 |
| HUD width / left-right / up-down | HUD 画面尺寸和位置，用测试画面在车上对齐 |
| HUD on top of alerts | HUD 是否压在宝马自己的提示框之上；默认让位 |
| Map crop top / bottom / left / right | 从 CarLife 整屏画面里裁掉多少才算地图区，按百分比 |
| Map crop fit | 裁出的地图怎么装进 1088×480：Fill（按形状裁）/ Stretch / Fit（留黑边） |

应用状态页会显示：当前帧源及其细节、cluster-render 连接状态、map/HUD 层的状态、累计帧数和帧序号、
HUD 收下的帧数与它当前的尺寸（`HUD 37 (456x200)`），以及 `USB tap` 一行——取流件写在
`/dev/shm/carlife-tap.txt` 里的读数。

`HUD 37` 一直是 0，说明帧没送到（层被拒或尺寸不符）；帧数在涨但玻璃上没有东西，那就是槽位被锁或让位，
看同一行的状态。`waiting` 表示层已建好但在等槽位或等第一帧；`shown` 表示已上屏。

`USB tap` 一行是判断 CarLife 环节卡在哪的唯一入口，四种读法：

| 显示 | 含义 |
|---|---|
| `not installed (no report)` | 取流件没装成功，或装了但还没重启车机（库只在 carlife 启动时加载） |
| `in 0.0MB ...` | 库已加载但没读到 USB 数据：手机没连、或 CarLife 没在前台跑导航 |
| `in 12.4MB ..., H.264, IDR 240` | **取流通了**：画面正从手机经 USB 到车机，只是还没有解码器 |
| `out 3.2MB` 也在涨 | 反向（触摸）数据在走，说明链路是双向正常的 |

## 帧源

### Test picture（默认）

应用在车机上直接生成滚动的测试地图图案（写 YUV atlas，不做 RGB 转换）。用于确认
cluster-render、槽位、HUD 位置都正常，不依赖任何外部程序。

### CarLife（实时画面）

选这一项时，应用在 `/dev/shm/carlife-map/live.sock` 上等取流件连进来，收到的是 CarLife
自己的画面。取流件（tool id `carlife-tap`）在应用的 `requires` 里，**装应用时会一并装上、
卸应用时一并卸掉**；但要**装完重启过一次车机**才生效：那个库由 systemd drop-in 挂到 carlife
的 `LD_PRELOAD` 上，只在 carlife 启动时加载。

装之前，仪表盘会显示 `WAITING FOR CARLIFE`——不是黑屏，所以"在等"和"坏了"不是同一个画面。

链路分三种状态，仪表盘各有一张对应的画面，不会都用黑色糊过去：

| 状态 | 仪表盘 | 中控状态页 |
|---|---|---|
| 取流件没连上 | `WAITING FOR CARLIFE` + 呼吸点 | `waiting for capture (...)` |
| 流到了但没有解码器 | `CARLIFE LIVE` + 已收到的 MB / IDR 数 / 速率 | `H.264 ..., no decoder` |
| 有解码后的帧 | 真实画面 | `decoded frames from ...` |

**当前限制：中间那条就是现状。** CarLife 发的是 H.264，车机上没有现成的解码器，应用收到的
是裸流，所以看到的是"流已到达"的数据画面而不是导航画面。这证明的是取流链路（USB → carlife
进程 → 应用 → cluster-render → 仪表盘）已经全通，缺的只是解码这一步。

帧格式与下文的 TCP/FIFO 相同（`CLMF` 头 + 一块 1088×480 的 YUV 4:2:0 atlas），没有第二个格式：
将来把解码器接上，把解码结果按这个格式写进同一个 socket 就行，应用这一侧不用再改。

### 只显示地图，不显示整屏

CarLife 协议里**只有一路视频**：手机把中控那块屏整块编码下来（状态栏、按钮、地图都在里面），
没有"地图单独一路"这种东西。所以取流件拿到的必然是整屏，这一点和 CarPlay 不同——CarPlay 是
手机端按仪表盘尺寸**单独渲染一路**出来，画面天生只有地图、长宽比也天生正确。

要"只上地图"，只能在**解码之后**裁：`Map crop top/bottom/left/right` 去掉状态栏和按钮区，
剩下的地图区再按 `Map crop fit` 装进 1088×480。

- `Fill`（默认）：把地图区裁成 1088:480（约 2.27:1）的一条，横向视野完整、纵向少一些。地图
  这种东西纵向少一点不影响导航，所以它是默认。
- `Stretch`：整块压进去，视野全但要变形。
- `Fit`：整块缩小留黑边，不变形但字更小。

代价说清楚：**仪表盘上的纵向视野会比手机上少**。CarPlay 那一路是手机照着仪表盘的长宽比渲染的，
不需要从中裁一条，这是两者无法完全对齐的地方。

参数由应用写在 `/dev/shm/carlife-map/crop.json`，解码器每次读到变化就按新框输出。解码器还没接上
（见上面的"当前限制"），所以这些参数现在只是写进文件，还不会影响画面。

`carlife.json` 里可以用 `carlifeHost` / `carlifePort` 让应用主动去连（手机上跑取流件时用），
`sockPath` 改本地路径。

### TCP

帧源连到 `127.0.0.1:20558`。端口/主机可用应用数据目录下的 `carlife.json` 覆盖：

```json
{ "host": "127.0.0.1", "port": 20558 }
```

如果想让手机/电脑主动连车机（车机监听），写：

```json
{ "tcpListen": true, "port": 20558 }
```

### FIFO

帧源读 `/dev/shm/carlife-map/frames.fifo`，路径同样可用 `carlife.json` 的 `path` 覆盖。
适合 root 的原生捕获程序在本机写帧。

### 帧格式

TCP 和 FIFO 都是同样的字节流，Little Endian：

```
u32 magic = 0x464d4c43    ('CLMF')
u32 len   = 783360        (1088 * (480 + 480/2))
u32 seq   = 帧序号
len 字节的 4:2:0 atlas
```

atlas 布局：

```
行   0 .. 479    Y 平面，每行 1088 字节
行 480 .. 719    左半 544 字节 = U，右半 544 字节 = V
```

`kit/tools/carlife_frame_sender.py` 是一个最小的发送端：从 stdin 读 NV12 原始帧，
按上面的格式加上帧头后发到车机。可以这样用（在电脑或手机上）：

```sh
ffmpeg -i phone_capture.mp4 -vf scale=1088:480 -pix_fmt nv12 -f rawvideo - \
  | python3 carlife_frame_sender.py --host <车机IP> --port 20558
```

真正从安卓手机实时取 CarLife 画面，需要在手机上用 MediaProjection 截屏（无 root 可行），
编码后送到发送端；或者用 scrcpy 的 H.264 流在电脑上解码。这部分不在本应用范围内。

## HUD 仲裁

应用把自己当临时（temporary）HUD 用户：通过 `kit/runtime/hud_claim.js` 在
`/dev/shm/mgu-hud/cn_carlife_map` 留下占用标记，每 2 秒刷新，并用 `HudClaim.others()`
复查——别的 app 占用时自动让位（状态页显示 `giving way`），对方释放后自动收回。
关掉"Show map on"或切到仅仪表时会释放。

## 可行性边界（审查结论）

**能成链路的部分：** 仪表盘 `map` 区（1088×480，slot 0x100）默认配置就允许第三方
`contend:1` 的层从原厂地图手里抢过来，这是 waze-on-cluster 实车验证过的；HUD slot 0x323
也能收 video 层，atlas 字节数、帧率、像素内存都在服务限制内。

**HUD 的帧必须是它自己的尺寸。** 这一条踩过坑：video 层的帧长度必须正好等于该层的
`vw × vh`，否则 cluster-render 的 `frame()` 直接返回 false，**静默丢弃**，界面上什么也
不会说；而层矩形比帧小时不是缩放而是**裁切**，只有帧的左上角那一块会被画出来。把地图的
1088×480 帧直接喂给 456×200 的 HUD 层，HUD 上就只有地图左上角的深色背景——在投影式
HUD 上等于什么都没有。所以 HUD 层有自己的 `vw/vh`，画面由 `atlas.js` 的 `cropAtlas()`
从地图帧中心裁出来，逐帧复用同一块缓冲。HUD 层用 `class: 'overlay'`，压在原厂的
`content` 层之上。

**必须清楚的限制：**

- **CarLife 画面来源是本方案最大的未解决项。** CarLife 走私有协议（USB AOA /
  Wi-Fi），把手机界面编码成 H.264 送车机，车机端由百度的闭源库解码显示。
  本应用既没有实现 CarLife 协议，也没有从车机 CarLife 进程抓流——它需要一个外部
  帧源（手机截屏推流，或车机侧抓 H.264 再解码）。idrive-apps 对 CarPlay 的那套二进制
  补丁不能直接套用到 CarLife，因为协议栈完全不同。
- **投到 HUD 比投到仪表盘弱。** cluster-render 的 `hud_take_over_stock=0`，抢不过原厂
  HUD 导航引导；video 层没有逐像素 alpha，会盖住底下的宝马内容。所以本应用把画面
  限制在 HUD 可见窗口的安全区（约 x120–680 / y120–320），避开底部的速度/限速牌。
  实测 HUD 可见窗口只有约 560×240，地图缩到这么小字会偏小。
- **map slot 争抢有失败率。** 实测约 30% 的争抢会输，服务按 2/5/10/20/30 秒阶梯重试；
  不是装上立刻就显示。抢到时会同时隐藏原厂转向框（`guide_hold:1`）。
- **上传预算共享。** 所有客户端合计约 5500 KB/s。测试图案已做成静止网格 + 单个移动
  标记（相邻帧仅变 0.1%），但真实地图若整屏变化，两个 1088×480 层 @ 15fps 仍可能
  打满预算导致掉帧。建议地图源先降到 10 fps 试。
- **video 层显示缓冲最多 2 个。** 若车上同时跑 waze-on-cluster（它也用 video 层），
  第三个显示层可能被拒。两者同时开属于未验证场景。
- **OAP + JS video 路径无实车先例。** 协议和客户端单测都过了，但没有"JS 客户端送
  4:2:0 atlas 上真车"的成功记录。请把本应用当实验功能，先在车上用 Demo 验证。
- 只支持 iDrive 7 的 `map` / `hud` target；cluster-render 必须在场。
- 帧源配置在应用数据目录（`carlife.json`），不随应用包走。
