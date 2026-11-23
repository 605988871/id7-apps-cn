'use strict';
/**
 * Wi-Fi page inside the CarLife app - join the phone's hotspot without
 * leaving the app and without opening MGU Store.
 *
 * mgu-uplink owns Wi-Fi on the unit. Its control socket is root-only and the
 * updater only relays Wi-Fi requests for the Store app, so a plain OAP app
 * cannot reach it. The root `wifi-bridge` helper in the carlife-wireless
 * component listens on a unix socket under /dev/shm and forwards our five
 * Wi-Fi operations to the uplink. This module is the JS half: it reads the
 * uplink's public status.json for the network list, sends the requests, and
 * uses the HMI's own speller for a password (falling back to the app setting).
 *
 * No passwords are logged or drawn. The reply from the uplink is shown as-is
 * when it fails, so a short password or a wrong band is understandable.
 *
 * The page remembers the last joined SSID (and the password when one was
 * typed) so the app can reconnect automatically on the next launch.
 *
 * Every tappable control sits inside the app's safe touch area: the iDrive 7
 * HMI keeps a back-arrow column on the left (x < 84) and its status icons on
 * the top right (x > 1340, y < 76). Anything drawn there is shown but its
 * taps go to the HMI, so keep all buttons at x >= 100, y >= 90.
 */
const fs = require('fs');
const net = require('net');
const { spell } = require('./speller');

const STATUS = '/run/mgu-uplink/status.json';
const WIFI_SOCK = '/dev/shm/carlife-wireless/wifi.sock';
const MAX_ROWS = 8;
const TIMEOUT_MS = 9000;

function signalText(dbm) {
    if (typeof dbm !== 'number') return '';
    if (dbm >= -55) return '强';
    if (dbm >= -70) return '中';
    return '弱';
}

class WifiPage {
    constructor(ctx, settings, onBack) {
        this.ctx = ctx;
        this.settings = settings;
        this.onBack = onBack;
        this.networks = [];
        this.wifi = null;
        this.msg = '';
        this.busy = false;
        this.zones = [];
        this.refresh();
    }

    /* status.json is 0644 and written by mgu-uplink; no request needed. */
    refresh() {
        try {
            const st = JSON.parse(fs.readFileSync(STATUS, 'utf8'));
            this.wifi = st.wifi || null;
            this.networks = (this.wifi && Array.isArray(this.wifi.networks)) ? this.wifi.networks.slice(0, MAX_ROWS) : [];
            if (!this.msg) this.msg = this.wifi ? '' : '未检测到 mgu-uplink，请先安装 MGU 商店组件';
        } catch (e) {
            this.wifi = null;
            this.networks = [];
            if (!this.msg) this.msg = '未检测到 mgu-uplink，请先安装 MGU 商店组件';
        }
    }

    /* One JSON line in, one JSON line back - the uplink's ctl protocol. */
    request(req) {
        return new Promise((resolve) => {
            let sock;
            try {
                sock = net.connect(WIFI_SOCK);
            } catch (e) {
                resolve({ ok: false, error: 'Wi-Fi 服务未启动' });
                return;
            }
            let buf = '';
            let done = false;
            const finish = (value) => {
                if (done) return;
                done = true;
                clearTimeout(timer);
                try { sock.destroy(); } catch (e) { /* already closed */ }
                resolve(value);
            };
            const timer = setTimeout(() => finish({ ok: false, error: '请求超时' }), TIMEOUT_MS);
            sock.setEncoding('utf8');
            sock.on('connect', () => sock.write(JSON.stringify(req) + '\n'));
            sock.on('data', (d) => {
                buf += d;
                const nl = buf.indexOf('\n');
                if (nl < 0) return;
                try { finish(JSON.parse(buf.slice(0, nl))); }
                catch (e) { finish({ ok: false, error: '无效回复' }); }
            });
            sock.on('error', () => finish({ ok: false, error: 'Wi-Fi 服务未启动' }));
            sock.on('close', () => finish({ ok: false, error: 'Wi-Fi 服务断开' }));
        });
    }

    async toggle() {
        if (!this.wifi) { this.msg = '未检测到 mgu-uplink'; return; }
        this.busy = true;
        const r = await this.request({ op: 'wifi-enable', on: !this.wifi.enabled });
        this.busy = false;
        this.msg = r.ok ? (this.wifi.enabled ? 'Wi-Fi 已关闭' : 'Wi-Fi 已开启，正在扫描') : ('操作失败：' + (r.error || '未知错误'));
        this.refresh();
    }

    async scan() {
        this.busy = true;
        if (this.wifi && !this.wifi.enabled) {
            const on = await this.request({ op: 'wifi-enable', on: true });
            if (!on.ok) { this.busy = false; this.msg = '开启 Wi-Fi 失败：' + (on.error || '未知错误'); return; }
        }
        this.msg = '正在扫描附近热点…';
        const r = await this.request({ op: 'wifi-scan' });
        this.busy = false;
        this.msg = r.ok ? '扫描完成，选择手机热点' : ('扫描失败：' + (r.error || '未知错误'));
        /* The uplink writes networks into status.json asynchronously. */
        setTimeout(() => { this.refresh(); }, 1200);
    }

    /* The single connection path used both by a tap on a network and by the
     * app's automatic reconnect at launch. Remembers the SSID on success. */
    async connect(ssid, psk) {
        if (this.busy) return { ok: false, error: '正在处理中' };
        this.busy = true;
        this.msg = '正在连接 ' + ssid + '…';
        const r = await this.request({ op: 'wifi-connect', ssid, psk: psk || '' });
        this.busy = false;
        if (r && r.ok) {
            try { this.settings.set('wifi_ssid', ssid); } catch (e) { /* read-only */ }
            this.msg = '已连接 ' + ssid;
        } else {
            this.msg = '连接失败：' + ((r && r.error) || '未知错误');
        }
        this.refresh();
        return r;
    }

    async join(net) {
        if (this.busy) return;
        let psk = '';
        if (net.secure && !net.saved) {
            /* The HMI's own full-screen speller is what the Store uses for a
             * password. Some units do not offer it; fall back to the setting. */
            try {
                psk = String(await spell(this.ctx.app, '热点密码') || '');
            } catch (e) {
                psk = '';
            }
            if (!psk) psk = String(this.settings.get('wifi_psk') || '').trim();
            if (!psk) {
                this.msg = '请在 设置 → 热点密码 填入密码后重试';
                return;
            }
        }
        /* Keep the password for next launch's automatic reconnect. */
        if (psk) { try { this.settings.set('wifi_psk', psk); } catch (e) { /* read-only */ } }
        const r = await this.connect(net.ssid, psk);
        /* Back to the picture as soon as the connect was accepted; DHCP takes a
         * moment and the stream service picks up the lease on its own. */
        if (r && r.ok) {
            setTimeout(() => { try { this.onBack(); } catch (e) { /* app closing */ } }, 2500);
        }
    }

    /* Draw into the canvas main.js already cleared. Record tap zones as we go. */
    render(cv, t, W, H) {
        const fg = (t && (t.fg || t.text)) || '#ffffff';
        const dim = '#9aa0a6';
        this.zones = [];
        const zone = (x, y, w, h, fn) => this.zones.push({ x, y, w, h, fn });

        /* All content starts below the HMI header and right of the back column
         * (safe area: x >= 100, y >= 90 on the 1600x720 canvas). */
        cv.text('连接手机热点', 100, 104, 34, fg, { literal: true });

        const w = this.wifi;
        const line = !w ? 'mgu-uplink 未运行'
            : w.link === 'online' ? ('已连接 ' + (w.ssid || '') + (w.ip ? ' · ' + w.ip : ''))
                : w.link === 'connected' ? ('已关联 ' + (w.ssid || '') + '（等待分配 IP）')
                    : w.enabled ? ('Wi-Fi 已开启 · ' + (w.link || 'idle')) : 'Wi-Fi 已关闭';
        cv.text(line, 100, 142, 22, dim, { literal: true });

        const by = 176;
        this.button(cv, 100, by, 280, 64, w && w.enabled ? '关闭 Wi-Fi' : '开启 Wi-Fi', () => this.toggle());
        zone(100, by, 280, 64, () => this.toggle());
        this.button(cv, 400, by, 200, 64, '扫描', () => this.scan());
        zone(400, by, 200, 64, () => this.scan());
        this.button(cv, W - 340, by, 240, 64, '返回画面', () => this.onBack());
        zone(W - 340, by, 240, 64, () => this.onBack());

        cv.text(this.busy ? (this.msg || '处理中…') : (this.msg || '选择手机的热点名称'),
            100, 274, 20, this.msg && /失败|未|请/.test(this.msg) ? '#f59e0b' : dim, { literal: true });

        const top = 300, rh = 52;
        if (!this.networks.length) {
            cv.text('没有看到热点。打开手机热点与百度 CarLife，然后点击“扫描”。', 112, top + 30, 20, dim, { literal: true });
        }
        this.networks.forEach((n, i) => {
            const y = top + i * rh;
            cv.roundRect(100, y, W - 200, rh - 6, 10, i % 2 ? '#1f2937' : '#273244');
            cv.text(n.ssid || '(未命名)', 124, y + 32, 21, fg, { literal: true });
            const tags = [];
            if (n.secure) tags.push('加密');
            if (n.saved) tags.push('已保存');
            if (n.current) tags.push('当前');
            const sig = signalText(n.signal);
            if (sig) tags.push('信号' + sig);
            cv.text(tags.join(' · '), W - 124, y + 32, 18, dim, { align: 'right', literal: true });
            zone(100, y, W - 200, rh - 6, () => this.join(n));
        });

        cv.text('加密热点首次连接可用车机键盘输入密码；也可在 设置 → 热点密码 中预设。',
            100, H - 28, 17, dim, { literal: true });
    }

    button(cv, x, y, w, h, label, fn) {
        cv.roundRect(x, y, w, h, 12, '#3b82f6');
        cv.text(label, x + w / 2, y + h / 2 + 8, 21, '#ffffff', { align: 'center', literal: true });
    }

    /* phase 1 down is enough: these are all tap targets, no dragging. */
    touch(phase, x, y) {
        if (phase !== 1 || this.busy) return true;
        for (const z of this.zones) {
            if (x >= z.x && x <= z.x + z.w && y >= z.y && y <= z.y + z.h) {
                z.fn();
                return true;                 /* keep the gesture away from the kit */
            }
        }
        return true;
    }
}

module.exports = { WifiPage };
