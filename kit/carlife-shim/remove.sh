#!/bin/sh
# carlife-shim - remove the drop-in and nothing else.
#
# The whole installation is one file in /etc/systemd/system/<unit>.d plus this
# directory, so this is the reverse of install.sh and nothing more: delete the
# file, reload, restart the unit that was recorded at install time. If the unit
# name was not recorded, ask the running process again.
set -u

CUR=/var/opt/carlife-shim/current
UNIT_FILE=$CUR/unit.txt
SHM=/dev/shm/carlife-shim

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

if [ -n "${UNIT:-}" ]; then
    rm -f /etc/systemd/system/"$UNIT".d/carlife-shim.conf 2>/dev/null
    rmdir /etc/systemd/system/"$UNIT".d 2>/dev/null
    systemctl daemon-reload 2>/dev/null
    systemctl try-restart "$UNIT" 2>/dev/null
fi
rm -f "$UNIT_FILE" 2>/dev/null

mkdir -p "$SHM" 2>/dev/null
{
    echo "=== CARLIFE SHIM REMOVED ==="
    echo "unit: ${UNIT:-unknown}"
    echo "carlife: restarted without the drop-in"
} > "$SHM/boot.txt.tmp" 2>/dev/null && mv "$SHM/boot.txt.tmp" "$SHM/boot.txt" 2>/dev/null
chmod 0644 "$SHM/boot.txt" 2>/dev/null
echo "carlife-shim: removed (unit ${UNIT:-unknown})"
exit 0
