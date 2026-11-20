#!/bin/sh
# CarLife 环境探测（只读，不改车机任何状态）
# 用法: ssh root@<车机IP> 'sh -s' < probe.sh
# 输出: /tmp/carlife-probe.txt 并打印到屏幕

OUT=/tmp/carlife-probe.txt
exec 2>&1 | tee "$OUT"

echo "===== CarLife PROBE $(date) ====="
echo "HOST: $(uname -n)  KERNEL: $(uname -r)  ARCH: $(uname -m)"

sec() { echo; echo "----- $1 -----"; }

sec "1. CarLife 相关进程"
ps -ef 2>/dev/null | grep -iE 'carlife|baidu|apollo|welink|mirror|projection|aapd|carplay' | grep -v grep || echo "(none matched)"

sec "2. 全部进程（前 80，含 uid）"
ps -eo user,pid,ppid,comm,args 2>/dev/null | head -80

sec "3. 监听端口"
(netstat -tulpn 2>/dev/null || ss -tulpn 2>/dev/null) | head -60 || echo "(no netstat/ss)"

sec "4. 活动 TCP 连接（重点看 7240/8240/9240/9340）"
{ netstat -tnp 2>/dev/null || ss -tnp 2>/dev/null; } | grep -E '7240|8240|9240|9241|9242|9340|ESTABLISHED' | head -40 || echo "(none)"

sec "5. /proc/net/tcp 中上述端口（hex: 7240=1C48 8240=2030 9240=2418 9340=247C）"
awk 'NR==1 || $2 ~ /:1C48$|:2030$|:2418$|:247C$/ || $3 ~ /:1C48$|:2030$|:2418$|:247C$/' /proc/net/tcp /proc/net/tcp6 2>/dev/null || echo "(unreadable)"

sec "6. 网络接口"
(ip -br addr 2>/dev/null || ifconfig -a 2>/dev/null) | head -40 || echo "(no ip/ifconfig)"

sec "7. Wi-Fi / P2P 接口与链路"
(iw dev 2>/dev/null; echo '--- p2p ---'; iw dev p2p-dev-wlan0 link 2>/dev/null; echo '--- wlan0 ---'; iw dev wlan0 link 2>/dev/null) | head -40 || echo "(no iw)"

sec "8. CarLife 文件系统线索（限定常见目录，避免卡死）"
find /usr /opt /var /data /system /app /home -maxdepth 5 \( -iname '*carlife*' -o -iname '*baidu*' -o -iname '*apollo*' -o -iname '*welink*' \) 2>/dev/null | head -80 || echo "(none)"

sec "9. systemd unit 线索"
{ ls /etc/systemd/system 2>/dev/null; ls /lib/systemd/system 2>/dev/null; } | grep -iE 'carlife|baidu|apollo|projection|mirror' | head -40 || echo "(none)"
systemctl list-units --all --no-pager 2>/dev/null | grep -iE 'carlife|baidu|apollo|projection|mirror' | head -20 || true

sec "10. 抓包/转发/解码工具是否可用"
for t in tcpdump nft iptables socat nc ffmpeg ffprobe strace lsof; do
  p=$(command -v "$t" 2>/dev/null) && echo "$t -> $p" || echo "$t -> MISSING"
done

sec "11. 解码硬件"
ls -l /dev/dri/renderD128 2>/dev/null || echo "no /dev/dri/renderD128"
ls /usr/lib*/libmfx* /usr/lib*/libva* 2>/dev/null | head -20 || echo "(no libmfx/libva in common paths)"

sec "12. 内核抓包能力"
grep -E 'CONFIG_PACKET|CONFIG_NF_TABLES|CONFIG_NETFILTER' /proc/config.gz 2>/dev/null | head -10 || echo "(no /proc/config.gz)"
cat /proc/sys/net/ipv4/ip_forward 2>/dev/null

sec "13. 磁盘空间（抓包需要）"
df -h /tmp /var/tmp /data 2>/dev/null | head -10

echo
echo "===== DONE: $OUT ====="
