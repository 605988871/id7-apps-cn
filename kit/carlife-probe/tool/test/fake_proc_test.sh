#!/bin/sh
# Offline check of probe-root.sh's parsing against a fake /proc tree.
# readlink is overridden, so the fd targets come from the names below.
set -e
FP=/tmp/fp
rm -rf $FP
mkdir -p $FP/proc/2823/fd $FP/proc/2824/fd $FP/proc/1 $FP/proc/net

printf 'carlife\0-c\0/etc/cinemo/carlife.conf\0' > $FP/proc/2823/cmdline
printf 'Uid:\t13005\t13005\t13005\t13005\nVmRSS:\t  92000 kB\n' > $FP/proc/2823/status
printf 'sdlpd\0--sink\0' > $FP/proc/2824/cmdline
printf 'Uid:\t13010\t13010\t13010\t13010\nVmRSS:\t  31000 kB\n' > $FP/proc/2824/status
printf 'sh\0-c\0init\0' > $FP/proc/1/cmdline
printf 'Uid:\t0\t0\t0\t0\n' > $FP/proc/1/status

# carlife opens the AOA device, a dmabuf, a frame segment and two sockets
i=0
for t in /dev/bus/usb/001/004 anon_inode:dmabuf socket /dev/dri/renderD128 /dev/null pipe socket /dev/shm/clframe0; do
    i=$((i+1)); : > $FP/proc/2823/fd/$i
done
: > $FP/proc/2824/fd/0
: > $FP/proc/2824/fd/1

cat > $FP/proc/2823/maps <<'EOF'
7f00-7f10 r-xp 00000000 08:01 1 /usr/lib/libmfxhw64.so
7f10-7f20 r-xp 00000000 08:01 2 /usr/lib/libcarlife_core.so.2
7f20-7f30 r-xp 00000000 08:01 3 /usr/lib/libias-media_transport-avb_ufipc_bridge.so.1
7f30-7f40 rw-s 00000000 00:05 4 /dev/shm/clframe0
7f40-7f50 rw-s 00000000 00:05 5 /memfd:video-buf (deleted)
EOF
cat > $FP/proc/2824/maps <<'EOF'
7f00-7f10 r-xp 00000000 08:01 1 /usr/lib/libc.so.6
EOF

printf 'Num       RefCount Protocol Flags    Type St Inode Path\n' > $FP/proc/net/unix
printf '0000000000000000: 00000002 00000000 00010000 0001 01 4123456 @/tmp/carlife/video\n' >> $FP/proc/net/unix
printf '0000000000000000: 00000002 00000000 00010000 0001 01 4123457 @/tmp/cinemo/render\n' >> $FP/proc/net/unix

# the fd numbers above map to these targets, in order
sed -e "s#/proc/#$FP/proc/#g" -e "s#^OUT=.*#OUT=$FP/report.txt#" \
    -e "s#^FULL=.*#FULL=$FP/keep.txt#" \
    -e "s#^\[ -d /dev/shm \].*#:#" \
    ../probe-root.sh > $FP/run.sh

cat > $FP/go.sh <<'EOF'
readlink() {
    case "$1" in
        */2823/fd/1) echo /dev/bus/usb/001/004 ;;
        */2823/fd/2) echo "anon_inode:dmabuf" ;;
        */2823/fd/3) echo "socket:[4123456]" ;;
        */2823/fd/4) echo /dev/dri/renderD128 ;;
        */2823/fd/5) echo /dev/null ;;
        */2823/fd/6) echo "pipe:[777]" ;;
        */2823/fd/7) echo "socket:[4123457]" ;;
        */2823/fd/8) echo /dev/shm/clframe0 ;;
        *) echo "" ;;
    esac
}
. /tmp/fp/run.sh once
EOF
sh $FP/go.sh || true
echo "=========== REPORT ==========="
cat $FP/report.txt
echo "=========== LINES: $(wc -l < $FP/report.txt) ==========="
