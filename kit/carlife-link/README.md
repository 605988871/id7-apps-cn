# carlife-link

The head unit side of Baidu CarLife over Wi-Fi: find the phone, connect its six
channels, run the handshake, take the picture and the sound bytes, and send
touch back. It is the second half of a wired-to-wireless CarLife box, running on
the unit itself so there is no box.

## Why it has to exist

The unit's own `carlife` process speaks CarLife over USB AOA only. The probe of
2026-11-20 found a usbfs handle in `carlife` and **no TCP port listening at all**
(7240/8240/9240/9340 all closed), so nothing on the unit can be pointed at a
phone over the network: the wireless transport simply is not compiled into it.

Baidu keeps that part closed. The vehicle library they published
(`apollo-DuerOS/CarLife-Vehicle-Lib`, which is what a Linux head unit is built
from) says so in its own README: *"CarLife+ currently supports wireless
connection. There is no open source code of the wireless connection part."* A
box gets around this by being a phone to the car over USB and a head unit to the
phone over Wi-Fi. This tool is the Wi-Fi half, and it is the half that has to be
written from the wire up.

## Who listens where

On Wi-Fi the **phone is the server** and the head unit is the client - the
opposite of USB, where `carlife` hosts the sockets and the phone connects.
Six channels, six TCP ports on the phone, offset from a 7240 base:

| channel | port | carries |
|---|---|---|
| cmd | 7240 | handshake, encoder control, module state - protobuf |
| video | 8240 | H.264 Annex-B |
| media | 9240 | PCM, music |
| tts | 9241 | PCM, navigation prompts |
| vr | 9242 | PCM, microphone (head unit -> phone) and its answers |
| touch | 9340 | touch and hard keys (head unit -> phone) |

The 8-byte AOA header `[chan u32][len u32]` exists **only over USB**. Over TCP
each channel is a connection of its own and the inner frame travels alone:

```
cmd / touch     [len u16][reserved u16 = 0][service type u32][protobuf]
video / audio   [len u32][timestamp u32][service type u32][payload]
```

Service types carry their direction in bit 15 of the low half: `0x00018001` is
head unit to phone, `0x00010002` is phone to head unit, `0x00068001` is a touch
action, `0x00020001` is a video payload.

## What the handshake actually is

The first message on the cmd channel must be the version; a phone that matches
answers `0x00010002`, and only then may the picture be asked for. What this tool
does, in order:

```
HU -> phone   0x00018001  protocol version {1,0}        08 01 10 00
phone -> HU   0x00010002  match status                   08 01
phone -> HU   0x00010004  MD_INFO            (logged, not answered)
HU -> phone   0x00018027  statistics (version name/code; the rest is Baidu's telemetry)
HU -> phone   0x00018007  video encoder init {w,h,fps}
phone -> HU   0x00010008  encoder init done {w,h,fps}
HU -> phone   0x00018009  start
phone -> HU   video channel: [len][ts][0x00020001] + Annex-B, len 0 = keepalive
HU -> phone   touch channel: [len][0][0x00068001] + {action,x,y in encoded pixels}
```

`--hu-info` adds `0x00018003` (device info). It is off by default: its field
numbers are the ones a head unit *was seen* to use, the phone only logs it, and
a wrong field number is worse than a message that is missing.

## Finding the phone

Nothing tells the unit the phone's address: on a hotspot it is whatever DHCP
handed out, and the unit's own DHCP lease table is not ours to read. So the port
that only a CarLife phone answers is the beacon: `--find` opens `7240` on every
neighbour of the unit's own /24s, a batch of 48 at a time with 400 ms per batch,
and the first one that accepts is the phone. On a /24 that is about 2.5 s, and it
repeats every 5 s while nothing is connected.

## The control port (how the app's touch gets in)

`--ctl 7399` listens on `127.0.0.1` only. One client at a time, one command per
line:

```
down 5000 5000      # finger down at 0.5, 0.5 of the picture (0..10000 of each axis)
move 5100 5200
up 5000 5000
key 20              # a hard key by code (BACK = 0x0E, OK = 0x14, ...)
retry               # drop everything and connect again
```

Coordinates are normalised because the app does not know what size the phone
chose; the tool turns them into encoded pixels after `encoder init done`. A
touch that arrives before the picture size is known is dropped and counted, not
guessed at.

## The report

`--report /dev/shm/carlife-wireless/report.txt`, rewritten once a second, one
`key: value` per line - `state`, `host`, `cmd`, `video`, `stream`, `audio`,
`touch`, `error`. The app draws it, so it is also the only debugging channel the
car has: everything that decides a picture is a line on that screen.

## Testing it without a car

The phone side is a file. `test/fake_md.py` listens on all six ports, answers the
handshake, pumps an Annex-B stream whose SPS/PPS/IDR are where a real one has
them, and records every message it receives. `test/test_link.py` builds both
binaries and checks 35 things against it - the version frame is byte-exact, the
size is asked for only after the match, a tap at 0.5/0.5 of 1280x720 arrives as
640,360, a decoder that reads the pipe too slowly does not stall the session,
the unit's binary names the loader the unit actually has.

```sh
python test/test_link.py
```

The same two pieces test a **real phone** with no car in the loop: put a laptop
and the phone on one hotspot, start the phone's CarLife wireless connection, then

```sh
./build.sh --dev
./link.exe probe --host <phone-ip>        # are the six ports really there?
./link.exe run --host <phone-ip> --video phone.h264 --report report.txt
```

`probe` prints what each port answered, including the first bytes the phone sends
back. That is the experiment that decides everything below.

To see and touch the phone's screen from the laptop - the stand-in head unit:

```sh
python test/preview_window.py --host <phone-ip>
python test/preview_window.py --replay phone.h264     # no phone needed
```

`--replay` plays a captured stream through the same pipe, which is how the
window and the decoder get checked without a phone awake.

Four things in that pipe are load-bearing, and the first three each looked like
a phone stuck on its launch page until they were found:

* `-fflags nobuffer` makes the demuxer give up after a couple of frames on a
  pipe. `-flags low_delay` is what actually keeps the delay down.
* A `QImage` built over a Python buffer only keeps a pointer to it; Qt then
  draws from freed memory. The window hands the reader's refcounted bytes
  straight to a painter that draws them inside the same call.
* The link writes the stream from its own thread with a bounded backlog, so a
  slow reader drops frames instead of stalling the socket loop - which used to
  freeze the command channel and leave the phone's state machine on its splash.
* **Nothing is scaled on the CPU.** ffmpeg hands over the native 1920x1080 and
  the picture is a `QOpenGLWidget`, so the scale to the window happens in the
  texture unit. This is not a micro-optimisation: with Windows at 200%, a plain
  `QLabel` smoothed the pixmap up to 2560x1440 on the CPU every frame and capped
  the window at **19 fps**, against 100 fps after the change on the same
  capture. `--scale 1280x720` brings back the ffmpeg scale for a machine that
  would rather spend CPU than bandwidth.

The pointer stays visible over the picture on purpose - a blank cursor makes a
drag feel like it happens somewhere else.

## What is proven, and what only the car can answer

Proven here: the framing, the handshake order, the video accounting, the touch
encoding, the discovery loop, and both builds.

Not proven, because it needs the phone and then the car:

1. **Does the phone open those ports for a plain Wi-Fi client?** The community
   notes say the phone's CarLife is the server and describe Wi-Fi Direct
   (`WifiP2pInfo.groupOwnerAddress`) as the way the two sides meet. A phone that
   only accepts a P2P group owner would need `p2p_connect` on the unit instead of
   an AP - `probe` answers this in one minute.
2. **Version 1 or 2.** `--major 2` makes the phone send a longer start batch; the
   unit's own CarLife is old enough that 1.0 is the right first guess.
3. **The audio channels.** They are drained and counted here (that alone proves
   the phone is sending them); playing PCM on this unit is a separate question -
   Cinemo owns the audio devices.
4. **The picture.** Not decoded yet. That is the next step and it is the unit's
   MSDK decoder (as `carlife-decode` did for the USB tap), fed from
   `--video`'s stream instead of a socket.

## Build

```sh
./build.sh          # the unit's binary (glibc 2.27, /lib/ld-linux-x86-64.so.2)
./build.sh --dev    # this machine's, for fake_md.py
```

`test/elf_check.py` reads the result back and refuses a program that is not
64-bit little-endian x86-64 or that names `/lib64/...`, because on this unit that
is a program which exists, is executable, and cannot start.
