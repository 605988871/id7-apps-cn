'use strict';
/**
 * Turn View (转向影像) - the camera on the side the indicator points at, in the
 * cluster's central map area.
 *
 * The inputs are two things the car already has:
 *   - the turn signals, de.bmw.body.Light.StatusFunctionsIndicators, the same
 *     signal the ambient light app uses on this unit;
 *   - the camera picture, which arrives as H.264 on the AVB media bus while
 *     something asks the camera ECU for a view.
 *
 * The asking is camreq.js (SOME/IP); the receiving is the turn-cam tool, which
 * writes Annex B to a socket; the decoding is turn-decode (CarLife Map's
 * decoder, built into the same tool, run with --dir /dev/shm/turn-view), so the
 * picture path is the one that already works on this car. This app is the last
 * mile: ask, show, hide.
 *
 * Nothing here draws with a shader. The camera is a video layer on the 'map'
 * target - the same layer the Maps-on-cluster project uses - and the layer is
 * made invisible rather than dropped when the indicator goes off, so the next
 * turn shows the first frame at once instead of waiting for a layer to be
 * accepted again.
 */

const fs = require('fs');
const mgu = require('./kit/mgu');
const { ClusterRender } = require('./cluster_render_client');
const { createSource } = require('./carlife_source');
const { MAP_W, MAP_H, atlasSize, zoomWindow, scaleAtlas } = require('./atlas');
const camreq = require('./camreq');

const APP = 'cn_turn_view';
const DIR = '/dev/shm/turn-view';
const LIVE_SOCK = DIR + '/live.sock';
const CROP_FILE = DIR + '/crop.json';
const CAM_REPORT = DIR + '/turn-cam.txt';
const DECODE_REPORT = '/dev/shm/turn-view-decode.txt';

/* The car's turn signals, from Light.StatusFunctionsIndicators
 * activeFunctionIndicateDirection (by name or wire number). The names are the
 * ones verified on this unit by cn_ambient_config: driver's, one-touch, the
 * driving assistant's and the hazards; the lock and alarm flashes are not. */
const TURN = {
    DAUERBLINKEN_LINKS: 'left', TIPPBLINKEN_LINKS: 'left',
    DAUERBLINKEN_RECHTS: 'right', TIPPBLINKEN_RECHTS: 'right',
    WARNBLINKEN_MANUELL: 'both', CRASH_BLINKEN: 'both', AUFFAHRWARNBLINKEN: 'both',
    WARNBLINKEN_NACH_GEFAHRENBRECHUNG: 'both',
    FAS_WARNBLINKEN_AUSPRAEGUNG_1: 'both', FAS_WARNBLINKEN_AUSPRAEGUNG_2: 'both',
    FAS_WARNBLINKEN_AUSPRAEGUNG_3: 'both',
    FAS_RICHTUNGSBLINKEN_LOWPRIO_LINKS: 'left', FAS_RICHTUNGSBLINKEN_MIDPRIO_LINKS: 'left',
    FAS_RICHTUNGSBLINKEN_HIGHPRIO_LINKS: 'left',
    FAS_RICHTUNGSBLINKEN_LOWPRIO_RECHTS: 'right', FAS_RICHTUNGSBLINKEN_MIDPRIO_RECHTS: 'right',
    FAS_RICHTUNGSBLINKEN_HIGHPRIO_RECHTS: 'right'
};
const TURN_NO = {
    1: 'both', 6: 'both', 7: 'left', 8: 'right', 9: 'left', 10: 'right', 12: 'both',
    13: 'both', 16: 'both', 18: 'left', 19: 'right', 20: 'left', 21: 'right',
    22: 'left', 23: 'right', 24: 'both', 25: 'both'
};
const turnOf = (v) => {
    const x = v && typeof v === 'object' ? v.activeFunctionIndicateDirection : v;
    return (typeof x === 'number' ? TURN_NO[x] : TURN[x]) || null;
};

const SIDE_TEXT = { left: '左转', right: '右转', both: '双闪', null: '没有打灯' };

async function run(ctx) {
    const { ui, settings, log, signals } = ctx;

    const safe = (tag, fn) => function () {
        try { return fn.apply(this, arguments); }
        catch (e) { try { log.error(tag + ': ' + (e && e.stack ? e.stack : e)); } catch (x) {} }
    };

    /* oap-sdk's proxy builder. The host does not hand it over, and the package
     * we ship has only the SDK's index.js, so it is the public export that
     * works here - not the deep path Turn View's own repository uses (its
     * bundle keeps every module). */
    let builders = ctx.someipBuilders;
    if (!builders) {
        try { builders = require('oap-sdk').someipBuilders; }
        catch (e) { log.warn('no someipBuilders: the camera cannot be asked for (' + e.message + ')'); }
    }
    if (!builders) log.warn('camera: no SOME/IP builder in this host, the status page will say why');

    let cr = null;
    let mapLayer = 0;
    let source = null;
    let zoomBuf = null;

    let visible = false;         /* whether the layer is on the glass */
    let holding = false;         /* the indicator is on (or its hold time runs) */
    let hideAt = 0;              /* when the hold time ends; 0 = not running */
    let turnNow = null;

    let layerState = 'off', renderStatus = 'not connected';
    let lastAtlas = null, lastSeq = 0;
    let frames = 0, sent = 0, lastSent = 0;
    let srcStatus = 'stopped';
    let page = 0;
    let lastTurnLine = '';

    const cam = camreq.create({ someipBuilders: builders, log });

    const frameGap = () => 1000 / Math.max(1, Number(settings.get('fps')) || 15);
    const target = () => settings.get('target') || 'cluster';
    const wantShow = () => target() !== 'off' && (settings.get('keepAlive') === true || holding);

    /* The view to ask for, from the mode and the side that is blinking.
     *
     * 'side' is the hoped-for one: the side view is what the car's parking
     * screens use, and whether the camera ECU gives it to an app while driving
     * is the one thing only the car can answer. The status page prints the
     * ECU's own answer, so a refusal is a sentence rather than a black
     * rectangle. */
    function viewFor(side) {
        const mode = settings.get('viewMode') || 'side';
        const defApp = settings.get('application') || 'SIDEVIEW';
        const left = Math.max(1, Math.min(63, Number(settings.get('sideLeft')) || 1));
        const right = Math.max(1, Math.min(63, Number(settings.get('sideRight')) || 2));
        if (mode === 'front') return { application: 'DR_ACTIVE', perspective: 1 };
        if (mode === 'rear') return { application: 'DR_ACTIVE', perspective: 2 };
        if (mode === 'all') return { application: 'DR_ACTIVE', perspective: 7 };
        /* Hazards: there is no "both sides" view to ask for, so the mosaic
         * that holds every camera is the only one that shows what the flashing
         * is about. It is also the one view whose number the stock Drive
         * Recorder asks for, so it is the most likely to be given. */
        if (side === 'both') return { application: 'DR_ACTIVE', perspective: 7 };
        const p = side === 'right' ? right : left;
        return { application: defApp, perspective: p };
    }

    /* ---------------------------------------------------------------- layer -- */

    /* A layer on the map slot is contended for: on this unit the factory map
     * holds it and a third-party content layer loses the first attempt about a
     * third of the time (CarLife Map measured it). `video()` returns 0 then,
     * and the service retries on its own ladder - so the app must not hammer
     * it every tick while that is going on. */
    let layerRetryAt = 0;

    const makeLayer = safe('layer', () => {
        if (!cr || !cr.ready || target() === 'off') return;
        layerFps = Number(settings.get('fps')) || 15;
        layerTarget = target();
        if (mapLayer) { cr.drop(mapLayer); mapLayer = 0; }
        mapLayer = cr.video({
            klass: 'content', target: 'map', x: 0, y: 0, w: MAP_W, h: MAP_H,
            vw: MAP_W, vh: MAP_H,
            fps: layerFps,
            z: 0, visible: 0, contend: 1, opacity: 1,
            /* Holding the map area also hides the factory turn box, as CarLife
             * Map's map layer does: the navigation arrow over a camera picture
             * is the one thing worse than no picture. It comes back when the
             * layer is hidden, which is what hiding rather than dropping the
             * layer buys. */
            guide_hold: 1,
            /* The same reasoning as CarLife Map: cluster-render's defaults hold
             * small changes for up to a second, which on a live camera is a
             * second of lag. A camera scene changes everywhere, so keep both
             * low. */
            dirty_threshold: 2, settle_ms: 120, stall_ms: 6000
        });
        if (!mapLayer) {
            layerState = 'refused';
            layerRetryAt = Date.now() + 3000;
            log.warn('the map layer was refused; asking again in 3 s');
            return;
        }
        layerState = visible ? 'shown' : 'hidden';
        if (visible) cr.set(mapLayer, { visible: 1 });
        if (lastAtlas) sendFrame(lastAtlas, lastSeq);
        log.info('layer: ' + mapLayer + ' at ' + MAP_W + 'x' + MAP_H);
    });

    const setVisible = safe('visible', (on) => {
        if (!mapLayer) return;
        if (visible === on) return;
        visible = on;
        cr.set(mapLayer, { visible: on ? 1 : 0 });
        /* A layer that comes back must show the next picture at once, not wait
         * out a pacing interval that started while it was hidden. */
        if (on) { lastSent = 0; if (lastAtlas) sendFrame(lastAtlas, lastSeq); }
        log.info('layer ' + (on ? 'shown' : 'hidden'));
    });

    /* ---------------------------------------------------------------- frames -- */

    const sendFrame = safe('frame', (atlas, seq) => {
        if (!mapLayer || !atlas || !visible) return;
        if (atlas.length !== atlasSize(MAP_W, MAP_H)) return;
        const now = Date.now();
        if (lastSent && now - lastSent < frameGap()) return;
        lastSent = now;
        const z = Math.max(100, Math.min(200, Number(settings.get('zoom')) || 100));
        let out = atlas;
        if (z > 100) {
            const panX = (Number(settings.get('offsetX')) || 0) / MAP_W * 100;
            const panY = (Number(settings.get('offsetY')) || 0) / MAP_H * 100;
            const win = zoomWindow(MAP_W, MAP_H, z, panX, panY);
            if (!zoomBuf || zoomBuf.length !== atlasSize(MAP_W, MAP_H)) {
                zoomBuf = Buffer.alloc(atlasSize(MAP_W, MAP_H));
            }
            out = scaleAtlas(atlas, MAP_W, MAP_H, win, MAP_W, MAP_H, zoomBuf);
            if (!out) return;
        }
        if (cr.frame(mapLayer, out, seq)) sent++;
    });

    const startSource = safe('source', () => {
        if (source) return;
        source = createSource({
            kind: 'carlife', w: MAP_W, h: MAP_H,
            fps: Number(settings.get('fps')) || 15,
            sockPath: LIVE_SOCK
        });
        source.on('frame', safe('source frame', (atlas, seq) => {
            lastAtlas = atlas;
            lastSeq = seq;
            frames++;
            sendFrame(atlas, seq);
        }));
        source.on('status', safe('source status', (s) => { srcStatus = String(s); }));
        source.start();
        srcStatus = 'starting';
        log.info('camera frames from ' + LIVE_SOCK);
    });

    /* The decoder is run with --dir /dev/shm/turn-view, so it reads the crop
     * from there. A camera picture is the whole frame, not a map inside a
     * phone's screen: no cut, keep the aspect ratio, and no HUD card at all. */
    const writeCrop = safe('crop', () => {
        const box = {
            mapTop: 0, mapBottom: 0, mapLeft: 0, mapRight: 0,
            mapFit: 'fit', mapW: MAP_W, mapH: MAP_H,
            cardMode: 'off', cardTop: 0, cardBottom: 0, cardLeft: 0, cardRight: 0,
            cardFit: 'stretch', cardW: 16, cardH: 16
        };
        try {
            if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, 0o777);
            fs.chmodSync(DIR, 0o777);
        } catch (e) { /* the tool's install made it; this is only a repair */ }
        fs.writeFileSync(CROP_FILE, JSON.stringify(box) + '\n');
    });

    /* ------------------------------------------------------------- the turn -- */

    function matches(side) {
        const t = settings.get('trigger') || 'both';
        if (t === 'hazard') return side === 'both';
        if (t === 'left') return side === 'left' || side === 'both';
        if (t === 'right') return side === 'right' || side === 'both';
        return side === 'left' || side === 'right' || side === 'both';
    }

    /* Ask the camera for a side's view, and only when the answer would be a
     * different one: the indicator fires the same value again on every change
     * of its own state, and a request per fire would be a SOME/IP call per
     * second for a view that is already up. */
    let askedKey = '';

    function ask(side) {
        const v = viewFor(side);
        const key = v.application + '/' + v.perspective;
        if (key === askedKey) return;
        askedKey = key;
        log.info('asking ' + key);
        cam.request(v.application, v.perspective);
    }

    function onTurn(value) {
        const side = turnOf(value);
        if (side === turnNow) return;
        turnNow = side;
        const line = SIDE_TEXT[side] || String(side);
        if (line !== lastTurnLine) { lastTurnLine = line; log.info('turn: ' + line); }

        if (side && matches(side)) {
            holding = true;
            hideAt = 0;
            /* Shown before the camera answers: the layer is up and empty for
             * the fraction of a second the ECU needs, which is the difference
             * between "the picture appears" and "the picture appears late". */
            if (wantShow()) setVisible(true);
            ask(side);
        } else if (holding) {
            const hold = Math.max(0, Math.min(8, Number(settings.get('holdSec')) || 0));
            hideAt = Date.now() + hold * 1000;
            if (!hold) finish();
        }
    }

    function finish() {
        holding = false;
        hideAt = 0;
        askedKey = '';           /* the camera is given back: the next turn asks again */
        setVisible(false);
        cam.release();
    }

    /* One tick for everything that is time: the hold after the indicator goes
     * off, the layer following the setting, and the ask that a setting change
     * or "always on" makes necessary. */
    const tick = safe('tick', () => {
        if (hideAt && Date.now() >= hideAt) finish();
        const want = wantShow();
        /* The layer first: it is what being visible means, and 300 ms of an
         * empty map area is 300 ms of the map being gone. */
        if (want && !mapLayer && cr && cr.ready && Date.now() >= layerRetryAt) makeLayer();
        if (want !== visible) setVisible(want);
        /* "Always on" asks for the left camera once, so that the layer has a
         * picture instead of sitting there grey. Its dedupe means this is one
         * request, and a view change re-asks with the new one. */
        if (settings.get('keepAlive') === true && target() !== 'off') ask('left');
    });
    const tickTimer = setInterval(tick, 300);
    if (tickTimer.unref) tickTimer.unref();

    /* --------------------------------------------------------------- reports -- */

    const lines = (p) => { try { return fs.readFileSync(p, 'utf8').trim().split('\n'); } catch (e) { return []; } };
    const field = (ls, key) => {
        for (let i = 0; i < ls.length; i++) {
            if (ls[i].indexOf(key) === 0) return ls[i].slice(key.length).trim();
        }
        return '';
    };

    /* ---------------------------------------------------------------- status -- */

    const draw = safe('draw', () => {
        const cv = ctx.canvas(1600, 520).clear('#0b1016');
        const st = cam.status();
        if (page === 0) {
            cv.text('转向影像', 40, 64, 40, '#ffffff');
            cv.text('转向灯  : ' + (SIDE_TEXT[turnNow] || '-'), 40, 130, 26, '#a8d8c0');
            /* The layer, not the indicator: with "always on" the picture is up
             * with no turn, and a page that says "waiting" then is a page that
             * sends its reader looking for a fault. */
            cv.text('画面    : ' + (target() === 'off' ? '已关闭' : visible ? '显示中' : '等待转向灯'), 40, 168, 26,
                visible ? '#8fe0a8' : '#a8d8c0');
            cv.text('请求    : ' + (st.asked || '-') + '   ' + st.text, 40, 206, 22, '#7fbf9f');
            const e = st.ecu;
            cv.text('摄像头  : ' + (e ? e.application + '/' + e.mode + '/' + e.perspective : '还没有读到状态'),
                40, 240, 22, '#7fbf9f');
            cv.text('图层    : ' + layerState + '   渲染器: ' + renderStatus, 40, 274, 22, '#a8d8c0');
            cv.text('帧      : 收到 ' + frames + '  送到仪表 ' + sent, 40, 308, 22, '#a8d8c0');
            cv.text('取流    : ' + srcStatus, 40, 342, 20, '#e0c88a');
            const camLs = lines(CAM_REPORT), decLs = lines(DECODE_REPORT);
            cv.text('Camera  : ' + (field(camLs, 'turn-cam:') || '报告还没有'), 40, 384, 20, '#e0c88a');
            cv.text('          ' + (field(camLs, 'packets:') || '-'), 40, 410, 19, '#c8b080');
            cv.text('Decode  : ' + (field(decLs, 'Decode:') || '报告还没有'), 40, 444, 20, '#a8d8c0');
            cv.text('设置里可以调触发方式、看哪一路、缩放和微调；状态页只读，用来判断车上能不能拿到画面。',
                40, 492, 19, '#8fa3b4');
            return ui.image('MAIN_GFX', cv);
        }
        cv.text('诊断', 40, 60, 38, '#ffffff');
        const camLs = lines(CAM_REPORT), decLs = lines(DECODE_REPORT);
        const rows = [
            ['转向灯', SIDE_TEXT[turnNow] || '-'],
            ['请求状态', st.state + '  ' + st.text],
            ['请求的视角', st.asked || '-'],
            ['CameraProxy', st.cam],
            ['ICAM2Proxy', st.icam],
            ['XView3D', st.xv],
            ['ECU 当前', st.ecu ? st.ecu.application + ' / ' + st.ecu.mode + ' / ' + st.ecu.perspective : '-'],
            ['图层', layerState + '   ' + renderStatus],
            ['帧', '收到 ' + frames + '，送到仪表 ' + sent],
            ['画面源', srcStatus],
            ['取流', field(camLs, 'turn-cam:') || '-'],
            ['取流统计', field(camLs, 'packets:') || '-'],
            ['解码', field(decLs, 'Decode:') || '-']
        ];
        rows.forEach((r, i) => {
            cv.text(r[0], 40, 118 + i * 30, 21, '#7fbf9f');
            cv.text(String(r[1]).slice(0, 110), 300, 118 + i * 30, 21, '#a8d8c0');
        });
        return ui.image('MAIN_GFX', cv);
    });

    /* ------------------------------------------------------------- settings -- */

    /* Which size and frame rate the layer was made with: cluster-render takes
     * fps when a layer is made, not as a change, so only those two settings
     * need the layer rebuilt. Everything else (zoom, offsets, trigger, hold,
     * which view) is either the app's own math or one request. */
    let layerFps = 0, layerTarget = '';

    const apply = safe('apply', () => {
        const fps = Number(settings.get('fps')) || 15;
        const t = target();
        /* The view may have changed (side, mode, application): ask for it
         * again while the indicator is still on, so a setting lands without
         * waiting for the next turn. */
        if (holding && turnNow) ask(turnNow);
        if (source) source.fps = fps;
        writeCrop();
        if (t === 'off') {
            if (mapLayer) { cr.drop(mapLayer); mapLayer = 0; }
            visible = false;
            layerState = 'off';
            return;
        }
        /* A new layer for a new frame rate only: dropping one that is already
         * up blanks the map area for as long as the renderer takes to accept
         * it again, which for a zoom change nobody asked for. */
        if (mapLayer && (fps !== layerFps || t !== layerTarget)) makeLayer();
        else if (!mapLayer && Date.now() >= layerRetryAt) makeLayer();
        if (wantShow() !== visible) setVisible(wantShow());
    });

    if (settings.onChange) {
        settings.onChange(safe('settings', (key) => { if (key !== 'theme') apply(); }));
    } else {
        /* Only for a host without onChange: compare the whole set once a second. */
        let last = '';
        const t = setInterval(safe('settings', () => {
            const now = JSON.stringify(settings.all ? settings.all() : null);
            if (now !== last) { last = now; apply(); }
        }), 1000);
        if (t.unref) t.unref();
    }

    /* ---------------------------------------------------------------- wiring -- */

    const connect = safe('connect', () => {
        if (cr) return;
        cr = new ClusterRender(APP);
        cr.on('ready', safe('ready', () => {
            renderStatus = cr.backend + ' ' + cr.targets;
            log.info('cluster-render: ' + renderStatus);
            makeLayer();
            if (wantShow()) setVisible(true);
        }));
        cr.on('disconnected', safe('disconnected', () => {
            renderStatus = 'reconnecting';
            layerState = 'off';
            mapLayer = 0;
            visible = false;
            log.warn('cluster-render went away');
        }));
        cr.on('layer', safe('layer', (ref, state, reason) => {
            if (ref === mapLayer) layerState = state + (reason ? ' (' + reason + ')' : '');
        }));
        cr.on('refused', safe('refused', (op, ref, why) => {
            log.warn('cluster-render refused ' + op + ' ' + ref + ': ' + why);
        }));
    });

    /* The turn signals: a watch on the body module, the same interface the
     * ambient light app reads on this unit. */
    if (signals && signals.watch) {
        signals.watch('de.bmw.body.Light', '1', {
            StatusFunctionsIndicators: (v) => onTurn(v)
        }, log).then((s) => {
            log.info('turn signals: ' + (s && s.error ? 'error ' + s.error : 'subscribed'));
        }, (e) => log.warn('turn signals: ' + (e && e.message ? e.message : e)));
    } else {
        log.warn('no signals in this host: the turn signals cannot be read');
    }

    cam.start();
    /* The folder first: the picture source listens on a socket inside it, and
     * /dev/shm starts empty on every boot. */
    writeCrop();
    startSource();
    connect();
    apply();

    if (ui.comp('BTN_PAGE')) ui.onClick('BTN_PAGE', () => { page = page ? 0 : 1; });
    /* Two pages, redrawn on the screen's own clock: the numbers on them are
     * read from files and from the camera proxy, and reading them once a
     * frame is cheaper than a timer that keeps running off screen. */
    ctx.loop('MAIN', 5, draw);
}

mgu.run({
    async start(ctx) {
        try { await run(ctx); }
        catch (e) { try { ctx.log.error('turn view start: ' + (e && e.stack ? e.stack : e)); } catch (x) {} }
    }
});
