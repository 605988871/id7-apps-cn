#!/usr/bin/env python3
"""Desk tests for find-phone.sh.

The car decides whether the WiFi stream ever starts from the address this
script returns. It has to work with a lease, without a lease, with only a
kernel default route, and with nothing at all. Fixtures stand in for
/run/mgu-uplink and /proc/net/route so every branch runs on a PC.

    python3 kit/carlife-wireless/test/find_phone_test.py
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
KIT = os.path.dirname(HERE)
FINDER = os.path.join(KIT, 'find-phone.sh')

failed = []


def check(name, got, want_prefix):
    ok = got.startswith(want_prefix)
    print(('  ok   ' if ok else '  FAIL ') + name + '  -> ' + repr(got))
    if not ok:
        failed.append('%s: wanted %r, got %r' % (name, want_prefix, got))


def posix(p):
    """MSYS sh needs /c/... rather than C:\\..."""
    p = p.replace('\\', '/')
    m = re.match(r'^([A-Za-z]):/(.*)$', p)
    if m:
        return '/' + m.group(1).lower() + '/' + m.group(2)
    return p


ROUTE = ('Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT\n')


def route_line(iface, gw_hex, dest='00000000'):
    return '%s\t%s\t%s\t0003\t0\t0\t0\t00000000\t0\t0\t0\n' % (iface, dest, gw_hex)


class Fixture:
    def __init__(self):
        self.dir = tempfile.mkdtemp(prefix='carlife-find-')
        self.host = os.path.join(self.dir, 'host')
        self.lease = os.path.join(self.dir, 'lease.json')
        self.route = os.path.join(self.dir, 'route')
        self.status = os.path.join(self.dir, 'status.json')
        self.allow_auto = '1'
        self.extra = {}

    def write(self, path, data):
        with open(path, 'w', encoding='utf-8', newline='\n') as f:
            f.write(data)

    def run(self):
        env = dict(os.environ)
        env.update({
            'CARLIFE_HOST_FILE': posix(self.host),
            'CARLIFE_LEASE': posix(self.lease),
            'CARLIFE_ROUTE': posix(self.route),
            'CARLIFE_STATUS': posix(self.status),
            'CARLIFE_WIFI_IF': 'wlan0',
            'CARLIFE_ALLOW_AUTO': self.allow_auto,
        })
        env.pop('CARLIFE_HOST', None)
        env.update(self.extra)
        out = subprocess.run(['sh', posix(FINDER)], env=env,
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             universal_newlines=True, timeout=15)
        return out.stdout.strip()

    def close(self):
        shutil.rmtree(self.dir, ignore_errors=True)


def main():
    sh = shutil.which('sh')
    if not sh:
        print('sh is required (Git Bash on Windows)')
        return 1

    # 1. nothing known: auto discovery, never an empty --host
    f = Fixture()
    check('nothing known -> auto discovery', f.run(), 'auto|auto discovery')
    f.allow_auto = '0'
    check('auto disabled -> explicit none', f.run(), '|none')
    f.close()

    # 2. explicit override wins over every file
    f = Fixture()
    f.write(f.host, '10.0.0.9\n')
    f.write(f.lease, json.dumps({'router': '192.168.43.1'}))
    f.extra['CARLIFE_HOST'] = '172.16.5.7'
    check('environment override wins', f.run(), '172.16.5.7|environment override')
    f.close()

    # 3. the app's hand-entered address wins over the lease
    f = Fixture()
    f.write(f.host, '10.0.0.9\n')
    f.write(f.lease, json.dumps({'router': '192.168.43.1'}))
    check('host file wins over lease', f.run(), '10.0.0.9|app setting')
    f.close()

    # 4. lease.json is the normal path once mgu-uplink is "online"
    f = Fixture()
    f.write(f.lease, json.dumps({'ip': '192.168.43.55', 'router': '192.168.43.1',
                                 'prefix': 24, 'dns': []}))
    check('lease router', f.run(), '192.168.43.1|mgu-uplink lease')
    f.close()

    # 5. no lease but a kernel default route on wlan0 (the "associated but
    #    not online" case from the car): 0101A8C0 is little-endian 192.168.1.1
    f = Fixture()
    f.write(f.route, ROUTE + route_line('wlan0', '0101A8C0'))
    check('wlan0 default route', f.run(), '192.168.1.1|default route on wlan0')
    f.close()

    # 6. a different interface still counts, and its name is reported
    f = Fixture()
    f.write(f.route, ROUTE + route_line('eth0', '012BA8C0'))
    check('fallback default route', f.run(), '192.168.43.1|default route on eth0')
    f.close()

    # 7. wlan0 is preferred when several default routes exist
    f = Fixture()
    f.write(f.route, ROUTE + route_line('eth0', '0101A8C0') + route_line('wlan0', '012BA8C0'))
    check('wlan0 preferred', f.run(), '192.168.43.1|default route on wlan0')
    f.close()

    # 8. link-local / loopback gateways are useless and must be skipped
    f = Fixture()
    f.write(f.route, ROUTE + route_line('wlan0', '01FEFEA9'))  # 169.254.254.1
    f.allow_auto = '0'
    check('link-local gateway skipped', f.run(), '|none')
    f.close()

    # 9. status.json's car IP gives a last-resort gateway estimate
    f = Fixture()
    f.write(f.status, json.dumps({'state': 'online',
                                  'wifi': {'link': 'online', 'ssid': 'iQOO 12 Pro',
                                           'ip': '192.168.137.23'}}))
    check('estimated gateway from car IP', f.run(),
          '192.168.137.1|estimated gateway from car IP 192.168.137.23')
    f.close()

    # 10. garbage must not become a host name (no DNS on the unit)
    f = Fixture()
    f.write(f.host, 'not-an-ip\n')
    f.write(f.lease, json.dumps({'router': '192.168.43.1'}))
    check('invalid host ignored', f.run(), '192.168.43.1|mgu-uplink lease')
    f.close()

    # 11. priority: lease > default route > status estimate
    f = Fixture()
    f.write(f.lease, json.dumps({'router': '192.168.43.1'}))
    f.write(f.route, ROUTE + route_line('wlan0', '0101A8C0'))
    f.write(f.status, json.dumps({'wifi': {'link': 'online', 'ip': '10.1.2.3'}}))
    check('lease beats route and status', f.run(), '192.168.43.1|mgu-uplink lease')
    f.close()

    print()
    if failed:
        print('%d check(s) failed' % len(failed))
        for m in failed:
            print('  ' + m)
        return 1
    print('all find-phone checks passed')
    return 0


if __name__ == '__main__':
    sys.exit(main())
