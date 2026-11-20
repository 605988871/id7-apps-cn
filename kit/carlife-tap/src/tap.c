// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * carlife-tap: an LD_PRELOAD library that watches what CarLife reads from the
 * phone and writes a short report. It is the first half of "CarLife's map on
 * the instrument cluster": CarLife sends one H.264 stream over USB (AOA), the
 * phone has no second display to offer, so the picture has to be copied out of
 * the carlife process itself. This library is that copy point.
 *
 * It observes, it does not alter: every call is forwarded unchanged to the
 * kernel and the payload is only read, never rewritten. Two functions are
 * interposed, nothing else:
 *
 *   read()   the bulk endpoint read straight off the usbfs handle
 *   ioctl()  the same endpoint by URB (SUBMITURB/REAPURB) or by
 *            USBDEVFS_BULK, which is how libusb and most userspace drivers
 *            actually move the data
 *
 * Both forward with raw syscalls rather than dlsym(RTLD_NEXT): the unit
 * already preloads /usr/lib/libschedeconfig.so.1 into carlife, and going
 * through the kernel directly means neither library can shadow the other.
 * open() is deliberately not interposed (that is the one call a configuration
 * shim is likely to care about); a usbfs descriptor is recognised by its
 * /proc/self/fd link instead, once, and then remembered.
 *
 * ---- the protocol, as CarLife frames it ----
 *
 * The bytes copied for the picture also carry CarLife's own framing:
 *
 *   video    u32 len | u32 ts(ms) | u32 0x00020001 | len bytes of Annex B
 *   command  u16 len | u16 pad    | u32 serviceType | len bytes of protobuf
 *
 * That is what the phone and the head unit exchange, and command packet
 * 0x00018007 ("video encoder init") is the head unit **asking for a size**:
 * protobuf field 1 = width, 2 = height, 3 = frame rate. Whatever the phone
 * encodes, it encodes at that size - which is why CarLife has no second
 * picture for the cluster, and why the crop settings have to be measured
 * against a number the car chose, not one we guessed.
 *
 * So this library classifies instead of assuming. Once per process it decides
 * whether the stream is framed (above) or bare Annex B, counts packets per
 * service type, keeps the first bytes of each type for a human to read, and
 * decodes those three fields. If the stream is framed the copy handed to the
 * app carries payload only, so the decoder never sees a protocol header. If
 * the stream is bare, nothing changes: the chunk goes out as it came in.
 *
 * Report: /dev/shm/carlife-tap.txt (text, rewritten at most every 2 s).
 * Marker: /dev/shm/carlife-tap.loaded, written by any process that loads this
 * library, so the installing tool can prove the library loads and runs on the
 * unit without touching CarLife.
 *
 * Sink: /dev/shm/carlife-map/h264.sock. Every inbound chunk is also written
 * there, unchanged, for the CarLife Map app to read. The socket is optional in
 * every sense: non-blocking, MSG_NOSIGNAL (a closed reader must never raise
 * SIGPIPE in carlife), a full buffer drops the chunk instead of buffering it
 * in carlife's memory, and no reader at all costs one connect attempt per
 * second. Capture must not be able to hurt the thing it observes.
 *
 * Build: kit/carlife-tap/build-zig.sh (zig cc, x86_64-linux-gnu.2.27, the
 * unit's glibc).
 */

#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>      /* AT_FDCWD and the O_* the report file is opened with */
#include <stdarg.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/un.h>
#include <time.h>
#include <unistd.h>

/* ---- the kernel's usbfs interface, spelled out so no kernel headers are
 * needed on the build machine. Sizes are what the ioctl numbers encode, so
 * they are asserted rather than trusted. ---- */
struct usbdevfs_urb {
    unsigned char type;
    unsigned char endpoint;
    int status;
    unsigned int flags;
    void *buffer;
    int buffer_length;
    int actual_length;
    int start_frame;
    union {
        int number_of_packets;
        unsigned int stream_id;
    };
    int error_count;
    unsigned int signr;
    void *usercontext;
};

struct usbdevfs_bulktransfer {
    unsigned int ep;
    unsigned int len;
    unsigned int timeout;
    void *data;
};

_Static_assert(sizeof(struct usbdevfs_urb) == 56, "usbdevfs_urb must match the kernel's");
_Static_assert(sizeof(struct usbdevfs_bulktransfer) == 24, "usbdevfs_bulktransfer must match the kernel's");

/* ioctl numbers are matched by type and number only (not by their encoded
 * size), so a kernel that grew a field would still be recognised. */
#define UF_TYPE(cmd) (((cmd) >> 8) & 0xffu)
#define UF_NR(cmd) ((cmd) & 0xffu)
#define UF_BULK 2u
#define UF_SUBMITURB 10u
#define UF_REAPURB 12u
#define UF_REAPURBNDELAY 13u
#define UF_CLAIMINTERFACE 15u

#define MAXFD 2048
#define REPORT "/dev/shm/carlife-tap.txt"
#define MARKER "/dev/shm/carlife-tap.loaded"
/* carlife-decode listens here and turns the stream into the pictures the
 * apps draw; the apps themselves only ever see decoded frames. */
#define SINK "/dev/shm/carlife-map/h264.sock"
#define CHUNKS 4
#define HEAD 24

/* ---- what the protocol probe needs ---- */
#define MSG_VIDEO_DATA 0x00020001u  /* phone -> car, H.264 payload */
#define MSG_VIDEO_INIT 0x00018007u  /* car -> phone, the size it wants */
#define RING (1024u * 1024u)        /* reassembly window: one keyframe fits */
#define MAXPKT (4u * 1024u * 1024u) /* longer than any packet the phone sends */
#define TYPE_SLOTS 12
#define TYPE_HEAD 24
#define MAX_RESEEK 8192u            /* this many misses and the framing is wrong */
#define MAXCMD_TIGHT 4096u          /* while resyncing, only this much is believable */

static int on;                 /* watching this process */
static const char *rep_path = REPORT;
/* Test only (kit/carlife-tap/test): a path prefix that stands in for the
 * phone's usbfs node, so the parser can be exercised where there is no USB.
 * Never set for carlife on the unit. */
static const char *fake_prefix;
static unsigned char usbfd[MAXFD];
static unsigned long long in_urbs, in_bytes, out_urbs, out_bytes, submits;
static int iface = -1;
static char devpath[64];
static int chunk_n;
static unsigned int chunk_len[CHUNKS];
static unsigned char chunk_head[CHUNKS][HEAD];
static unsigned long long starts, n_sps, n_pps, n_idr, n_slice;
static unsigned char p0, p1;
/* Plain longs, not volatile: every access below goes through the __sync
 * builtins, which are the ordering. volatile here would only make GCC warn
 * about a qualifier the builtin does not take (and -Werror turns that into a
 * failed build). */
static long last_write;
static int rep_lock;

/* ---- tiny append-only formatter over a static buffer ---- */
static char out[8192];
static size_t outn;

static void put(const char *s)
{
    size_t n = strlen(s);
    if (outn + n >= sizeof out) n = sizeof out - 1 - outn;
    memcpy(out + outn, s, n);
    outn += n;
    out[outn] = 0;
}

static void putf(const char *fmt, ...)
{
    char b[400];
    va_list ap;
    va_start(ap, fmt);
    int n = vsnprintf(b, sizeof b, fmt, ap);
    va_end(ap);
    if (n > 0) put(b);
}

static void puthex(const unsigned char *p, size_t n)
{
    static const char *d = "0123456789abcdef";
    for (size_t i = 0; i < n && outn + 2 < sizeof out; i++) {
        out[outn++] = d[p[i] >> 4];
        out[outn++] = d[p[i] & 15];
        out[outn] = 0;
    }
}

static void clock_now(char *b, size_t n)
{
    time_t t = time(NULL);
    struct tm tm;
    localtime_r(&t, &tm);
    strftime(b, n, "%H:%M:%S", &tm);
}

/* ---- handing the stream to whoever is listening ---- */
static int sink_fd = -1;
static long sink_next;
static unsigned long long sink_bytes, sink_drops;

static void sink_close(void)
{
    if (sink_fd >= 0) syscall(SYS_close, sink_fd);
    sink_fd = -1;
}

static int sink_connect(void)
{
    if (sink_fd >= 0) return 1;
    long now = (long)time(NULL);
    if (now < sink_next) return 0;
    sink_next = now + 1;                 /* one attempt a second, never a loop */

    int fd = (int)syscall(SYS_socket, AF_UNIX, SOCK_STREAM | SOCK_NONBLOCK | SOCK_CLOEXEC, 0);
    if (fd < 0) return 0;
    struct sockaddr_un sa;
    memset(&sa, 0, sizeof sa);
    sa.sun_family = AF_UNIX;
    strncpy(sa.sun_path, SINK, sizeof sa.sun_path - 1);
    long r = syscall(SYS_connect, fd, &sa, sizeof sa);
    if (r != 0 && errno != EINPROGRESS) { syscall(SYS_close, fd); return 0; }
    sink_fd = fd;
    return 1;
}

/* Non-blocking and without SIGPIPE: if the app is not running, or is slower
 * than the phone, the chunk is dropped. Buffering it would grow carlife's
 * memory, and raising SIGPIPE would kill it - neither is acceptable for an
 * observer. */
static void sink_write(const void *buf, size_t n)
{
    if (!on || !n) return;
    if (sink_fd < 0 && !sink_connect()) return;
    long w = syscall(SYS_sendto, sink_fd, buf, n, 0x4000 /* MSG_NOSIGNAL */, NULL, 0);
    if (w == (long)n) { __sync_fetch_and_add(&sink_bytes, n); return; }
    __sync_fetch_and_add(&sink_drops, 1);
    if (w < 0 && (errno == EAGAIN || errno == EWOULDBLOCK || errno == ENOBUFS)) return;
    sink_close();                        /* reader went away: reconnect later */
}

/* ---- the stream, as it goes past ---- */
static void scan_annexb(const unsigned char *b, size_t n)
{
    for (size_t i = 0; i < n; i++) {
        unsigned char c = b[i];
        if (p0 == 0 && p1 == 0 && c == 1) {
            starts++;
            if (i + 1 < n) {
                unsigned t = b[i + 1] & 0x1f;
                if (t == 7) n_sps++;
                else if (t == 8) n_pps++;
                else if (t == 5) n_idr++;
                else if (t == 1) n_slice++;
            }
        }
        p0 = p1;
        p1 = c;
    }
}

/* ---- the protocol probe -------------------------------------------------
 *
 * Everything below is bookkeeping on bytes that are already in memory: no
 * packet is allocated, none is held past the reassembly window, and a stream
 * that does not frame the way CarLife does falls back to the byte-for-byte
 * passthrough that 0.2 did.
 */
static unsigned char ring[RING];
static size_t ring_len;
static int framed = -1;                    /* -1 undecided, 0 bare, 1 framed */
static int proto_lock;
static unsigned long long reseek, resyncs, pkt_video, vbytes, pkt_cmd, cbytes;
static unsigned media_w, media_h, media_fps;

struct ctype {
    unsigned type;
    unsigned long long n, bytes;
    unsigned hlen;
    unsigned char head[TYPE_HEAD];
};
static struct ctype types[TYPE_SLOTS];
static int ntypes;

static unsigned be16(const unsigned char *p)
{
    return ((unsigned)p[0] << 8) | (unsigned)p[1];
}

static unsigned be32(const unsigned char *p)
{
    return ((unsigned)p[0] << 24) | ((unsigned)p[1] << 16) | ((unsigned)p[2] << 8) | (unsigned)p[3];
}

/* 0x0001xxxx: the command channel's service types all live in that range. */
static int is_cmd_type(unsigned t)
{
    return (t >> 16) == 1u;
}

/* A read does not have to begin on a packet boundary - if this library is
 * loaded after the session started, the first bytes are the middle of
 * something. Look for a video header inside the window instead of giving up:
 * the type word follows a length that has to be believable. */
static size_t find_video_hdr(const unsigned char *p, size_t n)
{
    for (size_t k = 8; k + 4 <= n; k++) {
        if (p[k] == 0 && p[k + 1] == 2 && p[k + 2] == 0 && p[k + 3] == 1) {
            unsigned len = be32(p + k - 8);
            if (len >= 4 && len <= MAXPKT) return k - 8;
        }
    }
    return (size_t)-1;
}

static int pb_varint(const unsigned char *p, size_t n, size_t *i, unsigned long long *v)
{
    unsigned long long r = 0;
    unsigned shift = 0;
    while (*i < n && shift < 64) {
        unsigned char c = p[(*i)++];
        r |= (unsigned long long)(c & 0x7f) << shift;
        if (!(c & 0x80)) { *v = r; return 1; }
        shift += 7;
    }
    return 0;
}

/* The video size request is three varint fields. Anything else in the payload
 * (wire types 1/2/5) is skipped so a longer message still parses. */
static void pb_video_size(const unsigned char *p, size_t n)
{
    size_t i = 0;
    while (i < n) {
        unsigned long long tag, v;
        if (!pb_varint(p, n, &i, &tag)) return;
        unsigned field = (unsigned)(tag >> 3), wire = (unsigned)(tag & 7);
        if (wire == 0) {
            if (!pb_varint(p, n, &i, &v)) return;
            if (field == 1) media_w = (unsigned)v;
            else if (field == 2) media_h = (unsigned)v;
            else if (field == 3) media_fps = (unsigned)v;
        } else if (wire == 2) {
            if (!pb_varint(p, n, &i, &v)) return;
            if (v > (unsigned long long)(n - i)) return;
            i += (size_t)v;
        } else if (wire == 5) {
            if (n - i < 4) return;
            i += 4;
        } else if (wire == 1) {
            if (n - i < 8) return;
            i += 8;
        } else {
            return;
        }
    }
}

static void proto_cmd(unsigned type, const unsigned char *p, unsigned n)
{
    struct ctype *c = NULL;
    for (int i = 0; i < ntypes; i++) {
        if (types[i].type == type) { c = &types[i]; break; }
    }
    if (!c && ntypes < TYPE_SLOTS) {
        c = &types[ntypes++];
        c->type = type;
        c->n = 0;
        c->bytes = 0;
        c->hlen = 0;
    }
    if (c) {
        c->n++;
        c->bytes += n;
        if (!c->hlen) {
            c->hlen = n < TYPE_HEAD ? n : TYPE_HEAD;
            memcpy(c->head, p, c->hlen);
        }
    }
    if (type == MSG_VIDEO_INIT) pb_video_size(p, n);
}

static void raw_path(const unsigned char *b, size_t n)
{
    scan_annexb(b, n);
    sink_write(b, n);
}

static void ring_add(const unsigned char *b, size_t n)
{
    if (n > RING) { b += n - RING; n = RING; }   /* keep the newest */
    if (n > RING - ring_len) {
        size_t keep = RING - n;
        if (keep > ring_len) keep = ring_len;
        memmove(ring, ring + ring_len - keep, keep);
        ring_len = keep;
        resyncs++;
        /* Something arriving is larger than the window: the packet we were
         * waiting for can never complete now, and waiting forever would mean
         * no picture at all. Hand the stream over bare instead - a decoder
         * finds its next start code and the picture survives. */
        if (framed == 1) framed = 0;
    }
    memcpy(ring + ring_len, b, n);
    ring_len += n;
}

static void proto_parse(void)
{
    size_t pos = 0;
    while (pos < ring_len) {
        const unsigned char *p = ring + pos;
        size_t avail = ring_len - pos;
        int handled = 0;

        if (framed < 0) {
            if (avail >= 12 && be32(p + 8) == MSG_VIDEO_DATA) { framed = 1; continue; }
            if (avail >= 8 && is_cmd_type(be32(p + 4))) { framed = 1; continue; }
            /* 00 00 01 / 00 00 00 01 at the head: nothing wraps this stream */
            if (avail >= 4 && p[0] == 0 && p[1] == 0 && (p[2] == 1 || (p[2] == 0 && p[3] == 1))) {
                framed = 0;
                break;
            }
            if (avail >= 64) {
                /* the window does not start on a boundary: look inside it */
                size_t k = find_video_hdr(p, avail);
                if (k != (size_t)-1) {
                    reseek += k;
                    pos += k;
                    framed = 1;
                    continue;
                }
                framed = 0;
                break;                              /* no framing to find */
            }
            break;                                  /* wait for more bytes */
        }
        if (framed == 0) break;
        /* Both headers are decided from the same window: with fewer than 12
         * bytes a video header would be half-read, and its length word (whose
         * top half is zero for a small frame) would pass for a very short
         * command packet. Wait. */
        if (avail < 12) break;

        /* A byte that only looks like a header can claim a length that never
         * arrives. In a clean stream any command length is believable; while
         * resyncing only a small one is, because that is all the command
         * channel carries. */
        if (be32(p + 8) == MSG_VIDEO_DATA && be32(p) <= MAXPKT) {
            unsigned len = be32(p);
            if (avail < 12 + (size_t)len) break;        /* packet still arriving */
            pkt_video++;
            vbytes += len;
            scan_annexb(p + 12, len);
            sink_write(p + 12, len);
            pos += 12 + (size_t)len;
            handled = 1;
        } else if (is_cmd_type(be32(p + 4)) && (!reseek || be16(p) <= MAXCMD_TIGHT)) {
            unsigned len = be16(p);
            if (avail < 8 + (size_t)len) break;
            pkt_cmd++;
            cbytes += len;
            proto_cmd(be32(p + 4), p + 8, len);
            pos += 8 + (size_t)len;
            handled = 1;
        }
        if (!handled) {
            reseek++;
            pos++;
            if (reseek > MAX_RESEEK) { framed = 0; break; }
        }
    }
    if (pos) {
        memmove(ring, ring + pos, ring_len - pos);
        ring_len -= pos;
    }
}

static void proto_feed(const unsigned char *b, size_t n)
{
    if (framed == 0) { raw_path(b, n); return; }
    while (__sync_lock_test_and_set(&proto_lock, 1)) {
    }
    ring_add(b, n);
    proto_parse();
    if (framed == 0 && ring_len) {          /* decided against framing: drain */
        raw_path(ring, ring_len);
        ring_len = 0;
    }
    __sync_lock_release(&proto_lock);
}

static void tap_in(const void *buf, size_t n)
{
    __sync_fetch_and_add(&in_urbs, 1);
    __sync_fetch_and_add(&in_bytes, n);
    /* the slot is taken atomically: two threads of the projection stack can
     * be reading at once, and an overflow here would be in carlife's address
     * space, not ours. */
    int i = __sync_fetch_and_add(&chunk_n, 1);
    if (i < CHUNKS) {
        chunk_len[i] = (unsigned int)n;
        size_t h = n < HEAD ? n : HEAD;
        memcpy(chunk_head[i], buf, h);
    }
    proto_feed((const unsigned char *)buf, n);
}

static void tap_out(size_t n)
{
    __sync_fetch_and_add(&out_urbs, 1);
    __sync_fetch_and_add(&out_bytes, n);
}

/* ---- writing the report ---- */
static void write_all(const char *path, const char *data, size_t n, int append)
{
    int fd = (int)syscall(SYS_openat, AT_FDCWD, path,
                          O_WRONLY | O_CREAT | (append ? O_APPEND : O_TRUNC), 0644);
    if (fd < 0) return;
    size_t done = 0;
    while (done < n) {
        long w = syscall(SYS_write, fd, data + done, n - done);
        if (w <= 0) break;
        done += (size_t)w;
    }
    syscall(SYS_close, fd);
}

static void report(void)
{
    char t[32];
    /* one writer at a time: the projection stack reads on several threads,
     * and a report torn in two would be unreadable rather than harmless */
    while (__sync_lock_test_and_set(&rep_lock, 1)) {
    }
    outn = 0;
    out[0] = 0;
    clock_now(t, sizeof t);
    putf("=== CARLIFE TAP %s pid=%ld ===\n", t, (long)syscall(SYS_getpid));
    putf("usb fd: %s\n", devpath[0] ? devpath : "(none seen)");
    if (iface < 0) put("claim: (none seen)\n");
    else putf("claim: interface %d\n", iface);
    putf("urbs: in=%llu (%.1fMB) out=%llu (%.1fMB) submits=%llu\n",
         in_urbs, (double)in_bytes / (1024.0 * 1024.0),
         out_urbs, (double)out_bytes / (1024.0 * 1024.0), submits);
    putf("sink: %s sent=%.1fMB drops=%llu\n",
         sink_fd >= 0 ? "connected" : "no reader",
         (double)sink_bytes / (1024.0 * 1024.0), sink_drops);
    /* One line for the framing question: does this pipe carry CarLife's
     * headers at all, and are there command packets next to the picture? */
    putf("proto: %s video=%llu/%.1fMB cmd=%llu/%lluB reseek=%llu resync=%llu\n",
         framed < 0 ? "undecided" : (framed ? "framed" : "raw"),
         pkt_video, (double)vbytes / (1024.0 * 1024.0), pkt_cmd, cbytes,
         reseek, resyncs);
    if (media_w || media_h)
        putf("media: %ux%u@%u  (the car asked the phone for this size)\n",
             media_w, media_h, media_fps);
    for (int i = 0; i < ntypes; i++) {
        putf("cmd 0x%08x n=%llu %lluB ", types[i].type, types[i].n, types[i].bytes);
        puthex(types[i].head, types[i].hlen);
        put("\n");
    }
    for (int i = 0; i < CHUNKS && i < chunk_n; i++) {
        putf("in#%d len=%u ", i + 1, chunk_len[i]);
        puthex(chunk_head[i], chunk_len[i] < HEAD ? chunk_len[i] : HEAD);
        put("\n");
    }
    putf("annexb: %s  starts=%llu sps=%llu pps=%llu idr=%llu slice=%llu\n",
         starts ? "yes" : "no", starts, n_sps, n_pps, n_idr, n_slice);
    if (!in_urbs) put("(no usb traffic yet: connect the phone and open CarLife)\n");
    write_all(rep_path, out, outn, 0);
    __sync_lock_release(&rep_lock);
}

static void maybe_report(void)
{
    long now = (long)time(NULL);
    long was = last_write;
    if (now - was < 2) return;
    if (!__sync_bool_compare_and_swap(&last_write, was, now)) return;
    report();
}

/* ---- which descriptor is the phone ---- */
static int is_usb_fd(int fd)
{
    if (fd < 0) return 0;
    if (fd < MAXFD) {
        if (usbfd[fd] == 1) return 1;
        if (usbfd[fd] == 2) return 0;
    }
    char link[64], path[128];
    snprintf(link, sizeof link, "/proc/self/fd/%d", fd);
    long n = syscall(SYS_readlink, link, path, sizeof path - 1);
    if (n <= 0) {
        if (fd < MAXFD) usbfd[fd] = 2;
        return 0;
    }
    path[n] = 0;
    if (fake_prefix && strncmp(path, fake_prefix, strlen(fake_prefix)) == 0) {
        if (fd < MAXFD) usbfd[fd] = 1;
        if (!devpath[0]) snprintf(devpath, sizeof devpath, "%d -> %.48s", fd, path);
        return 1;
    }
    if (strncmp(path, "/dev/bus/usb/", 13) == 0) {
        if (fd < MAXFD) usbfd[fd] = 1;
        if (!devpath[0]) snprintf(devpath, sizeof devpath, "%d -> %.48s", fd, path);
        return 1;
    }
    if (fd < MAXFD) usbfd[fd] = 2;             /* not the phone: never looked at again */
    return 0;
}

/* ---- the two interposed calls ---- */
ssize_t read(int fd, void *buf, size_t n)
{
    long r = syscall(SYS_read, fd, buf, n);
    if (r > 0 && on && is_usb_fd(fd)) {
        tap_in(buf, (size_t)r);
        maybe_report();
    }
    return (ssize_t)r;
}

int ioctl(int fd, unsigned long req, ...)
{
    va_list ap;
    void *arg = NULL;
    va_start(ap, req);
    arg = va_arg(ap, void *);
    va_end(ap);

    long r = syscall(SYS_ioctl, fd, req, arg);
    if (!on || UF_TYPE(req) != (unsigned long)'U') return (int)r;

    switch (UF_NR(req)) {
    case UF_REAPURB:
    case UF_REAPURBNDELAY: {
        if (r != 0 || !arg) break;
        void *p = *(void **)arg;
        if (!p) break;
        struct usbdevfs_urb *u = (struct usbdevfs_urb *)p;
        if (u->status != 0 || u->actual_length <= 0 || !u->buffer) break;
        if (u->endpoint & 0x80) tap_in(u->buffer, (size_t)u->actual_length);
        else tap_out((size_t)u->actual_length);
        maybe_report();
        break;
    }
    case UF_BULK: {
        if (r < 0 || !arg) break;
        struct usbdevfs_bulktransfer *b = (struct usbdevfs_bulktransfer *)arg;
        if (b->ep & 0x80) tap_in(b->data, (size_t)r);
        else tap_out((size_t)r);
        maybe_report();
        break;
    }
    case UF_SUBMITURB:
        if (r == 0) __sync_fetch_and_add(&submits, 1);
        break;
    case UF_CLAIMINTERFACE:
        if (r == 0 && arg && iface < 0) iface = (int)(*(unsigned int *)arg & 0xffff);
        break;
    default:
        break;
    }
    return (int)r;
}

/* ---- load ---- */
__attribute__((constructor)) static void carlife_tap_init(void)
{
    char exe[160] = {0};
    long n = syscall(SYS_readlink, "/proc/self/exe", exe, sizeof exe - 1);
    if (n > 0) exe[n] = 0;

    /* Any process that loads this library leaves a marker: the installing
     * tool runs LD_PRELOAD=<this> /bin/sh -c ':' and looks for it, which
     * proves the library resolves and its constructor runs on the unit. */
    char line[256];
    char t[32];
    clock_now(t, sizeof t);
    int m = snprintf(line, sizeof line, "%s pid=%ld exe=%s\n", t,
                     (long)syscall(SYS_getpid), exe);
    if (m > 0) write_all(MARKER, line, (size_t)m, 1);

    const char *off = getenv("CARLIFE_TAP");
    if (off && off[0] == '0') return;
    if (!strstr(exe, "carlife")) return;       /* not the projection process */

    const char *p = getenv("CARLIFE_TAP_OUT");
    if (p && p[0]) rep_path = p;
    p = getenv("CARLIFE_TAP_FAKE");
    if (p && p[0]) fake_prefix = p;

    on = 1;
    report();                                  /* a first, empty report at once */
}

/* The library is never unloaded, but a report at exit costs nothing and
 * catches the last seconds of a session. */
__attribute__((destructor)) static void carlife_tap_fini(void)
{
    if (on) report();
    sink_close();
}
