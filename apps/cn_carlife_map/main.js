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
const { createSource, DEFAULT_HOST, DEFAULT_PORT, DEFAULT_FIFO } = require('./carlife_source');
const { MAP_W, MAP_H } = require('./atlas');

const APP = 'cn_carlife_map';
const KEYS = ['target', 'source', 'fps', 'hudWidth', 'hudX', 'hudY', 'hudKeep'];

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
    let srcStatus = 'stopped', renderStatus = 'not connected';
    const layerState = { map: 'off', hud: 'off' };
    const targetEvents = {};

    function hudRect() {
        const pct = Number(settings.get('hudWidth')) || 57;
        let w = Math.round(800 * pct / 100) & ~3;
        if (w < 64) w = 64;
        if (w > 800) w = 800;
        let h = Math.round(w * MAP_H / MAP_W) & ~3;
        if (h < 32) h = 32;
        if (h > 480) h = 480;
        const dx = Number(settings.get('hudX')) || 0;
        const dy = Number(settings.get('hudY')) || 0;
        return {
            x: Math.round((800 - w) / 2 + dx),
            y: Math.round((480 - h) / 2 + dy),
            w: w, h: h
        };
    }

    const wants = (t, which) => t === which || t === 'both';

    const setLayers = safe('layers', () => {
        const t = settings.get('target') || 'off';
        if (mapLayer) { if (cr) cr.drop(mapLayer); mapLayer = 0; layerState.map = 'off'; }
        if (hudLayer) { if (cr) cr.drop(hudLayer); hudLayer = 0; layerState.hud = 'off'; }

        if (!cr || !cr.ready || t === 'off') {
            claim.hold(false);
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
            hudLayer = cr.video(Object.assign({}, common, {
                target: 'hud', x: r.x, y: r.y, w: r.w, h: r.h,
                yield: settings.get('hudKeep') ? 0 : 1
            }));
            layerState.hud = hudLayer ? 'waiting' : 'refused';
        }
        claim.hold(wants(t, 'hud'));
        if (lastAtlas) {
            if (mapLayer) cr.frame(mapLayer, lastAtlas, lastSeq);
            if (hudLayer) cr.frame(hudLayer, lastAtlas, lastSeq);
        }
        log.info('layers: target ' + t + ', map ' + mapLayer + ', hud ' + hudLayer);
    });

    const setSource = safe('source', () => {
        const kind = settings.get('source') || 'demo';
        const fps = Number(settings.get('fps')) || 15;
        if (source) { source.removeAllListeners(); source.stop(); source = null; }
        source = createSource({
            kind: kind, w: MAP_W, h: MAP_H, fps: fps,
            host: override.host || DEFAULT_HOST,
            port: Number(override.port) || DEFAULT_PORT,
            path: override.path || DEFAULT_FIFO,
            tcpListen: override.tcpListen === true
        });
        source.on('frame', safe('frame', (atlas, seq) => {
            lastAtlas = atlas;
            lastSeq = seq;
            frames++;
            if (!cr || !cr.ready) return;
            if (mapLayer) cr.frame(mapLayer, atlas, seq);
            if (hudLayer) cr.frame(hudLayer, atlas, seq);
        }));
        source.on('status', safe('source status', (s) => { srcStatus = String(s); }));
        source.start();
        srcStatus = 'starting';
        log.info('picture source: ' + kind + ' @ ' + fps + ' fps');
    });

    const apply = safe('apply', () => { setSource(); setLayers(); });

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

    /* ---------- status page ---------- */
    ctx.loop('MAIN', 5, safe('ui', () => {
        const cv = ctx.canvas(1600, 520).clear('#0b1016');
        cv.text('CarLife Map on Cluster', 40, 68, 42, '#ffffff');
        cv.text('Source  : ' + (settings.get('source') || 'demo') + '  -  ' + srcStatus, 40, 140, 28, '#a8d8c0');
        cv.text('Render  : ' + renderStatus, 40, 184, 28, '#a8d8c0');
        cv.text('Map     : ' + layerState.map + '   ' + (targetEvents.map || ''), 40, 228, 28, '#a8d8c0');
        cv.text('HUD     : ' + layerState.hud + '   ' + (targetEvents.hud || ''), 40, 272, 28, '#a8d8c0');
        cv.text('Frames  : ' + frames + '   last seq ' + lastSeq, 40, 316, 28, '#a8d8c0');
        cv.text('Install Cluster renderer from the MGU Store if Render stays empty.', 40, 398, 26, '#8fa3b4');
        cv.text('Settings: source, target, frame rate and HUD size/position.', 40, 442, 26, '#8fa3b4');
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
