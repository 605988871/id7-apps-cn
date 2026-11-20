# carlife-tap

The copy point for CarLife's picture: an `LD_PRELOAD` library that watches what
the projection process reads from the phone and writes a short report. It is
the first half of putting CarLife's map on the instrument cluster and the HUD.

## Why it has to exist

Maps on cluster works for CarPlay because the **phone** renders a second,
cluster-shaped stream: patching `/usr/bin/carplay` into advertising the cluster
display is enough, and the head unit only joins the stream that arrives.

CarLife has no such thing. One stream leaves the phone, over USB AOA
(`ff/42/01`, a usbfs handle in the `carlife` process), and on this unit
(probe 1.0.1, 2026-11-20) nothing else can see it:

| what we looked for | what the unit answered |
|---|---|
| a decoded frame shared with another process | `dma=8` inside carlife, but `/dev/shm` holds only navigation data and no `memfd:` is mapped: the frames never leave the process |
| a second output to configure | `cinemo_options.xml` has no `kombi`/`alternate`/`sink` key to switch on |
| the stream on the network | no TCP at all: 7240/8240/9240/9340 are not even listening |
| passive USB capture | no `usbmon.ko` in `/lib/modules/4.14.198-apl` |
| building a hook on the unit | no `gcc`, `cc`, `make`, `python3` |

So the picture has to be taken from inside `carlife`. This library is that
hook; `decoder_msdk.cpp` and the cluster-render client (the same ones Maps on
cluster uses) are the other half.

## What it does

It interposes exactly two calls and forwards both to the kernel unchanged:

- `read()` — the bulk endpoint read straight off the usbfs handle
- `ioctl()` — the same endpoint by URB (`SUBMITURB`/`REAPURB`) or
  `USBDEVFS_BULK`, which is how userspace drivers actually move the data

It never rewrites a byte. `open()` is deliberately **not** interposed: the unit
already preloads `/usr/lib/libschedeconfig.so.1` into carlife, and a
configuration shim is the one thing likely to care about `open`. A usbfs
descriptor is recognised through its `/proc/self/fd` link, once, then
remembered. Both hooks forward with raw syscalls rather than
`dlsym(RTLD_NEXT)`, so neither library can shadow the other.

Report: `/dev/shm/carlife-tap.txt`, rewritten at most every 2 s —

```
=== CARLIFE TAP 15:22:31 pid=3120 ===
usb fd: 27 -> /dev/bus/usb/001/009
claim: interface 1
urbs: in=1234 (88.1MB) out=56 (1.5MB) submits=1290
in#1 len=24576 0000000...
annexb: yes  starts=88412 sps=41 pps=41 idr=41 slice=88300
```

Marker: `/dev/shm/carlife-tap.loaded`, written by *any* process that loads the
library. The installing tool runs `LD_PRELOAD=… /bin/sh -c ':'` and reads it,
which proves on the unit itself that the library resolves and its constructor
runs — without touching CarLife.

## Build

`bin/libcarlife-tap.so` is committed, because the Store packs the tool from the
repository tree. It is built with **zig**, which carries the unit's glibc
headers and stub libraries, so no container and no compiler install is needed:

```sh
ZIG=/d/zig/zig-x86_64-windows-0.14.1/zig.exe ./build-zig.sh
```

`-target x86_64-linux-gnu.2.27` is the whole point: `check_elf.py` then reads
the result back and refuses it unless it is a 64-bit little-endian x86-64
shared object, needs nothing but `libc.so.6`, names no `GLIBC_` version above
2.27, and really exports `read` and `ioctl`. A library that asks for a newer
symbol fails at load time on the unit with "undefined symbol" and no screen
says why, so the build stops instead.

`make target` produces the same ABI through Docker + Ubuntu 18.04 and is what a
CI job would run; `build-zig.sh` is for a machine without Docker.

The test needs Linux, because it preloads the library into a process that
opens, writes and reads a file and calls an unknown usbfs ioctl: the bytes must
come back unchanged, the ioctl must still return `ENOTTY`, and the report must
appear. `CARLIFE_TAP_FAKE` stands a path prefix in for the phone's usbfs node
so the Annex-B parser can be exercised where there is no USB. On Windows the
library can only be built, not exercised.

## State

0.1.0 — reports only; nothing is installed into CarLife yet. The next version
adds the drop-in for `carlife.service` (appending to the existing `LD_PRELOAD`,
never replacing it), the install-time smoke test above, and a guard that
removes the drop-in if CarLife does not come back up.
