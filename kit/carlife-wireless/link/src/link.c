/*
 * carlife-link - the head-unit side of Baidu CarLife over Wi-Fi.
 *
 * The car has no wireless CarLife: the unit's own carlife process speaks the
 * protocol over USB AOA only (probe 1.0.1: a usbfs handle in carlife, no TCP
 * port listening). A wired-to-wireless box makes up for it by being a phone to
 * the car over USB and a head unit to the phone over Wi-Fi. This program is the
 * second half of that box, running on the unit itself: it is the head unit to
 * the phone, and nothing has to be plugged in.
 *
 * Who listens where
 * -----------------
 * In Wi-Fi mode the phone is the server and the head unit the client, unlike
 * USB where carlife hosts the sockets. Six channels, six TCP ports on the
 * phone, offset from a 7240 base:
 *
 *     cmd 7240   video 8240   media 9240   tts 9241   vr 9242   touch 9340
 *
 * The 8-byte AOA header ([chan u32][len u32]) exists only over USB; over TCP
 * each channel is a connection of its own, and what travels on it is the inner
 * frame alone:
 *
 *     cmd / touch    [len u16][reserved u16=0][service type u32][protobuf len]
 *     video/audio    [len u32][timestamp u32][service type u32][payload len]
 *
 * Service types carry their direction in bit 15 of the low half: 0x00018001 is
 * head unit -> phone, 0x00010002 is phone -> head unit. The first message on
 * the cmd channel must be the version; a phone that matches answers with
 * 0x00010002, and only then may the video be asked for.
 *
 * What this program is and is not
 * -------------------------------
 * It brings the link up and keeps it honest: it connects the channels, runs the
 * handshake, counts what the phone sends (video bytes and frames, the audio
 * channels, SPS/PPS/IDR) and forwards touch and hard keys back. It does not
 * decode: the picture is H.264 Annex-B and decoding it is the next step, on the
 * unit's own MSDK decoder, not this program's business.
 *
 * Nothing here is guessed from a specification we do not have: the framing, the
 * handshake order and the touch encoding are the ones a working head unit was
 * observed to use, and every unknown is a switch, so a capture on the car can
 * correct it without a rebuild of the whole thing.
 *
 * Build and test
 * --------------
 * The same source builds for the unit (zig, glibc 2.27) and for a laptop, and
 * the laptop build is the point: the phone can be tested against it over a
 * hotspot, with no car in the loop (test/fake_md.py speaks the phone side).
 *
 *   zig cc -O2 -o carlife-link src/link.c                        (Linux/x86-64)
 *   python test/test_link.py                                     (both)
 */
#define _GNU_SOURCE
#include <ctype.h>
#include <errno.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#ifdef _WIN32
#  include <direct.h>
#  include <fcntl.h>
#  include <io.h>
#  include <process.h>
#  include <winsock2.h>
#  include <ws2tcpip.h>
#  include <windows.h>
#  include <iphlpapi.h>
typedef SOCKET sock_t;
typedef int socklen_arg;
#  define NO_SOCK INVALID_SOCKET
#  define sclose closesocket
#  define serr() WSAGetLastError()
#  define SWOULDBLOCK(e) ((e) == WSAEWOULDBLOCK)
#  define MKDIR(p) _mkdir(p)
static int net_init(void)
{
    WSADATA w;
    return WSAStartup(MAKEWORD(2, 2), &w) == 0 ? 0 : -1;
}
static void net_done(void) { WSACleanup(); }
#else
#  include <arpa/inet.h>
#  include <fcntl.h>
#  include <grp.h>
#  include <ifaddrs.h>
#  include <net/if.h>
#  include <netdb.h>
#  include <netinet/in.h>
#  include <netinet/tcp.h>
#  include <sys/select.h>
#  include <sys/socket.h>
#  include <pthread.h>
#  include <sys/stat.h>
#  include <sys/types.h>
#  include <unistd.h>
typedef int sock_t;
typedef socklen_t socklen_arg;
#  define NO_SOCK (-1)
#  define sclose close
#  define serr() errno
/* A non-blocking connect() does not return EWOULDBLOCK on Linux, it returns
 * EINPROGRESS, and the handshake is only finished later by select(). Leaving
 * EINPROGRESS out meant every connect to a phone on Wi-Fi was called a failure
 * the instant it started - "7240 failed (115)" - and never given the 500 ms it
 * had asked for. It went unnoticed because connects to a local test server
 * return 0 immediately, and because Windows (WSAEWOULDBLOCK) is the platform
 * the desktop tests run on. */
#  define SWOULDBLOCK(e) ((e) == EWOULDBLOCK || (e) == EAGAIN || \
                          (e) == EINPROGRESS || (e) == EALREADY)
#  define MKDIR(p) mkdir(p, 0777)
static int net_init(void) { return 0; }
static void net_done(void) {}
#endif

/* ---------- the picture sink ---------- */

/* The picture must never be able to stall the session.  A pipe to a decoder
 * that is slower than the stream blocks as soon as its buffer fills, and the
 * same loop that writes the picture also answers the phone on the control
 * channel - so one slow reader would leave the phone sitting on its launch
 * page, waiting for a head unit that had gone quiet.  The write therefore
 * happens on its own thread, into a bounded backlog: when nobody keeps up,
 * pictures are dropped and the session carries on. */

/* Small on purpose: this backlog IS the picture's latency. 6 MB of 1920x720
 * screen content is six to ten seconds, and on a unit whose decoder is even
 * slightly slower than the phone the backlog never drains - it just sits full,
 * so every gesture showed up seconds late while the picture itself looked
 * fine. One megabyte is under a second at the bit rates CarLife sends. */
#define SINK_BACKLOG (1u << 20)

/* Dropping a picture mid-GOP leaves the decoder without its reference and the
 * screen smears until the phone sends another IDR. So when the backlog is over
 * the limit, skip whole pictures until one carries an IDR and resume from
 * there. A stream that gives no IDR for this long is not worth waiting for:
 * write anyway rather than freeze the picture. */
#define SINK_IDR_WAIT_MS 800

typedef struct sink_frame {
    struct sink_frame *next;
    size_t n;
    uint8_t data[1];
} sink_frame;

typedef struct {
    FILE *f;
    int threaded;
    sink_frame *head, *tail;
    size_t backlog;
    unsigned long dropped;
    /* Skipping to catch up: pictures thrown away waiting for an IDR, and when
     * that wait began, so a stream without keyframes cannot stall the picture
     * for ever. */
    unsigned long skipped;
    int want_idr;
    double t_want;
    volatile int stopping, finished;
#ifdef _WIN32
    HANDLE thread;
    CRITICAL_SECTION mu;
#else
    pthread_t thread;
    pthread_mutex_t mu;
#endif
} sink_t;

static void sink_lock(sink_t *s)
{
#ifdef _WIN32
    EnterCriticalSection(&s->mu);
#else
    (void)pthread_mutex_lock(&s->mu);
#endif
}

static void sink_unlock(sink_t *s)
{
#ifdef _WIN32
    LeaveCriticalSection(&s->mu);
#else
    (void)pthread_mutex_unlock(&s->mu);
#endif
}

static void sink_sleep(void)
{
#ifdef _WIN32
    Sleep(1);
#else
    struct timespec ts;
    ts.tv_sec = 0;
    ts.tv_nsec = 1000000;
    nanosleep(&ts, NULL);
#endif
}

#ifdef _WIN32
static unsigned __stdcall sink_run(void *arg)
#else
static void *sink_run(void *arg)
#endif
{
    sink_t *s = (sink_t *)arg;
    for (;;) {
        sink_frame *fr;
        int stop;
        sink_lock(s);
        fr = s->head;
        if (fr) {
            s->head = fr->next;
            if (!s->head) s->tail = NULL;
            s->backlog -= fr->n;
        }
        stop = s->stopping && !fr;
        sink_unlock(s);
        if (stop) break;
        if (!fr) { sink_sleep(); continue; }
        if (fr->n) (void)!fwrite(fr->data, 1, fr->n, s->f);
        /* A pipe is fully buffered: without this the last few kilobytes of
         * every frame sit in this process until the NEXT frame pushes them
         * out, which is a whole frame of latency bought for nothing. The
         * decoder downstream is waiting on exactly these bytes. */
        fflush(s->f);
        free(fr);
    }
    fflush(s->f);
    s->finished = 1;
    return 0;
}

/* `threaded` for a pipe, where the reader's speed is out of our hands; a plain
 * file is written straight through, because dropping frames there would leave
 * a corrupt capture on disk. */
static int sink_open(sink_t *s, FILE *f, int threaded)
{
    memset(s, 0, sizeof *s);
    s->f = f;
    s->threaded = threaded;
#ifdef _WIN32
    InitializeCriticalSection(&s->mu);
#else
    (void)pthread_mutex_init(&s->mu, NULL);
#endif
    if (!threaded) return 0;
#ifdef _WIN32
    s->thread = (HANDLE)_beginthreadex(NULL, 0, sink_run, s, 0, NULL);
    if (!s->thread) return -1;
    CloseHandle(s->thread);            /* detached: it ends when told to */
#else
    if (pthread_create(&s->thread, NULL, sink_run, s) != 0) return -1;
    (void)pthread_detach(s->thread);
#endif
    return 0;
}

static void sink_put(sink_t *s, const uint8_t *p, size_t n)
{
    sink_frame *fr;
    if (!s->f) return;
    if (!s->threaded) { (void)!fwrite(p, 1, n, s->f); return; }
    if (n > SINK_BACKLOG) { s->dropped++; return; }
    sink_lock(s);
    if (s->backlog + n > SINK_BACKLOG) {
        s->dropped++;
        sink_unlock(s);
        return;
    }
    fr = (sink_frame *)malloc(sizeof *fr + n);
    if (!fr) {
        s->dropped++;
        sink_unlock(s);
        return;
    }
    memcpy(fr->data, p, n);
    fr->n = n;
    fr->next = NULL;
    if (s->tail) s->tail->next = fr; else s->head = fr;
    s->tail = fr;
    s->backlog += n;
    sink_unlock(s);
}

/* Throw away the oldest queued pictures until at most keep bytes remain.
 * Used when the decoder has fallen so far behind that even a waiting IDR
 * cannot help: writing more into a full backlog only grows the latency. */
static void sink_trim(sink_t *s, size_t keep)
{
    sink_frame *fr;
    sink_lock(s);
    while (s->head && s->backlog > keep) {
        fr = s->head;
        s->head = fr->next;
        if (!s->head) s->tail = NULL;
        s->backlog -= fr->n;
        s->dropped++;
        free(fr);
    }
    sink_unlock(s);
}

static void sink_close(sink_t *s)
{
    int waited;
    if (!s->f) return;
    if (s->threaded) {
        s->stopping = 1;
        for (waited = 0; waited < 2000 && !s->finished; waited++) sink_sleep();
    }
    if (s->f == stdout) fflush(s->f);
    else fclose(s->f);
    s->f = NULL;
}

/* ---------- channels and message types ---------- */

enum { CH_CMD, CH_VIDEO, CH_MEDIA, CH_TTS, CH_VR, CH_TOUCH, NCH };
static const char *CH_NAME[NCH] = { "cmd", "video", "media", "tts", "vr", "touch" };
static const int CH_OFFSET[NCH] = { 0, 1000, 2000, 2001, 2002, 2100 };

#define MSG_HU_VERSION      0x00018001u
#define MSG_MATCH_STATUS    0x00010002u
#define MSG_HU_INFO         0x00018003u
#define MSG_MD_INFO         0x00010004u
#define MSG_VIDEO_INIT      0x00018007u
#define MSG_VIDEO_INIT_DONE 0x00010008u
#define MSG_VIDEO_START     0x00018009u
#define MSG_MD_FOREGROUND   0x0001001Bu
#define MSG_STATISTIC       0x00018027u
#define MSG_MD_AUTHEN       0x0001004Bu
#define MSG_VIDEO_DATA      0x00020001u
#define MSG_VIDEO_BEAT      0x00020002u
#define MSG_TOUCH_ACTION    0x00068001u
#define MSG_TOUCH_HARD_KEY  0x00068008u

#define VIDEO_MAX_FRAME (4u << 20)

/* ---------- small helpers ---------- */

static double now_ms(void)
{
#ifdef _WIN32
    LARGE_INTEGER f, c;
    QueryPerformanceFrequency(&f);
    QueryPerformanceCounter(&c);
    return (double)c.QuadPart * 1000.0 / (double)f.QuadPart;
#else
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (double)ts.tv_sec * 1000.0 + (double)ts.tv_nsec / 1e6;
#endif
}

static void stamp(char *out, size_t n)
{
    time_t t = time(NULL);
    struct tm tm;
#ifdef _WIN32
    localtime_s(&tm, &t);
#else
    localtime_r(&t, &tm);
#endif
    snprintf(out, n, "%02d:%02d:%02d", tm.tm_hour, tm.tm_min, tm.tm_sec);
}

static unsigned be16_get(const uint8_t *p) { return ((unsigned)p[0] << 8) | p[1]; }
static uint32_t be32_get(const uint8_t *p)
{
    return ((uint32_t)p[0] << 24) | ((uint32_t)p[1] << 16) | ((uint32_t)p[2] << 8) | p[3];
}
static void be16_put(uint8_t *p, unsigned v) { p[0] = (uint8_t)(v >> 8); p[1] = (uint8_t)v; }
static void be32_put(uint8_t *p, uint32_t v)
{
    p[0] = (uint8_t)(v >> 24); p[1] = (uint8_t)(v >> 16); p[2] = (uint8_t)(v >> 8); p[3] = (uint8_t)v;
}

static void set_nonblock(sock_t s)
{
#ifdef _WIN32
    u_long mode = 1;
    ioctlsocket(s, FIONBIO, &mode);
#else
    int fl = fcntl(s, F_GETFL, 0);
    if (fl >= 0) fcntl(s, F_SETFL, fl | O_NONBLOCK);
#endif
}

static int send_all(sock_t s, const void *data, size_t n, int timeout_ms)
{
    const uint8_t *p = (const uint8_t *)data;
    double deadline = now_ms() + timeout_ms;
    while (n) {
        int sent = (int)send(s, (const char *)p, (int)n, 0);
        if (sent > 0) { p += sent; n -= (size_t)sent; continue; }
        int e = serr();
        if (!SWOULDBLOCK(e)) return -1;
        double left = deadline - now_ms();
        if (left <= 0) return -1;
        fd_set wr;
        FD_ZERO(&wr);
        FD_SET(s, &wr);
        struct timeval tv;
        tv.tv_sec = (long)(left / 1000);
        tv.tv_usec = (long)((left - (double)tv.tv_sec * 1000.0) * 1000.0);
        if (select((int)(s + 1), NULL, &wr, NULL, &tv) <= 0) return -1;
    }
    return 0;
}

static sock_t tcp_connect(const char *host, int port, int timeout_ms, char *err, size_t errlen)
{
    char service[16];
    struct addrinfo hints, *res = NULL, *ai;
    snprintf(service, sizeof service, "%d", port);
    memset(&hints, 0, sizeof hints);
    hints.ai_family = AF_UNSPEC;
    hints.ai_socktype = SOCK_STREAM;
    if (getaddrinfo(host, service, &hints, &res) != 0) {
        snprintf(err, errlen, "cannot resolve %s", host);
        return NO_SOCK;
    }
    for (ai = res; ai; ai = ai->ai_next) {
        sock_t s = socket(ai->ai_family, ai->ai_socktype, ai->ai_protocol);
        if (s == NO_SOCK) continue;
        set_nonblock(s);
        if (connect(s, ai->ai_addr, (socklen_arg)ai->ai_addrlen) != 0) {
            int e = serr();
            int ok = 0;
            if (SWOULDBLOCK(e)) {
                fd_set wr;
                FD_ZERO(&wr);
                FD_SET(s, &wr);
                struct timeval tv;
                tv.tv_sec = timeout_ms / 1000;
                tv.tv_usec = (timeout_ms % 1000) * 1000;
                if (select((int)(s + 1), NULL, &wr, NULL, &tv) > 0) {
                    int so = 0;
                    socklen_arg sl = (socklen_arg)sizeof so;
                    if (getsockopt(s, SOL_SOCKET, SO_ERROR, (char *)&so, &sl) == 0 && so == 0) ok = 1;
                    else snprintf(err, errlen, "%s:%d refused (%d)", host, port, so);
                } else {
                    snprintf(err, errlen, "%s:%d timed out", host, port);
                }
            } else {
                snprintf(err, errlen, "%s:%d failed (%d)", host, port, e);
            }
            if (!ok) { sclose(s); continue; }
        }
        {
            int one = 1;
            setsockopt(s, IPPROTO_TCP, TCP_NODELAY, (const char *)&one, sizeof one);
        }
        freeaddrinfo(res);
        return s;
    }
    freeaddrinfo(res);
    if (!err[0]) snprintf(err, errlen, "%s:%d unreachable", host, port);
    return NO_SOCK;
}

/* ---------- finding the phone ----------
 * Nothing tells the head unit the phone's address: on the car's hotspot it is
 * whatever DHCP handed out. So the port that only a CarLife phone answers is
 * the beacon: one non-blocking connect per neighbour on the local /24, a batch
 * at a time, and the first one that opens the cmd channel is the phone. */

#define DISC_BATCH 48
#define DISC_TIMEOUT_MS 400

/* How many failed dials to a hinted address before looking for the phone on
 * the network we are on now. At the 3 s retry interval this is about twelve
 * seconds: long enough that a phone in Wi-Fi power save is not declared
 * missing. Joining another hotspot is caught earlier and exactly by the
 * address watch in the main loop (a few hundred ms after DHCP), so this is
 * only the fallback for a hint that is still on our subnet but wrong.
 * (Measured on the unit: the old 20 rounds read as "the address takes a
 * minute to switch".) */
#define HINT_ROUNDS 4

/* How long a live session may go without a single byte from the phone before
 * it is thrown away and dialled again.
 *
 * Measured on the unit: the phone can leave a session half-built - all six
 * channels accept, the version matches, the encoder even reports "init done",
 * and then not one frame arrives. Nothing closes, so nothing in the read path
 * notices; the screen sat on "waiting for picture" with frames=0 for three and
 * a half minutes until the phone itself dropped the video socket. Tearing the
 * sockets down and reconnecting fixed it instantly (the phone starts a fresh
 * session for a fresh connection).
 *
 * Ten seconds: long enough for the handshake plus the encoder's first frame on
 * a loaded Atom (usual time to first frame is under two), short enough that a
 * driver is not left looking at a dead screen. */
#define WATCHDOG_MS 10000.0

#ifndef _WIN32
/* Virtual interfaces are never the phone's network, and every one of them
 * would cost a /24 sweep of its own: the unit runs dockerd, and a laptop's
 * VPN and VM bridges look the same. Filtering them by name is crude but it is
 * the one thing that works without a netlink library on either side. */
static int virt_if(const char *name)
{
    static const char *const bad[] = { "lo", "docker", "tun", "tap", "veth",
                                       "br-", "virbr", "vnet", "dummy", "sit", "wg" };
    size_t i;
    if (!name) return 1;
    for (i = 0; i < sizeof bad / sizeof bad[0]; i++)
        if (!strncmp(name, bad[i], strlen(bad[i]))) return 1;
    return 0;
}
#endif

static int local_ipv4(uint32_t *out, int max)
{
    int n = 0;
#ifdef _WIN32
    /* getaddrinfo(hostname) answers with a single address, and on a laptop that
     * is often a virtual adapter rather than the Wi-Fi one the phone is on:
     * enumerate the adapters instead, default-gateway ones first, because the
     * phone always sits behind the default route. */
    IP_ADAPTER_ADDRESSES *aa = NULL;
    ULONG size = 16 * 1024, rc = ERROR_BUFFER_OVERFLOW;
    int tries, pass;
    for (tries = 0; tries < 3; tries++) {
        aa = (IP_ADAPTER_ADDRESSES *)malloc(size);
        if (!aa) return 0;
        rc = GetAdaptersAddresses(AF_INET,
                                  GAA_FLAG_SKIP_ANYCAST | GAA_FLAG_SKIP_MULTICAST |
                                      GAA_FLAG_SKIP_DNS_SERVER,
                                  NULL, aa, &size);
        if (rc == NO_ERROR) break;
        free(aa);
        aa = NULL;
        if (rc != ERROR_BUFFER_OVERFLOW) return 0;
    }
    if (!aa) return 0;
    for (pass = 0; pass < 2 && n < max; pass++) {
        IP_ADAPTER_ADDRESSES *a;
        for (a = aa; a && n < max; a = a->Next) {
            IP_ADAPTER_UNICAST_ADDRESS *ua;
            int has_gw = a->FirstGatewayAddress != NULL;
            if (a->OperStatus != IfOperStatusUp) continue;
            if (a->IfType == IF_TYPE_SOFTWARE_LOOPBACK) continue;
            if ((has_gw ? 0 : 1) != pass) continue;
            for (ua = a->FirstUnicastAddress; ua && n < max; ua = ua->Next) {
                struct sockaddr_in *sa;
                uint32_t ip;
                if (!ua->Address.lpSockaddr || ua->Address.lpSockaddr->sa_family != AF_INET)
                    continue;
                sa = (struct sockaddr_in *)ua->Address.lpSockaddr;
                ip = ntohl(sa->sin_addr.s_addr);
                if (ip == 0 || (ip >> 24) == 127 || (ip >> 24) == 169) continue;
                out[n++] = ip;
            }
        }
    }
    free(aa);
#else
    struct ifaddrs *ifs = NULL, *p;
    char gw_if[IFNAMSIZ + 1] = "";
    int pass;
    if (getifaddrs(&ifs) != 0) return 0;
    /* The unit's hotspot has no default route - it *is* the gateway - so this
     * only orders the sweep: when it does have one, that subnet is the one the
     * phone is on and it gets swept first. */
    {
        FILE *rt = fopen("/proc/net/route", "r");
        if (rt) {
            char line[256];
            if (fgets(line, (int)sizeof line, rt))       /* the column header */
                while (fgets(line, (int)sizeof line, rt)) {
                    char name[IFNAMSIZ + 1];
                    unsigned long dest = 1, mask = 1;
                    if (sscanf(line, "%16s %lx %*s %*s %*s %*s %*s %lx",
                               name, &dest, &mask) == 3 && dest == 0 && mask == 0) {
                        snprintf(gw_if, sizeof gw_if, "%s", name);
                        break;
                    }
                }
            fclose(rt);
        }
    }
    for (pass = 0; pass < 2 && n < max; pass++) {
        for (p = ifs; p && n < max; p = p->ifa_next) {
            uint32_t ip;
            int want;
            if (!p->ifa_addr || p->ifa_addr->sa_family != AF_INET) continue;
            if (virt_if(p->ifa_name)) continue;
            want = (gw_if[0] && !strcmp(p->ifa_name, gw_if)) ? 0 : 1;
            if (want != pass) continue;
            ip = ntohl(((struct sockaddr_in *)p->ifa_addr)->sin_addr.s_addr);
            if (ip == 0 || (ip >> 24) == 127 || (ip >> 24) == 169) continue;
            out[n++] = ip;
        }
    }
    freeifaddrs(ifs);
#endif
    return n;
}

static sock_t tcp_start_v4(uint32_t ip, int port)
{
    struct sockaddr_in sa;
    sock_t s = socket(AF_INET, SOCK_STREAM, 0);
    if (s == NO_SOCK) return NO_SOCK;
    set_nonblock(s);
    memset(&sa, 0, sizeof sa);
    sa.sin_family = AF_INET;
    sa.sin_port = htons((unsigned short)port);
    sa.sin_addr.s_addr = htonl(ip);
    if (connect(s, (struct sockaddr *)&sa, (socklen_arg)sizeof sa) != 0) {
        int e = serr();
        if (!SWOULDBLOCK(e)) { sclose(s); return NO_SOCK; }
    }
    return s;
}

/* Fills `host` with the first neighbour that answers on the cmd port, and
 * `swept` with the /24s it looked at, space separated. */
static int discover(int port, char *host, size_t hostlen, char *swept, size_t sweptlen)
{
    uint32_t self[8];
    int nself = local_ipv4(self, 8), i, j;
    if (swept && sweptlen) swept[0] = '\0';
    /* Every adapter, not the first three: local_ipv4 puts default-gateway ones
     * first, and a phone is always reachable through the default route. The
     * APIPA subnets are skipped, and so is any /24 already swept, so a laptop
     * full of virtual adapters does not pay twice for the same subnet. */
    for (i = 0; i < nself; i++) {
        uint32_t net = self[i] & 0xffffff00u;
        unsigned long long batch;
        int seen = 0;
        if ((net >> 24) == 169) continue;              /* APIPA: not a hotspot */
        for (j = 0; j < i; j++)
            if ((self[j] & 0xffffff00u) == net) seen = 1;
        if (seen) continue;
        if (swept && sweptlen) {
            size_t used = strlen(swept);
            if (used + 1 < sweptlen)
                snprintf(swept + used, sweptlen - used, "%s%u.%u.%u.0/24", used ? " " : "",
                         (net >> 24) & 0xffu, (net >> 16) & 0xffu, (net >> 8) & 0xffu);
        }
        for (batch = 1; batch <= 254; batch += DISC_BATCH) {
            sock_t fds[DISC_BATCH];
            uint32_t ips[DISC_BATCH];
            int cnt = 0, k, open_at = -1, maxfd = 0;
            fd_set wr;
            struct timeval tv;
            for (k = 0; k < DISC_BATCH && batch + (unsigned long long)k <= 254; k++) {
                uint32_t ip = net | (uint32_t)(batch + (unsigned long long)k);
                if (ip == self[i]) continue;
                fds[cnt] = tcp_start_v4(ip, port);
                if (fds[cnt] == NO_SOCK) continue;
                ips[cnt++] = ip;
            }
            if (!cnt) continue;
            FD_ZERO(&wr);
            for (k = 0; k < cnt; k++) {
                FD_SET(fds[k], &wr);
                if ((int)fds[k] > maxfd) maxfd = (int)fds[k];
            }
            tv.tv_sec = 0;
            tv.tv_usec = DISC_TIMEOUT_MS * 1000;
            select(maxfd + 1, NULL, &wr, NULL, &tv);
            for (k = 0; k < cnt; k++) {
                int so = 0;
                socklen_arg sl = (socklen_arg)sizeof so;
                if (!FD_ISSET(fds[k], &wr)) continue;
                if (getsockopt(fds[k], SOL_SOCKET, SO_ERROR, (char *)&so, &sl) == 0 && so == 0) {
                    open_at = k;
                    break;
                }
            }
            for (j = 0; j < cnt; j++) sclose(fds[j]);
            if (open_at >= 0) {
                snprintf(host, hostlen, "%u.%u.%u.%u", (ips[open_at] >> 24) & 0xff,
                         (ips[open_at] >> 16) & 0xff, (ips[open_at] >> 8) & 0xff, ips[open_at] & 0xff);
                return 0;
            }
        }
    }
    return -1;
}

/* ---------- did the network underneath us change? ----------
 * Joining another hotspot never restarts this process: run.sh already picked
 * an address, the app already shows it, and the old TCP sessions just stop
 * carrying frames. The only early signal available without a DHCP client, a
 * netlink socket or root is the head unit's own interface table - wlan0 is
 * renumbered within a second of associating, long before any dial times out.
 * Watching that is what turns "the address takes a minute to switch" into
 * "the address switches before the picture even stops". */

/* The /24 a dotted quad sits on; 0 means "not an address I can reason about"
 * (a hostname override), which keeps every caller behaving as before. */
static uint32_t host_net(const char *h)
{
    unsigned a, b, c, d;
    char tail;
    if (!h || sscanf(h, "%u.%u.%u.%u%c", &a, &b, &c, &d, &tail) != 4) return 0;
    if (a > 255 || b > 255 || c > 255 || d > 255) return 0;
    return ((uint32_t)a << 24) | ((uint32_t)b << 16) | ((uint32_t)c << 8);
}

/* Is `net` one of the /24s this machine is on right now? No opinion (0) or no
 * local address yet counts as yes: the caller then waits for dial failures
 * exactly as it did before, instead of sweeping a network we are not on. */
static int on_any_net(uint32_t net, const uint32_t *self, int nself)
{
    int i;
    if (!net || nself <= 0) return 1;
    for (i = 0; i < nself; i++)
        if ((self[i] & 0xffffff00u) == net) return 1;
    return 0;
}

/* Same set of addresses. Order is not a promise: getifaddrs() hands them out
 * in whatever order the kernel's lists happen to be in. */
static int net_same(const uint32_t *a, int na, const uint32_t *b, int nb)
{
    int i, j, hit;
    if (na != nb) return 0;
    for (i = 0; i < na; i++) {
        hit = 0;
        for (j = 0; j < nb; j++)
            if (a[i] == b[j]) hit = 1;
        if (!hit) return 0;
    }
    return 1;
}

static void fmt_addrs(const uint32_t *ips, int n, char *out, size_t cap)
{
    size_t used = 0;
    int i;
    if (!cap) return;
    out[0] = '\0';
    for (i = 0; i < n && used + 1 < cap; i++) {
        int w = snprintf(out + used, cap - used, "%s%u.%u.%u.%u", used ? " " : "",
                         (ips[i] >> 24) & 0xff, (ips[i] >> 16) & 0xff,
                         (ips[i] >> 8) & 0xff, ips[i] & 0xff);
        if (w <= 0 || (size_t)w >= cap - used) break;
        used += (size_t)w;
    }
}

/* ---------- protobuf, written by hand: a dozen fields, no library ---------- */

static size_t pb_varint(uint8_t *o, size_t cap, uint64_t v)
{
    size_t n = 0;
    do {
        if (n >= cap) return 0;
        uint8_t b = (uint8_t)(v & 0x7f);
        v >>= 7;
        o[n++] = (uint8_t)(b | (v ? 0x80 : 0));
    } while (v);
    return n;
}

static size_t pb_uint(uint8_t *o, size_t cap, unsigned field, uint64_t v)
{
    size_t n = pb_varint(o, cap, ((uint64_t)field << 3) | 0);
    if (!n) return 0;
    size_t m = pb_varint(o + n, cap - n, v);
    return m ? n + m : 0;
}

static size_t pb_string(uint8_t *o, size_t cap, unsigned field, const char *s)
{
    size_t len = strlen(s), n = 0;
    n += pb_varint(o + n, cap - n, ((uint64_t)field << 3) | 2);
    if (!n) return 0;
    size_t m = pb_varint(o + n, cap - n, len);
    if (!m) return 0;
    n += m;
    if (n + len > cap) return 0;
    memcpy(o + n, s, len);
    return n + len;
}

/* First varint of `field` in a message, 0 when absent or unreadable. */
static int pb_get_uint(const uint8_t *p, size_t n, unsigned want, uint64_t *out)
{
    size_t i = 0;
    while (i < n) {
        uint64_t key = 0;
        int shift = 0;
        uint8_t c;
        do {
            if (i >= n || shift > 63) return 0;
            c = p[i++];
            key |= (uint64_t)(c & 0x7f) << shift;
            shift += 7;
        } while (c & 0x80);
        unsigned field = (unsigned)(key >> 3), wire = (unsigned)(key & 7);
        if (wire == 0) {
            uint64_t v = 0;
            shift = 0;
            do {
                if (i >= n || shift > 63) return 0;
                c = p[i++];
                v |= (uint64_t)(c & 0x7f) << shift;
                shift += 7;
            } while (c & 0x80);
            if (field == want) { *out = v; return 1; }
        } else if (wire == 2) {
            uint64_t len = 0;
            int ls = 0;
            do {
                if (i >= n || ls > 63) return 0;
                c = p[i++];
                len |= (uint64_t)(c & 0x7f) << ls;
                ls += 7;
            } while (c & 0x80);
            if (len > n - i) return 0;
            i += (size_t)len;
        } else if (wire == 1) {
            if (n - i < 8) return 0;
            i += 8;
        } else if (wire == 5) {
            if (n - i < 4) return 0;
            i += 4;
        } else {
            return 0;
        }
    }
    return 0;
}

/* ---------- the link ---------- */

typedef struct {
    const char *name;
    int offset;
    sock_t fd;
    int open;
    uint8_t *buf;
    size_t cap, len;
    unsigned long long bytes;
} chan_t;

typedef struct {
    char host[80];
    int base_port;
    chan_t ch[NCH];

    sock_t ctl_listen, ctl_client;
    int ctl_port;
    char line[256];
    size_t linelen;

    sink_t sink;
    char video_path[260];
    char report_path[260];
    char state[40];
    char error[200];
    /* the /24s the last look for the phone swept: when a driver reports "no
     * phone", this is the one line that says whether it looked in the right
     * place at all */
    char scan[200];

    int req_w, req_h, req_fps;
    int got_w, got_h, got_fps;
    int major, send_hu_info, verbose, find_mode;
    int matched, init_done, started;

    unsigned long cmd_rx, cmd_tx;
    unsigned long vid_frames, vid_keepalive, touch_sent, touch_drop;
    unsigned long long vid_bytes;
    unsigned long long audio_bytes;
    int saw_sps, saw_pps, saw_idr;

    double t0, t_last_video, t_reported, t_retry;
    int retry_idx;   /* which critical channel the next reopen pass starts at */
    double t_keepalive;  /* when the last periodic cmd message went out */
    int fail_rounds;     /* consecutive dials that reached no cmd channel */

    /* The phone last proving the session alive: a cmd message or a frame.
     * A session that matches and then goes silent is not healthy even though
     * every socket says "open" - see the watchdog in the main loop. */
    double t_progress;
    int resets;
    char reset_reason[80];

    /* The head unit's own IPv4 addresses, and when they were last read. A
     * change here means the car joined a different network, which is the one
     * event that must not wait for a dial to time out. */
    uint32_t self[8];
    int nself;
    double t_net;
    char netlist[96];    /* self, as text, for the report */
} link_t;

static link_t L;

static void fail(link_t *l, const char *fmt, const char *arg)
{
    snprintf(l->error, sizeof l->error, fmt, arg ? arg : "");
}

static void logline(link_t *l, const char *fmt, ...)
{
    (void)l;
    va_list ap;
    char ts[16];
    stamp(ts, sizeof ts);
    fprintf(stderr, "%s ", ts);
    va_start(ap, fmt);
    vfprintf(stderr, fmt, ap);
    va_end(ap);
    fputc('\n', stderr);
    fflush(stderr);
}

static void chan_close(chan_t *c)
{
    if (c->fd != NO_SOCK) sclose(c->fd);
    c->fd = NO_SOCK;
    c->open = 0;
    c->len = 0;
}

static void link_close(link_t *l)
{
    int i;
    for (i = 0; i < NCH; i++) chan_close(&l->ch[i]);
    if (l->ctl_client != NO_SOCK) sclose(l->ctl_client);
    l->ctl_client = NO_SOCK;
}

/* Every session channel is dropped, the app's control socket is not: a tap
 * must keep working across a hotspot change. Used when the network changed -
 * those sockets belong to the old one, and a half-dead socket that never sees
 * a RST would otherwise keep reporting "open" while no frame arrives.
 * The handshake bookkeeping is reset with them, because the phone starts a
 * fresh encoder for every session anyway. */
static void channels_reset(link_t *l)
{
    int i;
    for (i = 0; i < NCH; i++) chan_close(&l->ch[i]);
    l->matched = l->init_done = l->started = 0;
    l->got_w = l->got_h = l->got_fps = 0;
    l->saw_sps = l->saw_pps = l->saw_idr = 0;
}

static void send_frame(link_t *l, int ci, uint32_t type, const uint8_t *body, size_t n)
{
    uint8_t hdr[8];
    chan_t *c = &l->ch[ci];
    if (!c->open) return;
    be16_put(hdr, (unsigned)n);
    be16_put(hdr + 2, 0);
    be32_put(hdr + 4, type);
    if (send_all(c->fd, hdr, 8, 500) != 0 || (n && send_all(c->fd, body, n, 500) != 0)) {
        fail(l, "send on %s channel failed", c->name);
        chan_close(c);
        return;
    }
    c->bytes += 8 + n;
    if (ci == CH_CMD) l->cmd_tx++;
}

static void send_version(link_t *l)
{
    uint8_t body[16];
    size_t n = 0;
    n += pb_uint(body + n, sizeof body - n, 1, (uint64_t)l->major);
    n += pb_uint(body + n, sizeof body - n, 2, 0);
    send_frame(l, CH_CMD, MSG_HU_VERSION, body, n);
}

static void send_statistic(link_t *l)
{
    /* versionName(2) + versionCode(3): the rest is Baidu's own telemetry and a
     * phone that wanted it would only log it */
    uint8_t body[64];
    size_t n = 0;
    n += pb_string(body + n, sizeof body - n, 2, "2.0.0");
    n += pb_uint(body + n, sizeof body - n, 3, 1);
    send_frame(l, CH_CMD, MSG_STATISTIC, body, n);
}

/* CarlifeDeviceInfo: os(1), model(2), brand(3) - the field numbers a head unit
 * was seen to use; a phone only logs this. Off by default because a wrong
 * field number is worse than a missing message. */
static void send_hu_info(link_t *l)
{
    uint8_t body[128];
    size_t n = 0;
    n += pb_string(body + n, sizeof body - n, 1, "Linux");
    n += pb_string(body + n, sizeof body - n, 2, "MGU");
    n += pb_string(body + n, sizeof body - n, 3, "BMW");
    send_frame(l, CH_CMD, MSG_HU_INFO, body, n);
}

static void send_video_init(link_t *l)
{
    uint8_t body[32];
    size_t n = 0;
    n += pb_uint(body + n, sizeof body - n, 1, (uint64_t)l->req_w);
    n += pb_uint(body + n, sizeof body - n, 2, (uint64_t)l->req_h);
    n += pb_uint(body + n, sizeof body - n, 3, (uint64_t)l->req_fps);
    send_frame(l, CH_CMD, MSG_VIDEO_INIT, body, n);
    snprintf(l->state, sizeof l->state, "asked %dx%d@%d", l->req_w, l->req_h, l->req_fps);
}

static void send_video_start(link_t *l)
{
    send_frame(l, CH_CMD, MSG_VIDEO_START, NULL, 0);
    l->started = 1;
    snprintf(l->state, sizeof l->state, "waiting for picture");
}

/* The phone watches the cmd channel: when the head unit stops talking, it
 * tears the session down and the encoder restarts, which shows up as a black
 * frame and a stall. A real head unit sends a statistic every couple of
 * seconds for exactly this reason. We send the same one. */
static void send_keepalive(link_t *l)
{
    send_statistic(l);
}

static void touch_point(link_t *l, unsigned action, long pmx, long pmy)
{
    uint8_t body[32];
    size_t n = 0;
    int x, y;
    if (!l->ch[CH_TOUCH].open) { l->touch_drop++; return; }
    if (l->got_w <= 0 || l->got_h <= 0) { l->touch_drop++; return; }   /* nowhere to point yet */
    if (pmx < 0) pmx = 0;
    if (pmy < 0) pmy = 0;
    if (pmx > 10000) pmx = 10000;
    if (pmy > 10000) pmy = 10000;
    x = (int)(pmx * l->got_w / 10000);
    y = (int)(pmy * l->got_h / 10000);
    n += pb_uint(body + n, sizeof body - n, 1, action);
    n += pb_uint(body + n, sizeof body - n, 2, (uint64_t)x);
    n += pb_uint(body + n, sizeof body - n, 3, (uint64_t)y);
    send_frame(l, CH_TOUCH, MSG_TOUCH_ACTION, body, n);
    l->touch_sent++;
}

static void touch_key(link_t *l, unsigned code)
{
    uint8_t body[16];
    size_t n = pb_uint(body, sizeof body, 1, code);
    if (!l->ch[CH_TOUCH].open) { l->touch_drop++; return; }
    send_frame(l, CH_TOUCH, MSG_TOUCH_HARD_KEY, body, n);
    l->touch_sent++;
}

/* ---------- received messages ---------- */

static void on_cmd(link_t *l, uint32_t type, const uint8_t *body, size_t n)
{
    l->cmd_rx++;
    l->t_progress = now_ms();
    switch (type) {
    case MSG_MATCH_STATUS:
        if (!l->matched) {
            uint64_t status = 0;
            pb_get_uint(body, n, 1, &status);
            l->matched = 1;
            snprintf(l->state, sizeof l->state, "matched");
            logline(l, "version match (status=%llu)", (unsigned long long)status);
            send_statistic(l);
            if (l->send_hu_info) send_hu_info(l);
            send_video_init(l);
        }
        break;
    case MSG_VIDEO_INIT_DONE: {
        uint64_t w = 0, h = 0, fps = 0;
        pb_get_uint(body, n, 1, &w);
        pb_get_uint(body, n, 2, &h);
        pb_get_uint(body, n, 3, &fps);
        if (w > 0 && h > 0) {
            l->got_w = (int)w;
            l->got_h = (int)h;
            l->got_fps = (int)fps;
        }
        l->init_done = 1;
        logline(l, "encoder init done: %dx%d@%d", l->got_w, l->got_h, l->got_fps);
        send_video_start(l);
        break;
    }
    case MSG_MD_INFO:
        logline(l, "md info: %u bytes", (unsigned)n);
        break;
    case MSG_MD_FOREGROUND:
        break;
    case MSG_MD_AUTHEN:
        logline(l, "phone reports authentication: %u bytes", (unsigned)n);
        break;
    default:
        if (l->verbose) logline(l, "cmd %08x: %u bytes", type, (unsigned)n);
        break;
    }
}

/* Every start code in the payload, not just the one at byte 4: the first
 * message of a session is SPS, PPS and IDR concatenated. */
/* 1 if this access unit carries an IDR - the point at which a decoder that
 * skipped pictures can start again without smearing. */
static int scan_annexb(link_t *l, const uint8_t *p, size_t n)
{
    size_t i = 0;
    int idr = 0;
    while (i + 3 < n) {
        size_t sc = 0;
        if (p[i] == 0 && p[i + 1] == 0 && p[i + 2] == 0 && p[i + 3] == 1) sc = 4;
        else if (p[i] == 0 && p[i + 1] == 0 && p[i + 2] == 1) sc = 3;
        if (sc) {
            if (i + sc < n) {
                unsigned nal = p[i + sc] & 0x1f;
                if (nal == 7) l->saw_sps = 1;
                else if (nal == 8) l->saw_pps = 1;
                else if (nal == 5) { l->saw_idr = 1; idr = 1; }
            }
            i += sc;
        } else {
            i++;
        }
    }
    return idr;
}

static void on_video(link_t *l, uint32_t type, uint32_t ts, const uint8_t *p, size_t n)
{
    (void)ts;
    if (type == MSG_VIDEO_BEAT || (type == MSG_VIDEO_DATA && n == 0)) {
        l->vid_keepalive++;
        l->t_progress = now_ms();      /* the phone is alive, just no picture in this one */
        return;
    }
    if (type != MSG_VIDEO_DATA) {
        if (l->verbose) logline(l, "video type %08x (%u bytes) ignored", type, (unsigned)n);
        return;
    }
    {
        int idr = n >= 5 ? scan_annexb(l, p, n) : 0;
        double now = now_ms();
        l->vid_frames++;
        l->vid_bytes += n;
        l->t_last_video = now;
        l->t_progress = now;
        /* Whatever went wrong before this frame is history: the screen reads
         * error: verbatim, and a stale "read on the video channel failed"
         * beside a running picture is worse than no line at all. */
        if (l->error[0]) l->error[0] = 0;
        if (l->sink.want_idr) {
            if (!idr) {
                if (now - l->sink.t_want < SINK_IDR_WAIT_MS) {
                    l->sink.skipped++;
                    return;             /* catch up to a point we can draw from */
                }
                /* No keyframe came: drop the stale backlog and resume here.
                 * This can smear for a moment, but a picture a moment late is
                 * better than one frozen six seconds behind the phone. */
                sink_trim(&l->sink, SINK_BACKLOG / 4);
                l->sink.skipped++;
            }
            l->sink.want_idr = 0;
        } else if (l->sink.backlog + n > SINK_BACKLOG && !idr) {
            l->sink.want_idr = 1;
            l->sink.t_want = now;
            l->sink.skipped++;
            return;
        }
        sink_put(&l->sink, p, n);
    }
    if (!strcmp(l->state, "waiting for picture")) snprintf(l->state, sizeof l->state, "streaming");
}

/* ---------- report ---------- */

static void write_report(link_t *l)
{
    char tmp[300], ts[16];
    FILE *f;
    double secs = (now_ms() - l->t0) / 1000.0;
    if (!l->report_path[0]) return;
    snprintf(tmp, sizeof tmp, "%s.tmp", l->report_path);
    f = fopen(tmp, "wb");
    if (!f) return;
    stamp(ts, sizeof ts);
    fprintf(f, "=== CARLIFE LINK %s ===\n", ts);
    fprintf(f, "state: %s\n", l->state);
    fprintf(f, "host: %s\n", l->host);
    fprintf(f, "base: %d\n", l->base_port);
    fprintf(f, "scan: %s\n", l->scan[0] ? l->scan : "none");
    /* The car's own addresses. When the screen says "no phone on the
     * network", this is what says whether it is even on the same network as
     * the phone - i.e. whether the hotspot change actually took. */
    fprintf(f, "net: %s\n", l->netlist[0] ? l->netlist : "none");
    fprintf(f, "up: %.0f s\n", secs);
    fprintf(f, "cmd: %s rx=%lu tx=%lu match=%s\n", l->ch[CH_CMD].open ? "open" : "closed",
            l->cmd_rx, l->cmd_tx, l->matched ? "yes" : "no");
    fprintf(f, "video: %s %dx%d@%d frames=%lu %.1f MB beats=%lu dropped=%lu skipped=%lu backlog=%u%%\n",
            l->ch[CH_VIDEO].open ? "open" : "closed",
            l->got_w, l->got_h, l->got_fps, l->vid_frames, (double)l->vid_bytes / 1048576.0, l->vid_keepalive,
            l->sink.dropped, l->sink.skipped,
            (unsigned)(l->sink.backlog * 100 / SINK_BACKLOG));
    fprintf(f, "stream: sps=%s pps=%s idr=%s\n", l->saw_sps ? "yes" : "no", l->saw_pps ? "yes" : "no",
            l->saw_idr ? "yes" : "no");
    fprintf(f, "audio: media=%llu tts=%llu vr=%llu  %.1f KB\n",
            (unsigned long long)l->ch[CH_MEDIA].bytes, (unsigned long long)l->ch[CH_TTS].bytes,
            (unsigned long long)l->ch[CH_VR].bytes, (double)l->audio_bytes / 1024.0);
    fprintf(f, "touch: ctl=%d %s sent=%lu dropped=%lu\n", l->ctl_port,
            l->ctl_client != NO_SOCK ? "app=yes" : "app=no", l->touch_sent, l->touch_drop);
    fprintf(f, "reset: %d last: %s\n", l->resets, l->reset_reason[0] ? l->reset_reason : "none");
    fprintf(f, "error: %s\n", l->error[0] ? l->error : "none");
    fclose(f);
#ifdef _WIN32
    remove(l->report_path);
#endif
    rename(tmp, l->report_path);
}

/* ---------- control channel from the app (127.0.0.1) ---------- */

static void on_ctl_line(link_t *l, char *line)
{
    char *cmd, *a, *b;
    cmd = line;
    while (*cmd && isspace((unsigned char)*cmd)) cmd++;
    a = strchr(cmd, ' ');
    if (a) { *a++ = 0; while (*a == ' ') a++; }
    b = a ? strchr(a, ' ') : NULL;
    if (b) { *b++ = 0; while (*b == ' ') b++; }

    if (!strcmp(cmd, "down")) touch_point(l, 0, a ? strtol(a, NULL, 10) : 0, b ? strtol(b, NULL, 10) : 0);
    else if (!strcmp(cmd, "up")) touch_point(l, 1, a ? strtol(a, NULL, 10) : 0, b ? strtol(b, NULL, 10) : 0);
    else if (!strcmp(cmd, "move")) touch_point(l, 2, a ? strtol(a, NULL, 10) : 0, b ? strtol(b, NULL, 10) : 0);
    else if (!strcmp(cmd, "key")) touch_key(l, a ? (unsigned)strtoul(a, NULL, 10) : 0);
    else if (!strcmp(cmd, "retry")) {
        int i;
        logline(l, "app asked for a fresh connection");
        for (i = 0; i < NCH; i++) chan_close(&l->ch[i]);
        l->matched = l->init_done = l->started = 0;
        l->got_w = l->got_h = 0;
        snprintf(l->state, sizeof l->state, "reconnecting");
        l->t_retry = now_ms();
    }
    if (l->ctl_client != NO_SOCK) send_all(l->ctl_client, "ok\n", 3, 200);
}

static void ctl_pump(link_t *l, fd_set *rd)
{
    if (l->ctl_listen != NO_SOCK && FD_ISSET(l->ctl_listen, rd)) {
        sock_t s = accept(l->ctl_listen, NULL, NULL);
        if (s != NO_SOCK) {
            set_nonblock(s);
            if (l->ctl_client != NO_SOCK) sclose(l->ctl_client);
            l->ctl_client = s;
            l->linelen = 0;
            logline(l, "app connected on the control channel");
        }
    }
    if (l->ctl_client != NO_SOCK && FD_ISSET(l->ctl_client, rd)) {
        char buf[256];
        int got = (int)recv(l->ctl_client, buf, (int)sizeof buf, 0);
        int i;
        if (got <= 0) {
            sclose(l->ctl_client);
            l->ctl_client = NO_SOCK;
            logline(l, "app left the control channel");
            return;
        }
        for (i = 0; i < got; i++) {
            char c = buf[i];
            if (c == '\n') {
                l->line[l->linelen] = 0;
                on_ctl_line(l, l->line);
                l->linelen = 0;
            } else if (l->linelen + 1 < sizeof l->line) {
                l->line[l->linelen++] = c;
            }
        }
    }
}

/* ---------- reading and framing ---------- */

static void consume(chan_t *c, size_t n)
{
    if (n >= c->len) { c->len = 0; return; }
    memmove(c->buf, c->buf + n, c->len - n);
    c->len -= n;
}

static void parse_cmd(link_t *l)
{
    chan_t *c = &l->ch[CH_CMD];
    for (;;) {
        unsigned len;
        uint32_t type;
        if (c->len < 8) return;
        len = be16_get(c->buf);
        type = be32_get(c->buf + 4);
        if (c->len < 8 + (size_t)len) return;
        on_cmd(l, type, c->buf + 8, len);
        consume(c, 8 + (size_t)len);
    }
}

static void parse_video(link_t *l)
{
    chan_t *c = &l->ch[CH_VIDEO];
    for (;;) {
        uint32_t len, ts, type;
        if (c->len < 12) return;
        len = be32_get(c->buf);
        ts = be32_get(c->buf + 4);
        type = be32_get(c->buf + 8);
        if (len > VIDEO_MAX_FRAME) {
            fail(l, "video frame past the 4 MB buffer - resynchronising", NULL);
            c->len = 0;
            return;
        }
        if (c->len < 12 + (size_t)len) return;
        on_video(l, type, ts, c->buf + 12, len);
        consume(c, 12 + (size_t)len);
    }
}

static void parse_audio(link_t *l, int ci)
{
    chan_t *c = &l->ch[ci];
    for (;;) {
        uint32_t len;
        if (c->len < 12) return;
        len = be32_get(c->buf);
        if (len > (1u << 20)) { c->len = 0; return; }
        if (c->len < 12 + (size_t)len) return;
        l->audio_bytes += len;
        consume(c, 12 + (size_t)len);
    }
}

/* Only cmd and video carry the picture. The screen prints error: verbatim, and
 * the phone opens and closes media/tts/vr on its own schedule during a healthy
 * session, so a closed audio channel must never be shown as "取流错误". */
static int chan_required(int ci) { return ci == CH_CMD || ci == CH_VIDEO; }

static void read_channel(link_t *l, int ci, fd_set *rd)
{
    chan_t *c = &l->ch[ci];
    int got;
    if (!c->open || !FD_ISSET(c->fd, rd)) return;
    if (c->len == c->cap) {              /* a frame nothing can ever complete */
        if (chan_required(ci)) fail(l, "inbox on the %s channel overflowed", c->name);
        c->len = 0;
    }
    got = (int)recv(c->fd, (char *)c->buf + c->len, (int)(c->cap - c->len), 0);
    if (got == 0) {
        if (chan_required(ci)) {
            logline(l, "%s channel closed by the phone", c->name);
            snprintf(l->state, sizeof l->state, "phone closed %s", c->name);
            fail(l, "%s channel closed by the phone", c->name);
        } else {
            logline(l, "%s channel closed by the phone (not needed for the picture)", c->name);
        }
        chan_close(c);
        return;
    }
    if (got < 0) {
        int e = serr();
        if (!SWOULDBLOCK(e)) {
            if (chan_required(ci)) fail(l, "read on the %s channel failed", c->name);
            else logline(l, "read on the %s channel failed (not needed for the picture)", c->name);
            chan_close(c);
        }
        return;
    }
    c->bytes += (unsigned long long)got;
    c->len += (size_t)got;
    if (ci == CH_CMD) parse_cmd(l);
    else if (ci == CH_VIDEO) parse_video(l);
    else parse_audio(l, ci);
}

/* ---------- connecting ---------- */

static int open_channel(link_t *l, int ci, int timeout_ms)
{
    char err[200] = { 0 };
    chan_t *c = &l->ch[ci];
    sock_t s;
    chan_close(c);
    s = tcp_connect(l->host, l->base_port + c->offset, timeout_ms, err, sizeof err);
    if (s == NO_SOCK) {
        snprintf(l->error, sizeof l->error, "%s", err);
        return -1;
    }
    c->fd = s;
    c->open = 1;
    if (!c->buf) {
        c->cap = (ci == CH_VIDEO) ? VIDEO_MAX_FRAME + 12 : (64u << 10);
        c->buf = (uint8_t *)malloc(c->cap);
        if (!c->buf) { chan_close(c); snprintf(l->error, sizeof l->error, "out of memory"); return -1; }
    }
    c->len = 0;
    return 0;
}

/* Bring up everything, then the version. A missing cmd or video channel is
 * fatal; the three audio channels and touch are allowed to fail, and are
 * retried on the next pass while the session lives.
 *
 * A channel that is already open is left alone. The phone restarts its
 * encoder every time a session starts over, so a reconnect that is really
 * only meant to repair one channel must not throw the video channel away:
 * that costs a black frame and a stall on every hiccup. */
static int connect_all(link_t *l)
{
    int i;
    int need = 0;
    int had_video = l->ch[CH_VIDEO].open;
    snprintf(l->state, sizeof l->state, "connecting");
    /* The watchdog's clock starts with the dials, not with the first frame:
     * a session that opens every channel and then says nothing has to be
     * caught by the same ten seconds. */
    l->t_progress = now_ms();
    for (i = 0; i < NCH; i++) {
        if (l->ch[i].open) {
            logline(l, "%s channel still up (port %d)", l->ch[i].name, l->base_port + l->ch[i].offset);
            continue;
        }
        if (open_channel(l, i, 500) == 0) {
            logline(l, "%s channel up (port %d)", l->ch[i].name, l->base_port + l->ch[i].offset);
        } else if (i == CH_CMD || i == CH_VIDEO) {
            need = 1;
            logline(l, "%s channel is required and did not come up: %s", l->ch[i].name, l->error);
        } else {
            logline(l, "%s channel not up: %s (will retry)", l->ch[i].name, l->error);
        }
    }
    if (need) {
        snprintf(l->state, sizeof l->state, "phone not reachable");
        /* Only drop the channels that did not come up. A working video
         * channel is worth far more than a clean slate: the phone restarts
         * its encoder whenever a new session starts, so tearing the old one
         * down costs a black frame and a second of stall. */
        for (i = 0; i < NCH; i++) {
            if (!l->ch[i].open) continue;
            if (i == CH_CMD || i == CH_VIDEO) continue;   /* keep the live ones */
            chan_close(&l->ch[i]);
        }
        return -1;
    }
    if (had_video && l->ch[CH_VIDEO].open && l->matched) {
        /* The video session survived; the phone only needs the cmd channel
         * back. Re-running the whole handshake would make it restart the
         * encoder, so only the cmd part is redone. */
        logline(l, "cmd channel back, keeping the running video session");
        l->matched = 0;
        l->init_done = 1;      /* the encoder is already configured */
        send_version(l);
        return 0;
    }
    l->matched = l->init_done = l->started = 0;
    l->got_w = l->got_h = l->got_fps = 0;
    l->saw_sps = l->saw_pps = l->saw_idr = 0;
    snprintf(l->state, sizeof l->state, "handshake");
    send_version(l);
    return 0;
}

static void reopen_missing(link_t *l)
{
    /* Only the three channels we actually use are worth bringing back. The
     * phone closes its media/tts/vr channels every few seconds; reconnecting
     * all of them used to block this single-threaded loop for 600 ms each,
     * during which select() did not run, so video frames piled up and touch
     * commands sat unread. One critical channel per pass, short timeout. */
    static const int critical[3] = { CH_TOUCH, CH_VIDEO, CH_CMD };
    int k;
    for (k = 0; k < 3; k++) {
        int i = critical[(l->retry_idx + k) % 3];
        if (l->ch[i].open) continue;
        l->retry_idx = (l->retry_idx + k + 1) % 3;
        if (open_channel(l, i, 200) == 0) {
            logline(l, "%s channel back", l->ch[i].name);
            if (i == CH_CMD && !l->matched) send_version(l);
        }
        return;   /* at most one blocking connect per pass */
    }
}

/* ---------- probe ---------- */

static int probe(const char *host, int base, int quiet)
{
    int i, open_count = 0, refused = 0, silent = 0;
    printf("carlife probe: %s, base port %d\n", host, base);
    printf("%-6s %-6s %s\n", "chan", "port", "answer");
    for (i = 0; i < NCH; i++) {
        char err[160] = { 0 };
        sock_t s = tcp_connect(host, base + CH_OFFSET[i], 2500, err, sizeof err);
        if (s == NO_SOCK) {
            /* A phone in Wi-Fi power save drops the first SYN and answers the
             * next one: one more try separates "asleep" from "not listening". */
            if (strstr(err, "timed out")) {
                char err2[160] = { 0 };
                s = tcp_connect(host, base + CH_OFFSET[i], 2500, err2, sizeof err2);
                if (s == NO_SOCK) snprintf(err, sizeof err, "%s", err2);
            }
        }
        if (s == NO_SOCK) {
            if (strstr(err, "refused")) refused++;
            else silent++;
            printf("%-6s %-6d closed (%s)\n", CH_NAME[i], base + CH_OFFSET[i], err);
            continue;
        }
        open_count++;
        if (i == CH_CMD && !quiet) {
            uint8_t hdr[8];
            uint8_t body[16];
            size_t n = 0;
            char hex[3 * 64 + 1];
            int at = 0, got, k;
            uint8_t in[64];
            n += pb_uint(body + n, sizeof body - n, 1, 1);
            n += pb_uint(body + n, sizeof body - n, 2, 0);
            be16_put(hdr, (unsigned)n);
            be16_put(hdr + 2, 0);
            be32_put(hdr + 4, MSG_HU_VERSION);
            send_all(s, hdr, 8, 400);
            send_all(s, body, n, 400);
            {
                /* the socket is non-blocking: give the phone a moment to answer
                 * instead of reading the empty buffer and calling it silence */
                fd_set rd;
                struct timeval tv;
                FD_ZERO(&rd);
                FD_SET(s, &rd);
                tv.tv_sec = 1;
                tv.tv_usec = 500000;
                got = (select((int)(s + 1), &rd, NULL, NULL, &tv) > 0)
                          ? (int)recv(s, (char *)in, (int)sizeof in, 0)
                          : 0;
            }
            if (got <= 0) {
                printf("%-6s %-6d open, no answer to the version\n", CH_NAME[i], base + CH_OFFSET[i]);
            } else {
                for (k = 0; k < got && at < (int)sizeof hex - 3; k++) at += snprintf(hex + at, sizeof hex - (size_t)at, "%02x ", in[k]);
                hex[at ? at - 1 : 0] = 0;
                printf("%-6s %-6d open, answered %d bytes: %s\n", CH_NAME[i], base + CH_OFFSET[i], got, hex);
            }
        } else {
            printf("%-6s %-6d open\n", CH_NAME[i], base + CH_OFFSET[i]);
        }
        sclose(s);
    }
    printf("%d of %d channels open\n", open_count, NCH);
    if (!open_count) {
        if (refused)
            printf("diagnosis: %d port(s) answered 'refused' - the phone is awake and reachable,\n"
                   "  so CarLife is simply not listening. Start CarLife on the phone and put it\n"
                   "  in its wireless/waiting state, keeping the screen on.\n", refused);
        else if (silent)
            printf("diagnosis: %d port(s) stayed silent - the phone is asleep, firewalling, or\n"
                   "  this is not its address. Wake it and keep it on, then try again.\n", silent);
    }
    return open_count == NCH ? 0 : (open_count ? 2 : 1);
    return open_count == NCH ? 0 : (open_count ? 2 : 1);
}

/* ---------- run ---------- */

static void usage(void)
{
    fprintf(stderr,
            "carlife-link - the head-unit side of CarLife over Wi-Fi\n"
            "\n"
            "  carlife-link probe --host IP [--port 7240]\n"
            "  carlife-link run   --host IP|auto [options]\n"
            "\n"
            "  --host IP        the phone's address, or `auto` to find it on the local network\n"
            "  --find           same as --host auto\n"
            "  --port N         base port; camera 7240, video 8240, touch 9340 (default 7240)\n"
            "  --ctl N          control port the app connects to on 127.0.0.1 (default 7399)\n"
            "  --report PATH    status file, rewritten once a second\n"
            "  --video PATH     append the H.264 Annex-B the phone sends to PATH\n"
            "  --width/--height/--fps   what to ask the phone to encode (default 1280x720@60)\n"
            "  --major N        CarLife major version to announce (default 1)\n"
            "  --hu-info        also send HU_INFO (off: field numbers unproven on this phone)\n"
            "  --seconds N      stop after N seconds (default: until killed)\n"
            "  --drop-uid N     setuid/setgid to N after start (Linux; before any socket)\n"
            "  --verbose        log every cmd message and the ignored video types\n");
}

int main(int argc, char **argv)
{
    const char *mode, *host = NULL;
    int i, rc = 0;
    int host_known = 1;   /* --find: false until something answers on the network */
    double seconds = 0;
#ifndef _WIN32
    int drop_uid = -1;   /* mgu-uplink's whitelist uid; root is never whitelisted */
#endif

    if (argc < 2) { usage(); return 2; }
    mode = argv[1];
    if (!strcmp(mode, "-h") || !strcmp(mode, "--help")) { usage(); return 0; }
    /* install.sh proves every shipped binary can be executed on the unit.
     * This must not open a socket, parse a report or need privileges. */
    if (!strcmp(mode, "--selftest")) { printf("carlife-link ok\n"); return 0; }

    if (net_init() != 0) { fprintf(stderr, "winsock init failed\n"); return 2; }
    memset(&L, 0, sizeof L);
    L.base_port = 7240;
    L.ctl_port = 7399;
    L.req_w = 1280;
    L.req_h = 720;
    /* 60, not 30: the phone honours the frame rate we ask for, and at 30 it
     * caps the whole session well below what it can actually push. Measured
     * on a phone that supports 60: 12 fps at 30 versus 28-38 fps at 60. */
    L.req_fps = 60;
    L.major = 1;
    L.ctl_listen = NO_SOCK;
    L.ctl_client = NO_SOCK;
    for (i = 0; i < NCH; i++) { L.ch[i].name = CH_NAME[i]; L.ch[i].offset = CH_OFFSET[i]; L.ch[i].fd = NO_SOCK; }
    snprintf(L.state, sizeof L.state, "idle");
    snprintf(L.host, sizeof L.host, "127.0.0.1");

    for (i = 2; i < argc; i++) {
        const char *a = argv[i];
        const char *v = (i + 1 < argc) ? argv[i + 1] : NULL;
        if (!strcmp(a, "--host") && v) { snprintf(L.host, sizeof L.host, "%s", v); host = L.host; i++; }
        else if (!strcmp(a, "--port") && v) { L.base_port = atoi(v); i++; }
        else if (!strcmp(a, "--ctl") && v) { L.ctl_port = atoi(v); i++; }
        else if (!strcmp(a, "--report") && v) { snprintf(L.report_path, sizeof L.report_path, "%s", v); i++; }
        else if (!strcmp(a, "--video") && v) { snprintf(L.video_path, sizeof L.video_path, "%s", v); i++; }
        else if (!strcmp(a, "--width") && v) { L.req_w = atoi(v); i++; }
        else if (!strcmp(a, "--height") && v) { L.req_h = atoi(v); i++; }
        else if (!strcmp(a, "--fps") && v) { L.req_fps = atoi(v); i++; }
        else if (!strcmp(a, "--major") && v) { L.major = atoi(v); i++; }
        else if (!strcmp(a, "--seconds") && v) { seconds = atof(v); i++; }
#ifndef _WIN32
        else if (!strcmp(a, "--drop-uid") && v) { drop_uid = atoi(v); i++; }
#endif
        else if (!strcmp(a, "--hu-info")) L.send_hu_info = 1;
        else if (!strcmp(a, "--find")) L.find_mode = 1;
        else if (!strcmp(a, "--verbose")) L.verbose = 1;
        else if (!strcmp(a, "-h") || !strcmp(a, "--help")) { usage(); net_done(); return 0; }
        else { fprintf(stderr, "unknown argument: %s\n", a); usage(); net_done(); return 2; }
    }
    if (L.find_mode || (host && !strcmp(host, "auto"))) {
        L.find_mode = 1;
    } else if (!host) {
        fprintf(stderr, "--host is required (or --find to look for the phone)\n");
        net_done();
        return 2;
    }

    /* mgu-uplink's firewall only lets whitelisted uids send out of the WiFi
     * interface, and it never whitelists root. Everything this program needs
     * (a high control port, a report file in a 0777 dir, outbound TCP) works
     * as an unprivileged uid, so drop after parsing --drop-uid and before
     * opening any socket. Done in the binary, not relying on setpriv/su. */
#ifndef _WIN32
    if (drop_uid >= 0) {
        if (setgroups(0, NULL) != 0 || setgid((gid_t)drop_uid) != 0 || setuid((uid_t)drop_uid) != 0) {
            fprintf(stderr, "cannot drop to uid %d: %s\n", drop_uid, strerror(errno));
            net_done();
            return 2;
        }
    }
#endif

    if (!strcmp(mode, "probe")) {
        rc = probe(L.host, L.base_port, 0);
        net_done();
        return rc;
    }
    if (strcmp(mode, "run")) { fprintf(stderr, "unknown mode: %s\n", mode); usage(); net_done(); return 2; }

    if (L.video_path[0]) {
        if (!strcmp(L.video_path, "-")) {
            /* "-" sends the raw stream to stdout so a decoder can read it from
             * a pipe; no temp file, no seek, no growth on flash.  Threaded: a
             * pipe whose reader falls behind must not stall the session */
#ifdef _WIN32
            _setmode(_fileno(stdout), _O_BINARY);
#endif
            if (sink_open(&L.sink, stdout, 1) != 0) {
                fprintf(stderr, "cannot start the stdout writer\n");
                net_done();
                return 2;
            }
        } else {
            FILE *f = fopen(L.video_path, "wb");
            if (!f) { fprintf(stderr, "cannot write %s\n", L.video_path); net_done(); return 2; }
            sink_open(&L.sink, f, 0);
        }
    }
    {
        /* the control channel: the app's only way in, and it must not need root */
        struct sockaddr_in sa;
        sock_t s = socket(AF_INET, SOCK_STREAM, 0);
        int one = 1;
        if (s != NO_SOCK) {
            setsockopt(s, SOL_SOCKET, SO_REUSEADDR, (const char *)&one, sizeof one);
            memset(&sa, 0, sizeof sa);
            sa.sin_family = AF_INET;
            sa.sin_port = htons((unsigned short)L.ctl_port);
            sa.sin_addr.s_addr = htonl(0x7f000001u);
            if (bind(s, (struct sockaddr *)&sa, sizeof sa) == 0 && listen(s, 2) == 0) {
                set_nonblock(s);
                L.ctl_listen = s;
            } else {
                logline(&L, "control port %d is busy: the app will show status only", L.ctl_port);
                sclose(s);
            }
        }
    }

    L.t0 = now_ms();
    L.t_retry = L.t0;
    L.t_keepalive = L.t0;
    /* Baseline for the network watch: only a change from here is a hotspot
     * change, so the first look must never fire the "network changed" path. */
    L.nself = local_ipv4(L.self, 8);
    L.t_net = L.t0;
    fmt_addrs(L.self, L.nself, L.netlist, sizeof L.netlist);
    if (L.find_mode) {
        char found[64];
        snprintf(L.state, sizeof L.state, "looking for the phone");
        if (discover(L.base_port, found, sizeof found, L.scan, sizeof L.scan) == 0) {
            snprintf(L.host, sizeof L.host, "%s", found);
            logline(&L, "found the phone at %s", L.host);
        } else {
            /* Nothing was found, so there is nothing to dial: with --host auto
             * the host field still holds the word "auto", and dialling it
             * produced "cannot resolve auto" in the report - an error about
             * our own argument, displayed as if the phone had refused. The
             * retry loop looks again every few seconds. */
            host_known = 0;
            logline(&L, "no phone answered on the local network yet");
            snprintf(L.state, sizeof L.state,
                     L.nself ? "no phone on the network" : "looking for the phone");
        }
    }
    if (host_known && connect_all(&L) != 0) logline(&L, "first attempt failed, retrying");
    write_report(&L);

    while (1) {
        fd_set rd;
        struct timeval tv;
        int maxfd = -1, i;
        double now = now_ms();
        FD_ZERO(&rd);
        for (i = 0; i < NCH; i++) {
            if (L.ch[i].open) { FD_SET(L.ch[i].fd, &rd); if ((int)L.ch[i].fd > maxfd) maxfd = (int)L.ch[i].fd; }
        }
        if (L.ctl_listen != NO_SOCK) { FD_SET(L.ctl_listen, &rd); if ((int)L.ctl_listen > maxfd) maxfd = (int)L.ctl_listen; }
        if (L.ctl_client != NO_SOCK) { FD_SET(L.ctl_client, &rd); if ((int)L.ctl_client > maxfd) maxfd = (int)L.ctl_client; }
        tv.tv_sec = 0;
        /* The control socket is only pumped after select() returns, so a long
         * timeout here adds directly to touch latency whenever the phone is
         * between frames. 50 ms of idle wakeups costs nothing. */
        tv.tv_usec = 50000;
        if (select(maxfd + 1, &rd, NULL, NULL, &tv) > 0) {
            for (i = 0; i < NCH; i++) read_channel(&L, i, &rd);
            ctl_pump(&L, &rd);
        }

        now = now_ms();
        /* Hotspot change watch: one getifaddrs() a second. When the set of
         * local addresses differs from the last look, the car has joined a
         * different network - the session we were dialling belongs to the old
         * one, so it is dropped and the phone is looked for again at once.
         * This is the whole fix for "the address takes a minute to switch":
         * whatever the dials are doing, DHCP renumbers wlan0 within a second
         * or two of associating, and that is now the trigger. */
        if (now - L.t_net >= 1000) {
            uint32_t cur[8];
            int ncur = local_ipv4(cur, 8);
            L.t_net = now;
            if (!net_same(L.self, L.nself, cur, ncur)) {
                int was = L.nself;
                char before[96], after[96], found[64];
                fmt_addrs(L.self, was, before, sizeof before);
                fmt_addrs(cur, ncur, after, sizeof after);
                memcpy(L.self, cur, sizeof cur);
                L.nself = ncur;
                snprintf(L.netlist, sizeof L.netlist, "%s", after);
                logline(&L, "network changed (%d -> %d addresses: %s -> %s), looking for the phone again",
                        was, ncur, before[0] ? before : "none", after[0] ? after : "none");
                L.fail_rounds = 0;
                channels_reset(&L);
                snprintf(L.state, sizeof L.state, "looking for the phone");
                if (discover(L.base_port, found, sizeof found, L.scan, sizeof L.scan) == 0) {
                    if (strcmp(found, L.host)) snprintf(L.host, sizeof L.host, "%s", found);
                    logline(&L, "found the phone at %s", found);
                    L.t_retry = now;
                    connect_all(&L);
                } else {
                    /* No address at all is not the same as an address with no
                     * phone behind it: the car may still be associating, and
                     * "找不到手机" while wlan0 has no lease would be a lie. */
                    snprintf(L.state, sizeof L.state,
                             ncur ? "no phone on the network" : "looking for the phone");
                    /* Keep the address we had: it may be the right one with
                     * the phone's CarLife simply not open yet, and the retry
                     * loop below takes over from here either way. */
                    logline(&L, ncur ? "no phone answered on the new network yet"
                                     : "no address yet, waiting for the hotspot");
                }
                write_report(&L);
            }
        }
        if (now - L.t_reported >= 1000) {
            L.t_reported = now;
            write_report(&L);
        }
        /* A session that opens, matches and then goes silent is what the phone
         * leaves behind when an earlier session was never torn down: the
         * encoder even reports "init done" and not one frame follows. No read
         * returns an error, so nothing else here notices - measured on the
         * unit, frames=0 for three and a half minutes until the phone dropped
         * the video socket by itself. Fresh sockets clear it at once, because
         * the phone starts a new session for a new connection. */
        if ((L.ch[CH_CMD].open || L.ch[CH_VIDEO].open) && now - L.t_progress >= WATCHDOG_MS) {
            int stale = L.vid_frames && L.t_last_video > 0 && now - L.t_last_video >= WATCHDOG_MS;
            snprintf(L.reset_reason, sizeof L.reset_reason,
                     stale ? "no picture for %d s" : "the phone accepted the session and sent nothing",
                     (int)(WATCHDOG_MS / 1000));
            logline(&L, "watchdog: %s - dropping the session and dialling again", L.reset_reason);
            L.resets++;
            channels_reset(&L);
            snprintf(L.state, sizeof L.state, "reconnecting");
            L.t_retry = now;
            connect_all(&L);
            L.t_progress = now;
            write_report(&L);
        }
        /* Keep the cmd channel talking. The phone drops a session whose cmd
         * channel goes quiet, and the encoder restarts with it, so a couple
         * of statistic messages a second is what keeps the picture steady. */
        if (L.ch[CH_CMD].open && now - L.t_keepalive >= 2000) {
            L.t_keepalive = now;
            send_keepalive(&L);
        }
        /* nothing connected: keep trying, but not in a tight loop */
        if (!L.ch[CH_CMD].open && now - L.t_retry >= (L.find_mode ? 5000.0 : 3000.0)) {
            int ready = 1;
            L.t_retry = now;
            if (L.find_mode) {
                char found[64];
                snprintf(L.state, sizeof L.state, "looking for the phone");
                if (discover(L.base_port, found, sizeof found, L.scan, sizeof L.scan) == 0) {
                    if (strcmp(found, L.host)) logline(&L, "found the phone at %s", found);
                    snprintf(L.host, sizeof L.host, "%s", found);
                } else {
                    ready = 0;
                    snprintf(L.state, sizeof L.state, "no phone on the network");
                    logline(&L, "still no phone answering on this network");
                }
            } else if (++L.fail_rounds >=
                       (on_any_net(host_net(L.host), L.self, L.nself) ? HINT_ROUNDS : 2)) {
                /* The address was a hint (mgu-uplink's lease, the file the app
                 * writes): a lease outlives the network it describes, so after
                 * the car joins another hotspot it can name a router that is
                 * not on this link at all, and dialling it recovers never.
                 * Sweep the network we are on now and switch if the phone is
                 * somewhere else on it.
                 *
                 * A hint that is not even on one of our own /24s gets only two
                 * rounds: it cannot be the phone, so there is nothing to wait
                 * for. (This is what catches a host file typed for an earlier
                 * hotspot, including the one the app publishes from Settings.)
                 * The network-change watch above normally fires first. */
                char found[64];
                L.fail_rounds = 0;
                if (discover(L.base_port, found, sizeof found, L.scan, sizeof L.scan) == 0) {
                    if (strcmp(found, L.host))
                        logline(&L, "%s is not answering; the phone is at %s", L.host, found);
                    snprintf(L.host, sizeof L.host, "%s", found);
                } else {
                    logline(&L, "hint %s is not answering, nothing on %s has the port",
                            L.host, L.scan[0] ? L.scan : "the network");
                }
            }
            if (ready) {
                logline(&L, "trying %s again", L.host);
                connect_all(&L);
                if (L.ch[CH_CMD].open) L.fail_rounds = 0;
            }
        } else if (L.ch[CH_CMD].open && (!L.ch[CH_VIDEO].open || !L.ch[CH_TOUCH].open) && now - L.t_retry >= 400) {
            /* A closed touch channel used to stay down for 3 s, dropping every
             * tap in that window. reopen_missing() now does one short connect
             * per pass, so checking often is both cheap and necessary. */
            L.t_retry = now;
            reopen_missing(&L);
        }
        if (seconds > 0 && (now - L.t0) / 1000.0 >= seconds) break;
    }

    write_report(&L);
    sink_close(&L.sink);
    if (L.ctl_listen != NO_SOCK) sclose(L.ctl_listen);
    link_close(&L);
    net_done();
    return (L.vid_frames || L.vid_bytes) ? 0 : 1;
}
