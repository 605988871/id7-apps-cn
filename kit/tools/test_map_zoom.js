'use strict';
/**
 * The two new pieces in the map path: the window a zoom picks out of the
 * decoder's atlas, and the resampling of that window into a layer-sized frame.
 *
 *   node kit/tools/test_map_zoom.js
 *
 * What is checked: 100% keeps the whole map (so the HUD stops showing a blown-
 * up corner), a larger zoom takes a smaller centred window, pan moves it only
 * when there is room, the window stays even and inside the source, and the
 * output is a well-formed 4:2:0 atlas whose U and V come from the right halves
 * of the source rows.
 */
const assert = require('assert');
const path = require('path');
const { atlasSize, zoomWindow, scaleAtlas, MAP_W, MAP_H } = require(path.join(__dirname, '..', '..', 'apps', 'cn_carlife_map', 'atlas'));

/* 100% = the whole picture, centred, pan has no room. */
{
    const w = zoomWindow(MAP_W, MAP_H, 100, 0, 0);
    assert.deepStrictEqual(w, { x: 0, y: 0, w: MAP_W, h: MAP_H }, '100% is not the whole map');
    const p = zoomWindow(MAP_W, MAP_H, 100, 40, 40);
    assert.deepStrictEqual(p, { x: 0, y: 0, w: MAP_W, h: MAP_H }, 'pan moved a window with no room');
}

/* 200% = a quarter of the map, centred; 400% smaller still. */
{
    const w2 = zoomWindow(MAP_W, MAP_H, 200, 0, 0);
    assert.strictEqual(w2.w, MAP_W / 2, '200% width');
    assert.strictEqual(w2.h, MAP_H / 2, '200% height');
    assert.strictEqual(w2.x, (MAP_W - w2.w) / 2, '200% centred x');
    assert.strictEqual(w2.y, (MAP_H - w2.h) / 2, '200% centred y');
    const w4 = zoomWindow(MAP_W, MAP_H, 400, 0, 0);
    assert.strictEqual(w4.w, MAP_W / 4, '400% width');
    assert.strictEqual(w4.h, MAP_H / 4, '400% height');
}

/* Every window: even offsets, w multiple of four, h even, inside the map.
 * This is the contract scaleAtlas and cluster-render both rely on. */
for (const zoom of [100, 110, 125, 150, 175, 200, 250, 300, 400]) {
    for (const pan of [-40, -20, 0, 20, 40]) {
        const w = zoomWindow(MAP_W, MAP_H, zoom, pan, pan);
        assert.strictEqual(w.x % 2, 0, 'odd x at ' + zoom + '/' + pan);
        assert.strictEqual(w.y % 2, 0, 'odd y at ' + zoom + '/' + pan);
        assert.strictEqual(w.w % 4, 0, 'w not multiple of four at ' + zoom);
        assert.strictEqual(w.h % 2, 0, 'odd h at ' + zoom);
        assert.ok(w.x >= 0 && w.y >= 0 && w.x + w.w <= MAP_W && w.y + w.h <= MAP_H,
            'window outside map at ' + zoom + '/' + pan);
    }
}

/* Pan at 200% moves the window right and stays inside. */
{
    const base = zoomWindow(MAP_W, MAP_H, 200, 0, 0);
    const right = zoomWindow(MAP_W, MAP_H, 200, 40, 0);
    assert.ok(right.x > base.x, 'pan right did not move the window');
    assert.strictEqual(right.y, base.y, 'pan x moved y');
    assert.ok(right.x + right.w <= MAP_W, 'pan pushed the window out');
}

/* A source whose luma is a left-to-right ramp and whose U/V are distinct
 * constants. Downscaling the full map to HUD size must keep those colours:
 * U in the left half of each chroma row, V in the right. */
function rampAtlas(sw, sh) {
    const b = Buffer.alloc(atlasSize(sw, sh));
    for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) b[y * sw + x] = 16 + Math.round(219 * x / (sw - 1));
    const cw = sw >> 1;
    for (let r = 0; r < (sh >> 1); r++) {
        b.fill(90, sw * sh + r * sw, sw * sh + r * sw + cw);
        b.fill(240, sw * sh + r * sw + cw, sw * sh + (r + 1) * sw);
    }
    return b;
}

{
    const src = rampAtlas(MAP_W, MAP_H);
    const dw = 240, dh = 104;
    const out = scaleAtlas(src, MAP_W, MAP_H, zoomWindow(MAP_W, MAP_H, 100, 0, 0), dw, dh);
    assert.strictEqual(out.length, atlasSize(dw, dh), 'output atlas length');
    /* Luma: left edge dark, right edge bright - i.e. a downscale, not a crop. */
    assert.ok(out[0] < 60, 'left luma not dark: ' + out[0]);
    assert.ok(out[dw - 1] > 200, 'right luma not bright: ' + out[dw - 1]);
    /* Chroma planes intact. */
    const du = dw * dh, chw = dw >> 1, chh = dh >> 1;
    for (let r = 0; r < chh; r++) {
        assert.strictEqual(out[du + r * dw], 90, 'U at row ' + r);
        assert.strictEqual(out[du + r * dw + chw], 240, 'V at row ' + r);
    }
    /* The same buffer can be reused without growing. */
    assert.strictEqual(scaleAtlas(src, MAP_W, MAP_H, zoomWindow(MAP_W, MAP_H, 100, 0, 0), dw, dh, out), out,
        'output buffer not reused');
}

/* Zoom 200% into the left half really shows the left half: its window starts
 * at x 0 and the sampled luma rises from dark to mid, never reaching bright. */
{
    const src = rampAtlas(MAP_W, MAP_H);
    const win = zoomWindow(MAP_W, MAP_H, 200, -40, 0);
    const dw = 240, dh = 104;
    const out = scaleAtlas(src, MAP_W, MAP_H, win, dw, dh);
    assert.strictEqual(win.x, 0, 'left pan clamped to the edge');
    assert.ok(out[0] < 60, 'zoomed left luma dark');
    assert.ok(out[dw - 1] < 140, 'zoomed left should not reach full bright: ' + out[dw - 1]);
}

/* A short source is refused rather than read past its end. */
{
    assert.strictEqual(scaleAtlas(Buffer.alloc(10), MAP_W, MAP_H, { x: 0, y: 0, w: MAP_W, h: MAP_H }, 240, 104), null,
        'short atlas accepted');
}

console.log('map_zoom ok: windows, pan, resample, chroma planes');
