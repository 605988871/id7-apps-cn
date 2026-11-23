#!/bin/sh
# Cross-build the two native helpers for the MGU (x86_64, glibc 2.27, its own
# loader). zig carries the unit's glibc headers and stubs, so no container and
# no compiler install is needed. Output ABI is checked before it is used.
#
#   ZIG=/path/to/zig ./build.sh
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
ZIG=${ZIG:-}
[ -n "$ZIG" ] || ZIG=$(command -v zig 2>/dev/null || true)
[ -n "$ZIG" ] || for c in /d/zig/zig-x86_64-windows-0.14.1/zig.exe /d/zig/zig.exe; do
    [ -x "$c" ] && ZIG=$c && break
done
[ -n "$ZIG" ] || { echo "zig not found: set ZIG=" >&2; exit 1; }

TARGET=x86_64-linux-gnu.2.27
LOADER="-Wl,--dynamic-linker=/lib/ld-linux-x86-64.so.2"
MFX="$HERE/../../third_party/mfx/include"

echo "building carlife-link..."
"$ZIG" cc -O2 -Wall -Wextra -target "$TARGET" $LOADER \
    -o "$HERE/carlife-link" "$HERE/link/src/link.c" -lpthread
python3 "$HERE/link/test/elf_check.py" "$HERE/carlife-link"

echo "building carlife-decode..."
"$ZIG" cc -O2 -Wall -Wextra -std=gnu11 -target "$TARGET" $LOADER \
    -I"$MFX" -o "$HERE/carlife-decode" "$HERE/decode.c" -ldl -lpthread
python3 "$HERE/link/test/elf_check.py" "$HERE/carlife-decode"

echo "building wifi-bridge..."
"$ZIG" cc -O2 -Wall -Wextra -std=gnu11 -target "$TARGET" $LOADER \
    -o "$HERE/wifi-bridge" "$HERE/wifi-bridge.c"
python3 "$HERE/link/test/elf_check.py" "$HERE/wifi-bridge"

chmod 0755 "$HERE/carlife-link" "$HERE/carlife-decode" "$HERE/wifi-bridge"
echo "built all three binaries for $TARGET"
