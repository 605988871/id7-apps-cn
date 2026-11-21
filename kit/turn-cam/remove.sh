#!/bin/sh
# turn-cam: stop both services and take the folder they shared with the app
# away. The Store removes the units and the files itself; this only clears what
# they leave behind, so a reinstall starts from a clean socket directory.
set -e

if command -v systemctl >/dev/null 2>&1; then
    systemctl stop turn-cam.service 2>/dev/null || true
    systemctl stop turn-decode.service 2>/dev/null || true
    systemctl disable turn-cam.service 2>/dev/null || true
    systemctl disable turn-decode.service 2>/dev/null || true
fi
# The reports live inside the folder (turn-cam.txt) and beside it, named after
# it (turn-view-decode.txt, decode.c derives that from --dir), plus the install
# hook's own account of the last start.
rm -rf /dev/shm/turn-view 2>/dev/null || true
rm -f /dev/shm/turn-view-decode.txt /dev/shm/turn-cam-boot.txt 2>/dev/null || true
echo "turn-cam: removed"
