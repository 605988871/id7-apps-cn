'use strict';
/**
 * Desk check of the display chain, no car and no MSDK needed:
 *
 *   NV12 frame (what the decoder's blit produces) -> CLMF packet ->
 *   CarlifeSource frame -> toRgba -> PPM picture
 *
 * Run after exporting a real frame with:
 *   ffmpeg -i test.h264 -vf "select=eq(n\,150),scale=1280:720" -vframes 1 -pix_fmt nv12 frame720_nv12.yuv
 *   node test_display.js <frame720_nv12.yuv>
 *
 * It proves the atlas layout, the CLMF framing the source accepts, and the
 * YUV->RGB coefficients all agree - a mistake in any one shows up as a wrong
 * colour or no frame at all, and neither is visible until the car.
 */
const fs = require('fs');
const { CarlifeSource } = require('../carlife_source');
const { toRgba } = require('../hud_convert');

const W = 1280, H = 720;
const file = process.argv[2] || 'D:/carlife-probe/frames/frame720_nv12.yuv';
const nv12 = fs.readFileSync(file);
if (nv12.length !== W * H * 3 / 2) {
    console.error('expected ' + (W * H * 3 / 2) + ' NV12 bytes, got ' + nv12.length);
    process.exit(2);
}

/* decoder blit(): Y plane, then each chroma row split U (left half) + V
 * (right half). ffmpeg gives interleaved UV; lay it out the decoder way. */
const atlas = Buffer.alloc(W * (H + H / 2));
nv12.copy(atlas, 0, 0, W * H);
const cw = W / 2, ch = H / 2;
for (let y = 0; y < ch; y++) {
    const src = W * H + y * W;
    const du = W * H + y * W;
    const dv = du + cw;
    for (let x = 0; x < cw; x++) {
        atlas[du + x] = nv12[src + x * 2];
        atlas[dv + x] = nv12[src + x * 2 + 1];
    }
}

/* Wrap it in CLMF exactly as the decoder's out_write does. */
const HEAD = 12, MAGIC = 0x464d4c43;
const pkt = Buffer.alloc(HEAD + atlas.length);
pkt.writeUInt32LE(MAGIC, 0);
pkt.writeUInt32LE(atlas.length, 4);
pkt.writeUInt32LE(1, 8);
atlas.copy(pkt, HEAD);

/* Feed the real source class, and check a frame comes out at the right size. */
const source = new CarlifeSource({ w: W, h: H, fps: 30, sockPath: '/tmp/none.sock' });
source.running = true;      /* _feed ignores frames when stopped */
source.format = 'clmf';
let got = null;
source.on('frame', (buf) => { got = buf; });
source._feed(pkt);
if (!got) { console.error('FAIL: no frame emitted from a valid CLMF packet'); process.exit(1); }
if (got.length !== W * H * 3 / 2) { console.error('FAIL: frame size ' + got.length); process.exit(1); }

/* Colour it and write a PPM the harness turns into a PNG for eyeballing. */
const rgba = Buffer.alloc(W * H * 4);
if (!toRgba(got, W, H, rgba)) { console.error('FAIL: toRgba returned null'); process.exit(1); }
const header = 'P6\n' + W + ' ' + H + '\n255\n';
const ppm = Buffer.alloc(Buffer.byteLength(header) + W * H * 3);
let p = ppm.write(header, 0, 'ascii');
for (let i = 0; i < W * H; i++) {
    ppm[p++] = rgba[i * 4];
    ppm[p++] = rgba[i * 4 + 1];
    ppm[p++] = rgba[i * 4 + 2];
}
fs.writeFileSync('D:/carlife-probe/frames/display_check.ppm', ppm);
console.log('ok   CLMF -> frame -> RGBA -> PPM (' + got.length + ' atlas bytes, ' + rgba.length + ' RGBA bytes)');
