/*
 * The depacketiser against real datagrams, on the build machine.
 *
 * Every case here is a shape the camera stream can actually take: a single NAL,
 * a STAP-A bundle, a keyframe split into FU-A fragments, a fragment that joins
 * mid-way after a loss, a sequence-number gap, a datagram from another stream
 * on the same bus. Getting one of these wrong is a mosaic on the cluster, and
 * the car is an expensive place to find out.
 *
 *   zig cc -I../src -o test_rtp.exe test_rtp.c ../src/rtp_h264.c && ./test_rtp.exe
 */
#include <stdio.h>
#include <string.h>

#include "rtp_h264.h"

static int problems;

#define CHECK(cond, what) do { \
    if (!(cond)) { printf("  FAIL %s (line %d)\n", what, __LINE__); problems++; } \
} while (0)

/* What the depacketiser handed out, in order. */
static unsigned char out[8][4096];
static size_t out_len[8];
static int out_count;

static void collect(void *user, const unsigned char *nal, size_t n)
{
    (void)user;
    if (out_count >= 8 || n > sizeof out[0]) return;
    memcpy(out[out_count], nal, n);
    out_len[out_count] = n;
    out_count++;
}

/* An RTP header + payload, payload type 96. */
static size_t rtp(unsigned char *b, unsigned seq, const unsigned char *payload, size_t n)
{
    memset(b, 0, 12);
    b[0] = 0x80;                 /* version 2, no padding, no extension, no CSRC */
    b[1] = 96;                   /* H.264, dynamic payload type */
    b[2] = (unsigned char)(seq >> 8);
    b[3] = (unsigned char)seq;
    b[8] = 0x11; b[9] = 0x22; b[10] = 0x33; b[11] = 0x44;   /* SSRC */
    memcpy(b + 12, payload, n);
    return 12 + n;
}

static void reset(void)
{
    out_count = 0;
    memset(out_len, 0, sizeof out_len);
}

static Rtp r;

static void single_nal(void)
{
    unsigned char pkt[64], pl[5] = { 0x67, 0x42, 0x00, 0x1f, 0x8c };   /* SPS header */
    size_t n;

    reset();
    n = rtp(pkt, 1, pl, sizeof pl);
    rtp_push(&r, pkt, n, collect, NULL);
    CHECK(out_count == 1, "single NAL: one unit out");
    CHECK(out_len[0] == sizeof pl, "single NAL: length kept");
    CHECK(memcmp(out[0], pl, sizeof pl) == 0, "single NAL: bytes unchanged");
    CHECK(r.nals == 1, "single NAL: counted");
}

static void stap_a(void)
{
    unsigned char pkt[64], pl[16];
    size_t n, i = 0;

    reset();
    pl[i++] = 24;                                  /* STAP-A */
    pl[i++] = 0; pl[i++] = 2; pl[i++] = 0x67; pl[i++] = 0xaa;   /* first NAL */
    pl[i++] = 0; pl[i++] = 3; pl[i++] = 0x68; pl[i++] = 0xbb; pl[i++] = 0xcc;
    n = rtp(pkt, 2, pl, i);
    rtp_push(&r, pkt, n, collect, NULL);
    CHECK(out_count == 2, "STAP-A: two units out");
    CHECK(out_len[0] == 2 && out[0][0] == 0x67, "STAP-A: first unit");
    CHECK(out_len[1] == 3 && out[1][0] == 0x68, "STAP-A: second unit");
}

static void fu_a(void)
{
    unsigned char pkt[64], pl[16];
    size_t n;
    unsigned seq = 10;

    reset();
    /* start fragment: FU indicator (NRI 3, type 28), FU header (S=1, type 5) */
    pl[0] = 0x7c; pl[1] = 0x85; pl[2] = 0x01; pl[3] = 0x02;
    n = rtp(pkt, seq++, pl, 4);
    rtp_push(&r, pkt, n, collect, NULL);
    CHECK(out_count == 0, "FU-A: nothing before the last fragment");

    pl[0] = 0x7c; pl[1] = 0x05; pl[2] = 0x03; pl[3] = 0x04;   /* middle */
    n = rtp(pkt, seq++, pl, 4);
    rtp_push(&r, pkt, n, collect, NULL);
    CHECK(out_count == 0, "FU-A: still nothing");

    pl[0] = 0x7c; pl[1] = 0x45; pl[2] = 0x05; pl[3] = 0x06;   /* end */
    n = rtp(pkt, seq++, pl, 4);
    rtp_push(&r, pkt, n, collect, NULL);
    CHECK(out_count == 1, "FU-A: one unit out");
    CHECK(out_len[0] == 7, "FU-A: reassembled length");
    /* The rebuilt header is the FU indicator's F/NRI with the FU header's type:
     * 0x65 = NRI 3, type 5 (IDR). */
    CHECK(out[0][0] == 0x65, "FU-A: rebuilt NAL header");
    CHECK(out[0][1] == 0x01 && out[0][6] == 0x06, "FU-A: payload order kept");
}

static void fu_a_without_start(void)
{
    unsigned char pkt[64], pl[8];
    size_t n;

    reset();
    pl[0] = 0x7c; pl[1] = 0x05; pl[2] = 0x01; pl[3] = 0x02;
    n = rtp(pkt, 20, pl, 4);
    rtp_push(&r, pkt, n, collect, NULL);
    CHECK(out_count == 0, "mid-fragment: nothing out");
    CHECK(r.drops == 1, "mid-fragment: counted as a drop");
}

static void sequence_gap(void)
{
    unsigned char pkt[64], pl[8];
    size_t n;

    unsigned long long gaps = r.gaps, lost = r.lost;

    reset();
    r.have_seq = 0;               /* the earlier cases left their own sequence behind */
    pl[0] = 0x41; pl[1] = 0x01;
    n = rtp(pkt, 30, pl, 2);
    rtp_push(&r, pkt, n, collect, NULL);
    n = rtp(pkt, 34, pl, 2);      /* three datagrams missing */
    rtp_push(&r, pkt, n, collect, NULL);
    CHECK(r.gaps == gaps + 1, "gap: counted");
    CHECK(r.lost == lost + 3, "gap: three lost");
    CHECK(out_count == 2, "gap: whole NAL units still delivered");
}

static void not_ours(void)
{
    unsigned char pkt[64], pl[4] = { 0x41, 0x01, 0x02, 0x03 };
    size_t n;
    unsigned long long bad = r.bad;

    reset();
    n = rtp(pkt, 40, pl, 2);
    pkt[0] = 0x40;                              /* RTP version 1 */
    rtp_push(&r, pkt, n, collect, NULL);
    CHECK(out_count == 0 && r.bad == bad + 1, "not RTP: dropped");

    n = rtp(pkt, 41, pl, 2);
    pkt[1] = 97;                                /* another payload type */
    rtp_push(&r, pkt, n, collect, NULL);
    CHECK(out_count == 0 && r.bad == bad + 2, "not H.264: dropped");
}

static void header_variants(void)
{
    unsigned char pkt[64], pl[4] = { 0x41, 0x01, 0x02, 0x03 };
    size_t n;

    /* CSRC list: one identifier shifts the payload by four bytes. */
    reset();
    n = rtp(pkt, 50, pl, 4);
    pkt[0] = 0x81;                              /* one CSRC */
    memmove(pkt + 16, pkt + 12, 4);
    pkt[12] = 0xaa; pkt[13] = 0; pkt[14] = 0; pkt[15] = 0;
    rtp_push(&r, pkt, n + 4, collect, NULL);
    CHECK(out_count == 1 && out[0][0] == 0x41, "CSRC: payload found");

    /* Extension header: profile 2 bytes + length 2 bytes, then words. */
    reset();
    n = rtp(pkt, 51, pl, 4);
    pkt[0] = 0x90;                              /* extension */
    memmove(pkt + 20, pkt + 12, 4);
    memset(pkt + 12, 0, 8);
    pkt[14] = 0; pkt[15] = 1;                   /* one extension word */
    rtp_push(&r, pkt, n + 8, collect, NULL);
    CHECK(out_count == 1 && out[0][0] == 0x41, "extension: payload found");

    /* Padding: the last byte says how many bytes to take off the end. */
    reset();
    n = rtp(pkt, 52, pl, 4);
    pkt[0] = 0xa0;                              /* padding */
    pkt[n] = 0; pkt[n + 1] = 2;                 /* two bytes, count in the last one */
    rtp_push(&r, pkt, n + 2, collect, NULL);
    CHECK(out_count == 1 && out_len[0] == 4, "padding: trimmed");
}

int main(void)
{
    if (!rtp_init(&r, 4096)) {
        printf("no memory\n");
        return 1;
    }
    printf("rtp:\n");
    single_nal();
    stap_a();
    fu_a();
    fu_a_without_start();
    sequence_gap();
    not_ours();
    header_variants();
    rtp_free(&r);

    if (problems) {
        printf("test_rtp: %d problem(s)\n", problems);
        return 1;
    }
    printf("test_rtp ok: single NAL, STAP-A, FU-A, mid-fragment, gap, foreign RTP, headers\n");
    return 0;
}
