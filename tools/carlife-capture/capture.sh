#!/bin/sh
# CarLife 视频流抓包（旁路，只读，不碰 CarLife 进程/连接）
# 必须先运行本脚本开始抓包，再在车机上启动 CarLife 连接（保证拿到首帧 SPS/PPS/IDR）
#
# 用法:
#   sh capture.sh 60              # 抓 60 秒到 /tmp/carlife-8240.pcap
#   sh capture.sh 0 eth0          # 一直抓到 Ctrl-C，指定网卡
#   IFACE=auto DURATION=90 sh capture.sh
#
DURATION=${1:-60}
IFACE=${2:-${IFACE:-auto}}

echo "=== CarLife capture ==="

# 1. 找 tcpdump
TD=$(command -v tcpdump 2>/dev/null)
if [ -z "$TD" ]; then
  echo "ERROR: tcpdump 不存在。请先安装静态 tcpdump 到 /usr/sbin/tcpdump。"
  echo "       二进制放在本脚本同目录，用: cp tcpdump /usr/sbin/ && chmod +x /usr/sbin/tcpdump"
  exit 1
fi

# 2. 找网卡
if [ "$IFACE" = "auto" ]; then
  IFACE=$(ip -o link show 2>/dev/null | sed -n 's/^[0-9]*: \([^:@]*\)[@:].*/\1/p' | grep -E '^p2p-|^wlan' | head -1)
  if [ -z "$IFACE" ]; then
    IFACE=$(ip -o link show 2>/dev/null | sed -n 's/^[0-9]*: \([^:@]*\)[@:].*/\1/p' | grep -vE '^lo$|^eth0$' | head -1)
  fi
  echo "AUTO iface = $IFACE"
fi
[ -z "$IFACE" ] && { echo "ERROR: 找不到网卡，请用第二个参数指定，如: sh capture.sh 60 p2p-dev-wlan0"; exit 1; }

OUT=/tmp/carlife-8240.pcap
echo "iface=$IFACE  duration=${DURATION}s  out=$OUT"
echo "现在请【开始抓包后】在车机上启动 CarLife 连接（先抓后连，否则拿不到关键帧）"
echo "抓 3 秒后开始连接比较稳妥。"

# 3. 抓包：只抓 8240 端口，禁名称解析，snaplen 262144
if [ "$DURATION" = "0" ]; then
  exec "$TD" -i "$IFACE" -s 262144 -nn -w "$OUT" 'tcp port 8240 or tcp port 7240'
else
  exec "$TD" -i "$IFACE" -s 262144 -nn -w "$OUT" -C 32 -W 4 'tcp port 8240 or tcp port 7240' &
  TD_PID=$!
  echo "抓包 PID=$TD_PID，${DURATION} 秒后自动停止..."
  sleep "$DURATION"
  kill -INT "$TD_PID" 2>/dev/null
  sleep 1
  echo "抓包结束: $OUT"
  ls -lh "$OUT"*
fi
