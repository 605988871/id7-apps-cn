'use strict';
/**
 * Local head-unit simulator: run the REAL main.js + carlife_source.js against
 * a mocked OAP runtime, and prove the 0.5.0 fixes without a car or MSDK.
 *
 * What it checks:
 *   A. CarlifeSource tags real frames `real=true` and its "CARLIFE LIVE"
 *      placeholder `real=false`.
 *   B. main.js ignores the placeholder (the connect button stays up) and only
 *      shows the picture once a real frame arrives.
 *   C. Touch routing: no picture -> a tap on the button opens the Wi-Fi page;
 *      every other tap is swallowed, nothing leaks.
 *
 * The car-only pieces are stubbed: kit/mgu (the OAP runtime), kit/record
 * (setImage), wifi_page (which needs the HMI speller), and the unix socket the
 * decoder writes (Windows has no AF_UNIX). Everything under test is the real
 * shipping code.
 *
 *   node test/simulate_car.js
 */
const Module = require('module');
const assert = require('assert');

const W = 1280, H = 720;
const ATLAS = W * (H + H / 2);              /* 1382400 bytes, the decoder's frame */
const MAGIC = 0x464d4c43;

/* ------------------------------------------------------------------ stubs -- */

let impl = null;
const mockMgu = { run(i) { impl = i; } };
const mockRecord = { setImage() {} };

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

/* The real Wi-Fi page: its bind() is what makes the HMI rows pressable, and
 * that is the half of the app this file now has to prove. It only touches the
 * unix socket on a click, so loading it here is safe. */


/* The real source, minus the unix socket it listens on. */
const RealCarlifeSource = require('../carlife_source').CarlifeSource;
let lastSource = null;
class ControllableCarlifeSource extends RealCarlifeSource {
    constructor(opts) { super(opts); lastSource = this; }
    _start() { this.running = true; this.emit('status', 'simulated listener'); }
    _stop() { this.running = false; }
}

/* Intercept main.js's own requires, and only its own. */
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (parent && /cn_carlife_wireless[\\/]main\.js$/.test(parent.filename)) {
        if (request === 'net') return mockNet;
        if (request === './kit/mgu') return mockMgu;
        if (request === './kit/record') return mockRecord;
        if (request === './carlife_source') return { CarlifeSource: ControllableCarlifeSource };
    }
    return realLoad.call(this, request, parent, isMain);
};

/* ---------------------------------------------------------- mock ctx/canvas -- */

function makeCanvas() {
    const calls = { image: 0, roundRect: 0, texts: [] };
    return {
        calls,
        clear() { return this; },
        text(str) { calls.texts.push(String(str)); return this; },
        roundRect() { calls.roundRect++; return this; },
        image() { calls.image++; return this; },
        rect() { return this; },
    };
}

let currentCanvas = makeCanvas();
let touchHandler = null;
let renderFn = null;
const store = {};

/* The HMI side: only components can be pressed on the car (pixel images give
 * up touch claims), so these handlers are the app's only way in. */
const uiState = { clicks: {}, opened: [], visible: {}, texts: {} };
const mockUi = {
    image() { return 'MAIN_GFX'; },
    comp() { return null; },                 /* the mock HMI has no components */
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
        onChange(cb) { /* publishHost only; no-op here */ },
    },
    canvas() { return currentCanvas; },
    onTouch(cb) { touchHandler = cb; },
    loop(name, fps, fn) { renderFn = fn; },
    theme() { return { bg: '#000000', fg: '#ffffff', text: '#ffffff' }; },
    log: { info() {}, warn() {}, error() {} },
    app: {},
};

/* ------------------------------------------------------------- helpers -- */

function clmfPacket() {
    const atlas = Buffer.alloc(ATLAS, 128);       /* mid-grey, decodes fine */
    const pkt = Buffer.alloc(12 + ATLAS);
    pkt.writeUInt32LE(MAGIC, 0);
    pkt.writeUInt32LE(ATLAS, 4);
    pkt.writeUInt32LE(1, 8);
    atlas.copy(pkt, 12);
    return pkt;
}

function render() {
    currentCanvas = makeCanvas();
    renderFn();
    return currentCanvas.calls;
}

let failed = 0;
function check(name, cond) {
    if (cond) { console.log('ok   ' + name); }
    else { failed++; console.error('FAIL ' + name); }
}

/* --------------------------------------------------------------------- D -- */
/* The menu app.json declares and the rows this app fills must be one set. A
 * mistyped component name cannot be seen on the car: ui.comp() returns null,
 * ui.onClick() binds to nothing, and the row simply never answers. */
(function () {
    const spec = require('../app.json');
    const { MAX_ROWS } = require('../wifi_page');
    const scr = (n) => (spec.screens || []).find((s) => s.name === n) || {};
    const wifi = scr('WIFI');
    const names = (wifi.items || []).map((it) => it[1]);
    check('D1 the Wi-Fi page is an HMI menu state', wifi.kind === 'menu');
    check('D2 the main screen has the bar button',
        (scr('MAIN').buttons || []).some((b) => b[0] === 'BTN_WIFI'));
    ['BTN_WIFI_TOGGLE', 'BTN_WIFI_SCAN', 'BTN_WIFI_PSK', 'BTN_WIFI_BACK', 'WIFI_STATUS', 'WIFI_NOTE']
        .forEach((n) => check('D3 the menu declares ' + n, names.indexOf(n) >= 0));
    const nets = names.filter((n) => /^NET_\d+$/.test(n));
    check('D4 one menu row per MAX_ROWS (' + MAX_ROWS + ')', nets.length === MAX_ROWS,
        nets.length + ' rows declared');
    check('D5 the rows are in order', nets.join(',') ===
        Array.from({ length: MAX_ROWS }, (_, i) => 'NET_' + (i + 1)).join(','));
})();

/* --------------------------------------------------------------------- A -- */
/* The source itself must tag placeholder vs real frames. */
(function () {
    const src = new RealCarlifeSource({ w: W, h: H, fps: 30, sockPath: '/tmp/x.sock' });
    src.running = true;
    let realFlag = null, placeholderFlag = null;
    src.on('frame', (buf, seq, real) => {
        if (real === false) placeholderFlag = real;
        else if (real === true) realFlag = real;
    });

    /* placeholder: _activity draws it after the 600 ms gate (waitTick % 3). */
    src.waitTick = 2;
    src._activity();
    check('A1 placeholder frame is tagged real=false', placeholderFlag === false);

    /* real: a valid CLMF frame through the parser. */
    src.format = 'clmf';
    src._feed(clmfPacket());
    check('A2 real frame is tagged real=true', realFlag === true);
    src.stop();
})();

/* --------------------------------------------------------------------- B -- */
/* main.js must ignore the placeholder and show only real frames. */
(async () => {
    require('../main.js');
    assert(impl, 'mgu.run was not called');
    await impl.start(ctx);
    assert(renderFn && touchHandler, 'loop/onTouch were not registered');

    /* B1: no frames yet -> button, no picture. */
    let c = render();
    check('B1 no frame: button shown, no picture',
        c.image === 0 && c.roundRect >= 1 &&
        c.texts.some((t) => t.includes('连接热点') || t.includes('连接中')));

    /* B2: placeholder frame -> button STILL shown (the 0.5.0 fix). */
    lastSource.emit('frame', Buffer.alloc(ATLAS, 128), 0, false);
    c = render();
    check('B2 placeholder frame ignored, button stays',
        c.image === 0 && c.roundRect >= 1);

    /* C: diagnose() must name the stage that is actually stuck. 0.6.0 added
     * the launcher (run.txt) and install (boot.txt) reports, and distinguishes
     * an associated Wi-Fi from one that really has a DHCP lease. */
    const path = require('path');
    const fs = require('fs');
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
            c.texts.some((t) => t.includes('已连接 iQOO 12 Pro · 192.168.43.55')));

        put(linkFile, 'state: no phone on the network\nerror: none\n');
        c = render();
        check('C3 link report names the real reason', c.texts.some((t) => t.includes('找不到手机')));

        /* Right after a hotspot change the link still holds the address it
         * dialled a moment ago, and its dial error names exactly that address.
         * Printed beside "正在查找手机" the error reads as "the IP never
         * switched" - which is how the car reported it. Name the address and
         * what the link is doing with it instead. */
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

        /* A stale "streaming" from the previous session must not hide a fresh
         * restart: compare the reports' mtimes, not just their existence. */
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
    } finally {
        clearReports();
        for (const d of [path.resolve('/run'), path.resolve('/dev/shm')]) {
            try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* absent */ }
        }
    }

    /* B3: taps anywhere else (no picture) are swallowed, nothing leaks. */
    const swallowed = touchHandler(1, 30, 30) === true && touchHandler(1, 1500, 700) === true;
    check('B3 other taps swallowed, nothing leaks', swallowed);

    /* B4: the HMI bar's own "连接热点" opens the WIFI menu state.
     *
     * A drawn button could never do this on the car: the picture needs pixel
     * images, and a connection that sends them cannot claim touches (CLAIM
     * shares IMAGE's message number), so every tap goes to the HMI. The app
     * used to draw a big blue button that no finger could ever press - which is
     * exactly what "点了没反应" looked like. The bar button is an HMI component
     * and does get its click (cn_doom plays on a screen of this kind). */
    uiState.opened.length = 0;
    const wifiClick = uiState.clicks['BTN_WIFI'];
    check('B4 BTN_WIFI is bound as an HMI button', typeof wifiClick === 'function');
    if (wifiClick) wifiClick();
    check('B4 it opens the WIFI menu state', uiState.opened.indexOf('WIFI') >= 0,
        uiState.opened.join(','));
    const wfi = uiState.clicks['NET_1'];
    check('B4 the menu rows are bound too (NET_1)', typeof wfi === 'function' &&
        typeof uiState.clicks['NET_8'] === 'function' &&
        typeof uiState.clicks['BTN_WIFI_SCAN'] === 'function');
    check('B4 the menu was painted (status line filled)',
        typeof uiState.texts['WIFI_STATUS'] === 'string');
    /* No scan result yet: the eight row slots must not show as empty buttons. */
    check('B4 unused network rows are hidden', uiState.visible['NET_1'] === false);

    /* B5: real frame -> picture shown, button gone. */
    lastSource.emit('frame', Buffer.alloc(ATLAS, 128), 1, true);
    c = render();
    check('B5 real frame shows the picture', c.image >= 1 && c.roundRect === 0);

    /* B6: with a picture, a tap routes to the phone path. */
    const withPicture = touchHandler(1, 800, 360) === true;
    check('B6 tap with picture routes without crashing', withPicture);

    /* B7: the phone drops a bare down/up pair with no move and no press
     * duration. A quick tap on the HMI can deliver phase 1 and phase 3 in
     * the same frame - prove the app turns it into a full gesture. */
    ctlLines.length = 0;
    touchHandler(1, 800, 360);
    touchHandler(3, 800, 360);
    await new Promise((r) => setTimeout(r, 260));
    const seq = ctlLines.map((e) => e.line.trim().split(' ')[0]);
    check('B7 a fast tap becomes down/move/up', seq.join(',') === 'down,move,up', seq.join(','));
    check('B7 the press lasts at least 150 ms',
        ctlLines.length === 3 && ctlLines[2].at - ctlLines[0].at >= 150,
        ctlLines.length === 3 ? (ctlLines[2].at - ctlLines[0].at) + ' ms' : 'missing lines');

    /* B8: a drag already has a body of real ACTION_MOVEs, so its release
     * must not be held back by the minimum press that only a bare tap needs.
     * This is what makes dragging feel rubbery if it regresses. */
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

    console.log(failed === 0 ? '\nALL PASS' : '\n' + failed + ' FAILED');
    process.exit(failed === 0 ? 0 : 1);
})();
