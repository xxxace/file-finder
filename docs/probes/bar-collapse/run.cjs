/**
 * 验 `grid-template-rows: 0fr ↔ 1fr` 在**本项目这版 Chromium** 里到底是不是插值。
 *
 *   bash docs/probes/bar-collapse/run.sh
 *
 * 为什么值得单开一个探针：底部状态条在**文档流**里，卸载时整条高度消失 ⇒ 网格当场跳 50px。
 * 只做淡入不解决那一下。要让它平滑，必须让**高度**也过渡；而 `height: auto` 不能过渡，
 * `max-height` 要写魔数（内容一换就剪错）。`0fr → 1fr` 是唯一零魔数写法 ——
 * 但它只在 Chromium ≥ 107 才可插值，**不能靠记忆断定**。
 *
 * 环境三坑同 header-width/run.cjs：`env -u ELECTRON_RUN_AS_NODE`、独立 userData、offscreen + 关节流。
 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const os = require('node:os');

app.setPath('userData', path.join(os.tmpdir(), 'probe-bar-collapse'));
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.disableHardwareAcceleration();

app.whenReady().then(async () => {
    const win = new BrowserWindow({
        show: false,
        width: 800,
        height: 400,
        webPreferences: { contextIsolation: false, backgroundThrottling: false, offscreen: true },
    });
    win.webContents.on('console-message', (_e, _lvl, msg) => console.log('[page]', msg));

    await win.loadFile(path.join(__dirname, 'index.html'));
    win.webContents.setZoomFactor(1);
    await new Promise((r) => setTimeout(r, 600));

    console.log('Chromium =', process.versions.chrome);
    const r = await win.webContents.executeJavaScript('__test()');
    console.log(await win.webContents.executeJavaScript('document.getElementById("out").textContent'));

    console.log('\n结论：' +
        (r.mids > 3
            ? `✅ 轨道在插值（采到 ${r.mids} 帧中间高度）⇒ 状态条摘/挂时下方内容会**跟着滑**，不会最后塌一下。`
            : `❌ 没有中间高度（${r.mids} 帧）⇒ 这版 Chromium 不支持 fr 插值，必须换 height 的 JS 写法。`));
    console.log(`   条自身高 ${r.open - 0}px（40 min-height + 2/8 padding = 50），收起后 ${r.collapsed}px`);

    app.quit();
});
