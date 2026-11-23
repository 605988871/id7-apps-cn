#!/bin/sh
# carlife-wireless: take the phone's CarLife H.264 stream over WiFi and hand
# full-frame pictures to the JS app on a unix socket.
#
# Joining the hotspot is NOT done here. MGU Store's own Wi-Fi page (Settings
# -> Wi-Fi, backed by mgu-uplink) does that: it joins on the car's wlan0
# through the car's supplicant without disturbing the car's hotspot or
# wireless CarPlay. Once it is online, /run/mgu-uplink/lease.json carries the
# hotspot gateway - which is the phone - so no IP has to be typed anywhere.
# A hand-entered address in $HOST_FILE still overrides that as a fallback.
#
# Two programs, one pipeline:
#   carlife-link   --host <phone> --seconds 0 --video - --report link.txt
#       connects the six TCP ports, does the version handshake, asks for video,
#       and writes the raw Annex-B H.264 to stdout.
#   carlife-decode --stdin --dir /dev/shm/carlife-wireless
#       reads that stream from stdin, decodes with the unit's MSDK, and writes
#       CLMF frames to /dev/shm/carlife-wireless/live.sock (1280x720 per crop.json).
#
# The link's ctl socket (127.0.0.1:7399) is where the app sends taps back to
# the phone. Nothing here touches the car's own carlife process, so this cannot
# cause the head-unit restarts the USB approach did.
set -e

HERE=$(cd "$(dirname "$0")" 2>/dev/null && pwd)
LINK="$HERE/carlife-link"
DECODE="$HERE/carlife-decode"
DIR=/dev/shm/carlife-wireless
HOST_FILE="$DIR/host"
LEASE=/run/mgu-uplink/lease.json
PHONE=${CARLIFE_HOST:-}
PORT=${CARLIFE_PORT:-7240}

mkdir -p "$DIR"
chmod 0777 "$DIR"
# The linker runs as an unprivileged uid below: it cannot overwrite a report
# left behind by an earlier root run. Start with a clean one.
rm -f "$DIR/link.txt" 2>/dev/null || true

# The uplink lease names the gateway of the network it joined - the phone's
# hotspot. Read it first so joining in MGU Store is all the owner has to do.
# sed, not node: this runs before any app is up and is retried every 5 s.
if [ -z "$PHONE" ] && [ -f "$LEASE" ]; then
    PHONE=$(sed -n 's/.*"router"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$LEASE" | head -1 | tr -d ' \r\n')
fi

# Older setups, or a unit without mgu-uplink: the app may have written the
# address into the shm file. It wins over the lease when present.
if [ -z "$PHONE" ] && [ -f "$HOST_FILE" ]; then
    PHONE=$(head -1 "$HOST_FILE" | tr -d ' \r\n')
fi

# No address yet: the phone is not connected. Exit so systemd retries; the
# app's status page says "waiting" the whole time, with no black-screen mystery.
if [ -z "$PHONE" ]; then
    echo "carlife-wireless: no phone address (join the hotspot in MGU Store -> Settings -> Wi-Fi)" >&2
    exit 3
fi

# crop.json lives beside the binaries in the installed version directory; the
# decoder reads it from the shm dir, so keep a copy there where it is writable.
cp "$HERE/crop.json" "$DIR/crop.json" 2>/dev/null || true

echo "carlife-wireless: connecting to $PHONE:$PORT" >&2

# mgu-uplink's firewall only lets whitelisted uids send out of the WiFi
# interface, and it never whitelists root. component.json declares uid 65534
# for this tool, and --drop-uid makes the linker (the only process here that
# opens TCP sockets) switch to it inside the binary - no reliance on setpriv
# or su being installed on the unit. The decoder stays root: it needs the
# car's MSDK/GPU but opens no network socket.
LINK_UID=65534

# Run the pipeline with both children visible so that the death of either one
# ends the group and systemd restarts both together. A bare `a | b` would leave
# the shell alive when one side dies, leaving a half-broken session up.
"$LINK" run --host "$PHONE" --port "$PORT" --seconds 0 \
    --video - --report "$DIR/link.txt" --ctl 7399 --drop-uid "$LINK_UID" &
link_pid=$!
"$DECODE" --stdin --dir "$DIR" &
decode_pid=$!

trap 'kill "$link_pid" "$decode_pid" 2>/dev/null || true' EXIT INT TERM

# Wait for either to finish. `wait -n` is not in the unit's old bash, so poll.
while kill -0 "$link_pid" 2>/dev/null && kill -0 "$decode_pid" 2>/dev/null; do
    sleep 1
done

echo "carlife-wireless: a pipeline stage ended, restarting" >&2
exit 4
