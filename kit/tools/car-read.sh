#!/bin/sh
# car-read.sh - 用 SSH 只读地看车机现状。
#
# 车上一个字节都不写：只有 ls / cat / grep / readlink / ps 这类读操作，
# 没有 mkdir、没有 mount、没有 systemctl start/stop、没有重定向到车上路径。
# 报告直接打到本地屏幕，不落到车机，所以不存在“调试本身改变现场”的问题。
#
# usage: sh kit/tools/car-read.sh [section]
#   section: host proc shim record unit usb net probe   (默认 all)
#
# 连接信息不写死在这里——车架号和私钥路径不该进公开仓库。第一次用之前：
#
#   export CAR_HOST=169.254.x.x          # 车机在 ENET 上的地址
#   export CAR_KEY=/path/to/enrollment/id_rsa
#
# 另外可覆盖 CAR_PORT（默认 22）、CAR_USER（默认 root）。
set -u

HOST=${CAR_HOST:-}
PORT=${CAR_PORT:-22}
USER=${CAR_USER:-root}
KEY=${CAR_KEY:-}

if [ -z "$HOST" ] || [ -z "$KEY" ]; then
    cat >&2 <<'USAGE'
car-read.sh: 需要 CAR_HOST 和 CAR_KEY。

  export CAR_HOST=169.254.x.x
  export CAR_KEY=/path/to/idrive7-8-ssh-root/dist/MGU-SSH/data/enrollments/<VIN>/id_rsa

地址可以在车机上不了网时用 arp 找：arp -a | grep 169.254
USAGE
    exit 2
fi

WHAT=${1:-all}
case "$WHAT" in
    host|proc|shim|record|unit|usb|net|probe|all) ;;
    *) echo "unknown section: $WHAT" >&2; exit 2 ;;
esac

[ -r "$KEY" ] || { echo "key not readable: $KEY" >&2; exit 2; }

# known_hosts：主机每次刷写都换 host key，而 /dev/null 在 Windows 上会被当成真
# 文件（首连写入后反而报 REMOTE HOST IDENTIFICATION HAS CHANGED），所以每次用
# 一个新的空文件。TMPDIR 在 Git Bash 里是 C:\... 形式，ssh.exe 要正斜杠。
KH=$(printf '%s/car-read-known-hosts-%s' "${TMPDIR:-/tmp}" "$$" | tr '\\' '/')
: > "$KH"
trap 'rm -f "$KH" 2>/dev/null' EXIT INT TERM

SSH_OPTS="-i $KEY -p $PORT -o BatchMode=yes -o StrictHostKeyChecking=no
 -o CheckHostIP=no -o UserKnownHostsFile=$KH -o GlobalKnownHostsFile=$KH
 -o IdentitiesOnly=yes -o PreferredAuthentications=publickey
 -o ConnectTimeout=10 -o ServerAliveInterval=10 -o LogLevel=ERROR"

# shellcheck disable=SC2086
run() {
    { printf 'WHAT=%s\n' "$WHAT"
      cat <<'REMOTE'
set -u
sec() { printf '\n== %s ==\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }
pids() {
    pidof carlife 2>/dev/null || pgrep -x carlife 2>/dev/null || \
        ps 2>/dev/null | awk '$0 ~ /carlife/ && $0 !~ /awk/ {print $1}' | tr '\n' ' '
}
SHM=/dev/shm/carlife-shim
CUR=/var/opt/carlife-shim/current
P=$(pids)

case "$WHAT" in host|all)
sec host
id 2>/dev/null
uname -a 2>/dev/null
printf 'uptime(s): '; cut -d' ' -f1 /proc/uptime 2>/dev/null
for f in /etc/version /etc/os-release /etc/mgu-version /etc/build-info; do
    [ -r "$f" ] && { printf '%s: ' "$f"; head -3 "$f" 2>/dev/null | tr '\n' ' '; echo; }
done
;; esac

case "$WHAT" in proc|all)
sec proc
printf 'carlife pid: %s\n' "${P:-（没在跑）}"
for p in ${P:-}; do
    printf -- '--- pid %s ---\n' "$p"
    printf 'cmdline: '; tr '\0' ' ' < /proc/$p/cmdline 2>/dev/null; echo
    printf 'exe: '; readlink /proc/$p/exe 2>/dev/null; echo
    printf 'cwd: '; readlink /proc/$p/cwd 2>/dev/null; echo
    printf 'LD_PRELOAD: '
    tr '\0' '\n' < /proc/$p/environ 2>/dev/null | sed -n 's/^LD_PRELOAD=//p' | head -3
    printf 'shim in maps: '
    grep -c 'carlife-shim' /proc/$p/maps 2>/dev/null || echo 0
    grep 'carlife-shim' /proc/$p/maps 2>/dev/null | head -2
    printf 'fds: '; ls /proc/$p/fd 2>/dev/null | wc -l | tr -d ' '; echo
    printf 'usb nodes: '
    ls -l /proc/$p/fd 2>/dev/null | sed -n 's|.*-> \(/dev/bus/usb/[0-9]*/[0-9]*\).*|\1|p' | sort -u | tr '\n' ' '; echo
    printf 'sockets: '; ls -l /proc/$p/fd 2>/dev/null | grep -c 'socket:' | tr -d ' '; echo
done
ps 2>/dev/null | grep -i -e carlife -e carplay -e usbip 2>/dev/null | grep -v grep
;; esac

case "$WHAT" in shim|all)
sec shim
ls -la "$SHM" 2>/dev/null || echo '（没有 /dev/shm/carlife-shim）'
for f in state.txt head.txt; do
    [ -r "$SHM/$f" ] && { printf -- '--- %s ---\n' "$f"; cat "$SHM/$f" 2>/dev/null; }
done
if [ -r "$SHM/tap.txt" ]; then
    printf -- '--- tap.txt (%s bytes, 前 40 行) ---\n' "$(wc -c < "$SHM/tap.txt" 2>/dev/null | tr -d ' ')"
    head -40 "$SHM/tap.txt" 2>/dev/null
fi
;; esac

case "$WHAT" in record|all)
sec record
ls -la "$CUR" 2>/dev/null || echo "（没有 $CUR）"
[ -r "$CUR/boot.txt" ] && { echo '--- boot.txt ---'; cat "$CUR/boot.txt" 2>/dev/null; }
;; esac

case "$WHAT" in unit|all)
sec unit
for f in /etc/systemd/system/carlife.service /lib/systemd/system/carlife.service \
         /usr/lib/systemd/system/carlife.service; do
    [ -r "$f" ] && { printf -- '--- %s ---\n' "$f"; cat "$f" 2>/dev/null; break; }
done
ls -la /etc/systemd/system/carlife.service.d 2>/dev/null
for f in /etc/systemd/system/carlife.service.d/*.conf; do
    [ -r "$f" ] && { printf -- '--- %s ---\n' "$f"; cat "$f" 2>/dev/null; }
done
have systemctl && { printf 'active: '; systemctl is-active carlife 2>/dev/null; }
;; esac

case "$WHAT" in usb|all)
sec usb
for d in /sys/bus/usb/devices/*; do
    [ -r "$d/idVendor" ] || continue
    printf '%s  %s:%s  %s  %s\n' "${d##*/}" "$(cat "$d/idVendor" 2>/dev/null)" \
        "$(cat "$d/idProduct" 2>/dev/null)" "$(cat "$d/product" 2>/dev/null)" \
        "$(cat "$d/manufacturer" 2>/dev/null)"
done
printf 'interfaces:\n'
for d in /sys/bus/usb/devices/*:*; do
    [ -r "$d/bInterfaceClass" ] || continue
    printf '  %s  %s/%s/%s  driver=%s\n' "${d##*/}" \
        "$(cat "$d/bInterfaceClass" 2>/dev/null)" "$(cat "$d/bInterfaceSubClass" 2>/dev/null)" \
        "$(cat "$d/bInterfaceProtocol" 2>/dev/null)" \
        "$(basename "$(readlink -f "$d/driver" 2>/dev/null)" 2>/dev/null)"
done
;; esac

case "$WHAT" in net|all)
sec net
cat /proc/net/dev 2>/dev/null
printf 'ifaces: '; ls /sys/class/net 2>/dev/null | tr '\n' ' '; echo
;; esac

case "$WHAT" in probe|all)
sec probe
if [ -r /dev/shm/carlife-probe/report.txt ]; then
    cat /dev/shm/carlife-probe/report.txt 2>/dev/null
else
    echo '（没有 probe 报告）'
fi
;; esac
REMOTE
    } | ssh $SSH_OPTS "$USER@$HOST" 'sh -s'
}

run
