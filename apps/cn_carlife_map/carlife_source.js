// SPDX-License-Identifier: MPL-2.0
'use strict';
/**
 * Frame sources for the CarLife map app.
 *
 * Every source produces one complete YUV 4:2:0 atlas per frame:
 *   rows 0..h-1          Y
 *   rows h..h+h/2-1      U (left w/2 bytes), V (right w/2 bytes)
 * and emits it as 'frame' (buffer, seq). No conversion is done here.
 *
 * Sources:
 *   demo   - a built-in moving test picture, no external service needed
 *   tcp    - framed atlases over TCP (connect or listen, see config file)
 *   fifo   - framed atlases from a local named pipe
 *
 * Wire format for tcp / fifo, all little endian:
 *   u32 magic = 0x464d4c43 ('CLMF')
 *   u32 len   = number of atlas bytes (must be w * (h + h/2))
 *   u32 seq   - frame number, informational
 *   bytes[len] - the atlas
 */

const net = require('net');
const fs = require('fs');
const EventEmitter = require('events');
const { demoAtlas, atlasSize } = require('./atlas');

const MAGIC = 0x464d4c43;
const HEAD = 12;
const MAX_PACKET = 8 * 1024 * 1024;
const BACKOFF = [500, 1000, 2000, 4000];

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 20558;
const DEFAULT_FIFO = '/dev/shm/carlife-map/frames.fifo';

class FrameSource extends EventEmitter {
    constructor(opts) {
        super();
        this.w = opts.w;
        this.h = opts.h;
        this.expected = atlasSize(opts.w, opts.h);
        this.fps = opts.fps || 15;
        this.running = false;
        this.seq = 0;
        this.frames = 0;
        this.retry = 0;
        this.timer = null;
    }

    start() {
        if (this.running) return;
        this.running = true;
        try { this._start(); } catch (e) { this._fail('start: ' + e.message); }
    }

    stop() {
        if (!this.running) return;
        this.running = false;
        if (this.timer) { clearTimeout(this.timer); this.timer = null; }
        try { this._stop(); } catch (e) { /* shutting down */ }
    }

    _fail(why) {
        this.emit('status', 'error: ' + why);
    }

    _retry(why) {
        if (!this.running) return;
        this.emit('status', why);
        if (this.server) { try { this.server.close(); } catch (e) {} this.server = null; }
        if (this.stream) { try { this.stream.destroy(); } catch (e) {} this.stream = null; }
        this.buf = Buffer.alloc(0);
        const ms = BACKOFF[Math.min(this.retry, BACKOFF.length - 1)];
        this.retry++;
        this.timer = setTimeout(() => {
            this.timer = null;
            if (this.running) { try { this._start(); } catch (e) { this._retry('start: ' + e.message); } }
        }, ms);
    }

    _frame(buf) {
        if (!this.running || !buf || buf.length !== this.expected) return;
        this.frames++;
        this.emit('frame', buf, this.seq++);
    }
}

/** A moving picture made on the head unit: proves the whole rendering path. */
class DemoSource extends FrameSource {
    _start() {
        this.emit('status', 'demo picture');
        const period = Math.max(33, Math.round(1000 / this.fps));
        let buf = null;
        this.tick = 0;
        this.timer = setInterval(() => {
            if (!this.running) return;
            try {
                buf = demoAtlas(buf, this.w, this.h, this.tick++);
                this._frame(buf);
            } catch (e) { this._fail('demo: ' + e.message); }
        }, period);
    }

    _stop() {
        if (this.timer) { clearInterval(this.timer); this.timer = null; }
    }
}

/** Framed atlases over a byte stream (TCP socket or FIFO read stream). */
class StreamSource extends FrameSource {
    constructor(opts) {
        super(opts);
        this.mode = opts.mode || 'tcp-connect';   // tcp-connect | tcp-listen | fifo
        this.host = opts.host || DEFAULT_HOST;
        this.port = opts.port || DEFAULT_PORT;
        this.path = opts.path || DEFAULT_FIFO;
        this.stream = null;
        this.server = null;
        this.buf = Buffer.alloc(0);
    }

    _start() {
        if (this.mode === 'tcp-listen') this._listen();
        else if (this.mode === 'fifo') this._fifo();
        else this._connect();
    }

    _stop() {
        if (this.server) { try { this.server.close(); } catch (e) {} this.server = null; }
        if (this.stream) { try { this.stream.destroy(); } catch (e) { try { this.stream.end(); } catch (e2) {} } this.stream = null; }
        this.buf = Buffer.alloc(0);
    }

    _connect() {
        const s = net.connect({ host: this.host, port: this.port });
        this._attach(s, 'tcp ' + this.host + ':' + this.port);
    }

    _listen() {
        const srv = net.createServer((s) => {
            if (this.stream) { s.destroy(); return; }   // one producer at a time
            this.retry = 0;
            this._attach(s, 'tcp listen :' + this.port);
        });
        this.server = srv;
        srv.on('error', () => this._retry('listen failed :' + this.port));
        srv.listen(this.port, '0.0.0.0', () => this.emit('status', 'tcp listen :' + this.port));
    }

    _fifo() {
        const s = fs.createReadStream(this.path);
        this._attach(s, 'pipe ' + this.path);
    }

    _attach(s, label) {
        this.stream = s;
        this.buf = Buffer.alloc(0);
        s.on('data', (d) => this._feed(d));
        s.on('error', () => {});
        s.on('close', () => {
            if (this.stream !== s) return;
            this.stream = null;
            this._retry(label + ' closed');
        });
        s.on('end', () => {
            if (this.stream !== s) return;
            this.stream = null;
            this._retry(label + ' ended');
        });
        s.on('open', () => { if (this.stream === s) this.emit('status', label + ' open'); });
    }

    _feed(d) {
        if (!this.running) return;
        this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
        while (this.buf.length >= HEAD) {
            const magic = this.buf.readUInt32LE(0);
            if (magic !== MAGIC) { this.buf = this.buf.slice(1); continue; }
            const len = this.buf.readUInt32LE(4);
            if (len < 1 || len > MAX_PACKET) { this.buf = this.buf.slice(4); continue; }
            if (this.buf.length < HEAD + len) break;
            const payload = this.buf.slice(HEAD, HEAD + len);
            this.buf = this.buf.slice(HEAD + len);
            if (len === this.expected) {
                this.retry = 0;
                this._frame(payload);
            } else {
                this.emit('status', 'frame size ' + len + ', want ' + this.expected);
            }
        }
        /* Keep a possible partial magic at the tail. */
        if (this.buf.length > MAX_PACKET + HEAD) this.buf = Buffer.alloc(0);
    }
}

/**
 * opts: { w, h, fps, kind, host, port, path }. `kind` is 'demo', 'tcp' or 'fifo'.
 * 'tcp' connects to host:port by default; set opts.tcpListen = true to listen.
 */
function createSource(opts) {
    if (opts.kind === 'tcp') {
        return new StreamSource(Object.assign({}, opts, { mode: opts.tcpListen ? 'tcp-listen' : 'tcp-connect' }));
    }
    if (opts.kind === 'fifo') return new StreamSource(Object.assign({}, opts, { mode: 'fifo' }));
    return new DemoSource(opts);
}

module.exports = { createSource, DEFAULT_HOST, DEFAULT_PORT, DEFAULT_FIFO, atlasSize };
