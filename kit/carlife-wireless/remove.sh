#!/bin/sh
# carlife-wireless: stop and remove the service and the shared folder. Run as
# root by the Store on uninstall. Touches nothing the unit owns.
set -e

say() { echo "carlife-wireless: $*"; }

if command -v systemctl >/dev/null 2>&1; then
    systemctl stop carlife-wireless.service >/dev/null 2>&1 || true
    systemctl disable carlife-wireless.service >/dev/null 2>&1 || true
    systemctl stop carlife-wifi.service >/dev/null 2>&1 || true
    systemctl disable carlife-wifi.service >/dev/null 2>&1 || true
    systemctl daemon-reload 2>/dev/null || true
fi

rm -rf /dev/shm/carlife-wireless 2>/dev/null || true
rm -f /dev/shm/carlife-wireless-decode.txt 2>/dev/null || true
rm -f /dev/shm/carlife-wireless-boot.txt 2>/dev/null || true

say "removed"
