'use strict';
/**
 * Wireless CarLife - the screen for carlife-link.
 *
 * The tool is the head unit to the phone over Wi-Fi; this app is what the
 * driver sees while it does that. It reads the tool's report
 * (/dev/shm/carlife-wireless/report.txt, rewritten once a second) and says
 * where the link stands: whether the phone was found, whether the handshake
 * matched, what size the encoder was asked for, how much picture and audio
 * arrived, and the first thing that failed.
 *
 * That is the whole app on purpose. Reading a report costs nothing and cannot
 * lie about the link, whereas a screen that pretends to be the phone would hide
 * exactly the part that is not finished yet: the decode.
 *
 * The one thing it can do is ask for a fresh connection (the bar's button, or
 * the control port at 127.0.0.1:7399 "retry"), which is what a driver needs
 * when the phone was in the pocket when the car started.
 */
const fs = require('fs');
const net = require('net');
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const { t: translate } = require('./kit/i18n');

const W = 1600, H = 520;
const REPORT = '/dev/shm/carlife-wireless/report.txt';
const CTL = { host: '127.0.0.1', port: 7399 };
const READ_MS = 1000;
const STALE_MS = 6000;

mgu.run({
    async start(ctx) {
        const { ui, log } = ctx;
        let page = 0;
        let report = { at: 0, map: {}, lines: [], missing: true };

        /* ---------- the report ---------- */
        function load() {
            let text;
            try {
                text = fs.readFileSync(REPORT, 'utf8');
            } catch (e) {
                report = { at: 0, map: {}, lines: [], missing: true };
                return;
            }
            const lines = text.split(/\r?\n/).filter((l) => l && !l.startsWith('==='));
            const map = {};
            lines.forEach((l) => {
                const i = l.indexOf(': ');
                if (i > 0) map[l.slice(0, i)] = l.slice(i + 2);
            });
            report = { at: Date.now(), map, lines, missing: false };
        }
        load();
        const timer = setInterval(load, READ_MS);
        process.on('exit', () => clearInterval(timer));

        const field = (key, fallback) => report.map[key] || fallback || '--';

        /* ---------- asking the tool for a fresh connection ---------- */
        let pending = false;
        function reconnect() {
            if (pending) return Promise.resolve(false);
            pending = true;
            return new Promise((resolve) => {
                const s = net.createConnection({ host: CTL.host, port: CTL.port });
                let done = false;
                const finish = (ok) => {
                    if (done) return;
                    done = true;
                    pending = false;
                    try { s.destroy(); } catch (e) { /* already gone */ }
                    if (!ok) log.warn('control port ' + CTL.port + ' did not answer: is carlife-link installed?');
                    resolve(ok);
                };
                s.setTimeout(1500, () => finish(false));
                s.on('connect', () => s.write('retry\n'));
                s.on('data', () => finish(true));
                s.on('error', () => finish(false));
            });
        }

        /* ---------- drawing ---------- */
        /* The tool's own `state` line is English and technical, which is right
         * for a report and wrong for the biggest text on the screen. The same
         * four facts, in the driver's language, come out of the fields that
         * decide them: is anything there, did the phone answer, is a picture
         * arriving. */
        function headline(t) {
            if (report.missing) return [translate('No report yet'), t.crit];
            if (!report.at || Date.now() - report.at > STALE_MS) return [translate('Tool not running'), t.crit];
            const cmd = report.map.cmd || '', video = report.map.video || '', state = report.map.state || '';
            if (cmd.includes('closed') || state.includes('not reachable') || state.includes('no phone')) return [translate('No phone found'), t.crit];
            if (!cmd.includes('match=yes')) return [translate('Waiting for the phone'), t.accent2];
            if (/\bframes=0\b/.test(video)) return [translate('Connected, waiting for picture'), t.accent2];
            return [translate('Picture is arriving'), t.accent];
        }

        /* yes/no/open/closed are the tool's words, not the driver's. */
        const localize = (v) => v
            .replace(/\byes\b/g, translate('yes'))
            .replace(/\bno\b/g, translate('no'))
            .replace(/\bopen\b/g, translate('open'))
            .replace(/\bclosed\b/g, translate('closed'));

        function row(cv, t, x, y, label, value, colour) {
            cv.text(translate(label), x, y, 22, t.dim, { font: 'bold', spacing: 1.5 });
            cv.text(value, x + 210, y + 2, 28, colour || t.text, { font: 'num' });
        }

        function drawLink(cv, t) {
            const sh = G.panel(cv, t, 24, 44, 1552, 468, translate('Link'));
            const [head, colour] = headline(t);
            cv.text(head, sh.x + 24, 140, 54, colour, { font: 'bold', spacing: 1 });

            const err = field('error', 'none');
            const host = field('host');
            row(cv, t, sh.x + 26, 214, 'Phone', host === '--' ? '--' : `${host}  ·  ${translate('port')} ${field('base')}`);
            row(cv, t, sh.x + 26, 258, 'Command', localize(field('cmd')));
            row(cv, t, sh.x + 26, 302, 'Video', localize(field('video')));
            row(cv, t, sh.x + 26, 346, 'Stream', localize(field('stream')));
            row(cv, t, sh.x + 26, 390, 'Audio', localize(field('audio')));
            row(cv, t, sh.x + 26, 434, 'Touch', localize(field('touch')));
            cv.text(translate('Error') + '  ' + err, sh.x + 26, 484, 24, err === 'none' ? t.dim : t.crit, { font: 'bold' });

            if (pending) cv.text(translate('Asking for a fresh connection'), 1576 - 24, 140, 24, t.accent2, { align: 'right', font: 'bold' });
            else if (report.at) cv.text(translate('updated') + ' ' + Math.round((Date.now() - report.at) / 1000) + ' s', 1576 - 24, 140, 24, t.dim, { align: 'right', font: 'bold' });
        }

        function drawHelp(cv, t) {
            const sh = G.panel(cv, t, 24, 44, 1552, 468, translate('Help'));
            const lines = [
                ['Car or phone?', 'The car connects to the phone: the phone runs the CarLife server, the car is the client.'],
                ['On the phone', 'Open CarLife and start its wireless connection, then leave it in the foreground.'],
                ['Same network', 'Both devices must be on one network - the car\'s hotspot, or a hotspot the phone shares.'],
                ['What works now', 'Handshake, picture bytes, audio bytes and touch. The picture is not decoded yet: that is the next step.'],
            ];
            let y = 132;
            lines.forEach(([head, body]) => {
                cv.text(translate(head).toUpperCase(), sh.x + 26, y, 22, t.accent2, { font: 'bold', spacing: 2 });
                cv.text(translate(body), sh.x + 26, y + 38, 26, t.text);
                y += 100;
            });
        }

        async function render() {
            const t = ctx.theme(), cv = ctx.canvas(W, H).clear(t.bg);
            (page === 0 ? drawLink : drawHelp)(cv, t);
            G.frame(cv, t, [translate('Link'), translate('Help')], page);
            await ui.image('MAIN_GFX', cv);
        }

        /* ---------- controls ---------- */
        const actionLabel = () => ui.text('BTN_ACTION', translate('Reconnect'));
        const flip = () => { page = 1 - page; return render(); };
        ui.onClick('BTN_PAGE', flip);
        ui.onClick('BTN_PREV', flip);
        ctx.onTab((i) => i !== page && flip());
        ui.onClick('BTN_ACTION', () => reconnect().then(() => { load(); return render(); }));
        actionLabel();

        ctx.loop('MAIN', 5, render);
        render().then(() => log.info('wireless carlife screen up')).catch((e) => log.warn('first render: ' + e));
    },
});
