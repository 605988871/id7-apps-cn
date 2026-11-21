// SPDX-License-Identifier: MPL-2.0
'use strict';
/**
 * YUV 4:2:0 atlas helpers for cluster-render video layers.
 *
 * A cluster-render video frame is one whole 4:2:0 atlas, w x (h + h/2):
 *   rows 0 .. h-1            Y, w bytes per row
 *   rows h .. h+h/2-1        U in the left half, V in the right half
 * No RGB conversion happens on the head unit: the KOMBI's GPU does it.
 *
 * The demo pattern writes straight into the atlas, so it costs no RGB
 * conversion and is safe to run in the OAP process.
 */

const MAP_W = 1088;
const MAP_H = 480;

function atlasSize(w, h) {
    return w * (h + (h >> 1));
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

/** Fill a rectangle in the Y plane. */
function fillY(a, w, h, x, y, rw, rh, value) {
    const x0 = clamp(x, 0, w), x1 = clamp(x + rw, 0, w);
    const y0 = clamp(y, 0, h), y1 = clamp(y + rh, 0, h);
    if (x1 <= x0 || y1 <= y0) return;
    for (let yy = y0; yy < y1; yy++) a.fill(value, yy * w + x0, yy * w + x1);
}

/** Fill a rectangle in the U and V planes (coordinates are full-frame). */
function fillUV(a, w, h, x, y, rw, rh, u, v) {
    const hw = w >> 1, hh = h >> 1;
    const x0 = clamp(x >> 1, 0, hw), x1 = clamp((x + rw) >> 1, 0, hw);
    const y0 = clamp(y >> 1, 0, hh), y1 = clamp((y + rh) >> 1, 0, hh);
    if (x1 <= x0 || y1 <= y0) return;
    for (let by = y0; by < y1; by++) {
        const row = h * w + by * w;
        a.fill(u, row + x0, row + x1);
        a.fill(v, row + hw + x0, row + hw + x1);
    }
}

/**
 * Cut a rectangle out of one atlas, into an atlas of the rectangle's own size.
 *
 * A video layer draws its frame at the frame's size: a layer rectangle smaller
 * than the frame does not scale it, the rest is cut off. The cluster's map slot
 * is 1088x480 and the HUD glass is about 560x200, so a HUD layer fed the map's
 * frame can only ever show the map's top-left corner — which is mostly
 * background, and invisible on a projected HUD. The HUD needs a frame of its
 * own size.
 *
 * `dx`/`dy` must be even and `dw` a multiple of 4 with `dh` even: 4:2:0 chroma
 * is per 2x2 block, and cluster-render takes only those frame sizes.
 * The rectangle must lie inside the source.
 */
function cropAtlas(src, sw, sh, dx, dy, dw, dh, out) {
    const need = atlasSize(dw, dh);
    const a = out && out.length === need ? out : Buffer.alloc(need);
    const hw = dw >> 1, hh = dh >> 1;
    const su = sw * sh;                 // where the chroma planes start
    const du = dw * dh;
    for (let y = 0; y < dh; y++) {
        const s = (dy + y) * sw + dx;
        src.copy(a, y * dw, s, s + dw);
    }
    for (let by = 0; by < hh; by++) {
        const s = su + ((dy >> 1) + by) * sw + (dx >> 1);
        const d = du + by * dw;
        src.copy(a, d, s, s + hw);                              // U
        src.copy(a, d + hw, s + (sw >> 1), s + (sw >> 1) + hw);  // V
    }
    return a;
}

/**
 * The window of the source a zoom shows. 100 is the whole picture; a larger
 * number takes a smaller window (a closer look) and that window is stretched
 * to the layer's size. Pan moves the window after centring it, in per cent of
 * the source, so a pan has no room until there is zoom to give it - which is
 * why the HUD's full-map view is centred and cannot be nudged away from it.
 * x/y are even and w is a multiple of four, so chroma stays on 2x2 blocks.
 */
function zoomWindow(sw, sh, zoom, panX, panY) {
    const z = Number(zoom) > 100 ? Number(zoom) : 100;
    const w = Math.max(4, Math.min(sw, Math.round(sw * 100 / z / 4) * 4));
    const h = Math.max(2, Math.min(sh, Math.round(sh * 100 / z / 2) * 2));
    let x = Math.round((sw - w) / 2 + sw * (Number(panX) || 0) / 100);
    let y = Math.round((sh - h) / 2 + sh * (Number(panY) || 0) / 100);
    x = Math.max(0, Math.min(sw - w, x)) & ~1;
    y = Math.max(0, Math.min(sh - h, y)) & ~1;
    return { x: x, y: y, w: w, h: h };
}

/**
 * Resample a window of a 4:2:0 atlas into a dw x dh atlas. Nearest neighbour:
 * a map is roads and text, not a photograph, and the head unit has no cycles
 * for a filter here. dw must be a multiple of four and dh even, as cluster-
 * render requires; the window zoomWindow() returns is already aligned.
 * At 1:1 with the full window this is a plain copy, so the cluster's default
 * view costs nothing extra.
 */
function scaleAtlas(src, sw, sh, win, dw, dh, out) {
    const need = atlasSize(dw, dh);
    /* The source must hold the whole sw x sh picture, not the dw x dh output:
     * a zoom window is a cut of the source, so a smaller output is fed by a
     * full-size source and checking src against the output would misjudge it
     * (and a larger output would pass a source that is in fact too small). */
    if (dw < 4 || dh < 2 || !src || src.length < atlasSize(sw, sh)) return null;
    const a = out && out.length === need ? out : Buffer.alloc(need);
    const du = dw * dh, su = sw * sh;
    const chw = dw >> 1, chh = dh >> 1;
    const swin = win.w >> 1, shwin = win.h >> 1;
    const cx = win.x >> 1, cy = win.y >> 1, shw = sw >> 1;
    for (let y = 0; y < dh; y++) {
        const sy = win.y + Math.floor(y * win.h / dh);
        const s = sy * sw + win.x, d = y * dw;
        for (let x = 0; x < dw; x++) a[d + x] = src[s + Math.floor(x * win.w / dw)];
    }
    for (let y = 0; y < chh; y++) {
        const sy = cy + Math.floor(y * shwin / chh);
        const s = su + sy * sw, d = du + y * dw;
        for (let x = 0; x < chw; x++) {
            const sx = cx + Math.floor(x * swin / chw);
            a[d + x] = src[s + sx];                    // U, left half of the row
            a[d + chw + x] = src[s + shw + sx];        // V, right half
        }
    }
    return a;
}

/** Fill a triangle in the Y plane. Used for arrow heads, which have to look
 * like an arrow and not like a box. */
function fillTri(a, w, h, x0, y0, x1, y1, x2, y2, value) {
    const minY = Math.max(0, Math.floor(Math.min(y0, y1, y2)));
    const maxY = Math.min(h - 1, Math.ceil(Math.max(y0, y1, y2)));
    const e = [[x0, y0, x1, y1], [x1, y1, x2, y2], [x2, y2, x0, y0]];
    for (let y = minY; y <= maxY; y++) {
        const xs = [];
        for (let i = 0; i < 3; i++) {
            const ax = e[i][0], ay = e[i][1], bx = e[i][2], by = e[i][3];
            if ((ay <= y && by > y) || (by <= y && ay > y)) {
                xs.push(ax + (y - ay) * (bx - ax) / (by - ay));
            }
        }
        if (xs.length < 2) continue;
        const lo = Math.max(0, Math.round(Math.min(xs[0], xs[1])));
        const hi = Math.min(w - 1, Math.round(Math.max(xs[0], xs[1])));
        if (hi >= lo) fillY(a, w, h, lo, y, hi - lo + 1, 1, value);
    }
}

/** A thick line, laid down as a run of square brushes: lane arrows turn at
 * angles that pixel rectangles cannot follow. */
function lineThick(a, w, h, x0, y0, x1, y1, t, value) {
    const dx = x1 - x0, dy = y1 - y0;
    const steps = Math.max(2, Math.round(Math.max(Math.abs(dx), Math.abs(dy))));
    const half = t >> 1;
    for (let i = 0; i <= steps; i++) {
        fillY(a, w, h,
            Math.round(x0 + dx * i / steps) - half,
            Math.round(y0 + dy * i / steps) - half, t, t, value);
    }
}

/** A ring, for the speed limit sign. */
function fillRing(a, w, h, cx, cy, rOut, thick, value) {
    const rIn = Math.max(0, rOut - thick);
    for (let y = -rOut; y <= rOut; y++) {
        const yy = cy + y;
        if (yy < 0 || yy >= h) continue;
        const outer = Math.round(Math.sqrt(rOut * rOut - y * y));
        if (Math.abs(y) >= rIn) {
            fillY(a, w, h, cx - outer, yy, outer * 2 + 1, 1, value);
            continue;
        }
        const inner = Math.round(Math.sqrt(rIn * rIn - y * y));
        fillY(a, w, h, cx - outer, yy, outer - inner, 1, value);
        fillY(a, w, h, cx + inner + 1, yy, outer - inner, 1, value);
    }
}

/**
 * One lane's arrow, inside a box.
 *
 * `type` is what the lane does, in the words a guidance strip uses: straight,
 * left, right, slight-left, slight-right, uturn, or left-straight /
 * right-straight for a lane that goes two ways. A driver reads these at a
 * glance, so each is the ordinary icon and nothing clever.
 */
function laneGlyph(a, w, h, x, y, bw, bh, type, value) {
    const t = Math.max(3, Math.round(bh * 0.15));
    const half = t >> 1;
    const cx = x + (bw >> 1);
    /* The brush is t wide and centred on the path, so the path has to stay
     * half a brush inside the box or the arrow bleeds over the card's edge. */
    const top = y + half, bottom = y + bh - 1 - half;
    const midY = y + Math.round(bh * 0.50);
    const headLen = Math.max(5, Math.round(bh * 0.26));
    const headHalf = Math.max(4, Math.round(headLen * 0.62));

    switch (type) {
    case 'straight':
        lineThick(a, w, h, cx, bottom, cx, top + headLen, t, value);
        fillTri(a, w, h, cx, top, cx - headHalf, top + headLen,
            cx + headHalf, top + headLen, value);
        break;
    case 'left':
    case 'right': {
        const s = type === 'left' ? -1 : 1;
        const hl = Math.max(4, Math.round(Math.min(bh * 0.30, bw * 0.34)));
        const arm = Math.max(2, (bw >> 1) - hl);
        lineThick(a, w, h, cx, bottom, cx, midY, t, value);
        lineThick(a, w, h, cx, midY, cx + s * arm, midY, t, value);
        fillTri(a, w, h, cx + s * (arm + hl), midY,
            cx + s * arm, midY - headHalf, cx + s * arm, midY + headHalf, value);
        break;
    }
    case 'slight-left':
    case 'slight-right': {
        const s = type === 'slight-left' ? -1 : 1;
        const shear = Math.round(bh * 0.20) * s;
        const rows = bottom - (top + headLen);
        for (let i = 0; i <= rows; i++) {
            const off = Math.round(shear * i / Math.max(1, rows));
            fillY(a, w, h, cx - (t >> 1) + off, bottom - i, t, 1, value);
        }
        const hx = cx + shear;
        fillTri(a, w, h, hx + Math.round(shear * 0.45), top,
            hx - headHalf, top + headLen, hx + headHalf, top + headLen, value);
        break;
    }
    case 'uturn': {
        const arm = Math.min(Math.round(bw * 0.32), Math.round(bw / 2) - headHalf - 1);
        const elbow = y + Math.round(bh * 0.34);
        const down = midY + Math.round(bh * 0.20);
        lineThick(a, w, h, cx, bottom, cx, elbow, t, value);
        lineThick(a, w, h, cx, elbow, cx - arm, elbow, t, value);
        lineThick(a, w, h, cx - arm, elbow, cx - arm, down, t, value);
        fillTri(a, w, h, cx - arm, down + headLen, cx - arm - headHalf, down,
            cx - arm + headHalf, down, value);
        break;
    }
    case 'left-straight':
    case 'right-straight': {
        const s = type === 'left-straight' ? -1 : 1;
        const arm = Math.min(Math.round(bw * 0.30), Math.round(bw / 2) - headLen - 1);
        const armY = y + Math.round(bh * 0.44);
        lineThick(a, w, h, cx, bottom, cx, top + headLen, t, value);
        fillTri(a, w, h, cx, top, cx - headHalf, top + headLen,
            cx + headHalf, top + headLen, value);
        lineThick(a, w, h, cx, armY, cx + s * arm, armY, t, value);
        fillTri(a, w, h, cx + s * (arm + headLen), armY,
            cx + s * arm, armY - headHalf, cx + s * arm, armY + headHalf, value);
        break;
    }
    default:
        break;
    }
}

/**
 * The turn card: the arrow, the distance to it, and, when there is room, the
 * lane guidance and the speed limit.
 *
 * This is what a HUD is for. A projected HUD shows roughly 560x200 of glass a
 * metre in front of the driver, at a focal distance where a map is unreadable
 * but a single arrow is obvious - the stock head unit draws exactly this for
 * its own navigation, and so does CarPlay. Feeding the HUD a shrunken map,
 * which is what this app did before, works against the hardware.
 *
 * `detail` decides how much of it appears, because a HUD that says too much
 * says nothing:
 *
 *   minimal   the arrow and the distance
 *   standard  ... and the road name
 *   full      ... and the lane guidance and the speed limit
 *
 * Drawn here, on the head unit, so the shape can be judged on the car before
 * any decoder exists: with `Picture source = Test picture` the card is shown
 * and the settings move it. It is not used by the camera view itself, which
 * crops its picture rather than drawing anything.
 *
 * `dir` is a lane glyph type; `lanes` is an array of them with `active` naming
 * the lane to take; `limit` is a speed limit in km/h or null.
 */
function arrowAtlas(out, w, h, tick, opt) {
    const need = atlasSize(w, h);
    const a = out && out.length === need ? out : Buffer.alloc(need);
    a.fill(16, 0, w * h);
    a.fill(128, w * h);

    const o = opt || {};
    const dir = o.dir || 'left';
    const detail = o.detail === 'standard' || o.detail === 'minimal' ? o.detail : 'full';
    const lanes = detail === 'full' && Array.isArray(o.lanes) && o.lanes.length ? o.lanes : [];
    const limit = detail === 'full' && o.limit ? String(o.limit) : '';

    const pad = Math.max(6, Math.round(h * 0.06));
    const laneH = lanes.length ? Math.round(h * 0.27) : 0;
    const mainH = h - laneH;

    /* The arrow owns a square on the left; the text sits to its right. */
    const side = Math.min(mainH - pad, Math.round(w * 0.30));
    laneGlyph(a, w, h, pad, Math.round((mainH - side) / 2), side, side, dir, 238);

    const ringR = limit ? Math.min(Math.round(mainH * 0.20), 26) : 0;
    const ringCx = w - pad - ringR;
    const textRight = limit ? ringCx - ringR - pad : w - pad;
    const tx = pad + side + Math.round(w * 0.055);

    /* The distance is the one number that matters, so it is as large as the
     * space allows and the unit hangs off its shoulder. */
    const kd0 = detail === 'minimal' ? 0.46 : 0.34;
    let kd = Math.max(3, Math.round((mainH * kd0) / 7));
    const dist = o.dist || '300';
    const unit = o.unit === '' ? '' : (o.unit || 'M');
    let wDist = charWidth(dist, kd) + (unit ? 8 + charWidth(unit, 3) : 0);
    while (kd > 3 && tx + wDist > textRight) {
        kd--;
        wDist = charWidth(dist, kd) + (unit ? 8 + charWidth(unit, 3) : 0);
    }
    const roadScale = 3;
    const hasRoad = detail !== 'minimal';
    const blockH = 7 * kd + (hasRoad ? Math.round(h * 0.10) + 7 * roadScale : 0);
    const ty = Math.round((mainH - blockH) / 2);

    const end = drawText(a, w, h, tx, ty, dist, kd, 236);
    if (unit) drawText(a, w, h, end + 8, ty + 7 * kd - 21, unit, roadScale, 190);
    if (hasRoad) {
        const ry = ty + 7 * kd + Math.round(h * 0.10);
        let road = o.road || 'CHANGAN AVE';
        const room = Math.floor((textRight - tx + roadScale) / (6 * roadScale));
        if (road.length > room) road = road.slice(0, Math.max(0, room));
        drawText(a, w, h, tx, ry, road, roadScale, 150);
    }

    if (limit) {
        fillRing(a, w, h, ringCx, Math.round(mainH / 2), ringR, Math.max(3, (ringR / 6) | 0), 210);
        let ks = ringR >= 22 ? 3 : 2;
        const inner = 2 * (ringR - Math.max(3, (ringR / 6) | 0)) - 4;
        while (ks > 1 && charWidth(limit, ks) > inner) ks--;
        const lw = charWidth(limit, ks);
        drawText(a, w, h, ringCx - (lw >> 1), Math.round(mainH / 2) - (7 * ks >> 1),
            limit, ks, 232);
    }

    if (lanes.length) {
        /* A hairline separates the lanes from the words: without it a five-lane
         * row reads as part of the road name. It stops at the last lane so it
         * does not run under the speed limit. */
        const ruleW = Math.min(textRight - tx + 8,
            Math.floor((textRight - tx) / lanes.length) * lanes.length);
        fillY(a, w, h, tx - 4, mainH, ruleW, 1, 45);

        const bandY = mainH + Math.round(laneH * 0.10);
        const bh = laneH - Math.round(laneH * 0.34);
        const avail = textRight - tx;
        const cellW = Math.floor(avail / lanes.length);
        const bw = Math.min(cellW - 8, Math.round(bh * 1.2));
        const active = Number(o.active);
        for (let i = 0; i < lanes.length; i++) {
            const cx = tx + i * cellW + (cellW >> 1);
            /* The lane to take is the bright one; the rest are dimmed, not
             * hidden. Brightness is the only channel a monochrome projection
             * has, and it is enough: the eye lands on the lit arrow. */
            const on = i === active;
            laneGlyph(a, w, h, cx - (bw >> 1), bandY, bw, bh, lanes[i], on ? 245 : 108);
        }
    }

    return a;
}

/**
 * Build a moving, map-like test picture directly in the atlas.
 * `out` may be a reused buffer of the exact size; otherwise one is made.
 * `tick` is a frame counter, so the roads scroll and a marker moves.
 */
function demoAtlas(out, w, h, tick) {
    const need = atlasSize(w, h);
    const a = out && out.length === need ? out : Buffer.alloc(need);
    a.fill(24, 0, w * h);       // dark background
    a.fill(128, w * h);         // neutral chroma everywhere

    // A park block and a water block, to make chroma errors visible.
    fillUV(a, w, h, 70, 44, 240, 150, 92, 100);
    fillUV(a, w, h, 710, 285, 320, 145, 188, 72);

    // Static street grid. The whole atlas is sent each frame, but the service
    // uploads only changed 64x64 tiles against the shared 5500 KB/s budget:
    // a scrolling grid would dirty every tile. Only the marker below moves.
    for (let x = 0; x < w; x += 96) fillY(a, w, h, x, 0, 5, h, 174);
    for (let y = 0; y < h; y += 96) fillY(a, w, h, 0, y, w, 5, 174);

    // The main road across the middle, brighter.
    const mid = h >> 1;
    fillY(a, w, h, 0, mid - 7, w, 14, 206);

    // A moving marker following the main road.
    const mx = (tick * 9) % (w - 48) + 24;
    fillY(a, w, h, mx, mid - 8, 26, 16, 236);
    fillUV(a, w, h, mx, mid - 8, 26, 16, 74, 204);

    return a;
}

/* 5x7 dot-matrix glyphs. The KOMBI's GPU converts YUV to RGB but there is no
 * text drawing on a video layer, and the atlas is the only thing we can write:
 * so numbers are drawn as dots here. Only what the activity picture says. */
const GLYPH = {
    '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
    '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
    '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
    '3': ['11111', '00010', '00100', '00010', '00001', '10001', '01110'],
    '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
    '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
    '6': ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
    '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
    '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
    '9': ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
    '.': ['00000', '00000', '00000', '00000', '00000', '01100', '01100'],
    '/': ['00001', '00001', '00010', '00100', '01000', '10000', '10000'],
    'A': ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
    'B': ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
    'C': ['01110', '10001', '10000', '10000', '10000', '10001', '01110'],
    'D': ['11100', '10010', '10001', '10001', '10001', '10010', '11100'],
    'E': ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
    'F': ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
    'G': ['01110', '10001', '10000', '10111', '10001', '10001', '01111'],
    'H': ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
    'I': ['01110', '00100', '00100', '00100', '00100', '00100', '01110'],
    'J': ['00111', '00010', '00010', '00010', '00010', '10010', '01100'],
    'K': ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
    'L': ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
    'M': ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
    'N': ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
    'O': ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
    'P': ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
    'Q': ['01110', '10001', '10001', '10001', '10101', '10010', '01101'],
    'R': ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
    'S': ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
    'T': ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
    'U': ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
    'V': ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
    'W': ['10001', '10001', '10001', '10101', '10101', '11011', '10001'],
    'X': ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
    'Y': ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
    'Z': ['11111', '00001', '00010', '00100', '01000', '10000', '11111'],
    ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000']
};

function charWidth(s, scale) { return s.length * 6 * scale - scale; }

/**
 * The biggest face a string may be drawn in without leaving the picture.
 *
 * The waiting page's size comes from a setting, and a setting can be set to
 * 600%: the glyphs would simply be clipped by the edge of the buffer and the
 * line would end mid-word, which looks like a bug rather than a choice. So the
 * requested size is a wish, and the picture is the limit.
 */
function fitScale(s, w, want) {
    const room = Math.floor((w * 0.94) / Math.max(1, s.length * 6));
    return Math.max(1, Math.min(Math.max(1, Math.round(want)), Math.max(1, room)));
}

/** The waiting text's size and place, as the app's settings describe them:
 * `scale` in percent of the default face, `x`/`y` in percent of the picture.
 * Absent settings mean "as designed", so every caller may pass nothing. */
function textOpt(o) {
    const pct = o && Number(o.scale) > 0 ? Number(o.scale) : 100;
    return {
        k: pct / 100,
        dx: ((o && Number(o.x)) || 0) / 100,
        dy: ((o && Number(o.y)) || 0) / 100
    };
}

function drawText(a, w, h, x, y, s, scale, value, chroma) {
    let cx = x;
    for (let i = 0; i < s.length; i++) {
        const g = GLYPH[s[i]] || GLYPH[' '];
        for (let r = 0; r < 7; r++) {
            const row = g[r];
            for (let c = 0; c < 5; c++) {
                if (row[c] !== '1') continue;
                fillY(a, w, h, cx + c * scale, y + r * scale, scale, scale, value);
            }
        }
        if (chroma) fillUV(a, w, h, cx, y, 5 * scale, 7 * scale, chroma[0], chroma[1]);
        cx += 6 * scale;
    }
    return cx;
}

/**
 * What is shown while the camera's stream arrives but cannot be decoded yet.
 *
 * The camera sends H.264 and the head unit has no decoder in this build, so
 * the real picture is not available. Drawing nothing would look exactly like a
 * broken pipeline, and that is the one thing this picture must not look like:
 * it prints the bytes and frames the receiver has already delivered, and a
 * marker that moves only when data is still coming. If the numbers climb, the
 * whole path from the camera ECU to the cluster works and only the decoder is
 * missing.
 *
 * `mb` megabytes seen, `idr` keyframes seen, `mbps` recent rate, `tick` frame
 * counter (the marker's position).
 */
function activityAtlas(out, w, h, tick, mb, idr, mbps) {
    const need = atlasSize(w, h);
    const a = out && out.length === need ? out : Buffer.alloc(need);
    a.fill(20, 0, w * h);
    a.fill(128, w * h);
    fillUV(a, w, h, 0, 0, w, 10, 128, 128);

    /* A moving marker on the very top: motion is the proof of live data. */
    const mx = (tick * 11) % (w - 40);
    fillY(a, w, h, mx, 6, 40, 6, 235);

    drawText(a, w, h, 40, 44, 'CAMERA LIVE', 4, 210);
    drawText(a, w, h, 40, 110, 'H.264 STREAM', 3, 150);

    const mbs = mb.toFixed(1);
    let x = drawText(a, w, h, 40, 190, mbs, 11, 236);
    drawText(a, w, h, x + 24, 190 + 44, 'MB', 4, 180);

    x = drawText(a, w, h, 40, 340, String(idr), 8, 236);
    drawText(a, w, h, x + 20, 340 + 28, 'IDR', 4, 180);

    const rate = mbps.toFixed(1) + ' MB/S';
    drawText(a, w, h, w - 40 - charWidth(rate, 4), 190 + 44, rate, 4, 180);

    /* Bottom strip: a level meter of the last second's rate, 0..4 MB/s. */
    const lv = clamp(Math.round(mbps / 4 * (w - 80)), 0, w - 80);
    fillY(a, w, h, 40, h - 40, w - 80, 6, 60);
    fillY(a, w, h, 40, h - 40, lv, 6, 236);
    fillUV(a, w, h, 40, h - 40, w - 80, 6, 90, 160);
    return a;
}

/**
 * The card's placeholder while the camera's stream arrives but cannot be
 * decoded, and while it has not started arriving at all.
 *
 * activityAtlas is laid out for the cluster's 1088x480 and its lower half would
 * fall off a 480x168 card, so the card gets its own: the same proof - a marker
 * that moves only while bytes are still coming - in three short lines instead
 * of six.
 *
 * The face is about a third of the cluster's. At five and nine, "WAITING FOR
 * CAMERA" covered the card once the HUD scaled the card up again; two and
 * three leave the car's own speed and limit sign alone. `opt` is the app's own
 * idea of how big and where (see textOpt), so it can be changed without a
 * rebuild. `mb` is kept for the card's own stream; a `note` from the app wins
 * because it says why the map is empty rather than merely how much came in.
 */
function liveCardAtlas(out, w, h, tick, mb, opt, note) {
    const need = atlasSize(w, h);
    const a = out && out.length === need ? out : Buffer.alloc(need);
    a.fill(20, 0, w * h);
    a.fill(128, w * h);
    const o = textOpt(opt);

    const s1 = 'WAITING FOR';
    const k1 = fitScale(s1, w, 2 * o.k);
    drawText(a, w, h, Math.round((w - charWidth(s1, k1)) / 2 + w * o.dx),
        Math.round(h * 0.14 + h * o.dy), s1, k1, 150);
    const s2 = 'CAMERA';
    const k2 = fitScale(s2, w, 3 * o.k);
    drawText(a, w, h, Math.round((w - charWidth(s2, k2)) / 2 + w * o.dx),
        Math.round(h * 0.34 + h * o.dy), s2, k2, 225);

    /* One short line under it, whatever it is: the app's reason on the map's
     * HUD, megabytes on the card's own stream. Truncated to what the card can
     * hold rather than clipped by its edge. */
    const line = note || (typeof mb === 'number' ? mb.toFixed(1) + ' MB' : mb);
    if (line) {
        const k = fitScale('X', w, 2 * o.k);
        const room = Math.max(1, Math.floor((w * 0.94) / (6 * k)));
        const txt = String(line).toUpperCase().replace(/[^A-Z0-9 ./:-]/g, ' ').slice(0, room);
        drawText(a, w, h, Math.round((w - charWidth(txt, k)) / 2 + w * o.dx),
            Math.round(h * 0.62 + h * o.dy), txt, k, 170);
    }

    const mx = (tick * 7) % Math.max(1, w - 60);
    fillY(a, w, h, mx, Math.round(h - 14), 60, 6, 238);
    return a;
}

/**
 * What is shown while the camera view is selected but nothing is arriving.
 *
 * An empty layer and a broken layer look the same on the cluster: black. This
 * says which one it is, and the blinking dot says the app is alive rather than
 * stuck - without it, "waiting" and "crashed" are the same picture.
 *
 * `note` is one short line under the big words, and it is the whole point of
 * the page: "waiting" is true of a camera that never sent, of a decoder that
 * never started and of frames that arrive at the wrong size, and those are
 * three different things to do. Whoever knows which one it is passes it
 * in; an empty note keeps the page as it was.
 *
 * `opt` carries the size and the place from the app's settings (textOpt). The
 * cluster's page is large on purpose - it is the one picture a driver sees
 * without looking down - so 100% is the size it always had; a HUD card drawn
 * by liveCardAtlas starts a third of that.
 */
function waitingAtlas(out, w, h, tick, note, opt) {
    const need = atlasSize(w, h);
    const a = out && out.length === need ? out : Buffer.alloc(need);
    a.fill(18, 0, w * h);
    a.fill(128, w * h);
    const o = textOpt(opt);

    const s1 = 'WAITING FOR', k1 = fitScale(s1, w, 5 * o.k);
    drawText(a, w, h, Math.round((w - charWidth(s1, k1)) / 2 + w * o.dx),
        Math.round(h * 0.20 + h * o.dy), s1, k1, 150);
    const s2 = 'CAMERA', k2 = fitScale(s2, w, 9 * o.k);
    drawText(a, w, h, Math.round((w - charWidth(s2, k2)) / 2 + w * o.dx),
        Math.round(h * 0.40 + h * o.dy), s2, k2, 225);

    /* Drawn in a smaller face than the title: it is a diagnosis, not a
     * headline, and it has to fit on one line at 1088 pixels. */
    if (note) {
        const k = fitScale('X', w, 3 * o.k);
        const room = Math.max(1, Math.floor((w * 0.94) / (6 * k)));
        const txt = String(note).toUpperCase().replace(/[^A-Z0-9 ./:-]/g, ' ').slice(0, room);
        drawText(a, w, h, Math.round((w - charWidth(txt, k)) / 2 + w * o.dx),
            Math.round(h * 0.62 + h * o.dy), txt, k, 236);
    }

    const n = tick % 3;
    for (let i = 0; i < 3; i++) {
        const x = Math.round(w / 2 - 82 + i * 70 + w * o.dx);
        fillY(a, w, h, x, Math.round(h * 0.80 + h * o.dy), 24, 24, i === n ? 235 : 70);
    }
    return a;
}

module.exports = { MAP_W, MAP_H, atlasSize, cropAtlas, zoomWindow, scaleAtlas, demoAtlas, arrowAtlas,
    activityAtlas, liveCardAtlas, waitingAtlas, fitScale, textOpt };
