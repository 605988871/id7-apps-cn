/*
 * wifi-bridge - let the CarLife app join the phone's hotspot itself.
 *
 * mgu-uplink owns Wi-Fi on this unit. Its control socket is root-only (0600),
 * and the updater relays privileged requests only for the Store app. Neither
 * route is open to an ordinary OAP app. This small root helper is the bridge:
 * it listens on a world-writable unix socket under /dev/shm, takes one JSON
 * request per connection, and forwards only the handful of Wi-Fi operations
 * the app needs to mgu-uplink's own socket. Replies go straight back.
 *
 * Only these ops are forwarded (an allow-list, not a deny-list):
 *   wifi-enable, wifi-5ghz, wifi-scan, wifi-connect, wifi-forget
 * Changing the preferred uplink or USB-phone handling is deliberately NOT
 * exposed: that belongs to the Store and can disturb the car's own devices.
 *
 * One request per connection, one reply, then close - the same protocol as
 * mgu-uplink's ctl.sock (ctl.go). A password never appears in our output.
 *
 * Built with zig cc for the head unit (glibc 2.27, arm/aarch64 as configured
 * in build.sh). No third-party headers or libraries.
 */
#include <errno.h>
#include <grp.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/un.h>
#include <time.h>
#include <unistd.h>

#define APP_SOCK    "/dev/shm/carlife-wireless/wifi.sock"
#define UPLINK_SOCK "/run/mgu-uplink/ctl.sock"
#define MAX_REQ     4096
#define TIMEOUT_S   8

/* A request is one JSON object on one line. Find the "op" value without a
 * JSON library: the uplink's protocol fixes the shape (ctl.go). Quotes
 * inside an op are impossible, so a bounded scan is sufficient here. */
static const char *request_op(const char *buf, size_t len)
{
    static const char *keys[] = { "wifi-enable", "wifi-5ghz", "wifi-scan", "wifi-connect", "wifi-forget" };
    const char *p;
    /* Walk the raw request by hand: tolerate spaces around the colon, and
     * never forward anything whose op is not on the allow-list. */
    for (p = buf; p + 8 < buf + len; p++) {
        const char *q;
        size_t k;
        if (*p != '"' || p[1] != 'o' || p[2] != 'p' || p[3] != '"') continue;
        q = p + 4;
        while (q < buf + len && (*q == ' ' || *q == '\t')) q++;
        if (q >= buf + len || *q++ != ':') continue;
        while (q < buf + len && (*q == ' ' || *q == '\t')) q++;
        if (q >= buf + len || *q++ != '"') continue;
        for (k = 0; k < sizeof(keys) / sizeof(keys[0]); k++) {
            size_t n = strlen(keys[k]);
            if ((size_t)(buf + len - q) < n + 1) continue;
            if (memcmp(q, keys[k], n) || q[n] != '"') continue;
            return keys[k];
        }
    }
    return NULL;
}

static int connect_unix(const char *path)
{
    int fd;
    struct sockaddr_un addr;
    memset(&addr, 0, sizeof addr);
    addr.sun_family = AF_UNIX;
    if (strlen(path) >= sizeof addr.sun_path) return -1;
    strcpy(addr.sun_path, path);
    fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0) return -1;
    if (connect(fd, (struct sockaddr *)&addr, sizeof addr) != 0) {
        close(fd);
        return -1;
    }
    return fd;
}

static void reply(int fd, const char *text)
{
    size_t n = strlen(text);
    ssize_t w;
    while (n) {
        w = write(fd, text, n);
        if (w <= 0) {
            if (w < 0 && errno == EINTR) continue;
            break;
        }
        text += w;
        n -= (size_t)w;
    }
}

static void serve_app(int fd)
{
    char req[MAX_REQ + 2];
    size_t len = 0;
    const char *op;
    int up = -1;
    struct timeval tv;

    tv.tv_sec = TIMEOUT_S;
    tv.tv_usec = 0;
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof tv);
    setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof tv);

    for (;;) {
        ssize_t r = read(fd, req + len, sizeof req - len - 1);
        if (r < 0) {
            if (errno == EINTR) continue;
            reply(fd, "{\"ok\":false,\"error\":\"read failed\"}\n");
            return;
        }
        if (r == 0) break;
        len += (size_t)r;
        if (memchr(req, '\n', len)) break;
        if (len >= sizeof req - 1) {
            reply(fd, "{\"ok\":false,\"error\":\"request too long\"}\n");
            return;
        }
    }
    if (!len) {
        reply(fd, "{\"ok\":false,\"error\":\"empty request\"}\n");
        return;
    }
    req[len] = '\n';
    req[len + 1] = '\0';

    op = request_op(req, len);
    if (!op) {
        reply(fd, "{\"ok\":false,\"error\":\"operation not allowed\"}\n");
        return;
    }

    up = connect_unix(UPLINK_SOCK);
    if (up < 0) {
        reply(fd, "{\"ok\":false,\"error\":\"mgu-uplink is not running\"}\n");
        return;
    }
    setsockopt(up, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof tv);
    setsockopt(up, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof tv);
    if (write(up, req, len + 1) != (ssize_t)(len + 1)) {
        reply(fd, "{\"ok\":false,\"error\":\"cannot reach mgu-uplink\"}\n");
        close(up);
        return;
    }

    /* The uplink replies with one JSON line, then closes. Forward it verbatim
     * so the app sees the uplink's real error text (e.g. a short password). */
    {
        int got = 0;
        for (;;) {
            char out[1024];
            ssize_t r = read(up, out, sizeof out - 1);
            if (r < 0) {
                if (errno == EINTR) continue;
                break;
            }
            if (r == 0) break;
            got = 1;
            out[r] = '\0';
            {
                ssize_t w;
                size_t left = (size_t)r, off = 0;
                while (left) {
                    w = write(fd, out + off, left);
                    if (w <= 0) {
                        if (w < 0 && errno == EINTR) continue;
                        break;
                    }
                    off += (size_t)w;
                    left -= (size_t)w;
                }
            }
            if (memchr(out, '\n', (size_t)r)) break;
        }
        if (!got) reply(fd, "{\"ok\":false,\"error\":\"mgu-uplink gave no answer\"}\n");
    }
    close(up);
}

int main(int argc, char **argv)
{
    int ln, yes = 1;
    struct sockaddr_un addr;

    if (argc > 1 && !strcmp(argv[1], "--selftest")) {
        printf("wifi-bridge ok\n");
        return 0;
    }
    signal(SIGPIPE, SIG_IGN);

    ln = socket(AF_UNIX, SOCK_STREAM, 0);
    if (ln < 0) { perror("socket"); return 1; }
    setsockopt(ln, SOL_SOCKET, SO_REUSEADDR, &yes, sizeof yes);
    unlink(APP_SOCK);
    memset(&addr, 0, sizeof addr);
    addr.sun_family = AF_UNIX;
    strcpy(addr.sun_path, APP_SOCK);
    if (bind(ln, (struct sockaddr *)&addr, sizeof addr) != 0) { perror("bind"); close(ln); return 1; }
    /* The app runs as an OAP uid, not root. Narrow the socket to the OAP app
     * group (the updater uses the same group for its own socket); if the unit
     * has no such group, fall back to world-writable so the app still works. */
    {
        struct group *g = getgrnam("tm_oap_app");
        mode_t mode = g ? 0660 : 0666;
        if (g && chown(APP_SOCK, 0, g->gr_gid) != 0) mode = 0666;
        if (chmod(APP_SOCK, mode) != 0) { perror("chmod"); close(ln); return 1; }
    }
    if (listen(ln, 8) != 0) { perror("listen"); close(ln); return 1; }

    for (;;) {
        int fd = accept(ln, NULL, NULL);
        if (fd < 0) {
            if (errno == EINTR) continue;
            continue;
        }
        serve_app(fd);
        close(fd);
    }
}
