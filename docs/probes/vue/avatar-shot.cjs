/**
 * 把 `avatar-probe.html` 渲染成一张 PNG（`avatar-probe.png`），用来和原型逐项对照。
 *
 * ⚠️ 依赖 `npm run dev`：Vite 只监听 `::1:5173`（**IPv6 回环**），所以这里必须写 `[::1]`，
 * 写 `127.0.0.1` 会直接 500/拒连。
 */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const URL = 'http://[::1]:5173/docs/probes/vue/avatar-probe.html';

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
    const win = new BrowserWindow({
        width: 1280,
        height: 860,
        show: false,
        webPreferences: { offscreen: true },
    });

    win.webContents.on('console-message', (_e, _level, msg) => {
        if (/error|Failed/i.test(msg)) console.log('[page]', msg);
    });

    await win.loadURL(URL);

    // 等真组件挂完（行 + 入场动画跑完），而不是死等一个固定毫秒
    for (let i = 0; i < 60; i++) {
        await new Promise(r => setTimeout(r, 200));
        const n = await win.webContents.executeJavaScript(
            "document.querySelectorAll('.ffw-row').length",
            true,
        );
        if (n >= 3) break;
    }
    await new Promise(r => setTimeout(r, 600));

    // 顺手把"入场动效到底挂上没有"读出来：静态截图看不出 animation 是否生效
    const anim = await win.webContents.executeJavaScript(
        `(() => {
            const el = document.querySelector('.ffw-row');
            const cs = getComputedStyle(el);
            return { name: cs.animationName, dur: cs.animationDuration, delay: cs.animationDelay };
        })()`,
        true,
    );
    console.log('enter animation:', JSON.stringify(anim));

    // `color-mix()` 万一不被支持，border-color 会退回继承色（白/黑），比原来的实色更糟 ——
    // 所以这里读真值，不靠"看起来还行"。
    const miss = await win.webContents.executeJavaScript(
        `getComputedStyle(document.querySelector(".ffw-row[data-state='miss'] .ffw-field")).borderColor`,
        true,
    );
    console.log('miss input border:', miss);

    // ⚠️ 底色画在 `.n-base-selection-label` 上，外层自己是透明的 —— 读外层会误报"没底色"
    const sel = await win.webContents.executeJavaScript(
        `getComputedStyle(document.querySelector('.ffw-select .n-base-selection-label')).backgroundColor`,
        true,
    );
    console.log('select bg:', sel);

    const img = await win.webContents.capturePage();
    const out = path.join(process.cwd(), 'docs', 'probes', 'vue', 'avatar-probe.png');
    fs.writeFileSync(out, img.toPNG());
    console.log('saved', out);

    // 再把下拉掰开截一张：要看的正是"已选项的底色是不是卡片选中那片蓝"
    await win.webContents.executeJavaScript(
        "document.querySelector('.ffw-select .n-base-selection').click()",
        true,
    );
    await new Promise(r => setTimeout(r, 400));
    const opt = await win.webContents.executeJavaScript(
        `(() => {
            const e = document.querySelector('.n-base-select-option');
            const cs = getComputedStyle(e);
            return {
                bgActivePending: cs.getPropertyValue('--n-option-color-active-pending').trim(),
                bgActive: cs.getPropertyValue('--n-option-color-active').trim(),
                bgPending: cs.getPropertyValue('--n-option-color-pending').trim(),
                tokenWeak: getComputedStyle(document.documentElement).getPropertyValue('--ff-highlight-weak').trim(),
                tokenHover: getComputedStyle(document.documentElement).getPropertyValue('--ff-ctl-hover').trim(),
            };
        })()`,
        true,
    );
    console.log('vars:', JSON.stringify(opt));

    const open = await win.webContents.capturePage();
    const out2 = path.join(process.cwd(), 'docs', 'probes', 'vue', 'avatar-probe-open.png');
    fs.writeFileSync(out2, open.toPNG());
    console.log('saved', out2);

    // 把下拉放大 4 倍单独存一张：12%~16% 的蓝底在缩略图上基本看不出来，
    // 不放大就只能靠猜（而"猜"正是这次返工的原因）。坐标从 DOM 读，不手填。
    const rect = await win.webContents.executeJavaScript(
        `(() => {
            const e = document.querySelector('.n-base-select-menu');
            const b = e.getBoundingClientRect();
            return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) };
        })()`,
        true,
    );
    console.log('menu rect:', JSON.stringify(rect));
    const menu = await win.webContents.capturePage({
        x: rect.x,
        y: rect.y,
        width: rect.w,
        height: rect.h,
    });
    const zoom = path.join(process.cwd(), 'docs', 'probes', 'vue', 'avatar-probe-menu.png');
    fs.writeFileSync(zoom, menu.resize({ width: rect.w * 4 }).toPNG());
    console.log('saved', zoom);

    app.exit(0);
});
