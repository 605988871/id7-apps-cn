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
| `/etc/cinemo/*` | the stack's own configuration: `KOMBI_DISPLAY`, alternate displays, the stream sink |
| `/proc/net/unix` | a frame pipe between the projection stack and the HMI would be the cheapest capture point of all |
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
something to show before the next start.

## Reading the report

```
--- FDS ---
carlife fd=31 usb=2 sock=14 gpu=0 pipe=3
```

`usb` above zero on a CarLife process means the session goes over USB (AOA,
interface `ff/42/01`), and the `fdN -> /dev/bus/usb/001/003` lines name the
node. With `usbmon.ko` absent on kernel 4.14.198-apl, that also means a passive
capture is closed and the frame path has to be reached inside the process
(hook) or after it (a socket/file the stack itself writes).

`--- TOOLCHAIN ---` answers whether such a hook can be built **on the unit**
(`gcc`/`cc`/`clang`), and `--- LIBS ---` names what it would have to hook.

## Uninstalling

The app keeps working without it (it falls back to its own port and USB scan);
remove the tool from the Store's head-unit tools to drop the service.
