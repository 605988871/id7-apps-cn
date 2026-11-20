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

module.exports = { MAP_W, MAP_H, atlasSize, demoAtlas };
