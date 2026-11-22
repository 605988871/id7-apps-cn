# carlife-shim

An `LD_PRELOAD` library for the unit's own `carlife`. This build only watches.

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

Two files under `/dev/shm/carlife-shim`, both world-readable — the app that shows
them is not root. A third, the install record, also lives under
`/var/opt/carlife-shim/current` so that it outlives a reboot.

`state.txt`, rewritten twice a second, a dozen lines, is what the app draws:

```
state: tap
pid: 15803  comm: carlife
devices: 1d6b:0003 0424:2530 2d95:7000 0424:4502 090c:1000 1d6b:0002
config: cfg1, 2if: if0 ff/ff: 81/a02/512 01/a02/512 if1 ff/42: 02/a02/512 82/a02/512
open: open 18d1:2d01 ok
ctrl: 11 calls, reqs 51 52 53
in:  4266 calls, 3922 KB
out: 24 calls, 0 KB
last in: ep=0x81 chan=2001 len=262136, 652 of 262144 bytes
last out: ep=0x01 10 bytes
async: 4301 submits, 8552 loops
frames: 1203 in / 44 out, 0 resync, 1000x42 2000x23 2001x1130
log: 256 KB of 256, writes 73
```

**A transfer is not a message.** This is what the first reading on the car got
wrong, so it is worth being blunt about it: a 200 KB picture does not arrive in
one `libusb_bulk_transfer`, and only the *first* of its bulk reads starts with
the `[chan][len]` header. Reading the first eight bytes of every transfer
reported `chan=2147614720 len=3641496067` on a 652-byte read — picture data where
a channel number was expected. `frames:` is that fixed: the shim walks each
endpoint's bytes as one stream, so the counters land on message boundaries. It is
the line that says whether `[chan][len]` is really the framing on this unit
(`0 resync`), which channel carries the picture (`2001` dominating), and how many
messages a second the phone sends. `resync` counts the places where a header was
not where a header should be; anything but zero means the layout assumption is
wrong and the stand-in device has to be rethought, not tuned.

`test/framer_test.py` lifts those functions out of `shim.c` and runs six cases
against them — split messages, two messages in one transfer, a mid-message chunk,
zero-length messages, garbage then a clean message — because a wrong count in
there looks like a quiet channel, which is the hardest kind of wrong to notice
from the screen.

`tap.txt` is the call log, one line per call, capped at 256 KB so a long drive
cannot fill shm. The first three transfers of each endpoint carry the first
sixteen bytes in hex; after that only every two-hundredth line survives, or the
log is sixteen kilobytes of video per second and nothing else. Errors and short
reads are always kept.

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

## What it does not do yet

It does not replace anything. The next build is the one that presents a device
carlife can open when no phone is on the port, and bridges the bulk packets to
the phone over TCP on the same channel offsets `carlife-link` already uses
(`0, 1000, 2000, 2001, 2002, 2100` added to `7240`). What this session buys is the
call sequence, the interface and endpoint shape a stand-in has to present
(`cfg1, 2if`, class `ff`, `81` in / `01` out with 512-byte packets), and — from
`frames:` — the channel numbers with their traffic share, so the bridge has
something to check itself against before it is driven.

One thing to keep in mind for that build: carlife moves data with the **async**
API (`async: … submits`), so a stand-in has to *complete* transfers rather than
return bytes from a blocking call.

## Build

```sh
./build.sh
python test/framer_test.py     # the stream framer, six cases
```

`zig cc -fPIC -shared -target x86_64-linux-gnu.2.27`, then
`test/elf_so_check.py`: ELF 64-bit LE x86-64, `e_type` is `ET_DYN`, **no
`PT_INTERP`** (a library that names an interpreter was linked as a program and
will not preload), the six symbols the shim exists for are really exported, and
no `GLIBC_2.33+` version strings — a `.so` asking for a newer glibc fails to
load into a 2.27 process with "version not found", and the visible symptom is
carlife not starting.
