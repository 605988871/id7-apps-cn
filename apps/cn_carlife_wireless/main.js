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
 * Flow (the simplest it can be):
 *   - no picture yet  -> status lines saying which stage is waiting, and where
 *                        the hotspot is joined: MGU Store's own Wi-Fi page.
 *                        This app has no Wi-Fi UI at all - the Store owns the
 *                        uplink, and two places that both join hotspots would
 *                        fight over the one wlan0.
 *   - hotspot joined   -> the picture shows, filling the screen.
 *   - next launch      -> the Store re-joins the remembered hotspot, so the
 *                        picture appears without touching anything.
 *
 * This app never starts the native helpers - a JS app cannot spawn processes.
 * The carlife-wireless service owns both and restarts them together.
 *
 * NOTE on touch: the picture is sent with renderd's pixel-image op, which only
 * exists in the upstream dialect - and that dialect gives up touch claims
 * (CLAIM shares IMAGE's message number), so the renderer routes every tap to
 * the HMI instead of this app. Drawing a button here would therefore be a
 * control that can never be pressed (0.7.7's "连接热点" box was exactly that).
 * Turning taps on the picture into phone taps needs the native dialect, which
 * cannot carry pixel images - so for now the picture is watch-only, and
 * nothing on this page pretends to be pressable.
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

/* The canvas is the phone's own picture size: 1280 x 480 is 8:3, the shape the
 * phone encodes for a widescreen head unit (it accepted 1920x720 and lays
 * CarLife out to fill it). The renderer scales this canvas into the app's area
 * of the screen (84..1920 x 0..720, i.e. 1836 x 688) by 1836/1280 = 1.434, so
 * the picture fills the screen with only the HMI's back-arrow column and 16 px
 * above/below left dark.
 *
 * Matching the canvas to the picture is what makes this affordable on the
 * Atom: the canvas stops being a 1600x720 wrapper that must be re-uploaded in
 * full every frame (4.6 MB), and becomes the frame itself (2.4 MB). */
const W = 1280, H = 480;
/* The decoder is told (via crop.json) to emit the whole frame at this size. */
const SRC_W = 1280, SRC_H = 480;
const ATLAS = SRC_W * (SRC_H + (SRC_H >> 1));
const SOCK = '/dev/shm/carlife-wireless/live.sock';
const HOST_FILE = '/dev/shm/carlife-wireless/host';
const CTL_PORT = 7399;              /* carlife-link's app control socket */
const STATUS_JSON = '/run/mgu-uplink/status.json';
/* Where the native pipeline drops its reports. link.txt is written by
 * carlife-link (state/error/host/stream), and the decode report goes to the
 * /dev/shm/<name>-decode.txt beside the shm dir (see decode.c set_dir). */
const LINK_TXT = '/dev/shm/carlife-wireless/link.txt';
/* run.txt is the launcher's own report (written by run.sh on every start and
 * every restart); boot.txt is install.sh's selftest of the two services.
 * Without them a missing link.txt can only be rendered as "not started",
 * which is exactly what hid a dead carlife-wireless.service on the car. */
const RUN_TXT = '/dev/shm/carlife-wireless/run.txt';
const BOOT_TXT = '/dev/shm/carlife-wireless-boot.txt';
const DECODE_TXT = '/dev/shm/carlife-wireless-decode.txt';
const LEASE_JSON = '/run/mgu-uplink/lease.json';

const IMG = 1;                      /* image slot for the frame */

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;

        /* The hotspot is MGU Store's business (see the note at the top). The
         * one thing the app still does with the uplink is read its reports -
         * status.json, lease.json - so the status page can name the stage that
         * is waiting instead of a bare "no picture".
         *
         * A leftover host override from older versions is removed: the link
         * finds the phone on the network the car is actually on, so a stale
         * hand-typed address would send it to the previous hotspot. */
        if (fs.existsSync(HOST_FILE)) { try { fs.unlinkSync(HOST_FILE); } catch (e) { /* not ours */ } }

        /* ---------- picture source ---------- */
        const source = new CarlifeSource({ w: SRC_W, h: SRC_H, fps: 30, sockPath: SOCK });
        const frame = Buffer.alloc(SRC_W * SRC_H * 4);
        let haveFrame = false;
        let firstFrameAt = 0;
        /* A new picture is the only reason to redraw. The loop below runs at
         * the renderer's rate (up to 60 fps); drawing a frame from it whether
         * or not anything arrived is what pushed the same canvas to the
         * renderer sixty times a second, starved the socket that carries the
         * phone's frames (decode: 1598 of 1599 frames dropped) and left a
         * frozen picture on the screen. */
        let dirty = true;

        source.on('frame', (buf, seq, real) => {
            /* The source's "CARLIFE LIVE" page is a diagnostic placeholder it
             * draws while nothing is connected. It must never count as a real
             * picture. */
            if (real === false) return;
            if (!toRgba(buf, SRC_W, SRC_H, frame)) return;
            haveFrame = true;
            if (!firstFrameAt) firstFrameAt = Date.now();
            dirty = true;
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

        /* The canvas is the picture's own size, so the picture fills it: a tap
         * anywhere on the page is a fraction of the phone's frame, with no
         * letterbox to skip. (The renderer scales the whole canvas up into the
         * screen, so the arithmetic is the same at any display size.) */
        function frameRect() { return { x: 0, y: 0, w: W, h: H }; }
        /* The phone's CarLife drops a bare down/up pair that arrives in the
         * same millisecond: it needs at least one ACTION_MOVE and a press
         * that lasts long enough to be a tap. A quick tap on the HMI can
         * deliver phase 1 and phase 3 in the same frame with no phase 2 at
         * all, so normalise the gesture before it reaches carlife-link.
         * A real drag already has that body of moves, so its release is sent
         * immediately - holding it back makes dragging feel rubbery. */
        let gesture = null;
        function ctlWrite(line) {
            try { ctl.write(line + '\n'); } catch (e) { /* closed */ }
        }
        function sendTouch(phase, x, y) {
            if (!ctl) return;
            const r = frameRect();
            const fx = (x - r.x) / r.w, fy = (y - r.y) / r.h;
            if (fx < 0 || fx > 1 || fy < 0 || fy > 1) return;   /* in a bar */
            const px = Math.round(fx * 10000), py = Math.round(fy * 10000);
            const now = Date.now();
            if (phase === 1) {
                if (gesture) clearTimeout(gesture.moveTimer);
                gesture = { x: px, y: py, at: now, moveSent: false, moved: false, moveTimer: null };
                ctlWrite('down ' + px + ' ' + py);
                gesture.moveTimer = setTimeout(() => {
                    if (gesture && !gesture.moveSent) {
                        gesture.moveSent = true;
                        ctlWrite('move ' + gesture.x + ' ' + gesture.y);
                    }
                }, 70);
                return;
            }
            if (phase === 2) {
                if (gesture) {
                    clearTimeout(gesture.moveTimer);
                    gesture.moveSent = true;
                    gesture.moved = true;
                }
                ctlWrite('move ' + px + ' ' + py);
                return;
            }
            const g = gesture;
            if (!g) { ctlWrite('up ' + px + ' ' + py); return; }
            const sendUp = () => {
                clearTimeout(g.moveTimer);
                if (!g.moveSent) ctlWrite('move ' + px + ' ' + py);
                ctlWrite('up ' + px + ' ' + py);
                if (gesture === g) gesture = null;
            };
            if (g.moved) { sendUp(); return; }   /* drag: release at once */
            const wait = 170 - (now - g.at);
            if (wait > 0) setTimeout(sendUp, wait); else sendUp();
        }

        /* ---------- touch routing ---------- */
        if (ctx.onTouch) {
            ctx.onTouch((phase, x, y) => {
                /* Kept for the day the picture can carry touch (native dialect
                 * with a video path). On the car this never fires: the renderer
                 * cannot claim touches on a connection that sends pixel images,
                 * so taps go to the HMI instead. */
                if (!haveFrame) return true;
                sendTouch(phase, x, y);
                return true;                    /* the whole gesture belongs to the phone */
            });
        }

        /* ---------- drawing ---------- */
        const t = ctx.theme ? ctx.theme() : null;
        function render() {
            const cv = ctx.canvas(W, H).clear(t ? t.bg : '#000000');
            if (haveFrame) {
                setImage(IMG, SRC_W, SRC_H, frame);
                cv.image(IMG, 0, 0, W, H);

                if (settings.get('showStats')) {
                    const age = firstFrameAt ? ((Date.now() - firstFrameAt) / 1000).toFixed(0) : '0';
                    cv.text('CarLife ' + source.live + ' frames · ' + age + 's', 16, 24, 16, '#ffffff');
                }
                return ui.image('MAIN_GFX', cv);
            }
            /* No picture yet: what the pipeline is doing, and the one thing
             * the driver has to do (join the hotspot in the Store). */
            drawHint(cv);
            return ui.image('MAIN_GFX', cv);
        }
        /* Parse a "key: value" report (link.txt / decode.txt) into an object,
         * or null when the file is absent (that stage never ran). */
        function readKV(path) {
            try {
                const s = fs.readFileSync(path, 'utf8');
                const o = {};
                s.split('\n').forEach((ln) => {
                    const i = ln.indexOf(':');
                    if (i > 0) o[ln.slice(0, i).trim()] = ln.slice(i + 1).trim();
                });
                return o;
            } catch (e) { return null; }
        }

        const LINK_STATE_ZH = {
            'idle': '取流链路待机',
            'connecting': '正在连接手机',
            'handshake': '正在与手机握手',
            'looking for the phone': '正在查找手机',
            'no phone on the network': '找不到手机（确认热点已连、百度 CarLife 已打开）',
            'waiting for picture': '已连接，等待画面',
            'reconnecting': '手机没有回画面，正在重新连接',
            'phone closed cmd': '手机断开控制通道',
            'phone closed video': '手机断开画面通道',
            'streaming': '正在接收画面'
        };

        /* A few short lines saying exactly where the pipeline is, read from
         * the native side's own reports, so a failed link names its reason
         * instead of a bare "waiting".
         *
         * mgu-uplink uses link "connected" for a wpa_supplicant association
         * and "online" only once it has a DHCP lease. They are NOT the same:
         * a unit that associated but has no lease has no phone address for
         * carlife-link to dial. Say which one it is on the screen. */
        function diagnose() {
            const lines = [];
            let lease = null;
            try { lease = JSON.parse(fs.readFileSync(LEASE_JSON, 'utf8')); } catch (e) { /* no lease yet */ }
            let wifiErr = '';
            try {
                const st = JSON.parse(fs.readFileSync(STATUS_JSON, 'utf8'));
                const w = st.wifi || {};
                wifiErr = w.error || '';
                if (w.link === 'online') {
                    /* w.ip is the CAR's own address on the phone's hotspot (the
                     * lease DHCP gave us), not the phone's. Printed bare after
                     * the SSID it read as "the phone is at 10.92.100.115",
                     * which is the car itself - and the phone was at .136. */
                    lines.push('热点：已连接 ' + (w.ssid || '') +
                        (w.ip ? '（本机 ' + w.ip + '）' : ''));
                } else if (w.link === 'connected') {
                    lines.push('热点：已关联 ' + (w.ssid || '') +
                        (lease && lease.router ? '' : '（尚未获取 IP 租约）'));
                } else if (w.enabled) {
                    lines.push('热点：Wi-Fi 已开启，尚未连接');
                } else {
                    lines.push('热点：未连接，请在 MGU 商店里连接');
                }
            } catch (e) { lines.push('热点：未检测到 mgu-uplink'); }
            if (wifiErr && lines.length < 5) lines.push('热点提示：' + wifiErr);

            const lr = readKV(LINK_TXT);
            const rr = readKV(RUN_TXT);
            /* run.sh no longer deletes link.txt, so a session that just died
             * can leave a stale "streaming" behind. A launcher that wrote
             * "restarting" after that report is the newer, truer story. */
            const mtime = (p) => { try { return fs.statSync(p).mtimeMs; } catch (e) { return 0; } };
            const crashed = rr && (rr.state || '').trim() === 'restarting' &&
                (!lr || mtime(RUN_TXT) >= mtime(LINK_TXT) - 2000);
            if (crashed) {
                lines.push('取流服务：反复重启 · ' + (rr.detail || '原因未知'));
                /* run.txt only knows which half exited, not why. link.txt is
                 * the report the linker writes while it runs, so it still
                 * holds the reason the stream stopped ("no phone on the
                 * network", a refused handshake). Without it the screen can
                 * only name a symptom - which is how a launcher that never
                 * connected the two halves looked like a decoder bug. */
                if (lr && lr.error && lr.error !== 'none') {
                    lines.push('取流错误：' + lr.error);
                } else if (lr) {
                    /* "streaming" is the state the link had a moment before it
                     * died; repeating it beside "反复重启" would contradict
                     * itself. Only a state that says something is wrong is
                     * worth a line here. */
                    const st = LINK_STATE_ZH[(lr.state || '').trim()];
                    if (st && (lr.state || '').trim() !== 'streaming') {
                        lines.push('取流链路：' + st);
                    }
                }
            } else if (lr) {
                const lstate = (lr.state || '').trim();
                /* The phone's address, straight from the link that dialled it -
                 * the hotspot line above only knows the car's own address. */
                const phone = lstate === 'streaming' || lstate === 'waiting for picture'
                    ? (lr.host ? ' · 手机 ' + lr.host : '')
                    : '';
                lines.push((LINK_STATE_ZH[lstate] || ('取流：' + lr.state)) + phone);
                /* While the link is re-homing after a hotspot change it is
                 * still holding the address it dialled a moment ago, and the
                 * dial error names exactly that address. Shown beside "正在
                 * 查找手机" it reads as "the IP never switched" - which is
                 * what the car reported. Name the address and say what the
                 * link is doing with it instead. */
                if (lstate === 'looking for the phone' || lstate === 'no phone on the network') {
                    lines.push('地址：' + (lr.host || '?') + '（按当前网络重新查找）');
                } else if (lr.error && lr.error !== 'none') {
                    lines.push('取流错误：' + lr.error);
                }
            } else if (rr) {
                /* No link report: the service ran but carlife-link never got
                 * as far as writing one. run.txt says what it was dialing. */
                lines.push('取流服务：已启动 → ' + (rr.phone || '?') +
                    '（' + (rr.source || '?') + '）');
            } else {
                let boot = '';
                try { boot = fs.readFileSync(BOOT_TXT, 'utf8'); } catch (e) { /* absent */ }
                const m = /state carlife-wireless\.service:\s*(\S+)/.exec(boot);
                if (m) {
                    lines.push('取流服务：' + (m[1] === 'active'
                        ? '运行中，但未生成取流报告' : '未运行（' + m[1] + '）'));
                } else {
                    lines.push('取流服务：未检测到，请重装 CarLife 无线组件');
                }
            }
            const dr = readKV(DECODE_TXT);
            if (dr) {
                /* The decoder's state is the last line it noted, which is an
                 * English sentence from the C side. The one the user actually
                 * meets is the cascade after the link goes away; say that in
                 * Chinese, and leave anything unknown in its original words -
                 * a wrong translation would be worse than none. */
                const DS_ZH = {
                    'stream ended, exiting for service restart':
                        '取流链路已断开，等待服务重启',
                    'stream ended':
                        '取流链路已断开，等待服务重启'
                };
                const ds = DS_ZH[(dr.state || '').trim()] || dr.state;
                if (ds && ds !== 'starting') lines.push('解码：' + ds);
                if (dr.error && dr.error !== 'none') lines.push('解码错误：' + dr.error);
            }
            return lines;
        }

        /* No picture: what the pipeline is doing, and the only thing the
         * driver has to do (join the hotspot in the Store). Nothing drawn here
         * is a control - on this screen the HMI gets every tap (see the note
         * at the top), so a box that looked like a button would be a lie. */
        function drawHint(cv) {
            cv.text('CarLife 无线投屏', W / 2, 132, 34, '#ffffff', { align: 'center', literal: true });
            cv.text('请在 MGU 商店里连接手机热点', W / 2, 184, 22, '#e5e7eb', { align: 'center', literal: true });
            cv.text('热点连上后本页会自动显示画面', W / 2, 216, 17, '#9aa0a6', { align: 'center', literal: true });

            /* The real reason nothing shows yet, straight from the pipeline. */
            const lines = diagnose().slice(0, 5);
            if (!lines.length) lines.push('取流组件尚未生成报告');
            let dy = 272;
            lines.forEach((line) => {
                const warn = /失败|错误|找不到|未检测|尚未/.test(line);
                cv.text(line, W / 2, dy, 16, warn ? '#f59e0b' : '#9aa0a6', { align: 'center', literal: true });
                dy += 24;
            });
        }

        /* Redraw when something changed. A picture costs 2.4 MB of upload, so
         * it is only drawn when a new frame arrived (and once a second anyway:
         * the renderer hides an app that has said nothing for 3 s). The status
         * page has no picture and costs nothing to draw, so it is drawn every
         * tick - that is what makes it follow link.txt while it waits. */
        let lastDraw = 0;
        ctx.loop('MAIN', 30, () => {
            const now = Date.now();
            if (!dirty && haveFrame && now - lastDraw < 900) return;
            dirty = false;
            lastDraw = now;
            return render();
        });

        /* Keep the source alive for the app's lifetime; shutdown is handled by
         * mgu.run (MainApp asks us to exit), so stop our timers then. */
        process.on('exit', () => {
            clearInterval(ctlTimer);
            if (gesture) clearTimeout(gesture.moveTimer);
            try { source.stop(); } catch (e) { /* shutting down */ }
            if (ctl) { try { ctl.destroy(); } catch (e) { /* closed */ } }
        });
    }
});
