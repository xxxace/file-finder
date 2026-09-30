/**
 * 无头 Electron 跑 index.html，读**真实 Chromium 布局**算出的预览图尺寸。
 *
 *   env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe docs/probes/preview-fill/run.cjs
 *
 * ⚠️ 两个环境坑（都踩过）：
 *   1. 本机 shell 里注入了 `ELECTRON_RUN_AS_NODE=1`，直接跑 electron 会被当成 node，
 *      `require('electron')` 返回的就不是 app —— 必须 `env -u` 真正删掉它（设空字符串没用）。
 *   2. 项目的 dev 实例占着默认 userData 的 GPUPersistentCache，会导致 GPU 进程反复崩、
 *      连带渲染进程加载失败（ERR_FAILED）。所以这里换一个独立 userData 并禁用 GPU。
 *
 * 为什么要用真 Electron 而不是 happy-dom：这个 probe 要验的是
 * `width:100% + object-fit:contain + 脚手架 max-*` 三者相互作用后**实际占多大**，
 * 那是布局计算，happy-dom 不做真实布局（getBoundingClientRect 是假的）。
 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const os = require('node:os');

app.setPath('userData', path.join(os.tmpdir(), 'probe-preview-fill'));
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('no-sandbox');
// ⚠️ 这三条是"量不准"的根因所在：窗口 show:false 时 Chromium 会节流 rAF，
// 于是 Vue <Transition> 的 enter-from class 永远移不掉，而 enter-from 是 scale(0.9) ——
// 量出来的盒子会整整小 10%（踩过三次，一直以为是"动画没跑完"，其实是 class 没切走）。
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.disableHardwareAcceleration();

app.whenReady().then(async () => {
    const win = new BrowserWindow({
        show: false,
        width: 1900,
        height: 1060,
        // offscreen 才是关键：show:false 的窗口在 Windows 上不参与合成，
        // rAF 不推进 → Vue <Transition> 的 enter-from（scale 0.9）赖着不走。
        // offscreen 由 Electron 自己驱动帧，rAF 正常。
        webPreferences: { contextIsolation: false, backgroundThrottling: false, offscreen: true }
    });
    win.webContents.on('console-message', (_e, _lvl, msg) => console.log('[page]', msg));

    await win.loadFile(path.join(__dirname, 'index.html'));
    await new Promise(r => setTimeout(r, 900));

    const out = await win.webContents.executeJavaScript('__probe()');
    console.log(JSON.stringify(out, null, 2));
    app.quit();
}).catch(e => {
    console.error('PROBE FAILED:', e && e.message ? e.message : e);
    app.exit(1);
});
