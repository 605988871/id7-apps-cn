#!/bin/sh
# Take the tap library back out.
#
# Run as root by the Store before a version is removed (component.json
# deactivate). It only removes what this tool added: its own drop-ins, the
# report and the marker. Units, their enablement and the payload are the
# Store's business.
set -e

say() { echo "carlife-tap: $*"; }

found=0
for f in /etc/systemd/system/*.service.d/50-carlife-tap.conf; do
    [ -f "$f" ] || continue
    dir=$(dirname "$f")
    rm -f "$f"
    rmdir "$dir" 2>/dev/null || true
    say "removed $f"
    found=1
done
[ "$found" = 1 ] || say "no drop-in was installed"
systemctl daemon-reload 2>/dev/null || true

rm -f /dev/shm/carlife-tap.loaded /dev/shm/carlife-tap.txt
say "done; CarLife runs without the library at its next start"
