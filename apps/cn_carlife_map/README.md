# CarLife Map on Cluster / HUD

把手机 CarLife 的导航送到 iDrive 7：**仪表盘显示地图，HUD 显示转向卡片**（箭头、距离、路名，
可加车道指引和限速）。

仪表盘和 HUD 是两种画面，不是一张图裁两次。HUD 的玻璃离眼睛一米、只有约 560×200 可见，
把地图缩到那里去既看不清也没意义；原厂导航和 CarPlay 在 HUD 上画的都是一个箭头。所以
HUD 走自己的一路：一张 `480×168` 的转向卡片。

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
| 显示在 | 关闭 / 仅仪表盘 / 仅 HUD / 仪表盘和 HUD |
| HUD 显示内容 | 转向卡片（箭头、车道、限速，默认）/ 一小块地图 |
| 转向卡片内容 | 箭头、距离、路名、车道、限速（默认）/ 箭头、距离、路名 / 只要箭头和距离 |
| 画面来源 | 测试画面 / CarLife（实时画面）/ 网络（TCP）/ 本地管道 |
| 帧率 | 5/8/10/12/15/20/24/30 帧/秒，默认 15。这个值现在也是**发送上限**：解码器给多快都按这个节奏往两块屏幕送，避免帧堆在套接字里一顿一顿地出来。地图变化慢，12–15 帧/秒通常最稳；车机吃力就调到 10 或 8 |
| HUD 画面宽度 | HUD 画面尺寸，用测试画面在车上对齐。默认 62%（卡片约 344×120），不铺满整块玻璃：HUD 是共用的，宝马自己的车速/限速和别的应用也在上面，铺满就把它们全遮住了。HUD 左右/上下位置已移到主界面的「微调」页，用按钮调；即使宽度调到 100%，按钮仍能把卡片移出默认安全区（整块 800×480 HUD 都能去） |
| HUD 画面不透明度 | HUD 那层的不透明度，默认 100%。调到 60–80% 时下面的车速、限速和别的应用的内容会透出来，代价是自己的画面也变淡 |
| HUD 压在提示框之上 | HUD 是否压在宝马自己的提示框之上；默认让位 |
| HUD 画面方式 | HUD 那层用什么送：自动（默认，先用视频层，被拒或 6 秒没显示就立刻改成图像层）/ 图像（RGBA）/ 视频（4:2:0）。画面出不来时先看这一项和状态页的 `HUD lyr` |
| 地图裁剪：上边、下边、左边、右边 | 从 CarLife 整屏画面里裁掉多少才算地图区，按百分比 |
| 地图裁剪方式 | 裁出的地图怎么装进 1088×480：填充（按形状裁边，推荐）/ 拉伸（压扁，会变形） |
| HUD 卡片裁剪：上边、下边、左边、右边 | 从 CarLife 整屏画面里裁哪一块当 HUD 的导航条，按百分比。默认 上 0 / 下 16 / 左 0 / 右 24 |
| HUD 卡片裁剪方式 | 这块怎么装进 HUD：拉伸（默认，内容全在，箭头会胖一点）/ 填充（保住箭头形状，边会被裁掉） |
| 仪表盘地图缩放、HUD 地图缩放 | 两块屏幕各自显示地图的放大倍数，默认均为 100%，即**完整地图**。调大（最大 400%）是放大取局部；HUD 从前的"放得很大"就是把中间一小块贴到玻璃上，现在默认整张地图缩小显示，与仪表盘一致。放大后可用微调页的左右上下移动取景 |
| 等待文字大小 | HUD 等待页文字相对默认大小；默认 100%，此时 HUD 卡片约为仪表盘等待页的 1/3。可选 10%–600%，文字不会超出画面 |
| 显示等待动画 | 默认开：没画面时仪表盘/HUD 显示 `WAITING FOR CARLIFE` 和诊断原因。关掉后，等待期间这两层直接隐藏（宝马自己的内容透出来），第一帧真实地图到来时自动显示；状态页 `Frames` 行末尾会显示 `wait on/off` |

排查取流/解码时保持等待动画打开——那几行诊断文字是唯一能在车上看出卡在哪里的入口。链路稳定后再关掉，玻璃上就不会一直挂着等待画面；关掉并不影响取流和解码，它们照常运行，只是没有地图时不往屏幕上放东西。

状态页 `Frames` 行的 `in` 是取流/解码送来的帧数，`map` / `HUD` 是节流后真正被渲染器收下的帧数，HUD 后面的 `@x,y` 是当前卡片位置。两者差得多是正常的：渲染器只显示最后一帧，多余的帧本来也看不到。另外，解码器通过 UNIX 套接字送来的大帧按块收齐再解析，不再每来一小块就复制一遍整张未完成的图，车机上能省下可观的拷贝开销。

### 微调页（主界面的「微调」按钮）

位置类设置不用在设置页的下拉里翻像素值，改在主界面按 **微调**（BTN_PAGE）翻到校准页，旋钮选中按钮、按确认键一次走一格，玻璃上立刻见效：

| 分组 | 按钮 | 对应设置 |
|---|---|---|
| HUD 位置 | 左/右、上/下 | HUD 左右位置、HUD 上下位置 |
| HUD 地图 | 缩小/放大、左/右、上/下 | HUD 地图缩放、HUD 里地图左右、HUD 里地图上下 |
| 仪表盘地图 | 缩小/放大 | 仪表盘地图缩放 |
| 等待文字 | 左/右、上/下 | 等待文字左右、等待文字上下 |

「全部复位」把以上各项还原为默认值。缩放的 100% 是完整地图；位置在缩放 100% 时无取景可移，放大后才起作用。设置页里仍保留两项缩放的下拉，方便一次选到较大倍数。HUD 位置现在一次走 10 px（大步还有 20/30/40/60/80 px），默认停在安全区中央；按钮可以在整块 800×480 HUD 里移动，不会被安全区卡住——状态页 `@x,y` 就是按按钮后的实际坐标。

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
| `in 12.4MB ..., H.264, SPS 2, IDR 240` | **取流通了**：画面正从手机经 USB 到车机；下一行 `Decode` 说它有没有变成画面 |
| `out 3.2MB` 也在涨 | 反向（触摸）数据在走，说明链路是双向正常的 |
| 尾部 `, sink connected 12.3MB/0d` | 取流件**已经把数据写进解码器的套接字**。反过来 `sink no reader` 就是没连上，解码器再正常也收不到东西 |
| `SPS 0` | 管道里从来没有序列头：解不出来，等多久都一样，要看手机侧为什么不发 |

`out` 是 USB 反向流量，不是"送给解码器多少"——后者是这一行尾部的 `sink`，
以及下一行 `Decode` 里的 `in`。两个数对不上，卡住的环节就在它们之间。

`sink` 连不上时，下一行 `Tap cmds` 会换成 `Tap sink`，写的是取流件自己拿到的错误：
`No such file or directory (2)` 是解码器没绑上那个套接字，`Permission denied (13)`
是它连不进去，`Too many open files (24)` 是 carlife 自己的描述符用完了。

取流件 0.3.0 起，同一行后面还会跟两个词，来自它的协议分诊：

| 尾部 | 含义 |
|---|---|
| `, framed` | 这条管道带着 CarLife 自己的包头（命令通道也在里面），取流件交给应用的已是**纯 H.264 载荷** |
| `, raw` | 管道里没有包头，整条就是视频数据，尺寸只能从 H.264 的 SPS 里读 |
| `, car wants 1920x720` | 车机通过 `video encoder init` 向手机请求的编码尺寸——裁剪参数必须照这个数算，不能猜 |

这一行是判断"车机要多大画面"的唯一入口。完整报告在 `/dev/shm/carlife-tap.txt`，
里面有每个 `serviceType` 的出现次数和头 24 字节，够看出命令通道里到底有什么。

再下面一行 `Decode` 读的是解码器写的 `/dev/shm/carlife-decode.txt`：取流说字节到了，
解码说它有没有变成画面，以及卡在哪一步。

| 显示 | 含义 |
|---|---|
| `not running (no report)` | 解码服务没起来（`carlife-decode.service`），或工具没装成功。后面跟的那一段来自 `Dec boot` 行，见下 |
| `0 frames, 0 fps - waiting for the tap` | 解码器在听，但**没有任何人连上来**：取流件的 `sink` 那半句会说为什么 |
| `0 frames, 0 fps - stream connected, in 8.0MB/1 conn` | 连上了，字节也到了，却一张都没解出来：流本身的问题（没有 SPS，或参数被拒） |
| `0 frames ... (3 restarts)` | 报告的 `pid` 在变：服务起来又倒下，`Restart=always` 每 3 秒重来一次 |
| `812 frames, 15 fps, last 66ms` | **通了**：仪表盘和 HUD 上的画面就是它给的 |
| `... - MFXVideoDECODE_Init: -15` | 到这一步为止都正常，参数被拒；报告里同时有库名和 API 版本 |

没有报告时，`Decode` 下面那行 `Cut` 会换成 `Dec boot:`，读的是安装钩子写的
`/dev/shm/carlife-decode-boot.txt`：它当初有没有把 `carlife-decode` 变成可执行、
单元文件在不在、`systemctl` 说它是什么状态，以及起不来时系统给的最后一句话。三种最常见的读法：

| `Dec boot` | 含义 |
|---|---|
| `active` 但仍无报告 | 进程起来了又立刻退出，看下面 `Exec err` 行的 systemd 原文 |
| `... is missing or not executable` | 载荷里的执行位丢了；重装一次工具即可（钩子会 `chmod 0755`） |
| `... runs (selftest ok, glibc 2.27)` | 钩子真的把它跑起来过：执行位、装载器、C 库都没问题 |
| `... will not run: ...` | 跑不起来，后面是它自己的第一句错话；载荷是坏的，重装工具 |
| `unit: ... was not installed` | 商店没落单元文件；工具与应用的依赖关系没对上，重装应用 |
| `failed` / `No such file or directory` | 单元在，`ExecStart` 指向的路径不存在：`/var/opt/carlife-tap/current` 没建起来 |

起不来时，那一行下面会多一行 `Exec err:`，是 systemd 自己那句话去掉了时间戳和主机名：

```
Exec err: Failed at step EXEC spawning /var/opt/carlife-tap/current/carlife-decode: No such file or directory
```

**`No such file or directory` 配上一个确实存在的文件**，说的是 ELF 里写的装载器不在这台车机上，
不是文件不在（0.4.4 就是这样：程序写的是 `/lib64/ld-linux-x86-64.so.2`，而车机只有
`/lib/ld-linux-x86-64.so.2`）。`...: Permission denied` 才是执行位。取流件 0.4.5 起装载器
已按车机改好，`loaders:` 一行会列出这台车机上实际有哪几个。

解码在车机侧做，因为 CarLife 只送一路整屏 H.264，协议里既没有"只含地图"的第二路，
也没有转向/车道/限速这些数据（官方车机端 SDK 的导航模块只有 `IDLE` 和 `START` 两个状态）。
所以地图和 HUD 上那条导航栏，都是从这一路画面里裁出来的。

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

这张等待画面的中间还有一行字，说明到底在等什么，因为三种"什么都没来"要做的事完全不同：

| 画面上那行 | 意思 | 要做什么 |
|---|---|---|
| `DECODER NOT RUNNING` | 解码单元没跑（最常见） | 看状态页 `Dec boot` 行；重装一次取流件即可，钩子会 `chmod` 并 `systemctl restart` |
| `DECODER FAILED TO START` | 单元在但起不来 | 状态页最下面 `Exec err` 行有 systemd 的原文 |
| `DECODER WILL NOT RUN: NO LOADER` | 程序里的装载器在车机上不存在 | 装 0.4.5 及以后的取流件；旧版写的是 `/lib64/...`，车机没有这个目录 |
| `DECODER NOT EXECUTABLE` | 载荷没有执行位 | 重装取流件 |
| `DECODER UP, NO PICTURE YET` | 解码器在，取流件还没连上 | 打开 CarLife 并跑起导航 |
| `DECODER OK, NOTHING REACHED THE APP` | 解码器已经解出画面，但一帧都没到应用 | 断在这一侧：看状态页 `Source` 行 |
| `SOCKET: PERMISSION DENIED` | 应用建不出 `/dev/shm/carlife-map/live.sock` | 那个目录是 root 建的、只给 root 写；装 0.4.7 及以后的取流件（它会 `chmod 0777`），装完不用重启，应用每 4 秒自己重试 |
| `FRAME 576000 WANT 783360` | 解码器在送，但尺寸不是图层要的 | 这一帧会被 cluster-render 静默丢掉；说明车机上跑的是旧版解码器，重装取流件 |

链路分三种状态，仪表盘各有一张对应的画面，不会都用黑色糊过去：

| 状态 | 仪表盘 | 中控状态页 |
|---|---|---|
| 取流件没连上 | `WAITING FOR CARLIFE` + 呼吸点 | `waiting for capture (...)` |
| 流到了但解码器没起来 | `CARLIFE LIVE` + 已收到的 MB / IDR 数 / 速率 | `H.264 ..., no decoder` |
| 解码器在跑但没有帧 | 同上 | `Decode : 0 frames, 0 fps - MFXVideoDECODE_Init: -15` |
| 有解码后的帧 | 真实画面 | `decoded frames from ...` |

`carlife-tap` 从 0.4.0 起自带解码器（`carlife-decode`，独立 systemd 单元），所以正常情况下
应该直接到最后一档。中间两档是"取流通了、解码没通"，`Decode:` 一行会指名停在哪个调用——
这就是车机上唯一能看到解码失败原因的入口。解码器在车机上**尚未实测过**（本机编译、ABI 已校验，
但第一次真正跑它的是车），所以这两档是真实可能出现的。

解码器读 `/dev/shm/carlife-map/h264.sock` 的裸流转成两幅 CLMF 图：`live.sock`（1088×480 地图）
和 `hud.sock`（HUD 卡片，尺寸随 `HUD width` 变）。帧格式与下文的 TCP/FIFO 完全相同。

`/dev/shm/carlife-map` 是**两个用户共用的目录**：解码器以 root 跑，应用不是。建 unix socket
要的是**目录**的写权限，而 `mkdir(0777)` 会被服务的 umask 砍成 root 的 `0755`，于是应用的
`listen()` 拿到 `EACCES`——这个词看着像"地址已被占用"，其实完全相反。取流件 0.4.7 起每次启动
都会把这个目录 `chmod 0777`，应用也把 `listen` 失败从"到此为止"改成每 4 秒重试一次：装完新
取流件后不用重启车机，几秒内自己接上。超时那一行的措辞也跟着分开了：`socket not opened`
是自己没能监听，`nothing connected` 是监听好了但没人来。

### 只显示地图，不显示整屏

CarLife 协议里**只有一路视频**：手机把中控那块屏整块编码下来（状态栏、按钮、地图都在里面），
没有"地图单独一路"这种东西。所以取流件拿到的必然是整屏，这一点和 CarPlay 不同——CarPlay 是
手机端按仪表盘尺寸**单独渲染一路**出来，画面天生只有地图、长宽比也天生正确。

要"只上地图"，只能在**解码之后**裁：`Map crop top/bottom/left/right` 去掉状态栏和按钮区，
剩下的地图区再按 `Map crop fit` 装进 1088×480。

- `Fill`（默认）：把地图区裁成 1088:480（约 2.27:1）的一条，横向视野完整、纵向少一些。地图
  这种东西纵向少一点不影响导航，所以它是默认。
- `Stretch`：整块压进去，视野全但要变形。

代价说清楚：**仪表盘上的纵向视野会比手机上少**。CarPlay 那一路是手机照着仪表盘的长宽比渲染的，
不需要从中裁一条，这是两者无法完全对齐的地方。

参数由应用写在 `/dev/shm/carlife-map/crop.json`，解码器每 0.5 秒重读一次，所以改设置当场生效，不用
重启。同一个文件里还有 HUD 导航条的两个参数：`cardTop/cardBottom/cardLeft/cardRight`（裁哪一块）和
`cardW/cardH`（输出多大——这个由 `HUD width` 决定，应用写，不要手改）。

怎么知道自己调对了：状态页的 `Cut:` 一行是解码器自己报的账，例如

```
Cut     : out 1088x480 + card 480x168 | crop m8/0/0/0 c0/16/0/24 | map rect 1280x564 at 0,106
```

`out` 是它实际发出去的两幅图尺寸，`crop` 是它读到的百分比，`map rect` 是它最后真正裁的那块像素
矩形。**画面偏一条、或者有黑边，先看这三个数对不对**：`out` 和图层尺寸不一致时 cluster-render 会
静默丢帧（帧数在涨，屏幕上没有东西）。

`carlife.json` 里可以用 `carlifeHost` / `carlifePort` 让应用主动去连（手机上跑取流件时用），
`sockPath` 改本地路径。

## HUD 显示什么：转向卡片

HUD 上先是一个转向箭头和一个距离（外加路名），路口再加一排车道指引和一个限速牌。这不是简化，
是这块玻璃的用法：它离眼睛一米、可见区约 560×200、焦点在远处，地图放上去既看不清也来不及看。
原厂导航在 HUD 上画的就是一个箭头，CarPlay 也是。

`Turn card detail` 三档，因为一张 HUD 说得太多就等于什么都没说：

| 档位 | 内容 |
|---|---|
| `full`（默认） | 箭头、距离、路名、车道排、限速 |
| `standard` | 箭头、距离、路名 |
| `minimal` | 箭头、距离 |

车道排按 CarLife 自己的说法画：`straight` / `left` / `right` / `slight-left` / `slight-right` /
`uturn` / `left-straight` / `right-straight`。该走的那条画**亮**，其余压暗——单色投影只有一个
通道可用，亮度就够：眼睛会落在亮的那条上。限速牌是圆环加数字，三位数时字号自动降一级，
因为 `100` 塞不进 `60` 的环。

所以 HUD 有**自己的一路帧**，尺寸 480×168，走 `/dev/shm/carlife-map/hud.sock`（与地图的
`live.sock` 并存，格式相同）。一个尺寸一路流，是 cluster-render 的硬要求：层帧长度必须正好
等于 `vw × vh`，否则静默丢弃。

卡片这一路**永远不会去连地图那一路的端口**：一个生产方只服务一条连接，连上去要么被拒、要么
把地图挤掉。所以按来源分开——CarLife 用本地 socket；`Network (TCP)` 时改用 **端口 +1**
（默认 `20559`）自己监听，谁来推都行；`Local pipe` 没有第二条路径，状态页会直接写
`no card stream`。

`What the HUD shows` 两档：

- `Turn card`（默认）：HUD 上是转向卡片。`Picture source = Test picture` 时这张卡由车机自己画
  （`atlas.js` 的 `arrowAtlas()`），**所以不用等解码器就能在车上把形状、大小、位置都调好**。
  卡片每 7 秒换一个场景（左转带三车道、直行带五车道、掉头、无路名……），因为只演一种情形
  会把其余排版的问题全藏起来。
- `A piece of the map`：退回旧行为，从 1088×480 的地图帧中心裁一块给 HUD。字会很小，只作对照。

**要清楚一件事：卡片上的车道和限速，眼下只有测试画面能给。** 百度官方的车机端 SDK
（`CarLife-Android-Vehicle-V2.0`）里，导航模块只有两个状态 `NAVI_STATUS_IDLE` /
`NAVI_STATUS_START`——没有转向类型、没有距离、没有车道、没有限速。所以接真画面时，这些
**只能从 CarLife 自己的导航条上裁下来**（箭头和车道本来就画在那一条里），不可能由车机重画。

接真画面时，卡片不是"从地图裁"，而是**从 CarLife 整屏画面的导航条裁**：导航条横在画面顶部，
箭头在它左端，车道排和路名也在这一条里。所以 `strip` 的下沿要够到车道排（默认 16%），否则
车道会被切掉。这块位置就是 `HUD card crop top/bottom/left/right` 四个设置，写在 `crop.json` 的
`cardTop/cardBottom/cardLeft/cardRight` 里，解码器按它输出第二路（`cardW/cardH` 由 `HUD width` 定）。
`What the HUD shows` 为 `A piece of the map` 时该段不生效（`cardMode: "off"`）。

`HUD card:` 一行是判断依据：

| 显示 | 含义 |
|---|---|
| `turn card (full), 37 from demo, own socket` | 卡片正在出图，37 帧来自测试图案 |
| `turn card (full), 0 from carlife, decoder /dev/shm/carlife-map/hud.sock` | 选了实时画面但卡片流还没数据：看 `Cut:` 那行的卡片尺寸和 `Decode:` 的帧数 |
| `off (no HUD layer)` | 当前 target 不含 HUD，或 HUD 层没建起来 |
| `map 456x200 from the map, pan 0/0%` | 处于地图模式，可以再用 `Map in HUD` 两档平移 |

### HUD 一直是黑的：看那三行

HUD 层和仪表盘的地图是两回事：地图那层由车机自己画，HUD 那层交给**仪表**去画。所以
"仪表盘有画面、HUD 没有"不会报错，也不会黑屏——HUD 就是什么也不出现。状态页为此有三行：

```
HUD     : waiting idle/none [image, 1 swap]
HUD slot: hud 800x480: idle
HUD lyr : layer 4 video: waiting - the target is not shown
Refused : layer 5 video: video smaller than 64x32
```

- `HUD` 行：层的状态 + 目标的整体状态，方括号里是这层实际用的方式（`video` 或 `image`）和换过
  几次。`waiting` 长时间不动就是没上去。
- `HUD slot`：渲染器自己说的 HUD 目标状态。`idle` = 没人要这个槽；`waiting/stock` = 被车机自己
  占着；`parked behind stock` = 压不住原厂内容。
- `HUD lyr`：渲染器给这一层的原话，`waiting - ...` 后面就是原因；没有这一行说明层根本没建成。
- `Refused`：最近的拒绝，通常一句话就够定位（尺寸、内存、目标名）。

`HUD picture as` 默认 `Auto`：先用视频层（和地图同一条路），**视频层被拒（例如
`too many video buffers on the display`）或 6 秒没显示，就立刻改成一张 RGBA 图**再送一次。
两条路都是这台车验证过的——视频是 Maps-on-cluster 的做法，RGBA 图是本仓库另一个 HUD 应用
（Redline）的做法。状态页 `[image, 1 swap]` 就说明它换了第二条路并且正在用。想固定用哪一条，
把这一项设成 `A picture` 或 `Video`。

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

HUD 的卡片流是同一格式、另一个尺寸：480×168 时 `len = 480 * 252 = 120960`，
写在 `/dev/shm/carlife-map/hud.sock`。尺寸跟着 `HUD width` 变（480×168 是 86% 时的默认，
100% 就是 560×196），解码器按 `crop.json` 的 `cardW/cardH` 出图——这两个数由应用写，手改没有意义。

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
HUD 上等于什么都没有。现在 HUD 层有自己的 `vw/vh`，**转向卡片模式下来自第二路流**
（`hud.sock`，480×168 起）；只有退回地图模式时才用 `cropAtlas()` 从地图帧里裁一块。
HUD 层用 `class: 'overlay'`，压在原厂的 `content` 层之上。

**必须清楚的限制：**

- **CarLife 画面来源是本方案最大的未解决项。** CarLife 走私有协议（USB AOA /
  Wi-Fi），把手机界面编码成 H.264 送车机，车机端由百度的闭源库解码显示。
  本应用既没有实现 CarLife 协议，也没有从车机 CarLife 进程抓流——它需要一个外部
  帧源（手机截屏推流，或车机侧抓 H.264 再解码）。idrive-apps 对 CarPlay 的那套二进制
  补丁不能直接套用到 CarLife，因为协议栈完全不同。
- **投到 HUD 比投到仪表盘弱。** cluster-render 的 `hud_take_over_stock=0`，抢不过原厂
  HUD 导航引导；video 层没有逐像素 alpha，会盖住底下的宝马内容。所以本应用把画面
  限制在 HUD 可见窗口的安全区（约 x120–680 / y120–320），避开底部的速度/限速牌。
  也因为这块窗口只有约 560×200，HUD 上放的是 480×168 的转向卡片，而不是地图。
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
