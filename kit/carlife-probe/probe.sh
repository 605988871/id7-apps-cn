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
# how many times a literal appears in a binary: the unit's carlife is stripped, but
# the strings it was compiled with still name its ports and its transports.
cnt() { grep -a -o "$1" "$2" 2>/dev/null | wc -l | tr -d ' '; }

pids() {
    pidof carlife 2>/dev/null || pgrep -x carlife 2>/dev/null || \
        ps -eo pid,comm 2>/dev/null | awk '$2 ~ /carlife/ {print $1}' | tr '\n' ' '
}

report() {
    P=$(pids)
    USBFD=no
    SOCKN=0
    USBN=0
    FDS=''
    NETIF=''
    NODE=''
    INODES=''
    EXE=''
    [ -n "$P" ] && [ -d /proc/$P ] && FDS=$(ls -l /proc/$P/fd 2>/dev/null)
    case "$FDS" in *"/dev/bus/usb"*|*usbfs*) USBFD=yes ;; esac
    [ -n "$FDS" ] && SOCKN=$(printf '%s\n' "$FDS" | grep -c 'socket:' 2>/dev/null)
    USBN=$(printf '%s\n' "$FDS" | grep -c 'usb/' 2>/dev/null)
    NODE=$(printf '%s\n' "$FDS" | sed -n 's|.*\(/dev/bus/usb/[0-9]*/[0-9]*\).*|\1|p' | head -1)
    INODES=$(printf '%s\n' "$FDS" | sed -n 's/.*socket:\[\([0-9]*\)\].*/\1/p')
    NETIF=$(ls /sys/class/net 2>/dev/null | grep -E '^(usb|rndis|enx|wwan)' | tr '\n' ' ')

    # usbfs first: a device handle is the stronger fact, and a unit that has both
    # a usbfs handle and a usb0 is still talking AOA.
    if [ -z "$P" ]; then V=bare
    elif [ "$USBFD" = yes ]; then V=AOA
    elif [ -n "$NETIF" ]; then V=IP
    else V=idle                              # running, but nothing plugged in
    fi

    # How it reaches the device, in one word: a libusb in the maps can be swapped
    # out from outside the binary, raw usbfs ioctls have to be intercepted at the
    # syscall, which is the difference between an afternoon and a week.
    if [ "$USBFD" = no ]; then ACC='(none)'
    elif [ -n "$(grep -oE 'libusb[^ ]*' /proc/${P%% *}/maps 2>/dev/null | head -1)" ]; then ACC=libusb
    else ACC='usbfs ioctl'
    fi

    # A static binary ignores LD_PRELOAD entirely, so this is the other half of
    # whether a shim is even loadable: any libc or loader mapping means dynamic.
    if [ -z "$P" ]; then DYN=--
    elif [ -n "$(grep -oE '/(libc|ld-)[^ ]*\.so' /proc/${P%% *}/maps 2>/dev/null | head -1)" ]; then DYN=dynamic
    else DYN=static
    fi

    printf 'at: %s\n' "$(date '+%Y-%m-%d %H:%M:%S' 2>/dev/null)"
    printf 'kernel: %s\n' "$(uname -r 2>/dev/null)"
    printf 'pids: %s\n' "${P:-none}"

    sec verdict
    printf 'verdict: %s\n' "$V"
    printf 'usbfs_fd: %s\n' "$USBFD"
    printf 'usbfs_n: %s\n' "$USBN"
    printf 'sockets: %s\n' "$SOCKN"
    printf 'usb_net_iface: %s\n' "${NETIF:-(none)}"
    printf 'access: %s\n' "$ACC"
    printf 'node: %s\n' "${NODE:-(none)}"

    sec proc
    if [ -z "$P" ]; then
        printf 'carlife: not running\n'
        printf 'start it in the HMI, then read again\n'
    fi
    for p in $P; do
        [ -d /proc/$p ] || continue
        EXE=$(readlink /proc/$p/exe 2>/dev/null)
        printf 'pid %s comm: %s\n' "$p" "$(cat /proc/$p/comm 2>/dev/null)"
        printf 'exe: %s\n' "$EXE"
        printf 'cmd: %s\n' "$(tr '\0' ' ' < /proc/$p/cmdline 2>/dev/null | cut -c1-96)"
        # libs before the fd list, because this is the line the next decision hangs
        # on: a libusb in maps means the usb conversation can be replaced inside the
        # process; no libusb means raw usbfs ioctls, a harder but bounded job.
        printf 'libs: %s\n' "$(nn "$(grep -oE '(libusb[^ ]*|libmfx[^ ]*|libva[^ ]*|avcodec[^ ]*|libGL[^ ]*|libEGL[^ ]*)' /proc/$p/maps 2>/dev/null | sed 's|.*/||' | sort -u | head -6 | tr '\n' ' ' | sed 's/ *$//')")"
        printf 'link: %s\n' "$DYN"
        printf 'fd count: %s  sockets: %s  usbfs: %s\n' \
            "$(ls /proc/$p/fd 2>/dev/null | wc -l | tr -d ' ')" "$SOCKN" "$USBN"
        printf '%s\n' "$FDS" | awk '$0 ~ /usb|socket|dri/ {print "  fd " $9 " " $11}' | head -2
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
    # Which of carlife's sockets are its own plumbing and which face the outside:
    # a usbfs handle plus a pile of unix sockets is a process that does the USB
    # work itself and talks to the HMI over local sockets, not a process reading
    # frames from some helper we could feed instead.
    NUNIX=0
    NTCP=0
    if [ -n "$INODES" ]; then
        PAT=$(printf '%s\n' $INODES | sed 's/^/^/; s/$/$/' | tr '\n' '|' | sed 's/|$//')
        NUNIX=$(awk -v p="$PAT" '$7 ~ p' /proc/net/unix 2>/dev/null | wc -l | tr -d ' ')
        NTCP=$(awk -v p="$PAT" '$10 ~ p' /proc/net/tcp /proc/net/tcp6 2>/dev/null | wc -l | tr -d ' ')
    fi
    printf 'socket fds: %s  unix: %s  tcp: %s\n' "$SOCKN" "$NUNIX" "$NTCP"
    if [ "$NUNIX" -gt 0 ] 2>/dev/null; then
        printf '%s\n' $INODES | while read -r i; do
            awk -v n="$i" '$7 == n {print $8}' /proc/net/unix 2>/dev/null
        done | head -3 | cut -c1-64 | sed 's/^/  /'
    fi

    sec usb
    for d in /sys/bus/usb/devices/*; do
        [ -r "$d/idVendor" ] || continue
        printf '  %s %s:%s class=%s %s\n' "$(basename "$d")" \
            "$(cat "$d/idVendor" 2>/dev/null)" "$(cat "$d/idProduct" 2>/dev/null)" \
            "$(cat "$d/bDeviceClass" 2>/dev/null)" "$(cat "$d/product" 2>/dev/null)"
    done | head -8 | cut -c1-96
    [ -n "$(ls /sys/bus/usb/devices 2>/dev/null)" ] || printf '  (no usb devices)\n'

    # The device carlife actually opened, described the way the host sees it: if
    # this is an accessory (18d1:xxxx, vendor-specific interface, one bulk pair)
    # then the cable is carrying CarLife frames wrapped in USB, and the only way
    # to feed the native UI is to stand in for this device inside the process.
    sec aoa
    if [ -n "$NODE" ]; then
        printf 'node: %s\n' "$NODE"
        # /dev/bus/usb/001/005 -> fields 5 and 6; sysfs prints these as decimals
        BUS=$(printf '%s' "$NODE" | cut -d/ -f5 | sed 's/^0*//'); BUS=${BUS:-0}
        DEV=$(printf '%s' "$NODE" | cut -d/ -f6 | sed 's/^0*//'); DEV=${DEV:-0}
        for d in /sys/bus/usb/devices/*; do
            [ -r "$d/busnum" ] || continue
            [ "$(cat "$d/busnum" 2>/dev/null)" = "$BUS" ] || continue
            [ "$(cat "$d/devnum" 2>/dev/null)" = "$DEV" ] || continue
            printf 'dev: %s %s:%s %s\n' "$(basename "$d")" \
                "$(cat "$d/idVendor" 2>/dev/null)" "$(cat "$d/idProduct" 2>/dev/null)" \
                "$(cat "$d/product" 2>/dev/null)"
            printf 'speed: %s Mb/s  ifaces: %s\n' \
                "$(cat "$d/speed" 2>/dev/null)" "$(cat "$d/bNumInterfaces" 2>/dev/null)"
            for f in "$d"/*:*; do
                [ -d "$f" ] || continue
                printf 'if %s class=%s subs=%s eps=%s\n' "${f##*:}" \
                    "$(cat "$f/bInterfaceClass" 2>/dev/null)" \
                    "$(cat "$f/bInterfaceSubClass" 2>/dev/null)" \
                    "$(cat "$f/bNumEndpoints" 2>/dev/null)"
                for e in "$f"/ep_*; do
                    [ -d "$e" ] || continue
                    printf '  ep %s %s %s\n' "$(cat "$e/bEndpointAddress" 2>/dev/null)" \
                        "$(cat "$e/type" 2>/dev/null)" "$(cat "$e/wMaxPacketSize" 2>/dev/null)"
                done
            done
        done | head -9 | cut -c1-96
    else
        printf 'node: (none)\n'
        printf 'no usbfs handle right now: plug the phone in and open the car CarLife\n'
    fi

    sec gadget
    K=$(uname -r 2>/dev/null)
    printf 'udc: %s\n' "$(nn "$(list /sys/class/udc)")"
    printf 'udc state: %s\n' "$(nn "$(cat /sys/class/udc/*/state 2>/dev/null | head -1)")"
    printf 'vhci built in: %s\n' "$( [ -d /sys/module/vhci_hcd ] && printf yes || printf no)"
    printf 'usbip modules: %s\n' "$(nn "$(list /lib/modules/"$K"/kernel/drivers/usb/usbip)")"
    printf 'gadget modules: %s\n' "$(nn "$(ls /lib/modules/"$K"/kernel/drivers/usb/gadget 2>/dev/null | head -3 | tr '\n' ' ' | sed 's/ *$//')")"
    printf 'loaded: %s\n' "$(nn "$(lsmod 2>/dev/null | awk '/vhci|usbip|libcomposite|configfs|dwc3/ {print $1}' | tr '\n' ' ' | sed 's/ *$//')")"
    printf 'usbmon: %s\n' "$(nn "$(list /sys/kernel/debug/usb/usbmon)")"
    printf 'usbfs mount: %s\n' "$(grep -qE 'usbfs|/proc/bus/usb' /proc/mounts 2>/dev/null && printf yes || printf no)"

    # What the binary was built to speak. Ports it never mentions cannot be a
    # transport it knows; ports it does mention mean the CarLife conversation is
    # in there twice, once per transport, and the framing is likely shared.
    sec binary
    if [ -n "$EXE" ] && [ -r "$EXE" ]; then
        printf 'ports: 7240=%s 8240=%s 9240=%s\n' \
            "$(cnt 7240 "$EXE")" "$(cnt 8240 "$EXE")" "$(cnt 9240 "$EXE")"
        printf 'words: accessory=%s aoa=%s wifi=%s\n' \
            "$(cnt accessory "$EXE")" "$(cnt aoa "$EXE")" "$(cnt wifi "$EXE")"
    else
        printf '(no readable exe)\n'
    fi

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
