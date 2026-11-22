#!/bin/sh
# carlife-probe (root) 0.1.0 - runs after every install from the Store.
#
# Same three steps as carlife-link's installer, for the same reason: a unit that
# cannot start is present, enabled and still silent, so prove it first, then
# reload, then restart (enabling alone only takes effect at the next boot).
#
# The selftest is the important one here: the probe is a shell script reading
# /proc, and the only way it fails invisibly is a missing tool (ss, ip, date).
# Running it once and keeping the first lines in boot.txt turns that into one
# line on the screen instead of an empty report.
set -u

CUR=/var/opt/carlife-probe/current
SHM=/dev/shm/carlife-probe
BOOT=$SHM/boot.txt

mkdir -p "$SHM" 2>/dev/null
chmod 0777 "$SHM" 2>/dev/null          # the app reads the report as itself

chmod 0755 "$CUR/probe.sh" 2>/dev/null
SELFTEST=$(/bin/sh "$CUR/probe.sh" 2>&1 | head -3 | tr '\n' ' ')
case "$SELFTEST" in
    *verdict*) : ;;
    *) SELFTEST="failed: $SELFTEST" ;;
esac

systemctl daemon-reload 2>/dev/null
systemctl enable carlife-probe.service 2>/dev/null
systemctl restart carlife-probe.service 2>/dev/null
STATE=$(systemctl is-active carlife-probe.service 2>/dev/null)
[ -n "$STATE" ] || STATE=-

{
    echo "=== CARLIFE PROBE INSTALL ==="
    echo "script: $CUR/probe.sh"
    echo "unit: /etc/systemd/system/carlife-probe.service"
    echo "state: $STATE"
    echo "report: $SHM/report.txt"
    echo "selftest: $SELFTEST"
} > "$BOOT.tmp" 2>/dev/null && mv "$BOOT.tmp" "$BOOT" 2>/dev/null
chmod 0644 "$BOOT" 2>/dev/null

# the install succeeds either way: a probe that cannot start is a line in
# boot.txt, and uninstalling the app must never leave the unit behind
if [ "$STATE" != active ]; then
    echo "carlife-probe: unit is $STATE"
    systemctl status --no-pager carlife-probe.service 2>&1 | tail -n 5
fi
exit 0
