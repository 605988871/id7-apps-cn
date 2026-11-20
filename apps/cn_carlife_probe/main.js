'use strict';
/**
 * CarLife Probe - read-only environment probe, no SSH required.
 *
 * Install from the MGU Store, open it, start CarLife on the head unit, press
 * Rescan, then screenshot each page. Everything shown comes from /proc and
 * /sys; nothing is modified and no CarLife process is touched.
 *
 * Round 1 on an MGU (iDrive 7) found: /usr/bin/carlife runs as uid 13005, the
 * CarLife family is uid 13000-13099, and a connected session showed no socket
 * on the CarLife TCP ports at all - so the video does not travel over TCP here.
 * Round 2 found a vivo iQOO 12 Pro on the USB bus as an AOA accessory
 * (interface ff/42/01, driven through usbfs) and no usbmon module, but the app
 * cannot read another uid's /proc/<pid>/fd or maps (hidepid).
 *
 * Round 3 therefore shows the report of the root tool carlife-probe-root,
 * which can: the descriptors of every CarLife process (a /dev/bus/usb handle is
 * the proof of the USB carrier), the loaded decoder and projection libraries,
 * the Cinemo configuration, the unit's own sockets and the build tools.
 */

const fs = require('fs');
const mgu = require('./kit/mgu');

/* CarLife channels from the reverse-engineered protocol (CarLink-Lab).
 * Key is the uppercase hex port as in /proc/net/tcp. */
const PORTS = {
    '1C48': '7240 CONTROL',
    '2030': '8240 VIDEO',
    '2418': '9240 MEDIA',
    '2419': '9241 TTS',
    '241A': '9242 VR',
    '247C': '9340 TOUCH'
};
const CARLIFE_RE = /carlife|baidu|apollo|welink|bcarlife|linkd|tether/i;

function readFile(file) {
    try { return fs.readFileSync(file, 'utf8'); } catch (e) { return null; }
}
function readLink(file) {
    try { return fs.readlinkSync(file); } catch (e) { return null; }
}
function exists(file) {
    try { return fs.existsSync(file); } catch (e) { return false; }
}
function listDir(dir) {
    try { return fs.readdirSync(dir); } catch (e) { return null; }
}

/* /proc/net/tcp stores IPv4 as little-endian hex: 02C0A8C0 = 192.168.192.2.
 * Read the hex bytes and reverse them to get network (display) order. */
function hexip(h) {
    if (!h || h.length !== 8) return h || '';
    try {
        var bytes = [0, 2, 4, 6].map(function (i) { return parseInt(h.substr(i, 2), 16); });
        return bytes.reverse().join('.');
    } catch (e) { return h; }
}

function parseNetTcp(text, rows, hits, wantEstab) {
    var lines = text.split('\n');
    for (var i = 1; i < lines.length; i++) {
        var f = lines[i].trim().split(/\s+/);
        if (f.length < 8) continue;
        var la = (f[1] || '').split(':');
        var ra = (f[2] || '').split(':');
        if (la.length < 2 || ra.length < 2) continue;
        var lport = (la[1] || '').toUpperCase();
        var rport = (ra[1] || '').toUpperCase();
        var st = f[3];
        var uid = f[7];
        var lip = hexip(la[0]);
        var rip = hexip(ra[0]);
        var isTarget = !!PORTS[lport] || !!PORTS[rport];
        var line = lip + ':' + parseInt(lport, 16) + ' -> ' + rip + ':' + parseInt(rport, 16) + ' uid=' + uid;
        if (isTarget) hits.push((PORTS[lport] || PORTS[rport]) + ' st=' + st + ' ' + line);
        if (st === '0A' && uid !== '0') rows.push('L ' + line + (PORTS[lport] ? ' <==' : ''));
        else if (st === '01' && wantEstab) rows.push('E ' + line + (isTarget ? ' <==' : ''));
    }
}

/* The CarLife family of processes: by name, and by the uid range round 1 found
 * (13002/13005/13006/13012 all belong to it). */
function findCarlife() {
    var out = [];
    var pids = listDir('/proc');
    if (!pids) return { error: 'UNREADABLE /proc', list: [], main: null };
    for (var i = 0; i < pids.length; i++) {
        if (!/^\d+$/.test(pids[i])) continue;
        var pid = pids[i];
        var cmd = readFile('/proc/' + pid + '/cmdline');
        if (!cmd) continue;
        cmd = cmd.replace(/\0/g, ' ').replace(/\s+/g, ' ').trim();
        if (!cmd) continue;
        var uid = '?';
        var status = readFile('/proc/' + pid + '/status');
        if (status) {
            var m = status.match(/^Uid:\s*(\d+)/m);
            if (m) uid = m[1];
        }
        var num = parseInt(uid, 10);
        var isFamily = (num >= 13000 && num < 13100) || CARLIFE_RE.test(cmd);
        if (!isFamily) continue;
        out.push({ pid: pid, uid: uid, cmd: cmd });
    }
    var main = null;
    for (var k = 0; k < out.length; k++) {
        if (/carlife/i.test(out[k].cmd)) { main = out[k]; break; }
    }
    if (!main && out.length) main = out[0];
    return { error: null, list: out, main: main };
}

function secProc(found) {
    var out = ['=== CARLIFE PROCESSES ==='];
    if (found.error) { out.push(found.error); return out; }
    if (!found.list.length) { out.push('(none matched by name or uid 13000-13099)'); return out; }
    for (var i = 0; i < found.list.length && i < 11; i++) {
        var p = found.list[i];
        var ns = readLink('/proc/' + p.pid + '/ns/net') || '?';
        out.push('pid ' + p.pid + ' uid ' + p.uid + ' ' + ns.replace('net:[', 'ns') +
            ' ' + p.cmd.slice(0, 70));
    }
    return out;
}

/* A /dev/bus/usb descriptor in the CarLife process would prove the video rides
 * on USB rather than TCP; a socket pair or v4l2 node says something else. */
function secFds(pid) {
    var out = ['=== CARLIFE FDS (pid ' + (pid || '-') + ') ==='];
    if (!pid) { out.push('(no CarLife process)'); return out; }
    var fds = listDir('/proc/' + pid + '/fd');
    if (!fds) { out.push('UNREADABLE /proc/' + pid + '/fd (hidepid/perms)'); return out; }
    var counts = { usb: 0, socket: 0, dri: 0, video: 0, other: 0 };
    var samples = [];
    for (var i = 0; i < fds.length; i++) {
        var target = readLink('/proc/' + pid + '/fd/' + fds[i]);
        if (!target) continue;
        if (target.indexOf('/dev/bus/usb') === 0) {
            counts.usb++;
            if (samples.length < 4) samples.push('usb ' + target);
        } else if (target.indexOf('socket:') === 0) {
            counts.socket++;
        } else if (target.indexOf('/dev/dri') === 0) {
            counts.dri++;
            if (samples.length < 6) samples.push('gpu ' + target);
        } else if (target.indexOf('/dev/video') === 0) {
            counts.video++;
            if (samples.length < 7) samples.push('vid ' + target);
        } else if (/^\/dev\/(snd|dsp|fb|kmsg)/.test(target)) {
            counts.other++;
        }
    }
    out.push('open=' + fds.length + ' usb=' + counts.usb + ' socket=' + counts.socket +
        ' gpu=' + counts.dri + ' video=' + counts.video);
    for (var k = 0; k < samples.length; k++) out.push(samples[k].slice(0, 90));
    return out;
}

/* The sockets of the CarLife process's own network namespace: an app reading
 * /proc/net/tcp sees only its own namespace, which is why round 1 found no
 * session at all. */
function secNetns(pid) {
    var out = ['=== CARLIFE NETNS TCP ==='];
    if (!pid) { out.push('(no CarLife process)'); return out; }
    var rows = [];
    var hits = [];
    var got = false;
    ['tcp', 'tcp6'].forEach(function (name) {
        var t = readFile('/proc/' + pid + '/net/' + name);
        if (!t) return;
        got = true;
        parseNetTcp(t, rows, hits, true);
    });
    if (!got) { out.push('UNREADABLE /proc/' + pid + '/net/tcp'); return out; }
    hits.slice(0, 4).forEach(function (s) { out.push('HIT ' + s.slice(0, 80)); });
    if (!rows.length) out.push('(no LISTEN, no established)');
    rows.slice(0, 9).forEach(function (s) { out.push(s.slice(0, 100)); });
    return out;
}

/* The USB tree: an AOA accessory shows interface class ff/42/01, which is what
 * a CarLife or Android Auto session looks like on the wire. */
function secUsb() {
    var out = ['=== USB DEVICES ==='];
    var devs = listDir('/sys/bus/usb/devices');
    if (!devs) { out.push('UNREADABLE /sys/bus/usb/devices'); return out; }
    var lines = 0;
    for (var i = 0; i < devs.length && lines < 12; i++) {
        var base = '/sys/bus/usb/devices/' + devs[i];
        if (devs[i].indexOf(':') >= 0) {
            var cls = readFile(base + '/bInterfaceClass');
            var sub = readFile(base + '/bInterfaceSubClass');
            var pro = readFile(base + '/bInterfaceProtocol');
            if (cls === null) continue;
            var driver = readLink(base + '/driver');
            var tag = '';
            if ((cls || '').trim() === 'ff' && (sub || '').trim() === '42' && (pro || '').trim() === '01') {
                tag = ' <== AOA/ACCESSORY';
            }
            out.push('  ' + devs[i] + ' cls=' + (cls || '').trim() + '/' + (sub || '').trim() +
                '/' + (pro || '').trim() + ' drv=' + (driver ? driver.split('/').pop() : '-') + tag);
            lines++;
        } else {
            var vid = readFile(base + '/idVendor');
            var idp = readFile(base + '/idProduct');
            if (vid === null) continue;
            var prod = (readFile(base + '/product') || '').trim();
            var man = (readFile(base + '/manufacturer') || '').trim();
            out.push(devs[i] + ' ' + (vid || '').trim() + ':' + (idp || '').trim() + ' ' +
                (man + ' ' + prod).trim().slice(0, 46));
            lines++;
        }
    }
    if (lines === 0) out.push('(no USB device nodes)');
    var nodes = listDir('/dev/bus/usb');
    out.push('dev/bus/usb: ' + (nodes ? nodes.join(',') : 'UNREADABLE'));
    return out;
}

/* usbmon would let a root tool read the raw bulk traffic of the session with no
 * driver and no protocol work, which is the cheapest passive capture here. */
function secUsbMon() {
    var out = ['=== USBMON / DEBUGFS ==='];
    var mounts = readFile('/proc/mounts') || '';
    out.push('debugfs mounted: ' + (/debugfs/.test(mounts) ? 'yes' : 'no') +
        '  debugfs rw: ' + (/debugfs\s+\S+\s+debugfs\s+\S*?rw/.test(mounts) ? 'yes' : 'no'));
    var mon = listDir('/sys/kernel/debug/usb/usbmon');
    out.push('usbmon dir: ' + (mon ? mon.join(',') : 'UNREADABLE/absent'));
    out.push('usb/devices (debug): ' + (exists('/sys/kernel/debug/usb/devices') ? 'yes' : 'no'));
    var devs = listDir('/dev');
    out.push('/dev/usbmon*: ' + (devs ? devs.filter(function (n) { return n.indexOf('usbmon') === 0; }).join(',') || 'none' : 'UNREADABLE'));
    var mods = readFile('/proc/modules');
    out.push('usbmon loaded: ' + (mods === null ? 'UNREADABLE' : (/^usbmon\b/m.test(mods) ? 'yes' : 'no')));
    var rel = (readFile('/proc/sys/kernel/osrelease') || '').trim();
    out.push('kernel: ' + rel);
    var modPath = '/lib/modules/' + rel + '/kernel/drivers/usb/mon/usbmon.ko';
    out.push('usbmon.ko: ' + (exists(modPath) || exists(modPath + '.xz') || exists(modPath + '.gz') ? 'present' : 'absent'));
    return out;
}

function secRuntime() {
    var out = ['=== RUNTIME ==='];
    out.push('node ' + process.version);
    var checks = [
        ['python3', ['/usr/bin/python3', '/usr/local/bin/python3']],
        ['ss', ['/usr/sbin/ss', '/bin/ss', '/usr/bin/ss']],
        ['socat', ['/usr/bin/socat', '/usr/local/bin/socat']],
        ['nc', ['/usr/bin/nc', '/bin/nc', '/usr/bin/netcat']],
        ['busybox', ['/bin/busybox', '/usr/bin/busybox']],
        ['modprobe', ['/usr/sbin/modprobe', '/sbin/modprobe']],
        ['insmod', ['/usr/sbin/insmod', '/sbin/insmod']],
        ['iptables', ['/usr/sbin/iptables', '/sbin/iptables']]
    ];
    for (var i = 0; i < checks.length; i++) {
        var hit = 'absent';
        for (var j = 0; j < checks[i][1].length; j++) {
            if (exists(checks[i][1][j])) { hit = checks[i][1][j]; break; }
        }
        out.push(checks[i][0] + ': ' + hit);
    }
    return out;
}

/* Which libraries carry the video path: an SDK name here tells us what to hook
 * or how to decode, without guessing. */
function secLibs(pid) {
    var out = ['=== CARLIFE LIBS ==='];
    if (!pid) { out.push('(no CarLife process)'); return out; }
    var maps = readFile('/proc/' + pid + '/maps');
    if (!maps) { out.push('UNREADABLE /proc/' + pid + '/maps'); return out; }
    var seen = {};
    var list = [];
    maps.split('\n').forEach(function (line) {
        var m = line.match(/\s(\/\S+\.so[^\s]*)$/);
        if (!m) return;
        var base = m[1].split('/').pop();
        if (seen[base]) return;
        seen[base] = 1;
        if (/carlife|baidu|bd|av|media|codec|decode|h264|hevc|mfx|va|sdl|gles|egl|usb/i.test(base)) list.push(base);
    });
    out.push('matching libs: ' + list.length);
    list.slice(0, 9).forEach(function (n) { out.push(n.slice(0, 90)); });
    return out;
}

var lines = [];
var page = 0;
var scannedAt = '';
var source = '';

/* The root tool's report: it can read what the app cannot (another uid's
 * /proc/<pid>/fd and maps on a hidepid unit). Live copy first, the copy the
 * tool keeps under /var/opt second. */
var ROOT_REPORT = ['/dev/shm/carlife-probe-root.txt', '/var/opt/carlife-probe-root/report.txt',
    '/tmp/carlife-probe-root.txt'];
var ROOT_LIMIT = 150;

function readRoot() {
    for (var i = 0; i < ROOT_REPORT.length; i++) {
        var t = readFile(ROOT_REPORT[i]);
        if (t && t.replace(/\s+/g, '').length) return { path: ROOT_REPORT[i], text: t };
    }
    return null;
}

function clock() {
    var d = new Date();
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

function rescan() {
    var out = [];
    var root = readRoot();
    if (root) {
        out.push('=== ROOT REPORT ' + root.path + ' ===');
        var body = root.text.split('\n');
        for (var i = 0; i < body.length && out.length < ROOT_LIMIT; i++) {
            var s = body[i].replace(/\s+$/, '');
            if (s.length) out.push(s);
        }
        if (body.length > ROOT_LIMIT) out.push('(report cut at ' + ROOT_LIMIT + ' lines)');
        source = 'root report';
    } else {
        var found = findCarlife();
        var pid = found.main ? found.main.pid : null;
        out.push('=== NO ROOT REPORT: install "CarLife probe (root)" ===');
        out.push('(Head-unit tools; until then only ports and USB are readable)');
        out = out.concat(secProc(found));
        out = out.concat(secFds(pid));
        out = out.concat(secNetns(pid));
        out = out.concat(secUsb());
        out = out.concat(secUsbMon());
        out = out.concat(secRuntime());
        out = out.concat(secLibs(pid));
        source = 'app only';
    }
    lines = out;
    scannedAt = clock();
    page = 0;
    return out.length;
}

var PER = 17;
function pageCount() { return Math.max(1, Math.ceil(lines.length / PER)); }

mgu.run({
    async start(ctx) {
        const { ui, log } = ctx;
        const n = rescan();
        log.info('CarLife probe scanned ' + n + ' lines at ' + scannedAt);

        ui.onClick('BTN_RESCAN', () => {
            const c = rescan();
            log.info('rescan -> ' + c + ' lines');
        });
        ui.onClick('BTN_NEXT', () => { page = (page + 1) % pageCount(); });
        ui.onClick('BTN_PREV', () => { page = (page + pageCount() - 1) % pageCount(); });

        ctx.loop('MAIN', 5, () => {
            const cv = ctx.canvas(1600, 520).clear('#0b1016');
            cv.text('CarLife Probe  ' + (page + 1) + '/' + pageCount() + '  @ ' + scannedAt +
                '  [' + source + ']', 40, 50, 28, '#ffffff');
            cv.text('Connect CarLife, wait 15 s, Rescan; screenshot every page',
                40, 82, 18, '#8fa3b4');
            const start = page * PER;
            for (let i = 0; i < PER && start + i < lines.length; i++) {
                const s = String(lines[start + i]);
                const color = s.indexOf('===') === 0 ? '#7fb2ff' :
                    (s.indexOf('<==') >= 0 || s.indexOf('HIT ') === 0 ? '#ffd76e' :
                        (s.indexOf('UNREADABLE') >= 0 || s.indexOf('absent') >= 0 ||
                            s.indexOf('NO ROOT REPORT') >= 0 ? '#ff8f8f' : '#a8d8c0'));
                cv.text(s.slice(0, 170), 40, 112 + i * 23, 17, color);
            }
            return ui.image('MAIN_GFX', cv);
        });
    }
});
