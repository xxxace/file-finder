/**
 * 第二次取证：撞上 cards=0（移动 UA 下页面结构与桌面不同 / 需更久加载）。
 * 这次先 dump「页面上到底有什么」：文本、链接、按钮、DOM 骨架，再决定怎么定位胶囊。
 * 页面脚本单独放 page.js，避免模板字符串转义把语法改坏。只读。
 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

app.disableHardwareAcceleration();
for (const s of ['disable-gpu', 'disable-gpu-compositing', 'disable-software-rasterizer', 'no-sandbox']) {
    app.commandLine.appendSwitch(s);
}
app.setPath('userData', path.join(__dirname, '_userdata'));

const URL_ = process.env.PROBE_URL || 'https://app.tapnow.media/home/taptv';
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const PAGE_JS = fs.readFileSync(path.join(__dirname, process.env.PROBE_PAGE || 'page.js'), 'utf8');

app.whenReady().then(async () => {
    const win = new BrowserWindow({ show: false, width: 390, height: 844,
        webPreferences: { offscreen: true, backgroundThrottling: false } });
    win.webContents.setUserAgent(UA);
    const logs = [];
    win.webContents.on('console-message', (e, level, message) => {
        logs.push(String((e && e.message) || message).slice(0, 300));
    });
    let data = null;
    try {
        await win.loadURL(URL_, { userAgent: UA });
        await new Promise(r => setTimeout(r, Number(process.env.PROBE_WAIT || 20000)));
        data = await win.webContents.executeJavaScript(PAGE_JS);
    } catch (e) { data = { error: String((e && e.message) || e) }; }
    fs.writeFileSync(path.join(__dirname, process.env.PROBE_OUT || 'out2.json'), JSON.stringify(data, null, 2));
    fs.writeFileSync(path.join(__dirname, 'console2.log'), logs.join('\n'));
    app.exit(0);
});
