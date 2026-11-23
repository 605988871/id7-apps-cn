# carlife-phone

The phone end of the bench, for `kit/carlife-shim` 0.6.0. It listens on the
three CarLife channels and answers the handshake, so a unit with no phone on the
USB port has something on the other end of the wire.

```sh
python h264stream.py make out/test.h264 --seconds 10   # a stream worth looking at
python fake_phone.py --h264 out/test.h264              # handshake, then video
python fake_phone.py --selftest                        # wire format, no unit
python fake_phone.py --loopback                        # handshake against ourselves
python fake_phone.py --loopback out/test.h264          # replay a file, prove no byte moved
```

## Ports

Every write on these ports carries the eight-byte `[chan][len]` header, in
network order, exactly as it appears on the unit's USB link:

| port | channel | payload after the header |
|---|---|---|
| 7240 | 1 control | `[u16 len][u16 0][u32 type]` + protobuf |
| 8240 | 2 video | `[u32 len][u32 ts][u32 0x00020001]` + one Annex-B NAL |
| 9240 | 3 media | counted, not parsed yet |

Keeping the header on the TCP side is a deliberate trade: it is what lets the
shim stay a byte pipe that never parses a channel's inner format, and the shim
is the one part of this that cannot be tested off the car. The cost is that
these ports are shim-shaped rather than CarLink-Lab-shaped - CarLink-Lab writes
bare payload on 7240/8240 because the real wireless path has no USB framing.

## Video: what the unit actually does

Three details were read off the unit's own session rather than assumed, and each
of them changes the shape of the sender:

1. **A picture is not one message.** A four-NAL keyframe arrived as four
   messages, all with the same `ts`. The sender cuts the stream into NAL units
   and writes one message each.
2. **The payload is Annex-B**, starting `00 00 00 01` - not AVCC with a length
   prefix.
3. **`ts` is Unix seconds.** The traffic carried `1795395829`, which is
   2026-11-23; a monotonic millisecond clock cannot be that number. Frames one
   to two milliseconds apart shared a timestamp and the value stepped by 1
   across a second of video.

`h264stream.py` does the cutting, and `--loopback <file>` is what keeps it
honest: it sends a whole file through the real sockets and compares what comes
out with what went in, byte for byte, then decodes the result with ffmpeg.

```
all 1086763 bytes came back unchanged          ok
621 messages for 300 pictures                  ok
reassembled stream decodes to 300 frames       ok
```

## Making a stream

`h264stream.py make` runs ffmpeg (PATH, `$FFMPEG`, or the copy bundled with
`imageio-ffmpeg`) and produces 1920x720@30, x264 baseline, ~850 kbps - the
geometry the unit asks for in `VIDEO_ENCODER_INIT`, and a bitrate near the
1.5 Mbps its real session ran at. The picture is a frame counter plus a bar that
sweeps once a second: a jumping counter means dropped frames, a stuttering bar
means wrong pacing, a black screen means nothing arrived.

`aud=1` puts a delimiter in front of every picture so the split is exact instead
of heuristic; `repeat-headers=1` puts SPS/PPS before every IDR so a decoder that
joins mid-stream still works.

```sh
python h264stream.py check out/test.h264
# 1086763 bytes, 621 NALs, 300 pictures, 10 keyframes, 300 AUD, geometry (1920, 720, 66)
```

## What a good run prints

```
cmd   protocol 2.0
cmd   head unit wants identity
cmd   encoder 1920x720@30
cmd   start video
video 1920x720, 300 pictures, 10 keyframes, 1061.3 KiB
video 30 pictures sent
```

`start video` is where a real phone begins encoding. Without `--h264` this prints
`no --h264 given: handshake only, nothing to send` and the screen stays black on
purpose - that is the handshake succeeding, not failing.

## Where the numbers come from

Not from a specification. The packet layouts and the 1920x720@30 encoder
settings are the bytes this unit's own wired CarLife session put on the bus
(`kit/carlife-shim/README.md`), cross-checked against the phone-side
implementation in `CarLink-Lab`. `--selftest` decodes the unit's captured
`VIDEO_ENCODER_INIT` payload to prove the reader agrees with the capture.

## One thing it does not do

It does not capture live. It replays a file, which is enough to prove the pipe
and to see a moving picture; feeding it from a screen capture through a pipe is
the next step, and nothing above has to change for it.
