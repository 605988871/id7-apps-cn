#!/bin/sh
# 本地交叉编译：用 zig 把 tap.c 编成车机（MGU, x86_64, glibc 2.27）能加载的 .so。
#
# 为什么不用 make target：那条路要 Docker + Ubuntu 18.04 镜像，还依赖
# GitHub Actions 的 workflow 权限（令牌没有 workflow scope 时连推都推不
# 上去）；zig 自带各版本 glibc 的头文件和 stub 库，一条命令就能产出 ABI
# 匹配的 ELF，改一次编一次只要几秒。
#
#   ./build-zig.sh                  PATH 里能找到 zig
#   ZIG=/d/zig/zig.exe ./build-zig.sh
#   ./build-zig.sh src/tap.c       换源文件
#
# 产物和 make target 出来的应当是同一个 ABI：不高于 GLIBC_2.27，read 和
# ioctl 都导出。check_elf.py 会在任何一项不满足时报错退出——车机上装错
# 版本只会静默地 "undefined symbol"，没有任何界面会告诉你原因。

set -e

ZIG=${ZIG:-zig}
SRC=${1:-src/tap.c}
TARGET=x86_64-linux-gnu.2.27
CFLAGS="-O2 -g0 -Wall -Wextra -Werror -std=gnu11"

cd "$(dirname "$0")"
mkdir -p bin

echo "--- zig $("$ZIG" version) ---"
"$ZIG" cc -target "$TARGET" $CFLAGS -fPIC -shared \
    -o bin/libcarlife-tap.so "$SRC"

python3 check_elf.py bin/libcarlife-tap.so
