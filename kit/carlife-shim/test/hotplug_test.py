"""Prove the hotplug injection without a unit.

The stand-in is only reachable if carlife's own attach callback is handed our
device pointer. dev_aoa.so never polls - it registers a libusb hotplug callback
and its usb_monitor_thread waits in libusb_handle_events - so with no phone in
the port nothing would ever ask for a device list, and the whole bridge would
sit idle with a log that looks exactly like "the shim is not loaded".

This lifts the real functions out of shim.c and drives them with stubs, the same
way framer_test.py lifts the framer. What it checks cannot be seen from the
outside: that the callback fires, that it fires without our lock held, that an
id mismatch still reaches the only device handler there is, and that a
detach-only callback is left alone.

    python hotplug_test.py
"""

import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SHIM = os.path.join(HERE, "..", "src", "shim.c")
ZIG = os.environ.get("ZIG", r"D:/zig/zig-x86_64-windows-0.14.1/zig.exe")

PRELUDE = r"""
#define EXPORT
#define NOT_SUPPORTED (-12)

#include <pthread.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

struct libusb_context;
struct libusb_device;
struct libusb_device_handle;
typedef struct libusb_context libusb_context;
typedef struct libusb_device libusb_device;
typedef struct libusb_device_handle libusb_device_handle;

static pthread_mutex_t lock = PTHREAD_MUTEX_INITIALIZER;
static int fake_opened, fake_on = 1;
static unsigned long fake_bulk_in;

static int cb_calls, cb_with_lock_held, cb_event, cb_saw_fake;

static void tap(const char *fmt, ...)
{
    va_list ap;
    va_start(ap, fmt);
    vprintf(fmt, ap);
    va_end(ap);
    printf("\n");
    fflush(stdout);
}

static int64_t now_ms(void)
{
    struct timespec t;
    clock_gettime(CLOCK_MONOTONIC, &t);
    return (int64_t)t.tv_sec * 1000 + t.tv_nsec / 1000000;
}

static void tick(void) { }

static int fake_wanted(void) { return fake_on; }

/* The real libusb answers 0 here on a unit with hotplug support; that is the
 * only thing register_callback's own return value depends on. */
static int stub_register(libusb_context *ctx, int events, int flags, int vid, int pid,
                         int cls, void *fn, void *ud, int *handle)
{
    (void)ctx; (void)events; (void)flags; (void)vid; (void)pid; (void)cls;
    (void)fn; (void)ud;
    if (handle) *handle = 1;
    return 0;
}

static void *sym(const char *name)
{
    (void)name;
    return (void *)stub_register;
}

static unsigned int fake_magic = 0x46414B45u;
static libusb_device *FAKE_DEV = (libusb_device *)&fake_magic;

/* MATCH_ANY, arrival: the ordinary registration. Must fire, must carry
 * LIBUSB_HOTPLUG_EVENT_DEVICE_ARRIVED, must not run with our mutex held, and
 * must be able to consume the device. */
static int cb_any(libusb_context *ctx, libusb_device *dev, int event, void *ud)
{
    (void)ctx; (void)ud;
    cb_calls++;
    cb_event = event;
    if (dev == FAKE_DEV) cb_saw_fake = 1;
    if (pthread_mutex_trylock(&lock) == 0) {
        pthread_mutex_unlock(&lock);
    } else {
        cb_with_lock_held = 1;
    }
    fake_opened = 1;
    return 0;
}

/* A vid/pid the stand-in does not claim. Real phones are matched by id, so a
 * wrong id must not be injected as if it were one - but dev_aoa still has
 * exactly one device handler, and not reaching it would be silent. */
static int cb_wrong(libusb_context *ctx, libusb_device *dev, int event, void *ud)
{
    (void)ctx; (void)dev; (void)ud;
    cb_calls++;
    cb_event = event;
    return 0;
}

/* Registered for detach only. An arrival must never be delivered here: that
 * would tell carlife a phone left when one had just appeared. */
static int cb_detach(libusb_context *ctx, libusb_device *dev, int event, void *ud)
{
    (void)ctx; (void)dev; (void)ud;
    cb_calls++;
    cb_event = event;
    return 0;
}
"""

# case: (events, vid, pid, callback)
CASES = {
    "any":       (1, -1, -1, "cb_any"),
    "mismatch":  (1, 0x1234, 0x5678, "cb_wrong"),
    "departed":  (2, -1, -1, "cb_detach"),
}

MAIN = r"""
int main(int argc, char **argv)
{
    int handle = 0, i;
    (void)argc;

    libusb_hotplug_register_callback(NULL, EVENTS, 0, VID, PID, -1, CB, NULL, &handle);

    for (i = 0; i < 60 && !hp_landed && !cb_calls; i++) {
        struct timespec ts = {0, 100 * 1000 * 1000};
        nanosleep(&ts, NULL);
    }
    if (!strcmp(argv[1], "mismatch")) {
        struct timespec ts = {0, 500 * 1000 * 1000};
        nanosleep(&ts, NULL);
    }

    printf("\nRESULT calls=%d event=%d fake=%d lockheld=%d landed=%d\n",
           cb_calls, cb_event, cb_saw_fake, cb_with_lock_held, hp_landed);
    return 0;
}
"""


def extract(source):
    start = source.index("/* ---- hotplug injection")
    end = source.index("EXPORT int libusb_init(")
    return source[start:end]


def build(case, work):
    with open(SHIM, encoding="utf-8") as handle:
        source = handle.read()
    events, vid, pid, callback = CASES[case]
    main = (MAIN.replace("EVENTS", str(events))
                .replace("VID", hex(vid) if vid >= 0 else "-1")
                .replace("PID", hex(pid) if pid >= 0 else "-1")
                .replace("CB", callback))
    path = os.path.join(work, "hp_%s.c" % case)
    with open(path, "w", encoding="utf-8", newline="\n") as handle:
        handle.write(PRELUDE + extract(source) + main)
    exe = path[:-2] + ".exe"
    built = subprocess.run([ZIG, "cc", "-O1", "-o", exe, path],
                           capture_output=True, text=True)
    if built.returncode != 0:
        print(built.stderr[:4000])
        raise SystemExit("build failed for %s" % case)
    return exe


def main():
    work = tempfile.mkdtemp(prefix="hp_")
    fails = 0

    def check(name, ok, detail=""):
        nonlocal fails
        print("  %-52s %s%s" % (name, "ok" if ok else "FAIL", "" if ok else "  " + detail))
        if not ok:
            fails += 1

    for case in ("any", "mismatch", "departed"):
        print("%s:" % case)
        run = subprocess.run([build(case, work), case], capture_output=True, text=True, timeout=40)
        out = run.stdout
        result = {}
        for token in out.split("RESULT")[-1].split():
            if "=" in token:
                key, value = token.split("=", 1)
                result[key] = int(value)

        if case == "any":
            check("the attach callback fires", result.get("calls") == 1, str(result))
            check("it is DEVICE_ARRIVED (1)", result.get("event") == 1, str(result))
            check("it is handed our device pointer", result.get("fake") == 1, str(result))
            check("our mutex is not held while it runs", result.get("lockheld") == 0, str(result))
            check("the open is noticed (injection landed)", result.get("landed") == 1, str(result))
            check("the log records the landing", "injection landed" in out, out[-200:])
        elif case == "mismatch":
            check("an unmatched id still reaches the only handler",
                  result.get("calls", 0) >= 1, str(result))
            check("the log admits it was a fallback",
                  "no vid matched" in out, out[-300:])
        else:
            check("a detach-only callback is never given an arrival",
                  result.get("calls") == 0, str(result))
            check("and the run says the injection did not land",
                  "did not land" in out, out[-200:])

    print("\n%s" % ("all hotplug cases pass" if not fails else "SOMETHING FAILED"))
    return 0 if fails else 1


if __name__ == "__main__":
    sys.exit(main())
