/* Desktop check for the app's CarLife source: no head unit needed.
 *
 *   node kit/carlife-tap/test/src_test.js
 *
 * It plays the capture side over TCP (unix sockets do not exist on Windows),
 * with a stream shaped like CarLife's: Annex B, SPS + IDR + slice.
 */
'use strict';
const path = require('path');
const net = require('net');
const APP = path.join(__dirname, '..', '..', '..', 'apps', 'cn_carlife_map');
const { CarlifeSource } = require(path.join(APP, 'carlife_source'));
const { activityAtlas, waitingAtlas, atlasSize, MAP_W, MAP_H } = require(path.join(APP, 'atlas'));

let bad = 0;
const ok = (cond, what, extra) => {
    if (!cond) bad++;
    console.log((cond ? 'ok   ' : 'FAIL ') + what + (extra ? '  ' + extra : ''));
};

/* 1. the activity picture is a valid atlas of the right size */
const a = activityAtlas(null, MAP_W, MAP_H, 0, 12.4, 240, 1.6);
ok(a.length === atlasSize(MAP_W, MAP_H), 'activity atlas is w*(h+h/2)',
    a.length + ' vs ' + atlasSize(MAP_W, MAP_H));
ok(a.slice(0, MAP_W * MAP_H).some((v) => v > 100), 'activity atlas has bright pixels');
const reuse = Buffer.alloc(atlasSize(MAP_W, MAP_H));
ok(activityAtlas(reuse, MAP_W, MAP_H, 3, 1, 2, 0.5) === reuse, 'activity atlas reuses the buffer');
/* the marker moves with the tick, so live data is visible as motion */
const b1 = activityAtlas(null, MAP_W, MAP_H, 1, 0, 0, 0);
const b2 = activityAtlas(null, MAP_W, MAP_H, 2, 0, 0, 0);
ok(!b1.equals(b2), 'activity atlas animates');

/* 2. the waiting picture is a valid atlas and blinks */
const w1 = waitingAtlas(null, MAP_W, MAP_H, 0);
ok(w1.length === atlasSize(MAP_W, MAP_H), 'waiting atlas is w*(h+h/2)');
ok(!w1.equals(waitingAtlas(null, MAP_W, MAP_H, 1)), 'waiting atlas blinks');

/* 2. the source recognises CarLife's stream and turns it into frames */
const PORT = 20999;
const srv = net.createServer((s) => {
    const pkt = Buffer.concat([
        Buffer.from([0, 0, 0, 1, 0x67]), Buffer.alloc(40, 0x11),
        Buffer.from([0, 0, 0, 1, 0x65]), Buffer.alloc(400, 0x22),
        Buffer.from([0, 0, 1, 0x41]), Buffer.alloc(100, 0x33)
    ]);
    const timer = setInterval(() => s.write(pkt), 20);
    s.on('close', () => clearInterval(timer));
    s.on('error', () => clearInterval(timer));
});

srv.listen(PORT, '127.0.0.1', () => {
    const src = new CarlifeSource({ w: MAP_W, h: MAP_H, fps: 15, host: '127.0.0.1', port: PORT });
    let frames = 0;
    const seen = [];
    src.on('frame', (buf) => { frames++; ok(buf.length === atlasSize(MAP_W, MAP_H), 'frame size'); });
    src.on('status', (s) => seen.push(s));
    src.start();

    setTimeout(() => {
        ok(frames > 0, 'H.264 became frames for the cluster', frames + ' frames');
        ok(src.format === 'h264', 'detected raw H.264', src.format);
        ok(src.h264Idr >= 2, 'counted keyframes', String(src.h264Idr));
        ok(src.h264Bytes > 0, 'counted bytes', src.h264Bytes + ' B');
        const d = src.detail();
        ok(/no decoder/.test(d), 'status says a decoder is missing', d);
        src.stop();
        srv.close();
        console.log(bad ? '\nFAILED ' + bad : '\nOK');
        process.exit(bad ? 1 : 0);
    }, 1000);
});
