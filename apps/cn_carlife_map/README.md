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
2. MGU Store 里安装 **Cluster renderer**（源 `robertnisipeanu/idrive-apps`，组件 id `cluster-render`）。
   没装的话本应用能启动，但 Render 一栏会一直是空的，仪表/HUD 不会出现画面。
3. 想投 HUD 的车需要有 HUD；HUD 上仅中间一块区域可见，用设置里的位置和尺寸微调。
4. 一个能提供画面的帧源；第一次先用 **Demo (test picture)** 验证。

## 安装

```sh
python3 kit/tools/build.py cn_carlife_map
```

产出 `dist/cn_carlife_map@1.0.0.tgz` / `.mgu`，用 mgu-store 或 `deploy/push-to-car.sh` 安装。
应用默认自启动（`autostart: true`），装完重启一次车机即可。

版本号必须提升才能让车机端 mgu-deploy 真正重装（它按版本号判断 `current`）。

## 设置

| 设置 | 说明 |
|---|---|
| Show map on | Off / 仅仪表 / 仅 HUD / 仪表和 HUD |
| Picture source | Demo 测试画面 / TCP 网络 / 本地管道 FIFO |
| Frame rate | 5–30 fps。地图变化慢，15 fps 通常够，也能减轻簇的上传负担 |
| HUD width / left-right / up-down | HUD 画面尺寸和位置，用测试画面在车上对齐 |
| HUD on top of alerts | HUD 是否压在宝马自己的提示框之上；默认让位 |

应用状态页会显示：当前帧源、cluster-render 连接状态、map/HUD 层的状态、累计帧数和帧序号。
`waiting` 表示层已建好但在等槽位或等第一帧；`shown` 表示已上屏。

## 帧源

### Demo（默认）

应用在车机上直接生成滚动的测试地图图案（写 YUV atlas，不做 RGB 转换）。用于确认
cluster-render、槽位、HUD 位置都正常，不依赖任何外部程序。

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

应用通过 `kit/runtime/hud_claim.js` 在 `/dev/shm/mgu-hud/cn_carlife_map` 留下占用标记，
每 2 秒刷新；与其他会画 HUD 的应用（例如 Redline、Cluster functions）互相让位。
关掉"Show map on"或切到仅仪表时会释放。

## 已知限制

- 只支持 iDrive 7 的 `map` / `hud` target；cluster-render 必须在场。
- 视频层全局最多 8 个，每车最多 2 个在显示；本应用占 1 或 2 个。
- HUD 上宝马的弹窗、警告等由 cluster-render 仲裁；`HUD on top of alerts` 打开才会压过去。
- 没有实现 CarLife 协议本身，也没有从车机 CarLife 进程抓流的能力。
- 牌照/临时文件：帧源配置在应用数据目录，不随应用包走。
