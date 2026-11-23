# CarLife Probe (车机端：CarLife 诊断)

An app for one question, asked from the driver's seat: **how does the car's own
wired CarLife get at the phone?** Everything else waits on the answer.

A wired-to-wireless box is a USB *device* to the car and a head unit to the phone
over Wi-Fi. Software on the car cannot be a USB device on its own host port, so
an app can only feed the native CarLife if the cable carries IP (a USB network
interface) rather than a raw USB device (AOA). The screen says which one it is:

| Headline | What it means | What we can do |
|---|---|---|
| `直接走 USB` (AOA) | `carlife` holds a `usbfs` handle, no network interface | a virtual USB device (`vhci`) or a shim inside the process — or draw the picture ourselves |
| `USB 当网卡` | a `usb0`/`rndis` interface appeared and `carlife` holds sockets | serve the same conversation from an application: no kernel work |
| `原车 CarLife 没运行` | `carlife` was not running when the report was taken | open it in the HMI, read again |

Six screens, `Next page` / `Previous page` to move, `Read again` to re-read:

1. **判据** — the verdict, the facts behind it (including `access`, `link` and
   the probe's own version), the process, the network
2. **USB** — devices on the bus, the accessory's interfaces and endpoints, and
   whether a gadget (`udc`) or `usbip` exists
3. **其他** — shared memory, systemd unit and its `ExecStart`, the binary, the
   kernel USB log
4. **接管** — two columns that answer different halves of one question. Left:
   what `carlife-shim` has seen from inside `carlife` (devices, config, control
   requests, bulk packets with their AOA channel). Right: **安装核对** — what the
   install actually left on disk, checked by the probe itself: the library on
   disk and its ELF type, the drop-in file, whether the library is in the running
   process's `maps` (`loaded`), the root file system's mode, the unit that owns
   carlife, and the install record. `loaded: no` with a drop-in present is one
   restart away; with no drop-in it is a failed install, and the line at the
   bottom of the page says which
5. **接管记录** — the first bytes of each direction, then `head.txt` if the shim
   wrote one, then the shim's own `tap.txt`, one screenful at a time.

   The first block is built here, from the log's own hex: the first three
   transfers of each direction, with `chan` and `len` decoded big-endian. It is
   built from the log rather than from `head.txt` because a page that needs a
   second file shows nothing when that file is missing — which is what happened
   on 2026-11-23, when page one was the one place those bytes could have been and
   it was empty. 8 bytes and `chan 1 len 10` is a control message with the body
   still to come; 652 bytes and a length of 167772160 is picture data sitting
   where a header is expected.

   The log after it is the call sequence a stand-in device has to follow — the AOA
   handshake, the strings sent to the phone, the bulk headers. Pages are cut by
   drawn rows, so a long bulk line keeps its hex. On this page `Next page` /
   `Previous page` scroll instead of changing screens, and only leave the page at
   either end
6. **读法** — what each verdict means, and how to take the reading

## Where the numbers come from

`/dev/shm/carlife-probe/report.txt`, rewritten every three seconds by
`carlife-probe.service` (`kit/carlife-probe`). The app only reads it: no shell, no
writes, nothing started or stopped — a probe that changes what it measures is
worthless.

Both versions are on the screen, because the usual confusion is which build the
unit is running: every page's title ends with `v<version>` (this app, from
`app.json`) and the age of the reading, and `probe:` in the facts line says which
probe wrote the report. `probe: --` means the tool is older than the app, so the
`接管` page will be empty until the tool is updated.

The title, not a floating stamp: the stamp used to sit at the top right, where the
unit's own chrome clipped it to `v0.2.` — the one line that says which build is
running was the one line the screen cut off.

Take the reading with a **wired CarLife session on screen**: the process facts
only exist while the native CarLife is running and talking to a phone.

If the screen says `还没有报告`, the service is not running:
`/dev/shm/carlife-probe/boot.txt` has what the installer saw.
