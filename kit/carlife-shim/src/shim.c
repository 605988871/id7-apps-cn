/* carlife-shim - an LD_PRELOAD library for the unit's own carlife.
 *
 * The probe of 2026-11-22 settled what that USB port carries: the phone
 * enumerates as 18d1:2d01 (Google accessory, PID 2D01 = accessory + audio),
 * carlife holds /dev/bus/usb/001/005, and no usb0/rndis interface exists. So
 * the CarLife messages ride inside AOA bulk packets, and Baidu's own patent
 * (CN106844275A, table 1) spells the packet out:
 *
 *     [Channel ID u32][Msg Len u32][CarLife Msg ...]
 *
 * which is the same eight bytes this kit's README has described since the first
 * capture - over TCP there is no such header, because each channel is a
 * connection of its own.
 *
 * What that header actually holds on this unit, read off the screen on
 * 2026-11-23: the first inbound transfer is eight bytes, 00 00 00 01 00 00 00 0a
 * - channel 1 carrying ten bytes - and the header arrives in a transfer of its
 * own, with the body following it. Both words are big-endian, like every other
 * length in the CarLife protocol. The previous build read them little-endian,
 * which turned that same header into channel 16777216 with a length of
 * 167772160, and the framer then counted picture data as messages.
 *
 * That is the whole opening. If the transport is just a pipe of labelled
 * packets, a library between carlife and libusb can hand carlife the same
 * packets - except they arrive from a socket to the phone instead of a cable.
 * Everything above the transport stays the car's own: its decoder (libmfxhw64
 * is mapped), its UI, its HUD and cluster projection, its steering wheel keys.
 * Nothing here reimplements CarLife, and nothing here draws a pixel.
 *
 * This build only *watches*. Every call is forwarded to the real libusb and
 * logged, so the next build knows which functions to stand in for, how carlife
 * enumerates, how large its bulk buffers are, whether it uses the sync or the
 * async API, and which channel numbers it actually puts in the header. A shim
 * that guesses those is a shim that crashes the one process the car needs.
 *
 * Three files under /dev/shm/carlife-shim, all world-readable because the app
 * that shows them is not root:
 *
 *   state.txt  a dozen lines, rewritten twice a second - what the app draws.
 *              Legible on a 1920x720 screen, and enough to tell "the library
 *              never loaded" from "it loaded and the phone never came".
 *   tap.txt    the call log itself, capped at 256 KB so a long drive cannot
 *              fill shm. Long lines, read by a human.
 *   head.txt   the first bytes of each direction, one line per transfer, kept
 *              for the first eight transfers and then frozen. This exists
 *              because "is there an eight-byte header at all" is the one
 *              question the aggregate counters cannot answer: a log full of
 *              picture data looks the same whether the header is four bytes,
 *              eight bytes or absent.
 *
 * Failure policy: if a real symbol is missing the call fails with
 * LIBUSB_ERROR_NOT_SUPPORTED instead of crashing, and the log says so. The
 * install script watches for exactly that and rolls itself back.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
#include <sys/stat.h>
#include <sys/time.h>

#define EXPORT __attribute__((visibility("default")))
#define NOT_SUPPORTED (-12)             /* LIBUSB_ERROR_NOT_SUPPORTED */

/* The libusb types we must name. The unit has no libusb headers and the build
 * host has no reason to. Nothing here dereferences a handle, and the structs
 * below are the stable part of libusb 1.0's ABI: descriptor layouts have not
 * moved, and every accessor that fills them in is the real one. */
struct libusb_context;
struct libusb_device;
struct libusb_device_handle;
typedef struct libusb_context libusb_context;
typedef struct libusb_device libusb_device;
typedef struct libusb_device_handle libusb_device_handle;

struct libusb_device_descriptor {
    uint8_t bLength, bDescriptorType;
    uint16_t bcdUSB;
    uint8_t bDeviceClass, bDeviceSubClass, bDeviceProtocol, bMaxPacketSize0;
    uint16_t idVendor, idProduct, bcdDevice;
    uint8_t iManufacturer, iProduct, iSerialNumber, bNumConfigurations;
};

struct libusb_endpoint_descriptor {
    uint8_t bLength, bDescriptorType, bEndpointAddress, bmAttributes;
    uint16_t wMaxPacketSize;
    uint8_t bInterval, bRefresh, bSynchAddress;
    const unsigned char *extra;
    int extra_length;
};

struct libusb_interface_descriptor {
    uint8_t bLength, bDescriptorType, bInterfaceNumber, bAlternateSetting;
    uint8_t bNumEndpoints, bInterfaceClass, bInterfaceSubClass;
    uint8_t bInterfaceProtocol, iInterface;
    const struct libusb_endpoint_descriptor *endpoint;
    const unsigned char *extra;
    int extra_length;
};

struct libusb_interface {
    const struct libusb_interface_descriptor *altsetting;
    int num_altsetting;
};

struct libusb_config_descriptor {
    uint8_t bLength, bDescriptorType;
    uint16_t wTotalLength;
    uint8_t bNumInterfaces, bConfigurationValue, iConfiguration;
    uint8_t bmAttributes, MaxPower;
    const struct libusb_interface *interface;
    const unsigned char *extra;
    int extra_length;
};

/* Read-only, leading fields only, and the buffer pointer is deliberately never
 * dereferenced: if this layout ever drifts the log shows nonsense instead of
 * taking a page fault inside carlife. */
struct libusb_transfer {
    libusb_device_handle *dev_handle;
    uint8_t flags;
    unsigned char endpoint;
    unsigned char type;
    unsigned int timeout;
    int status;
    int length;
    int actual_length;
    void *callback;
    void *user_data;
};

#define SHM_DIR "/dev/shm/carlife-shim"
#define LOG_CAP (256 * 1024)

/* A CarLife message is [channel u32][length u32] followed by that many bytes,
 * but a transfer is not a message: a 200 KB picture arrives as several bulk
 * reads, and only the first of them starts with a header. Reading the first
 * eight bytes of every transfer - which is what the state line used to do -
 * reports picture data as a channel number, and a 3.6 GB length for a 652-byte
 * read. The framer below reassembles the byte stream per endpoint so the counts
 * land on real message boundaries. */
#define FRAME_MAX (8u * 1024u * 1024u)
/* CarLife's channels are small numbers: the one clean session on this unit used
 * 1000, 2000 and 2001, and the patent's example table stays in the thousands.
 * A four-digit ceiling is what makes this a filter rather than a formality - at
 * 0xffff, picture bytes land on "channel 55563" often enough to stop the slide;
 * at 10000 they do not. */
#define CHAN_MAX 10000u

/* Keep this many transfers and this many bytes of each, then stop writing:
 * a file that stops changing is a file the screen can page without the
 * pagination being redone twice a second. */
#define HEAD_TX 8
#define HEAD_TXBYTES 24
#define HEAD_LINE ((HEAD_TXBYTES) * 3 + 1)

static pthread_mutex_t lock = PTHREAD_MUTEX_INITIALIZER;
static int log_fd = -1;
static size_t log_bytes;
static int log_full;
static int64_t boot_ms;

struct tally { unsigned long calls, bytes; };
static struct tally tin[16], tout[16];
static unsigned long ctrl_calls;
static unsigned long long in_bytes, out_bytes;
static unsigned long in_calls, out_calls;
static unsigned long async_submits, async_events;
static char req_text[64];
static unsigned char seen_req[16];
static int n_seen_req;
static char dev_text[160] = "(none seen)";
static char cfg_text[200] = "(not read)";
static char open_text[80] = "(not opened)";
static char last_in[140] = "(nothing yet)";
static char last_out[140] = "(nothing yet)";
static int64_t state_ms;

struct framer {
    unsigned char hdr[8];
    int have;                        /* header bytes collected, 0..8 */
    int payload;                     /* 1 while the body of a message is passing */
    unsigned long rem;               /* body bytes still to come */
    uint32_t chan;                   /* channel of the last complete header */
    unsigned long frames, resync, bytes;
    struct { uint32_t chan; unsigned long n; } ch[8];
    int nch;
};
static struct framer fin, fout;

/* The first transfers of each direction, verbatim. The counters say how much
 * came through; only the bytes say where a message begins. */
struct head {
    unsigned long total;             /* bytes seen, kept or not */
    int nt;                          /* transfers kept */
    int done;
    struct {
        unsigned long off;           /* stream offset of the first byte kept */
        int got, want;
        unsigned char b[HEAD_TXBYTES];
        int n;
    } t[HEAD_TX];
};
static struct head hin, hout;
static int head_dirty;

/* The first transfer in each direction, verbatim: two big-endian words and the
 * size that arrived. 00000001 0000000a on an eight-byte read is channel 1
 * carrying ten bytes - a control message whose body comes next. 00000280
 * 43060bd9 would be picture data sitting where a header is expected, which is
 * the one outcome that sends this design back to the drawing board. */
static char first_in[48] = "(nothing yet)";
static char first_out[48] = "(nothing yet)";

static int64_t now_ms(void)
{
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (int64_t)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

/* Big-endian, and that is not a detail. The first reading on the car decoded
 * these words little-endian and got chan=16777216 len=167772160 out of the
 * bytes 00 00 00 01 00 00 00 0a; read the other way it is channel 1 carrying
 * ten bytes, which is what a control message looks like. CarLife speaks network
 * order everywhere - the wireless link in kit/carlife-link writes its own
 * header with be16_put/be32_put - so the packet on USB is read the same way.
 * Getting this wrong does not fail loudly: the framer simply locks onto
 * picture data and reports seventeen messages on channel 512. */
static uint32_t be32(const unsigned char *p)
{
    return (uint32_t)p[0] << 24 | (uint32_t)p[1] << 16 | (uint32_t)p[2] << 8 | (uint32_t)p[3];
}

static void hex16(char *out, size_t cap, const unsigned char *p, int n)
{
    size_t o = 0;
    int i;
    if (n > 16) n = 16;
    for (i = 0; i < n && o + 3 < cap; i++)
        o += (size_t)snprintf(out + o, cap - o, "%02x", p[i]);
    out[o] = '\0';
}

/* Bytes as four-byte groups, which is how the header has to be read: a u32 at a
 * time, big-endian. Running the pairs together makes that reading an exercise
 * in counting characters on a 1920-wide screen, and grouping them makes "which
 * four bytes are the channel" a question of looking rather than counting. */
static void hex_group(char *out, size_t cap, const unsigned char *p, int n)
{
    size_t o = 0;
    int i;
    for (i = 0; i < n && o + 10 < cap; i++) {
        o += (size_t)snprintf(out + o, cap - o, "%02x", p[i]);
        if (i % 4 == 3 && i != n - 1 && o + 2 < cap) out[o++] = ' ';
    }
    out[o] = '\0';
}

/* Keep the head of the stream, not a window of it: a 652-byte transfer followed
 * by a 1 KB one needs both of their first bytes side by side, and a contiguous
 * window would hold only the first. */
static void head_add(struct head *h, const unsigned char *p, int got, int want)
{
    int k, take;

    if (got > 0 && h->nt < HEAD_TX) {
        k = h->nt++;
        h->t[k].off = h->total;
        h->t[k].got = got;
        h->t[k].want = want;
        take = got < HEAD_TXBYTES ? got : HEAD_TXBYTES;
        memcpy(h->t[k].b, p, (size_t)take);
        h->t[k].n = take;
        head_dirty = 1;
        if (h->nt == HEAD_TX) h->done = 1;
    }
    if (got > 0) h->total += (unsigned long)got;
}

/* The first eight bytes of a transfer, in wire order, plus the size that came:
 * "00000280 43060bd9  652B". Two words to compare against the length of the
 * read, which is the whole decision. */
static const char *head_text(const unsigned char *d, int avail)
{
    static char out[48];
    char hx[HEAD_LINE];

    if (avail <= 0) {
        snprintf(out, sizeof out, "(no bytes)");
        return out;
    }
    hex_group(hx, sizeof hx, d, avail < 8 ? avail : 8);
    snprintf(out, sizeof out, "%s  %dB", hx, avail);
    return out;
}

/* One message counted on its channel. Eight slots is more than CarLife uses; a
 * ninth channel is dropped rather than growing the array - this runs inside
 * carlife and allocates nothing. */
static void count_chan(struct framer *f, uint32_t chan)
{
    int i;
    for (i = 0; i < f->nch; i++)
        if (f->ch[i].chan == chan) { f->ch[i].n++; return; }
    if (f->nch < (int)(sizeof f->ch / sizeof f->ch[0])) {
        f->ch[f->nch].chan = chan;
        f->ch[f->nch].n = 1;
        f->nch++;
    }
}

/* A header the framer is willing to believe: a small channel number and a
 * length that fits in a buffer. Both tests matter. Without the channel test a
 * picture's first four bytes (00 00 02 80 reads as 0x80020000) pass whenever
 * the next word happens to be small, and the count then drifts for the rest of
 * the session. */
static int plausible(uint32_t chan, uint32_t len)
{
    /* A length of zero is refused, and that single test does most of the work:
     * eight zero bytes - the commonest eight bytes in a video stream - pass
     * every other check. A message that carries nothing is worth missing; a
     * stream that locks onto one every few hundred bytes is not. */
    return len > 0 && len <= FRAME_MAX && chan <= CHAN_MAX;
}

/* Walk a transfer's bytes as a stream: header, body, header, body. Each
 * iteration either consumes a byte or changes state, so this terminates, and it
 * never writes to the buffer it is handed.
 *
 * When eight bytes do not look like a header the stream is one byte further in
 * than assumed, so it slides one byte and looks again. The earlier build gave up
 * until the next transfer instead, which on a stream that starts mid-message
 * meant it never recovered: 2777 transfers produced one message and two hundred
 * resyncs. Sliding is what makes a framer self-synchronising. */
static void frame_bytes(struct framer *f, const unsigned char *p, int n)
{
    int i = 0;

    if (n <= 0) return;
    f->bytes += (unsigned long)n;
    while (i < n) {
        if (f->payload) {
            unsigned long left = (unsigned long)(n - i);
            unsigned long take = f->rem < left ? f->rem : left;
            i += (int)take;
            f->rem -= take;
            if (!f->rem) f->payload = 0;
            continue;
        }
        while (f->have < 8 && i < n) f->hdr[f->have++] = p[i++];
        if (f->have < 8) return;
        {
            uint32_t chan = be32(f->hdr), len = be32(f->hdr + 4);
            if (plausible(chan, len)) {
                f->have = 0;
                f->chan = chan;
                f->frames++;
                count_chan(f, chan);
                f->payload = 1;
                f->rem = len;
                continue;
            }
            f->resync++;
            memmove(f->hdr, f->hdr + 1, 7);
            f->have = 7;
        }
    }
}

/* "1000x80 2000x23 2001x1100", in the order the channels first appeared. */
static void chan_text(const struct framer *f, char *out, size_t cap)
{
    size_t o = 0;
    int i;
    for (i = 0; i < f->nch && o + 26 < cap; i++)
        o += (size_t)snprintf(out + o, cap - o, "%s%ux%lu", i ? " " : "",
                              (unsigned)f->ch[i].chan, f->ch[i].n);
    if (!o) snprintf(out, cap, "(none)");
}

/* One line of the long log, timestamped, dropped once the file is full: the
 * first 256 KB of a session is the part worth reading anyway. */
static void tap(const char *fmt, ...)
{
    char line[512];
    int n;
    va_list ap;

    if (log_fd < 0 || log_full) return;
    n = snprintf(line, sizeof line, "%6lld ", (long long)(now_ms() - boot_ms));
    if (n < 0) return;
    va_start(ap, fmt);
    n += vsnprintf(line + n, sizeof line - (size_t)n, fmt, ap);
    va_end(ap);
    if (n < 0) return;
    if (n > (int)sizeof line - 2) n = (int)sizeof line - 2;
    line[n++] = '\n';
    if (write(log_fd, line, (size_t)n) == n) {
        log_bytes += (size_t)n;
        if (log_bytes > LOG_CAP) log_full = 1;
    }
}

static void write_all(int fd, const char *p, int n)
{
    int o = 0;
    while (o < n) {
        int w = (int)write(fd, p + o, (size_t)(n - o));
        if (w <= 0) return;
        o += w;
    }
}

/* head.txt: one line per transfer, first eight of each direction. Written as
 * it fills and then never again, so its mtime settles and the screen can page
 * it without redoing the layout. */
static void put_head(void)
{
    char body[1800], path[160], hex[HEAD_LINE];
    int n = 0, fd, d, i;

    n += snprintf(body + n, sizeof body - (size_t)n,
                  "carlife-shim head - pid %d\n", (int)getpid());
    for (d = 0; d < 2; d++) {
        struct head *h = d ? &hout : &hin;
        n += snprintf(body + n, sizeof body - (size_t)n,
                      "%s %lu bytes, %d transfers\n", d ? "out" : "in", h->total, h->nt);
        if (!h->nt) n += snprintf(body + n, sizeof body - (size_t)n, "  (nothing yet)\n");
        for (i = 0; i < h->nt && n < (int)sizeof body - 120; i++) {
            hex_group(hex, sizeof hex, h->t[i].b, h->t[i].n);
            n += snprintf(body + n, sizeof body - (size_t)n,
                          "  t%d @%lu want=%d got=%d  %s\n",
                          i + 1, h->t[i].off, h->t[i].want, h->t[i].got, hex);
        }
    }

    snprintf(path, sizeof path, "%s/head.tmp", SHM_DIR);
    fd = open(path, O_WRONLY | O_CREAT | O_TRUNC, 0644);
    if (fd < 0) return;
    write_all(fd, body, n);
    close(fd);
    snprintf(path, sizeof path, "%s/head.txt", SHM_DIR);
    {
        char tmp[160];
        snprintf(tmp, sizeof tmp, "%s/head.tmp", SHM_DIR);
        rename(tmp, path);
    }
}

static void put_state(void)
{
    char body[2048], path[160];
    int n = 0, fd;

#define ADD(...) do { \
        if (n >= 0 && n < (int)sizeof body - 1) { \
            int r_ = snprintf(body + n, sizeof body - (size_t)n, __VA_ARGS__); \
            if (r_ > 0) n += r_; \
        } \
    } while (0)

    ADD("state: tap\n");
    ADD("pid: %d  comm: carlife\n", (int)getpid());
    ADD("devices: %.150s\n", dev_text);
    ADD("config: %.190s\n", cfg_text);
    ADD("open: %.70s\n", open_text);
    ADD("ctrl: %lu calls, reqs %.60s\n", ctrl_calls, req_text[0] ? req_text : "(none yet)");
    /* Two counts on one line: the page has fourteen rows for thirteen facts, and
     * the log's own size is something the app can stat for itself. */
    ADD("io: %lu in %llu KB, %lu out %llu KB\n",
        in_calls, in_bytes / 1024, out_calls, out_bytes / 1024);
    ADD("first in: %.40s\n", first_in);
    ADD("first out: %.40s\n", first_out);
    ADD("last in: %.130s\n", last_in);
    ADD("last out: %.130s\n", last_out);
    /* Messages, not transfers: this is the line that tells a stand-in device
     * whether the AOA header is really [chan][len] on this unit, which channel
     * carries the picture, and whether any transfer boundary fell inside one.
     * One line, not two: the shim block has to fit a column on the screen. */
    {
        char ci[120];
        chan_text(&fin, ci, sizeof ci);
        /* `aligned` is the word that matters: it means the eight-byte header was
         * found at every message boundary and the framer never had to slide, so
         * [chan][len] is the real layout and a stand-in can be written against
         * it. The slide count only appears once it is not zero - a page that
         * always carries it makes the good session look as noisy as the bad. */
        if (fin.resync + fout.resync)
            ADD("frames: %lu in / %lu out, slid %lu, %.50s\n",
                fin.frames, fout.frames, fin.resync + fout.resync, ci);
        else
            ADD("frames: %lu in / %lu out, aligned, %.50s\n", fin.frames, fout.frames, ci);
    }
    if (async_submits)
        ADD("async: %lu submits, %lu loops\n", async_submits, async_events);
#undef ADD

    snprintf(path, sizeof path, "%s/state.tmp", SHM_DIR);
    fd = open(path, O_WRONLY | O_CREAT | O_TRUNC, 0644);
    if (fd < 0) return;
    write_all(fd, body, n);
    close(fd);
    snprintf(path, sizeof path, "%s/state.txt", SHM_DIR);
    {
        char tmp[160];
        snprintf(tmp, sizeof tmp, "%s/state.tmp", SHM_DIR);
        rename(tmp, path);
    }
}

static void tick(void)
{
    int64_t t = now_ms();
    if (t - state_ms < 500) return;
    state_ms = t;
    put_state();
}

/* Resolve a real symbol. RTLD_NEXT covers the normal case - carlife links
 * libusb directly, so it is in the global scope by the time it calls us. The
 * second attempt is for something under carlife that dlopen()s libusb with
 * RTLD_LOCAL: it is still mapped, so RTLD_NOLOAD finds that same copy. */
static void *sym(const char *name)
{
    void *p = dlsym(RTLD_NEXT, name);
    if (!p) {
        void *h = dlopen("libusb-1.0.so.0", RTLD_LAZY | RTLD_NOLOAD);
        if (h) p = dlsym(h, name);
    }
    return p;
}

static int missing(const char *name)
{
    pthread_mutex_lock(&lock);
    tap("%s: not resolvable - refusing the call", name);
    pthread_mutex_unlock(&lock);
    return NOT_SUPPORTED;
}

/* What this one transfer looks like on its own. `len` is what the header at
 * offset zero claims, and it only has to agree with `avail` when the transfer
 * happens to carry exactly one message - a picture is split across several.
 * The framer's counters are the authority; this line is the per-transfer view. */
static void describe_aoa(char *out, size_t cap, const unsigned char *d, int avail)
{
    uint32_t chan, len, type;
    char hx[HEAD_LINE];

    if (avail < 8) {
        snprintf(out, cap, "%d bytes, too few for a header", avail);
        return;
    }
    /* An eight-byte transfer is the normal shape of a header: the phone writes
     * the header, then the body, and the driver keeps them apart. */

    chan = be32(d);
    len = be32(d + 4);
    type = avail >= 16 ? be32(d + 12) : 0;
    if (!plausible(chan, len)) {
        /* The transfer began in the middle of a message: those eight bytes are
         * picture, not a channel. Shown in wire order, because the useful
         * comparison is against the length of the read, not against 0x80020000. */
        hex_group(hx, sizeof hx, d, 8);
        snprintf(out, cap, "%s not a header", hx);
        return;
    }
    if ((unsigned long)len + 8 == (unsigned long)avail) {
        snprintf(out, cap, "chan=%u len=%u type=0x%08x", chan, len, type);
        return;
    }
    if ((unsigned long)len + 8 > (unsigned long)avail) {
        snprintf(out, cap, "chan=%u len=%u, %d of %lu bytes", chan, len, avail,
                 (unsigned long)len + 8);
        return;
    }
    snprintf(out, cap, "chan=%u len=%u, %d bytes (next header inside)", chan, len, avail);
}

static void log_bulk(const char *dir, unsigned char ep, const unsigned char *d,
                     int avail, int want, int ret, unsigned int timeout)
{
    struct tally *slot;
    char desc[130], hex[40] = "";
    unsigned long calls;
    int first;

    pthread_mutex_lock(&lock);
    if (dir[0] == 'i') { in_calls++; in_bytes += (unsigned)avail; }
    else { out_calls++; out_bytes += (unsigned)avail; }

    slot = ((dir[0] == 'i') ? tin : tout) + (ep & 0xf);
    first = slot->calls == 0;
    slot->calls++;
    slot->bytes += (unsigned long)avail;
    calls = slot->calls;

    describe_aoa(desc, sizeof desc, d, avail);
    if (dir[0] == 'i') {
        snprintf(last_in, sizeof last_in, "ep=0x%02x  %.120s", ep, desc);
        if (first) snprintf(first_in, sizeof first_in, "%.40s", head_text(d, avail));
        head_add(&hin, d, avail, want);
        frame_bytes(&fin, d, avail);
    } else {
        snprintf(last_out, sizeof last_out, "ep=0x%02x  %.120s", ep, desc);
        if (first) snprintf(first_out, sizeof first_out, "%.40s", head_text(d, avail));
        head_add(&hout, d, avail, want);
        frame_bytes(&fout, d, avail);
    }
    /* At most 2 x HEAD_TX writes for the whole session: the file is frozen once
     * both directions have their eight samples, and a file that stops changing is
     * one the screen can page without recomputing the layout. */
    if (head_dirty) {
        put_head();
        head_dirty = 0;
    }

    /* The first three of a kind get the bytes; after that only every 200th, or
     * the log becomes sixteen kilobytes of video per second and nothing else.
     * Errors and short reads are always kept - those are the interesting ones. */
    if (first < 3) hex16(hex, sizeof hex, d, avail);
    if (calls <= 3 || calls % 200 == 0 || ret != 0 || (avail && avail != want)) {
        tap("bulk %s ep=0x%02x want=%d got=%d ret=%d tmo=%u  %s  %s",
            dir, ep, want, avail, ret, timeout, desc, hex);
    }
    tick();
    pthread_mutex_unlock(&lock);
}

EXPORT int libusb_init(libusb_context **ctx)
{
    static int (*real)(libusb_context **);
    int r;
    if (!real) real = (int (*)(libusb_context **))sym("libusb_init");
    if (!real) return missing("libusb_init");
    r = real(ctx);
    pthread_mutex_lock(&lock);
    tap("libusb_init -> %d", r);
    pthread_mutex_unlock(&lock);
    return r;
}

EXPORT void libusb_exit(libusb_context *ctx)
{
    static void (*real)(libusb_context *);
    if (!real) real = (void (*)(libusb_context *))sym("libusb_exit");
    pthread_mutex_lock(&lock);
    tap("libusb_exit");
    put_state();
    pthread_mutex_unlock(&lock);
    if (real) real(ctx);
}

EXPORT ssize_t libusb_get_device_list(libusb_context *ctx, libusb_device ***list)
{
    static ssize_t (*real)(libusb_context *, libusb_device ***);
    static int (*desc_of)(libusb_device *, struct libusb_device_descriptor *);
    ssize_t n, i;

    if (!real) real = (ssize_t (*)(libusb_context *, libusb_device ***))sym("libusb_get_device_list");
    if (!real) return missing("libusb_get_device_list");
    if (!desc_of) desc_of = (int (*)(libusb_device *, struct libusb_device_descriptor *))
        sym("libusb_get_device_descriptor");

    n = real(ctx, list);
    pthread_mutex_lock(&lock);
    tap("get_device_list -> %d", (int)n);
    if (n > 0 && list && *list && desc_of) {
        int o = 0;
        dev_text[0] = '\0';
        for (i = 0; i < n && i < 8; i++) {
            struct libusb_device_descriptor d;
            memset(&d, 0, sizeof d);
            if (desc_of((*list)[i], &d) != 0) continue;
            o += snprintf(dev_text + o, sizeof dev_text - (size_t)o, "%s%04x:%04x",
                          o ? " " : "", d.idVendor, d.idProduct);
            tap("  dev %d: %04x:%04x class=%02x cfgs=%d",
                (int)i, d.idVendor, d.idProduct, d.bDeviceClass, d.bNumConfigurations);
        }
        if (n > 8) snprintf(dev_text + o, sizeof dev_text - (size_t)o, " +%d", (int)(n - 8));
        if (!dev_text[0]) snprintf(dev_text, sizeof dev_text, "%d unreadable", (int)n);
    } else {
        snprintf(dev_text, sizeof dev_text, "%d devices", (int)n);
    }
    tick();
    pthread_mutex_unlock(&lock);
    return n;
}

EXPORT void libusb_free_device_list(libusb_device **list, int unref)
{
    static void (*real)(libusb_device **, int);
    if (!real) real = (void (*)(libusb_device **, int))sym("libusb_free_device_list");
    if (real) real(list, unref);
}

/* Config descriptors are where the interface shape lives: whatever stands in
 * for the phone has to present this one, or carlife will not find its bulk
 * pair. This function is also the reason the log has a `config:` line. */
static void describe_config(const struct libusb_config_descriptor *c)
{
    char buf[200];
    int i, j, o = 0;

    if (!c) return;
    o += snprintf(buf + o, sizeof buf - (size_t)o, "cfg%d, %dif:",
                  c->bConfigurationValue, c->bNumInterfaces);
    for (i = 0; i < c->bNumInterfaces && i < 4 && o < (int)sizeof buf - 60; i++) {
        const struct libusb_interface *it = &c->interface[i];
        const struct libusb_interface_descriptor *id;
        if (!it->num_altsetting) continue;
        id = &it->altsetting[0];
        o += snprintf(buf + o, sizeof buf - (size_t)o, " if%d %02x/%02x:",
                      id->bInterfaceNumber, id->bInterfaceClass, id->bInterfaceSubClass);
        for (j = 0; j < id->bNumEndpoints && j < 3 && o < (int)sizeof buf - 24; j++) {
            const struct libusb_endpoint_descriptor *e = &id->endpoint[j];
            o += snprintf(buf + o, sizeof buf - (size_t)o, " %02x/a%02x/%u",
                          e->bEndpointAddress, e->bmAttributes, e->wMaxPacketSize);
        }
    }
    snprintf(cfg_text, sizeof cfg_text, "%s", buf);
    tap("%s", buf);
}

EXPORT int libusb_get_active_config_descriptor(libusb_device *dev,
                                               struct libusb_config_descriptor **cfg)
{
    static int (*real)(libusb_device *, struct libusb_config_descriptor **);
    int r;
    if (!real) real = (int (*)(libusb_device *, struct libusb_config_descriptor **))
        sym("libusb_get_active_config_descriptor");
    if (!real) return missing("libusb_get_active_config_descriptor");
    r = real(dev, cfg);
    pthread_mutex_lock(&lock);
    tap("get_active_config -> %d", r);
    if (r == 0 && cfg) describe_config(*cfg);
    tick();
    pthread_mutex_unlock(&lock);
    return r;
}

EXPORT int libusb_get_config_descriptor(libusb_device *dev, uint8_t index,
                                       struct libusb_config_descriptor **cfg)
{
    static int (*real)(libusb_device *, uint8_t, struct libusb_config_descriptor **);
    int r;
    if (!real) real = (int (*)(libusb_device *, uint8_t, struct libusb_config_descriptor **))
        sym("libusb_get_config_descriptor");
    if (!real) return missing("libusb_get_config_descriptor");
    r = real(dev, index, cfg);
    pthread_mutex_lock(&lock);
    tap("get_config(%u) -> %d", index, r);
    if (r == 0 && cfg) describe_config(*cfg);
    tick();
    pthread_mutex_unlock(&lock);
    return r;
}

EXPORT int libusb_open(libusb_device *dev, libusb_device_handle **h)
{
    static int (*real)(libusb_device *, libusb_device_handle **);
    int r;
    if (!real) real = (int (*)(libusb_device *, libusb_device_handle **))sym("libusb_open");
    if (!real) return missing("libusb_open");
    r = real(dev, h);
    pthread_mutex_lock(&lock);
    /* Which device was opened, not just that something was: a stand-in has to
     * present this vid:pid, and the bus list alone never says which one carlife
     * picked out of it. */
    {
        static int (*desc_of)(libusb_device *, struct libusb_device_descriptor *);
        struct libusb_device_descriptor d;
        int got = 0;
        if (r == 0 && dev) {
            if (!desc_of) desc_of = (int (*)(libusb_device *, struct libusb_device_descriptor *))
                sym("libusb_get_device_descriptor");
            memset(&d, 0, sizeof d);
            got = desc_of && desc_of(dev, &d) == 0;
        }
        if (got)
            snprintf(open_text, sizeof open_text, "open %04x:%04x ok", d.idVendor, d.idProduct);
        else
            snprintf(open_text, sizeof open_text, "open=%d", r);
        tap("open -> %d%s", r, got ? "" : " (no descriptor)");
        if (got) tap("  opened %04x:%04x class=%02x", d.idVendor, d.idProduct, d.bDeviceClass);
    }
    /* A new open is a new byte stream. Half a header left over from the previous
     * session would be prepended to the first bytes of this one, and the framer
     * would then be reading everything eight bytes out of step. */
    if (r == 0) {
        fin.have = fin.payload = 0;
        fin.rem = 0;
        fout.have = fout.payload = 0;
        fout.rem = 0;
    }
    pthread_mutex_unlock(&lock);
    return r;
}

EXPORT libusb_device_handle *libusb_open_device_with_vid_pid(libusb_context *ctx,
                                                            uint16_t vid, uint16_t pid)
{
    static libusb_device_handle *(*real)(libusb_context *, uint16_t, uint16_t);
    libusb_device_handle *h;
    if (!real) real = (libusb_device_handle *(*)(libusb_context *, uint16_t, uint16_t))
        sym("libusb_open_device_with_vid_pid");
    if (!real) { missing("libusb_open_device_with_vid_pid"); return NULL; }
    h = real(ctx, vid, pid);
    pthread_mutex_lock(&lock);
    tap("open_with_vid_pid(%04x:%04x) -> %s", vid, pid, h ? "handle" : "none");
    snprintf(open_text, sizeof open_text, "open %04x:%04x = %s", vid, pid, h ? "ok" : "none");
    if (h) {
        fin.have = fin.payload = 0;
        fin.rem = 0;
        fout.have = fout.payload = 0;
        fout.rem = 0;
    }
    pthread_mutex_unlock(&lock);
    return h;
}

EXPORT void libusb_close(libusb_device_handle *h)
{
    static void (*real)(libusb_device_handle *);
    if (!real) real = (void (*)(libusb_device_handle *))sym("libusb_close");
    pthread_mutex_lock(&lock);
    tap("close");
    pthread_mutex_unlock(&lock);
    if (real) real(h);
}

EXPORT int libusb_claim_interface(libusb_device_handle *h, int n)
{
    static int (*real)(libusb_device_handle *, int);
    int r;
    if (!real) real = (int (*)(libusb_device_handle *, int))sym("libusb_claim_interface");
    if (!real) return missing("libusb_claim_interface");
    r = real(h, n);
    pthread_mutex_lock(&lock);
    tap("claim_interface(%d) -> %d", n, r);
    pthread_mutex_unlock(&lock);
    return r;
}

EXPORT int libusb_release_interface(libusb_device_handle *h, int n)
{
    static int (*real)(libusb_device_handle *, int);
    int r;
    if (!real) real = (int (*)(libusb_device_handle *, int))sym("libusb_release_interface");
    if (!real) return missing("libusb_release_interface");
    r = real(h, n);
    pthread_mutex_lock(&lock);
    tap("release_interface(%d) -> %d", n, r);
    pthread_mutex_unlock(&lock);
    return r;
}

EXPORT int libusb_set_configuration(libusb_device_handle *h, int cfg)
{
    static int (*real)(libusb_device_handle *, int);
    int r;
    if (!real) real = (int (*)(libusb_device_handle *, int))sym("libusb_set_configuration");
    if (!real) return missing("libusb_set_configuration");
    r = real(h, cfg);
    pthread_mutex_lock(&lock);
    tap("set_configuration(%d) -> %d", cfg, r);
    pthread_mutex_unlock(&lock);
    return r;
}

EXPORT int libusb_set_interface_alt_setting(libusb_device_handle *h, int iface, int alt)
{
    static int (*real)(libusb_device_handle *, int, int);
    int r;
    if (!real) real = (int (*)(libusb_device_handle *, int, int))sym("libusb_set_interface_alt_setting");
    if (!real) return missing("libusb_set_interface_alt_setting");
    r = real(h, iface, alt);
    pthread_mutex_lock(&lock);
    tap("set_alt_setting(if%d alt%d) -> %d", iface, alt, r);
    pthread_mutex_unlock(&lock);
    return r;
}

EXPORT int libusb_reset_device(libusb_device_handle *h)
{
    static int (*real)(libusb_device_handle *);
    int r;
    if (!real) real = (int (*)(libusb_device_handle *))sym("libusb_reset_device");
    if (!real) return missing("libusb_reset_device");
    r = real(h);
    pthread_mutex_lock(&lock);
    tap("reset_device -> %d", r);
    pthread_mutex_unlock(&lock);
    return r;
}

/* 51 = do you speak AOA, 52 = who am I (the strings that pick the phone-side
 * app), 53 = switch. Seeing these with a real phone attached is how the
 * stand-in learns what to answer when there is no phone on the port at all. */
EXPORT int libusb_control_transfer(libusb_device_handle *h, uint8_t rt, uint8_t req,
                                   uint16_t val, uint16_t idx, unsigned char *data,
                                   uint16_t len, unsigned int timeout)
{
    static int (*real)(libusb_device_handle *, uint8_t, uint8_t, uint16_t, uint16_t,
                       unsigned char *, uint16_t, unsigned int);
    char hex[40] = "";
    int r, i;

    if (!real) real = (int (*)(libusb_device_handle *, uint8_t, uint8_t, uint16_t, uint16_t,
                               unsigned char *, uint16_t, unsigned int))sym("libusb_control_transfer");
    if (!real) return missing("libusb_control_transfer");

    r = real(h, rt, req, val, idx, data, len, timeout);

    pthread_mutex_lock(&lock);
    ctrl_calls++;
    /* Which request numbers the unit actually sends, in the order first seen:
     * 51/52/53 is the AOA handshake, anything else is the car's own business. */
    for (i = 0; i < n_seen_req; i++) if (seen_req[i] == req) break;
    if (i == n_seen_req && n_seen_req < (int)sizeof seen_req) {
        int o = (int)strlen(req_text);
        seen_req[n_seen_req++] = req;
        if (o && o < (int)sizeof req_text - 8) req_text[o++] = ' ';
        if (o < (int)sizeof req_text - 8)
            snprintf(req_text + o, sizeof req_text - (size_t)o, "%u", req);
    }
    if (data && r > 0 && (rt & 0x80)) hex16(hex, sizeof hex, data, r);
    tap("ctrl rt=%02x req=%u val=%u idx=%u len=%u -> %d  %s",
        rt, req, val, idx, len, r, hex);
    if (req == 52 && data && len)
        tap("  string[%u] = \"%.*s\"", idx, (int)(len > 56 ? 56 : len), (char *)data);
    tick();
    pthread_mutex_unlock(&lock);
    return r;
}

EXPORT int libusb_bulk_transfer(libusb_device_handle *h, unsigned char ep, unsigned char *data,
                                int len, int *transferred, unsigned int timeout)
{
    static int (*real)(libusb_device_handle *, unsigned char, unsigned char *, int, int *, unsigned int);
    int r, got = 0;
    if (!real) real = (int (*)(libusb_device_handle *, unsigned char, unsigned char *, int, int *, unsigned int))
        sym("libusb_bulk_transfer");
    if (!real) return missing("libusb_bulk_transfer");
    r = real(h, ep, data, len, transferred, timeout);
    if (transferred) got = *transferred;
    log_bulk((ep & 0x80) ? "in " : "out", ep, data, got, len, r, timeout);
    return r;
}

EXPORT int libusb_interrupt_transfer(libusb_device_handle *h, unsigned char ep, unsigned char *data,
                                     int len, int *transferred, unsigned int timeout)
{
    static int (*real)(libusb_device_handle *, unsigned char, unsigned char *, int, int *, unsigned int);
    int r, got = 0;
    if (!real) real = (int (*)(libusb_device_handle *, unsigned char, unsigned char *, int, int *, unsigned int))
        sym("libusb_interrupt_transfer");
    if (!real) return missing("libusb_interrupt_transfer");
    r = real(h, ep, data, len, transferred, timeout);
    if (transferred) got = *transferred;
    log_bulk((ep & 0x80) ? "in " : "out", ep, data, got, len, r, timeout);
    return r;
}

/* The async API. If carlife uses this, a stand-in has to *complete* transfers
 * rather than return bytes, which is a different shape of work - worth knowing
 * before writing a line of it. Header fields only, see the struct note. */
EXPORT int libusb_submit_transfer(struct libusb_transfer *t)
{
    static int (*real)(struct libusb_transfer *);
    int r;
    if (!real) real = (int (*)(struct libusb_transfer *))sym("libusb_submit_transfer");
    if (!real) return missing("libusb_submit_transfer");
    r = real(t);
    pthread_mutex_lock(&lock);
    async_submits++;
    if (t) tap("submit ep=0x%02x type=%u len=%d -> %d", t->endpoint, t->type, t->length, r);
    pthread_mutex_unlock(&lock);
    return r;
}

EXPORT int libusb_handle_events_timeout_completed(libusb_context *ctx, struct timeval *tv, int *done)
{
    static int (*real)(libusb_context *, struct timeval *, int *);
    int r;
    if (!real) real = (int (*)(libusb_context *, struct timeval *, int *))
        sym("libusb_handle_events_timeout_completed");
    if (!real) return missing("libusb_handle_events_timeout_completed");
    r = real(ctx, tv, done);
    pthread_mutex_lock(&lock);
    async_events++;
    tick();
    pthread_mutex_unlock(&lock);
    return r;
}

EXPORT int libusb_handle_events(libusb_context *ctx)
{
    static int (*real)(libusb_context *);
    int r;
    if (!real) real = (int (*)(libusb_context *))sym("libusb_handle_events");
    if (!real) return missing("libusb_handle_events");
    r = real(ctx);
    pthread_mutex_lock(&lock);
    async_events++;
    tick();
    pthread_mutex_unlock(&lock);
    return r;
}

EXPORT int libusb_get_string_descriptor_ascii(libusb_device_handle *h, uint8_t index,
                                              unsigned char *data, int len)
{
    static int (*real)(libusb_device_handle *, uint8_t, unsigned char *, int);
    int r;
    if (!real) real = (int (*)(libusb_device_handle *, uint8_t, unsigned char *, int))
        sym("libusb_get_string_descriptor_ascii");
    if (!real) return missing("libusb_get_string_descriptor_ascii");
    r = real(h, index, data, len);
    pthread_mutex_lock(&lock);
    tap("string_ascii(%u) -> %d%s%.24s", index, r, r > 0 ? "  \"" : "", r > 0 ? (char *)data : "");
    pthread_mutex_unlock(&lock);
    return r;
}

/* Loaded before carlife's main(): make the directory, open the log, say who we
 * are. The first line of tap.txt is deliberately a sentence - a session that
 * comes back with an empty log means the library was never loaded, which is a
 * different problem from "loaded and saw nothing". */
__attribute__((constructor)) static void shim_start(void)
{
    struct timespec ts;
    char path[160];

    boot_ms = now_ms();
    clock_gettime(CLOCK_REALTIME, &ts);
    mkdir(SHM_DIR, 0777);
    chmod(SHM_DIR, 0777);

    snprintf(path, sizeof path, "%s/tap.txt", SHM_DIR);
    log_fd = open(path, O_WRONLY | O_CREAT | O_TRUNC, 0644);
    log_bytes = 0;
    if (log_fd >= 0) chmod(path, 0644);

    tap("carlife-shim tap - pid %d, %lld.%03ld", (int)getpid(),
        (long long)ts.tv_sec, ts.tv_nsec / 1000000);
    tap("argv0=%s", program_invocation_short_name ? program_invocation_short_name : "?");
    tap("libusb-1.0 %s", sym("libusb_bulk_transfer") ? "reachable" : "NOT FOUND (dlopen'd later?)");
    put_state();
}
