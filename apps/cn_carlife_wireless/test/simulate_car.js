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

let wifiRendered = 0;
let lastWifiPage = null;
class MockWifiPage {
    constructor(ctx, settings, onBack) { this.settings = settings; this.onBack = onBack; lastWifiPage = this; }
    refresh() {}
    connect(ssid, psk) { return Promise.resolve({ ok: true }); }
    render() { wifiRendered++; }
    touch() { return true; }
}

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
        if (request === './kit/mgu') return mockMgu;
        if (request === './kit/record') return mockRecord;
        if (request === './wifi_page') return { WifiPage: MockWifiPage };
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

const ctx = {
    ui: { image() { return 'MAIN_GFX'; } },
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

    /* B4: tap on the button (still no real picture) opens the Wi-Fi page. */
    wifiRendered = 0;
    const BTN = { x: (1600 - 440) / 2, y: (720 - 110) / 2 };
    const ret = touchHandler(1, BTN.x + 220, BTN.y + 55);        /* button centre */
    render();
    check('B4 tap on button opens Wi-Fi page', ret === true && wifiRendered >= 1);

    /* back to the main page so the picture test below sees the frame path. */
    lastWifiPage.onBack();

    /* B5: real frame -> picture shown, button gone. */
    lastSource.emit('frame', Buffer.alloc(ATLAS, 128), 1, true);
    c = render();
    check('B5 real frame shows the picture', c.image >= 1 && c.roundRect === 0);

    /* B6: with a picture, a tap routes to the phone path (ctl is absent here,
     * so it just must not crash and must keep the gesture). */
    const withPicture = touchHandler(1, 800, 360) === true;
    check('B6 tap with picture routes without crashing', withPicture);

    console.log(failed === 0 ? '\nALL PASS' : '\n' + failed + ' FAILED');
    process.exit(failed === 0 ? 0 : 1);
})();
