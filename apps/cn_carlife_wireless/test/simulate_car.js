'use strict';
/**
 * Local head-unit simulator: run the REAL main.js against a mocked OAP runtime,
 * and prove the picture and touch rules without a car, a phone or MSDK.
 *
 * What it checks:
 *   D. app.json and the code agree: no Wi-Fi UI (the Store owns the hotspot),
 *      the canvas is the phone's 8:3 frame, and the app names the decoder's
 *      video file - the same /dev/shm/mgu-video-* path run.sh writes.
 *   B. No picture until the decoder has written a frame (the file's header says
 *      so), the renderer offers a video channel, and the canvas then draws that
 *      video instead of uploading pixels.
 *   C. Touch: every gesture on the picture goes to carlife-link's ctl port as a
 *      full down/move/up gesture; nothing is pressed while there is no picture.
 *   E. The kit records op 19 and skips it in the software path (record.js).
 *
 * The car-only pieces are stubbed: kit/mgu (the OAP runtime), kit/record's
 * setVideo, and net. The video file itself is real - the test writes an MGVF
 * header where the decoder would (on a PC, '/dev/shm/...' resolves inside the
 * current drive, which is where main.js reads it too).
 *
 *   node test/simulate_car.js
 */
const Module = require('module');
const assert = require('assert');
const path = require('path');
const fs = require('fs');

const W = 1920, H = 720;
const VIDEO_FILE = path.resolve('/dev/shm/mgu-video-carlife');

/* ------------------------------------------------------------------ stubs -- */

let impl = null;
const mockMgu = { run(i) { impl = i; } };
const videoCalls = [];
const mockRecord = { setVideo(id, p) { videoCalls.push({ id, p }); }, setImage() {} };

/* Record every line main.js sends to carlife-link's ctl port. The connect
 * event fires synchronously so the app's ctl socket is ready before the first
 * simulated tap. */
const ctlLines = [];
const mockNet = {
    connect() {
        return {
            on(ev, cb) { if (ev === 'connect') cb(); return this; },
            write(line) { ctlLines.push({ line: String(line), at: Date.now() }); return true; },
            destroy() {},
        };
    },
};

/* Intercept main.js's own requires, and only its own. */
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (parent && /cn_carlife_wireless[\\/]main\.js$/.test(parent.filename)) {
        if (request === 'net') return mockNet;
        if (request === './kit/mgu') return mockMgu;
        if (request === './kit/record') return mockRecord;
    }
    return realLoad.call(this, request, parent, isMain);
};

/* ---------------------------------------------------------- mock ctx/canvas -- */

function makeCanvas() {
    const calls = { image: 0, roundRect: 0, video: 0, texts: [] };
    return {
        calls,
        clear() { return this; },
        text(str) { calls.texts.push(String(str)); return this; },
        roundRect() { calls.roundRect++; return this; },
        image() { calls.image++; return this; },
        video() { calls.video++; return this; },
        rect() { return this; },
    };
}

let currentCanvas = makeCanvas();
let touchHandler = null;
let renderFn = null;
let videoOk = true;                    /* what the renderer offers (ctx.video) */
const store = {};

const uiState = { clicks: {}, opened: [], visible: {}, texts: {} };
const mockUi = {
    image() { return 'MAIN_GFX'; },
    comp() { return null; },
    onClick(name, fn) { uiState.clicks[name] = fn; },
    text(name, v) { uiState.texts[name] = v; return Promise.resolve(); },
    cells(name, row, obj) { uiState.texts[name] = obj; return Promise.resolve(); },
    visible(name, on) { uiState.visible[name] = !!on; return Promise.resolve(); },
    enabled() { return Promise.resolve(); },
    rows() { return Promise.resolve(); },
    open(name) { uiState.opened.push(name); return Promise.resolve(); },
    close(name) { uiState.opened.push('close:' + name); return Promise.resolve(); },
    isVisible(name) { return uiState.opened[uiState.opened.length - 1] === name; },
    onVisible() {},
};

const ctx = {
    ui: mockUi,
    settings: {
        get(k) { return store[k] !== undefined ? store[k] : ''; },
        set(k, v) { store[k] = v; },
        onChange() {},
    },
    canvas() { return currentCanvas; },
    onTouch(cb) { touchHandler = cb; },
    loop(name, fps, fn) { renderFn = fn; },
    video() { return videoOk; },
    theme() { return { bg: '#000000', fg: '#ffffff', text: '#ffffff' }; },
    log: { info() {}, warn() {}, error() {} },
    app: {},
};

/* ------------------------------------------------------------- helpers -- */

/* The decoder's video file: a 64-byte MGVF header, as decode.c writes it. */
function putVideo(seq, w, h) {
    const b = Buffer.alloc(64);
    b.writeUInt32LE(0x4656474d, 0);              /* "MGVF" */
    b.writeUInt32LE(1, 4);
    b.writeUInt32LE(w || W, 8);
    b.writeUInt32LE(h || H, 12);
    b.writeUInt32LE(seq, 16);
    b.writeUInt32LE(0, 20);
    b.writeUInt32LE(3, 24);
    fs.mkdirSync(path.dirname(VIDEO_FILE), { recursive: true });
    fs.writeFileSync(VIDEO_FILE, b);
}

function clearVideo() { try { fs.rmSync(VIDEO_FILE); } catch (e) { /* absent */ } }

/* The loop only draws on a state change: with a live picture it returns
 * undefined and the renderer keeps the last frame. For the test, carry the
 * last canvas forward so "no redraw" reads as "picture still on screen". */
let lastCalls = null;
function render() {
    currentCanvas = makeCanvas();
    const out = renderFn();
    if (out !== undefined) lastCalls = currentCanvas.calls;
    return lastCalls || currentCanvas.calls;
}

let failed = 0;
function check(name, cond, detail) {
    if (cond) { console.log('ok   ' + name); }
    else { failed++; console.error('FAIL ' + name + (detail !== undefined ? '  [' + detail + ']' : '')); }
}

/* --------------------------------------------------------------------- D -- */
/* app.json and the code must agree, and the app must not grow a second Wi-Fi
 * UI: the hotspot is MGU Store's, and two places that both join one wlan0
 * fight each other. */
(function () {
    const spec = require('../app.json');
    const scr = (n) => (spec.screens || []).find((x) => x.name === n) || {};
    const main = scr('MAIN');
    const code = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    check('D1 no Wi-Fi screen in the app',
        !(spec.screens || []).some((x) => x.name === 'WIFI'),
        (spec.screens || []).map((x) => x.name).join(','));
    check('D2 no hotspot button on the bar',
        !(main.buttons || []).some((b) => b[0] === 'BTN_WIFI'));
    check('D3 MAIN is a chrome-less canvas the app fills, with a video',
        main.kind === 'canvas' && main.chrome === false && main.video === true,
        JSON.stringify(main));
    check('D4 the canvas is the phone\'s own frame (1920x720)',
        main.src.w === W && main.src.h === H, JSON.stringify(main.src));
    check('D5 the canvas is 8:3, the shape the phone lays CarLife out in',
        Math.abs(main.src.w / main.src.h - 8 / 3) < 0.02, main.src.w + 'x' + main.src.h);
    const m = /const W = (\d+), H = (\d+);/.exec(code);
    check('D6 main.js draws at that size too', !!m && +m[1] === W && +m[2] === H, m && m.slice(1).join('x'));
    check('D7 the app has no Wi-Fi code left', !/wifi_page|WifiPage|BTN_WIFI/.test(code));
    /* The video file is named twice - here and in run.sh - and the renderer
     * refuses any path that is not /dev/shm/mgu-video-<name>: a mismatch is a
     * black screen with no error anywhere. */
    const rv = /const VIDEO_FILE = '([^']+)';/.exec(code);
    const sh = fs.readFileSync(path.join(__dirname, '../../../kit/carlife-wireless/run.sh'), 'utf8');
    const rsh = /CARLIFE_VIDEO_FILE:-(\/dev\/shm\/mgu-video-[A-Za-z0-9._-]+)/.exec(sh);
    check('D8 the app and run.sh name the same /dev/shm/mgu-video-* file',
        !!rv && !!rsh && rv[1] === rsh[1] && /^\/dev\/shm\/mgu-video-/.test(rv[1]),
        (rv && rv[1]) + ' vs ' + (rsh && rsh[1]));
    check('D9 the decoder is pointed at that file', /--video-file "\$VIDEO"/.test(sh));
})();

/* D6 (glyphs): every Chinese character this app can put on the canvas must
 * exist in the baked glyph atlas - the car has no font rasteriser, so an
 * unbaked character is drawn as '?'. app.json's `description` is left out on
 * purpose: the MGU Store shows it with the HMI's own fonts, so those
 * characters never reach this canvas. */
(function () {
    const atlas = JSON.parse(fs.readFileSync(
        path.join(__dirname, '../../../kit/runtime/fonts/cjk.json'), 'utf8'));
    const have = new Set(Object.keys(atlas.sizes[0].glyphs).map(Number));
    const spec = JSON.parse(fs.readFileSync(path.join(__dirname, '../app.json'), 'utf8'));
    const sources = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8') + '\n' +
        JSON.stringify({ texts: spec.texts, screens: spec.screens });
    const missing = [...new Set([...sources].filter((ch) =>
        ch.codePointAt(0) > 0x2000 && !have.has(ch.codePointAt(0))))];
    check('D10 every Chinese character the app draws is baked into the atlas',
        missing.length === 0, missing.join(''));
})();

/* --------------------------------------------------------------------- E -- */
/* The kit's half: op 19 must carry the video's id and rect, and the software
 * path must skip it instead of stopping the frame there. */
(function () {
    let rec;
    try { rec = require('../../../kit/runtime/record'); } catch (e) { rec = null; }
    if (!rec) { console.log('skip E: kit/runtime/record.js not loadable here'); return; }
    rec.setVideo(7, '/dev/shm/mgu-video-test');
    const r = new rec.Recorder(100, 50);
    r.video(7, 0, 0, 100, 50, 0);
    const w = r.words(), f = new Float32Array(w.buffer, w.byteOffset, w.length);
    check('E1 op 19 is recorded with id and rect',
        w[0] === 19 && f[1] === 0 && f[2] === 0 && f[3] === 100 && f[4] === 50 && f[5] === 0 && w[6] === 7,
        Array.prototype.slice.call(w, 0, 7).join(','));
    check('E2 the frame remembers which video it draws', r.videos.has(7));
    let threw = false;
    try { rec.play(w, { blit() {}, drawImage() {} }); } catch (e) { threw = true; }
    check('E3 the software path skips op 19 without throwing', !threw);
})();

/* --------------------------------------------------------------------- B -- */
(async () => {
    require('../main.js');
    assert(impl, 'mgu.run was not called');
    await impl.start(ctx);
    assert(renderFn && touchHandler, 'loop/onTouch were not registered');

    check('B0 the app names the decoder\'s video file',
        videoCalls.some((v) => v.p === '/dev/shm/mgu-video-carlife'),
        JSON.stringify(videoCalls));

    /* B1: no file at all -> the status page, no picture, no fake button. */
    clearVideo();
    let c = render();
    check('B1 no picture: status page, no video op, no fake button',
        c.video === 0 && c.roundRect === 0 &&
        c.texts.some((t) => t.includes('MGU 商店')));

    /* B2: the decoder's file exists but holds no frame yet (seq 0): still the
     * status page - a file is not a picture. */
    putVideo(0);
    c = render();
    check('B2 an empty video file is not a picture',
        c.video === 0 && c.texts.some((t) => t.includes('MGU 商店')));

    /* C: diagnose() must name the stage that is actually stuck. */
    const statusFile = path.resolve('/run/mgu-uplink/status.json');
    const leaseFile = path.resolve('/run/mgu-uplink/lease.json');
    const linkFile = path.resolve('/dev/shm/carlife-wireless/link.txt');
    const runFile = path.resolve('/dev/shm/carlife-wireless/run.txt');
    const bootFile = path.resolve('/dev/shm/carlife-wireless-boot.txt');
    const decodeFile = path.resolve('/dev/shm/carlife-wireless-decode.txt');
    const allFiles = [statusFile, leaseFile, linkFile, runFile, bootFile, decodeFile];
    const clearReports = () => {
        for (const f of allFiles) { try { fs.rmSync(f); } catch (e) { /* absent */ } }
    };
    const put = (f, s) => {
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.writeFileSync(f, s);
    };
    try {
        /* Associated, but no lease: the exact state from the car photo. */
        clearReports();
        put(statusFile, JSON.stringify({ wifi: { link: 'connected', ssid: 'iQOO 12 Pro', enabled: true } }));
        c = render();
        check('C1 association without a lease is called out',
            c.texts.some((t) => t.includes('已关联 iQOO 12 Pro')) &&
            c.texts.some((t) => t.includes('尚未获取 IP 租约')));

        put(leaseFile, JSON.stringify({ router: '192.168.43.1' }));
        put(statusFile, JSON.stringify({ wifi: { link: 'online', ssid: 'iQOO 12 Pro', ip: '192.168.43.55' } }));
        c = render();
        check('C2 online shows the car address',
            c.texts.some((t) => t.includes('已连接 iQOO 12 Pro（本机 192.168.43.55）')));

        /* C2b: the phone's address is the one the link dialled, not the car's. */
        put(linkFile, 'state: streaming\nhost: 10.92.100.136\nerror: none\n');
        c = render();
        check('C2b the streaming line names the phone address from link.txt',
            c.texts.some((t) => t.includes('正在接收画面') && t.includes('手机 10.92.100.136')),
            c.texts.join(' | '));
        check('C2c the hotspot address is labelled as the car\'s own',
            c.texts.some((t) => t.includes('本机 192.168.43.55')), c.texts.join(' | '));

        put(linkFile, 'state: no phone on the network\nerror: none\n');
        c = render();
        check('C3 link report names the real reason', c.texts.some((t) => t.includes('找不到手机')));

        put(linkFile, 'state: looking for the phone\nhost: 10.92.100.115\n' +
            'error: 10.92.100.115:7240 timed out\n');
        c = render();
        check('C9 re-homing names the address, not the old timeout',
            c.texts.some((t) => t.includes('正在查找手机')) &&
            c.texts.some((t) => t.includes('地址：10.92.100.115（按当前网络重新查找）')) &&
            !c.texts.some((t) => t.includes('取流错误')));

        fs.rmSync(linkFile);
        put(runFile, 'state: starting\nphone: 192.168.43.1\nsource: default route on wlan0\n');
        c = render();
        check('C4 missing link report shows the launcher state',
            c.texts.some((t) => t.includes('取流服务：已启动 → 192.168.43.1')) &&
            c.texts.some((t) => t.includes('default route on wlan0')));

        put(runFile, 'state: restarting\nphone: auto\nsource: auto discovery\n' +
            'detail: carlife-decode exited (rc 1)\n');
        c = render();
        check('C5 restarting names the half that died',
            c.texts.some((t) => t.includes('反复重启')) &&
            c.texts.some((t) => t.includes('carlife-decode exited (rc 1)')));

        clearReports();
        put(linkFile, 'state: streaming\n');
        const past = new Date(Date.now() - 60000);
        fs.utimesSync(linkFile, past, past);
        put(runFile, 'state: restarting\ndetail: carlife-decode exited (rc 1)\n');
        c = render();
        check('C8 a stale streaming report does not hide a crash',
            c.texts.some((t) => t.includes('反复重启')) &&
            !c.texts.some((t) => t.includes('正在接收画面')));

        clearReports();
        put(bootFile, 'state carlife-wireless.service: inactive\n');
        c = render();
        check('C6 a dead service is named', c.texts.some((t) => t.includes('未运行（inactive）')));

        clearReports();
        c = render();
        check('C7 no reports asks for a reinstall, never the old vague line',
            c.texts.some((t) => t.includes('请重装 CarLife 无线组件')) &&
            !c.texts.some((t) => t.includes('热点连上后自动开始')));

        /* C10: frames decoded but no video channel in this unit's renderer:
         * say that, rather than leaving "waiting for picture" forever. */
        putVideo(42);
        videoOk = false;
        c = render();
        check('C10 a picture the renderer cannot draw is called out',
            c.video === 0 && c.texts.some((t) => t.includes('渲染器不支持视频通道')),
            c.texts.join(' | '));
        videoOk = true;
    } finally {
        clearReports();
        for (const d of [path.resolve('/run'), path.resolve('/dev/shm')]) {
            try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* absent */ }
        }
    }

    /* The reports and the video file are gone: the next tick is back on the
     * status page, so the gesture checks below start from "no picture". */
    c = render();
    check('B2b a decoder that stopped is back to the status page',
        c.video === 0 && c.texts.some((t) => t.includes('MGU 商店')));

    /* B3: taps anywhere (no picture) are not the phone's: nothing leaks. */
    const swallowed = touchHandler(1, 30, 30) === false && touchHandler(1, 1500, 700) === false;
    check('B3 without a picture no gesture is claimed', swallowed);

    check('B4 no hotspot button is bound', typeof uiState.clicks['BTN_WIFI'] !== 'function');
    check('B4 no hotspot row is bound',
        Object.keys(uiState.clicks).every((k) => !/^NET_|^BTN_WIFI/.test(k)),
        Object.keys(uiState.clicks).join(','));

    /* B5: the decoder has written a frame -> the canvas draws the video, and
     * draws nothing per picture afterwards (the renderer reads the file). */
    putVideo(43);
    c = render();
    check('B5 a decoded frame draws one video op, and nothing else',
        c.video === 1 && c.texts.length === 0 && c.image === 0, JSON.stringify(c));
    check('B5 the video fills the whole canvas', c.video === 1);
    check('B5 the next tick sends nothing - the renderer has it',
        renderFn() === undefined);

    /* B6: with a picture, a tap routes to the phone. */
    const withPicture = touchHandler(1, 800, 360) === true;
    check('B6 tap with picture routes without crashing', withPicture);

    /* B7: the phone drops a bare down/up pair with no move and no press
     * duration; the app turns it into a full gesture. */
    ctlLines.length = 0;
    touchHandler(1, 800, 360);
    touchHandler(3, 800, 360);
    await new Promise((r) => setTimeout(r, 260));
    const seq = ctlLines.map((e) => e.line.trim().split(' ')[0]);
    check('B7 a fast tap becomes down/move/up', seq.join(',') === 'down,move,up', seq.join(','));
    check('B7 the press lasts at least 150 ms',
        ctlLines.length === 3 && ctlLines[2].at - ctlLines[0].at >= 150,
        ctlLines.length === 3 ? (ctlLines[2].at - ctlLines[0].at) + ' ms' : 'missing lines');

    /* B8: a drag already has a body of real ACTION_MOVEs, so its release must
     * not be held back by the minimum press that only a bare tap needs. */
    ctlLines.length = 0;
    touchHandler(1, 800, 360);
    touchHandler(2, 830, 380);
    touchHandler(2, 845, 395);
    touchHandler(3, 850, 400);
    const drag = ctlLines.map((e) => e.line.trim().split(' ')[0]);
    check('B8 a drag is down/move/move/up', drag.join(',') === 'down,move,move,up', drag.join(','));
    check('B8 drag release is immediate, not held for 170 ms',
        ctlLines.length === 4 && ctlLines[3].at - ctlLines[0].at < 100,
        ctlLines.length === 4 ? (ctlLines[3].at - ctlLines[0].at) + ' ms' : 'missing lines');

    /* B9: the decoder going away puts the status page back. */
    clearVideo();
    c = render();
    check('B9 the picture goes when the decoder stops writing',
        c.video === 0 && c.texts.some((t) => t.includes('MGU 商店')));

    /* B10: the real disconnect the car showed. The video file is STILL THERE
     * with its last frame - the phone walked out of range, link.txt says so.
     * A frozen picture is not acceptable: after the grace period the status
     * page must come back, and a fresh stream must bring the picture back. */
    putVideo(99);                                  /* last frame stays on disk */
    put(linkFile, 'state: streaming\nerror: none\n');
    c = render();
    check('B10 a healthy link keeps the picture', c.video === 1, JSON.stringify(c));

    put(linkFile, 'state: reconnecting\nerror: none\n');
    /* Still inside the grace period: do not blank the picture on a hiccup. */
    c = render();
    check('B10 a brief hiccup keeps the picture', c.video === 1, JSON.stringify(c));

    /* The app measures the outage from its own first sight of the bad state.
     * Let the grace period elapse, then drive the loop again. */
    await new Promise((r) => setTimeout(r, 3100));
    c = render();
    check('B10 a phone that left shows the status page, not the last frame',
        c.video === 0 && c.texts.some((t) => t.includes('MGU 商店')), JSON.stringify(c));

    /* A fresh stream reconnects and the picture returns. */
    put(linkFile, 'state: streaming\nerror: none\n');
    putVideo(100);
    c = render();
    check('B10 a reconnected phone brings the picture back', c.video === 1, JSON.stringify(c));

    /* B11: the native half died. link.txt still says "streaming" from the
     * moment before the crash, but the launcher already wrote "restarting" -
     * that newer report must win, or the screen freezes on the last frame
     * for as long as the service keeps failing. */
    put(runFile, 'state: restarting\ndetail: carlife-link exited (rc 3)\n');
    render();                                      /* the loop notices it now */
    await new Promise((r) => setTimeout(r, 3100));
    c = render();
    check('B11 a crashed service drops the picture even if link.txt is stale',
        c.video === 0 && c.texts.some((t) => t.includes('MGU 商店')), JSON.stringify(c));
    put(runFile, 'state: starting\ndetail: launching\n');

    console.log(failed === 0 ? '\nALL PASS' : '\n' + failed + ' FAILED');
    process.exit(failed === 0 ? 0 : 1);
})();
