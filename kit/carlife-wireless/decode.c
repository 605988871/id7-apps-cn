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
#include <gnu/libc-version.h>
#include <poll.h>
#include <signal.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/uio.h>
#include <sys/un.h>
#include <time.h>
#include <unistd.h>

#include "mfx/mfxvideo.h"

/* The folder the sockets and crop.json live in, and the report's own path.
 * Both are runtime state rather than macros because a second app (Turn View)
 * runs the same decoder beside CarLife Map: one binary, `--dir` for the other
 * app's folder, so neither app's tap takes the other's socket. The default is
 * exactly what CarLife Map has always used. */
#define DIR_DEFAULT "/dev/shm/carlife-map"
static char g_in_sock[192]   = DIR_DEFAULT "/h264.sock";
static char g_map_sock[192]  = DIR_DEFAULT "/live.sock";
static char g_card_sock[192] = DIR_DEFAULT "/hud.sock";
static char g_crop_file[192] = DIR_DEFAULT "/crop.json";
static char g_report[192]    = "/dev/shm/carlife-decode.txt";

/* The map layer's size (cluster-render takes a frame only at exactly the
 * layer's vw x vh) and the most a crop.json may ask for. They are separate so
 * that a bigger HUD setting cannot make the decoder hand out a frame the app
 * never asked for: the app clamps, and so does this. */
/* Wireless edition: the picture goes to the central display, not the
 * cluster's 1088x480 video layer, so the full 1920x1080 phone frame must fit.
 * MAP_W/MAP_H stay as the no-config fallback; only the ceiling is raised,
 * and a crop.json selects the full-frame size. */
#define MAP_W 1088u
#define MAP_H  480u
#define MAP_MAX_W 1920u
#define MAP_MAX_H 1080u
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
/* A frame is handed out without waiting on the reader. The picture is already
 * decoded, so blocking here is pure end-to-end latency - and worse: every
 * millisecond this loop stops is a millisecond the tap's sink socket is not
 * being drained, which is how the tap ends up dropping raw H.264 bytes and
 * the decoder paints a garbled picture. A slow reader costs this one frame;
 * the next frame is already on its way and replaces it. */
/* Above this much data with an SPS present but no usable header, the SPS is
 * not going to complete: skip it and look at the next one. A real SPS+PPS is
 * a few hundred bytes; four megabytes of waiting is the wedge this bounds. */
#define HEADER_WAIT_MAX (256u * 1024u)

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

/* What arrived from the tap, and how often a reader attached. A decoder that
 * is listening and a tap that is writing are not the same thing as a picture:
 * "0 frames" with 0 bytes means the two never met, and "0 frames" with 40 MB
 * means they did and the stream is what is wrong. The two need different
 * answers, and nothing on the car's screen could tell them apart before. */
static unsigned long long g_in_bytes;
static unsigned g_connects;
/* When the first byte of the stream arrived and when the first picture came
 * out of it. The gap is MSDK's own start-up (session, VPP, surfaces), and it is
 * the number that explained half a minute of "receiving picture" on the car -
 * the stream was there, the decoder was still building itself. */
static long long g_t_first_byte;
static long long g_t_first_frame;
static long long g_boot_ms = -1;         /* MSDK's own start-up, before any stream */

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

/* The number alone is not a diagnosis. On the car's screen every failure is
 * a black picture, and "-3" and "-17" look equally like a hopeless unit:
 * one means "this MSDK cannot do it", the other "the device fell over". The
 * names come from the same header the constants do, so they cannot drift. */
static const char *mfx_name(mfxStatus sts)
{
    switch ((int)sts) {
    case MFX_ERR_NONE:                     return "ok";
    case MFX_ERR_UNKNOWN:                  return "unknown";
    case MFX_ERR_NULL_PTR:                 return "null pointer";
    case MFX_ERR_UNSUPPORTED:              return "unsupported";
    case MFX_ERR_MEMORY_ALLOC:              return "out of memory";
    case MFX_ERR_NOT_ENOUGH_BUFFER:        return "not enough buffer";
    case MFX_ERR_INVALID_HANDLE:           return "invalid handle";
    case MFX_ERR_LOCK_MEMORY:              return "cannot lock memory";
    case MFX_ERR_NOT_INITIALIZED:          return "not initialised";
    case MFX_ERR_NOT_FOUND:                return "not found";
    case MFX_ERR_MORE_DATA:                return "more data needed";
    case MFX_ERR_MORE_SURFACE:             return "more surfaces needed";
    case MFX_ERR_ABORTED:                  return "aborted";
    case MFX_ERR_DEVICE_LOST:              return "device lost";
    case MFX_ERR_INCOMPATIBLE_VIDEO_PARAM: return "incompatible video params";
    case MFX_ERR_INVALID_VIDEO_PARAM:      return "invalid video params";
    case MFX_ERR_UNDEFINED_BEHAVIOR:       return "undefined behaviour";
    case MFX_ERR_DEVICE_FAILED:            return "device failed";
    case MFX_ERR_MORE_BITSTREAM:           return "more bitstream needed";
    case MFX_ERR_GPU_HANG:                 return "GPU hang";
    case MFX_ERR_REALLOC_SURFACE:          return "surface realloc needed";
    case MFX_WRN_DEVICE_BUSY:              return "device busy";
    case MFX_WRN_VIDEO_PARAM_CHANGED:      return "video params changed";
    case MFX_WRN_PARTIAL_ACCELERATION:     return "partial acceleration";
    default:                               return NULL;
    }
}

static void mfx_why(const char *call, mfxStatus sts)
{
    const char *n = mfx_name(sts);
    if (n) fail("%s: %d (%s)", call, (int)sts, n);
    else fail("%s: %d", call, (int)sts);
}

/* A failure that is recovered from: counted, shown as what is happening, and
 * never mistaken for the reason there is no picture. */
static void soft_why(const char *call, mfxStatus sts)
{
    const char *n = mfx_name(sts);
    g_soft++;
    if (n) note("%s: %d (%s) (#%lu)", call, (int)sts, n, g_soft);
    else note("%s: %d (#%lu)", call, (int)sts, g_soft);
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
    char dir[192];
    const char *slash = strrchr(path, '/');

    /* mkdir's mode is cut down by the umask, and a service's umask is 022: the
     * directory comes out root-owned 0755, and creating a unix socket in a
     * directory needs write permission *on the directory*. The app runs as
     * itself, not as root, so its listen() on live.sock fails with EACCES -
     * which sounds like "the address is in use" and is nothing of the sort.
     * chmod explicitly: whoever starts first creates the directory, and it has
     * to be one the other side can bind in. The folder is taken from the
     * socket's own path, so `--dir` moves it without a second variable. */
    if (slash && (size_t)(slash - path) < sizeof dir) {
        memcpy(dir, path, (size_t)(slash - path));
        dir[slash - path] = 0;
        mkdir(dir, 0777);
        chmod(dir, 0777);
    }
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
     * the payload, frame number - all little endian, then the 4:2:0 picture.
     * Header and payload go in one writev so a frame is either wholly on the
     * socket or not at all: a header with a half payload behind it would pair
     * the wrong bytes on the reader. */
    unsigned char hdr[12];
    uint32_t magic = 0x464d4c43u, len = (uint32_t)n, seq = (uint32_t)++o->seq;
    struct iovec iov[2];
    size_t done = 0, total = sizeof hdr + n;

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

    iov[0].iov_base = hdr;
    iov[0].iov_len = sizeof hdr;
    iov[1].iov_base = (void *)p;
    iov[1].iov_len = n;

    while (done < total) {
        ssize_t k = writev(o->fd, iov, 2);
        if (k > 0) {
            done += (size_t)k;
            if (iov[0].iov_len) {
                if ((size_t)k < iov[0].iov_len) {
                    iov[0].iov_base = (unsigned char *)iov[0].iov_base + k;
                    iov[0].iov_len -= (size_t)k;
                    k = 0;
                } else {
                    k -= (ssize_t)iov[0].iov_len;
                    iov[0].iov_len = 0;
                }
            }
            if (!iov[0].iov_len && k > 0) {
                iov[1].iov_base = (unsigned char *)iov[1].iov_base + k;
                iov[1].iov_len -= (size_t)k;
            }
            continue;
        }
        if (k < 0 && errno == EINTR) continue;
        if (done == 0 && (errno == EAGAIN || errno == EWOULDBLOCK || errno == ENOBUFS)) {
            /* Not one byte of this frame reached the socket: a full buffer is
             * a slow reader, not a dead one. Drop the frame and keep the
             * connection - the next frame replaces it, and the reader never
             * has to rebuild its source over one lost picture. */
            o->drops++;
            return;
        }
        /* A partial frame is on the socket: the reader would pair this
         * header with the wrong bytes, so close and let it resync at the
         * next header. A reader that truly went away lands here too. */
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
    FILE *f = fopen(g_crop_file, "rb");
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

/* Where the first SPS starts, or n when there is none. DecodeHeader needs
 * the bitstream to *begin* at a start code: knowing that an SPS exists
 * somewhere in four megabytes is not enough. The tap joins mid-picture, so
 * the buffer almost always begins with the tail of a slice; handing that
 * whole tail to DecodeHeader gets MFX_ERR_MORE_DATA for ever, and nothing is
 * consumed - the wedge that reads "no sequence header in N bytes" with a
 * socket the tap can no longer write to. Returning the offset lets the caller
 * put the SPS at the front, and gives it something to advance past when MFX
 * wants more. */
static size_t find_sps(const unsigned char *p, size_t n)
{
    size_t i;
    for (i = 0; i + 3 < n; i++)
        if (p[i] == 0 && p[i + 1] == 0 && p[i + 2] == 1 && (p[i + 3] & 0x1f) == 7)
            return i;
    return n;
}

/* --------------------------------------------------------- the app's video -- */
/* Wireless edition: instead of CLMF frames over a unix socket - which the JS app
 * then has to colour in JS and upload, megabytes a frame - the decoder writes
 * straight into the file the GPU renderer reads: /dev/shm/mgu-video-<name>, a
 * 64-byte header and nslot frames of I420, the format mgu-render's op 19 draws.
 *
 * That removes the queue the old path had. A socket between two processes that
 * run at different speeds is a buffer, and a buffer in front of a phone's camera
 * feed is a picture that answers seconds late: every stage kept up "on average"
 * while the picture slid further behind. Here the renderer looks at the header
 * and draws whatever the newest frame is, so the age of a picture can never
 * grow - the frame that arrives is the frame on the glass. */
typedef struct {
    int fd;
    unsigned char *map;
    size_t cap;
    unsigned w, h, nslot, slot;
    uint32_t seq;
    unsigned long frames;
    long long last_try;              /* a failed open is not retried per frame */
    unsigned long copy_sum, copy_n;  /* ms spent writing a picture, since the report window opened */
    unsigned copy_max;
} Vid;

#define VID_HDR   64
#define VID_SLOTS 3                     /* the writer is two frames from the one being read */
#define VID_MAGIC 0x4656474du           /* "MGVF" */

static void vid_close(Vid *v)
{
    if (v->map) munmap(v->map, v->cap);
    if (v->fd >= 0) close(v->fd);
    memset(v, 0, sizeof *v);
    v->fd = -1;
}

/* The file is made to its final size once and then written in place: the
 * renderer may look at it any time and must never read a file that is shorter
 * than its header says (it would keep the last picture instead). */
static int vid_open(Vid *v, const char *path, unsigned w, unsigned h)
{
    uint32_t *hd;
    size_t fsz;
    /* The renderer only draws a slot after this counter moves: a new size must
     * not publish the zero-filled slot as a picture, so the count goes on from
     * where it was and the first frame of the new size is the next one. */
    uint32_t keep = v->seq;

    vid_close(v);
    v->seq = keep;
    v->last_try = now_ms();
    if (w < 16 || h < 16 || (w & 1) || (h & 1) || w > 2048 || h > 2048) {
        soft_why("cannot show this picture size as a video (needs even, 16..2048)", 0);
        return 0;
    }
    v->fd = open(path, O_RDWR | O_CREAT | O_CLOEXEC, 0666);
    if (v->fd < 0) { soft_why("cannot create the video file", errno); return 0; }
    fsz = (size_t)w * h * 3 / 2;
    v->cap = VID_HDR + (size_t)VID_SLOTS * fsz;
    if (ftruncate(v->fd, (off_t)v->cap) != 0) { soft_why("cannot size the video file", errno); vid_close(v); return 0; }
    v->map = mmap(NULL, v->cap, PROT_READ | PROT_WRITE, MAP_SHARED, v->fd, 0);
    if (v->map == MAP_FAILED) { v->map = NULL; soft_why("cannot map the video file", errno); vid_close(v); return 0; }
    /* Header: magic, version, size, no frame yet, BT.601 limited (what a phone's
     * H.264 carries), three slots. */
    hd = (uint32_t *)v->map;
    memset(v->map, 0, VID_HDR);
    hd[0] = VID_MAGIC; hd[1] = 1; hd[2] = w; hd[3] = h;
    hd[4] = keep; hd[5] = 0; hd[6] = VID_SLOTS; hd[7] = 0; hd[8] = 0;
    v->w = w; v->h = h; v->nslot = VID_SLOTS; v->slot = 0;
    note("video %ux%u into %s", w, h, path);
    return 1;
}

/* One picture, whole: the slot after the newest, then the header says which one
 * that is (a reader that comes in between sees the previous frame, never half of
 * this one).
 *
 * The chroma split is NOT blit()'s: blit writes the atlas layout (U in the left
 * half of each chroma row, V in the right half), because that is what the CLMF
 * atlases of the cluster apps contain, while the renderer reads a video slot as
 * plain I420 - the Y plane, then the whole U plane, then the whole V plane
 * (proto.h, struct mgu_video_head). Handing blit's layout to it was 0.8.0's
 * black-and-white picture: every chroma row was a U half next to a V half, so
 * the colours came out as noise and a map looked grey. */
static void vid_copy_i420(unsigned char *dst, unsigned w, unsigned h,
                          const unsigned char *sy, unsigned spitch,
                          const unsigned char *suv)
{
    unsigned cw = w / 2, ch = h / 2, x, y;
    unsigned char *du = dst + (size_t)w * h;
    unsigned char *dv = du + (size_t)cw * ch;

    if (spitch == w) {
        memcpy(dst, sy, (size_t)w * h);
    } else {
        for (y = 0; y < h; y++) memcpy(dst + (size_t)y * w, sy + (size_t)y * spitch, w);
    }
    for (y = 0; y < ch; y++) {
        const unsigned char *s = suv + (size_t)y * spitch;
        unsigned char *ru = du + (size_t)y * cw;
        unsigned char *rv = dv + (size_t)y * cw;
        for (x = 0; x < cw; x++, s += 2) { ru[x] = s[0]; rv[x] = s[1]; }   /* NV12 -> planar */
    }
}

static void vid_put(Vid *v, const Dec *d)
{
    size_t fsz = (size_t)v->w * v->h * 3 / 2;
    unsigned slot = (v->slot + 1) % v->nslot;
    unsigned char *dst = v->map + VID_HDR + (size_t)slot * fsz;
    uint32_t *hd = (uint32_t *)v->map;
    long long t0 = now_ms();

    vid_copy_i420(dst, v->w, v->h, d->vout.Data.Y, d->pitch, d->vout.Data.UV);
    hd[5] = slot;
    hd[4] = ++v->seq;
    v->slot = slot;
    v->frames++;
    /* How long one picture costs here. The queue in front of this program is a
     * 64 KB pipe: if this number plus the decode is more than a phone's frame
     * interval, link blocks on the pipe, the phone's send window closes and the
     * whole session (touch included) answers seconds late - so the report has to
     * carry it. */
    {
        long long dt = now_ms() - t0;
        v->copy_sum += (unsigned long)dt;
        v->copy_n++;
        if (dt > v->copy_max) v->copy_max = (unsigned)dt;
    }
}

/* ---------------------------------------------------------------- frames -- */

static Out g_map = { g_map_sock, -1, 0, 0, 0 };
static Out g_card = { g_card_sock, -1, 0, 0, 0 };
static unsigned char *g_mapbuf, *g_cardbuf;
static size_t g_mapbuf_sz, g_cardbuf_sz;
static long long g_last_frame_ms;
/* The fd the H.264 comes in on (stdin or the accepted socket): FIONREAD on it
 * is how many bytes are still queued in the pipe/socket in front of us - the
 * one number that says whether this program is the slow stage. */
static int g_in_fd = -1;
static unsigned long g_frames, g_rate, g_rate_at_frames;
static unsigned long g_blank;           /* decoded pictures dropped for empty chroma */
static long long g_rate_at_ms;
/* The crop the pictures are being cut with, and the rectangles the last frame
 * came from: the report prints both, because on the car's screen the only way
 * to tell "the settings are not being read" from "they are read and wrong" is
 * to see what the decoder made of them. */
static Crop g_crop;
static Rect g_map_rect, g_card_rect;
static int g_have_rects;
static long long g_crop_read_ms;
/* Wireless edition: the renderer's video file (--video-file). Empty: the old
 * CLMF picture sockets, which the cluster apps still read. */
static const char *g_vid_path;
static Vid g_vid = { .fd = -1 };      /* everything else 0: no file, no frame yet */

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

/* A picture with no chroma is not a picture. When the tap has to cut a chunk
 * short, MSDK sometimes still hands back a surface whose UV plane was never
 * filled - all zeros instead of the neutral 128 - and BT.601 paints that
 * green, which on the glass looks like the decoder broke. The same happens on
 * the first frame after a session restarts. A real frame cannot have an
 * entirely empty chroma plane, so dropping it costs one picture and keeps a
 * green field off the screen; the next intact picture replaces it at once. */
static int picture_ok(const Dec *d)
{
    const unsigned char *uv = d->vout.Data.UV;
    unsigned pitch = d->pitch, w = d->w, h = d->h;
    unsigned gy, gx, live = 0;

    for (gy = 0; gy < 8; gy++) {
        unsigned ry = ((gy * h) / 8) & ~1u;
        for (gx = 0; gx < 16; gx++) {
            unsigned rx = ((gx * w) / 16) & ~1u;
            const unsigned char *s = uv + (size_t)(ry / 2) * pitch + rx;
            /* NV12: U and V interleaved. Anything well away from a blank
             * plane means the VPP really wrote this surface. */
            if (s[0] > 16 || s[1] > 16) live++;
        }
    }
    return live != 0;
}

static void produce(const Dec *d)
{
    Rect r;
    long long t = now_ms();
    unsigned mw, mh, cw, ch;

    if (!picture_ok(d)) {
        g_blank++;
        soft_why("blank picture (no chroma)", 0);
        return;                          /* keep the last good frame on screen */
    }

    /* Wireless edition: the whole picture, at the size the phone sent it, into
     * the renderer's video file. No cutting, no scaling, no socket: the renderer
     * fits it to the screen itself, and 1920x720 down to the app's 1835x688 is
     * one filtered step - while the old path went 1920 -> 1280 here (nearest
     * pixel, which is what made it look soft) and then 1280 -> 1835 there. */
    if (g_vid_path) {
        /* Opening the file is a page-cache and mmap cost that must not be paid
         * per frame when it cannot work (a full /dev/shm, a read-only unit). */
        if (!g_vid.map && g_vid.last_try && t - g_vid.last_try < 1000) return;
        if (!g_vid.map || g_vid.w != d->w || g_vid.h != d->h)
            vid_open(&g_vid, g_vid_path, d->w, d->h);
        if (!g_vid.map) return;          /* the report says why */
        vid_put(&g_vid, d);
        if (!g_t_first_frame) g_t_first_frame = t;
        g_frames++;
        g_last_frame_ms = t;
        if (t - g_rate_at_ms >= 1000) {
            g_rate = (unsigned long)((g_frames - g_rate_at_frames) * 1000 / (t - g_rate_at_ms));
            g_rate_at_frames = g_frames;
            g_rate_at_ms = t;
        }
        return;
    }

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
    if (!g_t_first_frame) g_t_first_frame = t;
    if (t - g_rate_at_ms >= 1000) {
        g_rate = (unsigned long)((g_frames - g_rate_at_frames) * 1000 / (t - g_rate_at_ms));
        g_rate_at_frames = g_frames;
        g_rate_at_ms = t;
    }
}

/* ------------------------------------------------------------- main loop -- */

/* Bytes the stage in front of this one has queued for us (a 64 KB pipe, or the
 * socket's receive buffer). Non-zero on every report means this program cannot
 * keep up: link then blocks writing to the pipe, the phone's send window closes
 * and the whole session - touch included - answers seconds late. */
static long long in_backlog(void)
{
    int n = 0;
    if (g_in_fd >= 0 && ioctl(g_in_fd, FIONREAD, &n) == 0 && n > 0) return n;
    return 0;
}

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
        "video: %s seq=%lu %ux%u frames=%lu copy=%lu/%lums\n"
        "in: %llu bytes, %u connection%s\n"
        "first: session %lldms, byte->frame %lldms\n"
        "queue: %lld KB in front of this program (non-zero: it is the slow stage)\n"
        "out: map %ux%u card %s\n"
        "crop: map t%.0f b%.0f l%.0f r%.0f %s; card t%.0f b%.0f l%.0f r%.0f %s\n"
        "rect: map %u,%u %ux%u; card %u,%u %ux%u\n"
        "errors: %lu blank=%lu\n"
        "error: %s\n",
        tm.tm_hour, tm.tm_min, tm.tm_sec, (int)getpid(),
        g_mfx_lib, g_va_lib[0] == '-' ? " (none)" : "", g_va_lib, g_mfx_ver,
        g_note[0] ? g_note : "starting",
        g_frames, g_rate, age,
        g_map.fd >= 0 ? "on" : "waiting", g_map.frames,
        g_card.fd >= 0 ? "on" : "waiting", g_card.frames,
        g_map.drops, g_card.drops,
        g_vid_path ? g_vid_path : "off", (unsigned long)g_vid.seq, g_vid.w, g_vid.h, g_vid.frames,
        g_vid.copy_n ? g_vid.copy_sum / g_vid.copy_n : 0UL, (unsigned long)g_vid.copy_max,
        g_in_bytes, g_connects, g_connects == 1 ? "" : "s",
        g_boot_ms,
        (g_t_first_byte && g_t_first_frame) ? (g_t_first_frame - g_t_first_byte) : -1LL,
        in_backlog() / 1024,
        (unsigned)g_crop.map_w, (unsigned)g_crop.map_h, card,
        g_crop.map_top, g_crop.map_bottom, g_crop.map_left, g_crop.map_right,
        g_crop.map_stretch ? "stretch" : "fill",
        g_crop.card_top, g_crop.card_bottom, g_crop.card_left, g_crop.card_right,
        g_crop.card_stretch ? "stretch" : "fill",
        g_have_rects ? g_map_rect.x : 0, g_have_rects ? g_map_rect.y : 0,
        g_have_rects ? g_map_rect.w : 0, g_have_rects ? g_map_rect.h : 0,
        g_have_rects ? g_card_rect.x : 0, g_have_rects ? g_card_rect.y : 0,
        g_have_rects ? g_card_rect.w : 0, g_have_rects ? g_card_rect.h : 0,
        g_soft, g_blank,
        g_why[0] ? g_why : "none");

    {
        int fd;
        ssize_t k;
        /* snprintf returns what it would have written, which is more than the
         * buffer when a line does not fit: writing that many bytes would read
         * past it. */
        if (n > (int)sizeof buf - 1) n = (int)sizeof buf - 1;
        if (n < 0) n = 0;
        fd = open(g_report, O_WRONLY | O_CREAT | O_TRUNC, 0644);
        if (fd >= 0) {
            k = write(fd, buf, (size_t)n);
            (void)k;
            close(fd);
        }
    }
    /* the copy numbers are per report window, like the frame rate */
    g_vid.copy_sum = g_vid.copy_n = 0;
    g_vid.copy_max = 0;
}

/* Run the same decoder for another app: its own folder for the sockets and
 * crop.json, and its own report beside them. The folder is made world-writable
 * here as well as in the install hook, because a folder that only root can
 * write is the failure that looks like "the tap is not running": bind fails
 * with EACCES before a single frame is read. */
static void set_dir(const char *d)
{
    char report[192];
    const char *base;

    if (!d || !*d) return;
    mkdir(d, 0777);
    chmod(d, 0777);
    snprintf(g_in_sock, sizeof g_in_sock, "%s/h264.sock", d);
    snprintf(g_map_sock, sizeof g_map_sock, "%s/live.sock", d);
    snprintf(g_card_sock, sizeof g_card_sock, "%s/hud.sock", d);
    snprintf(g_crop_file, sizeof g_crop_file, "%s/crop.json", d);
    base = strrchr(d, '/');
    base = (base && base[1]) ? base + 1 : d;
    snprintf(report, sizeof report, "/dev/shm/%s-decode.txt", base);
    memcpy(g_report, report, sizeof report);
}

int main(int argc, char **argv)
{
    Dec dec;
    static unsigned char *ibuf;
    size_t ilen = 0, iconsumed = 0;
    int lfd = -1, client = -1;
    mfxVideoParam par;
    mfxStatus sts;
    int header_done = 0, restarts = 0, stalls = 0;
    long long last_report = 0;
    /* Wireless edition: read the H.264 stream from stdin (carlife-link writes
     * its raw stream there with --video -) instead of listening on a unix
     * socket. Same decoder, same CLMF output; only the input end changes. */
    int stdin_mode = 0;

    /* One line, then out. The install hook runs this before the unit is
     * started, so that "the program does not run on this unit" is a sentence
     * on the status page instead of systemd's "Failed at step EXEC spawning
     * /var/opt/..." - which names a file that is present, executable and
     * innocent, and leaves the actual reason (the loader the toolchain asked
     * for is not on the unit) invisible. Nothing is opened and nothing is
     * changed: this must be safe to run at any time, including mid-install. */
    if (argc > 1 && strcmp(argv[1], "--selftest") == 0) {
        printf("selftest ok, glibc %s\n", gnu_get_libc_version());
        fflush(stdout);
        return 0;
    }
    /* --probe: can this unit decode at all?
     *
     * install.sh runs it as root straight after unpacking, before anyone is
     * sitting in the car with a phone. It opens the DRI node, brings up the
     * VA display and initialises the MSDK session - the three things that
     * depend on the unit's own libraries and can be tested nowhere else.
     * No picture is decoded, so it needs no stream and takes milliseconds.
     *
     * This is the difference between finding out at install time and finding
     * out after a drive: without it the first sign of a missing MSDK is a
     * black screen and a restart loop, with the reason four files deep. */
    if (argc > 1 && strcmp(argv[1], "--probe") == 0) {
        Dec d;
        int ok;
        memset(&d, 0, sizeof d);
        d.dri = -1;
        if (!load_mfx()) {
            printf("probe: %s\n", g_why[0] ? g_why : "no MSDK library");
            fflush(stdout);
            return 1;
        }
        ok = open_session(&d);
        if (ok) {
            /* display=no still means the session came up: MFXInit can make
             * its own device, and that is a working decoder on this unit. */
            printf("probe: mfx=%s api=%d va=%s display=%s %s\n",
                   g_mfx_lib, g_mfx_ver,
                   g_va_lib[0] == '-' ? "none" : g_va_lib,
                   d.display ? "yes" : "no", g_note);
        } else {
            printf("probe: %s%s%s\n",
                   g_why[0] ? g_why : "the MSDK will not start",
                   g_note[0] ? " / " : "", g_note[0] ? g_note : "");
        }
        dec_stop(&d);
        fflush(stdout);
        return ok ? 0 : 1;
    }
    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--dir") == 0 && i + 1 < argc) set_dir(argv[++i]);
        else if (strcmp(argv[i], "--stdin") == 0) stdin_mode = 1;
        /* Wireless edition: the picture goes to the renderer's video file
         * (/dev/shm/mgu-video-<name>) instead of the CLMF sockets. */
        else if (strcmp(argv[i], "--video-file") == 0 && i + 1 < argc) g_vid_path = argv[++i];
    }

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
    /* MSDK's own start-up - MFXInit, the VA display, the DRI node - is what
     * stands between the phone's first byte and its first picture, and it was
     * tens of seconds of "receiving picture" on the car before this line. It
     * needs no stream, so it happens now, while the unit waits for the phone
     * anyway. dec_start() keeps the session it finds. */
    {
        long long w0 = now_ms();
        open_session(&dec);
        g_boot_ms = now_ms() - w0;
        if (!dec.session) {
            note("decoder session did not come up after %lld ms", now_ms() - w0);
        } else {
            note("decoder ready after %lld ms, waiting for the stream", now_ms() - w0);
        }
    }
    if (stdin_mode) {
        client = STDIN_FILENO;
        g_in_fd = client;
        g_connects = 1;
        note("reading the stream from stdin");
    } else {
        lfd = listen_unix(g_in_sock);
        if (lfd < 0) { fail("cannot listen on %s: %s", g_in_sock, strerror(errno)); write_report(); return 1; }
        note("waiting for the tap");
    }
    ibuf = malloc(MAX_IN);
    if (!ibuf) { fail("no memory for the stream"); write_report(); return 1; }

    for (;;) {
        struct pollfd pfd[2];
        int nfd = 1;

        pfd[0].fd = lfd;
        pfd[0].events = POLLIN;
        pfd[0].revents = 0;
        pfd[1].fd = client;
        pfd[1].events = POLLIN;
        pfd[1].revents = 0;
        if (client >= 0) nfd = 2;

        if (poll(pfd, (nfds_t)nfd, 200) < 0 && errno != EINTR) {
            fail("poll: %s", strerror(errno));
            break;
        }

        if (!stdin_mode && (pfd[0].revents & POLLIN)) {
            int c = accept4(lfd, NULL, NULL, SOCK_NONBLOCK | SOCK_CLOEXEC);
            if (c >= 0) {
                if (client >= 0) close(client);   /* one capture at a time */
                client = c;
                g_in_fd = client;
                g_connects++;
                ilen = iconsumed = 0;
                note("stream connected");
            }
        }

        /* The stream fd (client) is always polled at pfd[1], in both modes:
         * socket mode accepts a connection into it, stdin mode sets it to 0. */
        if (client >= 0 && (pfd[1].revents & (POLLIN | POLLHUP | POLLERR))) {
            /* Always make room before reading. Compaction used to be gated
             * on `iconsumed`: while waiting for a header nothing is consumed,
             * so once the buffer was full no read ever happened again and the
             * tap's socket filled. Dropping from the front is safe here - a
             * header, once missed, is followed by another one. */
            if (ilen + READ_SZ > MAX_IN) {
                size_t drop;
                if (iconsumed) {
                    memmove(ibuf, ibuf + iconsumed, ilen - iconsumed);
                    ilen -= iconsumed;
                    iconsumed = 0;
                }
                if (ilen + READ_SZ > MAX_IN) {
                    drop = ilen + READ_SZ - MAX_IN;
                    if (drop < ilen) {
                        memmove(ibuf, ibuf + drop, ilen - drop);
                        ilen -= drop;
                    }
                }
            }
            if (ilen + READ_SZ <= MAX_IN) {
                ssize_t k = read(client, ibuf + ilen, READ_SZ);
                if (k > 0) {
                    ilen += (size_t)k;
                    g_in_bytes += (unsigned long long)k;
                    if (!g_t_first_byte) g_t_first_byte = now_ms();
                } else if (k == 0 || (errno != EAGAIN && errno != EINTR)) {
                    if (stdin_mode) {
                        /* The pipe from carlife-link closed: it exited or lost
                         * the phone. Exit so the service restarts both ends
                         * together; staying up would leave a decoder with no
                         * stream that can never recover on its own. */
                        note("stream ended, exiting for service restart");
                        dec_stop(&dec);
                        write_report();
                        return 2;
                    }
                    close(client);
                    client = -1;
                    g_in_fd = -1;
                    ilen = iconsumed = 0;
                    header_done = 0;
                    dec_stop(&dec);
                    note("stream went away");
                }
            }
        }

        /* No sequence header yet.
         *
         * The tap joins the stream in the middle of a picture, so the first
         * bytes are the tail of some NAL and nothing can start from them. The
         * temptation is to drop up to the next start code - which is what this
         * did, and it is why the decoder sat at "0 frames" with the socket
         * full: once the buffer is aligned to a start code that is not the
         * sequence header, "the next start code" is the one already at byte 0,
         * so nothing moves, nothing is consumed, the buffer fills to MAX_IN and
         * the reads stop. The sequence header that arrives a moment later is
         * in the buffer and is never looked at again.
         *
         * find_sps() has already searched every byte we hold, so if it says
         * no then nothing here can start a picture: drop it, keep the last
         * three bytes in case a start code is split across the next chunk,
         * and wait for the next one. Progress is what matters, not
         * conservation.
         *
         * If it *does* find one, the SPS must be at the front of the
         * bitstream given to DecodeHeader. Feeding the whole buffer from its
         * mid-picture start makes MFX ask for more data for ever: it consumes
         * nothing, we consume nothing, the socket fills and the tap's drops
         * climb into six figures. Every branch below therefore either
         * consumes bytes or compacts the buffer. */
        if (!header_done && ilen - iconsumed > 4) {
            size_t avail = ilen - iconsumed;
            size_t sps = find_sps(ibuf + iconsumed, avail);
            if (sps == avail) {
                size_t keep = avail > 3 ? 3 : avail;
                memmove(ibuf, ibuf + ilen - keep, keep);
                ilen = keep;
                iconsumed = 0;
            } else {
                /* Put the SPS at byte 0: that is the bitstream MFX expects.
                 * Dropping the bytes before it is also real progress. */
                iconsumed += sps;
                avail -= sps;
                if (!dec.session && !open_session(&dec)) {
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
                        /* The SPS arrived without the PPS that follows it, or
                         * a tap drop cut the pair in half. MFX asks for more,
                         * so give it more - but never on the same bytes: step
                         * past this SPS and try the next one, and keep doing
                         * so until a complete pair arrives. This is a normal
                         * state while joining a stream, not a soft error. */
                        size_t skip = 4;
                        note("waiting for a complete SPS+PPS");
                        while (skip + 3 < avail &&
                               !(ibuf[iconsumed + skip] == 0 &&
                                 ibuf[iconsumed + skip + 1] == 0 &&
                                 ibuf[iconsumed + skip + 2] == 1))
                            skip++;
                        iconsumed += skip < avail ? skip : avail;
                        /* One SPS can only cost so much: beyond that, the
                         * stream is not yielding a header and the reason has
                         * to be visible instead of an endless soft count. */
                        if (avail >= HEADER_WAIT_MAX)
                            note("no usable SPS+PPS in %u bytes", (unsigned)avail);
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
