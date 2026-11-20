// SPDX-License-Identifier: MPL-2.0
'use strict';
/**
 * The CarLife source's own rules, without a car:
 *
 *   - a frame whose length is not the layer's size is counted and named, and
 *     never reaches the layer (cluster-render would drop it without a word);
 *   - a real picture stops the status page;
 *   - a decoder that connects and then sends nothing does NOT stop it. That
 *     was the bug behind a cluster that sat on "waiting for CarLife" for ever:
 *     once the container was recognised the page went quiet, so a size
 *     mismatch and a working stream looked the same - one said nothing, the
 *     other showed a map.
 *
 *   node kit/tools/test_carlife_source.js
 */

const assert = require('assert');
const { CarlifeSource } = require('../../apps/cn_carlife_map/carlife_source');
const atlas = require('../../apps/cn_carlife_map/atlas');

let problems = 0;
function ok(name, fn) {
    try { fn(); console.log('ok   ' + name); }
    catch (e) { problems++; console.log('FAIL ' + name + '\n     ' + e.message); }
}

function packet(len, seq) {
    const b = Buffer.alloc(12 + len, 7);
    b.writeUInt32LE(0x464d4c43, 0);
    b.writeUInt32LE(len, 4);
    b.writeUInt32LE(seq, 8);
    return b;
}

function source() {
    const w = 64, h = 32;                       /* the smallest layer that fits */
    const s = new CarlifeSource({ w: w, h: h, fps: 5, sockPath: '/tmp/none.sock' });
    s.running = true;
    s.format = 'clmf';
    const seen = [];
    s.on('frame', (buf) => seen.push(buf));
    s.seen = seen;
    return s;
}

ok('a frame at the layer size arrives, and is counted as a picture', () => {
    const s = source();
    s._feed(packet(s.expected, 1));
    assert.strictEqual(s.seen.length, 1);
    assert.strictEqual(s.seen[0].length, s.expected);
    assert.strictEqual(s.live, 1);
    assert.ok(Date.now() - s.lastLiveAt < 1000);
});

ok('a frame at the wrong size is named, and reaches no layer', () => {
    const s = source();
    s._feed(packet(120, 2));
    assert.strictEqual(s.seen.length, 0);
    assert.strictEqual(s.badLen, 120);
    assert.strictEqual(s.badLen === s.expected, false);
});

ok('a real picture keeps the status page away', () => {
    const s = source();
    s._feed(packet(s.expected, 3));
    const before = s.seen.length;
    for (let i = 0; i < 6; i++) s._activity();
    assert.strictEqual(s.seen.length, before);
});

ok('a stale decoder still gets a page, with the two sizes on it', () => {
    const s = source();
    s._feed(packet(s.expected, 4));
    s.lastLiveAt = Date.now() - 5000;
    s._feed(packet(99, 5));
    for (let i = 0; i < 6; i++) s._activity();
    assert.ok(s.seen.length > 1, 'no status page after the stream stopped');
    const page = s.seen[s.seen.length - 1];
    assert.strictEqual(page.length, s.expected);
    /* The page with a note differs from the page without one: the note is
     * drawn into the picture, not just held in a string. */
    const plain = atlas.waitingAtlas(null, 64, 32, 0, '');
    assert.notStrictEqual(Buffer.compare(page, plain), 0);
});

ok('no decoder at all says so, and says it in the picture', () => {
    const s = source();
    s.format = '';                              /* nothing has connected */
    s.note = 'DECODER NOT RUNNING';
    for (let i = 0; i < 6; i++) s._activity();
    assert.ok(s.seen.length > 0);
    const plain = atlas.waitingAtlas(null, 64, 32, 0, '');
    assert.notStrictEqual(Buffer.compare(s.seen[s.seen.length - 1], plain), 0);
});

ok('a status page never grows the layer: its frame is exactly vw x vh', () => {
    for (const [w, h] of [[1088, 480], [480, 168], [344, 120]]) {
        const s = new CarlifeSource({ w: w, h: h, fps: 5, sockPath: '/tmp/none.sock' });
        s.running = true;
        const seen = [];
        s.on('frame', (b) => seen.push(b));
        for (let i = 0; i < 6; i++) s._activity();
        assert.ok(seen.length > 0, w + 'x' + h + ' produced no page');
        assert.strictEqual(seen[seen.length - 1].length, atlas.atlasSize(w, h));
    }
});

if (problems) { console.log(problems + ' problem(s)'); process.exit(1); }
console.log('carlife source ok: sizes, silence and the pages that break it');
