# CarLife probe (root)

A read-only root probe of the CarLife session, for the **CarLife Probe** app
(`apps/cn_carlife_probe`, which requires it). Installed from the MGU Store's
head-unit tools; no SSH.

## Why it exists

The app runs as `tm_oap_app` and on this unit cannot read another uid's
`/proc/<pid>/fd` or `/proc/<pid>/maps` (hidepid): both came back
`UNREADABLE` in rounds 1 and 2. Those two are exactly what decides how the
CarLife picture reaches the head unit:

| what | why it decides the approach |
|---|---|
| `/proc/<pid>/fd` | a `/dev/bus/usb/*` handle proves the video rides on USB bulk transfers (usbfs), so no TCP proxy can ever see it |
| `/proc/<pid>/maps` | names the decoder (`libmfx`, `libva`, a vendor codec) and the projection stack (Cinemo, `libNme*`) |
| `/dev/shm`, dmabuf, `/memfd:` | frames shared with another process would be the cheapest capture of all: no hook, no decoder of our own |
| `/proc/net/unix` | a frame pipe between the projection stack and the HMI, same reason |
| `/etc/cinemo/*` | the stack's own configuration: `KOMBI_DISPLAY`, alternate displays, the stream sink |
| toolchain | decides whether a hook (LD_PRELOAD) can be built on the unit itself |

## What it does

`probe-root.sh` reads `/proc`, `/sys`, `/etc/cinemo` and lists directories. It
loads no kernel module, writes no firewall rule, sends no signal and opens no
device: the only file it writes is its report.

- `/dev/shm/carlife-probe-root.txt` (0644, so the app reads it) — rewritten
  every 15 s while the service runs, only when the content changed
- `/var/opt/carlife-probe-root/report.txt` — a copy that survives `/dev/shm`
- installed as `carlife-probe-root.service` (`Type=simple`, `Restart=always`),
  enabled at `multi-user.target`

The `postInstall` step writes a first report at install time, so the app has
something to show before the next start; when it replaces a running probe it
also hands the service over to the new script (`systemctl try-restart`), which
otherwise would keep writing its old copy from the old inode.

## Reading the report (1.0.1)

The report is kept at about 90 lines because the app shows 17 a page and the
only way it out of the unit is a screenshot. One line per process carries both
halves of the answer:

```
--- FDS + DECODER (per process) ---
carlife fd=31 usb=2 shm=0 dma=0 so=14 gpu=1 pipe=3
--- DECODER LIBS (per process) ---
carlife libcarlife_core,libias-media_transport-avb_ufipc_bridge,libmfxhw64,
```

| line | what it settles |
|---|---|
| `usb>0` | the session goes over USB (AOA, interface `ff/42/01`) |
| `shm>0` / `dma>0`, or a `/dev/shm` segment over 1 MB, or a `/memfd:` in maps | the frames are already decoded and shared: read them, skip the hook **and** the decoder |
| `so:` names | the sockets between the stack's processes: if CarLife has no decoder library of its own, the H.264 leaves it over one of these, and that socket is the capture point |
| `libmfx`/`libva` in CarLife itself | it decodes in-process, so the frames can only be reached by hooking it |
| `--- CINEMO CONFIG ---` | `kombi`/`alternate`/`sink` keys would allow a second output, the way CarPlay's cluster stream is switched on |
| `--- TOOLCHAIN ---` `gcc`/`cc` | a hook can be built on the unit; without one it has to be cross-built (glibc 2.27, the ABI `idrive-apps` builds for) and shipped readymade |

With `usbmon.ko` absent on kernel 4.14.198-apl, a passive USB capture is closed
either way.

`probe-root.sh` with `once` writes a single report (what `postInstall` runs);
`loop` is the service.

## Testing the parsing off the unit

`test/fake_proc_test.sh` runs the script against a fake `/proc` tree (it
overrides `readlink`), so changes to the parsing can be checked on a desktop:

```sh
sh test/fake_proc_test.sh
```

## Uninstalling

The app keeps working without it (it falls back to its own port and USB scan);
remove the tool from the Store's head-unit tools to drop the service.
