# 手机画面桥接（PC 当中间人）

在写安卓 App 之前，先用 PC 回答两个问题：

1. **不裁的地图，在仪表上是什么样？** 裁剪这件事可以搬到"坐标已知、没有状态栏"的一侧去做，
   或者干脆不做，只缩放。
2. **车机 Wi‑Fi 能不能扛原始帧？** 能扛，车机就**不需要解码器**——应用的 TCP 帧源本来就吃
   NV12，这也正是 `kit/tools/carlife_frame_sender.py` 用的格式。

这个工具**不往车机装任何东西**。

```
手机屏幕 ──adb/screenrecord──▶ PC: ffmpeg 解码 → 裁剪 → 缩到 1088×480
                                            │
                                            ▼  TCP + CLMF 帧头
                              车机上的 CarLife Map（Picture source = Network (TCP)）
                                            │
                                            ▼
                                  cluster-render → 仪表 / HUD
```

## 准备

| 位置 | 要什么 |
|---|---|
| PC | `adb`（Android platform-tools）、`ffmpeg`。Windows：`winget install Google.PlatformTools` 与 `winget install Gyan.FFmpeg` |
| 手机 | 开发者选项 → USB 调试。vivo/iQOO 还要打开 **"USB 调试（安全设置）"**，否则 `screenrecord` 会被拒 |
| 车机 | 应用里 `Picture source = Network (TCP)`；应用数据目录写 `carlife.json`：`{"tcpListen": true}` |
| 网络 | PC 与车机同一网段（车机开热点或都连同一个路由） |

应用的 TCP 源默认是 `0.0.0.0:20558` 监听（`tcpListen: true` 时），PC 直接往车机 IP 推即可。

## 三步

```sh
# 1. 看设备、屏幕、显示列表、带宽表
python tools/phone-bridge/bridge.py probe

# 2. 不用手机，先用一段录屏验证管道（顺便导出一帧看看构图）
python tools/phone-bridge/bridge.py file clip.mp4 --host 192.168.1.50 --preview first.bmp

# 3. 真机实时
python tools/phone-bridge/bridge.py run --host 192.168.1.50 \
       --crop 1080x2280+0+330 --fps 10 --preview first.bmp
```

`--preview` 会把第一帧写成 BMP（只取 Y 平面，够看构图），**不用上车就知道会投出什么**。

## `--fit` 三选一：这就是本次实验的内容

| 值 | 行为 | 用来回答 |
|---|---|---|
| `cover`（默认） | 填满 1088×480，多出来的切掉 | 和现在车机侧裁的效果差多少 |
| `fit` | 整块缩进去，两侧留黑边，一点不丢 | 不裁的代价是不是可以接受 |
| `squash` | 直接压进去，比例失真 | 只验证管道，不看画质 |

`--crop WxH+X+Y` 在缩放**之前**执行。注意：这是**在手机上裁**——坐标固定、没有车机状态栏和按钮，
和"从车机镜像里裁一块"不是一回事。这正是那位博主的做法里最容易被忽略的一层。

## 带宽：算清楚再上车

一帧 NV12 = 1088 × 720 = **783 360 字节（765 KB）**，没有压缩。

| 帧率 | 每秒 | 折算 |
|---|---|---|
| 5 fps | 3.9 MB/s | 31 Mbit/s |
| 10 fps | 7.8 MB/s | 63 Mbit/s |
| 15 fps | 11.7 MB/s | 94 Mbit/s |
| 20 fps | 15.7 MB/s | 125 Mbit/s |

2.4 GHz 实际能到 100–300 Mbit/s，但车机的 Wi‑Fi 模块和手机热点都是变量。**从 10 fps 起步**，
状态页的 `Frames` 涨不涨、涨得稳不稳就是答案。抖动大就往下调，不要往上试。

想省带宽只有一条路：手机端编码（MediaCodec），车机端解码——但车机现在**没有解码器**，
这也是为什么先用原始帧做验证。

## 会不会看到"只有地图"

**默认抓的是手机当前屏幕，不是车机屏幕。** 如果手机上显示的就是导航界面，仪表上看到的就是它。

`probe` 会打印手机的显示列表。如果 Jovi in Car 之类的互联方案自己开了一块虚拟显示，用
`--display-id N` 抓那块——那才是"车机那块屏"的内容，而不是手机主屏。

两样都不成立时只有 `--crop` 一条路；但那已经是"在手机上裁"，和车机侧裁的差别在于
**手机知道布局**，坐标不会因为分辨率、状态栏、弹窗而漂移。

## 已知限制

- `screenrecord` 单次最长 180 秒，工具按 170 秒重启一次，**中间会断约 1 秒**。这是用系统录制器
  而不是自建 App 的代价。
- `screenrecord` 抓不到安全表面（银行、DRM 视频），导航不受影响。
- 原始帧没有重传也没有压缩：Wi‑Fi 抖一下就丢帧，表现为画面一顿一顿，不是花屏。
- 这个工具只搬画面，不搬音频和触摸。

## 自检（没有手机、没有车机也能跑）

```sh
python tools/phone-bridge/bridge.py selftest   # 帧格式：magic/长度/序号/完整性
node tools/phone-bridge/test_wire.js           # 用应用真实的解析器验同一件事
```

`test_wire.js` 直接 `require` 应用的 `carlife_source.js`，把帧切成 64 KB 和 7 字节两种粒度喂进去，
确认帧数、长度、序号都对；并测出解析一帧的耗时（本机 0.8 ms，10 fps 有 100 ms 可用）。
这条链路最容易出的错是"头部字段错一位"——套接字看着是通的，画面永远是黑屏。
