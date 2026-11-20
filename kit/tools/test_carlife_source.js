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
