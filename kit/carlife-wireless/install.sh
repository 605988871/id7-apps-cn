#!/bin/sh
# carlife-wireless: prove the two binaries run on this unit, make the shared
# folder, and bring up the service. Run as root by the Store from the version
# directory it just unpacked. Nothing here changes a file the unit owns: one
# service and one folder under /dev/shm, both removed on uninstall.
set -e

HERE=$(cd "$(dirname "$0")" 2>/dev/null && pwd)
LINK="$HERE/carlife-link"
DECODE="$HERE/carlife-decode"
BRIDGE="$HERE/wifi-bridge"
RUN="$HERE/run.sh"
DIR=/dev/shm/carlife-wireless
BOOT=/dev/shm/carlife-wireless-boot.txt

say() { echo "carlife-wireless: $*"; }
boot() { printf '%s\n' "$*" >> "$BOOT" 2>/dev/null || true; }

for f in "$LINK" "$DECODE" "$BRIDGE" "$RUN"; do
    [ -f "$f" ] || { echo "carlife-wireless: $f is missing from the package"; exit 1; }
done

printf '' > "$BOOT" 2>/dev/null || BOOT=/tmp/carlife-wireless-boot.txt
if read -r UP _ < /proc/uptime 2>/dev/null; then boot "uptime: $UP"; fi

# The decoder (root) listens on live.sock, the app listens on its ctl and reads
# the frames: creating a unix socket needs write permission on the directory.
# 0777 after mkdir, because a service umask of 022 leaves 0755 and listen()
# then fails with EACCES - which reads as "the decoder never came".
if mkdir -p "$DIR" 2>/dev/null; then
    chmod 0777 "$DIR" 2>/dev/null || true
    boot "shm: $DIR $(ls -ld "$DIR" 2>/dev/null | cut -c1-10)"
else
    boot "shm: $DIR cannot be created"
fi

chmod 0755 "$LINK" "$DECODE" "$BRIDGE" "$RUN" 2>/dev/null || true
cp "$HERE/crop.json" "$DIR/crop.json" 2>/dev/null || true

# A binary can be present and executable and still fail because the ELF
# interpreter named inside it is not on the unit. selftest proves it runs
# without opening anything or changing state.
for pair in "link:$LINK" "decode:$DECODE" "bridge:$BRIDGE"; do
    TAG=${pair%%:*}
    BIN=${pair#*:}
    RC=0
    if command -v timeout >/dev/null 2>&1; then
        OUT=$(timeout 10 "$BIN" --selftest 2>&1) || RC=$?
    else
        OUT=$("$BIN" --selftest 2>&1) || RC=$?
    fi
    if [ "$RC" = 0 ]; then
        boot "exec $TAG: runs ($OUT)"
    else
        boot "exec $TAG: will not run (rc $RC): $(printf '%s' "$OUT" | head -1)"
    fi
done

# The app writes the phone's hotspot address here once connected; until then
# the service exits and retries. Start with no file so a stale address cannot
# make it dial a phone that is not there.
rm -f "$DIR/host" 2>/dev/null || true

if command -v systemctl >/dev/null 2>&1; then
    systemctl daemon-reload 2>/dev/null || true
    systemctl enable carlife-wireless.service >/dev/null 2>&1 || true
    systemctl enable carlife-wifi.service >/dev/null 2>&1 || true
    if command -v timeout >/dev/null 2>&1; then
        timeout 15 systemctl restart carlife-wireless.service >/dev/null 2>&1 || true
    else
        systemctl restart carlife-wireless.service >/dev/null 2>&1 || true
    fi
    if command -v timeout >/dev/null 2>&1; then
        timeout 15 systemctl restart carlife-wifi.service >/dev/null 2>&1 || true
    else
        systemctl restart carlife-wifi.service >/dev/null 2>&1 || true
    fi
    sleep 1
    BSTATE=$(systemctl is-active carlife-wifi.service 2>/dev/null) || BSTATE=unknown
    boot "state carlife-wifi.service: $BSTATE"
    STATE=$(systemctl is-active carlife-wireless.service 2>/dev/null) || STATE=unknown
    [ -n "$STATE" ] || STATE=unknown
    boot "state carlife-wireless.service: $STATE"
    if [ "$STATE" != active ]; then
        systemctl status --no-pager -l carlife-wireless.service 2>&1 | tail -6 >> "$BOOT" 2>/dev/null || true
    fi
fi

say "installed: $DIR"
say "join the phone hotspot in the CarLife Wireless app (or MGU Store -> Settings -> Wi-Fi)"
say "reports: $DIR/link.txt, /dev/shm/carlife-wireless-decode.txt and $BOOT"
