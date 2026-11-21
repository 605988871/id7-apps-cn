'use strict';
/**
 * The "display waiting animation" switch, without a car:
 *
 *   node kit/tools/test_wait_toggle.js
 *
 * A waiting page carries the only diagnosis available on the glass, so the
 * default has to stay on. When it is off, only the layers with a real
 * waiting page (the CarLife sources) step aside; a demo/TCP/FIFO layer has
 * nothing to hide. The map and the HUD card have separate sources, so a card
 * that is still waiting must not put the words back on a HUD that is in
 * turn-card mode.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { hide, hasPicture } = require('../../apps/cn_carlife_map/wait_policy');

const ROOT = path.join(__dirname, '..', '..');
const NOW = 1000000;
const opts = (o) => Object.assign({
    showWait: true, kind: 'carlife', source: null, card: null,
    hudMode: 'navi', now: NOW
}, o || {});
const src = (at) => ({ live: 1, lastLiveAt: at });

/* On by default, including on an app whose saved settings predate the key. */
assert.strictEqual(hide('map', opts()), false, 'the default hides the waiting page');
assert.strictEqual(hide('hud', opts()), false, 'the default hides the HUD page');
assert.strictEqual(hide('map', opts({ showWait: undefined })), false,
    'an old setting without the key hid the page');

/* Only a CarLife source draws a waiting page. */
assert.strictEqual(hide('map', opts({ showWait: false, kind: 'demo' })), false);
assert.strictEqual(hide('hud', opts({ showWait: false, kind: 'tcp' })), false);
assert.strictEqual(hide('map', opts({ showWait: false, kind: 'fifo' })), false);

/* CarLife with no picture, with a fresh one, and with one that went stale. */
assert.strictEqual(hide('map', opts({ showWait: false })), true, 'no picture still showed the page');
assert.strictEqual(hide('hud', opts({ showWait: false })), true, 'no card still showed the page');
assert.strictEqual(hide('map', opts({ showWait: false, source: src(NOW - 500) })), false,
    'a fresh map was hidden');
assert.strictEqual(hide('map', opts({ showWait: false, source: src(NOW - 3000) })), true,
    'a stale map still showed the page');
assert.strictEqual(hide('map', opts({ showWait: true, source: src(NOW - 3000) })), false,
    'the switch on overrode a stale picture');

/* HUD: navi follows its own card stream, map mode follows the map. */
assert.strictEqual(hide('hud', opts({ showWait: false, source: src(NOW - 500), card: null })), true,
    'a HUD card that never arrived still showed the page');
assert.strictEqual(hide('hud', opts({ showWait: false, source: src(NOW - 500), card: src(NOW - 100) })), false,
    'a live card was hidden');
assert.strictEqual(hide('hud', opts({
    showWait: false, source: src(NOW - 500), card: null, hudMode: 'map'
})), false, 'map mode should not follow the missing card stream');

assert.strictEqual(hasPicture(null, NOW), false);
assert.strictEqual(hasPicture({ live: 0, lastLiveAt: NOW }, NOW), false);
assert.strictEqual(hasPicture(src(NOW - 1999), NOW), true);
assert.strictEqual(hasPicture(src(NOW - 2000), NOW), false);

/* The setting must be in the native settings page, in Chinese, and on by
 * default; the app must actually act on it (hiding a layer, not just storing
 * a flag). */
const spec = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps', 'cn_carlife_map', 'app.json'), 'utf8'));
const item = (spec.settings || []).filter((s) => s.key === 'showWait')[0];
assert.ok(item, 'no showWait setting in app.json');
assert.strictEqual(item.type, 'bool');
assert.strictEqual(item.default, true);
assert.ok(/[\u4e00-\u9fff]/.test(item.label || ''), 'the setting is not in Chinese');
const main = fs.readFileSync(path.join(ROOT, 'apps', 'cn_carlife_map', 'main.js'), 'utf8');
assert.ok(/waitPolicy\.hide\(/.test(main), 'main.js does not ask the policy');
assert.ok(/cr\.set\(ref, \{ visible: visible \? 1 : 0 \}\)/.test(main),
    'main.js does not hide the layer');
assert.ok(/'showWait'/.test(main), 'the app does not watch the setting for changes');

console.log('wait_toggle ok: default on, CarLife only, map/card separate, layers follow the switch');
