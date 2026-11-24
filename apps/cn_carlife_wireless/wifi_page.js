'use strict';
/**
 * Wi-Fi page inside the CarLife app - join the phone's hotspot without
 * leaving the app and without opening MGU Store.
 *
 * Why this is an HMI menu and not a drawn page: the stream needs pixel
 * images (renderd op 18), and that forces the connection into the upstream
 * dialect - where the renderer refuses touch claims ("CLAIM shares IMAGE's
 * message number"). A drawn page therefore cannot be tapped on the car: every
 * tap goes to the HMI. Native HMI rows can (cn_doom's own bar buttons work on
 * the same kind of screen), so the Wi-Fi page is a menu state in app.json and
 * this module only fills it in and answers its clicks.
 *
 * mgu-uplink owns Wi-Fi on the unit. Its control socket is root-only and the
 * updater only relays Wi-Fi requests for the Store app, so a plain OAP app
 * cannot reach it. The root `wifi-bridge` helper in the carlife-wireless
 * component listens on a unix socket under /dev/shm and forwards our Wi-Fi
 * operations to the uplink. This module is the JS half: it reads the uplink's
 * public status.json for the network list, sends the requests, and uses the
 * HMI's own speller for a password (falling back to the app setting).
 *
 * No passwords are logged or drawn. The reply from the uplink is shown as-is
 * when it fails, so a short password or a wrong band is understandable.
 *
 * The page remembers the last joined SSID (and the password when one was
 * typed) so the app can reconnect automatically on the next launch.
 */
const fs = require('fs');
const net = require('net');
const { spell } = require('./speller');

const STATUS = '/run/mgu-uplink/status.json';
const WIFI_SOCK = '/dev/shm/carlife-wireless/wifi.sock';
/* The WIFI state in app.json declares NET_1 .. NET_8; keep the two in step. */
const MAX_ROWS = 8;
const TIMEOUT_MS = 9000;

function signalText(dbm) {
    if (typeof dbm !== 'number') return '';
    if (dbm >= -55) return '信号强';
    if (dbm >= -70) return '信号中';
    return '信号弱';
}

class WifiPage {
    constructor(ctx, settings, onBack) {
        this.ctx = ctx;
        this.settings = settings;
        this.onBack = onBack;
        this.ui = null;
        this.networks = [];
        this.wifi = null;
        this.msg = '';
        this.busy = false;
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
        return this;
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
        if (!this.wifi) { this.msg = '未检测到 mgu-uplink'; this.paint(); return; }
        this.busy = true;
        this.msg = this.wifi.enabled ? '正在关闭 Wi-Fi…' : '正在开启 Wi-Fi…';
        this.paint();
        const was = this.wifi.enabled;
        const r = await this.request({ op: 'wifi-enable', on: !was });
        this.busy = false;
        /* Say what was asked for, not what status.json said a moment ago: the
         * old code read this.wifi.enabled before refresh() and reported the
         * opposite state ("已关闭" right after switching it on). */
        this.msg = r.ok ? (was ? 'Wi-Fi 已关闭' : 'Wi-Fi 已开启') : ('操作失败：' + (r.error || '未知错误'));
        this.refresh();
        this.paint();
    }

    async scan() {
        this.busy = true;
        this.msg = '正在扫描附近热点…';
        this.paint();
        if (this.wifi && !this.wifi.enabled) {
            const on = await this.request({ op: 'wifi-enable', on: true });
            if (!on.ok) {
                this.busy = false;
                this.msg = '开启 Wi-Fi 失败：' + (on.error || '未知错误');
                this.paint();
                return;
            }
        }
        const r = await this.request({ op: 'wifi-scan' });
        this.busy = false;
        this.msg = r.ok ? '扫描完成，选择手机热点' : ('扫描失败：' + (r.error || '未知错误'));
        this.refresh();
        this.paint();
        /* The uplink writes networks into status.json asynchronously. */
        setTimeout(() => { this.refresh(); this.paint(); }, 1200);
    }

    /* The single connection path used both by a tap on a network and by the
     * app's automatic reconnect at launch. Remembers the SSID on success. */
    async connect(ssid, psk) {
        if (this.busy) return { ok: false, error: '正在处理中' };
        this.busy = true;
        this.msg = '正在连接 ' + ssid + '…';
        this.paint();
        const r = await this.request({ op: 'wifi-connect', ssid, psk: psk || '' });
        this.busy = false;
        if (r && r.ok) {
            try { this.settings.set('wifi_ssid', ssid); } catch (e) { /* read-only */ }
            this.msg = '已连接 ' + ssid;
        } else {
            this.msg = '连接失败：' + ((r && r.error) || '未知错误');
        }
        this.refresh();
        this.paint();
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
                this.paint();
                return;
            }
        }
        /* Keep the password for next launch's automatic reconnect. */
        if (psk) { try { this.settings.set('wifi_psk', psk); } catch (e) { /* read-only */ } }
        const r = await this.connect(net.ssid, psk);
        /* Back to the picture as soon as the connect was accepted; DHCP takes a
         * moment and the stream service picks up the lease on its own. */
        if (r && r.ok) {
            setTimeout(() => { try { if (this.onBack) this.onBack(); } catch (e) { /* app closing */ } }, 2500);
        }
    }

    /**
     * The password, from the HMI's own speller (what the Store uses), kept in
     * the app's settings so the next launch reconnects without asking. The
     * app.json WIFI state has no settings rows, so this button is the only way
     * in - a canvas screen never gets the framework's settings screen.
     */
    async askPassword() {
        if (this.busy) return;
        let psk = '';
        try {
            psk = String(await spell(this.ctx.app, '热点密码') || '');
        } catch (e) {
            psk = '';
        }
        if (!psk) return;
        try { this.settings.set('wifi_psk', psk); } catch (e) { /* read-only */ }
        /* The length only: the password itself never goes to a log or a cell. */
        this.msg = '热点密码已保存（' + psk.length + ' 位）';
        this.paint();
    }

    /**
     * Take the WIFI state's components (app.json "items"): one click handler
     * per row plus the two buttons. Called once, from main.js's start.
     */
    bind(ui) {
        this.ui = ui;
        ui.onClick('BTN_WIFI_TOGGLE', () => { this.toggle(); });
        ui.onClick('BTN_WIFI_SCAN', () => { this.scan(); });
        ui.onClick('BTN_WIFI_PSK', () => { this.askPassword(); });
        ui.onClick('BTN_WIFI_BACK', () => { if (this.onBack) this.onBack(); });
        for (let i = 1; i <= MAX_ROWS; i++) {
            ui.onClick('NET_' + i, () => {
                const n = this.networks[i - 1];
                if (n) this.join(n);
            });
        }
        return this;
    }

    /**
     * Write the current state into the menu: the two buttons' labels, the two
     * status lines and one row per network (the unused rows are hidden rather
     * than left as empty buttons).
     */
    paint() {
        const ui = this.ui;
        if (!ui) return;
        const w = this.wifi;
        const ssid = (w && w.ssid) || '';
        const link = !w ? 'mgu-uplink 未运行'
            : w.link === 'online' ? ('已连接 ' + ssid + (w.ip ? ' · ' + w.ip : ''))
                : w.link === 'connected' ? ('已关联 ' + ssid + '（等待分配 IP）')
                    : w.enabled ? 'Wi-Fi 已开启，尚未连接' : 'Wi-Fi 已关闭';
        const note = this.busy ? (this.msg || '处理中…')
            : (this.msg || '选择手机的热点；加密热点会先询问密码');

        ui.text('BTN_WIFI_TOGGLE', w && w.enabled ? '关闭 Wi-Fi' : '开启 Wi-Fi');
        ui.text('BTN_WIFI_SCAN', '扫描附近热点');
        ui.text('BTN_WIFI_PSK', String(this.settings.get('wifi_psk') || '').trim()
            ? '热点密码：已保存' : '输入热点密码');
        ui.text('WIFI_STATUS', link);
        ui.text('WIFI_NOTE', note);

        this.networks.forEach((n, i) => {
            const tags = [];
            if (n.secure) tags.push('加密');
            if (n.saved) tags.push('已保存');
            if (n.current) tags.push('当前');
            const sig = signalText(n.signal);
            if (sig) tags.push(sig);
            ui.cells('NET_' + (i + 1), 0, { Text1stCol: n.ssid || '(未命名)', Text2ndCol: tags.join(' · ') });
            ui.visible('NET_' + (i + 1), true);
        });
        for (let i = this.networks.length + 1; i <= MAX_ROWS; i++) ui.visible('NET_' + i, false);
        return this;
    }
}

module.exports = { WifiPage, MAX_ROWS };
