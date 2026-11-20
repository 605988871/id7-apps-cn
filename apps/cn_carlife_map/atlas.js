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
 * What is shown while CarLife's stream arrives but cannot be decoded yet.
 *
 * CarLife sends H.264 and the head unit has no decoder in this build, so the
 * real picture is not available. Drawing nothing would look exactly like a
 * broken pipeline, and that is the one thing this picture must not look like:
 * it prints the bytes and frames the capture side has already delivered, and a
 * marker that moves only when data is still coming. If the numbers climb, the
 * whole path from USB to the cluster works and only the decoder is missing.
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

    drawText(a, w, h, 40, 44, 'CARLIFE LIVE', 4, 210);
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
 * What is shown while CarLife is selected but nothing is arriving yet.
 *
 * An empty layer and a broken layer look the same on the cluster: black. This
 * says which one it is, and the blinking dot says the app is alive rather than
 * stuck - without it, "waiting" and "crashed" are the same picture.
 */
function waitingAtlas(out, w, h, tick) {
    const need = atlasSize(w, h);
    const a = out && out.length === need ? out : Buffer.alloc(need);
    a.fill(18, 0, w * h);
    a.fill(128, w * h);

    const s1 = 'WAITING FOR', k1 = 5;
    drawText(a, w, h, Math.round((w - charWidth(s1, k1)) / 2), Math.round(h * 0.20), s1, k1, 150);
    const s2 = 'CARLIFE', k2 = 9;
    drawText(a, w, h, Math.round((w - charWidth(s2, k2)) / 2), Math.round(h * 0.40), s2, k2, 225);

    const n = tick % 3;
    for (let i = 0; i < 3; i++) {
        const x = Math.round(w / 2 - 82 + i * 70);
        fillY(a, w, h, x, Math.round(h * 0.80), 24, 24, i === n ? 235 : 70);
    }
    return a;
}

module.exports = { MAP_W, MAP_H, atlasSize, cropAtlas, demoAtlas, activityAtlas, waitingAtlas };
