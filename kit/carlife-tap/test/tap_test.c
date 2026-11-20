/* SPDX-License-Identifier: GPL-3.0-or-later
 *
 * What the library must do to a process that preloads it: nothing, except
 * write its report. It is run with LD_PRELOAD=libcarlife-tap.so, so every
 * call below goes through the interposers in src/tap.c.
 *
 * A path prefix (CARLIFE_TAP_FAKE) stands in for the phone's usbfs node,
 * because a build container has none: the stream read from a file under it is
 * what the parser would see on the unit.
 *
 *   carlife-tap-test raw      bare Annex B, the way 0.2 saw the stream
 *   carlife-tap-test framed   CarLife's headers around it (what 0.3 looks for)
 *
 * Both modes matter. The parser has to survive a stream it does not recognise
 * without changing a byte, and it has to find the size request when the
 * headers are there.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/stat.h>
#include <unistd.h>

static int fails;

static void chk(int ok, const char *what)
{
    printf("%s %s\n", ok ? "ok  " : "FAIL", what);
    if (!ok) fails++;
}

static char *slurp(const char *p)
{
    FILE *f = fopen(p, "rb");
    if (!f) return NULL;
    static char buf[8192];
    size_t n = fread(buf, 1, sizeof buf - 1, f);
    fclose(f);
    buf[n] = 0;
    return buf;
}

/* "sps=" followed by a number; -1 when the line is not there. The stream is
 * read twice, so the counts are doubled by the time the report is looked at -
 * the checks below only assert "at least what this stream contains". */
static long field(const char *t, const char *key)
{
    const char *p = strstr(t, key);
    if (!p) return -1;
    return strtol(p + strlen(key), NULL, 10);
}

/* the head of a CarLife session: SPS, PPS, then an IDR slice */
static const unsigned char h264[] = {
    0, 0, 0, 1, 0x67, 0x42, 0x00, 0x1e, 0x95, 0xa8, 0x14, 0x01,
    0, 0, 0, 1, 0x68, 0xce, 0x38, 0x80,
    0, 0, 0, 1, 0x65, 0x88, 0x84, 0x00,
};

/* "the panel is 1920x720 at 30 fps": protobuf 08 <1920> 10 <720> 18 30 */
static const unsigned char init[] = {
    0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x80, 0x07,   /* u16 len, pad, type */
    0x08, 0x80, 0x0f, 0x10, 0xd0, 0x05, 0x18, 0x1e,
};

static size_t build(unsigned char *dst, int framed)
{
    size_t n = 0;
    if (framed) {
        memcpy(dst + n, init, sizeof init);
        n += sizeof init;
        unsigned len = (unsigned)sizeof h264;
        dst[n + 0] = (unsigned char)(len >> 24);
        dst[n + 1] = (unsigned char)(len >> 16);
        dst[n + 2] = (unsigned char)(len >> 8);
        dst[n + 3] = (unsigned char)len;
        memset(dst + n + 4, 0, 4);                     /* timestamp */
        dst[n + 8] = 0x00; dst[n + 9] = 0x02;          /* 0x00020001 */
        dst[n + 10] = 0x00; dst[n + 11] = 0x01;
        n += 12;
        memcpy(dst + n, h264, sizeof h264);
        n += sizeof h264;
    } else {
        memcpy(dst + n, h264, sizeof h264);
        n += sizeof h264;
    }
    return n;
}

int main(int argc, char **argv)
{
    const int framed = argc > 1 && strcmp(argv[1], "framed") == 0;
    const char *fake = getenv("CARLIFE_TAP_FAKE");
    const char *rep = getenv("CARLIFE_TAP_OUT");
    chk(fake && *fake, "CARLIFE_TAP_FAKE is set");
    chk(rep && *rep, "CARLIFE_TAP_OUT is set");
    if (!fake || !rep || !*fake || !*rep) return 1;

    unsigned char stream[256];
    size_t sn = build(stream, framed);

    char dir[192], path[256];
    snprintf(dir, sizeof dir, "%s", fake);
    mkdir(dir, 0755);
    snprintf(path, sizeof path, "%s/stream.bin", fake);

    int fd = open(path, O_RDWR | O_CREAT | O_TRUNC, 0644);
    chk(fd >= 0, "the stand-in device opens");
    if (fd < 0) return 1;
    chk(write(fd, stream, sn) == (ssize_t)sn, "the stream is written");
    lseek(fd, 0, SEEK_SET);

    unsigned char got[512];
    memset(got, 0xAA, sizeof got);
    ssize_t n = read(fd, got, sizeof got);
    chk(n == (ssize_t)sn, "read returns every byte the carriage carries");
    chk(n > 0 && memcmp(got, stream, (size_t)n) == 0, "read hands the bytes back unchanged");

    /* an ioctl the library does not know must reach the kernel untouched */
    void *urb = NULL;
    errno = 0;
    int r = ioctl(fd, (unsigned long)(('U' << 8) | 12), &urb);
    chk(r == -1 && errno == ENOTTY, "an unknown usbfs ioctl passes through (ENOTTY)");

    /* the report is rate limited to one every two seconds: a second read
     * after the interval is what makes the first one count */
    sleep(3);
    lseek(fd, 0, SEEK_SET);
    read(fd, got, sizeof got);

    char *txt = slurp(rep);
    chk(txt != NULL, "the report is written");
    if (txt) {
        chk(strstr(txt, "CARLIFE TAP") != NULL, "the report names itself");
        chk(strstr(txt, "usb fd:") != NULL, "the report names the device");
        chk(strstr(txt, "annexb: yes") != NULL, "the stream is recognised as Annex B");
        chk(field(txt, "sps=") >= 1, "the SPS is counted");
        chk(field(txt, "pps=") >= 1, "the PPS is counted");
        chk(field(txt, "idr=") >= 1, "the IDR slice is counted");
        if (framed) {
            chk(strstr(txt, "proto: framed") != NULL, "the framing is recognised");
            chk(strstr(txt, "media: 1920x720@30") != NULL, "the size the car asked for is decoded");
            chk(strstr(txt, "cmd 0x00018007") != NULL, "the size request is named");
            chk(field(txt, "video=") >= 1, "the video packets are counted");
        } else {
            chk(strstr(txt, "proto: raw") != NULL, "bare Annex B is not framed by force");
            chk(strstr(txt, "media:") == NULL, "no size is invented for a raw stream");
        }
        if (fails) {
            printf("--- report ---\n%s\n", txt);
        }
    }

    close(fd);
    printf("%s: %d failure(s)\n", fails ? "FAILED" : "passed", fails);
    return fails ? 1 : 0;
}
