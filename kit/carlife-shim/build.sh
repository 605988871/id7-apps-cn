#!/bin/sh
# Build carlife-shim.so. The committed .so is the unit's; this makes it again.
#
#   ./build.sh            the unit's library (glibc 2.27, x86-64)
#
# zig carries the unit's glibc headers and stub libraries, so no container and
# no compiler install is needed (ZIG=/path/to/zig if it is not where the kit
# keeps it). A library has no interpreter, so -Wl,--dynamic-linker is neither
# needed nor allowed here - but the glibc target still matters: a .so built
# against 2.34 symbols fails to load into a 2.27 process with
# "version `GLIBC_2.34' not found", and the symptom is carlife not starting.
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
ZIG=${ZIG:-}
[ -n "$ZIG" ] || ZIG=$(command -v zig 2>/dev/null || true)
[ -n "$ZIG" ] || for c in /d/zig/zig-x86_64-windows-0.14.1/zig.exe /d/zig/zig.exe; do
    [ -x "$c" ] && ZIG=$c && break
done
[ -n "$ZIG" ] || { echo "zig not found: set ZIG=" >&2; exit 1; }

"$ZIG" cc -O2 -Wall -Wextra -fPIC -shared \
    -target x86_64-linux-gnu.2.27 \
    -o "$HERE/carlife-shim.so" "$HERE/src/shim.c" -lpthread -ldl

python "$HERE/test/elf_so_check.py" "$HERE/carlife-shim.so"
echo "built $HERE/carlife-shim.so"
