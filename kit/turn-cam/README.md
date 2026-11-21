# turn-cam

转向影像的两个后台程序：把车载摄像头的 H.264 从 AVB 总线上接下来（`turn-cam`），再解成仪表盘
地图区域那一块画面（`turn-decode`）。随「转向影像」应用一同安装，本身不请求摄像头。

## 为什么是这样拆的

原厂摄像头只有**在被请求之后**才推流，而且流不在设备节点上，在 AVB 媒体总线上：

| 要做的事 | 只能在哪做 | 这个仓库的选择 |
|---|---|---|
| 请求视角（attach + changeState） | 应用进程（SOME/IP 代理只有那儿有） | `apps/cn_turn_view/camreq.js` |
| 接住 AVB 上的 H.264 | C（回调在 AVB 桥的线程上） | `turn-cam` |
| 解码 + 缩放成 4:2:0 atlas | C（每帧 783 KB，JS 搬不动） | `turn-decode` |
| 上屏 | 应用进程（cluster-render 客户端） | `apps/cn_turn_view/main.js` |

`turn-cam` 刻意**不**请求摄像头。请求要复刻摄像头 ECU 的状态机（attach、changeState、备用视图、
泊车视图避让），那一套在应用里是 JS，改一行不用重编；写在 C 里就是第二份要同步的逻辑。

## 两个程序

### turn-cam

```
dlopen("libias-media_transport-avb_ufipc_bridge.so.1")
  ias_avbbridge_create_receiver("turncam.<pid>", "media_transport.avb_streaming.1")
  ias_avbbridge_register_H264_cb(handle, on_packet, NULL)
```

每个回调是一整个 RTP 包，交给 `src/rtp_h264.c` 拆：

| 情况 | 处理 |
|---|---|
| 单 NAL（type 1–23） | 直接输出 |
| STAP-A（24） | 逐个拆出 |
| FU-A（28） | 收齐分片再输出，首字节 = FU indicator 的 F/NRI + FU header 的 type |
| STAP-B / MTAP / FU-B（25/26/27/29） | 丢弃并计数（摄像头不用交错模式） |
| 序号跳变 | 丢掉半个 FU，`gaps` / `lost` 各加一 |
| 不是该流的包（payload type ≠ 96） | 丢弃并计入 `not RTP/H.264` |

输出是 Annex B（`00 00 00 01` + NAL），写进 `/dev/shm/turn-view/h264.sock`。

**写 socket 是全有或全无**：`send()` 只写了一半时立刻关掉这条连接，让解码器在下一个关键帧重新
同步。半个 NAL 留在流里，下一个起始码就落在错的位置上，屏幕上是一片马赛克——比起丢一个 NAL，
这更糟。

### turn-decode

从同目录的 `src/decode.c` 编出来，跑的时候带 `--dir /dev/shm/turn-view`：

- 监听 `h264.sock`（`turn-cam` 连上来）
- 用主机自己的 Intel MSDK（`libmfxhw64.so`，dlopen）解码
- 按 `crop.json` 缩放/裁切，默认 1088×480，4:2:0 分平面（Y 后面整块 U，再整块 V）
- 交给监听 `live.sock` 的那一方（应用）

`--dir` 的意义：两个应用各有自己的 socket 目录、`crop.json` 和报告，谁先启动都不影响另一边。
报告名字由目录名推出来，所以这里写的是 `/dev/shm/turn-view-decode.txt`。

**为什么解码器放在这个组件里**：不然装「转向影像」就得先装一整套取流工具（预加载库、unit、
安装脚本），只为借一个 34 KB 的解码器。源码只有一份（`src/decode.c`），
`test/component_test.py` 会核对 `turn-decode` 是不是用这份源码编的：源码里改过默认目录而没
重编，二进制就还指着旧目录，这是车上唯一看不出来的漂移。

## 文件与服务

| 文件 | 作用 |
|---|---|
| `/dev/shm/turn-view/h264.sock` | `turn-cam` → `turn-decode`，Annex B |
| `/dev/shm/turn-view/live.sock` | `turn-decode` → 应用，CLMF 帧（12 字节头 + atlas） |
| `/dev/shm/turn-view/crop.json` | 应用写的裁切参数（整幅、保持比例、无 HUD 卡片） |
| `/dev/shm/turn-view/turn-cam.txt` | 每秒一份：状态、包数/秒、NAL 数、丢包 |
| `/dev/shm/turn-view-decode.txt` | 解码器每秒一份：状态、输入字节、帧数、原因 |
| `/dev/shm/turn-cam-boot.txt` | 安装时的自检记录（两个程序能不能在本机跑起来、两个 unit 起没起来） |

`turn-decode.service` 先起（`turn-cam` 连的是它的 socket，反了也只是多等一秒），两个都是
`Restart=always` + `StartLimitIntervalSec=0`：一个安静退出的解码器在车上表现成"仪表盘黑的"，
没有任何界面会说原因。

`/dev/shm/turn-view` 必须是 `0777`：解码器以 root 监听，应用以自己的身份 `listen(live.sock)`，
目录不可写就 `EACCES`，读起来像"地址已占用"。`install.sh` 和 `turn-decode` 自己都会补这一下。

## 编译

```sh
./build-zig.sh                 # 两个都编
./build-zig.sh cam             # 只编 turn-cam
./build-zig.sh decode          # 只编 turn-decode（用 src/decode.c）
ZIG=/d/zig/zig-x86_64-windows-0.14.1/zig.exe ./build-zig.sh
```

目标是 `x86_64-linux-gnu.2.27`，并且显式指定 loader `/lib/ld-linux-x86-64.so.2`——主机没有
`/lib64`，用 zig 的默认值会得到一个"文件在、有执行位、`execve` 还是 ENOENT"的产物，systemd
只会说 `Failed at step EXEC spawning`。`check_elf.py` 会在任何一项不满足时报错退出。

## 测试

```sh
# RTP 拆包：单 NAL / STAP-A / FU-A / 中途加入 / 序号跳变 / 外来流 / 头字段
zig cc -I../src -o test_rtp.exe test/test_rtp.c ../src/rtp_h264.c && ./test_rtp.exe

# 组件清单：字段、载荷、unit、钩子、应用的版本要求、两份解码器是否一致、四处路径是否对齐
python3 test/component_test.py
```

应用那一侧的端到端（转向灯 → 请求 → 图层 → 帧 → 收起）在 `kit/tools/test_turn_view.js`。

## 已知边界

- 只有一种流名（`media_transport.avb_streaming.1`），换车/换配置可以用 `--stream` 覆盖。
- 只拆 RTP 里的 H.264：摄像头若改推 H.265 或 MPEG-TS，这里不会假装能读，`not RTP/H.264` 会一直涨。
- 不请求摄像头，所以"没有画面"的一半原因在应用那一侧（见应用 README 的上车验证顺序）。
