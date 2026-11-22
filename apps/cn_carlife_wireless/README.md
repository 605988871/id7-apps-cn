# Wireless CarLife

The screen for `carlife-link`. The unit has no wireless CarLife of its own: its
`carlife` process talks to the phone over USB, and nothing else. A wired-to-
wireless box makes up for it with a USB port and an antenna; this app is the
same idea without the box - the car connects to the phone over Wi-Fi and shows
where that connection stands.

## What it shows

One page, read from `/dev/shm/carlife-wireless/report.txt` once a second:

| line | what it settles |
|---|---|
| `state` | what the tool is doing: looking, connecting, handshake, streaming |
| `host` | which phone it found, and the base port it used |
| `cmd` | the cmd channel's open/closed, messages in and out, whether the phone matched |
| `video` | encoder size, frames, megabytes, keepalives |
| `stream` | whether an SPS, a PPS and an IDR were seen - the three things without which there is no picture at all |
| `audio` | bytes on the media/TTS/mic channels (proof the phone is sending them) |
| `touch` | whether the app is on the control port, and how many touches went out |
| `error` | the first thing that failed, in one line |

The bar's **Reconnect** button writes `retry` to the tool's control port: the
case where the phone was in a pocket when the car started and only came online
two minutes later.

## What it does not do yet, and why that is on purpose

There is no picture. The phone's H.264 arrives, is counted, and is written by
the tool but not decoded - this app is the link's instrument panel, not the
projection. A screen that pretended to be the phone would hide exactly the part
that is unfinished.

The order is deliberate: the link first (it can be tested against a phone on a
laptop, with no car), then the unit's MSDK decoder and the picture, then the
audio devices Cinemo owns, and only then the bezel-less full-screen layout with
touch where the picture is.

## Setup, once

1. Put the phone and the car on one network: the car's own Wi-Fi hotspot, or a
   hotspot the phone shares.
2. On the phone, open CarLife and start its wireless connection. Leave it in the
   foreground - CarLife is an app on the phone, not part of the system, and it
   stops serving when it is put away.
3. Open this app. It should go from `looking for the phone` to `matched` and
   then to `streaming` within a few seconds.
