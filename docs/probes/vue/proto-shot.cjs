/**
 * 把 `docs/proto-assistant-2026-11-08.html` 的头像页渲染成 PNG，用来和实现逐项对照。
 * 原型默认停在"补封面"，这里点一下 tab 再截。
 */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
    const win = new BrowserWindow({
        width: 1280,
        height: 900,
        show: false,
        webPreferences: { offscreen: true },
    });

    const file = path.join(process.cwd(), 'docs', 'proto-assistant-2026-11-08.html');
    await win.loadURL('file:///' + file.replace(/\\/g, '/'));

    // 切到头像页（原型里 tab 是 `.hint .tab[data-tab]`）
    await win.webContents.executeJavaScript(
        "document.querySelector('[data-tab=\"avatar\"]').click()",
        true,
    );
    await new Promise(r => setTimeout(r, 900));

    const img = await win.webContents.capturePage();
    const out = path.join(process.cwd(), 'docs', 'probes', 'vue', 'proto-avatar.png');
    fs.writeFileSync(out, img.toPNG());
    console.log('saved', out);
    app.exit(0);
});
