# CarLife 无线投屏（cn_carlife_wireless）

把手机百度 CarLife 的**完整画面**通过 WiFi 热点投到 iDrive 7/8 中控屏，并支持触摸回传。

## 和旧方案的区别

旧方案走 USB AOA：伪装成 USB 设备把数据喂给原车 `carlife` 进程。这台车上会导致车机重启，已放弃并回滚。

本方案**完全不碰原车 CarLife、不碰 USB**：
- 手机开热点，运行百度 CarLife（不是 vivo 智能车载，不需要蓝牙配对）
- **在本应用内直接扫描并连上该热点**（复用 `mgu-uplink`，不用先打开 MGU 商店；见下）
- 一个独立的原生链路连到手机的 6 个 TCP 端口，握手、取 H.264 流、解码、显示
- 原车 `carlife` 进程始终没有被触碰

## 在应用内连热点：复用 MGU Store 的 mgu-uplink（关键）

连热点这一步不用重复造轮子：MGU Store 的「设置 → Wi-Fi」页面背后的
`mgu-uplink` 已经解决了 iDrive 7 上最棘手的部分——

- iDrive 7 的 BCM4359 芯片只有 `wlan0` 一个 station 接口，车的
  `wpa_supplicant` 用它挂热点和无线 CarPlay。`mgu-uplink` 通过 D-Bus 在这个
  接口上 `AddNetwork`（标记 `id_str=mgu-uplink`）加入手机热点，**不打断原车
  热点和无线 CarPlay**，网络只在内存里、退出即移除。
- 它把连上后的租约写到 `/run/mgu-uplink/lease.json`，其中 `router` 就是热
  点网关（= 手机 IP）。本组件的 `run.sh` 直接读这个值，**不需要手填 IP**。
- 它的防火墙只允许白名单 uid 从 WiFi 接口发包，root 永远不在白名单里。
  因此 `carlife-link` 用 `--drop-uid 65534` 在二进制内降到该 uid，
  `component.json` 用 `internet:true` + `uids:[65534]` 让 Store 把该 uid 加进
  白名单（写入 `/var/opt/mgu-uplink/uids.d/carlife-wireless`）。解码器不联网，
  保持 root 以用车的 MSDK/GPU。

**但 Store 的 Wi-Fi 页不能直接从别的 app 调用**：`ctl.sock` 是 0600 root-only，
而 updater 只把 Wi-Fi 请求转发给 Store app（要它的 secret）。因此本组件带了
一个 root 常驻的 `wifi-bridge`：它监听 `/dev/shm/carlife-wireless/wifi.sock`
（0660，`tm_oap_app` 组），只放行 `wifi-enable / wifi-5ghz / wifi-scan /
wifi-connect / wifi-forget` 五个操作，原样转发到 uplink 的 `ctl.sock`。
`prefer`、`usb-phone` 会动到原车连接优先级，刻意不暴露。

app 的「连热点」页读公开的 `/run/mgu-uplink/status.json` 拿扫描结果，密码优
先用车机原生键盘（与 Store 同一个 SOME/IP speller）输入，取不到时用「设置 →
热点密码」里预填的值。连上手机热点后 `lease.json` 的 `router` 就是手机 IP，
取流服务自动读取，不用填地址。

前提：车机已装 MGU Store 且 `mgu-uplink` 组件在运行。未满足时仍可在 app
设置里手填手机 IP 作为回退，但需车机另有可用的 WiFi 客户端连接。Store 的
「设置 → Wi-Fi」页始终可用，作为本应用内连接失败时的第二条路。

## 可行性：已在 PC 上用真机验证（2026-11-23）

| 环节 | 结果 |
|---|---|
| 手机热点上 6 个 CarLife 端口 | 7240/8240/9240/9241/9242/9340 **全开** |
| 版本握手 | cmd 7240 返回 `MATCH_STATUS status=1`（手机接受车机身份） |
| H.264 取流 | 20 秒收到 287 帧 / 2.2 MB，SPS/PPS/IDR 齐全 |
| 画面 | 解码后确认是完整 CarLife 界面（地图 + 音乐卡 + 语音卡），颜色正确 |
| 显示链路 | CLMF → CarlifeSource → toRgba → RGBA 用真实帧验证，画面与原图一致 |

## 组成

| 组件 | 作用 |
|---|---|
| `kit/carlife-wireless/carlife-link` | 连手机 6 端口、握手、收 H.264，裸流写到 stdout |
| `kit/carlife-wireless/carlife-decode` | 从 stdin 读流，用车的 Intel MSDK 硬解，输出 CLMF 帧到 unix socket |
| `kit/carlife-wireless/run.sh` | 把上面两个用管道串起来，任一退出则整组重启 |
| `kit/carlife-wireless/carlife-wireless.service` | systemd 常驻，未连手机时循环重试 |
| `kit/carlife-wireless/wifi-bridge` | root 代理：app 的 Wi-Fi 请求 → mgu-uplink 的 root-only socket |
| `kit/carlife-wireless/carlife-wifi.service` | 独立的常驻 unit：未连热点时也能从 app 连 |
| `apps/cn_carlife_wireless/wifi_page.js` | 应用内「连热点」页：扫描、选网、密码、连接状态 |
| `apps/cn_carlife_wireless/` | JS app：读帧 → 显示到中控屏 → 触摸回传 |

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
2. 打开「CarLife 无线投屏」应用，点右上角**「连热点」**
   - 第一次：点「开启 Wi-Fi」→「扫描」→ 点手机热点名称 → 用车机键盘输密码
   - 已经连过（已保存网络）：直接点热点名称即可，不用再输密码
   - 键盘调不出来时：在「设置 → 热点密码」预填密码后再点热点
3. 连接成功后应用自动回到画面；service 从 `lease.json` 读到手机 IP，自动连手机取流
4. 画面出现后，触摸中控屏即可操作手机 CarLife

> 也可以在 **MGU 商店 → 设置 → Wi-Fi** 连热点，效果完全相同。回退：若车机未装
> `mgu-uplink`，可在 app「设置 → 手机热点地址」手填手机 IP，写到
> `/dev/shm/carlife-wireless/host`；但前提是车机此时已有其它方式连上该热点。

## 上车验证清单（按成本从低到高）

**第一步：mgu-uplink 是否存在、Wi-Fi 是否连上（决定整个方案是否成立）**
```sh
cat /run/mgu-uplink/status.json     # wifi.link 应为 online/connected，wifi.ssid 是手机热点
cat /run/mgu-uplink/lease.json      # router = 手机 IP；run.sh 就是读这里
cat /var/opt/mgu-uplink/uids.d/carlife-wireless   # 应为 65534（Store 安装的白名单）
```
- 在车机 UI 上：本应用右上角「连热点」能看到手机热点、点它输密码、状态变「已连接」
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
cat /dev/shm/carlife-wireless/link.txt          # 看 state / match / frames
cat /dev/shm/carlife-wireless-decode.txt        # 看 frames / in bytes / error
```

- `link.txt`: `state: streaming`、`match: yes`、`frames` 增长 → 取流成功
- `decode.txt`: `frames` 增长、`errors: 0` → 解码成功

**第四步：画面**
打开应用，应显示完整 CarLife 画面。若黑屏，先看上面两个报告，不要猜。

## 已知限制（第一阶段）

- **无音频**：CarLife 的音频走独立通道，车机音频被 Cinemo 独占。音频/通话后续版本处理（可能需要蓝牙 A2DP）。
- **触摸**：已实现归一化坐标回传，但映射精度需上车实测校准。
- **车型**：解码依赖车机自带的 Intel MSDK 2017（`libmfxhw64.so` API 1.24）+ libva；若车型不同可能缺失（install.sh 的 selftest 会报告）。
- **网络白名单依赖 mgu-uplink**：`carlife-link` 降到 uid 65534 才能从车机 WiFi 发包；这依赖 Store 在装本组件时写好 `uids.d/carlife-wireless`。若白名单没写进去，link 会连不上手机——按上面"第一步"检查该文件。
- **未推送**：代码在本地，尚未提交/推送 git，等上车验证通过后再定。

##  desk 回归测试（PC，不需要车）

```bash
# 协议层：握手字节、6 通道、触摸编码、车机 ABI
python3 kit/carlife-wireless/link/test/test_link.py
# 解码几何：裁剪/尺寸/色度布局（含 1920x1080 全画面）
python3 kit/carlife-wireless/decode_math_test.py
# 应用内连热点：桥接白名单、请求协议、版本一致
python3 kit/carlife-wireless/wifi_test.py
# 显示链路（需先用 ffmpeg 从真实 h264 导出一帧）
node apps/cn_carlife_wireless/test/test_display.js <frame720_nv12.yuv>
```
