'use strict';
/**
 * CarLife Probe - read-only environment probe, no SSH required.
 *
 * Install from the MGU Store, open it, start CarLife on the head unit, press
 * Rescan, then screenshot the screen. Everything shown comes from /proc and
 * filesystem checks; nothing is modified and no CarLife process is touched.
 *
 * Why this exists: before writing a transparent proxy / packet capture tool we
 * must know the real process name, uid, video port and available decoders on
 * this exact MGU. Public docs do not cover BMW's Baidu CarLife integration.
 */

const fs = require('fs');
const mgu = require('./kit/mgu');

/* CarLife channels from the reverse-engineered protocol (CarLink-Lab).
 * Value is the label shown; key is the uppercase hex port as in /proc/net/tcp. */
const PORTS = {
    '1C48': '7240 CONTROL',
    '2030': '8240 VIDEO',
    '2418': '9240 MEDIA',
    '2419': '9241 TTS',
    '241A': '9242 VR',
    '247C': '9340 TOUCH'
};
const CARLIFE_RE = /carlife|baidu|apollo|welink|bcarlife|carlife\+/i;

function readFile(file) {
    try { return fs.readFileSync(file, 'utf8'); }
    catch (e) { return null; }
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

function parseNetTcp(lines, out, hits) {
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
        var isLoop = /^127\./.test(lip) || /^127\./.test(rip) || lip === '0.0.0.0';

        /* Only surface LISTEN and established non-loopback connections:
         * those are what matter for a phone <-> head-unit CarLife session. */
        var isTarget = !!PORTS[lport] || !!PORTS[rport];
        if (isTarget) hits.push((PORTS[lport] || PORTS[rport]) + ' ' + st + ' ' +
            lip + ':' + parseInt(lport, 16) + ' -> ' + rip + ':' + parseInt(rport, 16) + ' uid=' + uid);

        if (st === '0A' && uid !== '0') {
            out.push('LISTEN  ' + lip + ':' + parseInt(lport, 16) + '  uid=' + uid +
                (PORTS[lport] ? '  <== ' + PORTS[lport] : ''));
        } else if (st === '01' && !isLoop) {
            out.push('ESTAB   ' + lip + ':' + parseInt(lport, 16) + ' -> ' +
                rip + ':' + parseInt(rport, 16) + '  uid=' + uid +
                (isTarget ? '  <== CARLIFE?' : ''));
        }
    }
}

function scanProcesses() {
    var found = [];
    var pids = [];
    try { pids = fs.readdirSync('/proc'); } catch (e) { return ['/proc read: ' + (e.code || e)]; }
    for (var i = 0; i < pids.length; i++) {
        if (!/^\d+$/.test(pids[i])) continue;
        var pid = pids[i];
        var cmd = readFile('/proc/' + pid + '/cmdline');
        if (!cmd) continue;
        cmd = cmd.replace(/\0/g, ' ').replace(/\s+/g, ' ').trim();
        if (!CARLIFE_RE.test(cmd)) continue;
        var uid = '?';
        var status = readFile('/proc/' + pid + '/status');
        if (status) {
            var m = status.match(/^Uid:\s*(\d+)/m);
            if (m) uid = m[1];
        }
        found.push('pid ' + pid + ' uid ' + uid + ': ' + cmd.slice(0, 96));
    }
    if (!found.length) found.push('(no CarLife/Baidu process name matched - see TCP uid rows)');
    return found;
}

function scanTools() {
    var rows = [];
    var checks = [
        ['tcpdump', ['/usr/sbin/tcpdump', '/sbin/tcpdump', '/usr/bin/tcpdump', '/bin/tcpdump']],
        ['nft', ['/usr/sbin/nft', '/sbin/nft', '/usr/bin/nft']],
        ['ffmpeg', ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg']],
        ['renderD128', ['/dev/dri/renderD128']],
        ['libmfx', ['/usr/lib/libmfxhw64.so', '/usr/lib/x86_64-linux-gnu/libmfxhw64.so']],
        ['libva', ['/usr/lib/libva.so.2', '/usr/lib/x86_64-linux-gnu/libva.so.2']]
    ];
    for (var i = 0; i < checks.length; i++) {
        var name = checks[i][0];
        var paths = checks[i][1];
        var hit = '(absent)';
        for (var j = 0; j < paths.length; j++) {
            try {
                if (fs.existsSync(paths[j])) { hit = paths[j]; break; }
            } catch (e) { /* keep looking */ }
        }
        rows.push(name.padEnd(12) + hit);
    }
    return rows;
}

function scanIfaces() {
    var out = [];
    var t = readFile('/proc/net/dev');
    if (!t) return ['/proc/net/dev unreadable'];
    var lines = t.split('\n').slice(2);
    for (var i = 0; i < lines.length; i++) {
        var p = lines[i].split(':');
        if (p.length < 2) continue;
        var name = p[0].trim();
        if (!name) continue;
        out.push(name + (name.indexOf('p2p') === 0 ? '  <== P2P (wireless projection)' : ''));
    }
    return out;
}

var lines = [];
var page = 0;
var scannedAt = '';

function rescan() {
    var out = [];
    var tcpHits = [];
    var tcpRows = [];

    ['/proc/net/tcp', '/proc/net/tcp6'].forEach(function (file) {
        var t = readFile(file);
        if (!t) { out.push(file + ': UNREADABLE (may be hidepid or restricted)'); return; }
        parseNetTcp(t.split('\n'), tcpRows, tcpHits);
    });

    out.push('=== CARLIFE PORT HITS ===');
    if (tcpHits.length) tcpHits.slice(0, 14).forEach(function (s) { out.push(s); });
    else out.push('(none - start CarLife, then press Rescan)');

    out.push('=== PROCESSES ===');
    scanProcesses().slice(0, 16).forEach(function (s) { out.push(s); });

    out.push('=== TCP (uid rows) ===');
    if (tcpRows.length) tcpRows.slice(0, 36).forEach(function (s) { out.push(s); });
    else out.push('(no LISTEN/non-loopback ESTAB rows)');

    out.push('=== INTERFACES ===');
    scanIfaces().forEach(function (s) { out.push(s); });

    out.push('=== TOOLS / DECODER ===');
    scanTools().forEach(function (s) { out.push(s); });

    lines = out;
    scannedAt = new Date().toISOString();
    page = 0;
    return out.length;
}

var PER = 16;
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
            cv.text('CarLife Probe  ' + (page + 1) + '/' + pageCount() + '  @ ' +
                scannedAt.slice(11, 19), 40, 52, 30, '#ffffff');
            cv.text('Open app -> start CarLife on HU -> Rescan -> screenshot this screen',
                40, 84, 19, '#8fa3b4');
            const start = page * PER;
            for (let i = 0; i < PER && start + i < lines.length; i++) {
                const s = String(lines[start + i]);
                const color = s.indexOf('<==') >= 0 ? '#ffd76e' :
                    (s.indexOf('UNREADABLE') >= 0 || s.indexOf('absent') >= 0 ? '#ff8f8f' : '#a8d8c0');
                cv.text(s.slice(0, 150), 40, 118 + i * 24, 19, color);
            }
            return ui.image('MAIN_GFX', cv);
        });
    }
});
