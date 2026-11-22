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

Five screens, `Next page` / `Previous page` to move, `Read again` to re-read:

1. **判据** — the verdict, the facts behind it (including `access` and `link`),
   the process, the network
2. **USB** — devices on the bus, the accessory's interfaces and endpoints, and
   whether a gadget (`udc`) or `usbip` exists
3. **其他** — shared memory, systemd unit and its `ExecStart`, the binary, the
   kernel USB log
4. **接管** — what `carlife-shim` has seen from inside `carlife` (devices,
   config, control requests, bulk packets with their AOA channel), and the
   install's own verdict: loaded, or rolled back
5. **读法** — what each verdict means, and how to take the reading

## Where the numbers come from

`/dev/shm/carlife-probe/report.txt`, rewritten every three seconds by
`carlife-probe.service` (`kit/carlife-probe`). The app only reads it: no shell, no
writes, nothing started or stopped — a probe that changes what it measures is
worthless.

Both versions are on the screen, because the usual confusion is which build the
unit is running: the top right says `v0.2.0` (this app), and `probe:` in the
facts line says which probe wrote the report. `probe: --` means the tool is older
than the app, so the `接管` page will be empty until the tool is updated.

Take the reading with a **wired CarLife session on screen**: the process facts
only exist while the native CarLife is running and talking to a phone.

If the screen says `还没有报告`, the service is not running:
`/dev/shm/carlife-probe/boot.txt` has what the installer saw.
