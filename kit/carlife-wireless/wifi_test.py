#!/usr/bin/env python3
"""Regression checks for the app-side Wi-Fi join path.

The bridge itself is a root daemon on the unit, so its end-to-end behaviour is
verified there. These checks pin the parts that must not drift across edits:
the bridge's allow-list (no way to reach a non-Wi-Fi uplink op), the JS half's
requests and status file, the service wiring, and the version agreement
between the app and the component.
"""
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
KIT = os.path.join(ROOT, 'kit', 'carlife-wireless')
APP = os.path.join(ROOT, 'apps', 'cn_carlife_wireless')

failed = []


def check(ok, what):
    print(('  ok   ' if ok else '  FAIL ') + what)
    if not ok:
        failed.append(what)


def text(path):
    with open(path, 'r', encoding='utf-8') as f:
        return f.read()


def main():
    c = text(os.path.join(KIT, 'wifi-bridge.c'))
    page = text(os.path.join(APP, 'wifi_page.js'))
    mainjs = text(os.path.join(APP, 'main.js'))
    runsh = text(os.path.join(KIT, 'run.sh'))
    finder = text(os.path.join(KIT, 'find-phone.sh'))
    component = json.loads(text(os.path.join(KIT, 'component.json')))
    app = json.loads(text(os.path.join(APP, 'app.json')))

    print('bridge allow-list:')
    m = re.search(r'static const char \*keys\[\] = \{([^}]*)\}', c)
    ops = re.findall(r'"([^"]+)"', m.group(1)) if m else []
    allowed = {'wifi-enable', 'wifi-5ghz', 'wifi-scan', 'wifi-connect', 'wifi-forget'}
    check(set(ops) == allowed, 'exactly the five Wi-Fi ops are forwarded (%s)' % ops)
    check('"prefer"' not in c and '"usb-phone"' not in c, 'preferred uplink / USB phone are NOT exposed')
    check('/run/mgu-uplink/ctl.sock' in c, 'forwards to the real uplink socket')
    check('/dev/shm/carlife-wireless/wifi.sock' in c, 'listens on the app-visible shm socket')
    check('getgrnam("tm_oap_app")' in c and 'chown(APP_SOCK' in c, 'socket is narrowed to the OAP app group')
    check('"--selftest"' in c, 'install-time selftest is present')

    print('app -> bridge protocol:')
    for op in ('wifi-enable', 'wifi-scan', 'wifi-connect'):
        check(("op: '%s'" % op) in page, 'wifi_page.js sends %s' % op)
    check('/run/mgu-uplink/status.json' in page, 'reads the uplink status for the network list')
    check("require('./speller')" in page and 'spell(this.ctx.app' in page, 'uses the HMI speller for a password')
    check("this.settings.get('wifi_psk')" in page, 'falls back to the app setting for a password')
    check("require('./wifi_page')" in mainjs and 'new WifiPage(' in mainjs, 'main.js wires in the Wi-Fi page')
    check('WIFI_BTN' in mainjs and "phase === 1 && inWifiButton" in mainjs, 'the in-app hotspot button is reachable')

    print('wiring and versions:')
    paths = [f['path'] for f in component['files']]
    check('wifi-bridge' in paths and 'carlife-wifi.service' in paths, 'component ships the bridge binary and unit')
    units = [u['name'] for u in component['units']]
    check('carlife-wifi.service' in units, 'bridge unit is registered')
    check(component['version'] == app['version'], 'app and component versions agree')
    check(app['requires']['carlife-wireless'] == component['version'], 'app requires this component version')
    check(any(s['key'] == 'wifi_psk' and s['type'] == 'text' for s in app['settings']),
          'wifi_psk is a text setting (the HMI keyboard can fill it)')

    print('stream launcher (regression for "connected hotspot, no stream"):')
    paths = [f['path'] for f in component['files']]
    check('find-phone.sh' in paths, 'component ships the address finder')
    check('run.txt' in runsh, 'launcher writes its own report for the app')
    check('rm -f "$DIR/link.txt"' not in runsh, 'launcher never deletes the link report')
    check('find-phone.sh' in runsh and 'PHONE=auto' in runsh,
          'no address still starts the link in discovery mode')
    for key in ('/proc/net/route', 'lease.json', 'status.json', 'app setting'):
        check(key in finder, 'finder covers %s' % key)
    check('RUN_TXT' in mainjs and 'BOOT_TXT' in mainjs,
          'app reads the launcher and install reports')
    check('已关联' in mainjs, 'app distinguishes association from an online lease')

    print()
    if failed:
        print('%d check(s) failed' % len(failed))
        return 1
    print('all Wi-Fi path checks passed')
    return 0


if __name__ == '__main__':
    sys.exit(main())
