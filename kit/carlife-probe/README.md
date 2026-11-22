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

`/proc/<pid>/{cmdline,exe,cwd,maps,fd}`, `/sys/class/net`, `ip addr`, `ss -tnp`,
`/sys/bus/usb/devices`, `/sys/class/udc`, `/lib/modules/$(uname -r)/...`,
`lsmod`, `/dev/shm`, `systemctl cat`, `dmesg | grep usb`.

Nothing is written outside `/dev/shm/carlife-probe`, and nothing is loaded,
started or stopped: the report is taken while a wired CarLife session is on the
screen, and a probe that changes what it measures is worthless.

## The verdict line

`verdict: AOA | IP | bare | unknown`, plus the three facts behind it
(`usbfs_fd`, `sockets`, `usb_net_iface`). `bare` means `carlife` was not running
when the report was taken — open CarLife in the HMI and read again.

## Reading it from a terminal

```sh
sh /var/opt/carlife-probe/current/probe.sh          # one pass, to stdout
cat /dev/shm/carlife-probe/report.txt               # what the app shows
cat /dev/shm/carlife-probe/boot.txt                 # did the unit start
```

The service runs `probe.sh 3`, so the report is never more than three seconds
old. `report.txt` is written to a temporary file and renamed, so a reader never
sees half of one.
