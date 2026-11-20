/* SPDX-License-Identifier: GPL-3.0-or-later
 *
 * What the library must do to a process that preloads it: nothing, except
 * write its report. It is run with LD_PRELOAD=libcarlife-tap.so, so every
 * call below goes through the interposers in src/tap.c.
 *
 * A path prefix (CARLIFE_TAP_FAKE) stands in for the phone's usbfs node,
 * because a build container has none: the stream read from a file under it is
 * what the parser would see on the unit.
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

int main(void)
{
    const char *fake = getenv("CARLIFE_TAP_FAKE");
    const char *rep = getenv("CARLIFE_TAP_OUT");
    chk(fake && *fake, "CARLIFE_TAP_FAKE is set");
    chk(rep && *rep, "CARLIFE_TAP_OUT is set");
    if (!fake || !rep || !*fake || !*rep) return 1;

    /* the head of a CarLife session: SPS, PPS, then an IDR slice */
    static const unsigned char h264[] = {
        0, 0, 0, 1, 0x67, 0x42, 0x00, 0x1e, 0x95, 0xa8, 0x14, 0x01,
        0, 0, 0, 1, 0x68, 0xce, 0x38, 0x80,
        0, 0, 0, 1, 0x65, 0x88, 0x84, 0x00,
    };
    char dir[192], path[256];
    snprintf(dir, sizeof dir, "%s", fake);
    mkdir(dir, 0755);
    snprintf(path, sizeof path, "%s/stream.h264", fake);

    int fd = open(path, O_RDWR | O_CREAT | O_TRUNC, 0644);
    chk(fd >= 0, "the stand-in device opens");
    if (fd < 0) return 1;
    chk(write(fd, h264, sizeof h264) == (ssize_t)sizeof h264, "the stream is written");
    lseek(fd, 0, SEEK_SET);

    unsigned char got[64];
    memset(got, 0xAA, sizeof got);
    ssize_t n = read(fd, got, sizeof got);
    chk(n == (ssize_t)sizeof h264, "read returns every byte the carriage carries");
    chk(n > 0 && memcmp(got, h264, (size_t)n) == 0, "read hands the bytes back unchanged");

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
        chk(strstr(txt, "sps=1") != NULL, "the SPS is counted");
        chk(strstr(txt, "pps=1") != NULL, "the PPS is counted");
        chk(strstr(txt, "idr=1") != NULL, "the IDR slice is counted");
        if (fails) {
            printf("--- report ---\n%s\n", txt);
        }
    }

    close(fd);
    printf("%s: %d failure(s)\n", fails ? "FAILED" : "passed", fails);
    return fails ? 1 : 0;
}
