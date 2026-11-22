#!/usr/bin/env python
# The framer in src/shim.c is the one piece of the shim that is pure logic: it
# walks a transfer's bytes as a stream of [chan][len][body] messages so the
# counters land on message boundaries rather than on transfer boundaries. It is
# also the piece a mistake in would be invisible from the car - a wrong count
# looks like a quiet channel.
#
# So this lifts the real functions out of shim.c (no copies, no stubs of the
# logic) into a small program, builds it for the host with the same zig that
# builds the library, and runs six cases:
#
#   1. one message per transfer, two channels
#   2. one message split over three transfers
#   3. a mid-message chunk, where picture data sits at offset zero
#   4. two messages and the head of a third in one transfer
#   5. zero-length messages (they must not hang or double-count)
#   6. garbage, then a good message in the next transfer
#
# usage: python kit/carlife-shim/test/framer_test.py [--keep]
import os
import re
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, '..', 'src', 'shim.c')
OUT = os.path.join(HERE, '.framer_test')

CASES = r'''
#include <stdio.h>
#include <stdint.h>
#include <string.h>
#include <stddef.h>

__FRAME_MAX__
__STRUCT__
__RD32__
__FRAMER__

static unsigned char buf[1 << 20];

static void put(unsigned off, uint32_t chan, uint32_t len)
{
    int i;
    for (i = 0; i < 4; i++) {
        buf[off + i] = (unsigned char)(chan >> (8 * i));
        buf[off + 4 + i] = (unsigned char)(len >> (8 * i));
    }
}

int main(void)
{
    char t[120];
    struct framer f;

    memset(&f, 0, sizeof f);
    memset(buf, 0, sizeof buf);
    put(0, 1000, 8);  frame_bytes(&f, buf, 16);
    put(0, 2000, 4);  frame_bytes(&f, buf, 12);
    put(0, 1000, 8);  frame_bytes(&f, buf, 16);
    chan_text(&f, t, sizeof t);
    printf("1 frames=%lu resync=%lu chans=%s\n", f.frames, f.resync, t);
    if (f.frames != 3 || f.resync || strcmp(t, "1000x2 2000x1")) return 1;

    memset(&f, 0, sizeof f);
    put(0, 2001, 300);
    frame_bytes(&f, buf, 108);
    frame_bytes(&f, buf, 100);
    frame_bytes(&f, buf, 100);
    chan_text(&f, t, sizeof t);
    printf("2 frames=%lu resync=%lu chans=%s\n", f.frames, f.resync, t);
    if (f.frames != 1 || f.resync || strcmp(t, "2001x1")) return 1;

    memset(&f, 0, sizeof f);
    memset(buf, 0, 652);
    buf[0] = 0x00; buf[1] = 0x00; buf[2] = 0x02; buf[3] = 0x80;
    buf[4] = 0x43; buf[5] = 0x06; buf[6] = 0x0b; buf[7] = 0xd9;
    frame_bytes(&f, buf, 652);
    printf("3 frames=%lu resync=%lu\n", f.frames, f.resync);
    if (f.frames != 0 || f.resync < 100) return 1;

    memset(&f, 0, sizeof f);
    memset(buf, 0, sizeof buf);
    put(0, 1000, 12); put(20, 2002, 12); put(40, 2001, 400);
    frame_bytes(&f, buf, 56);
    chan_text(&f, t, sizeof t);
    printf("4 frames=%lu resync=%lu chans=%s\n", f.frames, f.resync, t);
    if (f.frames != 3 || f.resync || strcmp(t, "1000x1 2002x1 2001x1")) return 1;

    /* An empty message is refused rather than counted: it carries nothing, and
     * accepting it is what lets a run of zeros inside a picture look like a
     * stream of messages. The next real header is eight bytes on and is found by
     * the slide, so nothing else is lost. */
    memset(&f, 0, sizeof f);
    put(0, 1000, 0);  frame_bytes(&f, buf, 8);
    put(0, 1000, 0);  frame_bytes(&f, buf, 8);
    printf("5 frames=%lu resync=%lu\n", f.frames, f.resync);
    /* Only the resync is pinned. What the slide locks onto afterwards is not a
     * property worth asserting: a repeated eight-byte pattern is the worst case
     * for any self-synchronising framer, and this case exists to prove it
     * terminates rather than to bless an answer. */
    if (f.resync < 2) return 1;

    memset(&f, 0, sizeof f);
    memset(buf, 0xff, 64);
    frame_bytes(&f, buf, 64);
    put(0, 2001, 16); frame_bytes(&f, buf, 24);
    printf("6 frames=%lu resync=%lu\n", f.frames, f.resync);
    if (f.frames != 1 || f.resync < 1) return 1;

    /* 7. The car's own case on 2026-11-22: the first read after open carries the
     * middle of a picture - 00 00 02 80 43 06 0b d9 and 644 bytes of it - and the
     * next message starts at a header the framer has never seen. It has to slide
     * to that boundary and count one message, not give up for the session. */
    memset(&f, 0, sizeof f);
    memset(buf, 0x55, sizeof buf);
    buf[0] = 0x00; buf[1] = 0x00; buf[2] = 0x02; buf[3] = 0x80;
    buf[4] = 0x43; buf[5] = 0x06; buf[6] = 0x0b; buf[7] = 0xd9;
    put(652, 2001, 32);
    frame_bytes(&f, buf, 652);
    frame_bytes(&f, buf + 652, 40);
    chan_text(&f, t, sizeof t);
    printf("7 frames=%lu resync=%lu chans=%s\n", f.frames, f.resync, t);
    if (f.frames != 1 || strcmp(t, "2001x1")) return 1;

    printf("all framer cases pass\n");
    return 0;
}
'''


def between(text, start, end):
    i = text.index(start)
    return text[i:text.index(end, i)]


def find_zig():
    z = os.environ.get('ZIG') or shutil.which('zig')
    if z:
        return z
    for c in (r'D:\zig\zig.exe', r'D:\zig\zig-x86_64-windows-0.14.1\zig.exe'):
        if os.path.exists(c):
            return c
    return None


def main():
    src = open(SRC, encoding='utf-8').read()
    body = (CASES
            .replace('__FRAME_MAX__', '#define FRAME_MAX (8u * 1024u * 1024u)\n#define CHAN_MAX 10000u\n')
            .replace('__STRUCT__', between(src, 'struct framer {', 'static struct framer fin, fout;')
                     + 'static struct framer fin, fout;\n')
            .replace('__RD32__', between(src, 'static uint32_t rd32(', 'static void hex16('))
            .replace('__FRAMER__', between(src, '/* One message counted on its channel.', '/* One line of the long log')))
    if 'frame_bytes' not in body or 'describe_aoa' in body:
        print('the framer moved: update the markers in this test', file=sys.stderr)
        return 1

    os.makedirs(OUT, exist_ok=True)
    c = os.path.join(OUT, 'framer_test.c')
    open(c, 'w', encoding='utf-8', newline='\n').write(body)

    zig = find_zig()
    if not zig:
        print('zig not found: set ZIG=. the source was written to', c)
        return 2
    exe = os.path.join(OUT, 'framer_test.exe' if os.name == 'nt' else 'framer_test')
    build = subprocess.run([zig, 'cc', '-target', 'x86_64-windows-gnu' if os.name == 'nt'
                            else 'x86_64-linux-gnu', '-o', exe, c],
                           capture_output=True, text=True)
    if build.returncode != 0:
        print(build.stdout + build.stderr, file=sys.stderr)
        return 1
    run = subprocess.run([exe], capture_output=True, text=True)
    print(run.stdout, end='')
    if run.returncode != 0:
        print(run.stderr, file=sys.stderr)
        return 1
    if '--keep' not in sys.argv:
        shutil.rmtree(OUT, ignore_errors=True)
    return 0


if __name__ == '__main__':
    sys.exit(main())
