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
 * carlife-probe.service) and draws it in four screens. Nothing here writes.
 */
const fs = require('fs');
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const { t: translate } = require('./kit/i18n');

const W = 1600, H = 520;
const REPORT = '/dev/shm/carlife-probe/report.txt';
const READ_MS = 2000;
const STALE_MS = 15000;
const SIZE = 20, LINE = 26;
const COL_W = 700;

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
    { name: 'Shim', secs: ['shim', 'boot'] },
    { name: 'How to read', help: true },
];

mgu.run({
    async start(ctx) {
        const { ui, log } = ctx;
        let page = 0;
        let doc = { ok: false, at: 0, meta: {}, sec: {} };

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
        function wrap(cv, str, width) {
            const out = [];
            let line = '';
            for (const ch of String(str)) {
                const next = line + ch;
                if (line && cv.textWidth(next, SIZE, { literal: true }) > width) {
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
                '    usb-net: ' + field('usb_net_iface') + '    access: ' + field('access');
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
            else if (scr.name === 'Key facts') drawKey(cv, t);
            else drawDump(cv, t, scr.secs);

            if (doc.ok) {
                const age = Math.round((Date.now() - doc.at) / 1000);
                const stale = Date.now() - doc.at > STALE_MS;
                cv.text(translate('updated') + ' ' + age + ' s', 1576 - 24, 126, SIZE,
                    stale ? t.crit : t.dim, { align: 'right' });
            }
            G.frame(cv, t, SCREENS.map((s) => translate(s.name)), page);
            await ui.image('MAIN_GFX', cv);
        }

        /* ---------- controls ---------- */
        const step = (d) => { page = (page + d + SCREENS.length) % SCREENS.length; return render(); };
        ui.text('BTN_ACTION', translate('Read again'));
        ui.onClick('BTN_ACTION', () => { load(); return render(); });
        ui.onClick('BTN_PAGE', () => step(1));
        ui.onClick('BTN_PREV', () => step(-1));
        ctx.onTab((i) => { if (i !== page) { page = i; render(); } });

        load();
        setInterval(load, READ_MS);
        ctx.loop('MAIN', 2, render);
        render().then(() => log.info('carlife probe screen up')).catch((e) => log.warn('first render: ' + e));
    },
});
