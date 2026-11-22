#!/bin/sh
# carlife-shim (root) 0.1.0 - runs after every install from the Store.
#
# This is the only tool in this repository that touches a unit it does not own:
# it puts LD_PRELOAD into whatever service runs /usr/bin/carlife. The car cannot
# do without that process, so everything here is written with the assumption
# that it will go wrong on the first try on some unit:
#
#   1. prove the library loads *on this unit* first, with /bin/true. A .so built
#      against a newer glibc fails here, before carlife is ever restarted, and
#      the reason lands in boot.txt.
#   2. find the unit by asking the running process (its cgroup) rather than by
#      guessing a name. Falling back to scanning for ExecStart=...carlife.
#   3. drop a file into /etc/systemd/system/<unit>.d - never the unit itself, so
#      removing one file is the whole rollback.
#   4. restart, then *look*: is the library in the new process's maps, and did
#      the process survive for two seconds? If not, remove the drop-in, restart
#      again, and say so. An uninstallable tool that leaves carlife down is
#      worse than no tool.
#
# What happened goes to /dev/shm/carlife-shim/boot.txt, which the probe app can
# show: a shim that failed to load is a line on the screen, not a guess.
set -u

CUR=/var/opt/carlife-shim/current
SO=$CUR/carlife-shim.so
UNIT_FILE=$CUR/unit.txt
SHM=/dev/shm/carlife-shim
BOOT=$SHM/boot.txt

mkdir -p "$SHM" 2>/dev/null
chmod 0777 "$SHM" 2>/dev/null
chmod 0644 "$SO" 2>/dev/null

note() { printf '%s\n' "$*"; }

# 1 ---------------------------------------------------------------------------
# /bin/sh rather than /bin/true: some units only have the shell, and the point
# is the loader, not the payload.
LOADTEST=$(LD_PRELOAD="$SO" /bin/sh -c ':' 2>&1 | head -2 | tr '\n' ' ')
[ -z "$LOADTEST" ] && LOADTEST=ok

if [ "$LOADTEST" != ok ]; then
    {
        note "=== CARLIFE SHIM INSTALL ==="
        note "state: not installed - the library does not load"
        note "so: $SO"
        note "loadtest: $LOADTEST"
        note "carlife: untouched"
    } > "$BOOT.tmp" 2>/dev/null && mv "$BOOT.tmp" "$BOOT" 2>/dev/null
    chmod 0644 "$BOOT" 2>/dev/null
    echo "carlife-shim: library does not load: $LOADTEST"
    exit 0
fi

# 2 ---------------------------------------------------------------------------
PID=$(pidof carlife 2>/dev/null | awk '{print $1}')
UNIT=''
if [ -n "${PID:-}" ] && [ -r "/proc/$PID/cgroup" ]; then
    UNIT=$(tr '/' '\n' < "/proc/$PID/cgroup" 2>/dev/null | grep -E '\.service$' | head -1)
fi
if [ -z "$UNIT" ]; then
    for f in /etc/systemd/system/*.service /lib/systemd/system/*.service; do
        [ -r "$f" ] || continue
        if grep -qE '^ExecStart=.*(/| )carlife' "$f" 2>/dev/null; then
            UNIT=$(basename "$f")
            break
        fi
    done
fi

if [ -z "$UNIT" ]; then
    {
        note "=== CARLIFE SHIM INSTALL ==="
        note "state: not installed - no service runs carlife"
        note "pid: ${PID:-none}"
        note "hint: the HMI may start carlife itself; this tool only knows systemd"
    } > "$BOOT.tmp" 2>/dev/null && mv "$BOOT.tmp" "$BOOT" 2>/dev/null
    chmod 0644 "$BOOT" 2>/dev/null
    echo "carlife-shim: no unit found for carlife, nothing changed"
    exit 0
fi

# 3 ---------------------------------------------------------------------------
D=/etc/systemd/system/"$UNIT".d
mkdir -p "$D" 2>/dev/null
{
    note "# carlife-shim: watch, then replace, the USB transport (see README)"
    note "[Service]"
    note "Environment=LD_PRELOAD=$SO"
} > "$D/carlife-shim.conf" 2>/dev/null
printf '%s\n' "$UNIT" > "$UNIT_FILE" 2>/dev/null

systemctl daemon-reload 2>/dev/null
systemctl restart "$UNIT" 2>/dev/null

# 4 ---------------------------------------------------------------------------
# Two seconds is enough for a restarting process to either come up with the
# library or fall over with it; checking sooner just reads the old pid.
sleep 2
NEW=$(pidof carlife 2>/dev/null | awk '{print $1}')
STATE=$(systemctl is-active "$UNIT" 2>/dev/null)
MAPS=no
[ -n "${NEW:-}" ] && grep -q 'carlife-shim' "/proc/$NEW/maps" 2>/dev/null && MAPS=yes

if [ "$MAPS" != yes ]; then
    rm -f "$D/carlife-shim.conf" 2>/dev/null
    rmdir "$D" 2>/dev/null
    systemctl daemon-reload 2>/dev/null
    systemctl restart "$UNIT" 2>/dev/null
    sleep 2
    BACK=$(pidof carlife 2>/dev/null | awk '{print $1}')
    [ -n "${BACK:-}" ] || systemctl start "$UNIT" 2>/dev/null
    {
        note "=== CARLIFE SHIM INSTALL ==="
        note "state: rolled back - the library did not reach the process"
        note "unit: $UNIT"
        note "loadtest: $LOADTEST"
        note "after restart: pid ${NEW:-none}, unit $STATE, in maps: $MAPS"
        note "carlife now: pid ${BACK:-none} - started again without the drop-in"
    } > "$BOOT.tmp" 2>/dev/null && mv "$BOOT.tmp" "$BOOT" 2>/dev/null
    chmod 0644 "$BOOT" 2>/dev/null
    echo "carlife-shim: rolled back, $UNIT now has pid ${BACK:-none}"
    exit 0
fi

{
    note "=== CARLIFE SHIM INSTALL ==="
    note "state: watching"
    note "unit: $UNIT"
    note "drop-in: $D/carlife-shim.conf"
    note "so: $SO"
    note "pid: $NEW  unit: $STATE  in maps: $MAPS"
    note "tap: $SHM/tap.txt"
} > "$BOOT.tmp" 2>/dev/null && mv "$BOOT.tmp" "$BOOT" 2>/dev/null
chmod 0644 "$BOOT" 2>/dev/null

# the files the app reads
chmod 0644 "$SHM"/*.txt 2>/dev/null
echo "carlife-shim: watching $UNIT (pid $NEW)"
exit 0
