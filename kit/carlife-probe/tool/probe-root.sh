#!/bin/sh
# CarLife probe (root): what CarLife's processes really hold, which libraries
# carry the video, how the Cinemo stack is configured, and what this unit can
# build with. Read-only by design: it reads /proc, /sys, /etc/cinemo and lists
# directories, and writes nothing but its report. It loads no module, changes
# no firewall rule and touches no process.
#
# Why root: the app (uid tm_oap_app) cannot read another uid's /proc/<pid>/fd
# and /proc/<pid>/maps on this unit (hidepid). Those two are the whole point:
#   * an open /dev/bus/usb/* handle in the CarLife process proves the video
#     rides on USB bulk transfers (usbfs) instead of TCP, and
#   * the loaded libraries name the decoder and the projection stack.
#
# The report goes to /dev/shm/carlife-probe-root.txt (0644, the app's uid can
# read it) and a copy to /var/opt/carlife-probe-root/report.txt.
#
# usage: probe-root.sh [once|loop]     (loop: rescan every 15 s, for the unit)

OUT=/dev/shm/carlife-probe-root.txt
KEEP=/var/opt/carlife-probe-root/report.txt
# a unit without /dev/shm (not this one) still leaves a report somewhere
[ -d /dev/shm ] || OUT=/tmp/carlife-probe-root.txt

p() { command -v "$1" 2>/dev/null || echo -; }

# The CarLife family, "pid|uid|rssMB|argv0|cmdline": the uids round 1 and 2
# found (13000-13099) plus the names the Cinemo stack uses.
fam() {
    : > "$1"
    for d in /proc/[0-9]*; do
        [ -r "$d/cmdline" ] || continue
        c=$(tr '\0' ' ' < "$d/cmdline" 2>/dev/null)
        [ -n "$c" ] || continue
        case "$c" in
            *carlife*|*aapd*|*carplay*|*sdlp*|*cinemo*|*mdnsd*) ;;
            *) continue ;;
        esac
        u=$(awk '/^Uid:/{print $2; exit}' "$d/status" 2>/dev/null)
        m=$(awk '/^VmRSS:/{printf "%d", $2/1024; exit}' "$d/status" 2>/dev/null)
        echo "${d#/proc/}|${u:--}|${m:--}|$(printf '%s' "$c" | cut -d' ' -f1)|$c" >> "$1"
    done
}

# open descriptors by kind: a usb= count above zero is the proof of a USB
# carrier (a CarLife session over USB AOA shows one or two /dev/bus/usb fds)
fdline() {
    n=0; u=0; s=0; g=0; pp=0
    [ -d "/proc/$1/fd" ] || { echo "fd=- (unreadable)"; return; }
    for f in /proc/$1/fd/*; do
        t=$(readlink "$f" 2>/dev/null) || continue
        n=$((n + 1))
        case "$t" in
            /dev/bus/usb/*) u=$((u + 1)) ;;
            socket:*) s=$((s + 1)) ;;
            /dev/dri/*) g=$((g + 1)) ;;
            pipe:*) pp=$((pp + 1)) ;;
        esac
    done
    echo "fd=$n usb=$u sock=$s gpu=$g pipe=$pp"
}

fdpaths() {
    [ -d "/proc/$1/fd" ] || return
    for f in /proc/$1/fd/*; do
        t=$(readlink "$f" 2>/dev/null) || continue
        case "$t" in
            /dev/bus/usb/*|/dev/dri/*|/dev/video*) echo "  ${f##*/} -> $t" ;;
        esac
    done | head -4
}

# the libraries that carry video, decoding and the projection bridge
libs() {
    [ -r "/proc/$1/maps" ] || { echo "(maps of $1 unreadable)"; return; }
    awk '{for (i = 1; i <= NF; i++) if ($i ~ /^\//) print $i}' "/proc/$1/maps" 2>/dev/null |
        sed 's#.*/##' | sort -u |
        grep -Ei 'carlife|cinemo|sdlp|apollo|avcodec|decod|h264|hevc|mfx|libva|usb|vfs|nme|egl|gles' |
        head -10
}

# the projection stack's own configuration: KOMBI_DISPLAY, alternate displays
# and the stream sink are named here, which is where a second output would be
# switched on
conf() {
    ls -l /etc/cinemo 2>/dev/null | awk 'NF > 5 {print $5, $9}' | head -10
    n=0
    for f in /etc/cinemo/cinemo_options.xml /etc/cinemo/carlife.conf /etc/cinemo/aapd.conf /etc/cinemo/carplay.conf; do
        [ -r "$f" ] || continue
        [ "$n" -ge 2 ] && break
        n=$((n + 1))
        echo "## ${f#/etc/cinemo/} $(wc -c < "$f" 2>/dev/null)b"
        grep -Ein 'kombi|alternate|secondary|display|sink|codec|viewport|cluster|resolution' "$f" 2>/dev/null |
            cut -c1-140 | head -6
    done
}

# the unit's own sockets: a frame pipe between the projection stack and the HMI
# would show up here, and would be the cheapest capture point of all
socks() {
    echo "unix=$(awk 'NR > 1' /proc/net/unix 2>/dev/null | wc -l)"
    awk 'NR > 1 {print $8}' /proc/net/unix 2>/dev/null |
        grep -Ei 'carlife|cinemo|sdlp|avb|nme|video|render|project|hud' | sort -u | head -8
}

scan() {
    T=$(mktemp "${OUT%/*}/.clp.XXXXXX" 2>/dev/null) || T="${OUT%/*}/.clp.$$"
    {
        echo "=== ROOT PROBE $(date +%H:%M:%S) uid=$(awk '/^Uid:/{print $2; exit}' /proc/self/status) ==="
        echo "kernel $(uname -r) $(uname -m)"
        fam "$T.fam"
        echo "--- PROCESSES pid uid rssMB cmd ---"
        cut -c1-110 "$T.fam" | tr '|' ' ' | head -10
        echo "--- FDS ---"
        usbp=""
        clp=""
        while IFS='|' read -r pid uid rss a0 cmd; do
            line=$(fdline "$pid")
            echo "$a0 $line"
            case "$line" in *usb=0*) ;; *) usbp="$usbp $pid" ;; esac
            case "$a0" in *carlife*) [ -z "$clp" ] && clp="$pid" ;; esac
        done < "$T.fam"
        for pid in $usbp; do
            fdpaths "$pid"
        done
        echo "--- LIBS (decoder / projection) ---"
        libs "${clp:-1}" | head -10
        echo "--- CINEMO CONFIG ---"
        conf
        echo "--- UNIX SOCKETS ---"
        socks
        echo "--- TOOLCHAIN ---"
        echo "build: gcc=$(p gcc) cc=$(p cc) clang=$(p clang) make=$(p make) as=$(p as) ld=$(p ld)"
        echo "python: py3=$(p python3) py2=$(p python2) perl=$(p perl)"
        echo "debug: strace=$(p strace) gdb=$(p gdb) objdump=$(p objdump) readelf=$(p readelf)"
        echo "net: nft=$(p nft) iptables=$(p iptables) socat=$(p socat) nc=$(p nc)"
        echo "--- USBMON ---"
        echo "modules: $(ls /lib/modules 2>/dev/null | head -2 | tr '\n' ' ')"
        echo "usbmon.ko: $(find /lib/modules -name 'usbmon*' 2>/dev/null | head -2 | tr '\n' ' ')"
        echo "debugfs usb: $(ls /sys/kernel/debug/usb 2>/dev/null | tr '\n' ' ')"
        echo "dev usbmon: $(ls /dev 2>/dev/null | grep -c usbmon)"
        echo "--- DEV / BINARIES ---"
        ls -l /dev/fb0 /dev/dri/renderD128 /dev/dri/card0 2>/dev/null | awk '{print $1, $5, $NF}'
        for b in carlife aapd carplay sdlpd mdnsd; do
            [ -e "/usr/bin/$b" ] && ls -l "/usr/bin/$b" 2>/dev/null | awk '{print $5, $NF}'
        done
        find /usr/lib /usr/lib64 -maxdepth 1 \( -iname '*carlife*' -o -iname '*cinemo*' -o -iname '*sdlp*' \) 2>/dev/null | head -6
        echo "--- NOTE ---"
        echo "usb>0 on a pid: the video rides on USB bulk (usbfs), not TCP."
        echo "no usbmon.ko above: passive USB capture is closed on this kernel."
    } > "$T" 2>/dev/null
    rm -f "$T.fam"
    chmod 0644 "$T" 2>/dev/null
    if [ -f "$OUT" ] && cmp -s "$T" "$OUT" 2>/dev/null; then
        rm -f "$T"
    else
        mv -f "$T" "$OUT" 2>/dev/null
        cp -f "$OUT" "$KEEP" 2>/dev/null
    fi
}

case "${1:-once}" in
loop)
    # the unit: a report that follows the session (connect CarLife, then read)
    while :; do
        scan
        sleep 15
    done
    ;;
*)
    scan
    ;;
esac
exit 0
