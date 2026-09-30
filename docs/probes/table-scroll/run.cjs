/**
 * 无头 Electron 跑 index.html，用**真实 Chromium 布局**量"表头会不会跟着滚走"。
 *
 *   env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe docs/probes/table-scroll/run.cjs
 *
 * 手法与两个环境坑照抄 docs/probes/preview-fill/run.cjs（那里踩过、注释写全了）：
 *   1. 本机 shell 注入了 ELECTRON_RUN_AS_NODE=1 —— 必须 `env -u` 真正删掉，设空字符串没用。
 *   2. 换个独立 userData 并禁 GPU —— dev 实例占着默认 userData 的 GPUPersistentCache，
 *      会让 GPU 进程反复崩、渲染进程 ERR_FAILED。
 *   3. offscreen + 关掉后台节流 —— show:false 的窗口在 Windows 上不参与合成，rAF 不推进。
 *
 * 为什么要真 Chromium：这个 probe 问的是"谁在滚、表头钉没钉住"，
 * 那是**布局计算**；happy-dom 不做真实布局（getBoundingClientRect 是假的）。
 * 页面里加载的是**真的 naive-ui UMD 包**（node_modules/naive-ui/dist/index.js + vue.global），
 * 所以量到的是真组件 + 真 CSS，不是复刻。
 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const os = require('node:os');

app.setPath('userData', path.join(os.tmpdir(), 'probe-table-scroll'));
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.disableHardwareAcceleration();

app.whenReady().then(async () => {
    const win = new BrowserWindow({
        show: false,
        width: 1200,
        height: 1000,
        webPreferences: { contextIsolation: false, backgroundThrottling: false, offscreen: true },
    });
    win.webContents.on('console-message', (_e, _lvl, msg) => console.log('[page]', msg));

    await win.loadFile(path.join(__dirname, 'index.html'));
    await new Promise(r => setTimeout(r, 1200));

    const out = await win.webContents.executeJavaScript('__probeAll()');
    console.log(JSON.stringify(out, null, 2));
    app.quit();
}).catch(e => {
    console.error('PROBE FAILED:', e && e.message ? e.message : e);
    app.exit(1);
});
