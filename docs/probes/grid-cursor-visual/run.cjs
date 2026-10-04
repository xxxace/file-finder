/**
 * 无头 Electron 探针 · 焦点环的**可见性**与三态可区分性
 * ==============================================================================
 *   bash docs/probes/grid-cursor-visual/run.sh
 *
 * 验什么：业主 2026-10-04 报「选中框样式很丑」的那个改动到底对不对。
 *
 * ⚠️ 原来的焦点态**边框色与 hover 完全相同**（都是 `#7a8da9`），只有阴影形状不同
 * ⇒ 鼠标划上去和键盘选中看起来一样。判据不是"好不好看"，是
 * **"能不能一眼看出焦点在哪、且不与 hover 混淆"**（Fluent 2 官方页的原话）。
 *
 * 为什么必须真渲染 + 算像素对比：「环画在浅色封面上会不会糊掉」是像素级问题，
 * 读 CSS 只能看到"我写了 rgba(...)"，看不到它叠上去之后还剩多少对比。
 *
 * ⚠️ 样式是**等效复制**（与 `index.vue` 保持一致）—— 因为 box-shadow 里的
 * 半透明环**canvas 读不到**（`getComputedStyle` 能读到值但采样不到像素），
 * 所以焦点环那一段用"按值合成 + 算 WCAG 对比"来验，图片用真canvas 渲染当底。
 * ⚠️ 复制错了探针就白测：改产品样式时**必须同步改这里**。
 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const os = require('node:os');

app.setPath('userData', path.join(os.tmpdir(), 'probe-grid-cursor-visual'));
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.disableHardwareAcceleration();

app.whenReady().then(async () => {
    const win = new BrowserWindow({
        show: false, width: 1000, height: 700,
        webPreferences: { contextIsolation: false, backgroundThrottling: false, offscreen: true },
    });
    win.webContents.on('console-message', (_e, _lvl, msg) => console.log('[page]', msg));
    await win.loadFile(path.join(__dirname, 'index.html'));
    await new Promise(r => setTimeout(r, 600));

    let body = '';
    try { body = await win.webContents.executeJavaScript('__probeAll()'); }
    catch (err) { body = '执行失败：' + String(err); }
    console.log(body);
    const fail = (body.match(/FAIL/g) || []).length;
    const pass = (body.match(/PASS/g) || []).length;
    console.log(`─────────────────────────────\n${pass} PASS / ${fail} FAIL\n`);
    await new Promise(r => setTimeout(r, 300));
    app.exit(fail ? 1 : 0);
});
