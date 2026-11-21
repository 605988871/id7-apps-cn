'use strict';
/**
 * Turn View, driven end to end with the car replaced by stubs:
 *
 *   node kit/tools/test_turn_view.js
 *
 * apps/cn_turn_view/main.js is loaded unchanged; only the renderer, the camera
 * request module, the picture source, the turn-signal subscription and the
 * iDrive canvas are replaced. What this checks is the sequence a unit test of
 * one piece cannot: a turn signal asks the camera for that side, puts the layer
 * on the glass before the picture exists, a picture reaches the map layer at
 * exactly its size, the other side switches the view without a second layer,
 * and the layer goes away (and the camera is given back) when the indicator
 * does - after the hold time the setting asks for, or at once at zero.
 *
 * The clock is the test's own, so the hold is checked without waiting for it.
 */
const assert = require('assert');
const fs = require('fs');
const Module = require('module');
const path = require('path');
const EventEmitter = require('events');

const ROOT = path.join(__dirname, '..', '..');
const APP = path.join(ROOT, 'apps', 'cn_turn_view');
const MAIN = path.join(APP, 'main.js');
const spec = JSON.parse(fs.readFileSync(path.join(APP, 'app.json'), 'utf8'));
const defaults = {};
spec.settings.forEach((s) => { defaults[s.key] = s.default; });

const { MAP_W, MAP_H, atlasSize } = require(path.join(APP, 'atlas'));

/* The clock: main.js reads Date.now() for the hold and for frame pacing. */
let clock = 1700000000000;
Date.now = () => clock;

class FakeCR {
    constructor() {
        this.ready = false;
        this.backend = 'fake';
        this.targets = 'map';
        this.handlers = {};
        this.refs = 0;
        this.calls = 0;
        this.refuseNext = false;
        this.videos = [];
        this.sets = [];
        this.frames = [];
        this.drops = [];
        global.cr = this;
    }
    on(ev, fn) { (this.handlers[ev] = this.handlers[ev] || []).push(fn); return this; }
    emit(ev) { const a = Array.prototype.slice.call(arguments, 1); (this.handlers[ev] || []).forEach((f) => f.apply(null, a)); }
    video(o) {
        this.calls++;
        /* The map slot is contended for: the service refuses a layer now and
         * then (measured about a third of first attempts on this car). */
        if (this.refuseNext) { this.refuseNext = false; return 0; }
        this.videos.push(o);
        return ++this.refs;
    }
    image(o) { this.videos.push(o); return ++this.refs; }
    set(ref, o) { this.sets.push({ ref: ref, visible: o.visible }); }
    drop(ref) { this.drops.push(ref); }
    frame(ref, b, id) { this.frames.push({ ref: ref, id: id, size: b.length }); return true; }
    status() {}
}

class FakeSource extends EventEmitter {
    constructor(o) {
        super();
        this.opts = o;
        this.w = o.w;
        this.h = o.h;
        this.seq = 0;
        global.sources.push(this);
    }
    start() { this.running = true; }
    stop() { this.running = false; }
    send(buf) { this.emit('frame', buf, this.seq++); }
}

class FakeCam extends EventEmitter {
    constructor(o) {
        super();
        this.o = o;
        this.requests = [];
        this.releases = 0;
        this.s = { state: 'idle', text: 'stub', asked: '', cam: '-', icam: '-', xv: '-', ecu: null };
        global.cam = this;
    }
    start() {}
    stop() {}
    request(app, p) { this.requests.push({ application: app, perspective: p }); this.s.asked = app + '/' + p; return Promise.resolve(true); }
    release() { this.releases++; return Promise.resolve(); }
    readState() { return Promise.resolve(null); }
    status() { return this.s; }
}

global.cr = null;
global.sources = [];
global.cam = null;
global.signalHandlers = null;
global.uiTick = null;

const fakeMgu = { run: (o) => { global.startApp = o.start; } };

/* /dev/shm is not this machine's to write: keep what the app writes. */
const written = {};
const realMkdir = fs.mkdirSync;
const realWrite = fs.writeFileSync;
const underShm = (p) => String(p).replace(/\\/g, '/').indexOf('/dev/shm/') >= 0;
fs.mkdirSync = function (p) { if (underShm(p)) return undefined; return realMkdir.apply(this, arguments); };
fs.writeFileSync = function (p, data) {
    if (underShm(p)) { written[String(p).replace(/\\/g, '/')] = String(data); return undefined; }
    return realWrite.apply(this, arguments);
};

/* The app's own 300 ms tick, called by the test so the clock stays virtual. */
const ticks = [];
const realSetInterval = global.setInterval;
global.setInterval = function (fn) { ticks.push(fn); return { unref() {}, _stub: true }; };

const load = Module._load;
Module._load = function (request, parent) {
    if (parent && parent.filename === MAIN) {
        if (request === './kit/mgu') return fakeMgu;
        if (request === './cluster_render_client') return { ClusterRender: FakeCR };
        if (request === './frame_source') {
            return { createSource: (o) => new FakeSource(o), mkdirp: () => {}, atlasSize: atlasSize };
        }
        if (request === './camreq') return { create: (o) => new FakeCam(o) };
    }
    if (request === 'oap-sdk' && parent && parent.filename === MAIN) {
        return { someipBuilders: { buildAndInitTypedProxy: () => Promise.reject(new Error('no car')) } };
    }
    return load.apply(this, arguments);
};
require(MAIN);
Module._load = load;
/* fs stays intercepted for the whole run: the app writes crop.json again on
 * every settings change, and on Windows /dev/shm is not where it says it is. */

const canvas = {
    clear() { return this; }, text() { return this; }, rect() { return this; },
    line() { return this; }, circle() { return this; }
};
const values = Object.assign({}, defaults);
const listeners = [];
const settings = {
    get: (k) => values[k],
    set: (k, v) => { values[k] = v; listeners.slice().forEach((f) => f(k)); },
    all: () => values,
    onChange: (f) => listeners.push(f),
    item: (k) => ({ steps: (spec.settings.find((s) => s.key === k) || {}).steps, default: defaults[k] })
};
const ctx = {
    dataDir: path.join(ROOT, 'dist', 'cn_turn_view'),
    settings: settings,
    ui: { image: () => ({}), comp: () => false, onClick: () => {} },
    canvas: () => canvas,
    theme: () => ({ text: '#fff', accent: '#0f0' }),
    loop: (name, fps, fn) => { global.uiTick = fn; },
    signals: {
        watch: (iface, inst, handlers) => { global.signalHandlers = handlers; global.watched = iface; return Promise.resolve({ available: true }); }
    },
    log: { info: () => {}, warn: () => {}, error: () => {} }
};

const lastSet = () => global.cr.sets[global.cr.sets.length - 1];
const turn = (v) => global.signalHandlers.StatusFunctionsIndicators(v);
const tick = () => ticks.forEach((f) => f());

(async () => {
    await global.startApp(ctx);
    global.setInterval = realSetInterval;
    const cam = global.cam;
    const cr = global.cr;
    assert.ok(cam, 'the app did not create the camera request module');
    assert.ok(cr, 'the app did not create the renderer');
    assert.strictEqual(global.watched, 'de.bmw.body.Light', 'the app does not read the turn signals');
    assert.ok(global.signalHandlers && global.signalHandlers.StatusFunctionsIndicators,
        'the app does not subscribe to StatusFunctionsIndicators');
    assert.ok(global.uiTick, 'the app never registered its page with ctx.loop');
    console.log('ok: loaded, watching the turn signals, page registered');

    /* --- the layer --------------------------------------------------------- */
    cr.ready = true;
    cr.emit('ready');
    assert.strictEqual(cr.videos.length, 1, 'expected one layer, got ' + cr.videos.length);
    const layer = cr.videos[0];
    assert.strictEqual(layer.target, 'map', 'the layer is not on the map target');
    assert.strictEqual(layer.w + 'x' + layer.h, MAP_W + 'x' + MAP_H, 'layer size ' + layer.w + 'x' + layer.h);
    assert.strictEqual(layer.vw + 'x' + layer.vh, MAP_W + 'x' + MAP_H, 'frame size the layer takes');
    assert.strictEqual(layer.visible, 0, 'a new layer should be hidden until a turn');
    assert.strictEqual(layer.dirty_threshold, 2, 'the layer keeps cluster-render\'s 1 s settle');
    assert.strictEqual(layer.settle_ms, 120, 'the layer keeps cluster-render\'s 1 s settle');
    console.log('ok: layer %dx%d on the map target, hidden', MAP_W, MAP_H);

    /* --- no turn, no request ---------------------------------------------- */
    assert.strictEqual(cam.requests.length, 0, 'the app asked for a camera without a turn');
    turn(0);
    assert.strictEqual(cam.requests.length, 0, 'a signal of 0 asked for a camera');
    console.log('ok: nothing asked for until the indicator is on');

    /* --- left ------------------------------------------------------------- */
    turn('DAUERBLINKEN_LINKS');
    assert.strictEqual(cam.requests.length, 1, 'the left indicator did not ask for a view');
    assert.deepStrictEqual(cam.requests[0], { application: 'SIDEVIEW', perspective: defaults.sideLeft },
        'left asked for ' + JSON.stringify(cam.requests[0]));
    assert.strictEqual(lastSet().visible, 1, 'the layer was not shown at once');
    console.log('ok: left -> %s/%d, layer visible before any frame', cam.requests[0].application, cam.requests[0].perspective);

    /* --- a picture -------------------------------------------------------- */
    const src = global.sources[0];
    assert.ok(src, 'the app did not open the picture stream');
    assert.strictEqual(src.opts.sockPath, '/dev/shm/turn-view/live.sock', 'the stream is not from the turn-view folder');
    src.send(Buffer.alloc(atlasSize(MAP_W, MAP_H), 16));
    assert.strictEqual(cr.frames.length, 1, 'the frame did not reach the layer');
    assert.strictEqual(cr.frames[0].size, atlasSize(MAP_W, MAP_H), 'frame size ' + cr.frames[0].size);
    assert.strictEqual(cr.frames[0].ref, 1, 'the frame went to another layer');
    console.log('ok: a frame of %d bytes reached the layer', cr.frames[0].size);

    /* --- the other side, while it is up ----------------------------------- */
    turn('TIPPBLINKEN_RECHTS');
    assert.strictEqual(cam.requests.length, 2, 'the right indicator did not ask for a view');
    assert.deepStrictEqual(cam.requests[1], { application: 'SIDEVIEW', perspective: defaults.sideRight },
        'right asked for ' + JSON.stringify(cam.requests[1]));
    assert.strictEqual(cr.videos.length, 1, 'switching sides made a second layer');
    assert.strictEqual(lastSet().visible, 1, 'switching sides hid the layer');
    console.log('ok: right -> %s/%d on the same layer', cam.requests[1].application, cam.requests[1].perspective);

    /* --- the wire numbers mean the same ---------------------------------- */
    turn(9);
    assert.strictEqual(cam.requests.length, 3, '9 (left) did not ask for a view');
    assert.strictEqual(cam.requests[2].perspective, defaults.sideLeft, '9 is not the left side');
    turn(24);
    assert.strictEqual(cam.requests.length, 4, '24 (hazards) did not ask for a view');
    assert.deepStrictEqual(cam.requests[3], { application: 'DR_ACTIVE', perspective: 7 },
        'hazards asked for ' + JSON.stringify(cam.requests[3]));
    console.log('ok: wire numbers: 9 left, 24 hazards -> the all-camera view');

    /* --- the hold, on the test's clock ----------------------------------- */
    values.holdSec = 2;
    const before = cam.releases;
    turn(0);
    assert.strictEqual(cam.releases, before, 'the camera was given back before the hold was over');
    assert.strictEqual(lastSet().visible, 1, 'the layer went away before the hold was over');
    clock += 1000;
    tick();
    assert.strictEqual(cam.releases, before, 'the hold ended a second early');
    clock += 1200;
    tick();
    assert.strictEqual(cam.releases, before + 1, 'the camera was not given back after the hold');
    assert.strictEqual(lastSet().visible, 0, 'the layer stayed after the hold');
    console.log('ok: hold 2 s: still up at 1 s, given back at 2.2 s');

    /* --- hold 0: gone with the indicator --------------------------------- */
    values.holdSec = 0;
    turn('DAUERBLINKEN_LINKS');
    assert.strictEqual(lastSet().visible, 1, 'the layer did not come back for a new turn');
    const rel = cam.releases;
    turn(0);
    assert.strictEqual(cam.releases, rel + 1, 'hold 0 did not give the camera back at once');
    assert.strictEqual(lastSet().visible, 0, 'hold 0 did not hide the layer at once');
    console.log('ok: hold 0: hidden and released with the indicator');

    /* --- the trigger setting --------------------------------------------- */
    values.holdSec = 0;
    values.trigger = 'left';
    const n = cam.requests.length;
    turn('DAUERBLINKEN_RECHTS');
    assert.strictEqual(cam.requests.length, n, 'trigger=left still asked for the right camera');
    assert.strictEqual(lastSet().visible, 0, 'trigger=left showed the layer on a right turn');
    turn('DAUERBLINKEN_LINKS');
    assert.strictEqual(cam.requests.length, n + 1, 'trigger=left did not ask on a left turn');
    turn(0);

    values.trigger = 'hazard';
    const m = cam.requests.length;
    turn('DAUERBLINKEN_LINKS');
    assert.strictEqual(cam.requests.length, m, 'trigger=hazard asked on a left turn');
    turn(24);
    assert.strictEqual(cam.requests.length, m + 1, 'trigger=hazard did not ask on hazards');
    turn(0);
    values.trigger = 'both';
    console.log('ok: trigger left / hazard / both');

    /* --- the view setting ------------------------------------------------- */
    const views = [['front', 'DR_ACTIVE', 1], ['rear', 'DR_ACTIVE', 2], ['all', 'DR_ACTIVE', 7]];
    for (const [mode, app, p] of views) {
        values.viewMode = mode;
        const k = cam.requests.length;
        turn('DAUERBLINKEN_LINKS');
        assert.deepStrictEqual(cam.requests[k], { application: app, perspective: p },
            mode + ' asked for ' + JSON.stringify(cam.requests[k]));
        turn(0);
    }
    values.viewMode = 'side';
    values.sideLeft = 3;
    values.sideRight = 4;
    let k = cam.requests.length;
    turn('DAUERBLINKEN_LINKS');
    assert.deepStrictEqual(cam.requests[k], { application: 'SIDEVIEW', perspective: 3 }, 'sideLeft is not used');
    turn('DAUERBLINKEN_RECHTS');
    assert.deepStrictEqual(cam.requests[k + 1], { application: 'SIDEVIEW', perspective: 4 }, 'sideRight is not used');
    turn(0);
    console.log('ok: view front / rear / all, and the two side numbers');

    /* --- a setting that changes the view re-asks for the one on screen --- */
    values.holdSec = 0;
    turn('DAUERBLINKEN_LINKS');
    k = cam.requests.length;
    values.viewMode = 'front';
    listeners.slice().forEach((f) => f('viewMode'));
    assert.strictEqual(cam.requests.length, k + 1, 'a view change did not re-ask while the indicator was on');
    assert.strictEqual(cam.requests[k].application, 'DR_ACTIVE', 'the re-ask did not use the new view');
    values.viewMode = 'side';
    turn(0);
    console.log('ok: changing the view while a turn is on asks again at once');

    /* --- crop.json: the whole frame, no cut, no HUD card ----------------- */
    const crop = written['/dev/shm/turn-view/crop.json'];
    assert.ok(crop, 'the app never wrote crop.json');
    const box = JSON.parse(crop);
    assert.strictEqual(box.mapW, MAP_W, 'crop asks for ' + box.mapW + ' wide');
    assert.strictEqual(box.mapH, MAP_H, 'crop asks for ' + box.mapH + ' high');
    assert.strictEqual(box.mapTop + box.mapBottom + box.mapLeft + box.mapRight, 0, 'the crop cuts the camera picture');
    assert.strictEqual(box.mapFit, 'fit', 'the camera picture is stretched');
    assert.strictEqual(box.cardMode, 'off', 'the crop asks for a HUD card');
    console.log('ok: crop.json asks for the whole frame, 1088x480, no card');

    /* --- keepAlive -------------------------------------------------------- */
    values.keepAlive = true;
    listeners.slice().forEach((f) => f('keepAlive'));
    assert.strictEqual(lastSet().visible, 1, 'keepAlive did not show the layer without a turn');
    const beforeAlive = cam.requests.length;
    tick();
    assert.strictEqual(cam.requests.length, beforeAlive + 1,
        'keepAlive showed a layer without asking the camera for a picture');
    tick();
    assert.strictEqual(cam.requests.length, beforeAlive + 1, 'keepAlive asked again on the next tick');
    values.keepAlive = false;
    listeners.slice().forEach((f) => f('keepAlive'));
    assert.strictEqual(lastSet().visible, 0, 'keepAlive off did not hide the layer');
    console.log('ok: keepAlive shows, asks once, and hides without any turn');

    /* --- target off: the layer goes, nothing is shown --------------------- */
    values.keepAlive = true;
    listeners.slice().forEach((f) => f('target'));
    values.target = 'off';
    listeners.slice().forEach((f) => f('target'));
    assert.ok(cr.drops.length >= 1, 'target off did not drop the layer');
    const quiet = cr.sets.length;
    tick();
    assert.strictEqual(cr.sets.length, quiet, 'target off still touched the layer');
    values.target = 'cluster';
    const layersBefore = cr.videos.length;
    listeners.slice().forEach((f) => f('target'));
    tick();
    assert.ok(cr.videos.length > layersBefore, 'target back on did not make a layer');
    assert.strictEqual(lastSet().visible, 1, 'target back on did not show the layer');
    values.keepAlive = false;
    listeners.slice().forEach((f) => f('keepAlive'));
    tick();
    console.log('ok: target off drops the layer and stays quiet; back on makes a new one');

    /* --- a refused layer is not hammered -------------------------------- */
    values.keepAlive = true;
    listeners.slice().forEach((f) => f('keepAlive'));
    values.target = 'off';
    listeners.slice().forEach((f) => f('target'));
    cr.refuseNext = true;
    values.target = 'cluster';
    listeners.slice().forEach((f) => f('target'));
    const calls = cr.calls;
    tick();
    assert.strictEqual(cr.calls, calls, 'a refused layer was asked for again on the next tick');
    clock += 3100;
    tick();
    assert.strictEqual(cr.calls, calls + 1, 'the layer was never asked for again after a refusal');
    assert.ok(cr.videos.length, 'the layer never came back');
    values.keepAlive = false;
    listeners.slice().forEach((f) => f('keepAlive'));
    console.log('ok: a refused layer waits 3 s instead of asking every tick');

    /* --- the page draws --------------------------------------------------- */
    global.uiTick();
    console.log('ok: the status page draws');

    console.log('test_turn_view: all checks passed');
    process.exit(0);
})().catch((e) => {
    console.error('FAIL ' + (e && e.message ? e.message : e));
    if (e && e.stack) console.error(e.stack.split('\n').slice(0, 6).join('\n'));
    process.exit(1);
});
