#!/bin/sh
# carlife-shim 0.2.0 - remove the drop-in and nothing else.
#
# The whole installation is one file in /etc/systemd/system/<unit>.d plus this
# directory, so this is the reverse of install.sh and nothing more: delete the
# file, reload, restart the unit that was recorded at install time. If the unit
# name was not recorded, ask the running process again.
#
# Same read-only root as the install: without a remount the delete fails quietly
# and the shim would come back at the next boot.
set -u

CUR=/var/opt/carlife-shim/current
UNIT_FILE=$CUR/unit.txt
SHM=/dev/shm/carlife-shim
BOOT=$SHM/boot.txt

UNIT=$(cat "$UNIT_FILE" 2>/dev/null | head -1)
if [ -z "${UNIT:-}" ]; then
    PID=$(pidof carlife 2>/dev/null | awk '{print $1}')
    [ -n "${PID:-}" ] && UNIT=$(tr '/' '\n' < "/proc/$PID/cgroup" 2>/dev/null | grep -E '\.service$' | head -1)
fi
if [ -z "${UNIT:-}" ]; then
    for f in /etc/systemd/system/*.service /lib/systemd/system/*.service; do
        [ -r "$f" ] || continue
        if grep -qE '^ExecStart=.*(/| )carlife' "$f" 2>/dev/null; then
            UNIT=$(basename "$f")
            break
        fi
    done
fi

RW=0
GONE=yes
if [ -n "${UNIT:-}" ]; then
    if ! { touch /etc/systemd/system/.carlife-shim-rw 2>/dev/null &&
           rm -f /etc/systemd/system/.carlife-shim-rw; }; then
        mount -o remount,rw / 2>/dev/null && RW=1
    fi
    rm -f /etc/systemd/system/"$UNIT".d/carlife-shim.conf 2>/dev/null
    rmdir /etc/systemd/system/"$UNIT".d 2>/dev/null
    [ -e /etc/systemd/system/"$UNIT".d/carlife-shim.conf ] && GONE=no
    systemctl daemon-reload 2>/dev/null
    systemctl try-restart "$UNIT" 2>/dev/null
    [ $RW = 1 ] && sync 2>/dev/null && mount -o remount,ro / 2>/dev/null
fi
rm -f "$UNIT_FILE" 2>/dev/null

mkdir -p "$SHM" 2>/dev/null
record() {
    body=$(cat)
    printf '%s\n' "$body" > "$CUR/boot.txt.tmp" 2>/dev/null && mv -f "$CUR/boot.txt.tmp" "$CUR/boot.txt" 2>/dev/null
    printf '%s\n' "$body" > "$BOOT.tmp" 2>/dev/null && mv -f "$BOOT.tmp" "$BOOT" 2>/dev/null
    chmod 0644 "$CUR/boot.txt" "$BOOT" 2>/dev/null
}
{
    echo "=== CARLIFE SHIM REMOVED ==="
    echo "unit: ${UNIT:-unknown}"
    echo "drop-in: $([ "$GONE" = yes ] && echo removed || echo still-there)"
    echo "carlife: restarted without the drop-in"
} | record
echo "carlife-shim: removed (unit ${UNIT:-unknown}, drop-in $GONE)"
exit 0
