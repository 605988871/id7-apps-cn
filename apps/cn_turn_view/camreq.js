'use strict';
/*
 * Asking the camera ECU for a view.
 *
 * The camera does not stream by itself: something has to attach to
 * ICAM2Proxy and change its state to "the drive recorder is active, in mosaic
 * mode, showing this perspective". Turn View (IterioDev/car-apps) does exactly
 * that for the front camera; the calls below are the same ones, with the view
 * taken from a setting instead of being fixed.
 *
 * The one thing this file cannot know is which perspective numbers the side
 * cameras have. BMW's own Drive Recorder asks for 1 (front), 2 (rear), 5
 * (front + rear) and 7 (all); the parking side view is a different application
 * ('SIDEVIEW'). Both are offered as settings, and the status page reports what
 * the ECU answers, so one session in the car settles which combination this
 * unit accepts.
 *
 * Every promise here resolves even when the call fails: a camera that cannot be
 * asked for must leave the app running and say so, not reject into a crash.
 */
const EventEmitter = require('events');

const IF = {
    cam: ['de.bmw.infotainment.video.cameraproxy.CameraProxy', '1'],
    icam: ['de.bmw.infotainment.video.cameraproxy.ICAM2Proxy', '1'],
    xv: ['de.bmw.dass.XView3D', '1']
};
/* Wire numbers, for the second attempt when the proxy refuses enum names. */
const WIRE = { CLIENT_INDIRECT: 1, DR_ACTIVE: 51, SIDEVIEW: 2, MODE_MOSAIK: 50 };
const RETRY_MS = 30000;

const errText = (e) => String((e && e.message) || e).slice(0, 160);

function create(o) {
    const log = o.log || (() => {});
    const builders = o.someipBuilders;
    const api = new EventEmitter();
    const px = {}, link = {};
    let cookie = null, attaching = null;
    let state = 'idle', text = '还没请求', asked = '';
    let ecu = null;
    let timer = null;

    function set(s, t) {
        if (s === state && t === text) return;
        state = s;
        text = t;
        log('camera: ' + s + ' (' + t + ')');
        api.emit('change', api.status());
    }

    function connect(name) {
        if (!builders) {
            link[name] = 'no SDK';
            return;
        }
        link[name] = 'connecting';
        Promise.resolve()
            .then(() => builders.buildAndInitTypedProxy(IF[name][0], IF[name][1], 10000))
            .then((p) => {
                px[name] = p;
                link[name] = 'ok';
                log('camera: ' + name + ' connected');
            }, (e) => {
                link[name] = 'ERR ' + errText(e);
                log('camera: ' + name + ' not there (' + errText(e) + '), again in 30 s');
                setTimeout(() => connect(name), RETRY_MS);
            });
    }

    /* Getters, not notifiers: an app's notifier often never fires. */
    const get = (name, field) => (px[name]
        ? Promise.resolve().then(() => px[name][field].getValue()).catch(() => undefined)
        : Promise.resolve(undefined));

    /* Enum arguments by name; once more as wire numbers if the proxy refuses
     * the name. Both forms appear in BMW's own clients. */
    const named = (fn, byName, byNumber) => Promise.resolve().then(() => fn(byName))
        .catch((e) => {
            log('camera: enum names refused (' + errText(e) + '), trying numbers');
            return fn(byNumber);
        });

    /* CameraProxy is never offered on its own on this unit (ICAM2Proxy extends
     * it), so clientAttach/clientDetach live on ICAM2Proxy. Without a typed
     * method the call goes through the SDK proxy's own callMethod. */
    function camCall(method, args) {
        if (px.cam && typeof px.cam[method] === 'function') return px.cam[method](args);
        if (!px.icam) return Promise.reject(new Error('ICAM2Proxy not connected'));
        if (typeof px.icam[method] === 'function') return px.icam[method](args);
        if (px.icam._someIpProxy) return px.icam._someIpProxy.callMethod(method, args, 10000);
        return Promise.reject(new Error('ICAM2Proxy has no ' + method));
    }

    /* Attached as the camera ECU's indirect client: one cookie, and a second
     * request waits for the attach under way. */
    function attach() {
        if (cookie !== null) return Promise.resolve(cookie);
        if (attaching) return attaching;
        attaching = named((a) => camCall('clientAttach', a),
            { type: 'CLIENT_INDIRECT' }, { type: WIRE.CLIENT_INDIRECT })
            .then((r) => {
                attaching = null;
                cookie = r && typeof r === 'object' ? r.cookie : r;
                log('camera: attached, cookie ' + cookie);
                return cookie;
            }, (e) => {
                attaching = null;
                throw e;
            });
        return attaching;
    }

    function release() {
        return Promise.resolve(attaching).catch(() => null).then(() => {
            if (cookie === null) return null;
            const c = cookie;
            return Promise.resolve().then(() => camCall('clientDetach', { cookie: c }))
                .then(() => {
                    cookie = null;
                    log('camera: released (cookie ' + c + ')');
                    set('idle', '已释放');
                }, (e) => log('camera: release failed: ' + errText(e)));
        });
    }

    /* One request. application: 'SIDEVIEW' or 'DR_ACTIVE'; perspective: the
     * view number. Resolves with the same shape whatever happens. */
    function request(application, perspective) {
        const app = application || 'SIDEVIEW';
        const p = Math.max(1, Math.min(63, Number(perspective) || 1));
        const appNo = WIRE[app] || Number(app) || 1;
        const st = (a, m) => ({ cookie: cookie, desiredState: { application: a, mode: m, perspective: p } });
        if (!px.icam) {
            set('refused', '摄像头服务还没连上');
            return Promise.resolve(false);
        }
        set('asked', '请求 ' + app + '/' + p);
        return attach().then(() => named(
            (a) => px.icam.changeState(a),
            st(app, 'MODE_MOSAIK'),
            st(appNo, WIRE.MODE_MOSAIK)
        )).then(() => {
            asked = app + '/' + p;
            set('on', '已请求 ' + asked);
            return true;
        }).catch((e) => {
            set('refused', errText(e));
            log('camera: request ' + app + '/' + p + ' failed: ' + errText(e));
            return false;
        });
    }

    /* What the ECU says it is showing. Read only, for the status page: this is
     * where "the side view was accepted" or "a parking view has the cameras"
     * becomes a sentence instead of a guess. */
    function readState() {
        if (!px.icam && !px.xv) return Promise.resolve(ecu);
        return Promise.all([get('xv', 'CurrentState'), get('icam', 'currentState')]).then((both) => {
            const s = both.filter((x) => x && typeof x === 'object')[0];
            if (s) {
                ecu = s;
                api.emit('ecu', s);
            }
            return ecu;
        }).catch(() => ecu);
    }

    function start() {
        Object.keys(IF).forEach(connect);
        timer = setInterval(() => { readState(); }, 5000);
        if (timer.unref) timer.unref();
    }

    function stop() {
        if (timer) clearInterval(timer);
        timer = null;
    }

    api.status = () => ({
        state: state, text: text, asked: asked,
        cookie: cookie !== null, attached: cookie !== null,
        cam: link.cam || '-', icam: link.icam || '-', xv: link.xv || '-',
        ecu: ecu ? { application: String(ecu.application), mode: String(ecu.mode), perspective: String(ecu.perspective) } : null
    });
    api.start = start;
    api.stop = stop;
    api.request = request;
    api.release = release;
    api.readState = readState;
    return api;
}

module.exports = { create };
