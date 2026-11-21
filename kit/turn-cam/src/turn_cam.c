/*
 * turn-cam - the head unit's camera picture, out of the AVB stream and into a
 * socket that the decoder reads.
 *
 * Why this exists: the camera ECU only sends a picture while something asks it
 * for a view, and the picture itself arrives on the AVB media bus, not on a
 * device node. Turn View (IterioDev/car-apps) does exactly this for the front
 * camera; this program separates the two halves so that the asking (which needs
 * the app's SOME/IP proxies and, for the side cameras, a view the stock tool
 * never asks for) can live in JavaScript, and the receiving can live here.
 *
 * What it does: joins the camera stream as one more receiver on the IAS AVB
 * bridge, depacketises RTP (rtp_h264.c: single NAL, STAP-A, FU-A) into Annex B,
 * and writes that to h264.sock. turn-decode (src/decode.c, built into this
 * component) reads that socket, decodes with the unit's MSDK, cuts the
 * picture and hands the app frames - so there is exactly one H.264 decoder on
 * the unit, already car-tested, and this program stays small enough to reason
 * about.
 *
 * Deliberately no camera request here. A receiver that asked for a view would
 * have to duplicate the camera ECU's state machine (attach, changeState, the
 * fallback views, the parking-view lockout) in C; the app already has that in
 * JavaScript, where it can be changed without a rebuild. This program receives
 * whatever the ECU is sending.
 *
 * Writes are all-or-nothing. A socket that takes half a NAL unit leaves the
 * decoder a stream whose next start code is in the wrong place, which is a
 * mosaic on screen; closing it instead makes the decoder resynchronise at the
 * next keyframe. The same reasoning as any other stream sink here.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <time.h>
#include <unistd.h>

#include "rtp_h264.h"

/* The IAS AVB bridge's C receiver API: the same three calls the unit's own
 * receivers use. Loaded with dlopen because the library is the unit's, not
 * ours - linking it would put a DT_NEEDED entry in an ELF that then refuses to
 * start on a unit whose library has a different soname. */
typedef struct {
    uint32_t size;
    void *data;
} IasAvbPacket;
typedef void (*IasAvbH264Cb)(void *handle, const IasAvbPacket *pkt, void *user);
typedef void *(*CreateFn)(const char *receiver, const char *stream);
typedef int (*RegisterFn)(void *handle, IasAvbH264Cb cb, void *user);
typedef void (*DestroyFn)(void *handle);

static CreateFn avb_create;
static RegisterFn avb_register;
static DestroyFn avb_destroy;

static const char *LIBS[] = {
    "libias-media_transport-avb_ufipc_bridge.so.1",
    "libias-media_transport-avb_ufipc_bridge.so",
    "/usr/lib/libias-media_transport-avb_ufipc_bridge.so.1",
    NULL
};

#define DIR_DEFAULT     "/dev/shm/turn-view"
#define STREAM_DEFAULT  "media_transport.avb_streaming.1"
#define DEFAULT_REPORT  DIR_DEFAULT "/turn-cam.txt"

static char g_dir[160]    = DIR_DEFAULT;
static char g_sock[192]   = DIR_DEFAULT "/h264.sock";
static char g_report[192] = DEFAULT_REPORT;
static char g_stream[128] = STREAM_DEFAULT;
static int g_verbose;

static Rtp g_rtp;

/* Written by the bridge's callback thread, read by the reporting loop. A torn
 * read costs a wrong number in a report, never a wrong picture. */
static unsigned long long g_out_bytes, g_out_drops, g_sock_errors;
static unsigned long long g_last_bytes, g_last_packets;
static unsigned long long g_byte_rate, g_packet_rate;

static int g_sock_fd = -1;

static unsigned char *g_out;
static size_t g_out_cap;

static void say(const char *fmt, ...)
{
    va_list ap;
    if (!g_verbose) return;
    va_start(ap, fmt);
    vfprintf(stderr, fmt, ap);
    va_end(ap);
    fputc('\n', stderr);
}

/* ------------------------------------------------------------------ socket */

static void out_close(void)
{
    if (g_sock_fd >= 0) close(g_sock_fd);
    g_sock_fd = -1;
}

static void out_connect(void)
{
    struct sockaddr_un a;
    int fd, sz = 4 * 1024 * 1024;

    if (g_sock_fd >= 0) return;
    fd = socket(AF_UNIX, SOCK_STREAM | SOCK_NONBLOCK | SOCK_CLOEXEC, 0);
    if (fd < 0) return;
    memset(&a, 0, sizeof a);
    a.sun_family = AF_UNIX;
    snprintf(a.sun_path, sizeof a.sun_path, "%s", g_sock);
    if (connect(fd, (struct sockaddr *)&a, sizeof a) < 0) {
        close(fd);
        return;
    }
    /* A picture is a few hundred KB and the socket's default buffer is a fifth
     * of that: without this every NAL unit is written in pieces and the reader
     * has to keep up between two writes. */
    setsockopt(fd, SOL_SOCKET, SO_SNDBUF, &sz, sizeof sz);
    g_sock_fd = fd;
    say("connected to %s", g_sock);
}

/* One whole start code and one whole NAL unit, or nothing. */
static void out_write(const unsigned char *p, size_t n)
{
    size_t done = 0;

    if (g_sock_fd < 0) out_connect();
    if (g_sock_fd < 0) { g_out_drops++; return; }
    while (done < n) {
        ssize_t k = send(g_sock_fd, p + done, n - done, MSG_NOSIGNAL);
        if (k > 0) { done += (size_t)k; continue; }
        if (k < 0 && errno == EINTR) continue;
        /* EAGAIN included on purpose: the reader is behind, and a half written
         * NAL unit is worse than a lost one. Closing makes the decoder drop
         * its session and start at the next SPS + IDR, which is a clean cut. */
        g_sock_errors++;
        out_close();
        g_out_drops++;
        return;
    }
    g_out_bytes += n;
}

/* --------------------------------------------------------------- NAL units */

static void emit_nal(void *user, const unsigned char *nal, size_t n)
{
    static const unsigned char sc[4] = { 0, 0, 0, 1 };
    size_t need;

    (void)user;
    if (!n) { g_out_drops++; return; }
    need = n + 4;
    if (need > g_out_cap) {
        unsigned char *p = realloc(g_out, need);
        if (!p) { g_out_drops++; return; }
        g_out = p;
        g_out_cap = need;
    }
    memcpy(g_out, sc, 4);
    memcpy(g_out + 4, nal, n);
    out_write(g_out, need);
}

static void on_packet(void *handle, const IasAvbPacket *pkt, void *user)
{
    (void)handle;
    (void)user;
    if (!pkt || !pkt->data || !pkt->size) return;
    rtp_push(&g_rtp, (const unsigned char *)pkt->data, pkt->size, emit_nal, NULL);
}

/* ------------------------------------------------------------------ report */

static void write_report(const char *state, const char *why)
{
    char line[640];
    int fd;

    snprintf(line, sizeof line,
        "turn-cam: %s\nstream: %s\nsocket: %s (%s)\n"
        "packets: %llu (%llu/s), gaps: %llu, lost: %llu\n"
        "nals: %llu, out: %.1f MB (%.1f MB/s)\n"
        "drops: %llu, socket errors: %llu, not RTP/H.264: %llu\n",
        state ? state : "?", g_stream, g_sock,
        g_sock_fd >= 0 ? "connected" : "not connected",
        g_rtp.packets, g_packet_rate, g_rtp.gaps, g_rtp.lost,
        g_rtp.nals, g_out_bytes / 1048576.0, g_byte_rate / 1048576.0,
        g_out_drops + g_rtp.drops, g_sock_errors, g_rtp.bad);
    (void)why;

    mkdir(g_dir, 0777);
    chmod(g_dir, 0777);
    fd = open(g_report, O_WRONLY | O_CREAT | O_TRUNC, 0644);
    if (fd >= 0) {
        size_t len = strlen(line);
        ssize_t k = write(fd, line, len);
        (void)k;
        close(fd);
    }
}

/* --------------------------------------------------------------------- main */

static int load_bridge(char *err, size_t errlen)
{
    int i;
    void *h = NULL;

    for (i = 0; LIBS[i]; i++) {
        h = dlopen(LIBS[i], RTLD_NOW | RTLD_LOCAL);
        if (h) break;
    }
    if (!h) {
        snprintf(err, errlen, "%s", dlerror() ? dlerror() : "library not found");
        return 0;
    }
    avb_create = (CreateFn)dlsym(h, "ias_avbbridge_create_receiver");
    avb_register = (RegisterFn)dlsym(h, "ias_avbbridge_register_H264_cb");
    avb_destroy = (DestroyFn)dlsym(h, "ias_avbbridge_destroy_receiver");
    if (!avb_create || !avb_register || !avb_destroy) {
        snprintf(err, errlen, "the bridge library has no receiver API");
        dlclose(h);
        return 0;
    }
    return 1;
}

static void set_dir(const char *d)
{
    if (!d || !*d) return;
    snprintf(g_dir, sizeof g_dir, "%s", d);
    snprintf(g_sock, sizeof g_sock, "%s/h264.sock", d);
    snprintf(g_report, sizeof g_report, "%s/turn-cam.txt", d);
}

int main(int argc, char **argv)
{
    char err[256] = "";
    void *handle;
    char name[64];
    int i;

    for (i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--dir") == 0 && i + 1 < argc) set_dir(argv[++i]);
        else if (strcmp(argv[i], "--sock") == 0 && i + 1 < argc) snprintf(g_sock, sizeof g_sock, "%s", argv[++i]);
        else if (strcmp(argv[i], "--stream") == 0 && i + 1 < argc) snprintf(g_stream, sizeof g_stream, "%s", argv[++i]);
        else if (strcmp(argv[i], "-v") == 0) g_verbose = 1;
        else if (strcmp(argv[i], "--selftest") == 0) {
            if (!load_bridge(err, sizeof err)) {
                printf("selftest failed: %s\n", err);
                return 1;
            }
            printf("selftest ok: bridge loaded, stream %s\n", g_stream);
            return 0;
        }
    }

    signal(SIGPIPE, SIG_IGN);
    set_dir(g_dir);
    mkdir(g_dir, 0777);
    chmod(g_dir, 0777);
    if (!rtp_init(&g_rtp, 2u * 1024u * 1024u)) {
        write_report("no memory", "");
        return 1;
    }

    if (!load_bridge(err, sizeof err)) {
        /* Staying up is the point: a unit that cannot load the bridge should
         * say so once a second on the status page, not enter a restart loop
         * that reads as a failed install. */
        write_report("bridge missing", err);
        for (;;) {
            sleep(5);
            load_bridge(err, sizeof err);
            write_report(avb_create ? "waiting for camera" : "bridge missing", "");
        }
    }

    snprintf(name, sizeof name, "turncam.%d", (int)getpid());
    handle = avb_create(name, g_stream);
    if (!handle) {
        write_report("no receiver", "the bridge refused the stream");
        return 1;
    }
    if (avb_register(handle, on_packet, NULL) != 0) {
        write_report("no callback", "register_H264_cb failed");
        avb_destroy(handle);
        return 1;
    }
    say("receiver %s on %s", name, g_stream);
    write_report("waiting for camera", "");

    for (;;) {
        unsigned long long bytes, packets;
        sleep(1);
        bytes = g_out_bytes;
        packets = g_rtp.packets;
        g_byte_rate = bytes - g_last_bytes;
        g_packet_rate = packets - g_last_packets;
        g_last_bytes = bytes;
        g_last_packets = packets;
        write_report(packets ? "receiving" : "waiting for camera", "");
    }
}
