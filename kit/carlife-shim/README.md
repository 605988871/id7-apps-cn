# carlife-shim

An `LD_PRELOAD` library for the unit's own `carlife`. Up to 0.5.0 it only
watched. From 0.6.0 it takes over: with no phone on the port it presents a
device carlife can open, answers the AOA handshake itself, and carries channel
traffic to a machine on the other end of the ENET cable.

## Two halves, and they fail separately

| | what it does | seen in |
|---|---|---|
| the stand-in | adds a fake AOA device to the enumeration, answers 51/52/53, hands out a two-interface config (`if0 ff/ff 81-in 01-out`, `if1 ff/42`) | `open -> 0 (stand-in 18d1:2d01)`, `fake: on (switched)` |
| the bridge | reassembles `[chan][len][body]` out of carlife's writes and forwards whole messages over TCP; does the reverse for reads | `bridge ch2 -> 169.254.x.x:8240` |

The fake device is appended **behind** the real enumeration, never in front of
it, so a phone that is actually plugged in still sorts first. Two switches turn
it off without touching the Store: `CARLIFE_SHIM_FAKE=0` in the environment, or
a file `/dev/shm/carlife-shim/nofake`.

Ports are the channel number times a thousand plus 7240 — channel 1 control on
7240, channel 2 video on 8240, channel 3 media on 9240. The far side listens;
this side connects. Where to connect is `CARLIFE_SHIM_PEER`, else
`/var/opt/carlife-shim/current/peer.txt`, else the one other complete entry in
`169.254/16` in `/proc/net/arp` — the last one because a laptop's link-local
address is not a constant and an address baked in at install time goes stale the
first time the cable moves.

TCP carries the **whole message**, header included, not the bare body. That is
what keeps this side free of channel semantics: it never has to know that
channel 1 frames with a `u16` length and channel 2 with a `u32`, only that eight
bytes say where the next message ends.

## Why this shape

The probe of 2026-11-22 (see `kit/carlife-probe`) settled what the USB port
carries when a phone is plugged in:

| Fact | Value |
|---|---|
| device | `18d1:2d01` — Google's accessory VID, `2D01` = accessory + audio |
| carlife holds | `/dev/bus/usb/001/005` (`usbfs: yes`, 1 handle) |
| network | `usb-net: (none)` — no `usb0`, no `rndis`, 19 sockets all unix |
| libs mapped | `libusb-1.0.so.0`, `libmfxhw64-p.so.1`, `libva`, `libva-drm` |

So the CarLife messages ride **inside AOA bulk packets**, and Baidu's own patent
for this (`CN106844275A`, table 1) gives the packet:

```
[Channel ID u32][Msg Len u32][CarLife Msg ...]
```

That is the same eight-byte header this repository documented from the first
capture as "exists only over USB" — over TCP each channel is a connection of its
own, so the header has nothing to say.

Which means the transport is a pipe of *labelled* packets. A library between
carlife and libusb can hand carlife those same packets, except they come from a
socket to the phone instead of a cable. Everything above the transport stays the
car's own: its decoder (`libmfxhw64` is already mapped — hardware H.264 on this
unit), its UI, its HUD and cluster projection, its steering wheel keys. Nothing
in this kit reimplements CarLife and nothing in it draws a pixel. That is the
whole reason to go at it this way: the box is replaced, but the car keeps
everything the box used to feed.

## Why watching comes first

A stand-in has to answer precisely what carlife asks, because the process it
runs inside is the one the car cannot do without. Guessing at any of these
crashes it:

- does carlife enumerate with `libusb_get_device_list`, or open by VID/PID?
- which interface does it claim, and does it set an alternate setting for the
  isochronous audio endpoint?
- how big are its bulk reads? (16 KB and 1 MB imply different buffer handling)
- sync `libusb_bulk_transfer`, or async `libusb_submit_transfer` plus an event
  loop? A stand-in has to *complete* transfers in the second case, which is a
  different shape of work.
- which channel numbers actually appear in the header, and does the length in
  the header always agree with the transfer size?

Every one of those is a line in `tap.txt` after one ordinary wired session.

## What it writes

Three files under `/dev/shm/carlife-shim`, all world-readable — the app that shows
them is not root. A fourth, the install record, also lives under
`/var/opt/carlife-shim/current` so that it outlives a reboot.

`state.txt`, rewritten twice a second, thirteen lines, is what the app draws:

```
state: tap
pid: 2783  comm: carlife
devices: 1d6b:0003 0424:2530 2d95:7000 0424:4502 090c:1000 1d6b:0002
config: cfg1, 2if: if0 ff/ff: 81/a02/512 01/a02/512 if1 ff/42: 02/a02/512 82/a02/512
open: open 18d1:2d01 ok
ctrl: 11 calls, reqs 51 52 53
io: 1607 in 3601 KB, 18 out 0 KB
first in: 00000001 0000000a 8B
first out: 00000001 0000000c 8B
last in: ep=0x81 00000f00 05ee6d31 not a header
last out: ep=0x01 00000001 00018009 not a header
frames: 34 in / 12 out, aligned, 1x4 2001x30
async: 1636 submits, 3259 loops
fake: on (switched), claims 1, bulk 812/34, 169.254.x.x
bridge: ch2 -> 169.254.x.x:8240
```

`fake:` is the stand-in's line. `switched` is the milestone — carlife took the
fake device through the AOA handshake and asked it to come back as an accessory,
which is the point where a real phone would start streaming. `bulk` counts the
transfers the bridge handled in each direction. `bridge:` names the last channel
that connected or the reason it did not, and it is the line to read when the
picture is black: `refused` means the far side is not listening, `no peer` means
the address could not be worked out, `closed by peer` means it was and went away.

`first in` and `first out` are the first transfer of each direction after
`libusb_open`, printed as the two four-byte words the framer reads plus the size
that arrived, in wire order. **Both words are big-endian**, like every length in
the CarLife protocol — `00000001 0000000a` is channel 1 carrying ten bytes, and
reading the same eight bytes little-endian gives channel 16777216 with a length
of 167772160. The first build read them the wrong way round and the framer
counted picture data as messages: seventeen messages on a channel 512 that does
not exist. The lesson is on the screen now — `first in` carries the raw bytes, so
a wrong reading is visible rather than plausible.

An eight-byte transfer is the normal shape of a header on this unit: the phone
writes the header, then the body, and the driver keeps them apart. That is what
makes `[chan][len]` checkable at all.

**A transfer is not a message.** This is what the first reading on the car got
wrong, so it is worth being blunt about it: a 200 KB picture does not arrive in
one `libusb_bulk_transfer`, and only the *first* of its bulk reads starts with
the `[chan][len]` header. Reading the first eight bytes of every transfer
reported `chan=2147614720 len=3641496067` on a 652-byte read — picture data where
a channel number was expected. `frames:` is that fixed: the shim walks each
endpoint's bytes as one stream, so the counters land on message boundaries.

The second reading then exposed a worse fault in the same line. Once the framer
decided a header was not a header it gave up *until the next transfer*, which on
a stream that begins mid-message means it never recovers: the car reported
`frames: 1 in / 0 out, 229 resync` after 2777 transfers. It now slides one byte
and looks again, which is what makes a framer self-synchronising. `aligned` means
it never had to slide — `[chan][len]` was found at every boundary and a stand-in
device can be written against it. `slid N` means it did, and the number says how
far from a clean parse the assumptions are.

Two tests keep that honest. A header is only believed when the channel is small
(`<= 10000`), the length is at most 8 MB, **and the length is not zero**: eight
zero bytes pass every other check, and a stream of them inside a picture is the
commonest way to lock onto nonsense. `test/framer_test.py` lifts the functions
out of `shim.c` and runs eight cases — split messages, two messages in one
transfer, a mid-message chunk, an empty message, garbage then a clean message,
the car's own case of a picture that starts mid-frame with a header after it,
and a header that arrives as a transfer of its own — because a wrong count in
there looks like a quiet channel, which is the hardest kind of wrong to notice
from the screen.

`tap.txt` is the call log, one line per call, capped at 256 KB so a long drive
cannot fill shm. The first three transfers of each endpoint carry the first
sixteen bytes in hex; after that only every two-hundredth line survives, or the
log is sixteen kilobytes of video per second and nothing else. Errors and short
reads are always kept.

`head.txt` is the small one, and it is the one that settles the argument: the
first eight transfers of each direction, twenty-four bytes each, with the size
requested and the size that arrived.

```
carlife-shim head - pid 9694
in 2382 bytes, 8 transfers
  t1 @0 want=262144 got=652  00000280 43060bd9 00000280 43060bd9
  t2 @652 want=262144 got=652  00000280 43060bd9 00000280 43060bd9
out 40 bytes, 3 transfers
  t1 @0 want=512 got=10  00000006 00068008 0000
```

A contiguous window would only have shown the first of those reads, and the
question is precisely whether the second one starts the same way. The file is
written while it fills and then frozen, so its mtime settles and the screen can
page it without redoing the layout twice a second.

`boot.txt` is the install's record, and it is written twice: to
`/var/opt/carlife-shim/current/boot.txt`, which survives a reboot, and to
`/dev/shm/carlife-shim/boot.txt`, which the probe reads first. The shm copy alone
was a mistake — `/dev/shm` is empty after every boot, so a reboot made a failed
install look exactly like an install that never ran, and those two need different
repairs.

## How it gets into carlife

`install.sh` writes one file, `/etc/systemd/system/<unit>.d/carlife-shim.conf`:

```
[Service]
Environment=LD_PRELOAD=/var/opt/carlife-shim/current/carlife-shim.so
```

It never edits the unit itself, so the rollback is `rm` of one file, and
`remove.sh` does exactly that. Five things it does in order, each because the
failure it prevents is invisible from the outside:

1. `LD_PRELOAD=$SO /bin/sh -c ':'` first — a `.so` built against a newer glibc
   fails *here*, before carlife is restarted, with the reason in `boot.txt`.
2. the unit is found by asking the running process (its cgroup), not by guessing
   a name; falling back to scanning `ExecStart=...carlife`.
3. `/` is remounted read-write if it is not: this unit ships a read-only root, and
   every write below would otherwise fail without a word — the drop-in simply
   never appears, and the restart that follows proves nothing. The write is read
   back before anything is restarted, and `/` goes back to read-only afterwards.
4. restart, then **look**: is the library in the new process's `maps`, and is
   the process still there after two seconds?
5. if not, the drop-in is removed, `daemon-reload`, restart again, and
   `boot.txt` says "rolled back". A tool that leaves carlife down is worse than
   no tool.

## What 0.6.0 does, and what it still does not

The five questions above were answered by the 0.4.0/0.5.0 sessions and are why
this build is short: carlife calls `libusb_get_device_list`, picks one device,
opens it, claims interface 0, and then uses the **synchronous** API with a
204800-byte read buffer and a one-second timeout.

The async question was answered the other way round from what it looked like.
`async: 1636 submits` does not mean carlife uses `libusb_submit_transfer`: every
one of those submits is libusb's own, made inside `libusb_bulk_transfer`. Two
things prove it. `submit ep=0x81 type=2 len=204800` is followed immediately by
`bulk in ep=0x81 want=204800` — the same length, because one is the inside of
the other. And the control transfers show `submit ep=0x00 type=0 len=263` for a
255-byte descriptor read: 263 is 255 plus the eight-byte setup packet, which is
how an async control transfer counts its buffer and how a synchronous caller
never does.

That distinction is the whole reason the bridge is a few hundred lines instead
of a transfer lifecycle: intercepting a blocking call means returning bytes, and
intercepting `submit_transfer` would have meant completing transfers from an
event loop of our own.

What is still missing is the picture. The bridge carries whatever the far side
sends; `kit/carlife-phone/fake_phone.py` does the handshake and replays a real
H.264 file picture by picture, but nothing here encodes video, and channel 3
(media, 3840-byte packets at 31/s on this unit) is counted and forwarded without
being understood.

One limit changed because of the capture: a body is handed back **whole**, up to
the caller's 204800-byte buffer, not sliced at 16 KB. The device carlife
normally talks to filled single transfers of 94113 bytes, so a message and a
transfer are the same thing on this link; slicing would only work if carlife
reassembled across reads, and if it does not, the symptom is a channel of
garbage rather than an error. Each message now leaves as two transfers, header
then body, exactly as the phone does it.

## Build

```sh
./build.sh
python test/framer_test.py                          # the stream framer, eight cases
python test/bridge_test.py                          # both bridge directions, eight cases
python ../carlife-phone/fake_phone.py --selftest    # the wire format
python ../carlife-phone/fake_phone.py --loopback    # the whole handshake
```

`zig cc -fPIC -shared -target x86_64-linux-gnu.2.27`, then
`test/elf_so_check.py`: ELF 64-bit LE x86-64, `e_type` is `ET_DYN`, **no
`PT_INTERP`** (a library that names an interpreter was linked as a program and
will not preload), the six symbols the shim exists for are really exported, and
no `GLIBC_2.33+` version strings — a `.so` asking for a newer glibc fails to
load into a 2.27 process with "version not found", and the visible symptom is
carlife not starting.

## Running it on a bench

The far side first, so its listeners are up before carlife restarts and starts
connecting:

```sh
cd kit/carlife-phone
python h264stream.py make out/test.h264 --seconds 10
python fake_phone.py --h264 out/test.h264
```

It prints the three listeners, then every command the unit sends, then
`video 1920x720, 300 pictures, 10 keyframes` once the unit asks for video. Then install
`carlife-shim` 0.6.0 from the Store; `install.sh` restarts carlife, and the
stand-in is on from that moment. On the unit, **CarLife 诊断 → 接管记录** should
show, in this order:

```
stand-in on (ports 7240/8240/9240 for channels 1/2/3)
libusb_init -> 0
get_device_list -> 7
  dev 6: 2d95:7000 class=00 cfgs=1 (stand-in)
open -> 0 (stand-in 2d95:7000)
ctrl rt=c0 req=51 val=0 idx=0 len=2 -> 2  0200
ctrl rt=40 req=52 ... -> 5
ctrl rt=40 req=53 val=0 idx=0 len=0 -> 0 (stand-in)
fake: AOA START - switching to 18d1:2d01
close (stand-in)
open -> 0 (stand-in 18d1:2d01)
get_active_config -> 0 (stand-in)
cfg1, 2if: if0 ff/ff: 81/a02/512 01/a02/512 if1 ff/42: 02/a02/512 82/a02/512
claim_interface(0) -> 0 (stand-in)
bridge ch1 -> 192.168.x.x:7240
```

and the bench should answer:

```
cmd   protocol 2.0
cmd   head unit wants identity
cmd   encoder 1920x720@30
cmd   start video
```

If the log stops at `get_device_list`, the fake device did not get picked.
If it stops at `ctrl req=51`, carlife opened the device but did not get to the
handshake. If it reaches `bridge ch1` and the bench sees nothing, the port or
the address is wrong and `state.txt`'s `bridge:` line says which. If it reaches
`start video` and the picture is black, the handshake worked; check that the
bench printed `video ... pictures` too. If it printed
`WARNING stream is 1280x720 but the unit asked for 1920x720`, the stream and the
encoder settings disagree and the decoder has nothing sensible to do — pass a
`--h264` made at the size the unit asked for.

Every one of those lines is world-readable in
`/dev/shm/carlife-shim/tap.txt`, so this works without ssh: the same text is on
the diagnostic screen.

