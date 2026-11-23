'use strict';
/**
 * The two conversions the HUD needs when it goes up as a picture instead of as
 * a video layer, and the two readings of cluster-render's own status text.
 *
 * They live in their own module so that they can be checked on a desk: neither
 * needs a socket, a renderer or a car, and both are the kind of thing that
 * fails quietly - a blue and red swapped, or a status line matched by the wrong
 * target - and looks like "the HUD is broken" on the road.
 */

/* BT.601 limited range, which is what the video in this car is in: 4:2:0 with
 * Y from 16 to 235 and chroma from 16 to 240. Full-range (JPEG) coefficients
 * here would show as washed-out colour, and 709's as slightly wrong greens -
 * neither is worth arguing about, both are wrong in a way that reads as a bad
 * decoder rather than as a colour-space mistake. */
const Y_LUT = new Float32Array(256);
const C_LUT = new Float32Array(256);
for (let i = 0; i < 256; i++) {
    Y_LUT[i] = 1.164383 * (i - 16);
    C_LUT[i] = i - 128;
}

function clamp8(v) {
    return v < 0 ? 0 : v > 255 ? 255 : v | 0;
}

/**
 * A 4:2:0 atlas (w x h of Y, then h/2 chroma rows, each row w bytes with the U
 * half first and the V half after it) as RGBA, into `out`.
 *
 * Chroma is shared by the 2x2 block it belongs to - that is the whole reason an
 * atlas is three quarters of an RGBA picture - so it is looked up once per two
 * columns and per two rows.
 */
function toRgba(atlas, w, h, out) {
    const cw = w >> 1;
    const base = w * h;
    const need = w * h * 4;
    if (atlas.length < base + cw * 2 * (h >> 1) || out.length < need) return null;
    let o = 0;
    for (let y = 0; y < h; y++) {
        const cRow = base + (y >> 1) * w;
        const yRow = y * w;
        for (let x = 0; x < w; x++, o += 4) {
            const lum = Y_LUT[atlas[yRow + x]];
            const u = C_LUT[atlas[cRow + (x >> 1)]];
            const v = C_LUT[atlas[cRow + cw + (x >> 1)]];
            out[o] = clamp8(lum + 1.596027 * v);
            out[o + 1] = clamp8(lum - 0.391762 * u - 0.812968 * v);
            out[o + 2] = clamp8(lum + 2.017232 * u);
            out[o + 3] = 255;
        }
    }
    return out;
}

/**
 * cluster-render's "target hud: slot 0x323 scene 0x1000400 800x480: idle ..."
 * as "hud 800x480: idle ...". The slot and scene numbers are the same on every
 * car of this generation and say nothing to someone looking at a HUD that is
 * dark; what the state and its reason say does.
 */
function parseTarget(text, name) {
    const re = new RegExp('^target ' + name + ': slot \\S+ scene \\S+ (\\d+x\\d+): (.*)$', 'm');
    const m = re.exec(String(text || ''));
    return m ? name + ' ' + m[1] + ': ' + m[2].trim() : '';
}

/**
 * The layer line for a target: "layer 5 video of app on hud, overlay z 0:
 * waiting - <reason>". Returns '' when no layer of ours is on that target,
 * which is itself the answer when a layer was asked for.
 */
function parseLayer(text, name, ref) {
    const lines = String(text || '').split('\n');
    for (const line of lines) {
        const m = /^layer (\d+) (\w+) of \S+ on (\w+)[^:]*: (.*)$/.exec(line);
        if (!m) continue;
        if (m[3] !== name) continue;
        if (ref && m[1] !== String(ref)) continue;
        return 'layer ' + m[1] + ' ' + m[2] + ': ' + m[4].trim();
    }
    return '';
}

module.exports = { toRgba, parseTarget, parseLayer };
