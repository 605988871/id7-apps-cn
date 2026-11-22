#!/bin/sh
# Build carlife-link. The committed binary is the unit's; this makes it again.
#
#   ./build.sh            the unit's binary (Linux x86-64, glibc 2.27, its own loader)
#   ./build.sh --dev      this machine's binary, for a laptop and fake_md.py
#
# zig is what the other tools in this kit use: it carries the unit's glibc
# headers and stub libraries, so no container and no compiler install is needed
# (ZIG=/path/to/zig if it is not where the kit keeps it).
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
ZIG=${ZIG:-}
[ -n "$ZIG" ] || ZIG=$(command -v zig 2>/dev/null || true)
[ -n "$ZIG" ] || for c in /d/zig/zig-x86_64-windows-0.14.1/zig.exe /d/zig/zig.exe; do
    [ -x "$c" ] && ZIG=$c && break
done
[ -n "$ZIG" ] || { echo "zig not found: set ZIG=" >&2; exit 1; }

if [ "${1:-}" = "--dev" ]; then
    case "$(uname -s)" in
        MINGW*|MSYS*|CYGWIN*) "$ZIG" cc -O2 -Wall -Wextra -o "$HERE/link.exe" "$HERE/src/link.c" -lws2_32 -liphlpapi ;;
        *)                    "$ZIG" cc -O2 -Wall -Wextra -o "$HERE/link" "$HERE/src/link.c" -lpthread ;;
    esac
    echo "built the dev copy"
    exit 0
fi

# -target ...2.27 and the loader are the whole point: the unit has no /lib64,
# and a program that names /lib64/ld-linux-x86-64.so.2 is present, executable
# and still fails with ENOENT
"$ZIG" cc -O2 -Wall -Wextra \
    -target x86_64-linux-gnu.2.27 \
    -Wl,--dynamic-linker=/lib/ld-linux-x86-64.so.2 \
    -o "$HERE/carlife-link" "$HERE/src/link.c" -lpthread

# read it back: 64-bit little-endian x86-64, and the loader the unit has
python "$HERE/test/elf_check.py" "$HERE/carlife-link"
echo "built $HERE/carlife-link"
