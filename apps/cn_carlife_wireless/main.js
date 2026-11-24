'use strict';
/**
 * CarLife Wireless - the phone's whole CarLife picture on the central display.
 *
 * The phone runs Baidu CarLife and opens a WiFi hotspot. carlife-link (a
 * native helper installed beside this app) joins that hotspot, does the
 * CarLife version handshake over six TCP ports, and receives the phone's
 * H.264 stream. carlife-decode turns it into I420 frames in the GPU renderer's
 * own video file. This app is the last hop: it names that file to the renderer
 * (one draw op, cv.video), claims the picture's area so taps go to the phone,
 * and forwards each touch back through link's control socket as a normalised
 * point.
 *
 * Why a video file and not pixels: the previous versions uploaded every frame
 * to the renderer themselves (2.4 MB a frame over the socket, after colouring
 * the YUV in JS). On the Atom that put a queue between the phone and the glass
 * and the picture answered seconds late. The renderer reads the file itself and
 * always draws its newest frame, so a picture can no longer be stale.
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
 * Touch: on this connection the renderer routes touch to the app that claims
 * the area (mgu-render/1, IterioDev's divert), so the picture can be dragged
 * and tapped and the HMI's own button bar - which the picture covers but does
 * not remove - never sees those taps.
 *
 * One file now. 0.8.0 deleted the frame path through JS (carlife_source.js,
 * atlas.js, hud_convert.js, wait_policy.js) and two modules nothing had used
 * since the picture stopped being pixels (cluster_render_client.js,
 * speller.js): ~1500 lines that still went into every bundle.
 */
const net = require('net');
const fs = require('fs');
const mgu = require('./kit/mgu');
const { setVideo } = require('./kit/record');

/* The picture is the phone's own frame size, 1920 x 720 = 8:3, the shape the
 * phone encodes for a widescreen head unit. The renderer fits it into the app's
 * area (84..1920 x 0..720, i.e. 1836 x 688) itself: 1920 -> 1836 is one
 * filtered step down, which is why the picture is sharp now - the old path went
 * 1920 -> 1280 here (nearest pixel) and 1280 -> 1835 there. */
const W = 1920, H = 720;
/* The decoder writes whatever the phone sends; 1920x720 is what link asks for
 * and what the phone agrees to (link.txt: "video: open 1920x720@30"). */
const VIDEO_ID = 1;
const VIDEO_FILE = '/dev/shm/mgu-video-carlife';
const HEADER = 64;                  /* MGVF header: magic, version, w, h, seq, slot, ... */
const MAGIC = 0x4656474d;
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

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;

        /* The hotspot is MGU Store's business (see the note at the top). The
         * one thing the app still does with the uplink is read its reports -
         * status.json, lease.json - so the status page can name the stage that
         * is waiting instead of a bare "no picture". */
        /* ---------- the picture ---------- */
        /* The renderer draws the decoder's file directly; naming it once per
         * connection is all a feed costs. */
        setVideo(VIDEO_ID, VIDEO_FILE);

        /* What the decoder's file says: how many frames it has written, and at
         * what size. The app reads the 64-byte header, not the picture - this is
         * the only signal that a real frame exists (the file is there, empty,
         * from the moment the decoder starts). */
        const hdr = Buffer.alloc(HEADER);
        let vidSeq = 0, vidW = 0, vidH = 0, firstFrameAt = 0;
        function readVideo() {
            let fd = -1;
            try {
                /* Opened each time, not kept: a decoder that restarts makes the
                 * file anew, and a held handle would then read the old picture's
                 * header for ever (a frozen screen with no error). */
                fd = fs.openSync(VIDEO_FILE, 'r');
                if (fs.readSync(fd, hdr, 0, HEADER, 0) < HEADER) { vidSeq = 0; return false; }
                if (hdr.readUInt32LE(0) !== MAGIC || hdr.readUInt32LE(4) !== 1) { vidSeq = 0; return false; }
                const w = hdr.readUInt32LE(8), h = hdr.readUInt32LE(12), seq = hdr.readUInt32LE(16);
                if (!w || !h || w > 2048 || h > 2048) { vidSeq = 0; return false; }
                vidW = w; vidH = h; vidSeq = seq;
                if (seq > 0 && !firstFrameAt) {
                    firstFrameAt = Date.now();
                    log.info('carlife: first picture after ' + sinceStart() + ' ms (' + w + 'x' + h + ')');
                }
                return seq > 0;
            } catch (e) {
                vidSeq = 0;                        /* the decoder is not there (yet) */
                return false;
            } finally {
                if (fd >= 0) { try { fs.closeSync(fd); } catch (e2) { /* gone */ } }
            }
        }
        const t0 = Date.now();
        function sinceStart() { return Date.now() - t0; }

        /* ---------- is the phone still feeding us? ----------
         * The video file keeps its last frame when the phone walks out of
         * range, so the header alone cannot say the stream stopped - seq just
         * stays where it was and the renderer keeps drawing that old picture.
         * link.txt is rewritten every second with the state of the connection;
         * decode.txt says "stream ended" when its input closes. Both are the
         * native side's own words, not a guess from a stale frame count.
         *
         * The states listed here are the ones with no picture behind them:
         * reconnecting / connecting / handshake / looking for the phone /
         * a channel the phone closed / not reachable. "streaming" and the
         * early "waiting for picture" / "matched" / "asked ..." still count as
         * healthy, so a handshake hiccup does not blank a working picture. */
        let linkLostAt = 0;
        const GRACE_MS = 3000;             /* a short outage is not a disconnect */
        function linkHealthy() {
            /* The launcher says "restarting" when either native half exited.
             * link.txt can still read "streaming" from a moment before the
             * crash, so the launcher's newer report wins here. */
            const rr = readKV(RUN_TXT);
            if (rr && (rr.state || '').trim() === 'restarting') return false;
            const lr = readKV(LINK_TXT);
            if (!lr) return true;          /* no report yet: do not guess */
            const st = (lr.state || '').trim();
            if (lr.error && lr.error !== 'none') return false;
            if (/^streaming$|^waiting for picture$|^matched$|^asked /.test(st)) return true;
            if (/^reconnecting$|^connecting$|^handshake$|^looking for the phone$|^no phone on the network$|^phone not reachable$|^phone closed /.test(st)) return false;
            const dr = readKV(DECODE_TXT);
            if (dr && /stream ended/.test(dr.state || '')) return false;
            return true;                   /* unknown states: keep the picture */
        }

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
        /* Where the renderer routes touch to this app (mgu-render/1 and a claim:
         * display.js claims the picture's whole area), every gesture on the
         * picture belongs to the phone: no tap, no scroll and no HMI button
         * under it. Without a picture there is nothing to press on the phone,
         * so the gesture is left to the kit. */
        if (ctx.onTouch) {
            ctx.onTouch((phase, x, y) => {
                if (!vidSeq) return false;
                sendTouch(phase, x, y);
                return true;
            });
        }

        /* ---------- drawing ---------- */
        const t = ctx.theme ? ctx.theme() : null;
        let showing = false;          /* the picture is what the last frame drew */
        function render() {
            const cv = ctx.canvas(W, H).clear(t ? t.bg : '#000000');
            if (showing) {
                /* One op. The renderer reads the file's newest frame each time
                 * it draws the app, so this frame is only sent again to say the
                 * app is alive (the kit does that once a second) - never per
                 * picture. That is the whole fix for a picture that was seconds
                 * behind: nothing between the phone and the glass buffers it. */
                cv.video(VIDEO_ID, 0, 0, W, H, 0);
                if (lagLine) {
                    cv.text(lagLine, 24, 40, 22, '#fbbf24', { literal: true });
                }
                if (settings.get('showStats')) {
                    cv.text('CarLife ' + vidSeq + ' frames · ' + Math.round(sinceStart() / 1000) + 's · ' +
                        vidW + 'x' + vidH, 24, 74, 22, '#ffffff', { literal: true });
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

        /* carlife-link used to queue 6 MB before the decoder - six to ten
         * seconds of screen content, which is why a gesture appeared that long
         * after the finger moved. It is 1 MB now, but only the car can tell us
         * whether the decoder still falls behind. One small line appears when
         * it does, so the numbers are on the screen instead of needing a shell
         * on the head unit. Only redrawn when the line changes: the renderer
         * refreshes the picture itself. */
        let lagLine = '', lagShown = '', lagAt = 0;
        function readLag() {
            const now = Date.now();
            if (now - lagAt < 500) return;
            lagAt = now;
            const d = readKV(DECODE_TXT), l = readKV(LINK_TXT);
            if (!d || !l) { lagLine = ''; return; }
            const f = /^(\d+)\s+rate\s+(\d+)\s+fps\s+last\s+(\d+)ms/.exec(d.frames || '');
            const v = l.video || '';
            /* @60 is the phone's ENCODER CONFIGURATION, not the frames it
             * actually sends: on the car it said @60 while the stream carried
             * about 24. push=Nfps is measured from received frames. */
            const want = /push=(\d+)fps/.exec(v), buf = /backlog=(\d+)%/.exec(v),
                  skip = /skipped=(\d+)/.exec(v);
            const rate = f ? +f[2] : 0, fps = want ? +want[1] : 0,
                  q = buf ? +buf[1] : 0, sk = skip ? +skip[1] : 0;
            /* Normally this stays hidden so the picture is clean. With the
             * "show stats" setting on it is always drawn: the car reported
             * @60 (encoder config) while actually pushing ~24, so seeing the
             * two rates together is how the next report gets answered without
             * another round of guessing. */
            lagLine = (settings.get('showStats') || (fps && rate && rate + 4 < fps) || q > 20)
                ? 'DEC ' + rate + '/' + fps + 'fps  BUF ' + q + '%  SKIP ' + sk : '';
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
            /* The decoder is the stage between a stream that arrives and a
             * picture that can be drawn: say what it is doing, and - when it
             * is decoding - that the renderer, not the decoder, is the one
             * holding the picture back. */
            const dr = readKV(DECODE_TXT);
            if (dr) {
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
            /* A picture the decoder has written and this screen cannot draw:
             * the renderer in this unit has no video channel (mgu-render/1's
             * op 19), so say that instead of leaving a bare "waiting". */
            if (vidSeq > 0 && !ctx.video()) {
                lines.push('渲染器不支持视频通道，请安装 MGU 商店的 GPU 渲染器');
            }
            return lines;
        }

        /* No picture: what the pipeline is doing, and the only thing the
         * driver has to do (join the hotspot in the Store). */
        function drawHint(cv) {
            cv.text('CarLife 无线投屏', W / 2, 250, 52, '#ffffff', { align: 'center', literal: true });
            cv.text('请在 MGU 商店里连接手机热点', W / 2, 330, 34, '#e5e7eb', { align: 'center', literal: true });
            cv.text('热点连上后本页会自动显示画面', W / 2, 386, 26, '#9aa0a6', { align: 'center', literal: true });

            /* The real reason nothing shows yet, straight from the pipeline. */
            const lines = diagnose().slice(0, 5);
            if (!lines.length) lines.push('取流组件尚未生成报告');
            let dy = 476;
            lines.forEach((line) => {
                const warn = /失败|错误|找不到|未检测|尚未|不支持/.test(line);
                cv.text(line, W / 2, dy, 24, warn ? '#f59e0b' : '#9aa0a6', { align: 'center', literal: true });
                dy += 34;
            });
        }

        /* The renderer draws new video frames by itself, so there is nothing to
         * redraw per picture: this loop only notices the change from the status
         * page to the picture (and back), and keeps the status page following
         * the reports while it waits. A video frame costs one small message,
         * which the kit sends once a second to stay "alive". */
        let ready = false;
        ctx.loop('MAIN', 30, () => {
            /* The header is a 64-byte read of a tmpfs file, 60 times a second:
             * nothing. It is the app's whole knowledge of the picture - frames
             * written, and at what size - so it is read on every tick rather
             * than reasoned about. */
            readVideo();
            readLag();
            /* A phone that left the hotspot stops updating link.txt within a
             * second. Hold the old picture through brief hiccups, then fall
             * back to the status page instead of freezing on the last frame. */
            if (!linkHealthy()) {
                if (!linkLostAt) linkLostAt = Date.now();
            } else {
                linkLostAt = 0;
            }
            const disconnected = linkLostAt > 0 && Date.now() - linkLostAt >= GRACE_MS;
            ready = vidSeq > 0 && !!ctx.video() && !disconnected;
            if (ready !== showing || (showing && lagShown !== lagLine)) {
                showing = ready;
                lagShown = lagLine;
                return render();
            }
            /* While waiting, this page follows the reports - the kit does not
             * send the same frame twice, so redrawing costs nothing. With a
             * picture there is nothing to do: the renderer has the video. */
            return showing ? undefined : render();
        });

        /* Keep the source alive for the app's lifetime; shutdown is handled by
         * mgu.run (MainApp asks us to exit), so stop our timers then. */
        process.on('exit', () => {
            clearInterval(ctlTimer);
            if (gesture) clearTimeout(gesture.moveTimer);
            if (ctl) { try { ctl.destroy(); } catch (e) { /* closed */ } }
        });
    }
});
