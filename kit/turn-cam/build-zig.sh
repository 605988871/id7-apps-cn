#!/bin/sh
# Local cross-compile for the unit (MGU: x86_64, glibc 2.27): zig carries the
# target's headers and stub libraries, so one command produces an ABI-matched
# ELF without Docker.
#
#   ./build-zig.sh
#   ZIG=/d/zig/zig-x86_64-windows-0.14.1/zig.exe ./build-zig.sh
#   ./build-zig.sh cam        only the receiver
#   ./build-zig.sh decode     only the decoder
#
# The decoder is built from src/decode.c into this component, so Turn View
# installs on its own: one camera picture should not pull in a whole second
# tool. `--dir` is what keeps it apart from any other app that runs a decoder -
# each app has its own folder for the sockets and its own crop.json. The source
# lives here; the binary is not checked in twice.
set -e

ZIG=${ZIG:-zig}
WHAT=${1:-all}
TARGET=x86_64-linux-gnu.2.27
CFLAGS="-O2 -g0 -Wall -Wextra -Werror -std=gnu11"
MFX=../../third_party/mfx/include
DECODE_SRC=src/decode.c

# The unit has no /lib64: name the loader it does have, or execve fails with
# ENOENT on a file that is present and executable and systemd reports only
# "Failed at step EXEC spawning".
UNIT_LD="-Wl,--dynamic-linker=/lib/ld-linux-x86-64.so.2"

# Git Bash rewrites path-looking arguments, including the one inside -Wl,...
MSYS_NO_PATHCONV=1
MSYS2_ARG_CONV_EXCL='*'
export MSYS_NO_PATHCONV MSYS2_ARG_CONV_EXCL

cd "$(dirname "$0")"

echo "--- zig $("$ZIG" version) ---"

if [ "$WHAT" = all ] || [ "$WHAT" = cam ]; then
    "$ZIG" cc -target "$TARGET" $CFLAGS $UNIT_LD -o turn-cam src/turn_cam.c src/rtp_h264.c -ldl
    chmod 0755 turn-cam
    python3 check_elf.py turn-cam
fi

if [ "$WHAT" = all ] || [ "$WHAT" = decode ]; then
    [ -f "$DECODE_SRC" ] || { echo "$DECODE_SRC is missing: the decoder source belongs in kit/turn-cam/src" >&2; exit 1; }
    "$ZIG" cc -target "$TARGET" $CFLAGS -I"$MFX" $UNIT_LD -o turn-decode "$DECODE_SRC"
    chmod 0755 turn-decode
    python3 check_elf.py turn-decode
fi
