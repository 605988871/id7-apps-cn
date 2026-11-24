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
# Same trap as the kit's build.sh, and this script had it too: Git Bash
# rewrites -Wl,--dynamic-linker=/lib/ld-linux-x86-64.so.2 into the build
# machine's own loader before zig sees it, and the resulting binary cannot
# start on the unit (exec: ENOENT, rc 127). Running this file on its own used
# to produce exactly that; elf_check.py below refuses the result, but only
# after the bad file has been written.
export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL='*'
# ...and switching the rewrite off globally also stops -o from being
# translated, at which point zig tries to open "/d/..." as a Windows path and
# fails with "unable to open output directory". Relative paths are what keeps
# both halves working: nothing handed to zig looks like a unix absolute path.
cd "$HERE"
ZIG=${ZIG:-}
[ -n "$ZIG" ] || ZIG=$(command -v zig 2>/dev/null || true)
[ -n "$ZIG" ] || for c in /d/zig/zig-x86_64-windows-0.14.1/zig.exe /d/zig/zig.exe; do
    [ -x "$c" ] && ZIG=$c && break
done
[ -n "$ZIG" ] || { echo "zig not found: set ZIG=" >&2; exit 1; }

if [ "${1:-}" = "--dev" ]; then
    case "$(uname -s)" in
        MINGW*|MSYS*|CYGWIN*) "$ZIG" cc -O2 -Wall -Wextra -o link.exe src/link.c -lws2_32 -liphlpapi ;;
        *)                    "$ZIG" cc -O2 -Wall -Wextra -o link src/link.c -lpthread ;;
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
    -o carlife-link src/link.c -lpthread

# read it back: 64-bit little-endian x86-64, and the loader the unit has
python test/elf_check.py carlife-link
echo "built $HERE/carlife-link"
