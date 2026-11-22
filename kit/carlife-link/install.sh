#!/bin/sh
# carlife-link (root) 0.1.0 - runs after every install from the Store.
#
# Three things, in this order, because each one is invisible from the outside
# when it fails:
#
#   1. prove the binary starts *on this unit*. A program built for the wrong
#      loader is present, executable, and still fails with ENOENT ("Failed at
#      step EXEC spawning") - carlife-tap 0.4.4 shipped exactly that and cost a
#      build and a drive to find.
#   2. daemon-reload, because the unit file is new or changed.
#   3. enable *and* restart: enabling only takes effect at the next boot, and
#      try-restart does nothing to a unit that is not active.
#
# What it found goes to /dev/shm/carlife-wireless/boot.txt, which the app can
# show: a link that cannot start is one line on the screen instead of a guess.
set -u

CUR=/var/opt/carlife-link/current
SHM=/dev/shm/carlife-wireless
BOOT=$SHM/boot.txt

mkdir -p "$SHM" 2>/dev/null
chmod 0777 "$SHM" 2>/dev/null          # the app reads the report as itself

BIN=$CUR/carlife-link
chmod 0755 "$BIN" 2>/dev/null
SELFTEST=$("$BIN" --help 2>&1 | head -1)
[ -n "$SELFTEST" ] || SELFTEST="failed: $("$BIN" --help 2>&1 | tail -1)"

systemctl daemon-reload 2>/dev/null
systemctl enable carlife-link.service 2>/dev/null
systemctl restart carlife-link.service 2>/dev/null
STATE=$(systemctl is-active carlife-link.service 2>/dev/null)
[ -n "$STATE" ] || STATE=-

{
    echo "=== CARLIFE LINK INSTALL ==="
    echo "exec: $BIN"
    echo "unit: /etc/systemd/system/carlife-link.service"
    echo "state: $STATE"
    echo "report: $SHM/report.txt"
    echo "selftest: $SELFTEST"
} > "$BOOT.tmp" 2>/dev/null && mv "$BOOT.tmp" "$BOOT" 2>/dev/null
chmod 0644 "$BOOT" 2>/dev/null

# the install succeeds either way: a link that cannot start is a line in the
# report, and uninstalling the app must never leave the tool behind
if [ "$STATE" != active ]; then
    echo "carlife-link: unit is $STATE"
    systemctl status --no-pager carlife-link.service 2>&1 | tail -n 5
fi
exit 0
