'use strict';
/**
 * When the waiting page is switched off, which layer should step aside?
 *
 * This is kept out of main.js so the decision can be checked on a bench: a
 * hidden layer still receives frames (the service does not call it stalled),
 * but BMW's own picture underneath shows through until a real one arrives.
 *
 * A CarLife source has a `live` counter and `lastLiveAt`. The source itself
 * stops drawing its status page once a real frame is under two seconds old
 * (carlife_source.js, _activity); this uses the same rule, so the layer is
 * hidden exactly while that page would have been on the glass. Sources that
 * never draw a waiting page (demo, TCP, FIFO) are left alone.
 */
const STALE_MS = 2000;

function hasPicture(src, now) {
    return !!(src && src.live > 0 && now - src.lastLiveAt < STALE_MS);
}

/** `which` is 'map' or 'hud'. `o` carries the settings and both sources. */
function hide(which, o) {
    const opt = o || {};
    if (opt.showWait !== false) return false;             // default: show the page
    if ((opt.kind || 'carlife') !== 'carlife') return false;
    const now = typeof opt.now === 'number' ? opt.now : Date.now();
    if (which === 'map' || (opt.hudMode || 'navi') === 'map') {
        return !hasPicture(opt.source, now);
    }
    return !hasPicture(opt.card, now);                    // the HUD's own card stream
}

module.exports = { hasPicture, hide };
