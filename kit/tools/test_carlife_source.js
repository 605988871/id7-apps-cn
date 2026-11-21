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
const fs = require('fs');
const os = require('os');
const path = require('path');
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

ok('waiting text follows the size and position settings', () => {
    const w = 320, h = 140;
    const note = 'DECODER NOT RUNNING';
    const smallOpt = { scale: 33, x: 20, y: -15 };
    const normal = atlas.waitingAtlas(null, w, h, 0, note, { scale: 100, x: 0, y: 0 });
    const small = atlas.waitingAtlas(null, w, h, 0, note, smallOpt);
    const moved = atlas.waitingAtlas(null, w, h, 0, note, { scale: 33, x: -20, y: 15 });
    assert.notStrictEqual(Buffer.compare(normal, small), 0);
    assert.notStrictEqual(Buffer.compare(small, moved), 0);

    const card = atlas.liveCardAtlas(null, w, h, 0, 0, { scale: 100, x: 0, y: 0 }, note);
    const cardSmall = atlas.liveCardAtlas(null, w, h, 0, 0, smallOpt, note);
    const cardMoved = atlas.liveCardAtlas(null, w, h, 0, 0,
        { scale: 33, x: -20, y: 15 }, note);
    assert.notStrictEqual(Buffer.compare(card, cardSmall), 0);
    assert.notStrictEqual(Buffer.compare(cardSmall, cardMoved), 0);

    assert.strictEqual(atlas.textOpt(smallOpt).k, 0.33);
    assert.strictEqual(atlas.textOpt(smallOpt).dx, 0.2);
    assert.ok(atlas.fitScale('CARLIFE', w, 600) <= atlas.fitScale('CARLIFE', w, 1000));
    assert.ok(7 * 6 * atlas.fitScale('CARLIFE', w, 1000) <= w);
});

ok('a card status page carries the reason and the text settings', () => {
    const s = new CarlifeSource({ w: 320, h: 140, fps: 5, sockPath: '/tmp/none.sock' });
    s.running = true;
    s.format = '';
    s.note = 'DECODER NOT RUNNING';
    s.text = { scale: 33, x: 20, y: -15 };
    const seen = [];
    s.on('frame', (b) => seen.push(b));
    for (let i = 0; i < 6; i++) s._activity();
    assert.ok(seen.length > 0);
    const first = Buffer.from(seen[seen.length - 1]);
    s.text = { scale: 100, x: 0, y: 0 };
    for (let i = 0; i < 6; i++) s._activity();
    assert.notStrictEqual(Buffer.compare(first, seen[seen.length - 1]), 0);
});

ok('a torn CLMF stream resyncs: short, bogus-length and garbage bytes never reach the layer', () => {
    const w = 64, h = 32, want = atlas.atlasSize(w, h);
    const s = new CarlifeSource({ w, h, fps: 10, sockPath: '/tmp/none.sock' });
    s.running = true;
    s.format = 'clmf';                          /* decoder already handshook */
    const seen = [];
    s.on('frame', (b) => seen.push(b));

    /* Stray bytes from a frame that was cut when the socket closed: no frame. */
    s._feed(Buffer.from([0xde, 0xad, 0xbe, 0x00, 0x00, 0x46]));
    assert.strictEqual(seen.length, 0, 'garbage produced a frame');

    /* A header split across two data events whose length is wrong: still no
     * frame, and the parser must be back on a boundary for the next packet. */
    const bogus = packet(want + 8, 2);
    s._feed(bogus.subarray(0, 5));
    s._feed(Buffer.concat([bogus.subarray(5), Buffer.alloc(want + 8, 0)]));
    assert.strictEqual(seen.length, 0, 'a wrong-size frame reached the layer');

    /* One intact frame after all that: delivered once, at the right size. */
    const good = packet(want, 3);
    good.set(Buffer.alloc(want, 0x5a), 12);
    s._feed(good);
    assert.strictEqual(seen.length, 1, 'expected one good frame, got ' + seen.length);
    assert.strictEqual(seen[0].length, want, 'a wrong-size frame got through');
    assert.strictEqual(seen[0][0], 0x5a, 'the good frame was not the one delivered');
});

ok('a frame split across many socket chunks is assembled once', () => {
    const w = 64, h = 32, want = atlas.atlasSize(w, h);
    const s = new CarlifeSource({ w, h, fps: 10, sockPath: '/tmp/none.sock' });
    s.running = true;
    s.format = 'clmf';
    const seen = [];
    s.on('frame', (b) => seen.push(b));
    const p = packet(want, 9);
    p.set(Buffer.alloc(want, 0x3c), 12);
    /* Seven bytes at a time: both the header and the atlas are split. */
    for (let i = 0; i < p.length; i += 7) s._feed(p.slice(i, i + 7));
    assert.strictEqual(seen.length, 1, 'a chunked frame became ' + seen.length + ' frames');
    assert.strictEqual(seen[0].length, want, 'a chunked frame lost bytes');
    assert.strictEqual(seen[0][0], 0x3c, 'the wrong bytes reached the layer');
    assert.strictEqual(s.parts.length, 0, 'socket chunks were left behind');
    assert.strictEqual(s.partLen, 0, 'a partial byte count was left behind');
});

ok('a decode socket that goes away clears its state before the next one', () => {
    const w = 64, h = 32;
    const s = new CarlifeSource({ w, h, fps: 10, sockPath: '/tmp/none.sock' });
    s.running = true;
    const handlers = {};
    const emitter = new (require('events').EventEmitter)();
    emitter.on = function (ev, fn) { handlers[ev] = fn; return this; };
    s._attach(emitter, 'local');
    s.format = 'clmf';
    s.buf = Buffer.from([1, 2, 3]);
    handlers.close();                            /* the decoder dropped the link */
    assert.strictEqual(s.client, null, 'a gone socket was not cleared');
    assert.strictEqual(s.format, '', 'the old format survived the disconnect');
    assert.strictEqual(s.buf.length, 0, 'partial bytes survived the disconnect');
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

/* The socket side, which needs real time and a little white-boxing.
 *
 * The failure modelled here is the one the car produced. The decoder runs as
 * root and starts at boot, so it creates /dev/shm/carlife-map with mkdir(0777)
 * cut down by its umask to 0755 - and creating a unix socket needs write
 * permission on the directory, not on the socket. The app's listen() then
 * fails with EACCES, which reads like "the address is in use" and is nothing
 * of the sort. The old code treated that as final: the decoder went on
 * decoding 1541 frames next to an app that had stopped listening for ever, and
 * the cluster said WAITING FOR CARLIFE while the picture was being made a few
 * centimetres away.
 *
 * net.createServer is stubbed because this has to run on the machine the code
 * is written on, and Windows refuses to bind unix sockets at all - the point
 * under test is the handler (what is said, and that it tries again), not the
 * kernel. */
function fakeListen(failures) {
    const netMod = require('net');
    const real = netMod.createServer;
    const realSI = global.setInterval, realCI = global.clearInterval;
    const live = new Set();
    let tries = 0;
    global.setInterval = (fn, ms) => { const h = realSI(fn, ms); live.add(h); return h; };
    global.clearInterval = (h) => { live.delete(h); return realCI(h); };
    netMod.createServer = () => {
        const srv = new (require('events').EventEmitter)();
        srv.close = () => {};
        srv.listen = (p, cb) => {
            tries++;
            if (tries <= failures) {
                const e = new Error('listen EACCES: permission denied ' + p);
                e.code = 'EACCES';
                setImmediate(() => srv.emit('error', e));
            } else {
                setImmediate(() => cb());
            }
        };
        return srv;
    };
    return {
        tries: () => tries,
        live: () => live.size,
        restore: () => {
            netMod.createServer = real;
            global.setInterval = realSI;
            global.clearInterval = realCI;
        }
    };
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function liveChecks() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clmf-'));
    const sock = path.join(dir, 'live.sock');
    const fake = fakeListen(2);              /* two refusals, then it works */
    const s = new CarlifeSource({ w: 64, h: 32, fps: 5, sockPath: sock });
    const said = [];
    s.on('status', (t) => said.push(t));
    try {
        s.start();
        await sleep(200);
        assert.strictEqual(s.running, true, 'the source gave up: retrying is the fix');
        assert.ok(/EACCES/.test(said.join(' | ')), 'no errno in the status: ' + said.join(' | '));
        assert.ok(/is uid/.test(said.join(' | ')), 'no directory owner in the status: ' + said.join(' | '));
        assert.ok(/^socket not opened/.test(s.detail()), 'detail hid it: ' + s.detail());

        await sleep(1600);
        assert.ok(fake.tries() > 2, 'it never tried again (' + fake.tries() + ' attempt(s))');
        assert.strictEqual(s.listenErr, '', 'still failing after the retries: ' + s.listenErr);
        assert.ok(/^waiting for CarLife/.test(said[said.length - 1]), 'not listening: ' + said[said.length - 1]);
        /* Two tickers, not two per attempt: a retry must not stack them. */
        assert.strictEqual(fake.live(), 2, fake.live() + ' intervals alive after ' + fake.tries() + ' attempts');

        s.stop();
        assert.strictEqual(fake.live(), 0, 'timers left behind after stop');
    } finally {
        try { s.stop(); } catch (e) {}
        fake.restore();
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
    }
}

liveChecks().then(() => {
    if (problems) { console.log(problems + ' problem(s)'); process.exit(1); }
    console.log('carlife source ok: sizes, silence, the pages that break it, and a listen that comes back');
}).catch((e) => {
    console.log('FAIL live socket\n     ' + e.message);
    process.exit(1);
});
