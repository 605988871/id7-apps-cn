#!/usr/bin/env python3
"""
CarLife 抓包离线分析器（纯标准库，无需 scapy）

从 pcap 中提取 8240 视频流，按 CarLife 12 字节头 [len:4BE][ts:4BE][type:4BE=0x00020001]
拆帧，统计 NALU 类型与关键帧间隔，并导出 Annex B H.264 供 ffmpeg 验证。

用法:
    python analyze_pcap.py carlife-8240.pcap
    python analyze_pcap.py carlife-8240.pcap --dump video.h264
    python analyze_pcap.py carlife-8240.pcap --port 8240 --verbose
"""
import argparse
import struct
import sys
from collections import Counter

MSG_VIDEO_DATA = 0x00020001
NAL_NAMES = {1: "non-IDR", 5: "IDR", 6: "SEI", 7: "SPS", 8: "PPS", 9: "AUD"}


def read_pcap(path):
    """产出 (ts_sec, ts_usec, packet_bytes)。支持 classic pcap 大小端。"""
    with open(path, "rb") as f:
        gh = f.read(24)
        if len(gh) < 24:
            raise ValueError("pcap 太短")
        magic = gh[:4]
        if magic == b"\xd4\xc3\xb2\xa1":
            endian, nano = "<", False
        elif magic == b"\xa1\xb2\xc3\xd4":
            endian, nano = ">", False
        elif magic == b"\x4d\x3c\xb2\xa1":
            endian, nano = "<", True
        elif magic == b"\xa1\xb2\x3c\x4d":
            endian, nano = ">", True
        else:
            raise ValueError("未知 pcap magic: %r" % magic)
        linktype = struct.unpack(endian + "I", gh[20:24])[0]
        while True:
            ph = f.read(16)
            if len(ph) < 16:
                break
            ts_s, ts_u, caplen, origlen = struct.unpack(endian + "IIII", ph)
            data = f.read(caplen)
            if len(data) < caplen:
                break
            yield linktype, ts_s, ts_u, data


def ipv4_payload(pkt, linktype):
    """返回 (src, dst, sport, dport, tcp_payload, seq)。非 TCP/IPv4 返回 None。"""
    off = 0
    if linktype == 1:          # Ethernet
        if len(pkt) < 14:
            return None
        etype = struct.unpack("!H", pkt[12:14])[0]
        off = 14
        while etype in (0x8100, 0x88a8) and len(pkt) >= off + 4:  # VLAN
            etype = struct.unpack("!H", pkt[off + 2:off + 4])[0]
            off += 4
        if etype != 0x0800:
            return None
    elif linktype == 101:      # raw IP
        pass
    elif linktype == 113:      # Linux SLL
        if len(pkt) < 16:
            return None
        etype = struct.unpack("!H", pkt[14:16])[0]
        off = 16
        if etype != 0x0800:
            return None
    else:
        off = 14  # 尽力而为

    if len(pkt) < off + 20:
        return None
    ihl = (pkt[off] & 0x0F) * 4
    if ihl < 20 or pkt[off] >> 4 != 4:
        return None
    proto = pkt[off + 9]
    if proto != 6:             # 只关心 TCP
        return None
    src = ".".join(str(b) for b in pkt[off + 12:off + 16])
    dst = ".".join(str(b) for b in pkt[off + 16:off + 20])
    t = off + ihl
    if len(pkt) < t + 20:
        return None
    sport, dport = struct.unpack("!HH", pkt[t:t + 4])
    seq = struct.unpack("!I", pkt[t + 4:t + 8])[0]
    doff = (pkt[t + 12] >> 4) * 4
    if doff < 20:
        return None
    payload = pkt[t + doff:]
    return src, dst, sport, dport, seq, payload


def nalu_types(au):
    """统计一个 access unit 里的 NALU 类型。"""
    parts = [p for p in __import__("re").split(b"\x00\x00\x00?\x01", au) if p]
    out = []
    for p in parts:
        if p:
            out.append(p[0] & 0x1F)
    return out


def reassemble_stream(segments):
    """
    segments: list of (seq, bytes)，按 TCP(seq+len) 排序去重，输出连续字节流。
    简化处理：不做回绕，只按 seq 升序拼接重叠部分。
    """
    segs = sorted(segments, key=lambda x: x[0])
    if not segs:
        return b""
    out = bytearray()
    next_seq = segs[0][0]
    for seq, data in segs:
        if seq > next_seq:
            # 缺包：插入占位（无法恢复，标记为 0）
            out.extend(b"\x00" * (seq - next_seq))
            next_seq = seq
        if seq < next_seq:
            skip = next_seq - seq
            if skip >= len(data):
                continue
            data = data[skip:]
        out.extend(data)
        next_seq = seq + len(data)
    return bytes(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("pcap")
    ap.add_argument("--port", type=int, default=8240)
    ap.add_argument("--dump", help="导出 Annex B H.264 到文件")
    ap.add_argument("--verbose", action="store_true")
    args = ap.parse_args()

    # 收集: key=(src,sport,dst,dport) -> list of (seq, payload)
    streams = {}
    pkts = 0
    for linktype, ts_s, ts_u, pkt in read_pcap(args.pcap):
        pkts += 1
        r = ipv4_payload(pkt, linktype)
        if not r:
            continue
        src, dst, sport, dport, seq, payload = r
        if args.port not in (sport, dport) or not payload:
            continue
        # 只看数据从手机(源端口=8240)发往车机方向
        if sport != args.port:
            continue
        key = (src, sport, dst, dport)
        streams.setdefault(key, []).append((seq, payload))

    print("pcap 包数:", pkts)
    print("匹配视频流:", len(streams))
    if not streams:
        print("!! 没有找到端口 %d 的数据。可能：抓错网卡 / 端口不同 / CarLife 是 WiFi Direct 非标准 IP" % args.port)
        sys.exit(2)

    for key, segs in streams.items():
        src, sport, dst, dport = key
        print("\n=== 流 %s:%d -> %s:%d  段数=%d ===" % (src, sport, dst, dport, len(segs)))
        stream = reassemble_stream(segs)
        print("重组字节:", len(stream))

        frames = []
        pos = 0
        bad = 0
        while pos + 12 <= len(stream):
            length, ts, mtype = struct.unpack(">III", stream[pos:pos + 12])
            if mtype != MSG_VIDEO_DATA or not (0 < length <= 8 * 1024 * 1024):
                bad += 1
                pos += 1
                if bad > 64 and not args.verbose:
                    print("头部对齐失败过多，尝试从下一个 12 字节头重新同步...")
                    # 暴力找下一个合法头
                    found = False
                    for i in range(pos, min(pos + 4096, len(stream) - 12)):
                        l, t, ty = struct.unpack(">III", stream[i:i + 12])
                        if ty == MSG_VIDEO_DATA and 0 < l <= 8 * 1024 * 1024:
                            pos = i
                            found = True
                            break
                    if not found:
                        break
                continue
            if pos + 12 + length > len(stream):
                break
            frames.append((ts, stream[pos + 12:pos + 12 + length]))
            pos += 12 + length

        print("解出视频帧:", len(frames))
        if not frames:
            print("!! 12 字节头未匹配。打印前 64 字节 hex 供人工判断:")
            print("   ", stream[:64].hex())
            continue

        nalu_counter = Counter()
        idr_ts = []
        for i, (ts, au) in enumerate(frames):
            types = nalu_types(au)
            nalu_counter.update(types)
            if 5 in types:
                idr_ts.append(ts)
            if args.verbose and i < 10:
                print("  frame %d ts=%d size=%d NAL=%s" % (
                    i, ts, len(au), [NAL_NAMES.get(t, str(t)) for t in types]))

        print("NALU 统计:", {NAL_NAMES.get(k, str(k)): v for k, v in nalu_counter.items()})
        if len(idr_ts) >= 2:
            # timestamp 低32位毫秒，回绕处理
            gaps = []
            for a, b in zip(idr_ts, idr_ts[1:]):
                d = (b - a) & 0xFFFFFFFF
                gaps.append(d)
            print("IDR 关键帧数:", len(idr_ts), " 间隔(ms) min/median/max:",
                  min(gaps), sorted(gaps)[len(gaps) // 2], max(gaps))
        elif idr_ts:
            print("IDR 关键帧数: 1  (无法算间隔)")
        else:
            print("!! 没有 IDR 关键帧 —— 可能抓包开始时连接已建立（错过首帧），请【先抓后连】重抓")

        if args.dump:
            with open(args.dump, "wb") as out:
                for _, au in frames:
                    out.write(au)
            print("已导出 Annex B H.264 ->", args.dump)
            print("验证命令: ffprobe -f h264 -i %s" % args.dump)


if __name__ == "__main__":
    main()
