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
sink: connected sent=88.1MB drops=0
proto: framed video=4211/88.0MB cmd=56/1204B reseek=0 resync=0
media: 1920x720@30  (the car asked the phone for this size)
cmd 0x00018001 n=1 4B 0801
cmd 0x00018007 n=1 8B 08800f10d005181e
in#1 len=24576 0000000...
annexb: yes  starts=88412 sps=41 pps=41 idr=41 slice=88300
```

## The protocol probe

The bytes copied for the picture also carry CarLife's own framing:

| channel | header | payload |
|---|---|---|
| video | `u32 len`, `u32 ts(ms)`, `u32 0x00020001` | that many bytes of Annex B |
| command | `u16 len`, `u16 pad`, `u32 serviceType` | that many bytes of protobuf |

Packet `0x00018007` (`video encoder init`) is the head unit **asking for a
size**: protobuf field 1 = width, 2 = height, 3 = frame rate. Whatever the
phone encodes, it encodes at that size — which is exactly why CarLife has no
second picture for the cluster, and why any crop setting has to be measured
against a number the car chose instead of one we guessed.

The library therefore classifies instead of assuming. Once per process it
decides whether the stream is framed or bare, counts packets per service type,
keeps the first bytes of each type for a human to read, and decodes those three
fields. `proto:` is the answer:

| `proto:` | what it means | what follows from it |
|---|---|---|
| `framed` | the pipe carries CarLife's headers, command packets included | the size the car asked for is in `media:`, and the copy handed to the app is payload only |
| `raw` | no framing at the head of the stream | the video payload is the whole pipe; sizes have to come from the H.264 SPS |
| `undecided` | not enough traffic yet | connect the phone and open CarLife's navigation |

Two details worth knowing. When the stream is framed, the sink gets **payload
only**, so a decoder never sees a protocol header. And `resync`/`reseek` are
not errors to hide: a stream that does not frame the way CarLife does after
8192 misses is treated as bare and handed over byte for byte, exactly as 0.2
did — the probe is never allowed to cost the picture.

Sink: `/dev/shm/carlife-map/h264.sock` (the decoder listens there). Every inbound chunk — or, when the
stream is framed, just its payload — is also written there for the CarLife Map
app. The socket is optional in every
sense — non-blocking, `MSG_NOSIGNAL` (a closed reader must never raise
`SIGPIPE` inside carlife and kill it), a full buffer drops the chunk instead of
buffering it in carlife's memory, and a missing reader costs one connect
attempt a second. Capture must not be able to hurt the thing it observes.

Marker: `/dev/shm/carlife-tap.loaded`, written by *any* process that loads the
library. The installing tool runs `LD_PRELOAD=… /bin/sh -c ':'` and reads it,
which proves on the unit itself that the library resolves and its constructor
runs — without touching CarLife.

## Installing it into CarLife

It is not installed on its own: it is a `requires` entry of the app
`cn_carlife_map`, so the Store installs it with the app and takes it away with
the app. Installing it from the tools list still works and does the same thing.

`install.sh` runs as root after every install (component.json `postInstall`) and
does three things:

1. **Proves the library loads** on this unit before anything else happens. A
   library that cannot resolve shows up as a carlife process that starts and
   dies, which is a very bad way to find out.
2. **Finds the unit that starts carlife** — from the running process's cgroup
   first, because Cinemo starts carlife as a child of a launcher whose unit file
   never names it; then from `ExecStart`; then from a unit named after it.
3. **Appends to the unit's own `LD_PRELOAD`**, never replaces it: the unit
   already preloads `/usr/lib/libschedeconfig.so.1` into carlife, and
   overwriting that value would silently take it away. The drop-in is
   `/etc/systemd/system/<unit>.d/50-carlife-tap.conf`, and the path it names is
   `/var/opt/carlife-tap/current/libcarlife-tap.so` — the Store's stable path,
   so an upgrade does not leave the unit pointing at a directory that has just
   been deleted.

Because CarLife has to be running for step 2 to read its unit, install while
CarLife is open. When the unit cannot be found, the install **succeeds** and
says so on its last line; the library is simply not preloaded yet, and the next
install after one CarLife session finishes the job. Failing here would roll the
app and the decoder back with it over a step that fixes itself.

It does **not** restart anything. CarLife picks the library up at the unit's
next start, so a head-unit restart is what makes it live; restarting just
carlife while the rest of the Cinemo stack keeps running is the less predictable
option for no gain.

`remove.sh` deletes only the drop-in, the report and the marker — nothing else,
and no unit or payload of the Store's. The Store has no uninstall hook here, so
this is a script to run by hand before uninstalling if the drop-in is to go:
left behind, it names a path that no longer exists, which the loader warns about
and skips — CarLife still starts.

Undo by hand, if ever needed:

```sh
rm -f /etc/systemd/system/*.service.d/50-carlife-tap.conf
systemctl daemon-reload
```

## The decoder

The sink carries **raw H.264**, because that is what leaves the phone: CarLife's
protocol has no map-only channel and no navigation data at all (the vehicle SDK's
navigation module has two states, idle and running). So `carlife-decode` decodes
the picture on the unit and cuts out the two pieces the apps draw:

```
carlife (USB) --tap--> /dev/shm/carlife-map/h264.sock --> carlife-decode
                                                           |        |
                                     live.sock 1088x480 <--+        +--> hud.sock 480x168
                                     (the map)                       (the guidance strip)
```

Both carry the same `CLMF` header the app's other frame sources read, so nothing
in the app needed changing to accept them.

It loads the unit's own Intel MSDK library with `dlopen` — `/usr/lib/libmfxhw64.so`,
API 1.24, with no dispatcher on this unit — plus `libva`, takes a VA display on
`/dev/dri/renderD128`, decodes into opaque surfaces and runs one VPP pass per
picture into system memory. Nothing has to be linked or installed beside it, and
decoding happens in its own process: a decoder that crashes must not take CarLife
with it. `nice -5` so it gets scheduled, and `Restart=always`, because a stopped
decoder is a black cluster and the screen would not say why.

The cut rectangles are percentages of CarLife's own picture, so they do not care
what size the phone was asked for:

```json
{"mapTop":8,"mapBottom":0,"mapLeft":0,"mapRight":0,"mapFit":"fill",
 "mapW":1088,"mapH":480,
 "cardMode":"navi","cardTop":0,"cardBottom":16,"cardLeft":0,"cardRight":24,
 "cardFit":"stretch","cardW":480,"cardH":168}
```

`/dev/shm/carlife-map/crop.json`, written by the app when its settings change and
re-read by the decoder every half second — the settings take effect without a
restart. Flat keys on purpose: the decoder is C with no JSON library, and a
`strstr` plus a `strtod` is all that needs.

`cardW`/`cardH` are the HUD layer's size, so the app writes them from `HUD width`;
anything else there is a frame the layer will refuse without a word. They are
clamped to 640x256 and forced even, as `mapW`/`mapH` are to 1088x480.

`mapFit=filled` and `cardFit=filled` trim the longer side so the layer is not
stretched; `stretch` uses the rectangle as it is. Both the rectangle and its
origin are forced even, because NV12 chroma is a quarter of the picture and an odd
centring puts the colour one column into its neighbour.

Everything the decoder knows about itself goes to `/dev/shm/carlife-decode.txt`,
which the app shows on its status page — the car's screen is the only screen the
user has, so the report has to say which library was loaded, whether the VA display
came up, the picture size, the frame rate and the first call that failed:

```
=== CARLIFE DECODE 17:40:12 pid=812 ===
libs: mfx=libmfxhw64.so va=libva mfxapi=124
state: decoding 1920x720
frames: 812 rate 15 fps last 66ms
sockets: map=on(812) card=on(812) drops=0+0
out: map 1088x480 card 480x168
crop: map t8 b0 l0 r0 fill; card t0 b16 l0 r24 stretch
rect: map 0,106 1280x564; card 0,0 306x114
errors: 0
error: none
```

`out` is what the app will receive, `crop` is what it read, `rect` is what it
last cut. A frame at the wrong size is dropped by cluster-render silently, so
`out` disagreeing with the layer's size is the first thing to look at when the
cluster keeps count of frames and shows none. `errors` counts the pictures lost
to a damaged slice or a busy engine - those restart the session at the next
sequence header and do not stop the process.

## Build

`libcarlife-tap.so` and `carlife-decode` are committed at the top of this
directory, because the Store packs the tool from the repository tree and its
file list names payload by `path` only — one flat name per file, no subdirectory,
no `from`. It is built with **zig**, which carries the unit's glibc headers and
stub libraries, so no container and no compiler install is needed:

```sh
ZIG=/d/zig/zig-x86_64-windows-0.14.1/zig.exe ./build-zig.sh
```

`-target x86_64-linux-gnu.2.27` is the whole point: `check_elf.py` then reads
the result back and refuses it unless it is a 64-bit little-endian x86-64
shared object, names no `GLIBC_` version above 2.27, and really exports `read`
and `ioctl`. A library that asks for a newer symbol fails at load time on the
unit with "undefined symbol" and no screen says why, so the build stops
instead. Its `NEEDED` entries are `libc.so.6` plus `libpthread.so.0` (zig's
glibc stub emits the latter; no pthread symbol is actually referenced).

`build-zig.sh decode` builds the decoder the same way. It is a program, not a
library, so `check_elf.py` holds it to the other rule: it may need only the C
runtime, because it finds MSDK and libva itself. Its MSDK headers are in
`third_party/mfx` (Intel's, MIT, the 1.x subset the unit's 1.24 library takes).

`test/decode_math_test.py` is the decoder's arithmetic again, in Python: the
decoder cannot run on a build machine (it needs the unit's MSDK and a VA display),
but its rectangles can be checked anywhere. It runs the crop settings over the
sizes a phone asks for and asserts the rectangle stays inside the picture, stays
even (NV12 chroma), keeps the layer's aspect, and that every source byte `blit()`
would read is inside the plane it reads from. It found the odd-centring bug that
would have shifted the colour plane by one column.

`make target` produces the same ABI through Docker + Ubuntu 18.04 and is what a
CI job would run; `build-zig.sh` is for a machine without Docker.

The test needs Linux, because it preloads the library into a process that
opens, writes and reads a file and calls an unknown usbfs ioctl: the bytes must
come back unchanged, the ioctl must still return `ENOTTY`, and the report must
appear. `CARLIFE_TAP_FAKE` stands a path prefix in for the phone's usbfs node
so the parser can be exercised where there is no USB. It runs the library over
two streams — one with CarLife's headers, one without — because the probe has
two answers to get right, and the second must still pass through byte for byte.
On Windows the library can only be built, not exercised.

## State

0.4.0 — captures, classifies, decodes, and delivers both pictures; installed and
removed as a `requires` entry of `cn_carlife_map`. `install.sh` finds the unit
(running process, then `ExecStart`, then file name), keeps the unit's own
`LD_PRELOAD`, and adds this library; `remove.sh` takes it back out. The decoder
is a unit of its own (`carlife-decode.service`), enabled with the tool and
restarted on upgrade.

What is still unproven is the decode itself: `libmfxhw64` + `libva` on this unit
have never been driven by anything but CarLife, so the first install answers
whether the session, the opaque pool and the VPP pass behave as the reference
decoder says they do. The report is written for exactly that question — if it
stops at a call, that call is named.

0.3.0 added the protocol probe, and with it the one number that was missing until
then: whether the pipe carries CarLife's command channel, and at what size the car
asked the phone to encode.
