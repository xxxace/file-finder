/**
 * 小窗口布局探针 —— 无头 Electron 跑 index.html，量"改前 / 改后"。
 *
 *   bash docs/probes/narrow-layout/run.sh
 *
 * 窗口 900×700：接近用户截图那个尺寸，是布局真会坏的那一档。
 * 手法与三个环境坑照抄 docs/probes/preview-fill/run.cjs（ELECTRON_RUN_AS_NODE / 独立 userData / offscreen）。
 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const os = require('node:os');

app.setPath('userData', path.join(os.tmpdir(), 'probe-narrow-layout'));
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.disableHardwareAcceleration();

app.whenReady().then(async () => {
    const win = new BrowserWindow({
        show: false,
        width: 900,
        height: 700,
        webPreferences: { contextIsolation: false, backgroundThrottling: false, offscreen: true },
    });
    win.webContents.on('console-message', (_e, _lvl, msg) => console.log('[page]', msg));

    await win.loadFile(path.join(__dirname, 'index.html'));
    await new Promise(r => setTimeout(r, 1200));

    // 扫一遍宽度：单点没复现出用户的坏状态就说明"坏在哪一档"本身也要量出来。
    // 用户截图是裁过的，不能拿图像宽度当窗口宽度。
    const widths = [680, 760, 820, 900, 1100];
    const all = [];
    for (const w of widths) {
        win.setSize(w, 700);
        await new Promise(r => setTimeout(r, 350));
        all.push(await win.webContents.executeJavaScript('__probeAll()'));
    }
    console.log(JSON.stringify(all, null, 2));
    app.quit();
}).catch(e => {
    console.error('PROBE FAILED:', e && e.message ? e.message : e);
    app.exit(1);
});
