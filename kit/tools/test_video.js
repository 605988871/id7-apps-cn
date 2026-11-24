#!/usr/bin/env node
'use strict';

// The kit's video channel without a socket: the renderer's video support needs a
// unix socket to talk to, which a Windows desk cannot always create (listen
// EACCES), so the two halves that decide whether a picture ever appears are
// checked here on a file sink instead:
//
//   1. the claim: a video screen claims the whole picture area, so a finger on
//      the bottom of the picture does not reach the HMI's own button bar
//   2. naming the file: only on the dialect AND the caps, only once per
//      connection, only after the decoder has written a frame - naming it
//      earlier is an ERROR and that connection never gets a picture
//
//   node kit/tools/test_video.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { Display } = require('../runtime/display');
const { RenderClient } = require('../runtime/renderd');
const rec = require('../runtime/record');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mgu-vid-'));
const sink = path.join(dir, 'sink.bin');
const frameFile = path.join(dir, 'frame.bin');
const X_READY = 0x4d520101;                // mgu-render/1's READY: flags, area, caps at byte 8
const VIDEO = 13;

let failed = 0, ran = 0;
function test(name, fn) {
    ran++;
    try { fn(); console.log('ok    ' + name); } catch (e) { failed++; console.log('FAIL  ' + name + '\n      ' + e.message.split('\n')[0]); }
}
const u32 = (...a) => Buffer.from(new Uint32Array(a).buffer);
function msg(type, payload) {
    const len = payload ? payload.length : 0;
    const b = Buffer.alloc(8 + len + ((4 - (len & 3)) & 3));
    b.writeUInt32LE(type, 0); b.writeUInt32LE(b.length - 8, 4);
    if (payload) payload.copy(b, 8);
    return b;
}

/* A full-screen 1920x720 frame: a chrome-less canvas at 0,0, the whole screen. */
function videoScreen() {
    return {
        place: { x: 0, y: 0, w: 1920, h: 720, ox: 0, oy: 0, scale: 1 },
        screen: { video: true, chrome: false, src: { x: 0, y: 0, w: 1920, h: 720 } },
        gpu: { claim: (a) => { videoScreen.claimed = a; } },
        barH: () => 0, headH: () => 0, own: () => true, onTab: false, tabs: [],
    };
}

test('a video screen claims the whole picture, not the app page', () => {
    const s = videoScreen();
    Display.prototype._claimTabs.call(s, [], null);
    const rects = videoScreen.claimed;
    assert(Array.isArray(rects) && rects.length === 1, 'one claim: ' + JSON.stringify(rects));
    const r = rects[0];
    assert.deepStrictEqual([r.x, r.y, r.w, r.h], [84, 0, 1836, 720], JSON.stringify(r));
});

/* A file sink is a renderer connection without the socket: HELLO and every
 * message the app would send land in the file, readable byte for byte. */
function client() {
    fs.writeFileSync(sink, '');
    const log = { warn() {}, info() {}, debug() {}, error() {} };
    const c = new RenderClient('test', log, { file: sink });
    c.connect();
    return c;
}
const size = () => fs.statSync(sink).size;
function videoMessages() {
    const buf = fs.readFileSync(sink), out = [];
    for (let i = 0; i + 8 <= buf.length;) {
        const type = buf.readUInt32LE(i), len = buf.readUInt32LE(i + 4);
        if (type === VIDEO && len > 0) {
            out.push({
                id: buf.readUInt32LE(i + 8),
                path: buf.slice(i + 12, i + 8 + len).toString('utf8').replace(/\0+$/, ''),
            });
        }
        i += 8 + len + ((4 - (len & 3)) & 3);
    }
    return out;
}

rec.setVideo(9, frameFile);
fs.rmSync(frameFile, { force: true });

test('no mgu-render/1 yet: nothing is named', () => {
    const c = client(), before = size();
    c._ensureVideo(9);
    assert.strictEqual(size(), before, 'HELLO only');
    assert.strictEqual(videoMessages().length, 0);
    c.close();
});

test('X_READY with caps 16 marks the connection as having video', () => {
    const c = client();
    c._data(msg(X_READY, u32(1, 1, 23)));      // touch, controller, video
    assert(c.native && c.info && c.info.video === true, JSON.stringify(c.info));
    c.close();
});

test('a native renderer without caps 16 is never sent a video', () => {
    const c = client(), before = size();
    c._data(msg(X_READY, u32(1, 1, 7)));       // X_READY version 3: pictures, no video
    c._ensureVideo(9);
    assert.strictEqual(size(), before);
    assert(!c.sent.video.has(9));
    c.close();
});

test('naming the file before the decoder wrote one is refused', () => {
    const c = client(), before = size();
    c._data(msg(X_READY, u32(1, 1, 23)));
    c._ensureVideo(9);                          // no frame file yet
    assert.strictEqual(size(), before, 'no VIDEO');
    c.close();
});

test('once the frame file exists it is named exactly once', () => {
    fs.writeFileSync(frameFile, Buffer.alloc(64));
    const c = client();
    c._data(msg(X_READY, u32(1, 1, 23)));
    c._ensureVideo(9);
    const named = videoMessages();
    assert.strictEqual(named.length, 1, JSON.stringify(named));
    assert.strictEqual(named[0].id, 9);
    assert.strictEqual(named[0].path, frameFile);
    c._ensureVideo(9);
    c._ensureVideo(9);
    assert.strictEqual(videoMessages().length, 1, 'still one, no message per frame');
    c.close();
});

test('dropVideo forgets it, so a resize can name it again', () => {
    const c = client();
    c._data(msg(X_READY, u32(1, 1, 23)));
    c._ensureVideo(9);
    c.dropVideo(9);
    assert(!c.sent.video.has(9));
    c._ensureVideo(9);
    assert.strictEqual(videoMessages().filter((v) => v.id === 9).length, 2);
    c.close();
});

fs.rmSync(dir, { recursive: true, force: true });
console.log(failed ? failed + ' of ' + ran + ' failed' : 'video: all ok');
process.exit(failed ? 1 : 0);
