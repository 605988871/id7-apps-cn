#!/bin/sh
# carlife-probe - how the unit's own CarLife gets at the phone, read-only.
#
# Every line of the report is a read: /proc, /sys, systemd's own state, dmesg.
# Nothing is loaded, started or stopped, because the report is meant to be taken
# while a wired CarLife session is on the screen, and a probe that changes what
# it measures is worth nothing.
#
# The question it answers, in one word, is which layer the cable carries:
#
#   AOA   carlife is talking to a USB *device* itself (a usbfs handle in its fd
#         table, no network interface anywhere) - the box is a USB device, so
#         replacing it without hardware needs a virtual device (vhci/usbip) or a
#         shim inside the process
#   IP    a USB network interface appeared (usb0/rndis/enx) and carlife holds
#         sockets - the cable is only a cable, and the same conversation can be
#         served from an application
#
# usage: probe.sh [interval]      no argument = one pass, an argument = loop
set -u

DIR=/dev/shm/carlife-probe
OUT=$DIR/report.txt
EVERY=${1:-0}

mkdir -p "$DIR" 2>/dev/null
chmod 0777 "$DIR" 2>/dev/null               # the app reads it as tm_oap_app

have() { command -v "$1" >/dev/null 2>&1; }
sec() { printf '\n## %s\n' "$*"; }
list() { ls "$@" 2>/dev/null | tr '\n' ' ' | sed 's/ *$//'; }
nn() { [ -n "$1" ] && printf '%s' "$1" || printf '(none)'; }

pids() {
    pidof carlife 2>/dev/null || pgrep -x carlife 2>/dev/null || \
        ps -eo pid,comm 2>/dev/null | awk '$2 ~ /carlife/ {print $1}' | tr '\n' ' '
}

report() {
    P=$(pids)
    USBFD=no
    SOCKN=0
    FDS=''
    NETIF=''
    [ -n "$P" ] && [ -d /proc/$P ] && FDS=$(ls -l /proc/$P/fd 2>/dev/null)
    case "$FDS" in *"/dev/bus/usb"*|*usbfs*) USBFD=yes ;; esac
    [ -n "$FDS" ] && SOCKN=$(printf '%s\n' "$FDS" | grep -c 'socket:' 2>/dev/null)
    NETIF=$(ls /sys/class/net 2>/dev/null | grep -E '^(usb|rndis|enx|wwan)' | tr '\n' ' ')

    if [ -z "$P" ]; then V=bare
    elif [ -n "$NETIF" ] && [ "$USBFD" = no ]; then V=IP
    elif [ "$USBFD" = yes ]; then V=AOA
    else V=unknown
    fi

    printf 'at: %s\n' "$(date '+%Y-%m-%d %H:%M:%S' 2>/dev/null)"
    printf 'kernel: %s\n' "$(uname -r 2>/dev/null)"
    printf 'pids: %s\n' "${P:-none}"

    sec verdict
    printf 'verdict: %s\n' "$V"
    printf 'usbfs_fd: %s\n' "$USBFD"
    printf 'sockets: %s\n' "$SOCKN"
    printf 'usb_net_iface: %s\n' "${NETIF:-(none)}"

    sec proc
    if [ -z "$P" ]; then
        printf 'carlife: not running\n'
        printf 'start it in the HMI, then read again\n'
    fi
    for p in $P; do
        [ -d /proc/$p ] || continue
        printf 'pid %s comm: %s\n' "$p" "$(cat /proc/$p/comm 2>/dev/null)"
        printf 'exe: %s\n' "$(readlink /proc/$p/exe 2>/dev/null)"
        printf 'cmd: %s\n' "$(tr '\0' ' ' < /proc/$p/cmdline 2>/dev/null | cut -c1-96)"
        printf 'fd count: %s\n' "$(ls /proc/$p/fd 2>/dev/null | wc -l | tr -d ' ')"
        printf '%s\n' "$FDS" | awk '$0 ~ /usb|socket|dri|shm/ {print "  fd " $9 " " $11}' | head -6
        printf 'libs: %s\n' "$(grep -oE '(libusb[^ ]*|usbfs|libmfx[^ ]*|libva[^ ]*|avcodec[^ ]*|h264[^ ]*|libGL[^ ]*|libEGL[^ ]*)' /proc/$p/maps 2>/dev/null | sed 's|.*/||' | sort -u | head -5 | tr '\n' ' ')"
        printf 'cwd: %s\n' "$(readlink /proc/$p/cwd 2>/dev/null)"
    done

    sec net
    printf 'ifaces: %s\n' "$(ls /sys/class/net 2>/dev/null | tr '\n' ' ')"
    if have ip; then
        ip -4 -o addr show 2>/dev/null | awk '{printf "  %s %s\n", $2, $4}' | head -6
    elif have ifconfig; then
        ifconfig -a 2>/dev/null | awk '/^[a-z]/ {i=$1} /inet / {print "  " i " " $2}' | head -6
    else
        printf '  (no ip, no ifconfig)\n'
    fi
    printf 'socket fds: %s\n' "$SOCKN"
    if [ "$SOCKN" -gt 0 ] 2>/dev/null; then
        if have ss; then
            ss -tnp 2>/dev/null | grep -i carlife | head -4 | cut -c1-96 | sed 's/^/  /'
        else
            awk 'NR>1 {printf "  %s %s %s\n", $10, $2, $3}' /proc/net/tcp 2>/dev/null | head -4
        fi
    fi

    sec usb
    for d in /sys/bus/usb/devices/*; do
        [ -r "$d/idVendor" ] || continue
        printf '  %s %s:%s class=%s %s\n' "$(basename "$d")" \
            "$(cat "$d/idVendor" 2>/dev/null)" "$(cat "$d/idProduct" 2>/dev/null)" \
            "$(cat "$d/bDeviceClass" 2>/dev/null)" "$(cat "$d/product" 2>/dev/null)"
    done | head -8 | cut -c1-96
    [ -n "$(ls /sys/bus/usb/devices 2>/dev/null)" ] || printf '  (no usb devices)\n'

    sec gadget
    K=$(uname -r 2>/dev/null)
    printf 'udc: %s\n' "$(nn "$(list /sys/class/udc)")"
    printf 'usbip modules: %s\n' "$(nn "$(list /lib/modules/"$K"/kernel/drivers/usb/usbip)")"
    printf 'gadget modules: %s\n' "$(nn "$(ls /lib/modules/"$K"/kernel/drivers/usb/gadget 2>/dev/null | head -4 | tr '\n' ' ' | sed 's/ *$//')")"
    printf 'loaded: %s\n' "$(nn "$(lsmod 2>/dev/null | awk '/vhci|usbip|libcomposite|configfs|dwc3/ {print $1}' | tr '\n' ' ' | sed 's/ *$//')")"

    sec shm
    ls -la /dev/shm 2>/dev/null | head -8 | sed 's/^/  /'

    sec service
    printf 'units: %s\n' "$(nn "$(systemctl list-unit-files --no-legend 2>/dev/null | awk '/carl/ {print $1}' | head -4 | tr '\n' ' ' | sed 's/ *$//')")"
    U=$(systemctl list-unit-files --no-legend 2>/dev/null | awk '/carl/ {print $1}' | head -1)
    if [ -n "${U:-}" ]; then
        systemctl cat "$U" 2>/dev/null | grep -E '^(ExecStart|Environment)' | head -2 | cut -c1-96 | sed 's/^/  /'
    fi

    sec kernel
    printf '%s\n' "$(dmesg 2>/dev/null | grep -iE 'usb 1-|dwc|xhci|gadget' | tail -4 | cut -c1-96 | sed 's/^/  /')"
}

if [ "$EVERY" -gt 0 ] 2>/dev/null; then
    while :; do
        report > "$OUT.tmp" 2>/dev/null && mv "$OUT.tmp" "$OUT" 2>/dev/null
        chmod 0644 "$OUT" 2>/dev/null
        sleep "$EVERY"
    done
else
    report
fi
