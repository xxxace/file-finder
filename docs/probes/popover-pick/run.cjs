/**
 * 无头 Electron 跑两页探针（手法同 preview-fill）。
 *
 *   env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe docs/probes/popover-pick/run.cjs
 *
 *   ① index.html         —— 文件列表 popover 本身：每个格子的命中归属 + openFile 收到什么
 *   ② grid-preview.html  —— 网格卡片（真 n-image 预览）+ popover：双击到底谁吃掉了点击
 *
 * ⚠️ 两个环境坑（同 preview-fill）：
 *   1. 本机 shell 注入了 `ELECTRON_RUN_AS_NODE=1` ⇒ 必须 `env -u` 真删掉。
 *   2. 用独立 userData + 关 GPU，避免和 dev 实例抢 GPUPersistentCache。
 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const os = require('node:os');

app.setPath('userData', path.join(os.tmpdir(), 'probe-popover-pick'));
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.disableHardwareAcceleration();

app.whenReady().then(async () => {
    const win = new BrowserWindow({
        show: false,
        width: 1400, height: 900,
        webPreferences: { contextIsolation: false, backgroundThrottling: false, offscreen: true }
    });
    win.webContents.on('console-message', (_e, _lvl, msg) => console.log('[page]', msg));

    const cases = [
        ['index.html', undefined],
        ['grid-preview.html', undefined],          // 改前
        ['grid-preview.html', 'fixed'],            // 改后
    ];
    for (const [page, hash] of cases) {
        const full = path.join(__dirname, page).replace(/\\/g, '/');
        await win.loadURL('file:///' + full + (hash ? '?v=' + hash : ''));
        await new Promise(r => setTimeout(r, 900));
        console.log(`\n########## ${page}${hash ? '#' + hash : ''} ##########`);
        const out = await win.webContents.executeJavaScript('__probe()');
        console.log(JSON.stringify(out, null, 2));
    }

    app.quit();
}).catch(e => {
    console.error('PROBE FAILED:', e && e.message ? e.message : e);
    app.exit(1);
});
