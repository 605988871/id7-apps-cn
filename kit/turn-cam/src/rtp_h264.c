#include "rtp_h264.h"

#include <stdlib.h>
#include <string.h>

int rtp_init(Rtp *r, size_t fu_cap)
{
    memset(r, 0, sizeof *r);
    if (fu_cap < 64) fu_cap = 64;
    r->fu = malloc(fu_cap);
    if (!r->fu) return 0;
    r->fu_cap = fu_cap;
    return 1;
}

void rtp_free(Rtp *r)
{
    free(r->fu);
    r->fu = NULL;
    r->fu_cap = 0;
}

void rtp_push(Rtp *r, const unsigned char *pkt, size_t n, RtpEmit emit, void *user)
{
    size_t off, end;
    const unsigned char *q;
    size_t qn;
    unsigned type;
    int cc, ext, pad;

    r->packets++;
    if (n < 12 || (pkt[0] >> 6) != 2) { r->bad++; return; }

    /* A sequence-number gap means bytes are missing: the fragment in flight
     * has a hole in it and must not be handed to the decoder as if whole. */
    {
        uint16_t seq = (uint16_t)((pkt[2] << 8) | pkt[3]);
        if (r->have_seq) {
            uint16_t d = (uint16_t)(seq - r->last_seq);
            if (d != 1) {
                r->gaps++;
                r->lost += d ? (unsigned long long)(d - 1) : 0;
                r->fu_active = 0;
            }
        }
        r->last_seq = seq;
        r->have_seq = 1;
    }

    cc = pkt[0] & 0x0f;
    ext = (pkt[0] >> 4) & 1;
    pad = (pkt[0] >> 5) & 1;
    off = 12 + (size_t)cc * 4;
    if (ext) {
        size_t words;
        if (off + 4 > n) { r->bad++; return; }
        words = ((size_t)pkt[off + 2] << 8) | pkt[off + 3];
        off += 4 + words * 4;
    }
    if (off >= n) { r->bad++; return; }

    end = n;
    if (pad) {
        size_t p = pkt[n - 1];
        if (p == 0 || p > n - off) { r->bad++; return; }
        end = n - p;
    }
    if (end <= off) { r->bad++; return; }

    /* Someone else's RTP can share the bus. This stream is payload type 96
     * (dynamic, H.264 by agreement); anything else is not ours to parse. */
    if ((pkt[1] & 0x7f) != 96) { r->bad++; return; }

    q = pkt + off;
    qn = end - off;
    type = q[0] & 0x1f;

    if (type >= 1 && type <= 23) {
        r->fu_active = 0;
        emit(user, q, qn);
        r->nals++;
    } else if (type == 24) {                     /* STAP-A */
        size_t i = 1;
        r->fu_active = 0;
        while (i + 2 <= qn) {
            size_t l = ((size_t)q[i] << 8) | q[i + 1];
            i += 2;
            if (!l || i + l > qn) { r->drops++; break; }
            emit(user, q + i, l);
            r->nals++;
            i += l;
        }
    } else if (type == 28) {                     /* FU-A */
        int start, fin;
        unsigned nt;
        if (qn < 2) { r->bad++; return; }
        start = (q[1] >> 7) & 1;
        fin = (q[1] >> 6) & 1;
        nt = q[1] & 0x1f;
        if (start) {
            /* The original NAL header: FU indicator's F and NRI, FU header's
             * type. Getting this byte wrong turns an IDR into a slice the
             * decoder cannot use. */
            r->fu[0] = (unsigned char)((q[0] & 0xe0) | nt);
            r->fu_len = 1;
            r->fu_active = 1;
        }
        if (!r->fu_active) { r->drops++; return; }   /* joined mid-fragment */
        if (r->fu_len + (qn - 2) > r->fu_cap) {
            r->fu_active = 0;
            r->drops++;
            return;
        }
        memcpy(r->fu + r->fu_len, q + 2, qn - 2);
        r->fu_len += qn - 2;
        if (fin) {
            emit(user, r->fu, r->fu_len);
            r->fu_active = 0;
            r->nals++;
        }
    } else {
        r->drops++;                              /* STAP-B, MTAP, FU-B */
    }
}
