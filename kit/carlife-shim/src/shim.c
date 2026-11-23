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
#include <arpa/inet.h>
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <poll.h>
#include <pthread.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
#include <sys/socket.h>
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

/* ---- stand-in device and channel bridge (0.6.0) --------------------------
 *
 * The whole point of this file up to 0.5.0 was to find out how carlife talks
 * to a phone. It found out: one AOA accessory device, two bulk endpoints, and
 * messages framed as [channel u32 BE][length u32 BE][body], with the header in
 * a transfer of its own. This block acts on that.
 *
 * Two pieces, and they fail independently:
 *
 *   the fake device  - answers enumeration, the 51/52/53 handshake and the
 *                      configuration descriptor, so a carlife with nothing
 *                      plugged into the port still reaches its read loop.
 *   the bridge       - carries whole messages over TCP to a machine that
 *                      plays the phone. The wire format is the *same* eight
 *                      byte header, not the bare body: then this side needs no
 *                      knowledge of what a channel means, and the far side does
 *                      not have to reproduce USB framing rules.
 *
 * Everything is appended behind the real enumeration, so a phone that is
 * actually there still sorts first and nothing about the wired path changes
 * until carlife picks the stand-in.
 */
#define FAKE_CH_MAX 4                   /* channels 1..3; slot 0 is not a channel */
#define FAKE_BODY_MAX (16 * 1024)       /* bytes handed back in one bulk read */
#define FAKE_MSG_MAX (8u * 1024u * 1024u)   /* same ceiling the framer uses */
#define FAKE_BASE_PORT 7240             /* 1 -> 7240, 2 -> 8240, 3 -> 9240 */

struct bmsg {
    struct bmsg *next;
    uint32_t chan, len;
    unsigned char body[1];
};

/* Reassembly buffer for one TCP channel: whole messages, since the header says
 * how long the body is and a body can arrive in any number of reads. */
struct bstream {
    unsigned char *buf;
    size_t cap, have;
};

/* One lock for all bridge state - queues, sockets, the in-flight message. Held
 * across a connect (400 ms at worst) and across a short send wait (200 ms), so
 * the other direction can stall that long. It must never be held across the
 * poll that waits for a phone to send something, or the two directions deadlock
 * into a standstill that looks exactly like "no data". */
static pthread_mutex_t blink = PTHREAD_MUTEX_INITIALIZER;
static int ch_fd[FAKE_CH_MAX] = { -1, -1, -1, -1 };
static int64_t ch_try_ms[FAKE_CH_MAX];
static struct bmsg *ch_head[FAKE_CH_MAX], *ch_tail[FAKE_CH_MAX];
static unsigned long ch_qbytes[FAKE_CH_MAX];
static unsigned long br_dropped;
static struct bstream ch_rx[FAKE_CH_MAX];
static struct bmsg *in_cur;              /* message being handed to carlife */
static int in_off;                       /* 8 = header done, else header bytes done */
static int in_rr;                        /* round-robin start channel */
static unsigned long br_in_msgs, br_out_msgs, br_timeouts;
static unsigned long long br_in_bytes, br_out_bytes;
static char peer[64];
static char br_note[96] = "(idle)";

/* The transfer direction that is currently being reassembled out of carlife's
 * writes. Kept as file statics rather than in a struct because there is exactly
 * one OUT endpoint and therefore exactly one such stream. */
static unsigned char out_hdr[8];
static int out_have;
static uint32_t out_chan, out_rem;

struct fake_obj { unsigned int magic; };
static struct fake_obj fake_dev_obj = { 0x46414B45u };   /* "FAKE" */
static struct fake_obj fake_hnd_obj = { 0x48414E44u };   /* "HAND" */
#define FAKE_DEV ((libusb_device *)&fake_dev_obj)
#define FAKE_HND ((libusb_device_handle *)&fake_hnd_obj)

static int fake_init_done;
static int fake_on = 1;                  /* overridable, see fake_wanted() */
static int fake_switched;                /* START seen: report 18d1:2d01 */
static int fake_opened;                  /* a handle is outstanding */
static int fake_claims;
static unsigned long fake_bulk_in, fake_bulk_out;
static libusb_device **fake_lists[8];    /* arrays we allocated, to free them */
static int fake_nlists;

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
    /* The stand-in's own line. `switched` is the milestone: it means carlife
     * took the fake device all the way through the AOA handshake and asked it
     * to come back as an accessory. Everything after that is the bridge. */
    if (fake_on)
        ADD("fake: on%s, claims %d, bulk %lu/%lu, %.40s\n",
            fake_switched ? " (switched)" : "", fake_claims,
            fake_bulk_in, fake_bulk_out, peer[0] ? peer : "no peer");
    if (br_note[0] != '(')
        ADD("bridge: %.90s\n", br_note);
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

/* ===========================================================================
 * The stand-in: enumeration, handshake, descriptors, bridge
 * =========================================================================*/

static void be32_put(unsigned char *p, uint32_t v)
{
    p[0] = (unsigned char)(v >> 24);
    p[1] = (unsigned char)(v >> 16);
    p[2] = (unsigned char)(v >> 8);
    p[3] = (unsigned char)v;
}

static int is_fake_dev(libusb_device *d)
{
    return d && (void *)d == (void *)&fake_dev_obj;
}

static int is_fake_hnd(libusb_device_handle *h)
{
    return h && (void *)h == (void *)&fake_hnd_obj;
}

static int is_fake_list(libusb_device **list)
{
    int i, n = fake_nlists < 8 ? fake_nlists : 8;
    for (i = 0; i < n; i++)
        if (fake_lists[i] == list) return 1;
    return 0;
}

/* A ring, not a stack: carlife can re-enumerate more often than there are
 * slots, and the oldest array is the one that has long been freed. Missing a
 * match is not a leak - it is the real free_device_list walking an array it did
 * not allocate and unref'ing a static struct, which takes carlife with it. */
static void note_fake_list(libusb_device **list)
{
    fake_lists[fake_nlists % 8] = list;
    fake_nlists++;
}

/* The stand-in is on by default: the reason to install this component at all is
 * to get a carlife with no phone on the port past its USB open. Turning it off
 * has to be possible without uninstalling, though - a real phone on a real
 * cable must always be able to win - hence two switches that need no Store
 * round trip: the environment the drop-in sets, and a file in /dev/shm. */
static int fake_wanted(void)
{
    const char *e = getenv("CARLIFE_SHIM_FAKE");
    if (e && (e[0] == '0' || e[0] == 'n' || e[0] == 'N')) return 0;
    if (access(SHM_DIR "/nofake", F_OK) == 0) return 0;
    return 1;
}

static void trim_line(char *s)
{
    int n = (int)strlen(s);
    while (n > 0 && (s[n - 1] == '\n' || s[n - 1] == '\r' || s[n - 1] == ' '))
        s[--n] = '\0';
}

/* Where the phone side listens. Three sources, most explicit first, because the
 * link-local address of a laptop is not a constant: the ENET cable is usually
 * straight into a machine that picks 169.254.x.x at random, and an address
 * baked in at install time goes stale the first time the cable is moved. */
static void peer_resolve(void)
{
    const char *e;
    FILE *f;
    char line[160];

    if (peer[0]) return;

    e = getenv("CARLIFE_SHIM_PEER");
    if (e && *e) {
        snprintf(peer, sizeof peer, "%s", e);
        trim_line(peer);
        if (peer[0]) return;
    }

    f = fopen("/var/opt/carlife-shim/current/peer.txt", "r");
    if (!f) f = fopen(SHM_DIR "/peer.txt", "r");
    if (f) {
        if (fgets(line, sizeof line, f)) {
            trim_line(line);
            if (line[0]) snprintf(peer, sizeof peer, "%s", line);
        }
        fclose(f);
        if (peer[0]) return;
    }

    /* /proc/net/arp, link-local only. This unit sits at 169.254.121.209; the
     * one other complete entry in 169.254/16 is the other end of the cable,
     * and there is exactly one cable. */
    f = fopen("/proc/net/arp", "r");
    if (!f) return;
    if (!fgets(line, sizeof line, f)) { fclose(f); return; }
    while (fgets(line, sizeof line, f)) {
        char ip[64], hw[32], mask[32], dev[32];
        unsigned type, flags;
        if (sscanf(line, "%63s %x %x %31s %31s %31s", ip, &type, &flags, hw, mask, dev) != 6)
            continue;
        if ((flags & 0x2) && strncmp(ip, "169.254.", 8) == 0) {
            snprintf(peer, sizeof peer, "%s", ip);
            break;
        }
    }
    fclose(f);
}

static int64_t peer_down_ms;

static void ch_drop(int ch)
{
    if (ch < 1 || ch >= FAKE_CH_MAX) return;
    if (ch_fd[ch] >= 0) close(ch_fd[ch]);
    ch_fd[ch] = -1;
    ch_try_ms[ch] = now_ms();
}

/* Called with blink held. A refused connect is the normal state on a bench
 * where the far side is not running yet, so one failure parks every channel
 * for a few seconds instead of spending the whole transfer timeout retrying
 * three of them. */
static int ch_connect(int ch, int64_t now)
{
    struct sockaddr_in a;
    struct pollfd p;
    int fd, fl, r, err = 0;
    socklen_t el = sizeof err;
    int port;

    if (ch < 1 || ch >= FAKE_CH_MAX) return -1;
    if (ch_fd[ch] >= 0) return 0;
    if (now - ch_try_ms[ch] < 2000) return -1;
    if (now - peer_down_ms < 3000) return -1;
    ch_try_ms[ch] = now;

    peer_resolve();
    if (!peer[0]) {
        snprintf(br_note, sizeof br_note, "no peer (arp/env/peer.txt all empty)");
        return -1;
    }

    port = FAKE_BASE_PORT + (ch - 1) * 1000;
    memset(&a, 0, sizeof a);
    a.sin_family = AF_INET;
    a.sin_port = htons((uint16_t)port);
    if (inet_pton(AF_INET, peer, &a.sin_addr) != 1) return -1;

    fd = socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0) return -1;

    fl = fcntl(fd, F_GETFL, 0);
    fcntl(fd, F_SETFL, fl | O_NONBLOCK);
    r = connect(fd, (struct sockaddr *)&a, sizeof a);
    if (r < 0 && errno == EINPROGRESS) {
        p.fd = fd;
        p.events = POLLOUT;
        p.revents = 0;
        if (poll(&p, 1, 400) <= 0) {
            close(fd);
            peer_down_ms = now_ms();
            snprintf(br_note, sizeof br_note, "ch%d %s:%d no answer", ch, peer, port);
            return -1;
        }
        getsockopt(fd, SOL_SOCKET, SO_ERROR, &err, &el);
        if (err) {
            close(fd);
            peer_down_ms = now_ms();
            snprintf(br_note, sizeof br_note, "ch%d %s:%d refused (%d)", ch, peer, port, err);
            return -1;
        }
    } else if (r < 0) {
        close(fd);
        peer_down_ms = now_ms();
        snprintf(br_note, sizeof br_note, "ch%d connect errno %d", ch, errno);
        return -1;
    }
    /* Stays non-blocking: a read that waits is poll's job, and a write that
     * blocks forever would freeze the picture with no way back. */
    ch_fd[ch] = fd;
    snprintf(br_note, sizeof br_note, "ch%d -> %s:%d", ch, peer, port);
    tap("bridge ch%d -> %s:%d", ch, peer, port);
    return 0;
}

/* Called with blink held. Whole messages only, so a partial send is finished
 * before the next header goes out - the far side parses a stream. */
static void ch_write(int ch, const unsigned char *p, int n)
{
    int o = 0;

    if (ch < 1 || ch >= FAKE_CH_MAX || ch_fd[ch] < 0) return;
    while (o < n) {
        int w = (int)send(ch_fd[ch], p + o, (size_t)(n - o), MSG_NOSIGNAL);
        if (w > 0) { o += w; continue; }
        if (w < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
            struct pollfd pf;
            pf.fd = ch_fd[ch];
            pf.events = POLLOUT;
            pf.revents = 0;
            if (poll(&pf, 1, 200) > 0) continue;
        }
        if (w < 0 && errno == EINTR) continue;
        tap("bridge ch%d send failed, errno %d", ch, errno);
        ch_drop(ch);
        snprintf(br_note, sizeof br_note, "ch%d send failed (%d), dropped", ch, errno);
        return;
    }
    br_out_bytes += (unsigned long long)n;
}

/* Four megabytes a channel. The far side can send faster than carlife reads -
 * a 30 fps picture is nearly 3 MB/s - and a queue with no ceiling turns a
 * stalled consumer into an out-of-memory kill of the process that draws the
 * dashboard. Dropping the oldest message keeps the picture current, which is
 * the only thing a viewer would have asked for anyway. */
#define FAKE_QMAX (4u * 1024u * 1024u)

static struct bmsg *bq_pop(int ch);

static void bq_push(uint32_t chan, const unsigned char *body, uint32_t len)
{
    struct bmsg *m;
    int i = (int)chan;

    if (i < 1 || i >= FAKE_CH_MAX || len == 0) return;
    m = malloc(sizeof *m + len);
    if (!m) return;
    m->next = NULL;
    m->chan = chan;
    m->len = len;
    memcpy(m->body, body, len);
    if (ch_tail[i]) ch_tail[i]->next = m;
    else ch_head[i] = m;
    ch_tail[i] = m;
    ch_qbytes[i] += len;
    br_in_msgs++;
    br_in_bytes += len;

    /* `head != tail` keeps the newest message even when it alone is over the
     * limit: dropping the only thing in the queue would be worse than holding
     * one oversized frame. */
    while (ch_qbytes[i] > FAKE_QMAX && ch_head[i] != ch_tail[i]) {
        struct bmsg *old = bq_pop(i);
        if (!old) break;
        free(old);
        br_dropped++;
    }
}

static struct bmsg *bq_pop(int ch)
{
    struct bmsg *m = ch_head[ch];
    if (!m) return NULL;
    ch_head[ch] = m->next;
    if (!ch_head[ch]) ch_tail[ch] = NULL;
    if (ch_qbytes[ch] >= m->len) ch_qbytes[ch] -= m->len;
    else ch_qbytes[ch] = 0;
    return m;
}

static int rx_ensure(struct bstream *s, size_t need)
{
    unsigned char *nb;
    size_t cap = s->cap ? s->cap : 65536;

    if (need <= s->cap) return 0;
    while (cap < need) cap *= 2;
    if (cap > (size_t)FAKE_MSG_MAX + 65536) return -1;
    nb = realloc(s->buf, cap);
    if (!nb) return -1;
    s->buf = nb;
    s->cap = cap;
    return 0;
}

/* Turn whatever has arrived on one channel into messages. A byte that cannot
 * start a header slides by one - the same rule the framer uses, for the same
 * reason: the far side is a program we wrote, but a restart of it leaves half a
 * write in the socket and a parser that gives up never comes back. */
static int rx_pump(int ch)
{
    struct bstream *s = &ch_rx[ch];
    size_t off = 0;
    int got = 0;

    while (s->have - off >= 8) {
        uint32_t c = be32(s->buf + off);
        uint32_t n = be32(s->buf + off + 4);
        if (c < 1 || c >= FAKE_CH_MAX || n == 0 || n > FAKE_MSG_MAX) {
            off++;
            continue;
        }
        if (s->have - off - 8 < (size_t)n) break;
        bq_push(c, s->buf + off + 8, n);
        off += 8 + (size_t)n;
        got++;
    }
    if (off) {
        memmove(s->buf, s->buf + off, s->have - off);
        s->have -= off;
    }
    return got;
}

/* Called with blink held. */
static void rx_fill(int ch, int64_t now)
{
    unsigned char tmp[8192];
    int n;

    (void)now;
    if (ch < 1 || ch >= FAKE_CH_MAX || ch_fd[ch] < 0) return;
    n = (int)read(ch_fd[ch], tmp, sizeof tmp);
    if (n == 0 || (n < 0 && errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR)) {
        tap("bridge ch%d closed (%d, errno %d)", ch, n, n < 0 ? errno : 0);
        snprintf(br_note, sizeof br_note, "ch%d closed by peer", ch);
        ch_drop(ch);
        return;
    }
    if (n < 0) return;
    if (rx_ensure(&ch_rx[ch], ch_rx[ch].have + (size_t)n)) return;
    memcpy(ch_rx[ch].buf + ch_rx[ch].have, tmp, (size_t)n);
    ch_rx[ch].have += (size_t)n;
    rx_pump(ch);
}

/* Called with blink held. Hands carlife the next chunk of one message: the
 * eight-byte header on its own, then the body in pieces. The header is never
 * split across two reads because a real device does not split it either and
 * there is no reason to find out whether carlife's framer copes. */
static int in_take(unsigned char *data, int len)
{
    int k, ch;

    if (!in_cur) {
        for (k = 0; k < 3; k++) {
            ch = in_rr;
            in_rr = in_rr % 3 + 1;
            if (ch_head[ch]) {
                in_cur = bq_pop(ch);
                in_off = 0;
                break;
            }
        }
    }
    if (!in_cur) return -1;

    if (in_off < 8) {
        unsigned char h[8];
        be32_put(h, in_cur->chan);
        be32_put(h + 4, in_cur->len);
        memcpy(data, h, 8);
        in_off = 8;
        return 8;
    }

    {
        unsigned long done = (unsigned long)(in_off - 8);
        unsigned long rem = in_cur->len - done;
        int n = (int)(rem < (unsigned long)len ? rem : (unsigned long)len);
        if (n > FAKE_BODY_MAX) n = FAKE_BODY_MAX;
        memcpy(data, in_cur->body + done, (size_t)n);
        in_off += n;
        if (in_off >= (int)(8 + in_cur->len)) {
            free(in_cur);
            in_cur = NULL;
            in_off = 0;
        }
        return n;
    }
}

static int bridge_in(unsigned char *data, int len, unsigned int timeout_ms)
{
    int64_t deadline = now_ms() + (int64_t)(timeout_ms ? timeout_ms : 1000);
    int n;

    if (len < 8) return -7;             /* LIBUSB_ERROR_TIMEOUT */

    for (;;) {
        pthread_mutex_lock(&blink);
        n = in_take(data, len);
        pthread_mutex_unlock(&blink);
        if (n >= 0) return n;

        {
            struct pollfd pf[FAKE_CH_MAX];
            int idx[FAKE_CH_MAX];
            int k = 0, ch, wait;
            int64_t now = now_ms();

            wait = (int)(deadline - now);
            if (wait <= 0) { br_timeouts++; return -7; }

            pthread_mutex_lock(&blink);
            for (ch = 1; ch < FAKE_CH_MAX; ch++) {
                if (ch_fd[ch] < 0) ch_connect(ch, now);
                if (ch_fd[ch] >= 0) {
                    pf[k].fd = ch_fd[ch];
                    pf[k].events = POLLIN;
                    pf[k].revents = 0;
                    idx[k] = ch;
                    k++;
                }
            }
            pthread_mutex_unlock(&blink);

            if (!k) {
                /* Nothing connected and nothing to wait on; the connect above
                 * already spent its budget, so yield and try again. */
                struct timespec ts;
                ts.tv_sec = 0;
                ts.tv_nsec = 20 * 1000 * 1000;
                nanosleep(&ts, NULL);
                continue;
            }

            n = poll(pf, (nfds_t)k, wait);
            if (n == 0) { br_timeouts++; return -7; }
            if (n < 0) {
                if (errno == EINTR) continue;
                br_timeouts++;
                return -7;
            }

            pthread_mutex_lock(&blink);
            for (ch = 0; ch < k; ch++)
                if (pf[ch].revents & (POLLIN | POLLHUP | POLLERR))
                    rx_fill(idx[ch], now_ms());
            n = in_take(data, len);
            pthread_mutex_unlock(&blink);
            if (n >= 0) return n;
            if (now_ms() >= deadline) { br_timeouts++; return -7; }
        }
    }
}

/* carlife's writes, reassembled into whole messages and forwarded with their
 * header intact. A header that does not parse means the stream is not where we
 * think it is, so slide one byte and look again - never discard the rest. */
static void bridge_out(const unsigned char *p, int n)
{
    int i = 0;

    pthread_mutex_lock(&blink);
    while (i < n) {
        if (out_have < 8) {
            int c = 8 - out_have;
            if (c > n - i) c = n - i;
            memcpy(out_hdr + out_have, p + i, (size_t)c);
            out_have += c;
            i += c;
            if (out_have == 8) {
                uint32_t ch = be32(out_hdr);
                uint32_t ln = be32(out_hdr + 4);
                if (ch < 1 || ch >= FAKE_CH_MAX || ln == 0 || ln > FAKE_MSG_MAX) {
                    out_have = 0;
                    out_rem = 0;
                    continue;
                }
                out_chan = ch;
                out_rem = ln;
                br_out_msgs++;
                if (ch_connect((int)ch, now_ms()) == 0) ch_write((int)ch, out_hdr, 8);
            }
            continue;
        }
        {
            int c = (int)(out_rem < (uint32_t)(n - i) ? out_rem : (uint32_t)(n - i));
            ch_write((int)out_chan, p + i, c);
            out_rem -= (uint32_t)c;
            i += c;
            if (out_rem == 0) out_have = 0;
        }
    }
    pthread_mutex_unlock(&blink);
}

/* A new open is a new stream in both directions: half a message left from the
 * previous session would be glued to the first bytes of this one and every
 * length after it would land one message out. The sockets stay up - the far
 * side did not restart just because carlife reopened the device. */
static void bridge_reset(void)
{
    struct bmsg *m, *nx;
    int ch;

    pthread_mutex_lock(&blink);
    for (ch = 1; ch < FAKE_CH_MAX; ch++) {
        for (m = ch_head[ch]; m; m = nx) {
            nx = m->next;
            free(m);
        }
        ch_head[ch] = ch_tail[ch] = NULL;
        ch_qbytes[ch] = 0;
        ch_rx[ch].have = 0;
    }
    if (in_cur) {
        free(in_cur);
        in_cur = NULL;
    }
    in_off = 0;
    out_have = 0;
    out_rem = 0;
    pthread_mutex_unlock(&blink);
}

/* ---- descriptors ---------------------------------------------------------
 *
 * The shape is copied from the session log, not from the AOA spec: this unit
 * 02 OUT and 82 IN. carlife only claims interface 0 and never touches if1 on
 * the data path, but it is in the real descriptor and a stand-in that omits it
 * is a stand-in that will be found out by the next carlife build. */
static struct libusb_endpoint_descriptor fep[4];
static struct libusb_interface_descriptor fint[2];
static struct libusb_interface fifc[2];
static struct libusb_config_descriptor fcfg;

static void fake_desc_init(void)
{
    if (fake_init_done) return;
    memset(fep, 0, sizeof fep);
    memset(fint, 0, sizeof fint);
    memset(fifc, 0, sizeof fifc);
    memset(&fcfg, 0, sizeof fcfg);

    fep[0].bLength = 7;
    fep[0].bDescriptorType = 5;
    fep[0].bEndpointAddress = 0x81;
    fep[0].bmAttributes = 0x02;         /* bulk */
    fep[0].wMaxPacketSize = 512;

    fep[1] = fep[0];
    fep[1].bEndpointAddress = 0x01;

    fep[2] = fep[0];
    fep[2].bEndpointAddress = 0x02;

    fep[3] = fep[0];
    fep[3].bEndpointAddress = 0x82;

    fint[0].bLength = 9;
    fint[0].bDescriptorType = 4;
    fint[0].bInterfaceNumber = 0;
    fint[0].bAlternateSetting = 0;
    fint[0].bNumEndpoints = 2;
    fint[0].bInterfaceClass = 0xff;
    fint[0].bInterfaceSubClass = 0xff;
    fint[0].bInterfaceProtocol = 0;
    fint[0].endpoint = &fep[0];

    fint[1] = fint[0];
    fint[1].bInterfaceNumber = 1;
    fint[1].bInterfaceSubClass = 0x42;
    fint[1].endpoint = &fep[2];

    fifc[0].altsetting = &fint[0];
    fifc[0].num_altsetting = 1;
    fifc[1].altsetting = &fint[1];
    fifc[1].num_altsetting = 1;

    fcfg.bLength = 9;
    fcfg.bDescriptorType = 2;
    fcfg.wTotalLength = (uint16_t)(9 + 2 * (9 + 2 * 7));
    fcfg.bNumInterfaces = 2;
    fcfg.bConfigurationValue = 1;
    fcfg.iConfiguration = 0;
    fcfg.bmAttributes = 0x80;
    fcfg.MaxPower = 250;
    fcfg.interface = fifc;

    fake_init_done = 1;
}

/* The control pipe of a stand-in. Only three requests mean anything, and the
 * rest fail with BUSY - which is exactly what the real phone answered to
 * GET_DESCRIPTOR and the serial string on this unit, and carlife carried on. */
static int fake_control(uint8_t rt, uint8_t req, uint16_t val, uint16_t idx,
                        unsigned char *data, uint16_t len)
{
    (void)val;
    (void)idx;

    if (req == 51 && (rt & 0x80)) {     /* GET_PROTOCOL */
        if (data && len >= 2) { data[0] = 0x02; data[1] = 0x00; }
        return 2;
    }
    if (req == 52 && !(rt & 0x80))      /* SEND_STRING */
        return (int)len;
    if (req == 53 && !(rt & 0x80)) {    /* START */
        if (!fake_switched) tap("fake: AOA START - switching to 18d1:2d01");
        fake_switched = 1;
        return 0;
    }
    return -6;                          /* LIBUSB_ERROR_BUSY */
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

    /* The stand-in goes last, never first. With a phone on the cable the real
     * device is still the one carlife opens; the fake is only reached when
     * nothing else would have been found at all. The array is re-made rather
     * than grown in place because libusb's own allocation is not ours to
     * realloc, and libusb_free_device_list below is taught to recognise it. */
    if (fake_on && n >= 0 && list && *list) {
        libusb_device **nl = malloc(((size_t)n + 2) * sizeof *nl);
        if (nl) {
            for (i = 0; i < n; i++) nl[i] = (*list)[i];
            nl[n] = FAKE_DEV;
            nl[n + 1] = NULL;
            free(*list);
            *list = nl;
            note_fake_list(nl);
            n++;
        }
    }

    pthread_mutex_lock(&lock);
    tap("get_device_list -> %d", (int)n);
    if (n > 0 && list && *list) {
        int o = 0;
        dev_text[0] = '\0';
        for (i = 0; i < n && i < 8; i++) {
            struct libusb_device_descriptor d;
            int fake = is_fake_dev((*list)[i]);
            memset(&d, 0, sizeof d);
            if (fake) {
                /* Not through desc_of: that is the real libusb, and the pointer
                 * it would be handed is not one of its own. */
                d.idVendor = (uint16_t)(fake_switched ? 0x18d1 : 0x2d95);
                d.idProduct = (uint16_t)(fake_switched ? 0x2d01 : 0x7000);
                d.bNumConfigurations = 1;
            } else if (!desc_of || desc_of((*list)[i], &d) != 0) {
                continue;
            }
            o += snprintf(dev_text + o, sizeof dev_text - (size_t)o, "%s%04x:%04x",
                          o ? " " : "", d.idVendor, d.idProduct);
            tap("  dev %d: %04x:%04x class=%02x cfgs=%d%s",
                (int)i, d.idVendor, d.idProduct, d.bDeviceClass, d.bNumConfigurations,
                fake ? " (stand-in)" : "");
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
    static void (*unref1)(libusb_device *);
    int i;

    /* Our array: the real devices copied into it still hold the references they
     * already had, so they are unref'd one at a time. Handing this array to the
     * real function would have it walk a pointer it never allocated, and unref
     * the stand-in - which is a static object, not a libusb_device. */
    if (list && is_fake_list(list)) {
        if (unref) {
            if (!unref1) unref1 = (void (*)(libusb_device *))sym("libusb_unref_device");
            for (i = 0; list[i]; i++)
                if (!is_fake_dev(list[i]) && unref1) unref1(list[i]);
        }
        free(list);
        return;
    }

    if (!real) real = (void (*)(libusb_device **, int))sym("libusb_free_device_list");
    if (real) real(list, unref);
}

/* ---- device accessors the stand-in has to answer itself ------------------
 *
 * None of these are reached with a stand-in pointer in a session that had a
 * phone, which is exactly why they are here: the first time one of them is not
 * interposed, the real libusb dereferences a static struct that is eight bytes
 * long and carlife dies inside the process that draws the dashboard. */
EXPORT int libusb_get_device_descriptor(libusb_device *dev,
                                        struct libusb_device_descriptor *desc)
{
    static int (*real)(libusb_device *, struct libusb_device_descriptor *);

    if (is_fake_dev(dev)) {
        if (!desc) return -1;
        memset(desc, 0, sizeof *desc);
        desc->bLength = 18;
        desc->bDescriptorType = 1;      /* DEVICE */
        desc->bcdUSB = 0x0200;
        desc->bDeviceClass = 0;
        desc->bDeviceSubClass = 0;
        desc->bDeviceProtocol = 0;
        desc->bMaxPacketSize0 = 64;
        /* Before START the phone is whatever it was - the unit's own phone said
         * 2d95:7000; after START it is an accessory and says 18d1:2d01. carlife
         * keeps the same device pointer across the switch and only re-opens it,
         * so this flag is the whole of the AOA re-enumeration. */
        desc->idVendor = (uint16_t)(fake_switched ? 0x18d1 : 0x2d95);
        desc->idProduct = (uint16_t)(fake_switched ? 0x2d01 : 0x7000);
        desc->bcdDevice = 0x0100;
        desc->iManufacturer = 1;
        desc->iProduct = 2;
        desc->iSerialNumber = 3;
        desc->bNumConfigurations = 1;
        return 0;
    }

    if (!real) real = (int (*)(libusb_device *, struct libusb_device_descriptor *))
        sym("libusb_get_device_descriptor");
    if (!real) return missing("libusb_get_device_descriptor");
    return real(dev, desc);
}

EXPORT libusb_device *libusb_ref_device(libusb_device *dev)
{
    static libusb_device *(*real)(libusb_device *);
    if (is_fake_dev(dev)) return dev;
    if (!real) real = (libusb_device *(*)(libusb_device *))sym("libusb_ref_device");
    return real ? real(dev) : dev;
}

EXPORT void libusb_unref_device(libusb_device *dev)
{
    static void (*real)(libusb_device *);
    if (!dev || is_fake_dev(dev)) return;
    if (!real) real = (void (*)(libusb_device *))sym("libusb_unref_device");
    if (real) real(dev);
}

EXPORT uint8_t libusb_get_device_address(libusb_device *dev)
{
    static uint8_t (*real)(libusb_device *);
    if (is_fake_dev(dev)) return 6;     /* the address the real phone had */
    if (!real) real = (uint8_t (*)(libusb_device *))sym("libusb_get_device_address");
    return real ? real(dev) : 0;
}

EXPORT uint8_t libusb_get_bus_number(libusb_device *dev)
{
    static uint8_t (*real)(libusb_device *);
    if (is_fake_dev(dev)) return 1;
    if (!real) real = (uint8_t (*)(libusb_device *))sym("libusb_get_bus_number");
    return real ? real(dev) : 0;
}

EXPORT uint8_t libusb_get_port_number(libusb_device *dev)
{
    static uint8_t (*real)(libusb_device *);
    if (is_fake_dev(dev)) return 1;
    if (!real) real = (uint8_t (*)(libusb_device *))sym("libusb_get_port_number");
    return real ? real(dev) : 0;
}

EXPORT libusb_device *libusb_get_parent(libusb_device *dev)
{
    static libusb_device *(*real)(libusb_device *);
    if (is_fake_dev(dev)) return NULL;
    if (!real) real = (libusb_device *(*)(libusb_device *))sym("libusb_get_parent");
    return real ? real(dev) : NULL;
}

EXPORT int libusb_get_device_speed(libusb_device *dev)
{
    static int (*real)(libusb_device *);
    if (is_fake_dev(dev)) return 3;     /* LIBUSB_SPEED_HIGH */
    if (!real) real = (int (*)(libusb_device *))sym("libusb_get_device_speed");
    return real ? real(dev) : 0;
}

EXPORT int libusb_get_port_numbers(libusb_device *dev, uint8_t *port_numbers, int port_numbers_len)
{
    static int (*real)(libusb_device *, uint8_t *, int);
    if (is_fake_dev(dev)) {
        if (port_numbers && port_numbers_len >= 1) {
            port_numbers[0] = 1;
            return 1;
        }
        return -1;
    }
    if (!real) real = (int (*)(libusb_device *, uint8_t *, int))sym("libusb_get_port_numbers");
    return real ? real(dev, port_numbers, port_numbers_len) : -12;
}

EXPORT int libusb_get_port_path(libusb_context *ctx, libusb_device *dev,
                                uint8_t *path, int path_length)
{
    static int (*real)(libusb_context *, libusb_device *, uint8_t *, int);
    if (is_fake_dev(dev)) {
        if (path && path_length >= 1) {
            path[0] = 1;
            return 1;
        }
        return -1;
    }
    if (!real) real = (int (*)(libusb_context *, libusb_device *, uint8_t *, int))
        sym("libusb_get_port_path");
    return real ? real(ctx, dev, path, path_length) : -12;
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

    if (is_fake_dev(dev)) {
        fake_desc_init();
        if (cfg) *cfg = &fcfg;
        pthread_mutex_lock(&lock);
        tap("get_active_config -> 0 (stand-in)");
        describe_config(&fcfg);
        tick();
        pthread_mutex_unlock(&lock);
        return 0;
    }

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

    if (is_fake_dev(dev)) {
        if (index != 0) return -2;      /* LIBUSB_ERROR_NOT_FOUND */
        fake_desc_init();
        if (cfg) *cfg = &fcfg;
        pthread_mutex_lock(&lock);
        tap("get_config(%u) -> 0 (stand-in)", index);
        describe_config(&fcfg);
        tick();
        pthread_mutex_unlock(&lock);
        return 0;
    }

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

/* carlife frees the descriptor it was given; the stand-in's is a static that
 * outlives the process, so freeing it hands libusb's allocator a pointer it
 * never produced. One comparison, and the crash that a correct free would have
 * caused is gone. */
EXPORT void libusb_free_config_descriptor(struct libusb_config_descriptor *cfg)
{
    static void (*real)(struct libusb_config_descriptor *);
    if (!cfg || cfg == &fcfg) return;
    if (!real) real = (void (*)(struct libusb_config_descriptor *))
        sym("libusb_free_config_descriptor");
    if (real) real(cfg);
}

EXPORT int libusb_open(libusb_device *dev, libusb_device_handle **h)
{
    static int (*real)(libusb_device *, libusb_device_handle **);
    int r;
    if (!real) real = (int (*)(libusb_device *, libusb_device_handle **))sym("libusb_open");
    if (!real) return missing("libusb_open");

    if (is_fake_dev(dev)) {
        if (h) *h = FAKE_HND;
        fake_opened = 1;
        bridge_reset();
        pthread_mutex_lock(&lock);
        snprintf(open_text, sizeof open_text, "open %s ok (stand-in)",
                 fake_switched ? "18d1:2d01" : "2d95:7000");
        tap("open -> 0 (stand-in %04x:%04x)",
            fake_switched ? 0x18d1 : 0x2d95, fake_switched ? 0x2d01 : 0x7000);
        fin.have = fin.payload = 0;
        fin.rem = 0;
        fout.have = fout.payload = 0;
        fout.rem = 0;
        tick();
        pthread_mutex_unlock(&lock);
        return 0;
    }

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

    /* The other way to reach the stand-in. carlife on this unit enumerates and
     * opens, so this path is not used today - but a build that reconnects by
     * asking for 18d1:2d01 by number would otherwise get nothing and look like
     * a dead port. */
    if (fake_on && ((vid == 0x18d1 && pid == 0x2d01) ||
                    (vid == 0x2d95 && pid == 0x7000))) {
        fake_opened = 1;
        bridge_reset();
        pthread_mutex_lock(&lock);
        tap("open_with_vid_pid(%04x:%04x) -> handle (stand-in)", vid, pid);
        snprintf(open_text, sizeof open_text, "open %04x:%04x = ok (stand-in)", vid, pid);
        tick();
        pthread_mutex_unlock(&lock);
        return FAKE_HND;
    }

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

    if (is_fake_hnd(h)) {
        fake_opened = 0;
        bridge_reset();
        pthread_mutex_lock(&lock);
        tap("close (stand-in)");
        tick();
        pthread_mutex_unlock(&lock);
        return;
    }

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

    if (is_fake_hnd(h)) {
        fake_claims++;
        pthread_mutex_lock(&lock);
        tap("claim_interface(%d) -> 0 (stand-in)", n);
        tick();
        pthread_mutex_unlock(&lock);
        return 0;
    }

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

    if (is_fake_hnd(h)) {
        pthread_mutex_lock(&lock);
        tap("release_interface(%d) -> 0 (stand-in)", n);
        pthread_mutex_unlock(&lock);
        return 0;
    }

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

    if (is_fake_hnd(h)) {
        pthread_mutex_lock(&lock);
        tap("set_configuration(%d) -> 0 (stand-in)", cfg);
        pthread_mutex_unlock(&lock);
        return 0;
    }

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

    if (is_fake_hnd(h)) {
        pthread_mutex_lock(&lock);
        tap("set_alt_setting(if%d alt%d) -> 0 (stand-in)", iface, alt);
        pthread_mutex_unlock(&lock);
        return 0;
    }

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

    /* A real reset would make the device disappear and come back; here the
     * disappearance is the far side dropping its sockets, which it does by
     * itself. Reporting success is the whole of it - but the stream has to be
     * treated as new, or the next message starts mid-header. */
    if (is_fake_hnd(h)) {
        bridge_reset();
        pthread_mutex_lock(&lock);
        tap("reset_device -> 0 (stand-in)");
        tick();
        pthread_mutex_unlock(&lock);
        return 0;
    }

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

    r = 0;
    if (is_fake_hnd(h)) {
        r = fake_control(rt, req, val, idx, data, len);
    } else {
        if (!real) real = (int (*)(libusb_device_handle *, uint8_t, uint8_t, uint16_t, uint16_t,
                                   unsigned char *, uint16_t, unsigned int))sym("libusb_control_transfer");
        if (!real) return missing("libusb_control_transfer");
        r = real(h, rt, req, val, idx, data, len, timeout);
    }

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

    if (is_fake_hnd(h)) {
        if (ep & 0x80) {
            int n = bridge_in(data, len, timeout);
            if (n < 0) {
                if (transferred) *transferred = 0;
                log_bulk("in ", ep, data, 0, len, n, timeout);
                return n;               /* TIMEOUT is the normal "nothing yet" */
            }
            got = n;
            fake_bulk_in++;
        } else {
            /* Every byte carlife hands to the OUT pipe is accepted, because
             * there is no device to be full: the bridge has already forwarded
             * it (or dropped it while the far side is away), and reporting a
             * short write would make carlife retry half a message. */
            bridge_out(data, len);
            got = len;
            fake_bulk_out++;
        }
        if (transferred) *transferred = got;
        log_bulk((ep & 0x80) ? "in " : "out", ep, data, got, len, 0, timeout);
        return 0;
    }

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

    /* An AOA accessory has no interrupt pipe. Answering one through the bulk
     * bridge would put bytes on a channel they never belonged to; failing it is
     * what the real device does and what any caller should handle. */
    if (is_fake_hnd(h)) {
        if (transferred) *transferred = 0;
        pthread_mutex_lock(&lock);
        tap("interrupt ep=0x%02x len=%d -> -1 (stand-in has no interrupt pipe)", ep, len);
        pthread_mutex_unlock(&lock);
        return -1;
    }

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

    /* Not on the path this shim uses - carlife calls the synchronous API, and
     * the submits in the log are libusb's own, made inside it. Still refused
     * for a stand-in handle rather than handed to a libusb that has no such
     * device, so a future carlife build shows up as a clean failure. */
    if (t && is_fake_hnd(t->dev_handle)) {
        pthread_mutex_lock(&lock);
        tap("submit ep=0x%02x type=%u len=%d -> -1 (stand-in is synchronous only)",
            t->endpoint, t->type, t->length);
        pthread_mutex_unlock(&lock);
        return -1;
    }

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

    if (is_fake_hnd(h)) {
        pthread_mutex_lock(&lock);
        tap("string_ascii(%u) -> -6 (stand-in)", index);
        pthread_mutex_unlock(&lock);
        return -6;
    }

    if (!real) real = (int (*)(libusb_device_handle *, uint8_t, unsigned char *, int))
        sym("libusb_get_string_descriptor_ascii");
    if (!real) return missing("libusb_get_string_descriptor_ascii");
    r = real(h, index, data, len);
    pthread_mutex_lock(&lock);
    tap("string_ascii(%u) -> %d%s%.24s", index, r, r > 0 ? "  \"" : "", r > 0 ? (char *)data : "");
    pthread_mutex_unlock(&lock);
    return r;
}

/* The rest of the handle API. None of these appear in the captured session,
 * which is why they are here: the day one does, the alternative is the real
 * libusb walking a four-byte static struct as if it were a device handle. */
EXPORT int libusb_get_configuration(libusb_device_handle *h, int *cfg)
{
    static int (*real)(libusb_device_handle *, int *);
    if (is_fake_hnd(h)) {
        if (cfg) *cfg = 1;
        return 0;
    }
    if (!real) real = (int (*)(libusb_device_handle *, int *))sym("libusb_get_configuration");
    return real ? real(h, cfg) : -12;
}

EXPORT int libusb_clear_halt(libusb_device_handle *h, unsigned char ep)
{
    static int (*real)(libusb_device_handle *, unsigned char);
    if (is_fake_hnd(h)) {
        pthread_mutex_lock(&lock);
        tap("clear_halt(0x%02x) -> 0 (stand-in)", ep);
        pthread_mutex_unlock(&lock);
        return 0;
    }
    if (!real) real = (int (*)(libusb_device_handle *, unsigned char))sym("libusb_clear_halt");
    return real ? real(h, ep) : -12;
}

EXPORT int libusb_kernel_driver_active(libusb_device_handle *h, int n)
{
    static int (*real)(libusb_device_handle *, int);
    if (is_fake_hnd(h)) return 0;       /* nothing bound, nothing to detach */
    if (!real) real = (int (*)(libusb_device_handle *, int))sym("libusb_kernel_driver_active");
    return real ? real(h, n) : -12;
}

EXPORT int libusb_detach_kernel_driver(libusb_device_handle *h, int n)
{
    static int (*real)(libusb_device_handle *, int);
    if (is_fake_hnd(h)) return -2;      /* NOT_FOUND: no kernel driver */
    if (!real) real = (int (*)(libusb_device_handle *, int))sym("libusb_detach_kernel_driver");
    return real ? real(h, n) : -12;
}

EXPORT int libusb_attach_kernel_driver(libusb_device_handle *h, int n)
{
    static int (*real)(libusb_device_handle *, int);
    if (is_fake_hnd(h)) return -2;
    if (!real) real = (int (*)(libusb_device_handle *, int))sym("libusb_attach_kernel_driver");
    return real ? real(h, n) : -12;
}

EXPORT int libusb_get_interface_alt_setting(libusb_device_handle *h, int n)
{
    static int (*real)(libusb_device_handle *, int);
    if (is_fake_hnd(h)) return 0;
    if (!real) real = (int (*)(libusb_device_handle *, int))sym("libusb_get_interface_alt_setting");
    return real ? real(h, n) : -12;
}

EXPORT int libusb_get_status(libusb_device_handle *h, int type, int index, uint16_t *data)
{
    static int (*real)(libusb_device_handle *, int, int, uint16_t *);
    if (is_fake_hnd(h)) {
        if (data) data[0] = 0;
        return -1;                      /* IO: the stand-in has no status pipe */
    }
    if (!real) real = (int (*)(libusb_device_handle *, int, int, uint16_t *))sym("libusb_get_status");
    return real ? real(h, type, index, data) : -12;
}

EXPORT int libusb_get_string_descriptor(libusb_device_handle *h, uint8_t index, uint16_t langid,
                                        unsigned char *data, int len)
{
    static int (*real)(libusb_device_handle *, uint8_t, uint16_t, unsigned char *, int);
    if (is_fake_hnd(h)) return -6;      /* BUSY, same answer the phone gave */
    if (!real) real = (int (*)(libusb_device_handle *, uint8_t, uint16_t, unsigned char *, int))
        sym("libusb_get_string_descriptor");
    return real ? real(h, index, langid, data, len) : -12;
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
    fake_on = fake_wanted();

    snprintf(path, sizeof path, "%s/tap.txt", SHM_DIR);
    log_fd = open(path, O_WRONLY | O_CREAT | O_TRUNC, 0644);
    log_bytes = 0;
    if (log_fd >= 0) chmod(path, 0644);

    tap("carlife-shim tap - pid %d, %lld.%03ld", (int)getpid(),
        (long long)ts.tv_sec, ts.tv_nsec / 1000000);
    tap("argv0=%s", program_invocation_short_name ? program_invocation_short_name : "?");
    tap("libusb-1.0 %s", sym("libusb_bulk_transfer") ? "reachable" : "NOT FOUND (dlopen'd later?)");
    tap("stand-in %s (ports %d/%d/%d for channels 1/2/3)",
        fake_on ? "on" : "off", FAKE_BASE_PORT, FAKE_BASE_PORT + 1000, FAKE_BASE_PORT + 2000);
    put_state();
}
