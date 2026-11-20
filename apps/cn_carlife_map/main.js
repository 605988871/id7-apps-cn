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
const { MAP_W, MAP_H, cropAtlas, atlasSize, liveCardAtlas } = require('./atlas');
const { toRgba, parseTarget, parseLayer } = require('./hud_convert');

const APP = 'cn_carlife_map';
const KEYS = ['target', 'source', 'fps', 'hudMode', 'hudDetail',
              'hudWidth', 'hudX', 'hudY', 'hudKeep', 'hudOpacity', 'hudPath',
              'mapTop', 'mapBottom', 'mapLeft', 'mapRight', 'mapFit',
              'cardTop', 'cardBottom', 'cardLeft', 'cardRight', 'cardFit',
              'hudMapX', 'hudMapY'];
const TAP_REPORT = '/dev/shm/carlife-tap.txt';
/* The decoder's own report: whether the stream became a picture. */
const DECODE_REPORT = '/dev/shm/carlife-decode.txt';
/* What the install hook saw when it tried to start the decoder. A decoder
 * that never ran leaves no report at all, and this is the only account of
 * why - so it is read and shown next to the report. */
const DECODE_BOOT = '/dev/shm/carlife-decode-boot.txt';
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
    /* The HUD as RGBA, only when it goes up as an image layer: the buffer, the
     * atlas it was made from, and when the last one went. */
    let hudRgba = null;
    let hudPrev = null;
    let hudImgAt = 0;
    let hudCardNote = '';
    /* The turn card is its own picture on its own socket - see setHudSource. */
    let hudSource = null, hudBuf = null, hudSourceKind = '', hudCards = 0;
    /* The last thing the service refused, and its own account of the HUD's
     * target - the only two places a HUD that never appears is explained. */
    let lastRefused = '';
    let svcText = '';
    let svcAt = 0;
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
        /* Smaller than the glass on purpose. The HUD is shared: BMW draws its
         * speed and limit sign on it, and another app in this repository puts
         * its own content there too. A picture that fills the whole glass
         * hides all of that, so the defaults leave room - 62% of the width for
         * a card, 30% for a piece of the map. */
        const pct = Number(settings.get('hudWidth')) || (mode === 'map' ? 30 : 62);
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

    /* What the HUD layer is made of: the setting, or - on 'auto' - whatever
     * the last attempt was, so a swap sticks for this size instead of being
     * undone at the next rebuild. */
    function wantHudKind() {
        const p = settings.get('hudPath') || 'auto';
        if (p === 'image') return 'image';
        if (p === 'video') return 'video';
        return hudKind;
    }

    /* How the HUD layer is fed, and what happened to it last time.
     *
     * A video layer is the cheap way: one 4:2:0 atlas per frame, the map's own
     * path, and what the original Maps-on-cluster project puts on the HUD. But
     * the display keeps only a couple of video buffers, and a layer the service
     * does not take leaves the target 'idle' and the layer 'waiting' with no
     * reason at all - which on the screen looks exactly like a HUD that is
     * switched off, and cannot be told from one.
     *
     * An image layer is the other way: RGBA, uploaded as a picture, and the
     * path the other HUD app in this repository uses on this same car. So the
     * setting 'auto' starts with the video and, if it has not been shown after
     * six seconds, puts the same picture up as an image. 'Out on the road' is
     * not a place to be editing settings to find out which one this car takes.
     */
    let hudKind = 'video';        /* what hudLayer is: 'video' or 'image' */
    let hudSwapAt = 0;            /* when to try the other kind; 0 = not yet */
    let hudSwaps = 0;
    let hudSeenShown = false;

    /* The HUD's layer, on its own, so that changing how it is fed - the video
     * the display may not take, then a picture - does not take the map down
     * with it and blink the cluster for a reason nobody asked for. */
    function makeHud(hudFps) {
        const r = hudRect();
        hudW = r.w;
        hudH = r.h;
        hudAtlas = null;                       /* the size changed: reuse nothing */
        hudRgba = null;
        hudPrev = null;
        hudImgAt = 0;
        hudSeenShown = false;
        hudSwapAt = 0;
        hudKind = wantHudKind();
        /* The HUD is a shared surface: whatever else draws on it - BMW's own
         * speed and limit sign, another app's content - sits underneath this
         * layer and an opaque picture hides it. Opacity below 100 lets that
         * through, dimmed, instead of covering it. */
        const op = Math.min(100, Math.max(20, Number(settings.get('hudOpacity')) || 100)) / 100;
        if (hudKind === 'image') {
            /* RGBA, so the cluster only has to texture it: the path the other
             * HUD app in this repository uses on this car. */
            hudLayer = cr.image({
                klass: 'overlay',              /* above the stock HUD's content layers */
                target: 'hud', x: r.x, y: r.y, w: r.w, h: r.h,
                iw: r.w, ih: r.h, fps: hudFps, sampling: 'nearest',
                z: 0, visible: 1, opacity: op
            });
        } else {
            hudLayer = cr.video({
                klass: 'overlay',
                target: 'hud', x: r.x, y: r.y, w: r.w, h: r.h,
                vw: r.w, vh: r.h, fps: hudFps,
                z: 0, visible: 1, opacity: op, contend: 1,
                dirty_threshold: 8, settle_ms: 1000, stall_ms: 6000,
                yield: settings.get('hudKeep') ? 0 : 1
            });
        }
        layerState.hud = hudLayer ? 'waiting' : 'refused';
    }

    /* The waiting page's words: how big and where, from the settings. Three
     * numbers passed to the atlas builders, so the picture follows the dial
     * without the app being restarted. */
    const waitText = () => ({
        scale: Number(settings.get('waitScale')) || 100,
        x: Number(settings.get('waitX')) || 0,
        y: Number(settings.get('waitY')) || 0
    });

    /* A card-sized waiting page.
     *
     * In map mode the HUD shows a window cut out of the map layer - and while
     * nothing has arrived, that layer holds the cluster's waiting page, so the
     * window is a 320x140 magnified fragment of one word. The words were never
     * meant to be seen at that scale, which is why they filled the glass. When
     * there is no picture to cut from, the card draws its own page at its own
     * size instead. */
    let hudWaitAt = 0, hudWaitTick = 0, hudWaitBuf = null;
    const waitCard = () => {
        if (!hudW || !hudH) return null;
        const now = Date.now();
        if (hudWaitBuf && now - hudWaitAt < 300) return hudWaitBuf;
        hudWaitAt = now;
        hudWaitBuf = liveCardAtlas(hudWaitBuf, hudW, hudH, hudWaitTick++,
            0, waitText(), carlifeNote());
        return hudWaitBuf;
    };

    /* The HUD's frame, in whichever shape the mode asks for.
     *
     * cluster-render takes a frame only when it is exactly the layer's vw x vh,
     * and a layer rectangle that is smaller than the frame does not scale it —
     * it cuts, showing only the frame's top-left corner. So each mode has to
     * hand over a frame of exactly the size the layer was created with. */
    const sendHud = safe('hud frame', (atlas) => {
        if (!cr || !cr.ready || !hudLayer || !hudW || !hudH) return;
        let frame;
        /* Is there a real picture yet? A CarLife source counts the frames it
         * has actually received; until it has one, the map layer is a status
         * page and there is nothing worth cropping out of it. */
        const noPicture = srcKind === 'carlife' && !(source && source.live > 0);
        if ((settings.get('hudMode') || 'navi') === 'map') {
            if (noPicture) {
                frame = waitCard();
            } else if (!atlas) {
                return;
            } else {
                /* Which piece of the map the glass shows. Centred by default;
                 * the two pan settings move it, as a percentage of the map's
                 * own size, so that a HUD sitting off to one side can show the
                 * road and not the middle of the picture. The window cannot
                 * leave the map, and the offsets are even because 4:2:0 chroma
                 * is per 2x2 block. */
                const px = Number(settings.get('hudMapX')) || 0;
                const py = Number(settings.get('hudMapY')) || 0;
                let dx = ((MAP_W - hudW) >> 1) + Math.round(MAP_W * px / 100);
                let dy = ((MAP_H - hudH) >> 1) + Math.round(MAP_H * py / 100);
                dx = Math.max(0, Math.min(MAP_W - hudW, dx)) & ~1;
                dy = Math.max(0, Math.min(MAP_H - hudH, dy)) & ~1;
                hudAtlas = cropAtlas(atlas, MAP_W, MAP_H, dx, dy, hudW, hudH, hudAtlas);
                frame = hudAtlas;
            }
        } else {
            /* The card arrives on its own stream, already the right size. A
             * map atlas is not a source for it: cutting an arrow out of a
             * shrunken map would show a shrunken arrow. With no card at all,
             * the card-sized waiting page is still better than an empty HUD. */
            frame = hudBuf || (noPicture ? waitCard() : null);
        }
        if (!frame) return;
        if (hudKind === 'image') {
            /* A picture is four bytes a pixel - three times the atlas it came
             * from - so it goes at ten a second at most, and not at all when it
             * is the same picture as last time. A HUD that shows the last frame
             * it got is right; a HUD competing with the map for the upload
             * budget is how the map starts to stutter. */
            const now = Date.now();
            if (now - hudImgAt < 100) return;
            if (hudPrev && hudPrev.length === frame.length && hudPrev.compare(frame) === 0) return;
            if (!hudRgba || hudRgba.length !== hudW * hudH * 4) hudRgba = Buffer.alloc(hudW * hudH * 4);
            if (!toRgba(frame, hudW, hudH, hudRgba)) return;
            if (cr.pixels(hudLayer, null, hudRgba)) {
                hudFrames++;
                hudImgAt = now;
                hudPrev = Buffer.from(frame);
            }
        } else if (cr.frame(hudLayer, frame, ++hudSeq)) {
            hudFrames++;
        }
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
            /* The card from CarLife is the decoder's second picture, always on
             * the local socket: it is not a second connection to whatever the
             * map's path is, and dialling the map's endpoint for it would
             * either be refused or steal the map's only connection. */
            host: live ? null : (override.host || DEFAULT_HOST),
            port: live ? (Number(override.carlifePort) || CARLIFE_PORT) : cardPort,
            sockPath: override.hudSockPath || CARD_SOCK,
            path: override.path || DEFAULT_FIFO,
            tcpListen: kind === 'tcp' ? true : (override.tcpListen === true)
        });
        hudCardNote = kind === 'tcp' ? 'listening on :' + cardPort
                    : live ? 'decoder ' + (override.hudSockPath || CARD_SOCK) : '';
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

    /* What the layers were last made for. Changing a crop percentage must not
     * tear the layers down and build them again: the decoder picks the new
     * rectangle up on its own, and a layer that is dropped and remade blinks
     * on the cluster and in the HUD - exactly when someone is looking at it to
     * tune the crop. */
    let layerSig = '';

    const setLayers = safe('layers', () => {
        const t = settings.get('target') || 'off';
        const hw = wants(t, 'hud') ? hudRect() : null;
        const sig = [t, Number(settings.get('fps')) || 15,
                     hw ? [hw.x, hw.y, hw.w, hw.h].join(',') : '-',
                     settings.get('hudKeep') ? 1 : 0,
                     settings.get('hudOpacity') || 100,
                     settings.get('hudPath') || 'auto',
                     (settings.get('hudMode') || 'navi')].join('|');
        if (sig === layerSig && (mapLayer || hudLayer || t === 'off')) return;
        layerSig = sig;

        if (mapLayer) { if (cr) cr.drop(mapLayer); mapLayer = 0; layerState.map = 'off'; }
        if (hudLayer) { if (cr) cr.drop(hudLayer); hudLayer = 0; layerState.hud = 'off'; hudW = hudH = 0; hudAtlas = null; }

        wantHud = wants(t, 'hud');
        if (!cr || !cr.ready || t === 'off') {
            layerSig = '';                         /* nothing was built: build it when ready */
            refreshClaim();
            setHudSource();                        /* nothing to feed: let it go */
            writeCrop();
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
        if (wants(t, 'hud')) makeHud(fps);
        refreshClaim();
        setHudSource();
        if (lastAtlas) {
            if (mapLayer) cr.frame(mapLayer, lastAtlas, lastSeq);
            if (hudLayer) sendHud(lastAtlas);
        }
        log.info('layers: target ' + t + ', map ' + mapLayer + ', hud ' + hudLayer +
            (hudLayer ? ' at ' + hudW + 'x' + hudH + ' (' + hudRect().x + ',' + hudRect().y + ')' : ''));
        /* The card's size is decided here and named in the crop file, so every
         * path that makes or drops a layer has to rewrite it - including the
         * one where cluster-render only becomes ready a moment after start. */
        writeCrop();
    });

    /* CarLife sends one full-screen picture - its protocol has no map-only
     * channel, unlike CarPlay, which renders a second display for the cluster.
     * So the map is cut out of the whole frame, after decoding: the decoder
     * reads these numbers and outputs an atlas of the cluster's size. The app
     * owns them because the settings UI is here.
     *
     * Both rectangles are percentages of CarLife's own picture, so they do not
     * care what size the phone asked for, and both are tunable: the phone's
     * map and its guidance bar are in different places on different CarLife
     * versions, and there is no way to ask it where. */
    const writeCrop = safe('crop', () => {
        const pct = (k, d) => {
            const v = Math.round(Number(settings.get(k)));
            return isFinite(v) ? Math.min(45, Math.max(0, v)) : d;
        };
        /* The decoder clamps to the same numbers (CARD_MAX_W/H): a card wider
         * than this is a frame the layer will silently refuse. */
        const cardW = Math.min(640, Math.max(16, hudW || CARD_W)) & ~1;
        const cardH = Math.min(256, Math.max(16, hudH || CARD_H)) & ~1;
        /* Flat keys, not nested objects: the decoder is C with no JSON
         * library, and a search for "mapTop" plus a strtod is all it needs. */
        const box = {
            mapTop: pct('mapTop', 8), mapBottom: pct('mapBottom', 0),
            mapLeft: pct('mapLeft', 0), mapRight: pct('mapRight', 0),
            mapFit: settings.get('mapFit') || 'fill',
            mapW: MAP_W, mapH: MAP_H,
            /* The HUD's card is a second crop of the same picture, delivered on
             * a second socket at its own size. CarLife's guidance strip runs
             * across the top of its picture with the turn arrow at its left
             * end, so the card is a box there: 0..24% across and 0..16% down
             * are starting values, not measurements - the bottom edge has to
             * reach the lane row or the lanes are cut off. */
            cardMode: (settings.get('hudMode') || 'navi') === 'navi' ? 'navi' : 'off',
            cardTop: pct('cardTop', 0), cardBottom: pct('cardBottom', 16),
            cardLeft: pct('cardLeft', 0), cardRight: pct('cardRight', 24),
            cardFit: settings.get('cardFit') || 'stretch',
            cardW: cardW, cardH: cardH
        };
        mkdirp('/dev/shm/carlife-map');
        fs.writeFileSync(CROP_FILE, JSON.stringify(box) + '\n');
        log.info('map crop: top ' + box.mapTop + '% bottom ' + box.mapBottom +
            '% left ' + box.mapLeft + '% right ' + box.mapRight + '%, fit ' + box.mapFit +
            '; card ' + box.cardMode + ' ' + box.cardW + 'x' + box.cardH +
            ' t' + box.cardTop + ' b' + box.cardBottom +
            ' l' + box.cardLeft + ' r' + box.cardRight + '%, ' + box.cardFit);
    });

    /* The picture source is only rebuilt when something about the stream
     * changed. Every crop percentage is a settings change, and each one used to
     * tear the socket down and build it again - a stutter for every step of the
     * dial while the crop is being tuned. */
    let srcKind = '', srcFps = 0;
    const setSource = safe('source', () => {
        const kind = settings.get('source') || 'demo';
        const fps = Number(settings.get('fps')) || 15;
        const live = kind === 'carlife';
        if (source && srcKind === kind && srcFps === fps) return;
        srcKind = kind;
        srcFps = fps;
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

    /* Layers first, and the crop file written from inside setLayers: the crop
     * names the card's size, and the card's size is what creating the HUD
     * layer works out. Written the other way round, a fresh start tells the
     * decoder to make a 480x168 card while the layer is, say, 560x196 - and
     * every frame is dropped until the next settings change, with nothing on
     * the screen to say why. */
    /* setHudSource and writeCrop are idempotent and run even when setLayers
     * decides the layers are already right: a HUD detail or a crop percentage
     * changes without any layer changing shape. */
    const apply = safe('apply', () => { setSource(); setLayers(); setHudSource(); writeCrop(); });

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
            /* The refs are kept: the client makes every layer again with its
             * last settings when the socket comes back. Dropping the signature
             * here would make the next 'ready' tear them all down and build
             * them again - a visible blink on the cluster, and the one blink
             * this app can avoid. */
            log.warn('cluster-render went away');
        }));
        cr.on('layer', safe('layer', (ref, state, reason) => {
            if (ref === mapLayer) layerState.map = state + (reason ? ' (' + reason + ')' : '');
            else if (ref === hudLayer) layerState.hud = state + (reason ? ' (' + reason + ')' : '');
        }));
        cr.on('target', safe('target', (name, state, holder, reason) => {
            /* The reason is the whole point: 'waiting with no reason' and
             * 'parked behind stock' look the same on the glass and are fixed in
             * opposite ways. */
            targetEvents[name] = state + (holder && holder !== 'none' ? '/' + holder : '') +
                (reason ? ' ' + reason.slice(0, 40) : '');
        }));
        /* A layer the service refuses never shows and never changes state, so
         * without this the status page keeps the optimistic 'waiting' for ever
         * and says nothing about why. The last refusal is the one that matters:
         * a wrong layer is refused once, not in a loop. */
        cr.on('refused', safe('refused', (op, ref, why) => {
            lastRefused = op + ' ' + ref + ': ' + why;
            log.warn('cluster-render refused ' + op + ' ' + ref + ': ' + why);
        }));
        cr.on('status', safe('status', (text) => { svcText = text || ''; }));
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
    let tapSink = '';
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
        const a = /^annexb: (\w+).*sps=(\d+) pps=(\d+) idr=(\d+)/m.exec(s);
        /* The SPS count is the one that decides whether "0 frames" can ever
         * change: a stream whose sequence header went past before the decoder
         * attached has no picture in it for anyone, and no amount of waiting
         * fixes that. */
        if (a) h = ', ' + (a[1] === 'yes' ? 'H.264' : 'no H.264') +
            ', SPS ' + a[2] + ', IDR ' + a[4];
        /* Whether the pipe carries CarLife's own headers, and the size the car
         * asked the phone for - the one number the crop has to be measured
         * against. Both come from the tap's protocol probe. */
        const p = /^proto: (\w+)/m.exec(s);
        if (p) h += ', ' + p[1];
        /* The tap's own verdict on the socket the decoder is listening on:
         * "no reader" means it never got a connection, "connected" with bytes
         * sent means the decoder is the side that is not reading. Between this
         * and the decoder's `in:` line, "0 frames" stops being a dead end. */
        const sk = /^sink: ([\w ]+?) sent=([\d.]+)MB drops=(\d+)(?: tries=(\d+))?(?: last="([^"]*)")?/m.exec(s);
        if (sk) {
            h += ', sink ' + sk[1].trim() + ' ' + sk[2] + 'MB/' + sk[3] + 'd';
            /* A failed connect carries the errno now: ENOENT is "the decoder
             * never bound that socket", EACCES is "this process may not touch
             * it", EMFILE is "carlife has no descriptors left". Three different
             * repairs, one word on the report. It goes on the line below,
             * because this one is already the longest on the page. */
            tapSink = sk[5] ? sk[1].trim() + ', ' + (sk[4] || '0') + ' tries, ' + sk[5] : '';
        }
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
     * call it stopped - the one question a black cluster cannot answer.
     *
     * The crop lines matter as much: they say what the decoder actually cut
     * the two pictures out of, and at what size it sent them. A frame at the
     * wrong size is dropped by cluster-render without a word, so "the layer
     * stays black while frames are being produced" is nearly always this. */
    let decInfo = 'not read yet';
    let decCrop = '';
    let decErr = '';
    /* How many frames the decoder says it has produced. It is the number that
     * decides where to look: a decoder with frames and an app with none is a
     * different fault from a decoder with nothing. */
    let decFrames = 0;
    let decAt = 0;
    /* Why there is no report at all, when that is the case. The install hook
     * (kit/carlife-tap/install.sh) writes what it found when it tried to start
     * the decoder - the execute bit, the unit, its systemd state and the
     * unit's own last words - to /dev/shm/carlife-decode-boot.txt. Without it
     * "not running (no report)" is a dead end: nothing on the car can say
     * whether the binary is missing, not executable, or simply not started. */
    let decBoot = '';
    let decExec = '';
    let decState = '';
    let decPid = 0;
    let decRestarts = 0;
    let decBootAt = 0;
    function uptime() {
        try {
            const v = parseFloat(fs.readFileSync('/proc/uptime', 'utf8'));
            return isFinite(v) ? v : -1;
        } catch (e) { return -1; }
    }
    function readDecBoot() {
        const now = Date.now();
        if (now - decBootAt < 5000) return decBoot;
        decBootAt = now;
        let s;
        try { s = fs.readFileSync(DECODE_BOOT, 'utf8'); } catch (e) { decBoot = ''; decExec = ''; return decBoot; }
        const lines = s.split('\n').filter(Boolean);
        const state = lines.find((l) => /^state:/.test(l));
        const exec = lines.find((l) => /^exec:/.test(l) &&
            /(missing|not executable|will not run)/.test(l));
        const unit = lines.find((l) => /^unit:/.test(l) && /not installed/.test(l));
        /* systemd's own account of why the unit is down: a journal line,
         * "Nov 20 15:13:35 mgu systemd[12991]: carlife-decode.service: Failed
         * at step EXEC spawning /var/opt/...". Sliced as-is it used up the
         * whole line on the timestamp and the host name, so the part that
         * says what happened was the part that got cut off. Strip the prefix,
         * then the unit's name, and keep what follows. */
        const raw = lines.find((l) => /^[A-Z][a-z]{2} +\d+ [\d:]+ /.test(l) ||
            /Failed at step|error while loading/.test(l));
        decExec = raw
            ? raw.replace(/^[A-Z][a-z]{2} +\d+ [\d:]+ \S+ /, '')
                .replace(/^systemd\[\d+\]: /, '')
                .replace(/^carlife-decode\.service: /, '')
                .slice(0, 110)
            : '';
        /* An install from before this boot has been overtaken: systemd started
         * the unit at boot, and the hook's account of a unit that was not
         * running then is history, not a diagnosis. */
        const was = parseFloat((/^uptime: ([\d.]+)/m.exec(s) || [])[1]);
        const up = uptime();
        const stale = isFinite(was) && up > 0 && up < was;
        const parts = [stale ? 'from before this boot' : '', state, exec, unit].filter(Boolean);
        decBoot = parts.join(' | ').replace(/^state: /, '').slice(0, 110);
        return decBoot;
    }

    /* Has the decoder written its report lately? It rewrites it every second
     * while it runs, so the file's age is a live answer to "is it up" - and a
     * far better one than the file merely existing, which a crash leaves
     * behind for ever. */
    function decoderAge() {
        try {
            const st = fs.statSync(DECODE_REPORT);
            /* mtimeMs is not on every Node 8 build; the Date is always there. */
            const m = st.mtimeMs || (st.mtime && st.mtime.getTime()) || 0;
            return m ? (Date.now() - m) / 1000 : -1;
        } catch (e) { return -1; }
    }

    function readDecode() {
        const now = Date.now();
        if (now - decAt < 2000) return decInfo;
        decAt = now;
        let s;
        try { s = fs.readFileSync(DECODE_REPORT, 'utf8'); }
        catch (e) {
            const b = readDecBoot();
            decInfo = e.code === 'ENOENT'
                ? 'not running (no report)' + (b ? ' - ' + b : '')
                : e.message;
            decCrop = '';
            return decInfo;
        }
        const f = /^frames: (\d+) rate (\d+) fps last (-?\d+)ms/m.exec(s);
        const err = /^error: (.*)$/m.exec(s);
        const soft = /^errors: (\d+)/m.exec(s);
        if (!f) { decInfo = 'report has no frames line'; return decInfo; }
        const e = err && err[1] !== 'none' ? err[1] : '';
        decErr = e ? e.slice(0, 48) : '';
        decFrames = Number(f[1]) || 0;
        const age = decoderAge();
        /* What the decoder itself is doing, and whether anything reached it.
         * "0 frames" has two completely different causes - the tap never
         * connected, or it connected and the stream is unreadable - and the
         * only place that can tell them apart is this report. */
        const st = /^state: (.*)$/m.exec(s);
        decState = st ? st[1].trim() : '';
        const ib = /^in: (\d+) bytes, (\d+) connection/m.exec(s);
        const got = ib ? Number(ib[1]) : -1;
        const conns = ib ? Number(ib[2]) : -1;
        /* A pid that changes between refreshes is a service that keeps
         * dying: enabled, "active", and restarting every three seconds. */
        const pi = /\bpid=(\d+)/.exec(s);
        const pid = pi ? Number(pi[1]) : 0;
        if (pid && decPid && pid !== decPid) decRestarts++;
        if (pid) decPid = pid;
        decInfo = (age > 4 ? 'stopped ' + Math.round(age) + 's ago - ' : '') +
            f[1] + ' frames, ' + f[2] + ' fps' +
            (Number(f[3]) >= 0 ? ', last ' + f[3] + 'ms' : '') +
            (e ? ' - ' + e : '');
        if (f[1] === '0' && !e) {
            if (decState) decInfo += ' - ' + decState;
            if (got >= 0) decInfo += ', in ' + (got / 1048576).toFixed(1) + 'MB/' + conns + ' conn';
            if (decRestarts) decInfo += ' (' + decRestarts + ' restarts)';
        }
        /* The size it sent and the percentages it used, on one line: what to
         * change when the map is off by a strip. */
        const out = /^out: map (\d+x\d+) card (\S+)/m.exec(s);
        const cr = /^crop: map t(\d+) b(\d+) l(\d+) r(\d+).*card t(\d+) b(\d+) l(\d+) r(\d+)/m.exec(s);
        const rc = /^rect: map (\d+),(\d+) (\d+x\d+)/m.exec(s);
        decCrop = out
            ? 'out ' + out[1] + ' + card ' + out[2] +
              (cr ? ' | crop m' + cr[1] + '/' + cr[2] + '/' + cr[3] + '/' + cr[4] +
                    ' c' + cr[5] + '/' + cr[6] + '/' + cr[7] + '/' + cr[8] : '') +
              (rc ? ' | map rect ' + rc[3] + ' at ' + rc[1] + ',' + rc[2] : '') +
              (soft && soft[1] !== '0' ? ' | ' + soft[1] + ' soft' : '')
            : '';
        return decInfo;
    }

    /* What the HUD is showing, in one line: the answer to "is it the arrow, or
     * still a piece of the map?". */
    function hudCardInfo() {
        const mode = settings.get('hudMode') || 'navi';
        if (mode === 'map') {
            return 'map ' + hudW + 'x' + hudH + ' from the map, pan ' +
                (Number(settings.get('hudMapX')) || 0) + '/' +
                (Number(settings.get('hudMapY')) || 0) + '%';
        }
        if (!hudSource) return 'off (no HUD layer)';
        return 'turn card (' + cardSpec().detail + '), ' + hudCards +
            ' from ' + hudSourceKind + ', ' + (hudCardNote || 'own socket');
    }

    /* One line for the waiting picture on the cluster: which of the three
     * "nothing yet" states it is. Only this side can read the reports that
     * say it - the source only sees its own socket. */
    function carlifeNote() {
        if (source && typeof source.live === 'number' && source.live > 0) return '';
        /* The decoder has pictures and this app has none: the break is on this
         * side of the socket. Saying "no picture yet" about a decoder that has
         * produced 1500 of them sends the next hour to the wrong process. */
        if (decFrames > 0) {
            const le = (source && source.listenErr) || '';
            if (/EACCES|EPERM/.test(le)) return 'SOCKET: PERMISSION DENIED';
            if (le) return 'SOCKET NOT OPENED: ' + le.split(' ')[0];
            return 'DECODER OK, NOTHING REACHED THE APP';
        }
        const age = decoderAge();
        /* Up but unable to decode is a different thing from up and waiting,
         * and the decoder's own report is the only place that says so. */
        if (age >= 0 && age <= 4) return decErr ? 'DECODER: ' + decErr : 'DECODER UP, NO PICTURE YET';
        const b = readDecBoot();
        /* systemd's sentence is the only exact account there is, so the
         * cluster gets a short form of it rather than another vague "did not
         * start": a missing loader and a missing execute bit are different
         * faults that need different fixes. */
        if (decExec) {
            if (/No such file/.test(decExec)) return 'DECODER WILL NOT RUN: NO LOADER';
            if (/ermission|denied/.test(decExec)) return 'DECODER NOT EXECUTABLE';
            return 'DECODER FAILED TO START';
        }
        if (/missing|not executable/.test(b)) return 'DECODER NOT EXECUTABLE';
        if (/will not run/.test(b)) return 'DECODER WILL NOT RUN';
        if (age > 4) return 'DECODER STOPPED';
        return 'DECODER NOT RUNNING';
    }

    /* The service's own account, shortened: the target line says who holds the
     * slot, the layer line carries the reason a layer is not shown - the one
     * thing a black HUD cannot say for itself. */
    const svcHudTarget = () => parseTarget(svcText, 'hud').slice(0, 120);
    const svcHudLayer = () => parseLayer(svcText, 'hud', hudLayer).slice(0, 120);

    /* ---------- status page ---------- */
    ctx.loop('MAIN', 5, safe('ui', () => {
        /* A HUD layer that never appears is the one failure this app cannot
         * see from the inside: the service accepts the layer, the target stays
         * idle, and nothing says why. So while it is not up: ask the service
         * for its own account every five seconds, and after six seconds of the
         * video layer not being shown, put the same picture up as an image. */
        if (hudLayer && /^shown/.test(layerState.hud)) hudSeenShown = true;
        if (hudLayer && !hudSeenShown) {
            if (cr && cr.ready && Date.now() - svcAt > 5000) {
                svcAt = Date.now();
                cr.status();
            }
            if (hudKind === 'video' && (settings.get('hudPath') || 'auto') === 'auto') {
                if (!hudSwapAt) hudSwapAt = Date.now() + 6000;
                else if (Date.now() >= hudSwapAt) {
                    hudSwaps++;
                    hudKind = 'image';
                    log.warn('HUD not shown as a video layer in 6 s: trying an image layer');
                    if (cr && hudLayer) cr.drop(hudLayer);
                    hudLayer = 0;
                    makeHud(Number(settings.get('fps')) || 15);
                    writeCrop();
                    if (lastAtlas) sendHud(lastAtlas);
                }
            }
        }

        const cv = ctx.canvas(1600, 520).clear('#0b1016');
        const kind = settings.get('source') || 'demo';
        /* The waiting picture on the cluster carries one short line of why.
         * It is set here, once a loop, because this is the only place that can
         * read the tap and decoder reports. */
        if (source && kind === 'carlife') source.note = carlifeNote();
        /* Size and place of the HUD's waiting words. The cluster page keeps
         * its own larger face: it is read at a glance, and a dial meant to fix
         * the glass should not shrink it. Read when the next page is drawn, so
         * a settings change lands on the next tick and nothing is rebuilt. */
        const wt = waitText();
        if (hudSource) hudSource.text = wt;
        const detail = (() => {
            try { return source && source.detail ? source.detail() : ''; } catch (e) { return ''; }
        })();
        const hudTag = hudLayer && (settings.get('hudPath') || 'auto') !== 'video'
            ? ' [' + hudKind + (hudSwaps ? ', ' + hudSwaps + ' swap' : '') + ']' : '';
        cv.text('CarLife Map on Cluster', 40, 58, 38, '#ffffff');
        cv.text('Source  : ' + kind + '  -  ' + srcStatus, 40, 112, 23, '#a8d8c0');
        cv.text('          ' + (detail || '-'), 40, 140, 21, '#7fbf9f');
        cv.text('Render  : ' + renderStatus, 40, 170, 23, '#a8d8c0');
        cv.text('Map     : ' + layerState.map + '   ' + (targetEvents.map || ''), 40, 199, 22, '#a8d8c0');
        cv.text('HUD     : ' + layerState.hud + '   ' + (targetEvents.hud || '') +
            (hudBlocked ? '  (busy)' : '') + hudTag, 40, 228, 22, '#a8d8c0');
        cv.text('Frames  : ' + frames + '   last seq ' + lastSeq + '   HUD ' + hudFrames +
            (hudW ? ' (' + hudW + 'x' + hudH + ')' : ''), 40, 257, 22, '#a8d8c0');
        cv.text('HUD card: ' + hudCardInfo(), 40, 284, 21, '#a8d8c0');
        cv.text('USB tap : ' + readTap(), 40, 311, 20, '#e0c88a');
        cv.text((tapSink ? 'Tap sink: ' : 'Tap cmds: ') + (tapSink || tapCmds || '-'),
            40, 337, 20, tapSink ? '#e08a8a' : '#e0c88a');
        const dec = readDecode();
        cv.text('Decode  : ' + dec, 40, 363, 20, '#a8d8c0');
        /* The decoder's own crop and output size: the numbers to change when
         * a picture is off by a strip, and the ones that explain a layer that
         * takes frames and shows none of them. When there is no crop to show -
         * the decoder never ran - this line carries the install hook's account
         * of why instead, which is the only account there is. */
        cv.text((decCrop ? 'Cut     : ' : 'Dec boot: ') + (decCrop || readDecBoot() || '-'),
            40, 388, 19, '#7fbf9f');
        cv.text('HUD slot: ' + (svcHudTarget() || (svcText ? 'no target hud line' : 'not asked yet')), 40, 414, 19, '#c8a8e0');
        cv.text('HUD lyr : ' + (svcHudLayer() || (svcText ? 'no layer on hud' : 'not asked yet')), 40, 439, 19, '#c8a8e0');
        cv.text('Refused : ' + (lastRefused ? lastRefused.slice(0, 120) : 'none'), 40, 464, 19,
            lastRefused ? '#e08a8a' : '#8fa3b4');
        /* When the unit would not start, systemd's own sentence takes the last
         * line. It has been the only account of the failure that reached the
         * screen, and until now it reached it cut off in the middle. */
        cv.text(decExec ? 'Exec err: ' + decExec
                        : 'CarLife needs the tap tool and a decoder; see the app README.',
            40, 492, 19, decExec ? '#e08a8a' : '#8fa3b4');
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
