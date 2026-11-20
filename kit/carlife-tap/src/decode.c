/* carlife-decode -- CarLife's H.264 to the two pictures the apps draw.
 *
 * CarLife sends the phone's picture as H.264 and nothing else: the protocol
 * carries no turn, no distance, no lane and no speed limit (the vehicle SDK's
 * navigation module has two states, idle and running). The only way to get a
 * map, or a turn arrow, onto the cluster and the HUD is therefore to decode
 * the picture here and cut the wanted piece out of it.
 *
 * The unit has no ffmpeg and no MSDK dispatcher; it has the Intel MSDK 2017
 * hardware library itself (/usr/lib/libmfxhw64.so, API 1.24) and libva. This
 * program therefore loads those with dlopen -- nothing to link against at
 * build time, nothing installed on the unit -- and runs the ordinary MSDK
 * sequence: a VA display on /dev/dri/renderD128, a decoder that hands out
 * opaque surfaces, and a VPP pass that copies those to system memory.
 *
 * Two frames come out of every decoded picture, because cluster-render takes
 * a frame only when its length is exactly the layer's vw x vh:
 *
 *   /dev/shm/carlife-map/live.sock   1088x480   the map, cut to the part of
 *                                               CarLife's picture that is the
 *                                               map and scaled to the layer
 *   /dev/shm/carlife-map/hud.sock     480x168   the guidance strip, cut from
 *                                               the top of the picture
 *
 * Both carry the same 12-byte CLMF header the app's other sources use, so the
 * app needs to know nothing about this program. The cut rectangles come from
 * /dev/shm/carlife-map/crop.json, which the app rewrites when its settings
 * change; this program re-reads it every second, so the settings take effect
 * without a restart.
 *
 * Everything this program knows about itself goes to
 * /dev/shm/carlife-decode.txt, because the car's screen is the only screen the
 * user has: which library was loaded, whether the VA display came up, what
 * size the picture is, how many frames have come out, and the first thing that
 * went wrong. A decoder that fails silently would be indistinguishable from a
 * phone that is not connected.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
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

#include "mfx/mfxvideo.h"

#define DIR        "/dev/shm/carlife-map"
#define IN_SOCK    DIR "/h264.sock"
#define MAP_SOCK   DIR "/live.sock"
#define CARD_SOCK  DIR "/hud.sock"
#define CROP_FILE  DIR "/crop.json"
#define REPORT     "/dev/shm/carlife-decode.txt"

/* The map layer's size (cluster-render takes a frame only at exactly the
 * layer's vw x vh) and the most a crop.json may ask for. They are separate so
 * that a bigger HUD setting cannot make the decoder hand out a frame the app
 * never asked for: the app clamps, and so does this. */
#define MAP_W 1088u
#define MAP_H  480u
#define MAP_MAX_W 1088u
#define MAP_MAX_H  480u
/* The HUD layer is whatever the app's hudWidth makes it: 480x168 at the
 * default 86%, up to 560x200 at 100%. The default below is only what an
 * unreadable crop.json falls back to. */
#define CARD_W 480u
#define CARD_H 168u
#define CARD_MAX_W 640u
#define CARD_MAX_H 256u

#define MAX_IN   (8u * 1024u * 1024u)   /* bigger than this and the stream is not what we think */
#define READ_SZ  (256u * 1024u)
#define POOL_MAX 32
/* MSDK waits are bounded: a GPU hang must not hang the process that the
 * cluster's picture comes from, and a hang shows on the screen either way. */
#define SYNC_MS  1000
#define BUSY_MAX 1000
/* How long one frame may take to reach a reader before it is dropped. Long
 * enough for a reader that is a frame behind, short enough not to become the
 * decoder's own latency. */
#define SEND_WAIT_MS 50

/* ---------------------------------------------------------------- report -- */

static char g_why[512];          /* the first failure that stopped a setup */
static char g_note[256];         /* what is happening now */
static const char *g_mfx_lib = "-";
static const char *g_va_lib = "-";
static int g_mfx_ver = -1;
/* Failures that cost a picture but not the process: a chunk the tap dropped
 * mid-slice, a busy engine. They are counted, and a run of them restarts the
 * session at the next sequence header; they are not the report's `error`,
 * which has to keep meaning "this is why there is no picture at all". */
static unsigned long g_soft;

static void note(const char *fmt, ...)
{
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(g_note, sizeof g_note, fmt, ap);
    va_end(ap);
}

static void fail(const char *fmt, ...)
{
    va_list ap;
    if (g_why[0]) return;        /* the first one is the useful one */
    va_start(ap, fmt);
    vsnprintf(g_why, sizeof g_why, fmt, ap);
    va_end(ap);
}

static void mfx_why(const char *call, mfxStatus sts)
{
    fail("%s: %d", call, (int)sts);
}

/* A failure that is recovered from: counted, shown as what is happening, and
 * never mistaken for the reason there is no picture. */
static void soft_why(const char *call, mfxStatus sts)
{
    g_soft++;
    note("%s: %d (#%lu)", call, (int)sts, g_soft);
}

static long long now_ms(void)
{
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (long long)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

/* -------------------------------------------------------------- sockets -- */

static int listen_unix(const char *path)
{
    struct sockaddr_un a;
    int fd;

    mkdir(DIR, 0777);
    unlink(path);
    fd = socket(AF_UNIX, SOCK_STREAM | SOCK_NONBLOCK | SOCK_CLOEXEC, 0);
    if (fd < 0) return -1;
    memset(&a, 0, sizeof a);
    a.sun_family = AF_UNIX;
    snprintf(a.sun_path, sizeof a.sun_path, "%s", path);
    if (bind(fd, (struct sockaddr *)&a, (socklen_t)sizeof a) < 0 ||
        listen(fd, 4) < 0) {
        close(fd);
        return -1;
    }
    chmod(path, 0666);
    return fd;
}

static int connect_unix(const char *path)
{
    struct sockaddr_un a;
    int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_NONBLOCK | SOCK_CLOEXEC, 0);
    if (fd < 0) return -1;
    memset(&a, 0, sizeof a);
    a.sun_family = AF_UNIX;
    snprintf(a.sun_path, sizeof a.sun_path, "%s", path);
    if (connect(fd, (struct sockaddr *)&a, (socklen_t)sizeof a) < 0) {
        close(fd);
        return -1;
    }
    return fd;
}

/* One output stream. The reader may not be there yet, may go away and may come
 * back; none of that may stop the decode, and none of it may block it. */
typedef struct {
    const char *path;
    int fd;
    unsigned long long seq;
    unsigned long frames;
    unsigned long drops;
} Out;

static void out_shut(Out *o)
{
    if (o->fd >= 0) close(o->fd);
    o->fd = -1;
}

static void out_write(Out *o, const unsigned char *p, size_t n)
{
    /* CLMF, the format the app's frame sources already read: magic, length of
     * the payload, frame number - all little endian, then the 4:2:0 picture. */
    unsigned char hdr[12];
    uint32_t magic = 0x464d4c43u, len = (uint32_t)n, seq = (uint32_t)++o->seq;
    size_t done = 0;
    int waited = 0;

    memcpy(hdr + 0, &magic, 4);
    memcpy(hdr + 4, &len, 4);
    memcpy(hdr + 8, &seq, 4);
    if (o->fd < 0) {
        o->fd = connect_unix(o->path);
        if (o->fd >= 0) {
            /* A frame is most of a megabyte and the socket's default buffer is
             * a fifth of that: without this every frame is written in pieces,
             * and the reader has to keep up between two write calls. */
            int sz = 4 * 1024 * 1024;
            setsockopt(o->fd, SOL_SOCKET, SO_SNDBUF, &sz, sizeof sz);
        }
    }
    if (o->fd < 0) { o->drops++; return; }
    if (write(o->fd, hdr, sizeof hdr) != (ssize_t)sizeof hdr) { out_shut(o); o->drops++; return; }
    while (done < n) {
        ssize_t k = write(o->fd, p + done, n - done);
        if (k > 0) { done += (size_t)k; continue; }
        if (k < 0 && errno == EINTR) continue;
        /* EAGAIN: the reader is a little behind. Wait for it, but only once
         * per frame and only briefly - a decoder that waits for its slowest
         * reader is a decoder that adds its latency to a picture that is
         * already late. A frame abandoned half way is not a lost frame: the
         * close makes the reader drop what it had of it and start at the next
         * header. */
        if (k < 0 && errno == EAGAIN && waited < SEND_WAIT_MS) {
            struct pollfd pf;
            pf.fd = o->fd;
            pf.events = POLLOUT;
            pf.revents = 0;
            int ms = poll(&pf, 1, SEND_WAIT_MS - waited);
            if (ms > 0) continue;
            waited = SEND_WAIT_MS;
        }
        out_shut(o);
        o->drops++;
        return;
    }
    o->frames++;
}

/* ------------------------------------------------------------ crop.json -- */

typedef struct {
    double map_top, map_bottom, map_left, map_right, map_w, map_h;
    double card_top, card_bottom, card_left, card_right, card_w, card_h;
    int card_off;
    int map_stretch;
    int card_stretch;
} Crop;

static double json_num(const char *s, const char *key, double dflt)
{
    char pat[64];
    const char *p;
    snprintf(pat, sizeof pat, "\"%s\"", key);
    p = strstr(s, pat);
    if (!p) return dflt;
    p = strchr(p + strlen(pat), ':');
    if (!p) return dflt;
    return strtod(p + 1, NULL);
}

static const char *json_str(const char *s, const char *key, const char *dflt)
{
    char pat[64];
    const char *p;
    snprintf(pat, sizeof pat, "\"%s\"", key);
    p = strstr(s, pat);
    if (!p) return dflt;
    p = strchr(p + strlen(pat), ':');
    if (!p) return dflt;
    p = strchr(p, '"');
    if (!p) return dflt;
    return p + 1;
}

/* A percentage that a rectangle can be built from: never negative (a negative
 * one would be cast to unsigned and become four billion), never so large that
 * the rectangle is empty, and never so large that top and bottom overlap. */
static double pct(double v, double hi)
{
    if (!(v > 0)) return 0;          /* also catches NaN */
    return v > hi ? hi : v;
}

/* The app writes flat keys - mapTop, cardW, ... - so that this parser can stay
 * a search and a strtod: a nested JSON reader would be more code than the rest
 * of the program. Defaults are the picture as it comes. */
static void read_crop(Crop *c)
{
    char buf[2048];
    FILE *f = fopen(CROP_FILE, "rb");
    size_t n = 0;

    memset(c, 0, sizeof *c);
    c->map_w = MAP_W; c->map_h = MAP_H;
    c->card_w = CARD_W; c->card_h = CARD_H;
    c->card_bottom = 16.0;
    c->card_right = 24.0;
    if (!f) return;
    n = fread(buf, 1, sizeof buf - 1, f);
    fclose(f);
    buf[n] = 0;

    c->map_top    = pct(json_num(buf, "mapTop", 0), 60);
    c->map_bottom = pct(json_num(buf, "mapBottom", 0), 60);
    c->map_left   = pct(json_num(buf, "mapLeft", 0), 45);
    c->map_right  = pct(json_num(buf, "mapRight", 0), 45);
    c->map_w      = json_num(buf, "mapW", MAP_W);
    c->map_h      = json_num(buf, "mapH", MAP_H);
    c->card_top    = pct(json_num(buf, "cardTop", 0), 60);
    c->card_bottom = pct(json_num(buf, "cardBottom", 16), 60);
    c->card_left   = pct(json_num(buf, "cardLeft", 0), 45);
    c->card_right  = pct(json_num(buf, "cardRight", 24), 45);
    c->card_w      = json_num(buf, "cardW", CARD_W);
    c->card_h      = json_num(buf, "cardH", CARD_H);
    if (json_str(buf, "cardMode", "navi")[0] == 'o') c->card_off = 1;    /* "off" */
    if (json_str(buf, "mapFit", "fill")[0] == 's') c->map_stretch = 1;   /* "stretch" */
    if (json_str(buf, "cardFit", "stretch")[0] == 'f') c->card_stretch = 0;
    else c->card_stretch = 1;
    /* The buffers are the layers' sizes and nothing else: a stale or edited
     * file must not be able to make the decoder write past them. */
    if (c->map_w > MAP_MAX_W) c->map_w = MAP_MAX_W;
    if (c->map_h > MAP_MAX_H) c->map_h = MAP_MAX_H;
    if (c->card_w > CARD_MAX_W) c->card_w = CARD_MAX_W;
    if (c->card_h > CARD_MAX_H) c->card_h = CARD_MAX_H;
    if (c->map_w < 16) c->map_w = MAP_W;
    if (c->map_h < 16) c->map_h = MAP_H;
    if (c->card_w < 16) c->card_w = CARD_W;
    if (c->card_h < 16) c->card_h = CARD_H;
    /* 4:2:0 again: an odd atlas width would put every chroma row a byte out of
     * step with the one before it, and a layer takes only its own size. */
    c->map_w  = (double)((unsigned)c->map_w & ~1u);
    c->map_h  = (double)((unsigned)c->map_h & ~1u);
    c->card_w = (double)((unsigned)c->card_w & ~1u);
    c->card_h = (double)((unsigned)c->card_h & ~1u);
}

/* --------------------------------------------------------------- scaling -- */

static unsigned even(double v, unsigned lo, unsigned hi)
{
    unsigned u = (unsigned)(v < 0 ? 0 : v);
    u &= ~1u;
    if (u < lo) u = lo & ~1u;
    if (u > hi) u = hi & ~1u;
    return u;
}

typedef struct { unsigned x, y, w, h; } Rect;

/* A percentage rectangle of the picture, filled out to the target's aspect so
 * that the picture is not stretched: this is what the setting calls Fit. */
static Rect rect_of(unsigned pw, unsigned ph, double top, double bottom,
                    double left, double right, unsigned dw, unsigned dh, int keep_aspect)
{
    Rect r;
    unsigned x0 = (unsigned)(pw * left / 100.0);
    unsigned x1 = pw - (unsigned)(pw * right / 100.0);
    unsigned y0 = (unsigned)(ph * top / 100.0);
    unsigned y1 = ph - (unsigned)(ph * bottom / 100.0);

    x0 &= ~1u; y0 &= ~1u;
    x1 &= ~1u; y1 &= ~1u;
    if (x1 <= x0 + 16) x1 = x0 + 16;
    if (y1 <= y0 + 16) y1 = y0 + 16;
    if (x1 > pw) x1 = pw;
    if (y1 > ph) y1 = ph;

    r.x = x0; r.y = y0; r.w = x1 - x0; r.h = y1 - y0;
    if (!dw || !dh) return r;

    if (keep_aspect) {
        /* Trim the longer side, never add: the pixels have to come from
         * somewhere, and outside the picture there is nothing. */
        if ((double)r.w / r.h > (double)dw / dh) {
            unsigned nw = even((double)r.h * dw / dh, 16, pw);
            if (nw < r.w) { r.x += (r.w - nw) / 2; r.w = nw; }
        } else {
            unsigned nh = even((double)r.w * dh / dw, 16, ph);
            if (nh < r.h) { r.y += (r.h - nh) / 2; r.h = nh; }
        }
    }
    /* Chroma is a quarter of the picture, so both the rectangle and where it
     * starts have to be even - centring an odd difference is exactly how a
     * picture ends up one column into its neighbour's colour. */
    r.x &= ~1u; r.y &= ~1u; r.w &= ~1u; r.h &= ~1u;
    return r;
}

/* Nearest neighbour. The source is a phone picture that is being scaled down by
 * about two; interpolation would cost more than it shows, and a HUD is read at
 * a glance. */
static void blit(unsigned char *dst, unsigned dw, unsigned dh,
                 const unsigned char *sy, unsigned spitch,
                 const unsigned char *suv, unsigned sxp, Rect r)
{
    unsigned x, y;

    for (y = 0; y < dh; y++) {
        unsigned syy = r.y + (unsigned)((unsigned long long)y * r.h / dh);
        const unsigned char *src = sy + (size_t)syy * spitch + r.x;
        unsigned char *row = dst + (size_t)y * dw;
        if (r.w == dw) {
            memcpy(row, src, dw);
        } else {
            for (x = 0; x < dw; x++)
                row[x] = src[(unsigned)((unsigned long long)x * r.w / dw)];
        }
    }

    /* Chroma is half resolution in both directions. Two layouts meet here and
     * only one of them can be right: MSDK's VPP hands out NV12, with U and V
     * interleaved two bytes a sample, while the atlas the app draws keeps U in
     * the left half of each chroma row and V in the right half (atlas.js's
     * fillUV and cluster-render's pack_nv12_atlas both read it that way). So
     * the split happens here, not there: interleaved bytes copied straight
     * into the atlas are an atlas whose every chroma sample is a U next to a V,
     * which on the screen is a picture in the wrong colours - the one failure
     * that looks like broken hardware rather than a bug. */
    {
        unsigned half_h = dh / 2, half_w = dw / 2;
        unsigned char *du = dst + (size_t)dw * dh;
        unsigned char *dv = du + half_w;
        unsigned rx = r.x / 2, ry = r.y / 2, rw = r.w / 2, rh = r.h / 2;

        for (y = 0; y < half_h; y++) {
            unsigned syy = ry + (unsigned)((unsigned long long)y * rh / half_h);
            const unsigned char *src = suv + (size_t)syy * sxp + (size_t)rx * 2;
            unsigned char *ru = du + (size_t)y * dw;
            unsigned char *rv = dv + (size_t)y * dw;
            for (x = 0; x < half_w; x++) {
                unsigned k = rw == half_w ? x
                           : (unsigned)((unsigned long long)x * rw / half_w);
                ru[x] = src[k * 2];
                rv[x] = src[k * 2 + 1];
            }
        }
    }
}

/* --------------------------------------------------------------- decode -- */

typedef struct {
    mfxStatus (*init)(mfxIMPL, mfxVersion *, mfxSession *);
    mfxStatus (*close)(mfxSession);
    mfxStatus (*query_version)(mfxSession, mfxVersion *);
    mfxStatus (*set_handle)(mfxSession, mfxHandleType, mfxHDL);
    mfxStatus (*sync)(mfxSession, mfxSyncPoint, mfxU32);
    mfxStatus (*dec_header)(mfxSession, mfxBitstream *, mfxVideoParam *);
    mfxStatus (*dec_query)(mfxSession, mfxVideoParam *, mfxFrameAllocRequest *);
    mfxStatus (*dec_init)(mfxSession, mfxVideoParam *);
    mfxStatus (*dec_close)(mfxSession);
    mfxStatus (*decode)(mfxSession, mfxBitstream *, mfxFrameSurface1 *,
                        mfxFrameSurface1 **, mfxSyncPoint *);
    mfxStatus (*vpp_query)(mfxSession, mfxVideoParam *, mfxFrameAllocRequest *);
    mfxStatus (*vpp_init)(mfxSession, mfxVideoParam *);
    mfxStatus (*vpp_close)(mfxSession);
    mfxStatus (*vpp_run)(mfxSession, mfxFrameSurface1 *, mfxFrameSurface1 *,
                         mfxExtVppAuxData *, mfxSyncPoint *);
} Api;

static Api g_api;

static void *(*g_va_get_display)(int);
static int (*g_va_init)(void *, int *, int *);
static int (*g_va_term)(void *);

static void *sym(void *h, const char *n)
{
    void *p = dlsym(h, n);
    return p;
}

static int load_mfx(void)
{
    static const char *names[] = {
        "libmfxhw64.so", "libmfxhw64.so.1", "libmfx.so.1", "libmfx.so", NULL
    };
    void *h = NULL;
    int i;

    for (i = 0; names[i]; i++) {
        h = dlopen(names[i], RTLD_NOW | RTLD_GLOBAL);
        if (h) { g_mfx_lib = names[i]; break; }
    }
    if (!h) { fail("no MSDK library: %s", dlerror()); return 0; }

#define GET(f, n) do { *(void **)(&g_api.f) = sym(h, n); \
        if (!g_api.f) { fail("MSDK has no %s", n); return 0; } } while (0)
    GET(init, "MFXInit");
    GET(close, "MFXClose");
    GET(query_version, "MFXQueryVersion");
    GET(set_handle, "MFXVideoCORE_SetHandle");
    GET(sync, "MFXVideoCORE_SyncOperation");
    GET(dec_header, "MFXVideoDECODE_DecodeHeader");
    GET(dec_query, "MFXVideoDECODE_QueryIOSurf");
    GET(dec_init, "MFXVideoDECODE_Init");
    GET(dec_close, "MFXVideoDECODE_Close");
    GET(decode, "MFXVideoDECODE_DecodeFrameAsync");
    GET(vpp_query, "MFXVideoVPP_QueryIOSurf");
    GET(vpp_init, "MFXVideoVPP_Init");
    GET(vpp_close, "MFXVideoVPP_Close");
    GET(vpp_run, "MFXVideoVPP_RunFrameVPPAsync");
#undef GET
    return 1;
}

static int load_va(void)
{
    static const char *va_names[] = { "libva.so.2", "libva.so.1", "libva.so", NULL };
    static const char *drm_names[] = { "libva-drm.so.2", "libva-drm.so.1", "libva-drm.so", NULL };
    void *va = NULL, *drm = NULL;
    int i;

    for (i = 0; va_names[i] && !va; i++) va = dlopen(va_names[i], RTLD_NOW | RTLD_GLOBAL);
    if (!va) return 0;
    for (i = 0; drm_names[i] && !drm; i++) drm = dlopen(drm_names[i], RTLD_NOW | RTLD_GLOBAL);
    if (!drm) return 0;
    *(void **)(&g_va_get_display) = sym(drm, "vaGetDisplayDRM");
    *(void **)(&g_va_init) = sym(va, "vaInitialize");
    *(void **)(&g_va_term) = sym(va, "vaTerminate");
    if (!g_va_get_display || !g_va_init) return 0;
    g_va_lib = "libva";
    return 1;
}

typedef struct {
    int up;                       /* a session and a picture size */
    mfxSession session;
    void *display;
    int dri;
    unsigned w, h;                /* the picture, from its own SPS */
    unsigned pitch;               /* VPP output stride, 64-byte aligned */
    unsigned vheight;             /* VPP output height, 16-byte aligned */
    mfxFrameSurface1 pool[POOL_MAX];
    mfxFrameSurface1 *pool_ptrs[POOL_MAX];
    unsigned pool_n;
    mfxVideoParam dec;
    mfxVideoParam vpp;
    mfxExtOpaqueSurfaceAlloc dec_op;
    mfxExtOpaqueSurfaceAlloc vpp_op;
    mfxExtBuffer *dec_ext[1];
    mfxExtBuffer *vpp_ext[1];
    mfxFrameSurface1 vout;
    unsigned char *vmem;
} Dec;

static void dec_stop(Dec *d)
{
    if (d->session) {
        if (d->up) { g_api.vpp_close(d->session); g_api.dec_close(d->session); }
        g_api.close(d->session);
        d->session = NULL;
    }
    if (d->display && g_va_term) g_va_term(d->display);
    if (d->dri >= 0) close(d->dri);
    d->dri = -1;
    d->display = NULL;
    free(d->vmem);
    d->vmem = NULL;
    d->up = 0;
}

/* A VA display is what the unit's hardware library takes its device from: on
 * Linux it has no other way to reach /dev/dri, and without one MFXInit fails
 * with a device error that says nothing about the reason. */
static int open_session(Dec *d)
{
    mfxVersion ver;
    mfxStatus sts;
    int major = 0, minor = 0;

    d->dri = open("/dev/dri/renderD128", O_RDWR | O_CLOEXEC);
    if (d->dri < 0) {
        note("no renderD128 (%s)", strerror(errno));
    } else if (load_va()) {
        d->display = g_va_get_display(d->dri);
        if (!d->display) {
            note("vaGetDisplayDRM found nothing");
        } else if (g_va_init(d->display, &major, &minor) != 0) {
            note("vaInitialize failed");
            g_va_term(d->display);
            d->display = NULL;
        }
    } else {
        note("no libva on this unit");
    }

    ver.Major = (mfxU16)MFX_VERSION_MAJOR;
    ver.Minor = (mfxU16)MFX_VERSION_MINOR;
    sts = g_api.init(MFX_IMPL_HARDWARE | MFX_IMPL_VIA_VAAPI, &ver, &d->session);
    if (sts < MFX_ERR_NONE) {
        /* A library that makes its own display is worth one try before giving
         * up: the failure above may have been ours, not the unit's. */
        d->session = NULL;
        sts = g_api.init(MFX_IMPL_HARDWARE, &ver, &d->session);
        if (sts < MFX_ERR_NONE) { mfx_why("MFXInit", sts); return 0; }
    }
    if (d->display) {
        sts = g_api.set_handle(d->session, MFX_HANDLE_VA_DISPLAY, d->display);
        if (sts < MFX_ERR_NONE) {
            mfx_why("MFXVideoCORE_SetHandle", sts);
            g_api.close(d->session);
            d->session = NULL;
            return 0;
        }
    }
    if (g_api.query_version(d->session, &ver) >= MFX_ERR_NONE)
        g_mfx_ver = ver.Major * 100 + ver.Minor;
    return 1;
}

/* Everything a sequence needs, in the order MSDK wants it. The decoder writes
 * into opaque surfaces - video memory the application never sees - and a VPP
 * pass copies each finished picture to system memory, where the cutting out
 * happens. */
static int dec_start(Dec *d, mfxVideoParam *from_header)
{
    mfxStatus sts;
    mfxFrameAllocRequest dec_req, vpp_req[2];
    mfxFrameInfo in, out;
    unsigned n, i;
    size_t bytes;

    if (!d->session && !open_session(d))
        return 0;

    d->dec = *from_header;
    d->dec.AsyncDepth = 1;
    d->dec.IOPattern = MFX_IOPATTERN_OUT_OPAQUE_MEMORY;
    d->dec.mfx.DecodedOrder = 1;      /* each picture as soon as it is decoded */

    in = d->dec.mfx.FrameInfo;
    /* A stream without a cropping rectangle in its SPS carries its picture at
     * the coded size: CropW/CropH are then 0, and the size is Width/Height. */
    d->w = in.CropW ? in.CropW : in.Width;
    d->h = in.CropH ? in.CropH : in.Height;
    if (!d->w || !d->h) { fail("the SPS gives no picture size"); dec_stop(d); return 0; }
    /* 4:2:0 is a 2x2 block per chroma sample: an odd picture cannot be cut into
     * even rectangles, and the last row and column would have no colour. The
     * even size goes back into the frame info the surfaces and VPP are set up
     * with, or the two would disagree about where the chroma row ends. */
    d->w &= ~1u;
    d->h &= ~1u;
    in.CropX = in.CropY = 0;
    in.CropW = (mfxU16)d->w;
    in.CropH = (mfxU16)d->h;

    memset(&d->vpp, 0, sizeof d->vpp);
    d->vpp.AsyncDepth = 1;
    d->vpp.IOPattern = MFX_IOPATTERN_IN_OPAQUE_MEMORY | MFX_IOPATTERN_OUT_SYSTEM_MEMORY;
    d->vpp.vpp.In = in;

    out = in;
    out.FourCC = MFX_FOURCC_NV12;
    out.ChromaFormat = MFX_CHROMAFORMAT_YUV420;
    out.PicStruct = MFX_PICSTRUCT_PROGRESSIVE;
    out.Width = (mfxU16)((in.CropW + 15) & ~15u);
    out.Height = (mfxU16)((in.CropH + 15) & ~15u);
    out.CropX = out.CropY = 0;
    out.CropW = in.CropW;
    out.CropH = in.CropH;
    if (!in.FrameRateExtN || !in.FrameRateExtD) {
        d->vpp.vpp.In.FrameRateExtN = out.FrameRateExtN = 30;
        d->vpp.vpp.In.FrameRateExtD = out.FrameRateExtD = 1;
    }
    d->vpp.vpp.Out = out;

    memset(&dec_req, 0, sizeof dec_req);
    memset(vpp_req, 0, sizeof vpp_req);
    sts = g_api.dec_query(d->session, &d->dec, &dec_req);
    if (sts < MFX_ERR_NONE) { mfx_why("MFXVideoDECODE_QueryIOSurf", sts); dec_stop(d); return 0; }
    sts = g_api.vpp_query(d->session, &d->vpp, vpp_req);
    if (sts < MFX_ERR_NONE) { mfx_why("MFXVideoVPP_QueryIOSurf", sts); dec_stop(d); return 0; }

    n = (unsigned)dec_req.NumFrameSuggested + (unsigned)vpp_req[0].NumFrameSuggested + 2;
    if (n > POOL_MAX) n = POOL_MAX;
    d->pool_n = n;
    for (i = 0; i < n; i++) {
        memset(&d->pool[i], 0, sizeof d->pool[i]);
        d->pool[i].Info = in;
        d->pool_ptrs[i] = &d->pool[i];
    }

    memset(&d->dec_op, 0, sizeof d->dec_op);
    d->dec_op.Header.BufferId = MFX_EXTBUFF_OPAQUE_SURFACE_ALLOCATION;
    d->dec_op.Header.BufferSz = sizeof d->dec_op;
    d->dec_op.Out.Surfaces = d->pool_ptrs;
    d->dec_op.Out.NumSurface = (mfxU16)n;
    d->dec_op.Out.Type = dec_req.Type;
    memset(&d->vpp_op, 0, sizeof d->vpp_op);
    d->vpp_op.Header = d->dec_op.Header;
    d->vpp_op.In = d->dec_op.Out;
    d->dec_ext[0] = &d->dec_op.Header;
    d->vpp_ext[0] = &d->vpp_op.Header;
    d->dec.ExtParam = d->dec_ext;
    d->dec.NumExtParam = 1;
    d->vpp.ExtParam = d->vpp_ext;
    d->vpp.NumExtParam = 1;

    sts = g_api.dec_init(d->session, &d->dec);
    /* A failed init leaves the session unusable: close it here, so that the
     * next sequence header starts from nothing rather than from half a
     * pipeline whose error the report already names. */
    if (sts < MFX_ERR_NONE) { mfx_why("MFXVideoDECODE_Init", sts); dec_stop(d); return 0; }
    sts = g_api.vpp_init(d->session, &d->vpp);
    if (sts < MFX_ERR_NONE) {
        g_api.dec_close(d->session);
        mfx_why("MFXVideoVPP_Init", sts);
        dec_stop(d);
        return 0;
    }

    d->pitch = (out.Width + 63u) & ~63u;
    d->vheight = out.Height;
    bytes = (size_t)d->pitch * d->vheight * 3 / 2;
    d->vmem = aligned_alloc(4096, (bytes + 4095) & ~(size_t)4095);
    if (!d->vmem) { fail("no memory for the VPP output"); dec_stop(d); return 0; }
    memset(d->vmem, 0, bytes);
    memset(&d->vout, 0, sizeof d->vout);
    d->vout.Info = out;
    d->vout.Data.Pitch = (mfxU16)d->pitch;
    d->vout.Data.Y = d->vmem;
    d->vout.Data.UV = d->vmem + (size_t)d->pitch * d->vheight;

    d->up = 1;
    note("picture %ux%u", d->w, d->h);
    return 1;
}

/* One SPS is enough to know the picture size; DecodeHeader wants the SPS and
 * the PPS that follows it, so it is retried until it says something else than
 * "more data". */
static int have_sps(const unsigned char *p, size_t n)
{
    size_t i;
    for (i = 0; i + 3 < n; i++)
        if (p[i] == 0 && p[i + 1] == 0 && p[i + 2] == 1 && (p[i + 3] & 0x1f) == 7)
            return 1;
    return 0;
}

/* Drop everything before the first start code at or after `from` - the bytes
 * the decoder has already eaten plus whatever the tap joined mid-picture.
 * Scanning from `from` and not from 0 is what makes progress: a start code
 * before it belongs to data already given to the decoder, and returning to it
 * would feed the same bytes again for ever. */
static void resync(unsigned char *p, size_t *n, size_t from)
{
    size_t i;
    for (i = from; i + 3 < *n; i++) {
        if (p[i] == 0 && p[i + 1] == 0 && p[i + 2] == 1) {
            memmove(p, p + i, *n - i);
            *n -= i;
            return;
        }
    }
    *n = 0;
}

/* ---------------------------------------------------------------- frames -- */

static Out g_map = { MAP_SOCK, -1, 0, 0, 0 };
static Out g_card = { CARD_SOCK, -1, 0, 0, 0 };
static unsigned char *g_mapbuf, *g_cardbuf;
static size_t g_mapbuf_sz, g_cardbuf_sz;
static long long g_last_frame_ms;
static unsigned long g_frames, g_rate, g_rate_at_frames;
static long long g_rate_at_ms;
/* The crop the pictures are being cut with, and the rectangles the last frame
 * came from: the report prints both, because on the car's screen the only way
 * to tell "the settings are not being read" from "they are read and wrong" is
 * to see what the decoder made of them. */
static Crop g_crop;
static Rect g_map_rect, g_card_rect;
static int g_have_rects;
static long long g_crop_read_ms;

/* An atlas buffer of exactly this size, remade when a setting changes its
 * size. Never reused across a size change: a frame is taken only at its
 * layer's size, and a buffer that is the wrong size is a frame that is
 * silently dropped. */
static unsigned char *buf_for(unsigned char **buf, size_t *have, size_t need)
{
    if (*buf && *have == need) return *buf;
    free(*buf);
    *buf = malloc(need);
    *have = *buf ? need : 0;
    return *buf;
}

static void produce(const Dec *d)
{
    Rect r;
    long long t = now_ms();
    unsigned mw, mh, cw, ch;

    /* The app rewrites the file when a setting changes and cannot tell this
     * program so: read it again, but not once per frame - a picture every
     * 60 ms is faster than anyone turns a dial. */
    if (!g_crop_read_ms || t - g_crop_read_ms >= 500) {
        g_crop_read_ms = t;
        read_crop(&g_crop);
    }

    mw = (unsigned)g_crop.map_w;
    mh = (unsigned)g_crop.map_h;
    cw = (unsigned)g_crop.card_w;
    ch = (unsigned)g_crop.card_h;
    if (!buf_for(&g_mapbuf, &g_mapbuf_sz, (size_t)mw * mh * 3 / 2)) {
        fail("no memory for the map");
        return;
    }
    if (!g_crop.card_off && !buf_for(&g_cardbuf, &g_cardbuf_sz, (size_t)cw * ch * 3 / 2)) {
        fail("no memory for the card");
        return;
    }

    /* The map: the part of CarLife's picture that is the map, filled out so
     * the cluster's layer is not stretched. */
    r = rect_of(d->w, d->h, g_crop.map_top, g_crop.map_bottom, g_crop.map_left,
                g_crop.map_right, mw, mh, !g_crop.map_stretch);
    blit(g_mapbuf, mw, mh, d->vout.Data.Y, d->pitch, d->vout.Data.UV, d->pitch, r);
    out_write(&g_map, g_mapbuf, (size_t)mw * mh * 3 / 2);
    g_map_rect = r;

    /* The HUD: the guidance strip at the top of the picture, straight across.
     * CarLife draws its arrow, its road name and its lanes there, so cutting
     * rather than redrawing is the only thing that can be honest about them. */
    if (!g_crop.card_off) {
        r = rect_of(d->w, d->h, g_crop.card_top, g_crop.card_bottom, g_crop.card_left,
                    g_crop.card_right, cw, ch, !g_crop.card_stretch);
        blit(g_cardbuf, cw, ch, d->vout.Data.Y, d->pitch, d->vout.Data.UV, d->pitch, r);
        out_write(&g_card, g_cardbuf, (size_t)cw * ch * 3 / 2);
        g_card_rect = r;
    }
    g_have_rects = 1;

    g_frames++;
    g_last_frame_ms = t;
    if (t - g_rate_at_ms >= 1000) {
        g_rate = (unsigned long)((g_frames - g_rate_at_frames) * 1000 / (t - g_rate_at_ms));
        g_rate_at_frames = g_frames;
        g_rate_at_ms = t;
    }
}

/* ------------------------------------------------------------- main loop -- */

static void write_report(void)
{
    char buf[2048];
    char card[32];
    time_t t = time(NULL);
    struct tm tm;
    long long age = g_last_frame_ms ? (now_ms() - g_last_frame_ms) : -1;
    int n;

    if (g_crop.card_off)
        snprintf(card, sizeof card, "off");
    else
        snprintf(card, sizeof card, "%ux%u", (unsigned)g_crop.card_w, (unsigned)g_crop.card_h);

    localtime_r(&t, &tm);
    n = snprintf(buf, sizeof buf,
        "=== CARLIFE DECODE %02d:%02d:%02d pid=%d ===\n"
        "libs: mfx=%s%s va=%s mfxapi=%d\n"
        "state: %s\n"
        "frames: %lu rate %lu fps last %lldms\n"
        "sockets: map=%s(%lu) card=%s(%lu) drops=%lu+%lu\n"
        "out: map %ux%u card %s\n"
        "crop: map t%.0f b%.0f l%.0f r%.0f %s; card t%.0f b%.0f l%.0f r%.0f %s\n"
        "rect: map %u,%u %ux%u; card %u,%u %ux%u\n"
        "errors: %lu\n"
        "error: %s\n",
        tm.tm_hour, tm.tm_min, tm.tm_sec, (int)getpid(),
        g_mfx_lib, g_va_lib[0] == '-' ? " (none)" : "", g_va_lib, g_mfx_ver,
        g_note[0] ? g_note : "starting",
        g_frames, g_rate, age,
        g_map.fd >= 0 ? "on" : "waiting", g_map.frames,
        g_card.fd >= 0 ? "on" : "waiting", g_card.frames,
        g_map.drops, g_card.drops,
        (unsigned)g_crop.map_w, (unsigned)g_crop.map_h, card,
        g_crop.map_top, g_crop.map_bottom, g_crop.map_left, g_crop.map_right,
        g_crop.map_stretch ? "stretch" : "fill",
        g_crop.card_top, g_crop.card_bottom, g_crop.card_left, g_crop.card_right,
        g_crop.card_stretch ? "stretch" : "fill",
        g_have_rects ? g_map_rect.x : 0, g_have_rects ? g_map_rect.y : 0,
        g_have_rects ? g_map_rect.w : 0, g_have_rects ? g_map_rect.h : 0,
        g_have_rects ? g_card_rect.x : 0, g_have_rects ? g_card_rect.y : 0,
        g_have_rects ? g_card_rect.w : 0, g_have_rects ? g_card_rect.h : 0,
        g_soft,
        g_why[0] ? g_why : "none");

    {
        int fd;
        ssize_t k;
        /* snprintf returns what it would have written, which is more than the
         * buffer when a line does not fit: writing that many bytes would read
         * past it. */
        if (n > (int)sizeof buf - 1) n = (int)sizeof buf - 1;
        if (n < 0) n = 0;
        fd = open(REPORT, O_WRONLY | O_CREAT | O_TRUNC, 0644);
        if (fd >= 0) {
            k = write(fd, buf, (size_t)n);
            (void)k;
            close(fd);
        }
    }
}

int main(void)
{
    Dec dec;
    static unsigned char *ibuf;
    size_t ilen = 0, iconsumed = 0;
    int lfd, client = -1;
    mfxVideoParam par;
    mfxStatus sts;
    int header_done = 0, restarts = 0, stalls = 0;
    long long last_report = 0;

    signal(SIGPIPE, SIG_IGN);
    memset(&dec, 0, sizeof dec);
    dec.dri = -1;

    if (!load_mfx()) {
        /* The library the unit decodes with is missing or unusable. Returning
         * here would put the unit into a restart loop, which reads as a failed
         * install and tells nobody why; staying up reports the same reason once
         * a second and picks the library up the moment it can be loaded. */
        for (;;) {
            write_report();
            sleep(30);
            g_why[0] = 0;
            if (load_mfx()) break;
        }
    }
    /* Once before anything is decoded, so that the report can say what it is
     * set up to cut even while it waits for the tap. */
    read_crop(&g_crop);
    g_crop_read_ms = now_ms();
    lfd = listen_unix(IN_SOCK);
    if (lfd < 0) { fail("cannot listen on %s: %s", IN_SOCK, strerror(errno)); write_report(); return 1; }
    ibuf = malloc(MAX_IN);
    if (!ibuf) { fail("no memory for the stream"); write_report(); return 1; }
    note("waiting for the tap");

    for (;;) {
        struct pollfd pfd[2];
        int nfd = 1;

        pfd[0].fd = lfd;
        pfd[0].events = POLLIN;
        pfd[1].fd = client;
        pfd[1].events = POLLIN;
        if (client >= 0) nfd = 2;

        if (poll(pfd, (nfds_t)nfd, 200) < 0 && errno != EINTR) {
            fail("poll: %s", strerror(errno));
            break;
        }

        if (pfd[0].revents & POLLIN) {
            int c = accept4(lfd, NULL, NULL, SOCK_NONBLOCK | SOCK_CLOEXEC);
            if (c >= 0) {
                if (client >= 0) close(client);   /* one capture at a time */
                client = c;
                ilen = iconsumed = 0;
                note("stream connected");
            }
        }

        if (client >= 0 && (pfd[1].revents & (POLLIN | POLLHUP | POLLERR))) {
            if (ilen + READ_SZ > MAX_IN && iconsumed) {
                memmove(ibuf, ibuf + iconsumed, ilen - iconsumed);
                ilen -= iconsumed;
                iconsumed = 0;
            }
            if (ilen + READ_SZ <= MAX_IN) {
                ssize_t k = read(client, ibuf + ilen, READ_SZ);
                if (k > 0) {
                    ilen += (size_t)k;
                } else if (k == 0 || (errno != EAGAIN && errno != EINTR)) {
                    close(client);
                    client = -1;
                    ilen = iconsumed = 0;
                    header_done = 0;
                    dec_stop(&dec);
                    note("stream went away");
                }
            }
        }

        /* Resynchronise to the first start code: the tap may join the stream in
         * the middle of a picture, and nothing decodes before a sequence
         * header anyway. */
        if (!header_done && ilen - iconsumed > 4) {
            size_t avail = ilen - iconsumed;
            if (!have_sps(ibuf + iconsumed, avail)) {
                resync(ibuf, &ilen, iconsumed);
                iconsumed = 0;
            } else if (!dec.session && !open_session(&dec)) {
                header_done = 1;       /* the reason is in the report */
            } else {
                mfxBitstream bs;
                memset(&bs, 0, sizeof bs);
                memset(&par, 0, sizeof par);
                /* The decoder fills it in from the SPS; naming the codec is
                 * what the reference implementation on this unit does, and it
                 * costs nothing. */
                par.mfx.CodecId = MFX_CODEC_AVC;
                bs.Data = ibuf + iconsumed;
                bs.DataLength = (mfxU32)avail;
                bs.MaxLength = (mfxU32)avail;
                sts = g_api.dec_header(dec.session, &bs, &par);
                if (sts == MFX_ERR_MORE_DATA) {
                    if (avail >= MAX_IN / 2) { fail("no sequence header in %u bytes", (unsigned)avail); }
                } else if (sts < MFX_ERR_NONE) {
                    /* This NAL cannot start a sequence: step past it and look
                     * for the next one, rather than reading the same bytes
                     * again on every loop. */
                    size_t skip = 4;
                    soft_why("MFXVideoDECODE_DecodeHeader", sts);
                    while (skip + 3 < avail &&
                           !(ibuf[iconsumed + skip] == 0 &&
                             ibuf[iconsumed + skip + 1] == 0 &&
                             ibuf[iconsumed + skip + 2] == 1))
                        skip++;
                    iconsumed += skip < avail ? skip : avail;
                } else if (dec_start(&dec, &par)) {
                    header_done = 1;
                    note("decoding %ux%u", dec.w, dec.h);
                } else {
                    header_done = 1;       /* the reason is in the report */
                }
            }
        }

        if (header_done && dec.up) {
            int stop = 0, busy = 0;

            while (!stop) {
                mfxBitstream bs;
                mfxFrameSurface1 *work = NULL, *out = NULL;
                mfxSyncPoint sync = NULL;
                unsigned i;

                if (iconsumed >= ilen) break;
                for (i = 0; i < dec.pool_n; i++)
                    if (!dec.pool[i].Data.Locked) { work = &dec.pool[i]; break; }
                if (!work) break;          /* every surface is still busy: next time */

                memset(&bs, 0, sizeof bs);
                bs.Data = ibuf + iconsumed;
                bs.DataLength = (mfxU32)(ilen - iconsumed);
                bs.MaxLength = bs.DataLength;
                bs.TimeStamp = (mfxU64)g_frames + 1;

                sts = g_api.decode(dec.session, &bs, work, &out, &sync);
                iconsumed += bs.DataOffset;
                if (!bs.DataOffset && !sync) {
                    /* The decoder took nothing and gave nothing: it will not
                     * start moving again on its own. Waiting would leave the
                     * picture stopped for good, so this is a restart like any
                     * other failed picture. */
                    if (++stalls > 8) {
                        soft_why("MFXVideoDECODE_DecodeFrameAsync (no progress)", sts);
                        stop = 1;
                        continue;
                    }
                } else {
                    stalls = 0;
                }

                if (sts == MFX_WRN_DEVICE_BUSY) {
                    /* Bounded: a device that stays busy is a hung device, and
                     * spinning on it forever would stop the picture without
                     * ever saying why. */
                    if (++busy > BUSY_MAX) {
                        soft_why("MFXVideoDECODE_DecodeFrameAsync (busy)", sts);
                        stop = 1;
                    } else {
                        usleep(1000);
                    }
                    continue;
                }
                busy = 0;
                if (sts == MFX_ERR_MORE_DATA) break;
                if (sts == MFX_ERR_INCOMPATIBLE_VIDEO_PARAM) {
                    /* Another sequence (a phone rotated, a resolution change):
                     * throw the session away and set it up from this point. */
                    if (++restarts > 8) { fail("the stream keeps changing its sequence"); break; }
                    dec_stop(&dec);
                    header_done = 0;
                    note("sequence changed, restarting");
                    break;
                }
                if (sts < MFX_ERR_NONE && sts != MFX_ERR_MORE_SURFACE) {
                    /* A picture the decoder cannot use - a slice the tap
                     * dropped half of, most often. It costs this picture and
                     * the ones that refer to it, not the process: the session
                     * goes, and the next sequence header starts a new one. */
                    soft_why("MFXVideoDECODE_DecodeFrameAsync", sts);
                    stop = 1;
                    continue;
                }
                if (!sync) continue;

                sts = g_api.sync(dec.session, sync, SYNC_MS);
                if (sts != MFX_ERR_NONE) {
                    soft_why("MFXVideoCORE_SyncOperation", sts);
                    stop = 1;
                    continue;
                }

                sts = g_api.vpp_run(dec.session, out, &dec.vout, NULL, &sync);
                if (sts == MFX_WRN_DEVICE_BUSY) {
                    if (++busy > BUSY_MAX) {
                        soft_why("MFXVideoVPP_RunFrameVPPAsync (busy)", sts);
                        stop = 1;
                    } else {
                        usleep(1000);
                    }
                    continue;
                }
                busy = 0;
                if (sts == MFX_ERR_MORE_DATA) continue;   /* VPP keeps the input */
                if (sts < MFX_ERR_NONE) {
                    soft_why("MFXVideoVPP_RunFrameVPPAsync", sts);
                    stop = 1;
                    continue;
                }
                if (!sync) continue;
                sts = g_api.sync(dec.session, sync, SYNC_MS);
                if (sts != MFX_ERR_NONE) {
                    soft_why("MFXVideoCORE_SyncOperation (VPP)", sts);
                    stop = 1;
                    continue;
                }

                produce(&dec);
            }

            if (iconsumed) {
                memmove(ibuf, ibuf + iconsumed, ilen - iconsumed);
                ilen -= iconsumed;
                iconsumed = 0;
            }
            if (stop) {
                dec_stop(&dec);
                header_done = 0;           /* the next sequence header restarts */
                stalls = 0;
            }
        }

        if (now_ms() - last_report >= 1000) {
            last_report = now_ms();
            write_report();
        }
    }

    dec_stop(&dec);
    write_report();
    return 0;
}
