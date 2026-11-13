/**
 * 第三轮取证：精确读「查看创作过程」胶囊全部样式 + 截图，用来判断"好看在哪"。
 * 只读；不点任何东西。
 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

app.disableHardwareAcceleration();
for (const s of ['disable-gpu', 'disable-gpu-compositing', 'disable-software-rasterizer', 'no-sandbox']) {
    app.commandLine.appendSwitch(s);
}
app.setPath('userData', path.join(__dirname, '_userdata'));

const URL_ = 'https://app.tapnow.media/home/taptv';
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const PAGE_JS = fs.readFileSync(path.join(__dirname, 'page3.js'), 'utf8');

app.whenReady().then(async () => {
    const win = new BrowserWindow({ show: false, width: 390, height: 844,
        webPreferences: { offscreen: true, backgroundThrottling: false } });
    win.webContents.setUserAgent(UA);
    let data = null;
    try {
        await win.loadURL(URL_, { userAgent: UA });
        await new Promise(r => setTimeout(r, 15000));
        data = await win.webContents.executeJavaScript(PAGE_JS);
        // 整屏 + 单卡特写
        const shot = await win.webContents.capturePage();
        fs.writeFileSync(path.join(__dirname, 'shot-full.png'), shot.toPNG());
        if (data && data.clip) {
            const r = data.clip;
            const clip = { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
            const card = await win.webContents.capturePage(clip);
            fs.writeFileSync(path.join(__dirname, 'shot-card.png'), card.toPNG());
        }
    } catch (e) { data = { error: String((e && e.message) || e) }; }
    fs.writeFileSync(path.join(__dirname, 'out3.json'), JSON.stringify(data, null, 2));
    app.exit(0);
});
