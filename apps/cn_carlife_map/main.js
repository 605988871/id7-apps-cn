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
const { MAP_W, MAP_H, cropAtlas } = require('./atlas');

const APP = 'cn_carlife_map';
const KEYS = ['target', 'source', 'fps', 'hudWidth', 'hudX', 'hudY', 'hudKeep',
              'mapTop', 'mapBottom', 'mapLeft', 'mapRight', 'mapFit'];
const TAP_REPORT = '/dev/shm/carlife-tap.txt';
/* Where the decoder is told how much of CarLife's picture is the map. */
const CROP_FILE = '/dev/shm/carlife-map/crop.json';

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
    /* The HUD gets a frame of its own size (see cropAtlas): a layer's frame
     * must be exactly its vw x vh, and cluster-render drops any frame that is
     * not, silently. */
    let hudW = 0, hudH = 0, hudAtlas = null, hudSeq = 0, hudFrames = 0;
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

    function hudRect() {
        const pct = Number(settings.get('hudWidth')) || 50;
        let w = Math.round(800 * pct / 100) & ~3;
        if (w < 64) w = 64;
        if (w > HUD_BOX.right - HUD_BOX.x) w = HUD_BOX.right - HUD_BOX.x;
        let h = Math.round(w * MAP_H / MAP_W) & ~3;
        if (h < 32) h = 32;
        if (h > HUD_BOX.bottom - HUD_BOX.y) {
            h = HUD_BOX.bottom - HUD_BOX.y;
            w = Math.round(h * MAP_W / MAP_H) & ~3;
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

    /* The HUD draws the middle of the map, at its own size.
     *
     * cluster-render takes a frame only when it is exactly the layer's vw x vh,
     * and a layer rectangle that is smaller than the frame does not scale it —
     * it cuts, showing only the frame's top-left corner. Fed the map's
     * 1088x480 frame, the HUD therefore showed the corner of a dark test grid,
     * which on a projected HUD is nothing at all. Cropping the middle into a
     * frame the size of the HUD's box is what makes it visible. */
    const sendHud = safe('hud frame', (atlas) => {
        if (!cr || !hudLayer || !hudW || !hudH) return;
        const dx = ((MAP_W - hudW) >> 1) & ~1;
        const dy = ((MAP_H - hudH) >> 1) & ~1;
        hudAtlas = cropAtlas(atlas, MAP_W, MAP_H, dx, dy, hudW, hudH, hudAtlas);
        if (cr.frame(hudLayer, hudAtlas, ++hudSeq)) hudFrames++;
    });

    const setLayers = safe('layers', () => {
        const t = settings.get('target') || 'off';
        if (mapLayer) { if (cr) cr.drop(mapLayer); mapLayer = 0; layerState.map = 'off'; }
        if (hudLayer) { if (cr) cr.drop(hudLayer); hudLayer = 0; layerState.hud = 'off'; hudW = hudH = 0; hudAtlas = null; }

        wantHud = wants(t, 'hud');
        if (!cr || !cr.ready || t === 'off') {
            refreshClaim();
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
        const box = {
            top: pct('mapTop', 8), bottom: pct('mapBottom', 0),
            left: pct('mapLeft', 0), right: pct('mapRight', 0),
            fit: settings.get('mapFit') || 'band'
        };
        mkdirp('/dev/shm/carlife-map');
        fs.writeFileSync(CROP_FILE, JSON.stringify(box) + '\n');
        log.info('map crop: top ' + box.top + '% bottom ' + box.bottom +
            '% left ' + box.left + '% right ' + box.right + '%, fit ' + box.fit);
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
        const a = /^annexb: (\w+).*idr=(\d+) slice=(\d+)/m.exec(s);
        if (a) h = ', ' + (a[1] === 'yes' ? 'H.264' : 'no H.264') + ', IDR ' + a[2] + ', slice ' + a[3];
        tapInfo = 'in ' + u[2] + 'MB out ' + u[4] + 'MB' + h;
        return tapInfo;
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
        cv.text('USB tap : ' + readTap(), 40, 368, 24, '#e0c88a');
        cv.text('CarLife needs the USB tap tool and a decoder; see the app README.', 40, 424, 24, '#8fa3b4');
        cv.text('Settings: picture source, target, frame rate, HUD size and position.', 40, 464, 24, '#8fa3b4');
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
