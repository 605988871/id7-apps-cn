#!/bin/sh
# carlife-wireless: find the phone's address on the hotspot.
#
# Prints "<address>|<source>" on stdout and nothing else. The caller passes
# the address to carlife-link; the source goes into run.txt so the car's
# screen can say where the address came from.
#
# Why more than one source: mgu-uplink's status.json says wifi.link
# "connected" as soon as wpa_supplicant associates. Only "online" means it
# took a DHCP lease and wrote lease.json. On units where the uplink picked a
# different device, Wi-Fi stays "connected" forever and lease.json never
# appears - yet the kernel may still have a default route on wlan0. Looking
# at the routing table as well is what makes the stream start in that case.
#
# Order (first hit wins):
#   1 CARLIFE_HOST              explicit override for a desk test
#   2 host file                 the address typed in the app's Settings
#   3 lease.json "router"       mgu-uplink's DHCP gateway (the phone)
#   4 /proc/net/route           default gateway, wlan0 first
#   5 status.json wifi.ip       estimate the gateway as x.x.x.1
#   6 auto                      let carlife-link sweep the local /24
#
# Every path is overridable by an environment variable so the whole finder
# can be exercised on a PC with fixture files (see test/find_phone_test.py).
# No root, no iproute2, no DHCP client needed: /proc/net/route is 0444.

HOST_FILE=${CARLIFE_HOST_FILE:-/dev/shm/carlife-wireless/host}
LEASE=${CARLIFE_LEASE:-/run/mgu-uplink/lease.json}
ROUTE=${CARLIFE_ROUTE:-/proc/net/route}
STATUS=${CARLIFE_STATUS:-/run/mgu-uplink/status.json}
WIFI_IF=${CARLIFE_WIFI_IF:-wlan0}
ALLOW_AUTO=${CARLIFE_ALLOW_AUTO:-1}

emit() { printf '%s|%s\n' "$1" "$2"; exit 0; }

# Only a dotted quad may leave this script: a bad fixture or a truncated
# write must not turn into a DNS lookup on the unit.
valid_ip() {
    case "$1" in
        ''|*[!0-9.]*|*..*|.*|*.) return 1 ;;
        169.254.*|127.*|0.*|255.*) return 1 ;;
    esac
    # exactly four numeric octets
    printf '%s' "$1" | awk -F. 'NF==4 && $1!="" && $2!="" && $3!="" && $4!="" {ok=1} END {if (ok) exit 0; exit 1}'
}

if [ -n "${CARLIFE_HOST:-}" ] && valid_ip "$CARLIFE_HOST"; then
    emit "$CARLIFE_HOST" "environment override"
fi

if [ -f "$HOST_FILE" ]; then
    h=$(head -1 "$HOST_FILE" 2>/dev/null | tr -d ' \r\n')
    if valid_ip "$h"; then emit "$h" "app setting (host file)"; fi
fi

if [ -f "$LEASE" ]; then
    h=$(sed -n 's/.*"router"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$LEASE" 2>/dev/null | head -1 | tr -d ' \r\n')
    if valid_ip "$h"; then emit "$h" "mgu-uplink lease"; fi
fi

# /proc/net/route's gateway is a little-endian hex word: 0101A8C0 -> 192.168.1.1
if [ -r "$ROUTE" ]; then
    hex=''
    iface=''
    hex=$(awk -v want="$WIFI_IF" 'NR>1 && $2=="00000000" && $3!="00000000" && $1==want {print $3; exit}' "$ROUTE" 2>/dev/null)
    [ -n "$hex" ] && iface="$WIFI_IF"
    if [ -z "$hex" ]; then
        # Any other default route is a weaker hint, but still better than
        # guessing: the source is recorded so a wrong guess is visible.
        pair=$(awk 'NR>1 && $2=="00000000" && $3!="00000000" {print $1"|"$3; exit}' "$ROUTE" 2>/dev/null)
        iface=${pair%%|*}
        hex=${pair#*|}
    fi
    if [ -n "$hex" ] && [ "$hex" != "$iface" ]; then
        ip=$(awk -v h="$hex" '
            function hx(s,   i,c,v) {
                v = 0
                for (i = 1; i <= length(s); i++) {
                    c = toupper(substr(s, i, 1))
                    v = v * 16 + index("0123456789ABCDEF", c) - 1
                }
                return v
            }
            BEGIN {
                if (length(h) != 8) exit 1
                printf "%d.%d.%d.%d", hx(substr(h,7,2)), hx(substr(h,5,2)), hx(substr(h,3,2)), hx(substr(h,1,2))
            }')
        if valid_ip "$ip"; then emit "$ip" "default route on $iface"; fi
    fi
fi

# status.json carries the car's own address only once Wi-Fi is "online".
# Phone hotspots hand out ...1 as the gateway, so this is a last estimate.
if [ -f "$STATUS" ]; then
    ip=$(sed -n 's/.*"ip"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$STATUS" 2>/dev/null | head -1 | tr -d ' \r\n')
    if valid_ip "$ip"; then
        gw=$(printf '%s' "$ip" | awk -F. 'NF==4 {print $1"."$2"."$3".1"}')
        if valid_ip "$gw"; then emit "$gw" "estimated gateway from car IP $ip"; fi
    fi
fi

# Nothing to dial yet. "auto" puts carlife-link in discovery mode: it keeps
# sweeping the local /24 and picks the phone up by itself once wlan0 gets an
# address. Crucially the link is RUNNING now, so link.txt is written and the
# app can show "looking for the phone" instead of "not started".
if [ "$ALLOW_AUTO" = 1 ]; then emit "auto" "auto discovery"; fi
emit "" "none"
