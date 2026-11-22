# carlife-probe

Read-only look at how the unit's own `carlife` process gets at the phone, so we
can decide how — or whether — a wireless app can stand in for a wired-to-wireless
box without the box.

## The question

A box is a USB **device** (it impersonates a phone to the car) that is also a
head unit over Wi-Fi. Software on the car cannot impersonate a USB device on its
own host port, so the only ways to feed the native CarLife are:

- a virtual USB device attached to the bus (`vhci_hcd` / usbip), or
- a shim inside `carlife` that replaces its usbfs reads, or
- nothing at all, in which case the app has to draw the picture itself.

Which of those is even on the table depends on one thing: **which layer the
cable carries.** If a USB network interface appears and `carlife` holds sockets,
the cable is only a cable and the conversation can be served from an application
— no kernel work. If `carlife` holds a `usbfs` handle and no interface ever
appears, it is talking to a USB device directly and a virtual device is the only
software route.

## What it reads

`/proc/<pid>/{cmdline,exe,maps,fd}`, `/proc/net/{unix,tcp,tcp6}`, `/sys/class/net`,
`ip addr`, `/sys/bus/usb/devices` (including the descriptors and endpoints of the
device `carlife` opened), the strings in the `carlife` binary, `/sys/class/udc`,
`/sys/kernel/debug/usb/usbmon`, `/lib/modules/$(uname -r)/...`, `lsmod`,
`/dev/shm`, `systemctl cat`, `dmesg | grep usb`.

Nothing is written outside `/dev/shm/carlife-probe`, and nothing is loaded,
started or stopped: the report is taken while a wired CarLife session is on the
screen, and a probe that changes what it measures is worthless.

## The verdict line

`verdict: AOA | IP | bare | idle`, plus the facts behind it (`usbfs_fd`,
`usbfs_n`, `sockets`, `usb_net_iface`, `access`, `node`). `bare` means `carlife`
was not running when the report was taken — open CarLife in the HMI and read
again. `idle` means it runs but holds no usbfs handle and no USB network
interface: no phone is plugged in, so the layer cannot be judged yet.

`access` is the word the next step hangs on: `libusb` means the USB conversation
goes through a library that can be replaced from outside the binary; `usbfs ioctl`
means raw syscalls, which have to be intercepted one level lower. `link: static`
in the process section rules a shim out entirely — a static binary never loads
one — so it has to be read together with `access`.

On this unit the answer is **AOA**, and it is not a matter of opinion: the phone
enumerates as `18d1:2d01` (Google's accessory ID, with audio) behind the xHCI host
controller, `carlife` holds `/dev/bus/usb/001/005`, and no `usb0`/`rndis`
interface ever appears. The cable carries CarLife frames wrapped in USB bulk, not
IP.

## The two sections that decide what comes next

`## aoa` walks sysfs for the device `carlife` actually opened and prints its
interfaces and endpoints — the shape a replacement has to imitate: one
vendor-specific interface (`class=ff`) with a bulk pair, plus an isochronous
audio interface. `## gadget` answers whether a virtual device is even possible
here: a UDC, `usbip`/`vhci` (module or built in), `usbmon` for capturing what the
real session looks like, and whether usbfs is mounted.

`## binary` counts the strings the binary was built with (`7240`, `8240`,
`accessory`, `aoa`, `wifi`). Ports it never mentions cannot be a transport it
knows; ports it does mention mean the CarLife conversation is compiled in twice,
once per transport, which is what makes a shim feasible at all.

## Reading it from a terminal

```sh
sh /var/opt/carlife-probe/current/probe.sh          # one pass, to stdout
cat /dev/shm/carlife-probe/report.txt               # what the app shows
cat /dev/shm/carlife-probe/boot.txt                 # did the unit start
```

The service runs `probe.sh 3`, so the report is never more than three seconds
old. `report.txt` is written to a temporary file and renamed, so a reader never
sees half of one.
