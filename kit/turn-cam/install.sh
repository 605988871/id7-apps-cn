#!/bin/sh
# turn-cam: make the folder the app and the two programs share, prove both
# binaries run on this unit, and have them up.
#
# Run as root by the Store from the version directory it just unpacked. Nothing
# here changes a file the unit owns: the tool adds two services and one folder
# under /dev/shm, and all three go away with it.
set -e

HERE=$(cd "$(dirname "$0")" 2>/dev/null && pwd)
CAM="$HERE/turn-cam"
DEC="$HERE/turn-decode"
DIR=/dev/shm/turn-view
BOOT=/dev/shm/turn-cam-boot.txt

say() { echo "turn-cam: $*"; }
boot() { printf '%s\n' "$*" >> "$BOOT" 2>/dev/null || true; }

for f in "$CAM" "$DEC"; do
    [ -f "$f" ] || { echo "turn-cam: $f is missing from the package"; exit 1; }
done

printf '' > "$BOOT" 2>/dev/null || BOOT=/tmp/turn-cam-boot.txt
if read -r UP _ < /proc/uptime 2>/dev/null; then boot "uptime: $UP"; fi

# /dev/shm is emptied on every boot, and this folder is where three processes
# meet: the decoder runs as root and listens on h264.sock, the app runs as
# itself and listens on live.sock. Creating a unix socket needs write permission
# on the directory, so 0777 after mkdir: a service umask of 022 leaves 0755 and
# the app's listen() then fails with EACCES, which reads as "address in use".
if mkdir -p "$DIR" 2>/dev/null; then
    chmod 0777 "$DIR" 2>/dev/null || true
    boot "shm: $DIR $(ls -ld "$DIR" 2>/dev/null | cut -c1-10)"
else
    boot "shm: $DIR cannot be created"
fi

chmod 0755 "$CAM" "$DEC" 2>/dev/null || true

# Run them, do not look at them: a file can be present and executable and still
# fail to start because the ELF interpreter named inside it is not on the unit.
for pair in "cam:$CAM" "decode:$DEC"; do
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

start() {
    UNIT=$1
    STATE=none
    systemctl daemon-reload 2>/dev/null || true
    systemctl enable "$UNIT" >/dev/null 2>&1 || true
    if command -v timeout >/dev/null 2>&1; then
        timeout 15 systemctl restart "$UNIT" >/dev/null 2>&1 || true
    else
        systemctl restart "$UNIT" >/dev/null 2>&1 || true
    fi
    sleep 1
    STATE=$(systemctl is-active "$UNIT" 2>/dev/null) || STATE=unknown
    [ -n "$STATE" ] || STATE=unknown
    boot "state $UNIT: $STATE"
    if [ "$STATE" != active ]; then
        systemctl status --no-pager -l "$UNIT" 2>&1 | tail -6 >> "$BOOT" 2>/dev/null || true
    fi
}

if command -v systemctl >/dev/null 2>&1; then
    # The decoder first: turn-cam connects to its socket and would otherwise
    # spend its first seconds looking for one.
    start turn-decode.service
    start turn-cam.service
fi

say "installed: $DIR, receiver on media_transport.avb_streaming.1"
say "reports: $DIR/turn-cam.txt and /dev/shm/turn-view-decode.txt"
say "both say 'waiting' until the app asks the camera for a view"
