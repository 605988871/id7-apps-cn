#!/bin/sh
# 本地交叉编译：用 zig 把 tap.c 和 decode.c 编成车机（MGU, x86_64, glibc 2.27）能用的产物。
#
# 为什么不用 make target：那条路要 Docker + Ubuntu 18.04 镜像，还依赖
# GitHub Actions 的 workflow 权限（令牌没有 workflow scope 时连推都推不
# 上去）；zig 自带各版本 glibc 的头文件和 stub 库，一条命令就能产出 ABI
# 匹配的 ELF，改一次编一次只要几秒。
#
#   ./build-zig.sh                 PATH 里能找到 zig
#   ZIG=/d/zig/zig.exe ./build-zig.sh
#   ./build-zig.sh tap             只编预加载库
#   ./build-zig.sh decode          只编解码器
#
# 产物和 make target 出来的应当是同一个 ABI：不高于 GLIBC_2.27。预加载库要
# 导出 read 和 ioctl 才能被插桩；解码器只能依赖 C 运行库，因为它用 dlopen
# 自己找 MSDK 和 libva。check_elf.py 会在任何一项不满足时报错退出——车机上
# 装错版本只会静默地 "undefined symbol"，没有任何界面会告诉你原因。

set -e

ZIG=${ZIG:-zig}
WHAT=${1:-all}
TARGET=x86_64-linux-gnu.2.27
CFLAGS="-O2 -g0 -Wall -Wextra -Werror -std=gnu11"
MFX=../../third_party/mfx/include

cd "$(dirname "$0")"

echo "--- zig $("$ZIG" version) ---"

if [ "$WHAT" = all ] || [ "$WHAT" = tap ]; then
    "$ZIG" cc -target "$TARGET" $CFLAGS -fPIC -shared \
        -o libcarlife-tap.so src/tap.c
    chmod 0644 libcarlife-tap.so
    python3 check_elf.py libcarlife-tap.so
fi

if [ "$WHAT" = all ] || [ "$WHAT" = decode ]; then
    "$ZIG" cc -target "$TARGET" $CFLAGS -I"$MFX" \
        -o carlife-decode src/decode.c
    chmod 0755 carlife-decode
    python3 check_elf.py carlife-decode
fi
