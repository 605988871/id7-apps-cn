#!/bin/sh
# Load the tap library into CarLife.
#
# Run as root by the Store after every install (component.json postInstall),
# from the tool's own version directory. It changes nothing until the next
# start of the unit: CarLife keeps running on the library it started with.
#
# Why a drop-in and not a patched unit: a drop-in is one small file that is
# removed on uninstall, and nothing the unit already sets is lost. The unit
# sets LD_PRELOAD itself (the head unit preloads libschedeconfig into carlife),
# so the drop-in writes back whatever was there, with our library appended.
# Overwriting that value would silently take the unit's own preload away.
set -e

# Where this script is, not where it was started from. The Store runs a
# postInstall from the version directory it just unpacked, but "the directory
# of $0" is the one answer that stays right in every layout - a run from / or
# from /var/opt/carlife-tap would otherwise look for the library in the wrong
# place and report it missing.
HERE=$(cd "$(dirname "$0")" 2>/dev/null && pwd)
LOCAL="$HERE/libcarlife-tap.so"

# What the unit is told to preload is the Store's stable path, not this
# version's: an upgrade unpacks into a new directory and deletes the old one,
# so a per-version path is stale the moment the next version lands. Through
# "current" the same line keeps working across upgrades, and after an
# uninstall it is a dangling entry the loader warns about and skips - CarLife
# still starts, which is what matters most.
# Under a Store install there is a /var/opt/carlife-tap to point into; a copy
# unpacked by hand has none, and then this directory is the only path that
# exists, so use it and accept that the next upgrade invalidates it.
if [ -d /var/opt/carlife-tap ]; then
    SO=/var/opt/carlife-tap/current/libcarlife-tap.so
else
    SO="$LOCAL"
fi
TAG=carlife-tap

say() { echo "$TAG: $*"; }

[ -f "$LOCAL" ] || { echo "$TAG: $LOCAL is missing from the package"; exit 1; }

# ---- 1. does the library load at all, without touching CarLife ----
# A library that cannot resolve shows up in CarLife as a process that starts
# and dies, which is a bad way to find out. The constructor writes a marker
# before it decides to do anything, so the marker proves two things at once:
# the ELF is loadable on this unit and its constructors run.
MARKER=/dev/shm/carlife-tap.loaded
rm -f "$MARKER"
# A loader that cannot use the file says so on stderr and then runs the program
# anyway. That is the failure worth stopping for, and the message is what says
# it: a static /bin/sh (busybox is one binary) ignores LD_PRELOAD in silence and
# would leave no marker without anything being wrong, so a missing marker alone
# must never fail the install - that would block a good library on a shell.
ERR=$(LD_PRELOAD="$LOCAL" CARLIFE_TAP=0 /bin/sh -c 'exit 0' 2>&1 >/dev/null)
case "$ERR" in
    *libcarlife-tap.so*)
        echo "$TAG: the library does not load on this unit's loader:"
        printf '%s\n' "$ERR" | head -4
        exit 1
        ;;
esac
# The marker still earns its keep as a positive signal: it proves the ELF
# resolves and its constructor runs, which is more than an absent error says.
if [ -s "$MARKER" ]; then
    say "library loads"
elif [ -d /dev/shm ]; then
    say "no marker from /bin/sh (a static shell, or nothing loaded yet)"
fi

# ---- 2. which unit starts CarLife ----
# Where the process actually lives beats what a unit file says: Cinemo starts
# carlife, carplay and aapd as children of one launcher, so a unit file that
# never mentions "carlife" can still be the right place to put the preload
# (children inherit the environment; the library only acts when the executable
# is carlife, so the siblings are untouched).
unit_of_pid() {
    tr '/' '\n' < "/proc/$1/cgroup" 2>/dev/null |
        sed -n 's/^\(.*\.service\)$/\1/p' | head -1
}
UNIT=
UNIT_HOW=
for d in /proc/[0-9]*; do
    # A process can exit between the glob and this read; that is not an error,
    # it is the next pid's turn - and with `set -e` an unchecked redirect here
    # would end the install.
    first=$(tr '\0' ' ' < "$d/cmdline" 2>/dev/null) || continue
    first=${first%% *}
    case "${first##*/}" in
        carlife) UNIT=$(unit_of_pid "${d#/proc/}")
                 [ -n "$UNIT" ] && UNIT_HOW="from the running process" && break ;;
    esac
done

if [ -z "$UNIT" ]; then
    for f in /etc/systemd/system/*.service /lib/systemd/system/*.service \
             /usr/lib/systemd/system/*.service; do
        [ -f "$f" ] || continue
        line=$(sed -n 's/^ExecStart=//p' "$f" 2>/dev/null | head -1)
        line=${line#-}
        exe=${line%% *}
        case "${exe##*/}" in
            carlife) UNIT=$(basename "$f"); UNIT_HOW="from its unit file"; break ;;
        esac
    done
fi

# A unit named after it, whose ExecStart runs a wrapper: the last resort before
# giving up. It is used only when nothing else named carlife.
if [ -z "$UNIT" ]; then
    for f in /etc/systemd/system/carlife*.service \
             /lib/systemd/system/carlife*.service \
             /usr/lib/systemd/system/carlife*.service; do
        [ -f "$f" ] || continue
        UNIT=$(basename "$f")
        UNIT_HOW="from its file name; its ExecStart starts a wrapper"
        break
    done
fi

[ -n "$UNIT" ] || {
    # Not a failed install: the preload goes into whichever unit starts CarLife,
    # and on a unit where Cinemo starts it that unit is only visible while the
    # process runs. Exiting non-zero here would roll the whole install back -
    # the app and the decoder included - over a step that the next install
    # after one CarLife session fixes. So: say it, keep the rest, exit 0.
    echo "$TAG: no systemd unit starts a binary named carlife, so nothing was preloaded yet"
    # the Store quotes the last line it read: keep the actionable one last
    echo "$TAG: open CarLife once, then install this again - a running process names its unit"
    exit 0
}
say "unit $UNIT ($UNIT_HOW)"

# ---- 3. keep whatever the unit already preloads ----
# "systemctl show -p Environment" prints one line, "Environment=A=1 B=2", with
# the property name in front and the variables space separated - the quotes
# systemd adds around values with spaces stay in the string. So strip the
# property, split on spaces, unquote each token, and take only the LD_PRELOAD
# one: the other variables are systemd's business, not this script's.
#
# Getting this wrong is quiet and expensive: writing a drop-in with only our
# library in it replaces the unit's own LD_PRELOAD instead of extending it, and
# the unit goes on starting - just without the /usr/lib/libschedeconfig.so.1 the
# head unit preloads into carlife.
if ! RAW=$(systemctl show "$UNIT" -p Environment 2>/dev/null); then
    say "could not read the unit's own environment, so it was left untouched"
    say "install again after a reboot - nothing was preloaded"
    exit 0
fi
PREV_RAW=$(printf '%s\n' "$RAW" | sed -n 's/^Environment=//p' | tail -1)
LIST=
OLDIFS=$IFS; IFS=' '
for tok in $PREV_RAW; do
    tok=${tok#\"}; tok=${tok%\"}          # systemd may quote the whole variable
    case "$tok" in
        LD_PRELOAD=*)
            PREV=${tok#LD_PRELOAD=}
            PREV=${PREV#\"}; PREV=${PREV%\"}  # ... or only its value
            ;;
        *) continue ;;
    esac
    # An upgrade puts the library in a new version directory, so a path written
    # by the last install no longer exists: drop ours, keep everything else.
    # Leaving it in would hand the loader a file that is not there.
    OIFS=$IFS; IFS=:
    for e in $PREV; do
        case "$e" in *libcarlife-tap.so) continue ;; esac
        if [ -n "$e" ]; then LIST="${LIST:+$LIST:}$e"; fi
    done
    IFS=$OIFS
done
IFS=$OLDIFS
PREV=$LIST
if [ -n "$PREV" ]; then
    WANT="$PREV:$SO"
    say "keeping the unit's own preload"
else
    WANT="$SO"
fi
# A value with a quote or a space in it would make the Environment line below
# something systemd cannot parse, and a unit that will not parse is worse than
# one without a preload: say so and leave it alone.
case "$WANT" in
    *\"*|*" "*)
        say "the unit's LD_PRELOAD is not a plain path list, so it was left untouched"
        say "preload $SO by hand, or install again after a reboot"
        exit 0
        ;;
esac

# ---- 4. the drop-in ----
# /etc may be on a read-only root. The Store remounts while it lays down its own
# unit files, but this runs as a hook of its own and cannot assume that: try the
# write first, and remount only if it fails - then put the root back, because
# leaving it writable is not this script's decision to make.
D="/etc/systemd/system/${UNIT}.d"
RW=0
# Whatever happens next - a write that fails, a command that stops the script -
# the root goes back to read-only: leaving it writable is not this script's
# decision to make, and a trap is the only way to be sure of that on every exit
# path. `set -e` would otherwise turn "[ $RW = 1 ] && mount ..." into an exit
# of its own when nothing was remounted.
trap 'if [ "$RW" = 1 ]; then mount -o remount,ro / 2>/dev/null; fi' EXIT

# Can this be written at all? A directory that is really a file, or a root that
# is mounted read-only, both say no here - and both are the difference between
# "installed" and "installed, but nothing happens".
writable() {
    [ -d "$D" ] || mkdir -p "$D" 2>/dev/null || return 1
    touch "$D/.carlife-tap-rw" 2>/dev/null || return 1
    rm -f "$D/.carlife-tap-rw" 2>/dev/null
}
if ! writable; then
    if mount -o remount,rw / 2>/dev/null; then
        RW=1
        if ! writable; then
            say "$D cannot be written even with the root remounted read-write"
            say "remove whatever is at that path, then install again - nothing was preloaded"
            exit 0
        fi
    else
        say "$D is not writable and the root file system cannot be remounted"
        say "unlock the root file system, then install again - nothing was preloaded"
        exit 0
    fi
fi

F="$D/50-carlife-tap.conf"
{
    echo '# carlife-tap: copies the phone video stream out of carlife (read-only).'
    echo '# Remove this file and run systemctl daemon-reload to undo.'
    echo '[Service]'
    echo "Environment=\"LD_PRELOAD=$WANT\""
} > "$F" 2>/dev/null || true
# A write can fail without the shell saying so - a full tmpfs, a unit directory
# that is not a directory - so the file itself is the evidence, not the exit
# status: read the line back before claiming it is there.
if ! grep -q '^Environment="LD_PRELOAD=' "$F" 2>/dev/null; then
    say "could not write $F"
    say "the install is fine, but nothing was preloaded; install again after a reboot"
    exit 0
fi
sync
if [ "$RW" = 1 ]; then
    mount -o remount,ro / 2>/dev/null || true
    RW=0
fi
systemctl daemon-reload 2>/dev/null || true

# ---- 5. the decoder has to be running ----
# The tap copies the stream into h264.sock and the decoder reads it. A decoder
# that is not running looks exactly like an install that did nothing: the tap
# fills its socket with nobody on the other end, and the cluster says "waiting
# for CarLife" for ever, with no word about why.
#
# Two ways to get there, and both are silent: a payload that arrived without
# its execute bit (the Store writes files, and mode is not always what the
# manifest asked for), and a unit that was enabled but never started - enabled
# only takes effect at the next boot, so a unit that failed once stays down
# until someone starts it by hand.
#
# So: make the binary executable, enable *and* start the unit, and write what
# happened where the app can print it. The app reads
# /dev/shm/carlife-decode-boot.txt on its status page; a decoder that cannot
# run is then one line on the screen instead of a blind install.
CUR=/var/opt/carlife-tap/current
BOOT=/dev/shm/carlife-decode-boot.txt
printf '' > "$BOOT" 2>/dev/null || BOOT=/tmp/carlife-decode-boot.txt
boot() { printf '%s\n' "$*" >> "$BOOT" 2>/dev/null || true; }

# When this ran, in seconds since boot. The app compares it with the unit's own
# uptime: an install from before the last restart is a report about a decoder
# that has since been started by systemd at boot, and showing it as if it were
# current would send someone chasing a failure that is no longer there.
if read -r UP _ < /proc/uptime 2>/dev/null; then boot "uptime: $UP"; fi

for b in "$HERE/carlife-decode" "$CUR/carlife-decode"; do
    [ -f "$b" ] && chmod 0755 "$b" 2>/dev/null || true
done
if [ ! -x "$CUR/carlife-decode" ]; then
    boot "exec: $CUR/carlife-decode is missing or not executable"
else
    boot "exec: $CUR/carlife-decode"
fi

FOUND=
for f in /etc/systemd/system/carlife-decode.service \
         /lib/systemd/system/carlife-decode.service \
         /usr/lib/systemd/system/carlife-decode.service; do
    [ -f "$f" ] && FOUND="$f" && break
done
if [ -n "$FOUND" ]; then
    boot "unit: $FOUND"
else
    boot "unit: carlife-decode.service was not installed"
fi

STATE=none
if command -v systemctl >/dev/null 2>&1; then
    systemctl daemon-reload 2>/dev/null || true
    systemctl enable carlife-decode.service >/dev/null 2>&1 || true
    # restart, not try-restart: try-restart does nothing at all to a unit that
    # is not active, which is precisely the case this section exists for.
    if command -v timeout >/dev/null 2>&1; then
        timeout 15 systemctl restart carlife-decode.service >/dev/null 2>&1 || true
    else
        systemctl restart carlife-decode.service >/dev/null 2>&1 || true
    fi
    sleep 1
    # An assignment from a command that exits non-zero fails under `set -e`,
    # and is-active exits 3 for a unit that is not running - which is exactly
    # the case being measured. So it is caught, not tested.
    STATE=$(systemctl is-active carlife-decode.service 2>/dev/null) || STATE=unknown
    [ -n "$STATE" ] || STATE=unknown
    boot "state: $STATE"
    if [ "$STATE" != active ]; then
        # The unit's own account: the reason a service does not start is the
        # first thing systemd says about it, and it is never on the car's
        # screen otherwise.
        systemctl status --no-pager -l carlife-decode.service 2>&1 | tail -6 >> "$BOOT" 2>/dev/null || true
    fi
else
    boot "state: no systemctl on this unit"
fi

if [ -s /dev/shm/carlife-decode.txt ]; then
    boot "report: yes"
else
    boot "report: no (/dev/shm/carlife-decode.txt)"
fi

if [ "$STATE" = active ]; then
    say "decoder running"
else
    say "the decoder did not start: $BOOT says why"
fi
say "installed for $UNIT, $WANT"
# the Store quotes the last line it read: keep the actionable one last
say "restart the head unit to load the preload; then check the Decode line"
