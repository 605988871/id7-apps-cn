'use strict';
/**
 * CarLife Wireless - the phone's whole CarLife picture on the central display.
 *
 * The phone runs Baidu CarLife and opens a WiFi hotspot. carlife-link (a
 * native helper installed beside this app) joins that hotspot, does the
 * CarLife version handshake over six TCP ports, and receives the phone's
 * H.264 stream. carlife-decode turns it into CLMF (YUV 4:2:0) frames on a unix
 * socket. This app is the last hop: it reads those frames, colours them, and
 * draws them full-screen; taps go back through link's control socket as
 * normalised points.
 *
 * This app never starts the native helpers - a JS app cannot spawn processes.
 * The carlife-wireless service owns both and restarts them together. When no
 * picture is coming this page says so plainly: a dark screen is otherwise
 * indistinguishable from a phone that never connected.
 *
 * Split out so each half can be checked on a desk:
 *   carlife_source.js  CLMF frames off the socket (with its own tests)
 *   hud_convert.js     YUV 4:2:0 atlas -> RGBA (BT.601, with its own tests)
 */
const net = require('net');
const fs = require('fs');
const mgu = require('./kit/mgu');
const { setImage } = require('./kit/record');
const { CarlifeSource } = require('./carlife_source');
const { toRgba } = require('./hud_convert');
const { WifiPage } = require('./wifi_page');

/* The central-display canvas. 16:9-ish so the phone's 1280x720 picture fits
 * with small side bars; the kit scales this into the screen's image area. */
const W = 1600, H = 720;
/* The decoder is told (via crop.json) to emit the whole frame at this size. */
const SRC_W = 1280, SRC_H = 720;
const ATLAS = SRC_W * (SRC_H + (SRC_H >> 1));
const SOCK = '/dev/shm/carlife-wireless/live.sock';
const HOST_FILE = '/dev/shm/carlife-wireless/host';
const CTL_PORT = 7399;              /* carlife-link's app control socket */

const IMG = 1;                      /* image slot for the frame */

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;

        /* The service reads the phone's address from a file under /dev/shm
         * (0777), so the app publishes the address typed in Settings without
         * root or SSH. The service picks it up on its next retry cycle. */
        const publishHost = () => {
            const h = String(settings.get('host') || '').trim();
            try {
                if (h) fs.writeFileSync(HOST_FILE, h + '\n');
                else { try { fs.unlinkSync(HOST_FILE); } catch (e) { /* absent */ } }
            } catch (e) { /* shm dir not ready yet */ }
        };
        publishHost();
        if (settings.onChange) settings.onChange(publishHost);   /* any settings change rechecks the host */

        /* ---------- Wi-Fi page (join the phone hotspot from here) ---------- */
        let page = 'main';                  /* 'main' | 'wifi' */
        const wifiPage = new WifiPage(ctx, settings, () => { page = 'main'; });

        /* ---------- picture source ---------- */
        const source = new CarlifeSource({ w: SRC_W, h: SRC_H, fps: 30, sockPath: SOCK });
        const frame = Buffer.alloc(SRC_W * SRC_H * 4);
        let haveFrame = false;
        let status = 'waiting for the decoder';
        let firstFrameAt = 0;

        source.on('status', (s) => { status = s; });
        source.on('frame', (buf) => {
            if (!toRgba(buf, SRC_W, SRC_H, frame)) return;
            haveFrame = true;
            if (!firstFrameAt) firstFrameAt = Date.now();
        });
        source.start();

        /* ---------- touch back to the phone ---------- */
        /* link wants normalised points (0..10000) and scales them to the
         * encoded frame itself, so the exact display scale never matters here. */
        let ctl = null;
        function ctlConnect() {
            if (ctl) return;
            const s = net.connect({ host: '127.0.0.1', port: CTL_PORT });
            s.on('connect', () => { ctl = s; });
            s.on('error', () => { ctl = null; });
            s.on('close', () => { if (ctl === s) ctl = null; });
        }
        ctlConnect();
        const ctlTimer = setInterval(() => { if (!ctl) ctlConnect(); }, 1500);

        /* The phone's picture sits centred, scaled to fit (or fill) the app's
         * canvas. Map a tap in app coordinates back to a fraction of the
         * picture, ignoring taps in the letterbox bars. */
        function frameRect() {
            const fit = settings.get('orientation') !== 'fill';
            const s = fit ? Math.min(W / SRC_W, H / SRC_H) : Math.max(W / SRC_W, H / SRC_H);
            const w = SRC_W * s, h = SRC_H * s;
            return { x: (W - w) / 2, y: (H - h) / 2, w, h };
        }
        function sendTouch(phase, x, y) {
            if (!ctl) return;
            const r = frameRect();
            const fx = (x - r.x) / r.w, fy = (y - r.y) / r.h;
            if (fx < 0 || fx > 1 || fy < 0 || fy > 1) return;   /* in a bar */
            const px = Math.round(fx * 10000), py = Math.round(fy * 10000);
            const cmd = phase === 1 ? 'down' : phase === 3 ? 'up' : 'move';
            try { ctl.write(cmd + ' ' + px + ' ' + py + '\n'); } catch (e) { /* closed */ }
        }

        /* The Wi-Fi button sits at the top right of every frame (its own
         * drawing below); all other taps go to the phone when a picture is up. */
        const WIFI_BTN = { x: W - 186, y: 14, w: 172, h: 54 };
        function inWifiButton(x, y) {
            return x >= WIFI_BTN.x && x <= WIFI_BTN.x + WIFI_BTN.w &&
                y >= WIFI_BTN.y && y <= WIFI_BTN.y + WIFI_BTN.h;
        }
        if (ctx.onTouch) {
            ctx.onTouch((phase, x, y) => {
                if (page === 'wifi') return wifiPage.touch(phase, x, y);
                if (phase === 1 && inWifiButton(x, y)) {
                    wifiPage.refresh();
                    page = 'wifi';
                    return true;
                }
                if (!haveFrame) return false;
                sendTouch(phase, x, y);
                return true;                    /* the whole gesture belongs to the phone */
            });
        }

        /* ---------- drawing ---------- */
        const t = ctx.theme ? ctx.theme() : null;
        function render() {
            const cv = ctx.canvas(W, H).clear(t ? t.bg : '#000000');
            if (page === 'wifi') {
                wifiPage.render(cv, t, W, H);
                return ui.image('MAIN_GFX', cv);
            }
            if (haveFrame) {
                const r = frameRect();
                setImage(IMG, SRC_W, SRC_H, frame);
                cv.image(IMG, Math.round(r.x), Math.round(r.y), Math.round(r.w), Math.round(r.h));

                if (settings.get('showStats')) {
                    const age = firstFrameAt ? ((Date.now() - firstFrameAt) / 1000).toFixed(0) : '0';
                    cv.text('CarLife ' + source.live + ' frames · ' + age + 's', 16, 24, 18, '#ffffff');
                }
                drawWifiButton(cv);
                return ui.image('MAIN_GFX', cv);
            }
            /* No picture: say exactly why, rather than showing a black screen
             * that looks like a broken app. */
            const msg = status || 'waiting for the phone';
            cv.text('CarLife 无线投屏', W / 2, H / 2 - 30, 30, '#ffffff', { align: 'center', literal: true });
            cv.text(msg, W / 2, H / 2 + 16, 20, '#9aa0a6', { align: 'center', literal: true });
            cv.text('手机开热点并打开百度 CarLife，点右上角「连热点」在本应用内连接', W / 2, H / 2 + 52, 17, '#6b7280', { align: 'center', literal: true });
            drawWifiButton(cv);
            return ui.image('MAIN_GFX', cv);
        }
        function drawWifiButton(cv) {
            cv.roundRect(WIFI_BTN.x, WIFI_BTN.y, WIFI_BTN.w, WIFI_BTN.h, 10, '#3b82f6');
            cv.text('连热点', WIFI_BTN.x + WIFI_BTN.w / 2, WIFI_BTN.y + 35, 20,
                '#ffffff', { align: 'center', literal: true });
        }
        ctx.loop('MAIN', 30, render);

        /* Keep the source alive for the app's lifetime; shutdown is handled by
         * mgu.run (MainApp asks us to exit), so stop our timers then. */
        process.on('exit', () => {
            clearInterval(ctlTimer);
            try { source.stop(); } catch (e) { /* shutting down */ }
            if (ctl) { try { ctl.destroy(); } catch (e) { /* closed */ } }
        });
    }
});
