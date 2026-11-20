# CarLife 车机侧抓流工具

目标：在已 root 的 BMW MGU 上拿到手机发来的 CarLife H.264 视频流，为下一步
"解码成 NV12 → 送仪表盘/HUD"提供真实样本和协议验证。

**当前阶段只做零风险的旁路抓包**，不碰 CarLife 进程、不改防火墙、不改二进制。
抓包验证通过后，再实现实时透明代理（方案 B）。

## 背景：已确认的协议事实

来自 `CarLink-Lab`（github.com/Zmandy/CarLink-Lab）逆向工程：

- 手机是 TCP **服务端**，监听 `7240`(control) / `8240`(video) / `9240`(media) / `9340`(touch)
- 车机 MGU 作为**客户端**主动连手机；无线模式下车机是 P2P GO（热点），手机是 STA
- 视频是**明文 Annex B H.264**，无加密无校验，12 字节头：

  ```
  [u32 len 大端][u32 timestamp 毫秒低32位 大端][u32 type=0x00020001 大端][len 字节 H.264]
  ```

- SPS/PPS 拼在 IDR 帧里一起发，没有独立消息
- **关键约束**：手机只在流开始时发 SPS/PPS/IDR，所以必须**先开始抓包，再连接 CarLife**，
  否则拿到流也解不出画面

## 第一步：车机环境探测

```bash
ssh root@<车机IP> 'sh -s' < probe.sh
```

结果同时存到车机 `/tmp/carlife-probe.txt`。重点看这几项：

| 探测项 | 为什么重要 |
|---|---|
| 1. CarLife 进程 | 拿到进程名/uid，后续 hook 或 uid 放行要用 |
| 3-5. 端口/连接 | 确认真实视频端口是不是 8240，对端手机 IP |
| 6-7. 网卡 | 确认 `p2p-*` 网卡名，抓包要指定 |
| 10. 工具 | tcpdump / nft / ffmpeg 是否可用 |
| 11. 解码硬件 | `/dev/dri/renderD128` 与 libmfx/libva 是否在（决定能否用 MSDK 解码） |

## 第二步：抓包

把 `capture.sh` 和**静态 tcpdump 二进制**放到车机（若探测发现已有 tcpdump 则跳过）：

```bash
scp capture.sh root@<车机IP>:/tmp/
# 若车机没有 tcpdump：scp 静态 tcpdump 到 /usr/sbin/ 并 chmod +x

ssh root@<车机IP>
sh /tmp/capture.sh 60          # 抓 60 秒
```

脚本会自动选 `p2p-*` 网卡。**运行后立即在车机上启动 CarLife 连接**（先抓后连）。
抓完得到 `/tmp/carlife-8240.pcap`，拷回 PC：

```bash
scp root@<车机IP>:/tmp/carlife-8240.pcap .
```

## 第三步：离线分析（在 PC 上，纯 Python 无需装库）

```bash
python analyze_pcap.py carlife-8240.pcap --dump video.h264 --verbose
```

判读输出：

- `解出视频帧: N` —— N 明显 >0 且能识别 NALU，说明协议假设成立
- `NALU 统计` 里有 `SPS/PPS/IDR` —— 抓到了首帧，样本可用
- `IDR 关键帧间隔` —— 决定实时方案的缓冲策略（通常 1-2 秒）
- 若 `没有找到端口 8240 的数据` —— 端口不同或抓错网卡，回到探测结果核对
- 若 `12 字节头未匹配` —— 打印的前 64 字节 hex 发我，人工判断真实头结构

导出的 `video.h264` 可直接验证画面：

```bash
ffprobe -f h264 -i video.h264
ffmpeg -f h264 -i video.h264 -frames:v 1 frame.png    # 抽一帧看是不是导航画面
```

## 自测状态

分析器已用合成 pcap 自测通过：TCP 分片重组、12 字节头拆帧、NALU 类型识别
（SPS/PPS/IDR/non-IDR）均正确。

## 下一步（拿到真实 pcap 后）

协议确认后实现实时方案 B：

1. nftables `nat output` REDIRECT，把车机发往手机 8240 的连接重定向到本地代理
2. 代理用 `SO_ORIGINAL_DST` 拿原目标，双向转发，**复制手机→车机方向的字节**一份给解码器
3. 复用 `idrive-apps/native/waze-on-cluster/src/decoder_msdk.cpp` 解 H.264 成 NV12
4. 打包成 CLMF 帧（`[magic][len][seq][atlas]`）送 `cn_carlife_map` 的 TCP 源（端口 20558）
5. 做成 `kind:"tool"` 组件，`requires: cluster-render`，root systemd 服务运行

这条路不碰百度闭源二进制，nft 表可整表删除秒级回滚，是目前风险最低的实时方案。
