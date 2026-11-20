'use strict';
/**
 * CarLife Map - put a navigation picture on the iDrive 7 cluster and HUD.
 *
 * This app is the head-unit half only. It takes one complete YUV 4:2:0 atlas
 * per frame from a source (built-in demo, TCP stream or local FIFO) and hands
 * it to cluster-render as a video layer on the 'map' and/or 'hud' target.
 * Capturing CarLife's own video is a separate, car-specific job: see README.
 *
 * Nothing is drawn with a shader: the cluster's GPU is small and a heavy
 * shader has been known to restart the KOMBI. Video layers are the path the
 * original "Maps on cluster" project uses, and they are safe here.
 */

const fs = require('fs');
const path = require('path');
const mgu = require('./kit/mgu');
const { HudClaim } = require('./kit/hud_claim');
const { ClusterRender } = require('./cluster_render_client');
const { createSource, mkdirp, DEFAULT_HOST, DEFAULT_PORT, DEFAULT_FIFO, DEFAULT_SOCK, CARLIFE_PORT } = require('./carlife_source');
const { MAP_W, MAP_H, cropAtlas, atlasSize } = require('./atlas');

const APP = 'cn_carlife_map';
const KEYS = ['target', 'source', 'fps', 'hudMode', 'hudDetail',
              'hudWidth', 'hudX', 'hudY', 'hudKeep',
              'mapTop', 'mapBottom', 'mapLeft', 'mapRight', 'mapFit'];
const TAP_REPORT = '/dev/shm/carlife-tap.txt';
/* The decoder's own report: whether the stream became a picture. */
const DECODE_REPORT = '/dev/shm/carlife-decode.txt';
/* Where the decoder is told how much of CarLife's picture is the map. */
const CROP_FILE = '/dev/shm/carlife-map/crop.json';
/* The HUD's turn card, in glass pixels. The visible HUD area is about 560x200,
 * and the stock speed reading and limit sign sit along its bottom, so the card
 * takes most of the width but not all of the height. */
const CARD_W = 480;
const CARD_H = 168;
const CARD_SOCK = '/dev/shm/carlife-map/hud.sock';

async function run(ctx) {
    const { ui, settings, log } = ctx;

    const safe = (tag, fn) => function () {
        try { return fn.apply(this, arguments); }
        catch (e) { try { log.error(tag + ': ' + (e && e.stack ? e.stack : e)); } catch (x) {} }
    };

    /* Optional overrides, for people with SSH: <app data>/carlife.json, e.g.
     * {"tcpListen":true,"port":20558} or {"host":"10.0.0.2","port":20558}. */
    let override = {};
    try {
        const f = path.join(ctx.dataDir || '.', 'carlife.json');
        if (fs.existsSync(f)) override = JSON.parse(fs.readFileSync(f, 'utf8')) || {};
    } catch (e) { log.warn('carlife.json: ' + e.message); }

    const claim = new HudClaim(APP, log);
    let cr = null;
    let source = null;
    let mapLayer = 0, hudLayer = 0;
    let lastAtlas = null, lastSeq = 0, frames = 0;
    /* The HUD gets a frame of its own size, from its own source: a layer's
     * frame must be exactly its vw x vh, and cluster-render drops any frame
     * that is not, silently. */
    let hudW = 0, hudH = 0, hudAtlas = null, hudSeq = 0, hudFrames = 0;
    let hudCardNote = '';
    /* The turn card is its own picture on its own socket - see setHudSource. */
    let hudSource = null, hudBuf = null, hudSourceKind = '', hudCards = 0;
    let srcStatus = 'stopped', renderStatus = 'not connected';
    let wantHud = false, hudBlocked = false;
    const layerState = { map: 'off', hud: 'off' };
    const targetEvents = {};

    /* Keep the HUD claim honest: give way while another app holds it, take it
     * back when free. hud_claim's claim marker is only a write - without this
     * poll a second HUD app would draw over us (or we over it). */
    const refreshClaim = safe('claim', () => {
        const busy = HudClaim.others(APP).length > 0;
        hudBlocked = wantHud && busy;
        claim.hold(wantHud && !busy);
    });
    const claimTimer = setInterval(refreshClaim, 2000);
    if (claimTimer.unref) claimTimer.unref();

    /* iDrive 7 HUD: what the glass actually shows is about x120..680, y120..360
     * of the 800x480 scene (G21/G05 test patterns), and BMW's own speed and
     * limit sign live along the bottom from y~325. A video layer is opaque,
     * so keep the picture in a safe box that does not cover that strip. */
    const HUD_BOX = { x: 120, y: 120, right: 680, bottom: 320 };

    /* Two ways to fill the HUD, and they are not the same picture:
     *
     *   navi - a turn card: one arrow, the distance to it, the road name. This
     *          is what a HUD is for, and what the stock head unit shows for its
     *          own navigation.
     *   map  - a piece of the map, at HUD size. Kept because it is the only
     *          thing that works before a card source exists, and because some
     *          people want it.
     *
     * The card is drawn at its own aspect ratio, so its height follows from
     * hudWidth rather than from the map's. */
    function hudRect() {
        const mode = settings.get('hudMode') || 'navi';
        const pct = Number(settings.get('hudWidth')) || (mode === 'map' ? 50 : 86);
        let w, h;
        if (mode === 'map') {
            w = Math.round(800 * pct / 100) & ~3;
            h = Math.round(w * MAP_H / MAP_W) & ~3;
        } else {
            w = Math.round(560 * pct / 100) & ~3;
            h = Math.round(w * CARD_H / CARD_W) & ~3;
        }
        if (w < 64) w = 64;
        if (w > HUD_BOX.right - HUD_BOX.x) w = HUD_BOX.right - HUD_BOX.x;
        if (h < 32) h = 32;
        if (h > HUD_BOX.bottom - HUD_BOX.y) {
            h = HUD_BOX.bottom - HUD_BOX.y;
            w = (mode === 'map' ? Math.round(h * MAP_W / MAP_H)
                                : Math.round(h * CARD_W / CARD_H)) & ~3;
        }
        const dx = Number(settings.get('hudX')) || 0;
        const dy = Number(settings.get('hudY')) || 0;
        let x = Math.round((HUD_BOX.x + HUD_BOX.right - w) / 2 + dx);
        let y = Math.round((HUD_BOX.y + HUD_BOX.bottom - h) / 2 + dy);
        x = Math.max(HUD_BOX.x, Math.min(HUD_BOX.right - w, x));
        y = Math.max(HUD_BOX.y, Math.min(HUD_BOX.bottom - h, y));
        return { x: x, y: y, w: w, h: h };
    }

    const wants = (t, which) => t === which || t === 'both';

    /* The HUD's frame, in whichever shape the mode asks for.
     *
     * cluster-render takes a frame only when it is exactly the layer's vw x vh,
     * and a layer rectangle that is smaller than the frame does not scale it —
     * it cuts, showing only the frame's top-left corner. So each mode has to
     * hand over a frame of exactly the size the layer was created with. */
    const sendHud = safe('hud frame', (atlas) => {
        if (!cr || !cr.ready || !hudLayer || !hudW || !hudH) return;
        let frame;
        if ((settings.get('hudMode') || 'navi') === 'map') {
            if (!atlas) return;
            const dx = ((MAP_W - hudW) >> 1) & ~1;
            const dy = ((MAP_H - hudH) >> 1) & ~1;
            hudAtlas = cropAtlas(atlas, MAP_W, MAP_H, dx, dy, hudW, hudH, hudAtlas);
            frame = hudAtlas;
        } else {
            /* The card arrives on its own stream, already the right size. A
             * map atlas is not a source for it: cutting an arrow out of a
             * shrunken map would show a shrunken arrow. */
            frame = hudBuf;
        }
        if (frame && cr.frame(hudLayer, frame, ++hudSeq)) hudFrames++;
    });

    /* The turn card has its own stream, because it is not a crop of the map.
     *
     * Same wire format, second socket: whatever produces the card (for now the
     * decoder, until then the demo) writes 480x168-ish atlases to
     * /dev/shm/carlife-map/hud.sock, and the map keeps its own socket
     * untouched. One size per layer, one layer per size - that is the rule
     * cluster-render enforces, and this is the cheapest way to obey it.
     *
     * With `Picture source = demo` the card is drawn on the head unit, so the
     * shape, the size and the HUD layer can all be judged on the car before any
     * picture source exists. */
    /* How much the card says. `full` adds the lane row and the speed limit,
     * which is what a junction needs and a straight road does not: a HUD that
     * says too much says nothing. */
    function cardSpec() {
        const d = settings.get('hudDetail');
        return { detail: d === 'standard' || d === 'minimal' ? d : 'full' };
    }

    const setHudSource = safe('hud source', () => {
        const kind = settings.get('source') || 'demo';
        const fps = Number(settings.get('fps')) || 15;
        const navi = (settings.get('hudMode') || 'navi') !== 'map';
        if (!wantHud || !navi || !hudW || !hudH) {
            if (hudSource) { try { hudSource.removeAllListeners(); hudSource.stop(); } catch (e) {} }
            hudSource = null; hudBuf = null; hudSourceKind = ''; hudCardNote = '';
            return;
        }
        if (hudSource && hudSourceKind === kind && hudSource.w === hudW && hudSource.h === hudH) {
            hudSource.card = cardSpec();              /* detail may have changed */
            return;
        }
        if (hudSource) { try { hudSource.removeAllListeners(); hudSource.stop(); } catch (e) {} }
        hudSource = null; hudBuf = null; hudSourceKind = kind;
        /* The card is a second stream, and it must never be dialled onto the
         * map's endpoint: a producer serves one connection, so the card would
         * either be refused or steal the map's. CarLife's source already has a
         * socket of its own; a network source listens on the next port instead;
         * a pipe has no second path at all. */
        const live = kind === 'carlife';
        if (kind === 'fifo') {
            hudCardNote = 'no card stream: a pipe has one path, not two';
            return;
        }
        const cardPort = (live ? (Number(override.carlifePort) || CARLIFE_PORT)
                              : (Number(override.port) || DEFAULT_PORT)) + 1;
        hudSource = createSource({
            kind: kind, w: hudW, h: hudH, fps: fps,
            draw: 'arrow',
            card: cardSpec(),
            host: live ? (override.carlifeHost || null) : (override.host || DEFAULT_HOST),
            port: live ? (Number(override.carlifePort) || CARLIFE_PORT) : cardPort,
            sockPath: override.hudSockPath || CARD_SOCK,
            path: override.path || DEFAULT_FIFO,
            tcpListen: kind === 'tcp' ? true : (override.tcpListen === true)
        });
        hudCardNote = kind === 'tcp' ? 'listening on :' + cardPort : '';
        hudSource.on('frame', safe('hud card', (buf) => {
            if (buf.length !== atlasSize(hudW, hudH)) return;
            hudBuf = buf;
            hudCards++;
            sendHud(null);
        }));
        hudSource.on('status', safe('hud status', () => {}));
        hudSource.start();
        log.info('hud card source: ' + kind + ' at ' + hudW + 'x' + hudH);
    });

    const setLayers = safe('layers', () => {
        const t = settings.get('target') || 'off';
        if (mapLayer) { if (cr) cr.drop(mapLayer); mapLayer = 0; layerState.map = 'off'; }
        if (hudLayer) { if (cr) cr.drop(hudLayer); hudLayer = 0; layerState.hud = 'off'; hudW = hudH = 0; hudAtlas = null; }

        wantHud = wants(t, 'hud');
        if (!cr || !cr.ready || t === 'off') {
            refreshClaim();
            setHudSource();                        /* nothing to feed: let it go */
            return;
        }
        const fps = Number(settings.get('fps')) || 15;
        const common = {
            klass: 'content', z: 0, visible: 1, contend: 1, opacity: 1,
            vw: MAP_W, vh: MAP_H, fps: fps,
            dirty_threshold: 8, settle_ms: 1000, stall_ms: 6000
        };
        if (wants(t, 'cluster')) {
            mapLayer = cr.video(Object.assign({}, common, {
                target: 'map', x: 0, y: 0, w: MAP_W, h: MAP_H, guide_hold: 1
            }));
            layerState.map = mapLayer ? 'waiting' : 'refused';
        }
        if (wants(t, 'hud')) {
            const r = hudRect();
            hudW = r.w;
            hudH = r.h;
            hudAtlas = null;                       /* the size changed: reuse nothing */
            hudLayer = cr.video(Object.assign({}, common, {
                klass: 'overlay',                  /* above the stock HUD's content layers */
                target: 'hud', x: r.x, y: r.y, w: r.w, h: r.h,
                vw: r.w, vh: r.h,
                yield: settings.get('hudKeep') ? 0 : 1
            }));
            layerState.hud = hudLayer ? 'waiting' : 'refused';
        }
        refreshClaim();
        setHudSource();
        if (lastAtlas) {
            if (mapLayer) cr.frame(mapLayer, lastAtlas, lastSeq);
            if (hudLayer) sendHud(lastAtlas);
        }
        log.info('layers: target ' + t + ', map ' + mapLayer + ', hud ' + hudLayer +
            (hudLayer ? ' at ' + hudW + 'x' + hudH + ' (' + hudRect().x + ',' + hudRect().y + ')' : ''));
    });

    /* CarLife sends one full-screen picture - its protocol has no map-only
     * channel, unlike CarPlay, which renders a second display for the cluster.
     * So the map is cut out of the whole frame, after decoding: the decoder
     * reads these numbers and outputs an atlas of the cluster's size. The app
     * owns them because the settings UI is here. */
    const writeCrop = safe('crop', () => {
        const pct = (k, d) => {
            const v = Math.round(Number(settings.get(k)));
            return isFinite(v) ? Math.min(45, Math.max(0, v)) : d;
        };
        /* Flat keys, not nested objects: the decoder is C with no JSON
         * library, and a search for "mapTop" plus a strtod is all it needs.
         * Both rectangles are percentages of CarLife's own picture, so they do
         * not care what size the phone asked for. */
        const box = {
            mapTop: pct('mapTop', 8), mapBottom: pct('mapBottom', 0),
            mapLeft: pct('mapLeft', 0), mapRight: pct('mapRight', 0),
            mapFit: settings.get('mapFit') || 'fill',
            mapW: MAP_W, mapH: MAP_H,
            /* The HUD's card is a second crop of the same picture, delivered on
             * a second socket at its own size. CarLife's guidance strip runs
             * across the top of its picture with the turn arrow at its left
             * end, so the card is a small box there and nothing else: these are
             * starting values to be tuned on the car, not measurements. The
             * bottom edge has to reach the lane row, or the lanes are cut off. */
            cardMode: (settings.get('hudMode') || 'navi') === 'navi' ? 'navi' : 'off',
            cardTop: 0, cardBottom: 16, cardLeft: 0, cardRight: 24,
            cardW: hudW, cardH: hudH
        };
        mkdirp('/dev/shm/carlife-map');
        fs.writeFileSync(CROP_FILE, JSON.stringify(box) + '\n');
        log.info('map crop: top ' + box.mapTop + '% bottom ' + box.mapBottom +
            '% left ' + box.mapLeft + '% right ' + box.mapRight + '%, fit ' + box.mapFit +
            '; card ' + box.cardMode + ' ' + box.cardW + 'x' + box.cardH);
    });

    const setSource = safe('source', () => {
        const kind = settings.get('source') || 'demo';
        const fps = Number(settings.get('fps')) || 15;
        const live = kind === 'carlife';
        if (source) { source.removeAllListeners(); source.stop(); source = null; }
        source = createSource({
            kind: kind, w: MAP_W, h: MAP_H, fps: fps,
            /* CarLife's own picture is local: the app listens on a socket and
             * the capture side connects. Only an override file makes it dial
             * out (a phone or another box feeding frames). */
            host: live ? (override.carlifeHost || null) : (override.host || DEFAULT_HOST),
            port: live ? (Number(override.carlifePort) || CARLIFE_PORT)
                       : (Number(override.port) || DEFAULT_PORT),
            sockPath: override.sockPath || DEFAULT_SOCK,
            path: override.path || DEFAULT_FIFO,
            tcpListen: override.tcpListen === true
        });
        source.on('frame', safe('frame', (atlas, seq) => {
            lastAtlas = atlas;
            lastSeq = seq;
            frames++;
            if (!cr || !cr.ready) return;
            if (mapLayer) cr.frame(mapLayer, atlas, seq);
            if (hudLayer) sendHud(atlas);
        }));
        source.on('status', safe('source status', (s) => { srcStatus = String(s); }));
        source.start();
        srcStatus = 'starting';
        log.info('picture source: ' + kind + ' @ ' + fps + ' fps');
    });

    const apply = safe('apply', () => { writeCrop(); setSource(); setLayers(); });

    /* ---------- cluster-render ---------- */
    const connect = safe('connect', () => {
        if (cr) return;
        cr = new ClusterRender(APP);
        cr.on('ready', safe('ready', () => {
            renderStatus = cr.backend + ' ' + cr.targets;
            log.info('cluster-render: ' + renderStatus);
            setLayers();
        }));
        cr.on('disconnected', safe('disconnected', () => {
            renderStatus = 'reconnecting';
            layerState.map = 'off'; layerState.hud = 'off';
            log.warn('cluster-render went away');
        }));
        cr.on('layer', safe('layer', (ref, state, reason) => {
            if (ref === mapLayer) layerState.map = state + (reason ? ' (' + reason + ')' : '');
            else if (ref === hudLayer) layerState.hud = state + (reason ? ' (' + reason + ')' : '');
        }));
        cr.on('target', safe('target', (name, state, holder, reason) => {
            targetEvents[name] = state + (holder ? '/' + holder : '');
        }));
        cr.on('refused', safe('refused', (op, ref, why) => {
            log.warn('cluster-render refused ' + op + ' ' + ref + ': ' + why);
        }));
        cr.connect();
        renderStatus = 'connecting';
    });

    /* ---------- settings ---------- */
    settings.onChange(safe('settings change', (key) => {
        if (KEYS.indexOf(key) < 0) return;
        apply();
    }));

    /* ---------- the capture side's own report ----------
     * The picture comes from a preload library inside carlife, which writes a
     * one-page report to /dev/shm. Reading it here is what separates the three
     * failures that all look the same on the cluster: nothing installed,
     * installed but not loaded into carlife, loaded and reading nothing (phone
     * not connected), loaded and reading the stream. */
    let tapInfo = 'not read yet';
    let tapCmds = '';
    let tapAt = 0;
    function readTap() {
        const now = Date.now();
        if (now - tapAt < 2000) return tapInfo;
        tapAt = now;
        let s;
        try { s = fs.readFileSync(TAP_REPORT, 'utf8'); }
        catch (e) {
            tapInfo = e.code === 'ENOENT' ? 'not installed (no report)' : e.message;
            return tapInfo;
        }
        const u = /^urbs: in=(\d+) \(([\d.]+)MB\).*out=(\d+) \(([\d.]+)MB\).*submits=(\d+)/m.exec(s);
        if (!u) { tapInfo = 'report has no traffic yet'; return tapInfo; }
        let h = '';
        const a = /^annexb: (\w+).*idr=(\d+)/m.exec(s);
        if (a) h = ', ' + (a[1] === 'yes' ? 'H.264' : 'no H.264') + ', IDR ' + a[2];
        /* Whether the pipe carries CarLife's own headers, and the size the car
         * asked the phone for - the one number the crop has to be measured
         * against. Both come from the tap's protocol probe. */
        const p = /^proto: (\w+)/m.exec(s);
        if (p) h += ', ' + p[1];
        const m = /^media: (\d+)x(\d+)@(\d+)/m.exec(s);
        if (m) h += ', car wants ' + m[1] + 'x' + m[2];
        tapInfo = 'in ' + u[2] + 'MB out ' + u[4] + 'MB' + h;
        /* The service types the command channel carries, with how often each
         * was seen. This is the list that says whether anything besides video
         * and handshake is in the pipe at all - and the report itself is a file
         * nobody can read from the car's screen, so it has to be shown. */
        const seen = [];
        const re = /^cmd 0x([0-9a-f]{8}) n=(\d+)/gm;
        let c;
        while ((c = re.exec(s)) && seen.length < 8) seen.push(c[1].slice(2) + '*' + c[2]);
        tapCmds = seen.join(' ');
        return tapInfo;
    }

    /* What the decoder says about itself. The tap report says the stream is
     * there; this one says whether it became a picture, and if not, at which
     * call it stopped - the one question a black cluster cannot answer. */
    let decInfo = 'not read yet';
    let decAt = 0;
    function readDecode() {
        const now = Date.now();
        if (now - decAt < 2000) return decInfo;
        decAt = now;
        let s;
        try { s = fs.readFileSync(DECODE_REPORT, 'utf8'); }
        catch (e) {
            decInfo = e.code === 'ENOENT' ? 'not running (no report)' : e.message;
            return decInfo;
        }
        const f = /^frames: (\d+) rate (\d+) fps last (-?\d+)ms/m.exec(s);
        const err = /^error: (.*)$/m.exec(s);
        if (!f) { decInfo = 'report has no frames line'; return decInfo; }
        const e = err && err[1] !== 'none' ? err[1] : '';
        decInfo = f[1] + ' frames, ' + f[2] + ' fps' +
            (Number(f[3]) >= 0 ? ', last ' + f[3] + 'ms' : '') +
            (e ? ' - ' + e : '');
        return decInfo;
    }

    /* What the HUD is showing, in one line: the answer to "is it the arrow, or
     * still a piece of the map?". */
    function hudCardInfo() {
        const mode = settings.get('hudMode') || 'navi';
        if (mode === 'map') return 'map crop, middle of the picture';
        if (!hudSource) return 'off (no HUD layer)';
        return 'turn card (' + cardSpec().detail + '), ' + hudCards +
            ' from ' + hudSourceKind + ', ' + (hudCardNote || 'own socket');
    }

    /* ---------- status page ---------- */
    ctx.loop('MAIN', 5, safe('ui', () => {
        const cv = ctx.canvas(1600, 520).clear('#0b1016');
        const kind = settings.get('source') || 'demo';
        const detail = (() => {
            try { return source && source.detail ? source.detail() : ''; } catch (e) { return ''; }
        })();
        cv.text('CarLife Map on Cluster', 40, 68, 42, '#ffffff');
        cv.text('Source  : ' + kind + '  -  ' + srcStatus, 40, 128, 26, '#a8d8c0');
        cv.text('          ' + (detail || '-'), 40, 164, 24, '#7fbf9f');
        cv.text('Render  : ' + renderStatus, 40, 208, 26, '#a8d8c0');
        cv.text('Map     : ' + layerState.map + '   ' + (targetEvents.map || ''), 40, 248, 26, '#a8d8c0');
        cv.text('HUD     : ' + layerState.hud + '   ' + (targetEvents.hud || '') + (hudBlocked ? '  (busy, giving way)' : ''), 40, 288, 26, '#a8d8c0');
        cv.text('Frames  : ' + frames + '   last seq ' + lastSeq + '   HUD ' + hudFrames +
            (hudW ? ' (' + hudW + 'x' + hudH + ')' : ''), 40, 328, 26, '#a8d8c0');
        cv.text('HUD card: ' + hudCardInfo(), 40, 368, 24, '#a8d8c0');
        cv.text('USB tap : ' + readTap(), 40, 396, 22, '#e0c88a');
        cv.text('Tap cmds: ' + (tapCmds || '-'), 40, 428, 22, '#e0c88a');
        cv.text('Decode  : ' + readDecode(), 40, 460, 22, '#a8d8c0');
        cv.text('CarLife needs the tap tool and a decoder; see the app README.', 40, 476, 22, '#8fa3b4');
        return ui.image('MAIN_GFX', cv);
    }));

    apply();
    connect();
}

mgu.run({
    async start(ctx) {
        try { await run(ctx); }
        catch (e) { try { ctx.log.error('carlife map start: ' + (e && e.stack ? e.stack : e)); } catch (x) {} }
    }
});
