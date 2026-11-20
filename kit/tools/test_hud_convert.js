'use strict';
/**
 * The HUD's picture path and the two readings of cluster-render's status text,
 * checked without a renderer.
 *
 *   node kit/tools/test_hud_convert.js
 *
 * What is checked: that a 4:2:0 atlas becomes the colour it stands for (grey,
 * black, white, and a saturated pair that a swapped U and V would turn blue
 * instead of red), that chroma is shared by the 2x2 block it belongs to, that a
 * short buffer is refused instead of read past, and that the status lines are
 * matched for the target they name - a "layer 7 video ... on map" read as the
 * HUD's would send someone to the wrong end of the problem.
 */

const assert = require('assert');
const path = require('path');
const { toRgba, parseTarget, parseLayer } = require(path.join(__dirname, '..', '..', 'apps', 'cn_carlife_map', 'hud_convert'));

/* An independent BT.601 conversion, written the slow obvious way, so that a
 * mistake in the lookup tables has something to disagree with. */
function ref(y, u, v) {
    const c = (x) => (x < 0 ? 0 : x > 255 ? 255 : Math.round(x));
    const Y = 1.164383 * (y - 16), U = u - 128, V = v - 128;
    return [c(Y + 1.596027 * V), c(Y - 0.391762 * U - 0.812968 * V), c(Y + 2.017232 * U), 255];
}

function atlas(w, h, y, u, v) {
    const b = Buffer.alloc(w * h * 3 / 2);
    b.fill(y, 0, w * h);
    const cw = w >> 1;
    for (let r = 0; r < (h >> 1); r++) {
        b.fill(u, w * h + r * w, w * h + r * w + cw);
        b.fill(v, w * h + r * w + cw, w * h + (r + 1) * w);
    }
    return b;
}

const W = 8, H = 4;

/* Grey: Y 126 with the chroma planes at 128 makes no colour at all - 128 not
 * 126, because the limited range starts at 16 and is stretched out again. */
{
    const out = toRgba(atlas(W, H, 126, 128, 128), W, H, Buffer.alloc(W * H * 4));
    for (let i = 0; i < W * H; i++) {
        assert.strictEqual(out[i * 4], 128, 'grey red at ' + i);
        assert.strictEqual(out[i * 4], out[i * 4 + 1], 'grey is not neutral at ' + i);
        assert.strictEqual(out[i * 4 + 1], out[i * 4 + 2], 'grey is not neutral at ' + i);
        assert.strictEqual(out[i * 4 + 3], 255, 'alpha at ' + i);
    }
}

/* The ends of the range, and the two colours a swapped U and V would swap. */
for (const [y, u, v] of [[16, 128, 128], [235, 128, 128], [81, 90, 240], [145, 54, 34], [0, 0, 0], [255, 255, 255]]) {
    const out = toRgba(atlas(W, H, y, u, v), W, H, Buffer.alloc(W * H * 4));
    const want = ref(y, u, v);
    for (let c = 0; c < 4; c++) {
        assert.ok(Math.abs(out[c] - want[c]) <= 1,
            'Y' + y + ' U' + u + ' V' + v + ' channel ' + c + ': ' + out[c] + ' vs ' + want[c]);
    }
}

/* A red bar has to come out red, not blue: the one mistake that is invisible in
 * code and obvious on a HUD. */
{
    const out = toRgba(atlas(W, H, 81, 90, 240), W, H, Buffer.alloc(W * H * 4));
    assert.ok(out[0] > 200 && out[2] < 60, 'red came out as rgb(' + out[0] + ',' + out[1] + ',' + out[2] + ')');
}

/* Chroma belongs to a 2x2 block: the four pixels of a block are one colour,
 * and the next block is another. An off-by-one here shifts every colour half a
 * block to the left, which reads as a decoder fault. */
{
    const b = atlas(W, H, 126, 128, 128);
    const cw = W >> 1;
    b[W * H + 0] = 255;          /* U of block (0,0) only: strongly blue */
    const out = toRgba(b, W, H, Buffer.alloc(W * H * 4));
    const at = (x, y) => [out[(y * W + x) * 4], out[(y * W + x) * 4 + 2]];
    /* Blue: the blue channel well clear of the red one. U alone cannot reach a
     * saturated blue at grey luma - it lands on rgb(128, 78, 255) - so this
     * compares the two channels rather than looking for 0,0,255. */
    const blue = (x, y) => at(x, y)[1] - at(x, y)[0] > 60;
    assert.ok(blue(0, 0) && blue(1, 1), 'the block the U byte belongs to is not blue');
    assert.ok(!blue(2, 0) && !blue(0, 2), 'the next block took the same U byte');
    assert.strictEqual(cw, 4);
}

/* A buffer that cannot hold the picture is refused, not read past. */
{
    assert.strictEqual(toRgba(Buffer.alloc(10), W, H, Buffer.alloc(W * H * 4)), null, 'short atlas accepted');
    assert.strictEqual(toRgba(atlas(W, H, 126, 128, 128), W, H, Buffer.alloc(4)), null, 'short output accepted');
}

/* Real status text, as the service writes it (PROTOCOL.md "status"). */
const STATUS = [
    'upload: cap 3800 KB/s (ceiling 3800, floor 200): healthy',
    'target map: slot 0x203 scene 0x1000300 1088x480: shown (us) verified',
    'target panel: slot 0x208 scene 0x1000401 1920x720: shown (us) verified',
    'target hud: slot 0x323 scene 0x1000400 800x480: idle',
    '  videos composed into one 1088x720 at 0,0: 2 videos',
    'layer 3 video of cn_carlife_map on map, content z 0: shown',
    '  frames 812',
    'layer 4 video of cn_carlife_map on hud, overlay z 0: waiting - the target is not shown',
    'layer 5 video of cn_other_app on hud, overlay z 0: error - video smaller than 64x32',
    ''
].join('\n');

assert.strictEqual(parseTarget(STATUS, 'hud'), 'hud 800x480: idle', 'hud target line');
assert.strictEqual(parseTarget(STATUS, 'map'), 'map 1088x480: shown (us) verified', 'map target line');
assert.strictEqual(parseTarget(STATUS, 'guide'), '', 'a target that is not there');

assert.strictEqual(parseLayer(STATUS, 'hud', 4), 'layer 4 video: waiting - the target is not shown', 'our hud layer');
assert.strictEqual(parseLayer(STATUS, 'hud', 5), 'layer 5 video: error - video smaller than 64x32', 'another app\'s');
assert.strictEqual(parseLayer(STATUS, 'hud', 99), '', 'a ref that is not there');
assert.strictEqual(parseLayer(STATUS, 'map', 3), 'layer 3 video: shown', 'the map layer is not the hud\'s');
assert.strictEqual(parseLayer('', 'hud', 1), '', 'empty text');

console.log('hud_convert ok: colour, chroma blocks, short buffers, status lines');
