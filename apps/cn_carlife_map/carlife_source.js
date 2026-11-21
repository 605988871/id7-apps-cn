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
 *   demo    - a built-in moving test picture, no external service needed
 *   carlife - CarLife's own picture, from the capture side over a local
 *             socket (see CarlifeSource below)
 *   tcp     - framed atlases over TCP (connect or listen, see config file)
 *   fifo    - framed atlases from a local named pipe
 *
 * Wire format for carlife / tcp / fifo, all little endian:
 *   u32 magic = 0x464d4c43 ('CLMF')
 *   u32 len   = number of atlas bytes (must be w * (h + h/2))
 *   u32 seq   - frame number, informational
 *   bytes[len] - the atlas
 */

const net = require('net');
const fs = require('fs');
const pathmod = require('path');
const EventEmitter = require('events');
const { demoAtlas, arrowAtlas, activityAtlas, liveCardAtlas, waitingAtlas, atlasSize } = require('./atlas');

const MAGIC = 0x464d4c43;
const HEAD = 12;
const MAX_PACKET = 8 * 1024 * 1024;
const BACKOFF = [500, 1000, 2000, 4000];

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 20558;
const DEFAULT_FIFO = '/dev/shm/carlife-map/frames.fifo';
/* Where the capture side delivers CarLife's picture. Under /dev/shm so it is
 * always there, and a unix socket rather than TCP so no port is exposed. */
const DEFAULT_SOCK = '/dev/shm/carlife-map/live.sock';
const CARLIFE_PORT = 20559;

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

/* What the test card cycles through, one every few seconds: the shapes a HUD
 * has to survive. A u-turn with three lanes says something a left turn with one
 * does not, and a card that only ever shows "left, 300 m" hides every
 * alignment bug in the rest of it. */
const CARD_SCENES = [
    { dir: 'left', dist: '300', unit: 'M', road: 'CHANGAN AVE',
      lanes: ['left', 'straight', 'straight'], active: 0, limit: '60' },
    { dir: 'straight', dist: '1.2', unit: 'KM', road: 'G42 SHANGHAI',
      lanes: ['straight', 'straight', 'slight-right'], active: 1, limit: '120' },
    { dir: 'right', dist: '120', unit: 'M', road: 'NANJING RD',
      lanes: ['straight', 'right', 'right'], active: 1, limit: '80' },
    { dir: 'slight-left', dist: '500', unit: 'M', road: 'XINHUA ROAD',
      lanes: ['slight-left', 'straight'], active: 0, limit: '40' },
    { dir: 'uturn', dist: '200', unit: 'M', road: 'RING ROAD',
      lanes: ['uturn', 'left-straight', 'straight'], active: 0, limit: '50' },
    { dir: 'straight', dist: '80', unit: 'M', road: 'GARAGE',
      lanes: ['left', 'straight', 'right'], active: 1, limit: '' }
];

/** A moving picture made on the head unit: proves the whole rendering path. */
class DemoSource extends FrameSource {
    constructor(opts) {
        super(opts);
        /* 'map' is the scrolling test map; 'arrow' is the HUD's turn card. They
         * are different pictures at different sizes, not one picture cropped
         * twice - the HUD card exists so the shape can be judged before any
         * picture source does. */
        this.draw = opts.draw === 'arrow' ? 'arrow' : 'map';
        this.card = opts.card || {};
        this.opt = { dir: 'left' };
    }

    _start() {
        this.emit('status', this.draw === 'arrow' ? 'demo turn card' : 'demo picture');
        const period = Math.max(33, Math.round(1000 / this.fps));
        let buf = null;
        this.tick = 0;
        this.timer = setInterval(() => {
            if (!this.running) return;
            try {
                const t = this.tick++;
                if (this.draw === 'arrow') {
                    /* One scene every seven seconds, so the card can be watched
                     * rather than studied. */
                    const sc = CARD_SCENES[Math.floor(t / (this.fps * 7)) % CARD_SCENES.length];
                    const o = this.opt;
                    o.dir = sc.dir; o.dist = sc.dist; o.unit = sc.unit; o.road = sc.road;
                    o.lanes = sc.lanes; o.active = sc.active; o.limit = sc.limit;
                    o.detail = this.card.detail;
                    buf = arrowAtlas(buf, this.w, this.h, t, o);
                } else {
                    buf = demoAtlas(buf, this.w, this.h, t);
                }
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

/** node 8 has no fs.mkdirSync({recursive:true}). */
function mkdirp(dir) {
    const parts = pathmod.resolve(dir).split(pathmod.sep);
    let cur = pathmod.sep;
    for (let i = 1; i < parts.length; i++) {
        cur = pathmod.join(cur, parts[i]);
        try { fs.mkdirSync(cur, 0o777); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    }
}

/** Who owns the directory a socket would live in.
 *
 * Creating a unix socket needs write permission on the directory, not on the
 * socket - and mkdirp's 0777 is cut down by the umask to 0755, owned by
 * whoever got there first. The decoder runs as root and starts at boot; the app
 * does not, so it finds a directory it cannot bind in and gets EACCES, which
 * sounds like "the address is taken" and is the opposite of it. The owner and
 * the mode are the whole story, so they are printed with the error. */
function dirFacts(p) {
    const dir = pathmod.dirname(p);
    try {
        const st = fs.statSync(dir);
        return dir + ' is uid ' + st.uid +
            ' mode ' + ('000' + (st.mode & 0o777).toString(8)).slice(-3);
    } catch (e) {
        return dir + ': ' + (e.code || e.message);
    }
}

/** Is this the start of an Annex B NAL unit (H.264 as CarLife sends it)? */
function looksLikeH264(b) {
    if (b.length < 3) return false;
    if (b[0] !== 0 || b[1] !== 0) return false;
    return b[2] === 1 || (b.length >= 4 && b[2] === 0 && b[3] === 1);
}

/**
 * CarLife's own picture.
 *
 * CarLife sends one H.264 stream over USB (AOA) and decodes it inside its own
 * process, so the only way to a second screen is to copy that stream out and
 * decode it again. The copying is done by a preload library in the carlife
 * process (kit/carlife-tap); this class is the receiving end.
 *
 * Two kinds of data can arrive, and saying which is the whole point of this
 * source, because both look identical from the outside - a black cluster:
 *
 *   CLMF, decoded frames  the capture side (or an external decoder) writes
 *                         atlases; they are drawn as they are.
 *   raw H.264             the stream is flowing but nothing decodes it. The
 *                         bytes and keyframes are counted and printed on the
 *                         cluster instead, so "capture works, decoder missing"
 *                         cannot be mistaken for "nothing is connected".
 *
 * Who connects: whoever captures. The app listens, so the order of start does
 * not matter - the capture side retries and drops in when it can.
 */
class CarlifeSource extends FrameSource {
    constructor(opts) {
        super(opts);
        this.sockPath = opts.sockPath || DEFAULT_SOCK;
        this.host = opts.host || null;          /* set only by an override file */
        this.port = opts.port || CARLIFE_PORT;
        this.server = null;
        this.client = null;
        this.buf = Buffer.alloc(0);
        /* CLMF frames arrive in stream-socket chunks. Keep the chunks whole
         * until a frame is complete instead of copying a growing partial frame
         * on every data event - see _feed. */
        this.parts = [];
        this.partLen = 0;
        this.remote = '';
        this.format = '';                       /* '', 'clmf' or 'h264' */
        this.h264Bytes = 0;
        this.h264Idr = 0;
        this.h264Nal = 0;
        this.h264Starts = 0;
        this.prevBytes = 0;
        this.mbps = 0;
        this.p0 = 0;
        this.p1 = 0;
        this.actBuf = null;
        this.actTick = 0;
        this.actSeen = -1;
        this.waitTick = 0;
        /* What has actually arrived. `live` counts real pictures and
         * `lastLiveAt` says when the last one did: the status pages exist for
         * the case where those two say nothing, and they must not replace a
         * picture that is working. */
        this.live = 0;
        this.lastLiveAt = 0;
        /* The last CLMF payload that was not the layer's size. The decoder
         * sends what crop.json asked for, so a mismatch here is the one thing
         * that turns a working decoder into an empty layer - and it is a
         * number, which is worth printing. */
        this.badLen = 0;
        /* Why the listening socket could not be opened, if it could not: the
         * one line that separates "the decoder never came" from "this app was
         * never able to listen for it". */
        this.listenErr = '';
        /* One short line for the waiting picture, set by the app from the
         * reports it can read and this one cannot. */
        this.note = '';
        /* How big that page's words are and where they sit, as the app's
         * settings have it: {scale, x, y}, percent of the designed face and of
         * the picture. Null means "as drawn". */
        this.text = null;
        this.countTimer = null;
        this.actTimer = null;
    }

    _start() {
        this.parts = [];
        this.partLen = 0;
        /* A retry runs _start again, and these two intervals are the only
         * things here that outlive a failed attempt: without this, every
         * backoff step added another 200 ms ticker and another rate timer,
         * and the app spent its budget drawing status pages for sockets that
         * were closed. */
        this._timers();
        if (this.host) this._connect();
        else this._listen();
        /* Once a second: turn the byte counter into a rate, and say what the
         * stream is. A silent source is indistinguishable from a dead one
         * without this. */
        this.countTimer = setInterval(() => {
            const d = this.h264Bytes - this.prevBytes;
            this.prevBytes = this.h264Bytes;
            this.mbps = d / 1048576;
            if (this.format === 'h264') {
                this.emit('status', 'H.264 ' + (this.h264Bytes / 1048576).toFixed(1) +
                    'MB ' + this.h264Idr + ' IDR ' + this.mbps.toFixed(2) + 'MB/s' +
                    ' (needs a decoder)');
            }
        }, 1000);
        if (this.countTimer.unref) this.countTimer.unref();
        this.actTimer = setInterval(() => this._activity(), 200);
        if (this.actTimer.unref) this.actTimer.unref();
    }

    _timers() {
        if (this.countTimer) { clearInterval(this.countTimer); this.countTimer = null; }
        if (this.actTimer) { clearInterval(this.actTimer); this.actTimer = null; }
    }

    _stop() {
        this._timers();
        if (this.client) { try { this.client.destroy(); } catch (e) {} this.client = null; }
        if (this.server) {
            try { this.server.close(); } catch (e) {}
            this.server = null;
            try { fs.unlinkSync(this.sockPath); } catch (e) {}
        }
        this.buf = Buffer.alloc(0);
        this.parts = [];
        this.partLen = 0;
    }

    _connect() {
        const s = net.connect({ host: this.host, port: this.port });
        this._attach(s, 'tcp ' + this.host + ':' + this.port);
    }

    _listen() {
        const dir = pathmod.dirname(this.sockPath);
        try { mkdirp(dir); } catch (e) { this._fail('mkdir ' + dir + ': ' + e.message); return; }
        try { fs.unlinkSync(this.sockPath); } catch (e) { /* stale socket from a crash */ }

        const srv = net.createServer((s) => {
            if (this.client) { s.destroy(); return; }      /* one capture at a time */
            this._attach(s, s.remoteAddress || 'local');
        });
        this.server = srv;
        /* Not _fail: a listening socket that cannot be created is usually a
         * directory owned by someone else, and the tool's install hook (or the
         * decoder, from 0.4.7 on) fixes exactly that within seconds. Giving up
         * here means waiting for a reboot to pick up a permission change. */
        srv.on('error', (e) => {
            /* Node's own message repeats the path the line already names
             * ("listen EACCES /dev/shm/..."), so only the errno is kept; for a
             * permission failure the directory's owner is the part to read,
             * and it goes on the same line because that is all the screen has
             * room for. */
            const denied = e.code === 'EACCES' || e.code === 'EPERM';
            const why = (e.code || e.message) + (denied ? ', ' + dirFacts(this.sockPath) : '');
            this.listenErr = why;
            this._retry('listen ' + this.sockPath + ': ' + why);
        });
        srv.listen(this.sockPath, () => {
            this.retry = 0;
            this.listenErr = '';
            try { fs.chmodSync(this.sockPath, 0o666); } catch (e) {}
            this.emit('status', 'waiting for CarLife (' + this.sockPath + ')');
        });
    }

    _attach(s, label) {
        this.client = s;
        this.buf = Buffer.alloc(0);
        this.parts = [];
        this.partLen = 0;
        this.remote = label;
        this.emit('status', 'capture connected: ' + label);
        s.on('data', (d) => { try { this._feed(d); } catch (e) { this._fail('feed: ' + e.message); } });
        s.on('error', () => {});
        const gone = () => {
            if (this.client !== s) return;
            this.client = null;
            this.buf = Buffer.alloc(0);
            this.format = '';
            this.emit('status', 'capture went away, waiting');
        };
        s.on('close', gone);
        s.on('end', gone);
    }

    _feed(d) {
        if (!this.running) return;
        if (!this.format) {
            const head = this.buf.length ? Buffer.concat([this.buf, d]) : d;
            this.buf = head;
            if (head.length < 4) return;
            if (head.readUInt32LE(0) === MAGIC) {
                this.format = 'clmf';
                this.emit('status', 'decoded frames from ' + this.remote);
            } else if (looksLikeH264(head)) {
                this.format = 'h264';
                this.emit('status', 'H.264 stream from ' + this.remote);
            } else {
                /* Unknown: drop a byte and look again, the way the framed
                 * parser resynchronises on a magic marker. */
                this.buf = head.slice(1);
                if (this.buf.length > MAX_PACKET) this.buf = Buffer.alloc(0);
                return;
            }
            d = this.buf;
            this.buf = Buffer.alloc(0);
            if (!d.length) return;
        }
        if (this.format === 'h264') { this._takeH264(d); return; }

        /* A full map frame is 783 KB but a stream socket may deliver it in
         * 64 KB pieces. Copying every piece into one growing buffer used to
         * move about half a megabyte per piece; keep the pieces whole and
         * assemble only when the parser actually needs the bytes. */
        if (d && d.length) { this.parts.push(d); this.partLen += d.length; }
        for (;;) {
            if (this.buf.length < HEAD) {
                const want = HEAD - this.buf.length;
                if (this.partLen < want) break;
                this._takeParts(want);
            }
            const magic = this.buf.readUInt32LE(0);
            if (magic !== MAGIC) { this.buf = this.buf.slice(1); continue; }
            const len = this.buf.readUInt32LE(4);
            if (len < 1 || len > MAX_PACKET) { this.buf = this.buf.slice(4); continue; }
            const need = HEAD + len - this.buf.length;
            if (need > 0) {
                if (this.partLen < need) break;
                this._takeParts(need);
            }
            const payload = this.buf.slice(HEAD, HEAD + len);
            this.buf = this.buf.slice(HEAD + len);
            if (len === this.expected) {
                this.badLen = 0;
                this._frame(payload);
            } else {
                this.badLen = len;
                this.emit('status', 'frame size ' + len + ', want ' + this.expected);
            }
        }
        if (this.buf.length > MAX_PACKET + HEAD) this.buf = Buffer.alloc(0);
    }

    /** Move n bytes from the socket's chunks into the parser's buffer. */
    _takeParts(n) {
        const take = [];
        let left = n;
        while (left > 0 && this.parts.length) {
            const p = this.parts[0];
            if (p.length <= left) {
                take.push(p);
                this.parts.shift();
                this.partLen -= p.length;
                left -= p.length;
            } else {
                take.push(p.slice(0, left));
                this.parts[0] = p.slice(left);
                this.partLen -= left;
                left = 0;
            }
        }
        if (!take.length) return;
        this.buf = this.buf.length ? Buffer.concat([this.buf].concat(take))
                  : (take.length === 1 ? take[0] : Buffer.concat(take));
    }

    /* Every real picture, counted before it is emitted: this is the signal
     * that the status pages are no longer needed. */
    _frame(buf) {
        if (this.running && buf && buf.length === this.expected) {
            this.live++;
            this.lastLiveAt = Date.now();
        }
        super._frame(buf);
    }

    /** Count the stream and its keyframes; nothing is decoded here. */
    _takeH264(d) {
        this.h264Bytes += d.length;
        for (let i = 0; i < d.length; i++) {
            const c = d[i];
            if (this.p0 === 0 && this.p1 === 0 && c === 1) {
                this.h264Nal++;
                if (i + 1 < d.length) {
                    const t = d[i + 1] & 0x1f;
                    if (t === 5) this.h264Idr++;              /* IDR slice */
                    else if (t === 7 || t === 8) this.h264Starts++;  /* SPS/PPS: a stream begins */
                }
            }
            this.p0 = this.p1;
            this.p1 = c;
        }
    }

    /* The cluster never goes black while CarLife is selected.
     *
     * Three states, three pictures: waiting for the capture side, H.264
     * arriving but not decodable, real frames (which come from _feed and skip
     * this entirely). An empty layer would make all three look alike.
     *
     * The last picture is re-sent even when nothing changes: a stopped stream
     * must not let the layer look stalled, and an identical frame costs
     * nothing against the service's dirty-tile budget. */
    /* Two shapes of the same report. The cluster gets the full page; the HUD
     * card, a third of its height, would lose the lower half of it. */
    _statusAtlas(buf, tick, mb, note) {
        if (this.h >= 240) {
            if (note) return waitingAtlas(buf, this.w, this.h, tick, note, this.text);
            return activityAtlas(buf, this.w, this.h, tick, mb, this.h264Idr, this.mbps);
        }
        return liveCardAtlas(buf, this.w, this.h, tick, mb, this.text, note);
    }

    _activity() {
        if (!this.running) return;
        /* A picture that is arriving is left alone. These pages exist for the
         * gap where nothing arrives; drawing one over a working map would be
         * the very bug they are meant to report. */
        if (this.live > 0 && Date.now() - this.lastLiveAt < 2000) return;

        if (this.format === 'h264') {
            if (this.h264Bytes !== this.actSeen) {
                this.actSeen = this.h264Bytes;
                this.actBuf = this._statusAtlas(this.actBuf, this.actTick++,
                    this.h264Bytes / 1048576, '');
            } else if (!this.actBuf) {
                this.actBuf = this._statusAtlas(this.actBuf, this.actTick++, 0, '');
            }
        } else if (this.format === 'clmf') {
            /* Frames arrive in a container we understand and not one of them
             * is the layer's size - or they have stopped. Either way the layer
             * is being fed nothing, and on the cluster that looks exactly like
             * a decoder that was never installed. The size is the number to
             * act on, so it goes on the screen. */
            this.waitTick = (this.waitTick + 1) % 1000000;
            if (this.waitTick % 3) return;
            this.actBuf = this._statusAtlas(this.actBuf, this.actTick++, 0,
                this.badLen ? 'FRAME ' + this.badLen + ' WANT ' + this.expected
                            : 'DECODER SENT NOTHING FOR 2S');
        } else {
            this.waitTick = (this.waitTick + 1) % 1000000;
            if (this.waitTick % 3) return;          /* once every 600 ms is enough */
            this.actBuf = this._statusAtlas(this.actBuf, this.actTick++, 0, this.note);
        }
        this.frames++;
        this.emit('frame', this.actBuf, this.seq++);
    }

    /** One line for the status page. */
    detail() {
        if (!this.running) return 'stopped';
        /* "No decoder on the socket" and "I could not open the socket" are
         * different failures with different fixes, and the second one is what
         * a wrong directory owner looks like from here. */
        if (this.listenErr) return 'socket not opened (' + this.listenErr + ')';
        if (!this.client) return 'nothing connected on ' + this.sockPath + ' yet';
        if (this.format === 'h264') {
            return 'H.264 ' + (this.h264Bytes / 1048576).toFixed(1) + 'MB ' +
                this.h264Idr + ' IDR ' + this.mbps.toFixed(2) + 'MB/s, no decoder';
        }
        if (this.format === 'clmf') {
            return this.live + ' pictures' + (this.badLen
                ? ', last frame ' + this.badLen + ' want ' + this.expected
                : ', ' + this.remote);
        }
        return 'connected, reading header';
    }
}

/**
 * opts: { w, h, fps, kind, host, port, path, sockPath }. `kind` is 'demo',
 * 'carlife', 'tcp' or 'fifo'. 'tcp' connects to host:port by default; set
 * opts.tcpListen = true to listen.
 */
function createSource(opts) {
    if (opts.kind === 'tcp') {
        return new StreamSource(Object.assign({}, opts, { mode: opts.tcpListen ? 'tcp-listen' : 'tcp-connect' }));
    }
    if (opts.kind === 'fifo') return new StreamSource(Object.assign({}, opts, { mode: 'fifo' }));
    if (opts.kind === 'carlife') return new CarlifeSource(opts);
    return new DemoSource(opts);
}

module.exports = {
    createSource, CarlifeSource, mkdirp,
    DEFAULT_HOST, DEFAULT_PORT, DEFAULT_FIFO, DEFAULT_SOCK, CARLIFE_PORT,
    atlasSize
};
