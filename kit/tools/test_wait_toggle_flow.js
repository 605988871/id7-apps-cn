'use strict';
/**
 * The waiting-page switch through the whole app, with the car replaced by
 * stubs:
 *
 *   node kit/tools/test_wait_toggle_flow.js
 *
 * main.js is loaded unchanged; only its renderer, its two picture sources and
 * the iDrive canvas are replaced. What is checked is the one thing a unit test
 * of the policy cannot show: turning the setting off actually sends `visible
 * 0` to both layers, and the first real pictures put them back at `1`.
 */
const assert = require('assert');
const fs = require('fs');
const Module = require('module');
const path = require('path');
const EventEmitter = require('events');

const ROOT = path.join(__dirname, '..', '..');
const MAIN = path.join(ROOT, 'apps', 'cn_carlife_map', 'main.js');
const spec = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps', 'cn_carlife_map', 'app.json'), 'utf8'));
const defaults = {};
spec.settings.forEach((s) => { defaults[s.key] = s.default; });
const values = Object.assign({}, defaults, { target: 'both', source: 'carlife' });

class FakeCR {
    constructor() {
        this.ready = false;
        this.backend = 'fake';
        this.targets = 'map hud';
        this.handlers = {};
        this.refs = 0;
        this.videos = [];
        this.images = [];
        this.sets = [];
        this.frames = [];
        this.drops = [];
        global.cr = this;
    }
    on(ev, fn) { (this.handlers[ev] = this.handlers[ev] || []).push(fn); return this; }
    emit(ev) { const a = Array.prototype.slice.call(arguments, 1); (this.handlers[ev] || []).forEach((f) => f.apply(null, a)); }
    video(o) { this.videos.push(o); return ++this.refs; }
    image(o) { this.images.push(o); return ++this.refs; }
    set(ref, o) { this.sets.push({ ref: ref, visible: o.visible }); }
    drop(ref) { this.drops.push(ref); }
    frame(ref, b, id) { this.frames.push({ ref: ref, id: id, size: b.length }); return true; }
    pixels(ref) { this.frames.push({ ref: ref, pixels: true }); return true; }
    status() {}
    connect() { this.ready = true; this.emit('ready'); }
}

class FakeSource extends EventEmitter {
    constructor(o) {
        super();
        this.opts = o;
        this.w = o.w;
        this.h = o.h;
        this.live = 0;
        this.lastLiveAt = 0;
        this.seq = 0;
        this.note = '';
        this.text = null;
        this.running = false;
        global.sources.push(this);
    }
    start() { this.running = true; }
    stop() { this.running = false; }
    detail() { return 'fake'; }
    send(buf) { this.emit('frame', buf, this.seq++); }
}

global.cr = null;
global.sources = [];
const fakeMgu = { run: (o) => { global.startApp = o.start; } };
const fakeClaim = function () { this.hold = () => {}; };
fakeClaim.others = () => [];
const fakeGauges = { button: () => 100 };
const fakeHudConvert = {
    toRgba: () => true,
    parseTarget: () => '',
    parseLayer: () => ''
};

const realMkdir = fs.mkdirSync;
const realWrite = fs.writeFileSync;
const underShm = (p) => String(p).replace(/\\/g, '/').indexOf('/dev/shm/') >= 0;
fs.mkdirSync = function (p) { if (underShm(p)) return undefined; return realMkdir.apply(this, arguments); };
fs.writeFileSync = function (p) { if (underShm(p)) return undefined; return realWrite.apply(this, arguments); };

const load = Module._load;
Module._load = function (request, parent) {
    if (parent && parent.filename === MAIN) {
        if (request === './kit/mgu') return fakeMgu;
        if (request === './kit/hud_claim') return { HudClaim: fakeClaim };
        if (request === './kit/gauges') return fakeGauges;
        if (request === './cluster_render_client') return { ClusterRender: FakeCR };
        if (request === './carlife_source') {
            return {
                createSource: (o) => new FakeSource(o),
                mkdirp: () => {},
                DEFAULT_HOST: '127.0.0.1', DEFAULT_PORT: 20558,
                DEFAULT_FIFO: 'fifo', DEFAULT_SOCK: 'sock', CARLIFE_PORT: 20559
            };
        }
        if (request === './hud_convert') return fakeHudConvert;
    }
    return load.apply(this, arguments);
};
require(MAIN);
Module._load = load;
fs.mkdirSync = realMkdir;
fs.writeFileSync = realWrite;

const canvas = {
    clear() { return this; }, text() { return this; }, rect() { return this; },
    line() { return this; }, circle() { return this; }
};
const listeners = [];
const settings = {
    get: (k) => values[k],
    set: (k, v) => { values[k] = v; listeners.slice().forEach((f) => f(k)); },
    onChange: (f) => listeners.push(f),
    item: (k) => ({ steps: defaults[k] && defaults[k].steps, default: defaults[k].default })
};
const ctx = {
    dataDir: path.join(ROOT, 'dist', 'cn_carlife_map'),
    settings: settings,
    ui: { image: () => ({}), comp: () => false, onClick: () => {} },
    canvas: () => canvas,
    theme: () => ({ text: '#fff', accent: '#0f0' }),
    loop: (name, fps, fn) => { global.uiTick = fn; },
    log: { info: () => {}, warn: () => {}, error: () => {} }
};

(async () => {
    await global.startApp(ctx);
    const cr = global.cr;
    assert.ok(cr, 'no renderer was created');
    assert.strictEqual(cr.videos.length, 2, 'expected a cluster and a HUD layer, got ' + cr.videos.length);
    assert.strictEqual(cr.sets.length, 0, 'a new layer should be visible');

    const map = global.sources.filter((s) => s.opts.draw !== 'arrow')[0];
    const card = global.sources.filter((s) => s.opts.draw === 'arrow')[0];
    assert.ok(map && card, 'the app did not open both picture streams');
    const { atlasSize } = require(path.join(ROOT, 'apps', 'cn_carlife_map', 'atlas'));
    const mapBuf = Buffer.alloc(atlasSize(map.w, map.h), 16);
    const cardBuf = Buffer.alloc(atlasSize(card.w, card.h), 16);

    /* A waiting picture with the switch on changes nothing. */
    map.send(mapBuf);
    card.send(cardBuf);
    assert.strictEqual(cr.sets.length, 0, 'the default hid a layer');

    /* Switch it off: both layers step aside even though no frame arrived. */
    settings.set('showWait', false);
    const off = cr.sets.filter((s) => s.visible === 0).map((s) => s.ref);
    assert.strictEqual(off.length, 2, 'expected two hidden layers, got ' + JSON.stringify(cr.sets));

    /* A fresh map puts only the map back; a fresh card puts only the HUD back. */
    map.live = 1;
    map.lastLiveAt = Date.now();
    map.send(mapBuf);
    assert.strictEqual(cr.sets.filter((s) => s.visible === 1).length, 1, 'the map did not come back');
    card.live = 1;
    card.lastLiveAt = Date.now();
    card.send(cardBuf);
    assert.strictEqual(cr.sets.filter((s) => s.visible === 1).length, 2, 'the HUD did not come back');

    /* Nothing changes while the state stays the same. */
    const n = cr.sets.length;
    map.send(mapBuf);
    card.send(cardBuf);
    settings.set('showWait', false);
    assert.strictEqual(cr.sets.length, n, 'the same visibility was sent again');

    /* Turning the switch back on cannot show the waiting pages while a real
     * picture is present, but the setting itself is not lost. */
    settings.set('showWait', true);
    assert.strictEqual(values.showWait, true);

    /* The fine-tuning buttons write hudX/hudY. A change must rebuild the HUD
     * layer at the new rectangle, not just save the number. */
    const hudBefore = cr.videos[cr.videos.length - 1];
    settings.set('hudX', 40);
    const hudAfter = cr.videos[cr.videos.length - 1];
    assert.notStrictEqual(hudAfter, hudBefore, 'a position change did not rebuild the HUD layer');
    assert.ok(hudAfter.x > hudBefore.x, 'hudX did not move the layer right: ' +
        hudBefore.x + ' -> ' + hudAfter.x);

    /* At 100% width the default safe box is exactly as wide as the card. The
     * old clamp to that box made every left/right press a no-op. */
    settings.set('hudWidth', 100);
    const fullBefore = cr.videos[cr.videos.length - 1];
    settings.set('hudX', 80);
    const fullAfter = cr.videos[cr.videos.length - 1];
    assert.ok(fullAfter.x > fullBefore.x, 'hudX did nothing at hudWidth 100: ' +
        fullBefore.x + ' -> ' + fullAfter.x);

    /* A burst from the decoder must not become a burst on the renderer. */
    const mapRef = 1;
    const beforeBurst = cr.frames.filter((f) => f.ref === mapRef).length;
    for (let i = 0; i < 10; i++) map.send(mapBuf);
    const afterBurst = cr.frames.filter((f) => f.ref === mapRef).length;
    assert.ok(afterBurst - beforeBurst <= 1,
        'pacing let ' + (afterBurst - beforeBurst) + ' frames through in one tick');

    console.log('wait_toggle_flow ok: hiding, recovery, HUD position at 100%, and burst pacing');
})().catch((e) => {
    console.log('FAIL wait_toggle_flow\n     ' + (e && e.stack ? e.stack : e));
    process.exit(1);
});
