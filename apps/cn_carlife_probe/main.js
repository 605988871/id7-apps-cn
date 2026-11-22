'use strict';
/**
 * CarLife Probe - the answer to one question, on the screen: which layer does
 * the phone cable carry?
 *
 * A wired-to-wireless box is a USB device to the car and a head unit to the
 * phone. Software on the car cannot be a USB device on its own host port, so the
 * only way an app can feed the native CarLife is if the cable carries IP (a USB
 * network interface) rather than a raw USB device (AOA). This app shows what the
 * unit's own carlife process is holding - a usbfs handle or sockets - so that
 * question is answered by looking, not by guessing.
 *
 * It reads /dev/shm/carlife-probe/report.txt (rewritten every three seconds by
 * carlife-probe.service) and, on its own page, the shim's long call log, and
 * draws them in six screens. Nothing here writes.
 *
 * Both halves of the install name themselves on the screen - the app version in
 * the top right corner, the probe's own version beside `access` - because the one
 * question that has cost time here is "which build is on the car right now".
 */
const fs = require('fs');
const path = require('path');
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const { t: translate } = require('./kit/i18n');

/* The build's own manifest, next to kit/: absent in a dev tree, so never fatal. */
const APP_VER = (() => {
    try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'kit', 'app-spec.json'), 'utf8')).version || ''; }
    catch (e) { return ''; }
})();

const W = 1600, H = 520;
const REPORT = '/dev/shm/carlife-probe/report.txt';
/* The shim's long log. It is written by carlife-shim inside carlife at 0644, so
 * this app can read it without being root - which is the whole reason the log is
 * on the screen instead of behind an ssh login. The file is capped at 256 KB by
 * the shim itself; the fields that matter for writing a stand-in device (the AOA
 * handshake, the bulk headers, the endpoint sizes) are all in its first pages. */
const TAP = '/dev/shm/carlife-shim/tap.txt';
const READ_MS = 2000;
const STALE_MS = 15000;
const SIZE = 20, LINE = 26;
const COL_W = 700;
const TAP_SZ = 16, TAP_LINE = 22, TAP_ROWS = 16;

const SEC_NAME = {
    verdict: 'Verdict',
    proc: 'Process',
    net: 'Network',
    usb: 'USB devices',
    aoa: 'Direct USB (AOA)',
    gadget: 'Virtual USB',
    binary: 'Binary',
    shm: 'Memory',
    service: 'Units',
    kernel: 'Kernel',
    shim: 'Shim',
    boot: 'Installed',
    install: 'Install check',
};

/* Four words, each meaning a different amount of work for us. */
const VERDICT = {
    AOA: ['Direct USB (AOA)', 'accent2'],
    IP: ['Network over USB', 'accent'],
    bare: ['carlife is not running', 'crit'],
    idle: ['No phone on USB', 'dim'],
    unknown: ['Not enough to tell', 'dim'],
};

const SCREENS = [
    { name: 'Key facts' },
    { name: 'USB', secs: ['usb', 'aoa'] },
    { name: 'The rest', secs: ['gadget', 'service', 'binary', 'kernel'] },
    { name: 'Shim', secs: ['shim', 'install'] },
    { name: 'Shim log', tap: true },
    { name: 'How to read', help: true },
];

mgu.run({
    async start(ctx) {
        const { ui, log } = ctx;
        let page = 0;
        let doc = { ok: false, at: 0, meta: {}, sec: {} };
        let tapPage = 0;
        let tap = { at: 0, lines: null };
        let tapRows = [];
        let tapMs = 0;

        /* ---------- the report ---------- */
        function load() {
            let text, at = 0;
            try {
                text = fs.readFileSync(REPORT, 'utf8');
                at = fs.statSync(REPORT).mtimeMs;
            } catch (e) {
                doc = { ok: false, at: 0, meta: {}, sec: {} };
                return;
            }
            const meta = {}, sec = {};
            let cur = '';
            text.split(/\r?\n/).forEach((raw) => {
                const l = raw.replace(/\s+$/, '');
                if (!l) return;
                if (l.slice(0, 3) === '## ') { cur = l.slice(3).trim(); sec[cur] = []; return; }
                // the fields a drawing needs are `key: value` wherever they sit: the
                // verdict lives inside its own section, the pid above it
                const i = l.indexOf(': ');
                if (i > 0 && i < 24) meta[l.slice(0, i)] = l.slice(i + 2);
                if (cur) sec[cur].push(l.replace(/^ {1,2}/, ''));
            });
            doc = { ok: true, at, meta, sec };
        }

        const field = (k, d) => doc.meta[k] || d || '--';

        /* ---------- drawing ---------- */
        function wrap(cv, str, width, size) {
            const px = size || SIZE;
            const out = [];
            let line = '';
            for (const ch of String(str)) {
                const next = line + ch;
                if (line && cv.textWidth(next, px, { literal: true }) > width) {
                    // Break after a separator when one is close by, so a wrapped
                    // path reads as two paths rather than two broken words.
                    let cut = line.length;
                    for (let k = line.length - 1; k > Math.max(0, line.length - 14); k--) {
                        if ('/_- .'.indexOf(line[k]) >= 0) { cut = k + 1; break; }
                    }
                    out.push(line.slice(0, cut));
                    line = line.slice(cut) + ch;
                } else line = next;
            }
            out.push(line);
            return out;
        }

        /* One section per column when there are two, halves otherwise, so a
         * screen with two short sections uses the width instead of stacking
         * them in the left third. Whatever does not fit is counted, never
         * silently dropped. */
        function itemsOf(cv, key) {
            const out = [{ head: translate(SEC_NAME[key] || key) }];
            const body = (doc.sec[key] || []).filter((l) => l.trim());
            if (!body.length) out.push({ text: '--' });
            body.forEach((l) => wrap(cv, l, COL_W).forEach((s) => out.push({ text: s })));
            return out;
        }

        function flow(cv, t, secs, yTop, rows) {
            const cols = [[], []];
            const per = Math.ceil(secs.length / 2) || 1;
            secs.forEach((key, i) => { cols[i < per ? 0 : 1].push(...itemsOf(cv, key)); });
            const x = [56, 56 + COL_W + 60];
            cols.forEach((items, ci) => {
                const shown = items.slice(0, rows);
                if (items.length > rows) shown[rows - 1] = { text: '+ ' + (items.length - rows) };
                shown.forEach((it, row) => {
                    const py = yTop + row * LINE;
                    if (it.head) cv.text(it.head, x[ci], py, SIZE, t.accent2, { font: 'bold', spacing: 1.5 });
                    else cv.text(it.text, x[ci], py, SIZE, t.text, { literal: true });
                });
            });
        }

        function evidence() {
            return 'pid ' + field('pids') + '    usbfs: ' + field('usbfs_fd') +
                ' (' + field('usbfs_n') + ')    sockets: ' + field('sockets') +
                '    usb-net: ' + field('usb_net_iface') + '    access: ' + field('access') +
                '    probe: ' + field('probe');
        }

        function drawKey(cv, t) {
            const sh = G.panel(cv, t, 24, 44, 1552, 468, translate('Key facts'));
            const key = (doc.meta.verdict || 'unknown').trim().toUpperCase();
            const [text, colour] = VERDICT[key] || VERDICT.unknown;
            cv.text(translate(text), sh.x + 26, 132, 40, t[colour] || t.text, { font: 'bold' });
            cv.text(evidence(), sh.x + 26, 176, SIZE, t.dim, { literal: true });
            flow(cv, t, ['proc', 'net'], 216, 10);
        }

        function drawDump(cv, t, secs) {
            const sh = G.panel(cv, t, 24, 44, 1552, 468, translate(SCREENS[page].name));
            flow(cv, t, secs, sh.y + 84, 14);
            /* `state: absent` is the probe saying it read no shim inside carlife.
             * The install section now says *why*: a drop-in that is on disk but
             * not in the process is one restart away, while no drop-in at all is
             * a failed install. Those two used to look identical here, and
             * "installed but not restarted" is the one that wastes a trip. */
            if (secs.indexOf('install') >= 0 && field('loaded') === 'no') {
                const ready = field('drop-in') !== 'absent';
                cv.text(translate(ready
                    ? 'The drop-in is in place: restart carlife once'
                    : 'Not inside carlife: install CarLife Shim, then restart carlife'),
                sh.x + 26, sh.y + 448, 18, t.dim, { literal: true });
            }
        }

        function drawHelp(cv, t) {
            const sh = G.panel(cv, t, 24, 44, 1552, 468, translate('How to read'));
            const lines = [
                ['AOA', 'Already confirmed: carlife reads a USB device directly and nothing goes over the network. The only way in is to replace that level inside the process; Binary says whether that means libusb.'],
                ['Network over USB', 'A USB network interface appeared and carlife runs sockets on top: an application can answer those instead of a device.'],
                ['How to take it', 'Get a picture from the car\'s own wired CarLife first, then come back here: the report is rewritten every three seconds.'],
                ['Nothing here writes', 'Read-only on purpose: a probe that changes what it measures is worth nothing.'],
            ];
            let y = 132;
            lines.forEach(([head, body]) => {
                cv.text(translate(head).toUpperCase(), sh.x + 26, y, SIZE, t.accent2, { font: 'bold', spacing: 2 });
                wrap(cv, translate(body), 1440).forEach((s, i) => {
                    cv.text(s, sh.x + 26, y + 30 + i * 24, 22, t.text, { literal: true });
                });
                y += 96;
            });
        }

        /* The shim's own log, one screenful at a time. The AOA handshake and the
         * first bulk headers are what a stand-in device has to imitate, so page
         * one is where the reading starts; the buttons scroll this page and only
         * leave it at either end.
         *
         * Pages are cut by drawn rows, not by file lines: a bulk line carries its
         * header and its hex, and cutting between lines would drop a tail. The
         * wrap is done once per change - measuring 300 lines a frame at 2 fps is
         * what would make this page slow, and the file changes every few seconds
         * while a phone is talking. */
        function loadTap(cv) {
            let at = 0, text = null;
            try {
                at = fs.statSync(TAP).mtimeMs;
                if (tap.lines && at === tap.at) return;
                if (tapRows.length && Date.now() - tapMs < 800) return;
                text = fs.readFileSync(TAP, 'utf8');
            } catch (e) {
                tap = { at: 0, lines: null };
                tapRows = [];
                return;
            }
            tapMs = Date.now();
            const lines = text.split(/\r?\n/);
            if (lines.length && !lines[lines.length - 1]) lines.pop();
            const rows = [];
            lines.forEach((l) => { wrap(cv, l, 1480, TAP_SZ).forEach((p) => rows.push(p)); });
            tap = { at, lines };
            tapRows = rows;
        }

        function drawTap(cv, t) {
            loadTap(cv);
            const rows = tapRows;
            const pages = Math.max(1, Math.ceil(rows.length / TAP_ROWS));
            if (tapPage > pages - 1) tapPage = pages - 1;
            const from = tapPage * TAP_ROWS;
            const to = Math.min(from + TAP_ROWS, rows.length);
            const title = rows.length
                ? translate('Shim log') + '  ' + (from + 1) + '-' + to + ' / ' + rows.length
                : translate('Shim log');
            const sh = G.panel(cv, t, 24, 44, 1552, 468, title);

            if (!rows.length) {
                cv.text(translate('No shim log yet'), sh.x + 26, 140, 36, t.crit, { font: 'bold' });
                wrap(cv, translate('Install CarLife Shim, plug the phone in and run a wired session, then read this page.'), 1440)
                    .forEach((s, i) => cv.text(s, sh.x + 26, 198 + i * 28, 22, t.text, { literal: true }));
                return;
            }

            for (let i = from; i < to; i++) {
                cv.text(rows[i], sh.x + 26, sh.y + 62 + (i - from) * TAP_LINE, TAP_SZ, t.text, { literal: true });
            }
        }

        function drawMissing(cv, t) {
            const sh = G.panel(cv, t, 24, 44, 1552, 468, translate('Key facts'));
            cv.text(translate('No report yet'), sh.x + 26, 140, 40, t.crit, { font: 'bold' });
            wrap(cv, translate('carlife-probe.service is not running, or its report is not readable.'), 1440)
                .forEach((s, i) => cv.text(s, sh.x + 26, 190 + i * 26, 22, t.text, { literal: true }));
            wrap(cv, translate('Install the probe with this app, then read /dev/shm/carlife-probe/boot.txt if it stays empty.'), 1440)
                .forEach((s, i) => cv.text(s, sh.x + 26, 246 + i * 26, 22, t.dim, { literal: true }));
        }

        async function render() {
            const t = ctx.theme(), cv = ctx.canvas(W, H).clear(t.bg);
            const scr = SCREENS[page];
            if (!doc.ok) drawMissing(cv, t);
            else if (scr.help) drawHelp(cv, t);
            else if (scr.tap) drawTap(cv, t);
            else if (scr.name === 'Key facts') drawKey(cv, t);
            else drawDump(cv, t, scr.secs);

            if (doc.ok) {
                const age = Math.round((Date.now() - doc.at) / 1000);
                const stale = Date.now() - doc.at > STALE_MS;
                const stamp = (APP_VER ? 'v' + APP_VER + '   ' : '') + translate('updated') + ' ' + age + ' s';
                cv.text(stamp, 1576 - 24, 126, SIZE, stale ? t.crit : t.dim, { align: 'right' });
            }
            G.frame(cv, t, SCREENS.map((s) => translate(s.name)), page);
            await ui.image('MAIN_GFX', cv);
        }

        /* ---------- controls ---------- */
        const tapLast = () => Math.max(0, Math.ceil(tapRows.length / TAP_ROWS) - 1);
        const step = (d) => {
            if (SCREENS[page].tap) {
                const want = tapPage + d;
                // inside the log: the buttons page it; at either end they leave it,
                // so the screen cannot become a dead end with the buttons alone
                if (want >= 0 && want <= tapLast()) { tapPage = want; return render(); }
            }
            page = (page + d + SCREENS.length) % SCREENS.length;
            if (SCREENS[page].tap) tapPage = 0;
            return render();
        };
        ui.text('BTN_ACTION', translate('Read again'));
        ui.onClick('BTN_ACTION', () => { load(); return render(); });
        ui.onClick('BTN_PAGE', () => step(1));
        ui.onClick('BTN_PREV', () => step(-1));
        ctx.onTab((i) => {
            if (i !== page) { page = i; if (SCREENS[page].tap) tapPage = 0; render(); }
        });

        load();
        setInterval(load, READ_MS);
        ctx.loop('MAIN', 2, render);
        render().then(() => log.info('carlife probe screen up')).catch((e) => log.warn('first render: ' + e));
    },
});
