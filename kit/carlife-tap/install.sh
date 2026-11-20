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

SO="$(pwd)/libcarlife-tap.so"
TAG=carlife-tap

say() { echo "$TAG: $*"; }

[ -f "$SO" ] || { echo "$TAG: $SO is missing"; exit 1; }

# ---- 1. does the library load at all, without touching CarLife ----
# A library that cannot resolve shows up in CarLife as a process that starts
# and dies, which is a bad way to find out. The constructor writes a marker
# before it decides to do anything, so the marker proves two things at once:
# the ELF is loadable on this unit and its constructors run.
MARKER=/dev/shm/carlife-tap.loaded
rm -f "$MARKER"
if ! LD_PRELOAD="$SO" CARLIFE_TAP=0 /bin/sh -c 'exit 0' 2>/dev/null; then
    echo "$TAG: the library does not load on this unit's loader"
    exit 1
fi
[ -s "$MARKER" ] || { echo "$TAG: the library loads but its constructor never ran"; exit 1; }
say "library loads"

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
    [ -r "$d/cmdline" ] || continue
    first=$(tr '\0' ' ' < "$d/cmdline" 2>/dev/null)
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

[ -n "$UNIT" ] || {
    echo "$TAG: no systemd unit starts a binary named carlife; nothing changed"
    echo "$TAG: open CarLife once, then run this again (the running process names its unit)"
    echo "$TAG: the probe app's report shows how CarLife is started here"
    exit 1
}
say "unit $UNIT ($UNIT_HOW)"

# ---- 3. keep whatever the unit already preloads ----
PREV=$(systemctl show "$UNIT" -p Environment 2>/dev/null |
       tr ' ' '\n' | sed -n 's/^LD_PRELOAD=//p' | tail -1)
# An upgrade puts the library in a new version directory, so a path written by
# the last install no longer exists: drop ours, keep everything else. Leaving
# it in would hand the loader a file that is not there.
LIST=
OLDIFS=$IFS; IFS=:
for e in $PREV; do
    case "$e" in *libcarlife-tap.so) continue ;; esac
    [ -n "$e" ] && LIST="${LIST:+$LIST:}$e"
done
IFS=$OLDIFS
PREV=$LIST
if [ -n "$PREV" ]; then
    WANT="$PREV:$SO"
    say "keeping the unit's own preload"
else
    WANT="$SO"
fi

# ---- 4. the drop-in ----
D="/etc/systemd/system/${UNIT}.d"
mkdir -p "$D"
{
    echo '# carlife-tap: copies the phone video stream out of carlife (read-only).'
    echo '# Remove this file and run systemctl daemon-reload to undo.'
    echo '[Service]'
    echo "Environment=\"LD_PRELOAD=$WANT\""
} > "$D/50-carlife-tap.conf"
systemctl daemon-reload 2>/dev/null || true

say "installed for $UNIT; it takes effect at the next start"
say "restart the head unit (or: systemctl restart $UNIT)"
printf '{"status":"preloaded into %s","reboot":"the CarLife tap loads when carlife starts"}\n' "$UNIT"
