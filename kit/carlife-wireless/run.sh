#!/bin/sh
# carlife-wireless: take the phone's CarLife H.264 stream over WiFi and hand
# full-frame pictures to the JS app on a unix socket.
#
# Joining the hotspot is done from the app (wifi-bridge -> mgu-uplink), not
# here. find-phone.sh works out the phone's address from whatever the unit
# knows about the network; see that script for the six sources and their
# order. The address may not exist yet: in that case carlife-link runs in
# discovery mode and picks the phone up by itself once wlan0 has an address.
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
FINDER="$HERE/find-phone.sh"
DIR=${CARLIFE_DIR:-/dev/shm/carlife-wireless}
RUN_TXT="$DIR/run.txt"
PORT=${CARLIFE_PORT:-7240}

mkdir -p "$DIR"
chmod 0777 "$DIR"

# 0.5.0 used to delete link.txt on every start. When either half of the
# pipeline died (a decoder with no MSDK, for instance) systemd restarted us
# five seconds later and deleted the report again, so the app could only ever
# say "not started" - even though carlife-link had reported a real reason.
# Keep the report: write_report() uses tmp+rename in a 0777 directory, so an
# unprivileged link can replace a file an earlier root run left behind.
rm -f "$DIR/link.txt.tmp" 2>/dev/null || true

# A short, stable report of what THIS launcher did. The app reads it when
# link.txt is missing, which is the only way to tell "the service never ran"
# from "the service ran but could not find the phone" on a car with no SSH.
write_run() {
    _state=$1
    _detail=$2
    _tmp="$RUN_TXT.tmp"
    {
        printf 'state: %s\n' "$_state"
        printf 'phone: %s\n' "${PHONE:-none}"
        printf 'source: %s\n' "${PHONE_SRC:-none}"
        printf 'port: %s\n' "$PORT"
        printf 'uptime: %s\n' "$(cut -d' ' -f1 /proc/uptime 2>/dev/null || echo '?')"
        printf 'detail: %s\n' "$_detail"
    } > "$_tmp" 2>/dev/null || true
    mv -f "$_tmp" "$RUN_TXT" 2>/dev/null || true
}

if [ -f "$FINDER" ]; then
    # `sh`, not a direct exec: the version directory must be executable for
    # the ELF helpers anyway, but a read-only/noexec mount would otherwise
    # cost us the address discovery for no reason.
    FOUND=$(sh "$FINDER" 2>/dev/null) || FOUND=""
else
    # A component update that somehow missed find-phone.sh: still read the
    # uplink lease, then fall through to discovery rather than exiting.
    FOUND=''
    if [ -f /run/mgu-uplink/lease.json ]; then
        r=$(sed -n 's/.*"router"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' /run/mgu-uplink/lease.json | head -1 | tr -d ' \r\n')
        [ -n "$r" ] && FOUND="$r|uplink lease (finder missing)" || true
    fi
fi
case "$FOUND" in
    *'|'*) PHONE=${FOUND%%|*}; PHONE_SRC=${FOUND#*|} ;;
    *)     PHONE=$FOUND; PHONE_SRC='finder' ;;
esac
[ -n "$PHONE" ] || PHONE=auto
[ -n "$PHONE_SRC" ] || PHONE_SRC='none'

write_run 'starting' "launching link and decoder for $PHONE ($PHONE_SRC)"

# crop.json lives beside the binaries in the installed version directory; the
# decoder reads it from the shm dir, so keep a copy there where it is writable.
cp "$HERE/crop.json" "$DIR/crop.json" 2>/dev/null || true

echo "carlife-wireless: phone=$PHONE source=$PHONE_SRC port=$PORT" >&2

# mgu-uplink's firewall only lets whitelisted uids send out of the WiFi
# interface, and it never whitelists root. component.json declares uid 65534
# for this tool, and --drop-uid makes the linker (the only process here that
# opens TCP sockets) switch to it inside the binary - no reliance on setpriv
# or su being installed on the unit. The decoder stays root: it needs the
# car's MSDK/GPU but opens no network socket.
LINK_UID=65534

# With no address, --find keeps link's own host at 127.0.0.1 (a local connect
# that fails instantly) instead of handing getaddrinfo() the literal "auto",
# which can block on a unit whose resolver is behind the uplink. Discovery
# then rewrites the host as soon as the phone answers on the local /24.
if [ "$PHONE" = auto ]; then
    set -- --find
else
    set -- --host "$PHONE"
fi

# Run the pipeline with both children visible so that the death of either one
# ends the group and systemd restarts both together. A bare `a | b` would leave
# the shell alive when one side dies, leaving a half-broken session up.
# Each half records its own exit status in a file. Watching those files is
# more reliable than `kill -0` here: a zombie still answers kill(pid, 0) on
# some shells, which used to leave this launcher spinning forever.
rm -f "$DIR/link.rc" "$DIR/decode.rc" "$DIR/link.pid" "$DIR/decode.pid" 2>/dev/null || true

# The two halves are separate subshells (each has to record its own exit
# status), and that is exactly how 0.7.1 shipped with no pipe between them:
# the link wrote the stream to the launcher's stdout, the decoder read the
# launcher's stdin, and on the unit that stdin is /dev/null. The decoder
# therefore exited with rc 2 "stream ended" before the first frame existed,
# while the link went on dialling the phone and writing a healthy report -
# the car could only show the symptom. A FIFO puts the pipe back and still
# keeps both exit statuses: open() blocks until the other end is there, so
# neither half can start before the other is ready.
FIFO="$DIR/stream.fifo"
rm -f "$FIFO" 2>/dev/null || true
# stderr is left alone on purpose: mkfifo's own reason goes to the journal,
# the summary goes to the screen.
if ! mkfifo "$FIFO"; then
    write_run 'restarting' "cannot create $FIFO with mkfifo - no pipeline possible"
    echo "carlife-wireless: mkfifo $FIFO failed" >&2
    exit 4
fi
# The link opens its end as root and drops to LINK_UID inside the binary, so
# the mode only matters if that ever changes; it costs nothing to be right.
chmod 0666 "$FIFO" 2>/dev/null || true

( set +e
  "$LINK" run "$@" --port "$PORT" --seconds 0 \
    --video - --report "$DIR/link.txt" --ctl 7399 --drop-uid "$LINK_UID" > "$FIFO" &
  child=$!
  printf '%s\n' "$child" > "$DIR/link.pid"
  trap 'kill "$child" 2>/dev/null || true' TERM INT
  wait "$child"
  printf '%s\n' "$?" > "$DIR/link.rc" ) &
link_pid=$!
( set +e
  "$DECODE" --stdin --dir "$DIR" < "$FIFO" &
  child=$!
  printf '%s\n' "$child" > "$DIR/decode.pid"
  trap 'kill "$child" 2>/dev/null || true' TERM INT
  wait "$child"
  printf '%s\n' "$?" > "$DIR/decode.rc" ) &
decode_pid=$!

# Kill both the wrappers AND the real helpers. Killing only a wrapper would
# leave its child as an orphan holding the control port and a second session
# to the phone until systemd's cgroup cleanup catches up.
trap 'for p in "$link_pid" "$decode_pid"; do kill "$p" 2>/dev/null || true; done
      for f in "$DIR/link.pid" "$DIR/decode.pid"; do
          [ -f "$f" ] && kill "$(head -1 "$f")" 2>/dev/null || true
      done' EXIT INT TERM

# Wait for either to finish. `wait -n` is not in the unit's old bash, so poll.
while [ ! -f "$DIR/link.rc" ] && [ ! -f "$DIR/decode.rc" ]; do
    sleep 1
done

# Name the half that died and its exit status: "decoder exited rc=1" on the
# car's screen tells us the MSDK is unavailable, which no amount of waiting
# for a phone address would have fixed.
#
# Which half FAILED is not the same as which half wrote its .rc first, and
# with a real pipe between them the cascade is the normal case: the decoder
# exits 2 exactly when its stdin closes (the link is gone), and any other
# status - 1 for no MSDK, no /dev/dri - is the decoder's own fault. Only in
# the second case did the decoder kill the stream; in the first the link did,
# and the link dying can also take the decoder down with it. So decode 0 and
# 2 mean "upstream ended" and everything else means "the decoder broke".
# When the decoder went first, give the link a second to record its own
# status, otherwise a link that died just after the launcher's one-second
# poll would still be reported as a decoder failure.
detail='a pipeline stage ended'
drc=''
lrc=''
if [ -f "$DIR/decode.rc" ]; then drc=$(head -1 "$DIR/decode.rc" 2>/dev/null); fi
if [ -n "$drc" ] && [ "$drc" != 0 ] && [ "$drc" != 2 ]; then
    detail="carlife-decode exited (rc $drc)"
else
    if [ ! -f "$DIR/link.rc" ]; then sleep 1; fi
    if [ -f "$DIR/link.rc" ]; then lrc=$(head -1 "$DIR/link.rc" 2>/dev/null); fi
    if [ -n "$lrc" ]; then
        detail="carlife-link exited (rc $lrc)"
    elif [ -n "$drc" ]; then
        detail="carlife-decode exited (rc $drc, stream ended)"
    fi
fi

write_run 'restarting' "$detail"
echo "carlife-wireless: $detail, restarting" >&2
exit 4
