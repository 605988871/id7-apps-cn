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

#define MAP_W 1088u
#define MAP_H  480u
#define CARD_W 480u
#define CARD_H 168u

#define MAX_IN   (8u * 1024u * 1024u)   /* bigger than this and the stream is not what we think */
#define READ_SZ  (256u * 1024u)
#define POOL_MAX 32

/* ---------------------------------------------------------------- report -- */

static char g_why[512];          /* the first failure, kept for the report */
static char g_note[256];         /* what is happening now */
static const char *g_mfx_lib = "-";
static const char *g_va_lib = "-";
static int g_mfx_ver = -1;

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

    memcpy(hdr + 0, &magic, 4);
    memcpy(hdr + 4, &len, 4);
    memcpy(hdr + 8, &seq, 4);
    if (o->fd < 0) o->fd = connect_unix(o->path);
    if (o->fd < 0) { o->drops++; return; }
    if (write(o->fd, hdr, sizeof hdr) != (ssize_t)sizeof hdr) { out_shut(o); o->drops++; return; }
    while (done < n) {
        ssize_t k = write(o->fd, p + done, n - done);
        if (k > 0) { done += (size_t)k; continue; }
        if (k < 0 && errno == EINTR) continue;
        /* EAGAIN: the reader is slower than the decoder. Dropping this frame is
         * right - the next one is 60 ms away, and buffering in the decoder
         * would only add latency to a picture that is already late. */
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
    if (!f) return;
    n = fread(buf, 1, sizeof buf - 1, f);
    fclose(f);
    buf[n] = 0;

    c->map_top    = json_num(buf, "mapTop", 0);
    c->map_bottom = json_num(buf, "mapBottom", 0);
    c->map_left   = json_num(buf, "mapLeft", 0);
    c->map_right  = json_num(buf, "mapRight", 0);
    c->map_w      = json_num(buf, "mapW", MAP_W);
    c->map_h      = json_num(buf, "mapH", MAP_H);
    c->card_top    = json_num(buf, "cardTop", 0);
    c->card_bottom = json_num(buf, "cardBottom", 16);
    c->card_left   = json_num(buf, "cardLeft", 0);
    c->card_right  = json_num(buf, "cardRight", 24);
    c->card_w      = json_num(buf, "cardW", CARD_W);
    c->card_h      = json_num(buf, "cardH", CARD_H);
    if (json_str(buf, "cardMode", "navi")[0] == 'o') c->card_off = 1;  /* "off" */
    if (json_str(buf, "mapFit", "fill")[0] == 's') c->map_stretch = 1; /* "stretch" */
    /* The buffers are the layers' sizes and nothing else: a stale or edited
     * file must not be able to make the decoder write past them. */
    if (c->map_w > MAP_W) c->map_w = MAP_W;
    if (c->map_h > MAP_H) c->map_h = MAP_H;
    if (c->card_w > CARD_W) c->card_w = CARD_W;
    if (c->card_h > CARD_H) c->card_h = CARD_H;
    if (c->map_w < 16) c->map_w = MAP_W;
    if (c->map_h < 16) c->map_h = MAP_H;
    if (c->card_w < 16) c->card_w = CARD_W;
    if (c->card_h < 16) c->card_h = CARD_H;
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

    /* Chroma is half resolution in both directions: sample it the same way,
     * two bytes at a time (NV12 keeps U and V interleaved). */
    {
        unsigned half_h = dh / 2, half_w = dw / 2;
        unsigned char *duv = dst + (size_t)dw * dh;
        unsigned rx = r.x / 2, ry = r.y / 2, rw = r.w / 2, rh = r.h / 2;
        for (y = 0; y < half_h; y++) {
            unsigned syy = ry + (unsigned)((unsigned long long)y * rh / half_h);
            const unsigned char *src = suv + (size_t)syy * sxp + (size_t)rx * 2;
            unsigned char *row = duv + (size_t)y * dw;
            if (rw == half_w) {
                memcpy(row, src, (size_t)half_w * 2);
            } else {
                for (x = 0; x < half_w; x++) {
                    unsigned k = (unsigned)((unsigned long long)x * rw / half_w) * 2;
                    row[x * 2] = src[k];
                    row[x * 2 + 1] = src[k + 1];
                }
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
        if (sts < MFX_ERR_NONE) { mfx_why("MFXVideoCORE_SetHandle", sts); return 0; }
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
    d->w = in.CropW;
    d->h = in.CropH;
    if (!d->w || !d->h) { fail("the SPS gives no picture size"); return 0; }

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
    if (sts < MFX_ERR_NONE) { mfx_why("MFXVideoDECODE_QueryIOSurf", sts); return 0; }
    sts = g_api.vpp_query(d->session, &d->vpp, vpp_req);
    if (sts < MFX_ERR_NONE) { mfx_why("MFXVideoVPP_QueryIOSurf", sts); return 0; }

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
    if (sts < MFX_ERR_NONE) { mfx_why("MFXVideoDECODE_Init", sts); return 0; }
    sts = g_api.vpp_init(d->session, &d->vpp);
    if (sts < MFX_ERR_NONE) {
        g_api.dec_close(d->session);
        mfx_why("MFXVideoVPP_Init", sts);
        return 0;
    }

    d->pitch = (out.Width + 63u) & ~63u;
    d->vheight = out.Height;
    bytes = (size_t)d->pitch * d->vheight * 3 / 2;
    d->vmem = aligned_alloc(4096, (bytes + 4095) & ~(size_t)4095);
    if (!d->vmem) { fail("no memory for the VPP output"); return 0; }
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

static void resync(unsigned char *p, size_t *n)
{
    size_t i;
    for (i = 0; i + 3 < *n; i++) {
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
static long long g_last_frame_ms;
static unsigned long g_frames, g_rate, g_rate_at_frames;
static long long g_rate_at_ms;

static void produce(const Dec *d)
{
    Crop c;
    Rect r;
    long long t = now_ms();

    read_crop(&c);

    if (!g_mapbuf) g_mapbuf = malloc((size_t)MAP_W * MAP_H * 3 / 2);
    if (!g_cardbuf) g_cardbuf = malloc((size_t)CARD_W * CARD_H * 3 / 2);
    if (!g_mapbuf || !g_cardbuf) { fail("no memory for the pictures"); return; }

    /* The map: the part of CarLife's picture that is the map, filled out so
     * the cluster's layer is not stretched. */
    r = rect_of(d->w, d->h, c.map_top, c.map_bottom, c.map_left, c.map_right,
                (unsigned)c.map_w, (unsigned)c.map_h, !c.map_stretch);
    blit(g_mapbuf, (unsigned)c.map_w, (unsigned)c.map_h,
         d->vout.Data.Y, d->pitch, d->vout.Data.UV, d->pitch, r);
    out_write(&g_map, g_mapbuf, (size_t)c.map_w * (unsigned)c.map_h * 3 / 2);

    /* The HUD: the guidance strip at the top of the picture, straight across.
     * CarLife draws its arrow, its road name and its lanes there, so cutting
     * rather than redrawing is the only thing that can be honest about them. */
    if (!c.card_off) {
        r = rect_of(d->w, d->h, c.card_top, c.card_bottom, c.card_left, c.card_right,
                    (unsigned)c.card_w, (unsigned)c.card_h, 0);
        blit(g_cardbuf, (unsigned)c.card_w, (unsigned)c.card_h,
             d->vout.Data.Y, d->pitch, d->vout.Data.UV, d->pitch, r);
        out_write(&g_card, g_cardbuf, (size_t)c.card_w * (unsigned)c.card_h * 3 / 2);
    }

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
    time_t t = time(NULL);
    struct tm tm;
    long long age = g_last_frame_ms ? (now_ms() - g_last_frame_ms) : -1;
    int n;

    localtime_r(&t, &tm);
    n = snprintf(buf, sizeof buf,
        "=== CARLIFE DECODE %02d:%02d:%02d pid=%d ===\n"
        "libs: mfx=%s%s va=%s mfxapi=%d\n"
        "state: %s\n"
        "frames: %lu rate %lu fps last %lldms\n"
        "sockets: map=%s(%lu) card=%s(%lu) drops=%lu+%lu\n"
        "error: %s\n",
        tm.tm_hour, tm.tm_min, tm.tm_sec, (int)getpid(),
        g_mfx_lib, g_va_lib[0] == '-' ? " (none)" : "", g_va_lib, g_mfx_ver,
        g_note[0] ? g_note : "starting",
        g_frames, g_rate, age,
        g_map.fd >= 0 ? "on" : "waiting", g_map.frames,
        g_card.fd >= 0 ? "on" : "waiting", g_card.frames,
        g_map.drops, g_card.drops,
        g_why[0] ? g_why : "none");

    {
        int fd = open(REPORT, O_WRONLY | O_CREAT | O_TRUNC, 0644);
        if (fd >= 0) {
            ssize_t k = write(fd, buf, (size_t)n);
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

    if (!load_mfx()) { write_report(); return 1; }
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
                resync(ibuf, &ilen);
                iconsumed = 0;
            } else if (!dec.session && !open_session(&dec)) {
                header_done = 1;       /* the reason is in the report */
            } else {
                mfxBitstream bs;
                memset(&bs, 0, sizeof bs);
                memset(&par, 0, sizeof par);
                bs.Data = ibuf + iconsumed;
                bs.DataLength = (mfxU32)avail;
                bs.MaxLength = (mfxU32)avail;
                sts = g_api.dec_header(dec.session, &bs, &par);
                if (sts == MFX_ERR_MORE_DATA) {
                    if (avail >= MAX_IN / 2) { fail("no sequence header in %u bytes", (unsigned)avail); }
                } else if (sts < MFX_ERR_NONE) {
                    fail("MFXVideoDECODE_DecodeHeader: %d", (int)sts);
                    iconsumed++;           /* step over it and look again */
                } else if (dec_start(&dec, &par)) {
                    header_done = 1;
                    note("decoding %ux%u", dec.w, dec.h);
                } else {
                    header_done = 1;       /* the reason is in the report */
                }
            }
        }

        if (header_done && dec.up) {
            for (;;) {
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
                    if (++stalls > 8) { note("decoder takes no input"); break; }
                } else {
                    stalls = 0;
                }

                if (sts == MFX_WRN_DEVICE_BUSY) { usleep(1000); continue; }
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
                    mfx_why("MFXVideoDECODE_DecodeFrameAsync", sts);
                    break;
                }
                if (!sync) continue;

                sts = g_api.sync(dec.session, sync, MFX_INFINITE);
                if (sts != MFX_ERR_NONE) { mfx_why("MFXVideoCORE_SyncOperation", sts); break; }

                sts = g_api.vpp_run(dec.session, out, &dec.vout, NULL, &sync);
                if (sts == MFX_WRN_DEVICE_BUSY) { usleep(1000); continue; }
                if (sts == MFX_ERR_MORE_DATA) continue;   /* VPP keeps the input */
                if (sts < MFX_ERR_NONE) { mfx_why("MFXVideoVPP_RunFrameVPPAsync", sts); break; }
                if (!sync) continue;
                sts = g_api.sync(dec.session, sync, MFX_INFINITE);
                if (sts != MFX_ERR_NONE) { mfx_why("MFXVideoCORE_SyncOperation (VPP)", sts); break; }

                produce(&dec);
            }

            if (iconsumed) {
                memmove(ibuf, ibuf + iconsumed, ilen - iconsumed);
                ilen -= iconsumed;
                iconsumed = 0;
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
