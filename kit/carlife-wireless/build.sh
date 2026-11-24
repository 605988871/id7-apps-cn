#!/bin/sh
# Cross-build the three native helpers for the MGU (x86_64, glibc 2.27, its own
# loader). zig carries the unit's glibc headers and stubs, so no container and
# no compiler install is needed. Output ABI is checked before it is used.
#
#   ZIG=/path/to/zig ./build.sh
#
# Every path below is relative and the script cd's to its own directory first.
# Git Bash and MSYS2 rewrite an argument that looks like a unix path before it
# reaches a native Windows program, and that rewrite turned
#
#   -Wl,--dynamic-linker=/lib/ld-linux-x86-64.so.2
#
# into the build machine's own loader and baked it into PT_INTERP:
#
#   D:/.../PortableGit/lib/ld-linux-x86-64.so.2
#
# The unit has no such file, so exec failed with ENOENT and the shell reported
# 127 - the "carlife-link exited (rc 127)" the head unit showed. Switching the
# rewrite off is what lets the loader path through intact; going relative is
# what keeps that switch from breaking every other path in this script.
# Two checks guard it now: test_link.py asserts the switch is still here, and
# elf_check.py reads PT_INTERP back out of each built file.
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE"

export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL='*'

ZIG=${ZIG:-}
[ -n "$ZIG" ] || ZIG=$(command -v zig 2>/dev/null || true)
[ -n "$ZIG" ] || for c in /d/zig/zig-x86_64-windows-0.14.1/zig.exe /d/zig/zig.exe; do
    [ -x "$c" ] && ZIG=$c && break
done
[ -n "$ZIG" ] || { echo "zig not found: set ZIG=" >&2; exit 1; }

TARGET=x86_64-linux-gnu.2.27
LOADER="-Wl,--dynamic-linker=/lib/ld-linux-x86-64.so.2"
MFX=../../third_party/mfx/include

echo "building carlife-link..."
"$ZIG" cc -O2 -Wall -Wextra -target "$TARGET" $LOADER \
    -o carlife-link link/src/link.c -lpthread
python3 link/test/elf_check.py carlife-link

echo "building carlife-decode..."
"$ZIG" cc -O2 -Wall -Wextra -std=gnu11 -target "$TARGET" $LOADER \
    -I"$MFX" -o carlife-decode decode.c -ldl -lpthread
python3 link/test/elf_check.py carlife-decode

echo "building wifi-bridge..."
"$ZIG" cc -O2 -Wall -Wextra -std=gnu11 -target "$TARGET" $LOADER \
    -o wifi-bridge wifi-bridge.c
python3 link/test/elf_check.py wifi-bridge

chmod 0755 carlife-link carlife-decode wifi-bridge
echo "built all three binaries for $TARGET"
