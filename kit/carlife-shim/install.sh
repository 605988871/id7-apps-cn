#!/bin/sh
# carlife-shim (root) 0.6.0 - runs after every install from the Store.
#
# This is the only tool in this repository that touches a unit it does not own:
# it puts LD_PRELOAD into whatever service runs /usr/bin/carlife. The car cannot
# do without that process, so everything here is written with the assumption
# that it will go wrong on the first try on some unit:
#
#   1. prove the library loads *on this unit* first, with /bin/sh. A .so built
#      against a newer glibc fails here, before carlife is ever restarted, and
#      the reason lands in the record.
#   2. find the unit by asking the running process (its cgroup) rather than by
#      guessing a name. Falling back to scanning for ExecStart=...carlife.
#   3. remount / read-write if it is not: /etc/systemd/system lives on the root
#      file system, which ships read-only. Without this every write below fails
#      silently and the drop-in is simply never there - the same failure the
#      Store's own renderer install guards against with the same remount.
#   4. drop a file into /etc/systemd/system/<unit>.d - never the unit itself, so
#      removing one file is the whole rollback.
#   5. restart, then *look*: is the library in the new process's maps, and did
#      the process survive for two seconds? If not, remove the drop-in, restart
#      again, and say so. An uninstallable tool that leaves carlife down is
#      worse than no tool.
#
# What happened goes to two places: /var/opt/carlife-shim/current/boot.txt, which
# survives a reboot, and /dev/shm/carlife-shim/boot.txt, which the app reads.
# The shm copy on its own was a mistake: /dev/shm is empty after every boot, and
# a boot is exactly when the record is needed.
set -u

CUR=/var/opt/carlife-shim/current
SO=$CUR/carlife-shim.so
UNIT_FILE=$CUR/unit.txt
SHM=/dev/shm/carlife-shim
BOOT=$SHM/boot.txt
DROPNAME=carlife-shim.conf

mkdir -p "$SHM" 2>/dev/null
chmod 0777 "$SHM" 2>/dev/null
chmod 0644 "$SO" 2>/dev/null

note() { printf '%s\n' "$*"; }

# One body, two destinations: /var/opt keeps it across a reboot, /dev/shm is what
# the probe reads first. Losing the record made an install that failed look like
# an install that never happened, which is a different repair.
record() {
    body=$(cat)
    printf '%s\n' "$body" > "$CUR/boot.txt.tmp" 2>/dev/null && mv -f "$CUR/boot.txt.tmp" "$CUR/boot.txt" 2>/dev/null
    printf '%s\n' "$body" > "$BOOT.tmp" 2>/dev/null && mv -f "$BOOT.tmp" "$BOOT" 2>/dev/null
    chmod 0644 "$CUR/boot.txt" "$BOOT" 2>/dev/null
}

# 1 ---------------------------------------------------------------------------
LOADTEST=$(LD_PRELOAD="$SO" /bin/sh -c ':' 2>&1 | head -2 | tr '\n' ' ')
[ -z "$LOADTEST" ] && LOADTEST=ok

if [ "$LOADTEST" != ok ]; then
    {
        note "=== CARLIFE SHIM INSTALL ==="
        note "state: not installed - the library does not load"
        note "so: $SO"
        note "loadtest: $LOADTEST"
        note "carlife: untouched"
    } | record
    echo "carlife-shim: library does not load: $LOADTEST"
    exit 0
fi

# 2 ---------------------------------------------------------------------------
# The load test ran the library inside /bin/sh a moment ago, and the library
# writes its own files on load: that shell's pid is in state.txt and tap.txt has
# been truncated. Left there it reads like "carlife has the shim" with the pid of
# a process that has already exited - the worst kind of wrong answer.
rm -f "$SHM/state.txt" "$SHM/state.txt.tmp" "$SHM/tap.txt" \
      "$SHM/head.txt" "$SHM/head.tmp" 2>/dev/null

PID=$(pidof carlife 2>/dev/null | awk '{print $1}')
UNIT=''
CGROUP=''
if [ -n "${PID:-}" ] && [ -r "/proc/$PID/cgroup" ]; then
    CGROUP=$(tr '\n' ' ' < "/proc/$PID/cgroup" 2>/dev/null)
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
        note "cgroup: ${CGROUP:-none}"
        note "hint: carlife was started by another process, not by systemd, so a"
        note "hint: drop-in has nothing to attach to - nothing was changed"
    } | record
    echo "carlife-shim: no unit found for carlife, nothing changed"
    exit 0
fi

# 3 ---------------------------------------------------------------------------
# Probe the root file system by writing to it: `mount` can report rw on a file
# system that still refuses new files, and a write that did not happen must not
# be followed by a restart of the one process the car needs.
RW=0
if ! { touch /etc/systemd/system/.carlife-shim-rw 2>/dev/null &&
       rm -f /etc/systemd/system/.carlife-shim-rw; }; then
    mount -o remount,rw / 2>/dev/null && RW=1
fi

D=/etc/systemd/system/"$UNIT".d
mkdir -p "$D" 2>/dev/null
{
    note "# carlife-shim: watch, then replace, the USB transport (see README)"
    note "[Service]"
    note "Environment=LD_PRELOAD=$SO"
} > "$D/$DROPNAME" 2>/dev/null

# Read it back before trusting it.
if [ ! -r "$D/$DROPNAME" ]; then
    [ $RW = 1 ] && mount -o remount,ro / 2>/dev/null
    {
        note "=== CARLIFE SHIM INSTALL ==="
        note "state: not installed - /etc is read only"
        note "unit: $UNIT"
        note "tried: $D/$DROPNAME"
        note "rootfs: $(awk '$2=="/"{print $4}' /proc/mounts 2>/dev/null | head -1)"
        note "carlife: untouched"
    } | record
    echo "carlife-shim: cannot write $D/$DROPNAME, nothing changed"
    exit 0
fi
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
    rm -f "$D/$DROPNAME" 2>/dev/null
    rmdir "$D" 2>/dev/null
    systemctl daemon-reload 2>/dev/null
    systemctl restart "$UNIT" 2>/dev/null
    sleep 2
    BACK=$(pidof carlife 2>/dev/null | awk '{print $1}')
    [ -n "${BACK:-}" ] || systemctl start "$UNIT" 2>/dev/null
    [ $RW = 1 ] && sync 2>/dev/null && mount -o remount,ro / 2>/dev/null
    {
        note "=== CARLIFE SHIM INSTALL ==="
        note "state: rolled back - the library did not reach the process"
        note "unit: $UNIT"
        note "loadtest: $LOADTEST"
        note "after restart: pid ${NEW:-none}, unit $STATE, in maps: $MAPS"
        note "carlife now: pid ${BACK:-none} - started again without the drop-in"
    } | record
    echo "carlife-shim: rolled back, $UNIT now has pid ${BACK:-none}"
    exit 0
fi

[ $RW = 1 ] && sync 2>/dev/null && mount -o remount,ro / 2>/dev/null

{
    note "=== CARLIFE SHIM INSTALL ==="
    note "state: watching"
    note "unit: $UNIT"
    note "drop-in: $D/$DROPNAME"
    note "so: $SO"
    note "pid: $NEW  unit: $STATE  in maps: $MAPS"
    note "tap: $SHM/tap.txt"
} | record

# the files the app reads
chmod 0644 "$SHM"/*.txt 2>/dev/null
echo "carlife-shim: watching $UNIT (pid $NEW)"
exit 0
