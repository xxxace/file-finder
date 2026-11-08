/**
 * 补封面卡 · 渲染探针（看"抓取中"那张卡的加载动效）。
 *
 * 静图看不出一张连续动画的问题，所以这里**同一张卡连拍 3 帧**（间隔 340ms），
 * 存成 frame1/2/3。三张图并排看，才知道它是"在动"还是"在闪"。
 *
 * 依赖 `npm run dev`；Vite 只监听 `::1:5173`（IPv6 回环）。
 */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const DIR = path.join(process.cwd(), 'docs', 'probes', 'vue');
app.disableHardwareAcceleration();

const wait = ms => new Promise(r => setTimeout(r, ms));

app.whenReady().then(async () => {
    const win = new BrowserWindow({
        width: 1280,
        height: 860,
        show: false,
        webPreferences: { offscreen: true },
    });
    await win.loadURL('http://[::1]:5173/docs/probes/vue/cover-probe.html');

    for (let i = 0; i < 60; i++) {
        await wait(200);
        const n = await win.webContents.executeJavaScript(
            "document.querySelectorAll('.ffw-card').length",
            true,
        );
        if (n >= 10) break;
    }
    await wait(500);

    const all = await win.webContents.capturePage();
    fs.writeFileSync(path.join(DIR, 'cover-probe.png'), all.toPNG());
    console.log('saved cover-probe.png');

    // 第一张卡（pending）的矩形：连拍同一块区域
    const rect = await win.webContents.executeJavaScript(
        `(() => {
            const el = document.querySelector(".ffw-card[data-state='pending'] .ffw-card__media");
            const b = el.getBoundingClientRect();
            return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) };
        })()`,
        true,
    );
    console.log('card media rect:', JSON.stringify(rect));

    for (let f = 1; f <= 3; f++) {
        const img = await win.webContents.capturePage({
            x: rect.x,
            y: rect.y,
            width: rect.w,
            height: rect.h,
        });
        fs.writeFileSync(path.join(DIR, `cover-frame${f}.png`), img.resize({ width: rect.w * 3 }).toPNG());
        console.log('saved cover-frame' + f + '.png');
        await wait(340);
    }

    app.exit(0);
});
