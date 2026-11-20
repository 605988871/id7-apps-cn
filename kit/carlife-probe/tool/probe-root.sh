#!/bin/sh
# CarLife probe (root) 1.0.1: what CarLife's processes really hold, which
# libraries carry the video, how the Cinemo stack is configured, and what this
# unit can build with. Read-only by design: it reads /proc, /sys and
# /etc/cinemo and lists directories, and writes nothing but its report. It
# loads no module, changes no firewall rule and touches no process.
#
# Why root: the app (uid tm_oap_app) cannot read another uid's /proc/<pid>/fd
# and /proc/<pid>/maps on this unit (hidepid). Those two are the whole point:
#   * an open /dev/bus/usb/* handle in the CarLife process proves the video
#     rides on USB bulk transfers (usbfs) instead of TCP,
#   * /dev/shm or dmabuf handles, or a socket, say where the frames go next,
#   * the loaded libraries say whether this process decodes the video itself
#     (libmfx / libva) or hands it to another one (then that socket is the
#     capture point).
#
# The report is kept short on purpose (about 90 lines, the app shows 17 a
# page): every line below is one fact a decision rests on.
#
# The report goes to /dev/shm/carlife-probe-root.txt (0644, the app's uid can
# read it) and a copy to /var/opt/carlife-probe-root/report.txt.
#
# usage: probe-root.sh [once|loop]     (loop: rescan every 15 s, for the unit)

OUT=/dev/shm/carlife-probe-root.txt
FULL=/var/opt/carlife-probe-root/report.txt
# a unit without /dev/shm (not this one) still leaves a report somewhere
[ -d /dev/shm ] || OUT=/tmp/carlife-probe-root.txt

p() { command -v "$1" 2>/dev/null || echo -; }

# The CarLife family, "pid|uid|rssMB|argv0|cmdline": the uids rounds 1 and 2
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

# open descriptors of one pid by kind. usb>0 is the proof of a USB carrier;
# shm>0 or dma>0 would be frames shared with another process, which is the
# cheapest capture point of all.
fds() {
    n=0; u=0; s=0; g=0; pp=0; sh=0; dm=0
    [ -d "/proc/$1/fd" ] || { echo "fd=- (hidepid)"; return; }
    for f in /proc/$1/fd/*; do
        t=$(readlink "$f" 2>/dev/null) || continue
        n=$((n + 1))
        case "$t" in
            /dev/bus/usb/*) u=$((u + 1)) ;;
            /dev/shm/*) sh=$((sh + 1)) ;;
            anon_inode:dmabuf*|/dev/dma_heap/*) dm=$((dm + 1)) ;;
            socket:*) s=$((s + 1)) ;;
            /dev/dri/*) g=$((g + 1)) ;;
            pipe:*) pp=$((pp + 1)) ;;
        esac
    done
    echo "fd=$n usb=$u shm=$sh dma=$dm so=$s gpu=$g pipe=$pp"
}

# the libraries in one pid's maps that decide the pipeline: a decoder in this
# process means the frames leave it decoded; no decoder here means they leave
# as H.264 to whoever has one (then its socket is the capture point).
dec() {
    [ -r "/proc/$1/maps" ] || { echo "-"; return; }
    awk '{for (i = 1; i <= NF; i++) if ($i ~ /^\//) {print $i; break}}' "/proc/$1/maps" 2>/dev/null |
        sed 's#.*/##; s/\.so.*//' | sort -u |
        grep -Ei '^(libmfx|libva|libias|libnme|libavcodec|libdlt|libgst|libcarlife|libcv|libegl|libgles|libwayland)' |
        tr '\n' ',' | cut -c1-74
}

# every distinct fd target of the family that is not a terminal or a pipe: the
# USB device node, a shared-memory or dmabuf segment, and the names of the
# unix sockets (resolved through /proc/net/unix), which is how a video pipe
# between the projection stack and the HMI shows itself.
devs() {
    for pid in $1; do
        for f in /proc/$pid/fd/*; do
            t=$(readlink "$f" 2>/dev/null) || continue
            case "$t" in
                socket:*)
                    i=$(printf '%s' "$t" | tr -dc '0-9')
                    nm=$(awk -v k="$i" '$1 == k {print $2; exit}' "$2" 2>/dev/null)
                    [ -n "$nm" ] && echo "so:$nm" ;;
                anon_inode:dmabuf*) echo "dma:dmabuf" ;;
                anon_inode:*) ;;
                /dev/null|/dev/zero|/dev/full|/dev/random|/dev/urandom|/dev/tty*|/dev/pts/*|pipe:*) ;;
                *) echo "$t" ;;
            esac
        done
    done | sort -u | head -12
}

# the Cinemo configuration: KOMBI_DISPLAY, alternate displays and the stream
# sink are named here, which is where a second output would be switched on.
# A small file is shown whole (the keys are what matters, not a guess at their
# spelling); a large one is grepped.
conf() {
    ls -l /etc/cinemo 2>/dev/null | awk 'NF > 5 {printf "  %6s %s\n", $5, $9}' | head -8
    for f in /etc/cinemo/cinemo_options.xml /etc/cinemo/carlife.conf /etc/cinemo/aapd.conf \
             /etc/cinemo/carplay.conf /etc/cinemo/*.conf /etc/cinemo/*.xml; do
        [ -r "$f" ] || continue
        sz=$(wc -c < "$f" 2>/dev/null)
        [ "${sz:-0}" -gt 0 ] || continue
        echo "## ${f#/etc/cinemo/} ${sz}b"
        if [ "$sz" -le 6000 ]; then
            grep -Ev '^[[:space:]]*(<!--|$)' "$f" 2>/dev/null | cut -c1-100 | head -12
        else
            grep -Ein 'kombi|alternate|secondary|display|sink|codec|viewport|cluster|resol|uri|fifo|udp|avb' \
                "$f" 2>/dev/null | cut -c1-100 | head -8
        fi
    done
}

scan() {
    W=$(mktemp -d "${OUT%/*}/.clpx.XXXXXX" 2>/dev/null) || { W="/tmp/.clpx.$$"; mkdir -p "$W" 2>/dev/null; }
    : > "$W/unix"
    # inode -> unix socket path, for devs()
    awk 'NR > 1 && NF > 7 {print $7, $8}' /proc/net/unix > "$W/unix" 2>/dev/null
    fam "$W/fam"
    usbp=""
    clp=""
    {
        echo "=== ROOT PROBE $(date +%H:%M:%S) uid=$(awk '/^Uid:/{print $2; exit}' /proc/self/status) ==="
        echo "kernel $(uname -r) $(uname -m)"
        echo "--- PROCESSES (pid uid rssMB) ---"
        cut -c1-108 "$W/fam" | tr '|' ' ' | head -8
        echo "--- FDS + DECODER (per process) ---"
        while IFS='|' read -r pid uid rss a0 cmd; do
            line=$(fds "$pid")
            echo "$a0 $line"
            case "$line" in *usb=0*) ;; *) usbp="$usbp $pid" ;; esac
            case "$a0" in *carlife*) [ -z "$clp" ] && clp="$pid" ;; esac
        done < "$W/fam"
        echo "--- DECODER LIBS (per process) ---"
        while IFS='|' read -r pid uid rss a0 cmd; do
            echo "$a0 $(dec "$pid")"
        done < "$W/fam" | head -8
        echo "--- DEVICES (usb/shm/dmabuf/sockets of the family) ---"
        d=$(devs "${clp:-} $usbp" "$W/unix")
        if [ -n "$d" ]; then echo "$d"; else echo "(none: no usb, shm, dmabuf or named socket handle)"; fi
        echo "--- DECODER AND STACK LIBRARIES ---"
        awk '{for (i = 1; i <= NF; i++) if ($i ~ /^\//) {print $i; break}}' "/proc/${clp:-1}/maps" 2>/dev/null |
            sed 's#.*/##' | sort -u |
            grep -Ei 'carlife|cinemo|sdlp|apollo|avcodec|decod|h264|hevc|mfx|libva|usb|ias|nme|dlt' |
            head -12
        echo "--- /dev/shm (a 1MB+ segment is a frame buffer) ---"
        ls -l /dev/shm 2>/dev/null | awk 'NR > 1 && $5 > 4096 {printf "  %9d %s\n", $5, $9}' |
            sort -rn | head -7
        echo "--- MEMFD / SHM IN MAPS ---"
        awk '{for (i = 1; i <= NF; i++) if ($i ~ /(^|\/)memfd:|\/dev\/shm\/|\/dev\/dma_heap/) {print "  " $i; break}}' \
            "/proc/${clp:-1}/maps" 2>/dev/null | sort -u | head -5
        echo "--- ENV (sink / display keys) ---"
        tr '\0' '\n' < "/proc/${clp:-1}/environ" 2>/dev/null |
            grep -Ei 'preload|sink|uri|display|kombi|variant|codec|width|height|resol' | cut -c1-96 | head -5
        echo "--- CINEMO CONFIG ---"
        conf
        echo "--- UNIX SOCKETS ---"
        awk 'NR > 1 {print $8}' /proc/net/unix 2>/dev/null |
            grep -Ei 'carlife|cinemo|sdlp|avb|nme|media|video|render|project|kombi|hud' | sort -u | head -8
        echo "--- TOOLCHAIN ---"
        echo "build: gcc=$(p gcc) cc=$(p cc) clang=$(p clang) make=$(p make) as=$(p as)"
        echo "python: py3=$(p python3) py2=$(p python2) perl=$(p perl)"
        echo "debug: strace=$(p strace) gdb=$(p gdb) objdump=$(p objdump) readelf=$(p readelf)"
        echo "net: nft=$(p nft) iptables=$(p iptables) socat=$(p socat) nc=$(p nc)"
        echo "mfx: $(ls /usr/lib*/libmfx* /usr/lib/x86_64-linux-gnu/libmfx* /usr/lib64/libmfx* 2>/dev/null | head -3 | tr '\n' ' ')"
        echo "--- USBMON ---"
        echo "modules: $(ls /lib/modules 2>/dev/null | head -2 | tr '\n' ' ')"
        echo "usbmon.ko: $(find /lib/modules -name 'usbmon*' 2>/dev/null | head -2 | tr '\n' ' ')"
        echo "debugfs usb: $(ls /sys/kernel/debug/usb 2>/dev/null | tr '\n' ' ')"
        echo "dev usbmon: $(ls /dev 2>/dev/null | grep -c usbmon)"
        echo "--- BINARIES ---"
        for b in carlife aapd carplay sdlpd mdnsd; do
            [ -e "/usr/bin/$b" ] && ls -l "/usr/bin/$b" 2>/dev/null | awk '{print $5, $NF}'
        done
        echo "--- NOTE ---"
        echo "usb>0: video rides on USB bulk (usbfs), not TCP."
        echo "no decoder lib on carlife: H.264 leaves it to another process (see sockets)."
        echo "no usbmon.ko: passive USB capture is closed on this kernel."
    } > "$W/r" 2>/dev/null
    chmod 0644 "$W/r" 2>/dev/null
    if [ -f "$OUT" ] && cmp -s "$W/r" "$OUT" 2>/dev/null; then
        :   # unchanged: leave the mtime alone, the app reads what is there
    else
        mv -f "$W/r" "$OUT" 2>/dev/null
        cp -f "$OUT" "$FULL" 2>/dev/null
    fi
    rm -rf "$W"
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
    # An install over a running probe leaves the old loop reading its own copy:
    # the one-shot a postInstall runs hands over to this script's loop. Bounded,
    # so a stuck systemctl never holds the install open (it warns instead).
    if command -v systemctl >/dev/null 2>&1; then
        if command -v timeout >/dev/null 2>&1; then
            timeout 10 systemctl try-restart carlife-probe-root.service 2>/dev/null
        else
            systemctl try-restart carlife-probe-root.service 2>/dev/null
        fi
    fi
    ;;
esac
exit 0
