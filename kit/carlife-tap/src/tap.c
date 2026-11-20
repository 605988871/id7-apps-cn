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
 * Report: /dev/shm/carlife-tap.txt (text, rewritten at most every 2 s).
 * Marker: /dev/shm/carlife-tap.loaded, written by any process that loads this
 * library, so the installing tool can prove the library loads and runs on the
 * unit without touching CarLife.
 *
 * Sink: /dev/shm/carlife-map/live.sock. Every inbound chunk is also written
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
#define SINK "/dev/shm/carlife-map/live.sock"
#define CHUNKS 4
#define HEAD 24

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
static char out[3072];
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
    char b[320];
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
    scan_annexb((const unsigned char *)buf, n);
    sink_write(buf, n);
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
