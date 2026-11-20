// SPDX-License-Identifier: MPL-2.0
'use strict';
/**
 * Does the app accept the frames tools/phone-bridge/bridge.py sends?
 *
 * The Python side has its own selftest, but that only proves it agrees with
 * itself. The receiver is JavaScript, and the failure this guards against is
 * the quiet kind: a header one field out of step still produces a live-looking
 * socket that never shows a picture.
 *
 * Also measures the cost of feeding 765 KB frames through the parser, because
 * raw NV12 over Wi-Fi is only viable if the app can eat 8 MB/s without
 * spending the whole frame interval on buffer copies.
 *
 *   node tools/phone-bridge/test_wire.js
 */

const path = require('path');
const { createSource } = require(path.join(__dirname,
    '..', '..', 'apps', 'cn_carlife_map', 'carlife_source.js'));

const MAGIC = 0x464d4c43;
const W = 1088, H = 480;
const FRAME = W * (H + (H >> 1));

let failed = 0;
function chk(ok, what) {
    if (!ok) { failed++; console.log('FAIL  ' + what); }
    else console.log('ok    ' + what);
}

function packets(n) {
    const out = [];
    for (let i = 0; i < n; i++) {
        const hdr = Buffer.alloc(12);
        hdr.writeUInt32LE(MAGIC, 0);
        hdr.writeUInt32LE(FRAME, 4);
        hdr.writeUInt32LE(i, 8);
        const body = Buffer.alloc(FRAME);
        body[0] = i & 0xff;
        out.push(Buffer.concat([hdr, body]));
    }
    return out;
}

function makeSource() {
    const src = createSource({
        kind: 'tcp', w: W, h: H, fps: 10,
        host: '127.0.0.1', port: 1, mode: 'tcp-connect'
    });
    src.running = true;            // pretend start(): no socket is opened here
    return src;
}

/* 1. Whole packets in one write, as a fast sender would arrive. */
{
    const src = makeSource();
    const got = [];
    src.on('frame', (buf, seq) => got.push([buf.length, seq, buf[0]]));
    const ps = packets(3);
    ps.forEach((p) => src._feed(p));
    chk(got.length === 3, 'three whole packets give three frames');
    chk(got.every((g) => g[0] === FRAME), 'every frame is ' + FRAME + ' bytes');
    chk(got.map((g) => g[1]).join(',') === '0,1,2', 'sequence numbers are kept');
    chk(got[2][2] === 2, 'the third frame carries its own first byte');
}

/* 2. Split at 64 KB, the size Windows and Linux deliver a 765 KB write in. */
{
    const src = makeSource();
    let n = 0, bad = 0;
    src.on('frame', (buf) => { n++; if (buf.length !== FRAME) bad++; });
    const all = Buffer.concat(packets(4));
    for (let i = 0; i < all.length; i += 65536) src._feed(all.slice(i, i + 65536));
    chk(n === 4 && !bad, 'a 64 KB chunked stream reassembles 4 frames');
}

/* 3. Split inside the header, which is where a naive parser loses bytes. */
{
    const src = makeSource();
    let n = 0;
    src.on('frame', () => n++);
    const all = Buffer.concat(packets(2));
    for (let i = 0; i < all.length; i += 7) src._feed(all.slice(i, i + 7));
    chk(n === 2, 'a 7 byte chunked stream reassembles 2 frames');
}

/* 4. Throughput: the app must spend far less than one frame interval. */
{
    const src = makeSource();
    let n = 0;
    src.on('frame', () => n++);
    const ps = packets(30);
    const t0 = process.hrtime.bigint();
    ps.forEach((p) => {
        for (let i = 0; i < p.length; i += 65536) src._feed(p.slice(i, i + 65536));
    });
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    const per = ms / n;
    console.log('      ' + n + ' frames in ' + ms.toFixed(0) + ' ms, ' +
        per.toFixed(1) + ' ms/frame, ' + (FRAME * n / 1048576 / (ms / 1000)).toFixed(1) +
        ' MB/s');
    chk(n === 30, 'thirty frames of 765 KB parse through');
    chk(per < 100, 'under 100 ms per frame (10 fps needs 100 ms)');
}

console.log(failed ? failed + ' check(s) failed' : '\nwire format: OK');
process.exit(failed ? 1 : 0);
