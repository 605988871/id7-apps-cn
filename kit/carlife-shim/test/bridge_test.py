#!/usr/bin/env python
# The bridge has two halves that are pure logic and one that is sockets, and the
# logic half is the one that can be wrong in a way the car shows as "no picture"
# with no other symptom:
#
#   the IN side   takes whole messages off a TCP stream and hands them to
#                 carlife eight header bytes at a time, then the body in pieces;
#   the OUT side  rebuilds messages out of carlife's writes, where the eight
#                 byte header and the body arrive as separate bulk transfers and
#                 a header can be split across two of them.
#
# So this lifts those functions out of shim.c - the real ones, not copies - and
# runs them against a fake emit, the same way framer_test.py lifts the framer.
#
# usage: python kit/carlife-shim/test/bridge_test.py [--keep]
import os
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, '..', 'src', 'shim.c')
OUT = os.path.join(HERE, '.bridge_test')

CASES = r'''
#include <stdio.h>
#include <stdint.h>
#include <string.h>
#include <stdlib.h>

/* shim.c's bridge holds one lock; the logic below only ever runs with it held,
 * so a no-op is a faithful stand-in and keeps pthread.h off the host. */
typedef int pthread_mutex_t;
#define PTHREAD_MUTEX_INITIALIZER 0
#define pthread_mutex_lock(x) 0
#define pthread_mutex_unlock(x) 0

#define FAKE_CH_MAX 4
#define FAKE_BODY_MAX (16 * 1024)
#define FAKE_MSG_MAX (8u * 1024u * 1024u)

__BE32PUT__
__STATE__
__BE32__
__QUEUE__
__INTAKE__

static int64_t now_ms(void) { return 0; }

/* The OUT direction is checked through what it would have sent. */
static struct { int chan; int n; } em[256];
static int nem;

static int test_emit(int chan, const unsigned char *p, int n)
{
    (void)p;
    if (nem < 256) { em[nem].chan = chan; em[nem].n = n; nem++; }
    return 0;
}
#define ch_write test_emit
#define ch_connect(a, b) 0

__OUT__

static unsigned char buf[1 << 20];
static unsigned char out[1 << 16];
static int fails;

static void check(const char *name, int ok)
{
    printf("%-56s %s\n", name, ok ? "ok" : "FAIL");
    if (!ok) fails++;
}

static void feed(int ch, const unsigned char *p, size_t n)
{
    rx_ensure(&ch_rx[ch], ch_rx[ch].have + n);
    memcpy(ch_rx[ch].buf + ch_rx[ch].have, p, n);
    ch_rx[ch].have += n;
    rx_pump(ch);
}

static void wipe(void)
{
    struct bmsg *m, *nx;
    int ch;
    for (ch = 0; ch < FAKE_CH_MAX; ch++) {
        for (m = ch_head[ch]; m; m = nx) { nx = m->next; free(m); }
        ch_head[ch] = ch_tail[ch] = NULL;
        ch_rx[ch].have = 0;
    }
    if (in_cur) { free(in_cur); in_cur = NULL; }
    in_off = 0;
    in_rr = 0;
    out_have = 0;
    out_rem = 0;
    nem = 0;
}

int main(void)
{
    int n, i;
    unsigned long total;

    /* 1 - one message, header then body. The header must come back on its own
     * and never be glued to the body: a real device sends it as its own
     * transfer and carlife's framer is written against that. */
    wipe();
    memset(buf, 0, sizeof buf);
    be32_put(buf, 1);
    be32_put(buf + 4, 16);
    memset(buf + 8, 0xAB, 16);
    feed(1, buf, 24);

    n = in_take(out, 204800);
    check("1 header alone: 8 bytes", n == 8);
    check("1 header is chan 1, len 16",
          n == 8 && memcmp(out, "\x00\x00\x00\x01\x00\x00\x00\x10", 8) == 0);
    n = in_take(out, 204800);
    check("1 body follows: 16 bytes", n == 16);
    check("1 body is the bytes we fed", out[0] == 0xAB && out[15] == 0xAB);
    check("1 then nothing", in_take(out, 204800) == -1);

    /* 2 - two channels waiting at once. carlife reads one endpoint, so the two
     * have to take turns; a queue that only ever serves the first would starve
     * the picture behind the control channel. */
    wipe();
    be32_put(buf, 2);
    be32_put(buf + 4, 4);
    memcpy(buf + 8, "VID1", 4);
    be32_put(buf + 12, 3);
    be32_put(buf + 16, 4);
    memcpy(buf + 20, "MED1", 4);
    feed(2, buf, 12);
    feed(3, buf + 12, 12);

    n = in_take(out, 204800);
    check("2 first message is on channel 2", n == 8 && out[3] == 2);
    in_take(out, 204800);                       /* its body */
    n = in_take(out, 204800);
    check("2 second message is on channel 3", n == 8 && out[3] == 3);
    in_take(out, 204800);
    check("2 both drained", in_take(out, 204800) == -1);

    /* 3 - half a message. Nothing may be handed over until the length is
     * satisfied, or carlife reads a body that is shorter than its header says. */
    wipe();
    be32_put(buf, 2);
    be32_put(buf + 4, 100);
    memset(buf + 8, 0x11, 50);
    feed(2, buf, 58);
    check("3 half a body is not handed over", in_take(out, 204800) == -1);
    memset(buf + 58, 0x22, 50);
    feed(2, buf + 58, 50);
    n = in_take(out, 204800);
    check("3 completes when the rest arrives", n == 8 && out[3] == 2);
    n = in_take(out, 204800);
    check("3 body is now the full 100", n == 100 && out[0] == 0x11 && out[99] == 0x22);

    /* 4 - garbage then a good message. A restarted far side leaves half a write
     * in the socket; a parser that gives up here never comes back. */
    wipe();
    memset(buf, 0xFF, 4);
    be32_put(buf + 4, 1);
    be32_put(buf + 8, 4);
    memcpy(buf + 12, "CTRL", 4);
    feed(1, buf, 16);
    n = in_take(out, 204800);
    check("4 resynchronises past four junk bytes", n == 8 && out[3] == 1);
    n = in_take(out, 204800);
    check("4 and the body is intact", n == 4 && memcmp(out, "CTRL", 4) == 0);

    /* 5 - a message bigger than one bulk read. carlife asks for 204800 bytes;
     * a 40 KB picture has to arrive in pieces no larger than FAKE_BODY_MAX and
     * add up exactly. */
    wipe();
    be32_put(buf, 2);
    be32_put(buf + 4, 40000);
    memset(buf + 8, 0x5A, 40000);
    feed(2, buf, 40008);
    n = in_take(out, 204800);
    check("5 big message: header first", n == 8 && out[3] == 2);
    total = 0;
    while ((n = in_take(out, 204800)) > 0) {
        if (n > FAKE_BODY_MAX) { fails++; printf("5 chunk too large: %d\n", n); }
        total += (unsigned long)n;
        if (total > 40000) break;
    }
    check("5 body adds up to 40000", total == 40000);
    check("5 nothing left over", in_take(out, 204800) == -1);

    /* 6 - the OUT direction. This is the shape the capture showed: eight header
     * bytes in one bulk transfer, the body in the next. Forwarding must put the
     * header back in front of the body, and must cope with the header itself
     * arriving split across two transfers. */
    wipe();
    be32_put(buf, 1);
    be32_put(buf + 4, 12);
    memset(buf + 8, 0x7E, 12);
    bridge_out(buf, 3);
    bridge_out(buf + 3, 5);
    bridge_out(buf + 8, 5);
    bridge_out(buf + 13, 7);

    check("6 three writes forwarded (header once, body twice)", nem == 3);
    check("6 header is one piece of 8 on channel 1",
          nem >= 1 && em[0].chan == 1 && em[0].n == 8);
    check("6 body follows in its own pieces",
          nem == 3 && em[1].n == 5 && em[2].n == 7);

    /* 7 - two messages back to back in one write, which happens when carlife
     * sends a header and the previous body in the same call. */
    wipe();
    be32_put(buf, 1);
    be32_put(buf + 4, 4);
    memcpy(buf + 8, "AAAA", 4);
    be32_put(buf + 12, 2);
    be32_put(buf + 16, 4);
    memcpy(buf + 20, "BBBB", 4);
    bridge_out(buf, 24);
    check("7 both headers sent", nem >= 2 && em[0].chan == 1 && em[2].chan == 2);
    check("7 body sizes kept", nem == 4 && em[1].n == 4 && em[3].n == 4);

    /* 8 - a stalled reader. A 30 fps picture is nearly 3 MB/s, so a queue with
     * no ceiling is an out-of-memory kill of the process that draws the
     * dashboard. Old messages go; the newest one stays. */
    wipe();
    {
        unsigned long before = br_dropped;
        int k;
        for (k = 0; k < 60; k++) {
            uint32_t len = 100000;
            be32_put(buf, 2);
            be32_put(buf + 4, len);
            memset(buf + 8, 0x33, len);
            feed(2, buf, 8 + len);
        }
        check("8 queue stays under the ceiling", ch_qbytes[2] <= FAKE_QMAX);
        check("8 and it really did drop", br_dropped > before);
        check("8 the newest message survived", ch_tail[2] != NULL && ch_tail[2]->len == 100000);
    }

    printf("\n%s\n", fails ? "SOMETHING FAILED" : "all bridge cases pass");
    return fails ? 1 : 0;
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
            .replace('__BE32PUT__', between(src, 'static void be32_put(', 'static int is_fake_dev('))
            .replace('__STATE__', between(src, 'struct bmsg {', 'static int fake_init_done;'))
            .replace('__BE32__', between(src, 'static uint32_t be32(', 'static void hex16('))
            .replace('__QUEUE__', between(src, '#define FAKE_QMAX', '/* Called with blink held. */'))
            .replace('__INTAKE__', between(src, 'static int in_take(', 'static int bridge_in('))
            .replace('__OUT__', between(src, 'static void bridge_out(', '/* A new open is a new stream')))
    for needed in ('rx_pump', 'in_take', 'bridge_out', 'bq_push', 'be32_put'):
        if needed not in body:
            print('the bridge moved: update the markers in this test (%s missing)' % needed,
                  file=sys.stderr)
            return 1

    os.makedirs(OUT, exist_ok=True)
    c = os.path.join(OUT, 'bridge_test.c')
    open(c, 'w', encoding='utf-8', newline='\n').write(body)

    zig = find_zig()
    if not zig:
        print('zig not found: set ZIG=. the source was written to', c)
        return 2
    exe = os.path.join(OUT, 'bridge_test.exe' if os.name == 'nt' else 'bridge_test')
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
