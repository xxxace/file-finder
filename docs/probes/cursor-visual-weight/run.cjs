/**
 * 无头 Electron 探针 · 焦点框到底有多粗
 * ==============================================================================
 *   bash docs/probes/cursor-visual-weight/run.sh
 *
 * 验什么：业主 2026-10-04 六次报「**你为什么会弄出这么粗边框的选中框？丑死了**」。
 *
 * ## 为什么必须量，不能靠读 CSS
 *
 * 读代码只能看到"我写了 `box-shadow: 0 0 0 2px …, 0 0 0 4px …`"，
 * 看不到**它叠在 1px border 上之后总共多粗**、也看不到 `scale(1.012)` 又把它放大了多少。
 * ⚠️ 网格那条（`.cursor`）与预览层那条（`.file-cursor`）**写法完全不同**，
 * 而 `file-cursor` 的注释写着"与网格的 `.cursor` 同一套焦点语言" ——
 * ⚠️ **那条注释是假的**（网格只有 1px，双环是早期 v2 方案残留）。
 * 这种"注释说一套、代码是另一套"的东西，只能靠实测抓出来。
 *
 * 输出不含任何真实路径 / 用户名 / 盘序列号。
 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const os = require('node:os');

app.setPath('userData', path.join(os.tmpdir(), 'probe-cursor-visual-weight'));
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.disableHardwareAcceleration();

let pass = 0, fail = 0;
const check = (label, cond, detail) => {
    console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '   → ' + detail : ''}`);
    if (cond) pass++; else fail++;
};

app.whenReady().then(async () => {
    const win = new BrowserWindow({
        show: false, width: 1500, height: 900,
        webPreferences: { contextIsolation: false, backgroundThrottling: false, offscreen: true },
    });
    await win.loadFile(path.join(__dirname, 'index.html'));
    await new Promise(r => setTimeout(r, 600));
    const run = (js) => win.webContents.executeJavaScript(js).catch(e => 'ERR: ' + String(e));

    // ───────────────── W1 · 网格焦点（.cursor）有多粗 ─────────────────
    console.log('—— W1 网格焦点 `.image-box-item.cursor` ——');
    await run(`__build('grid','cursor')`);
    await new Promise(r => setTimeout(r, 500));       // 转场跑完
    const g = await run(`__ringThickness('grid','k1')`);
    console.log(`  border-width = ${g.borderWidth}px`);
    console.log(`  box-shadow   = ${g.boxShadow}`);
    console.log(`  transform    = ${g.transform}`);
    console.log(`  ⇒ 可见环总厚 ≈ ${g.approxTotal}px（border + spread）`);
    check('★ 网格焦点是**细**的（1–2px），不是粗双环',
        g.approxTotal <= 2, `${g.approxTotal}px`);
    check('网格焦点没有 4px 那种外扩环',
        !/0px 0px 0px [3-9]/.test(g.boxShadow), g.boxShadow);

    // ───────────────── W2 · 预览层那一格（.file-cursor）有多粗 ─────────────────
    console.log('\n—— W2 预览层 `.file-item.file-cursor`（修前是 2px黑+4px蓝双环 = 5px）——');
    await run(`__build('files','file-cursor')`);
    await new Promise(r => setTimeout(r, 300));
    const f = await run(`__ringThickness('files','k1')`);
    console.log(`  border-width = ${f.borderWidth}px`);
    console.log(`  box-shadow   = ${f.boxShadow}`);
    console.log(`  ⇒ 可见环总厚 ≈ ${f.approxTotal}px`);
    check('★ 预览层不再有粗外扩环（总厚 ≤2px，与网格同一套）',
        f.approxTotal <= 2, `${f.approxTotal}px`);

    // ───────────────── W3 · 两者差多少（这就是"突兀"的量化） ─────────────────
    console.log('\n—— W3 两者落差 ——');
    const ratio = (f.approxTotal / Math.max(g.approxTotal, 0.5)).toFixed(2);
    console.log(`  预览层 ${f.approxTotal}px ÷ 网格 ${g.approxTotal}px = ${ratio} 倍（修前是 5.0 倍）`);
    check('★ 两处焦点粗细已一致（差 ≤1.5 倍，"同一套语言"这次是真的了）',
        f.approxTotal / Math.max(g.approxTotal, 0.5) <= 1.5, `${ratio} 倍`);

    console.log(`─────────────────────────────\n${pass} PASS / ${fail} FAIL\n`);
    await new Promise(r => setTimeout(r, 300));
    app.exit(fail ? 1 : 0);
});
