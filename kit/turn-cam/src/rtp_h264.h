/*
 * RTP H.264 depacketiser (RFC 3550 / RFC 6184), the small part of turn-cam that
 * decides where one NAL unit ends and the next begins.
 *
 * Kept apart from the AVB and socket code so that it can be tested on the build
 * machine with real datagrams: a mistake here is a mosaic on the cluster, and
 * the car is an expensive place to find one.
 *
 * Handles single NAL units, STAP-A and FU-A. STAP-B, MTAP and FU-B only occur
 * in interleaved mode, which this stream does not use; they are counted and
 * dropped rather than guessed at.
 *
 * Not thread-safe. One caller at a time, as the bridge's callback is.
 */
#ifndef TURN_CAM_RTP_H264_H
#define TURN_CAM_RTP_H264_H

#include <stddef.h>
#include <stdint.h>

typedef struct {
    unsigned char *fu;          /* FU-A reassembly buffer */
    size_t fu_cap, fu_len;
    int fu_active;

    unsigned long long packets; /* datagrams seen */
    unsigned long long nals;    /* NAL units handed out */
    unsigned long long drops;   /* NAL units or fragments discarded */
    unsigned long long bad;     /* not RTP, not H.264, or too short */
    unsigned long long gaps;    /* sequence-number discontinuities */
    unsigned long long lost;    /* datagrams missing by sequence number */

    uint16_t last_seq;
    int have_seq;
} Rtp;

/* Called with one whole NAL unit, header included, no start code. The pointer
 * is valid only during the call. */
typedef void (*RtpEmit)(void *user, const unsigned char *nal, size_t n);

/* fu_cap: the largest NAL unit that can be reassembled (2 MB is generous for
 * a 1080p keyframe). Returns 0 when there is no memory for it. */
int rtp_init(Rtp *r, size_t fu_cap);
void rtp_free(Rtp *r);

/* One datagram, or nothing. Never emits a partial NAL unit. */
void rtp_push(Rtp *r, const unsigned char *pkt, size_t n, RtpEmit emit, void *user);

#endif
