# carlife-phone

The phone end of the bench, for `kit/carlife-shim` 0.6.0. It listens on the
three CarLife channels and answers the handshake, so a unit with no phone on the
USB port has something on the other end of the wire.

```sh
python fake_phone.py                  # handshake only, log every command
python fake_phone.py --h264 out.h264  # ... and repeat that stream as video
python fake_phone.py --selftest       # check the wire format, no unit needed
python fake_phone.py --loopback       # run the handshake against ourselves
```

## Ports

| port | channel | payload |
|---|---|---|
| 7240 | 1 control | `[u16 len][u16 0][u32 type]` + protobuf |
| 8240 | 2 video | `[u32 len][u32 ts][u32 0x00020001]` + H.264 |
| 9240 | 3 media | counted, not parsed yet |

The USB side's eight-byte `[channel][length]` header is stripped by the shim, so
nothing here has to know that a bulk transfer is not a message.

## What a good run prints

```
cmd   protocol 2.0
cmd   head unit wants identity
cmd   encoder 1920x720@30
cmd   start video
```

`start video` is where a real phone begins encoding. Without `--h264` this prints
`no --h264 given: handshake only, nothing to send` and the screen stays black on
purpose — that is the handshake succeeding, not failing.

## Where the numbers come from

Not from a specification. The packet layouts and the 1920x720@30 encoder
settings are the bytes this unit's own wired CarLife session put on the bus
(`kit/carlife-shim/README.md`), cross-checked against the phone-side
implementation in `CarLink-Lab`. `--selftest` decodes the unit's captured
`VIDEO_ENCODER_INIT` payload to prove the reader agrees with the capture.

## One thing it does not do

It does not encode. A raw Annex-B stream played back whole as one frame is
enough to prove the pipe, not to produce a pleasant picture; a real encoder
feeding `--h264` through a pipe is the next step.
