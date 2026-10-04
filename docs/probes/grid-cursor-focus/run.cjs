/**
 * 无头 Electron 探针 · 网格选择器的**焦点隔离与键盘归属**
 * ==============================================================================
 *   bash docs/probes/grid-cursor-focus/run.sh
 *
 * 验什么：三件**静态读代码读不出来、只有真浏览器能证**的事：
 *   ① 焦点落在文件列表弹层里时，方向键**不会**动网格选择器（两个选择器不打架）
 *   ② 预览层开着时按回车**只**定位、**不**打开（keydown 的 bail 真的挡住了 keyup 那条）
 *   ③ 弹层关闭后焦点**真的**回到 body —— 否则方向键永久失灵且看不出原因
 *
 * 为什么必须真浏览器：这三条全部是 **DOM 焦点归属 + 事件冒泡** 的行为。
 * `getBoundingClientRect` 在 happy-dom 里恒为 0，而冒泡/焦点规则更是没法模拟。
 *
 * ⚠️ 三个环境坑照抄 `docs/probes/header-width/run.cjs`（那里踩过、注释写全了）：
 *   1. 本机 shell 注入 `ELECTRON_RUN_AS_NODE=1` —— 必须 `env -u` 真删掉，设空串没用
 *   2. 独立 userData + 禁 GPU —— dev 实例占着默认 userData 的 GPUPersistentCache
 *   3. `show:false` 在 Windows 上不参与合成、rAF 不推进 ⇒ offscreen + 关后台节流
 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

app.setPath('userData', path.join(os.tmpdir(), 'probe-grid-cursor-focus'));
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.disableHardwareAcceleration();

/**
 * 把真的 `isGridKeyBlocked` 注入页面。
 *
 * ⚠️ **不这么做探针就没有判据效力**：第一版是让页面里手抄一份判据，
 * 结果回退真源码时探针全绿 —— 改探针不会改真代码，断言的是"我抄的那份对不对"。
 * 守卫恰好是被这套探针改过两次的地方（见 `src/utils/index.ts` 文件头），
 * 所以必须是**同一份代码**。
 *
 * ⚠️ 打包**在 `run.sh` 里预先做完**、这里只读文件：在 Electron 主进程里
 * `execFileSync(process.execPath …)` 会撞 `EBUSY`（同一个 exe 正被自己占着，
 * Windows 不允许对运行中的映像再 spawn 一份）。
 */
const injectRealGuard = async (win) => {
    // ⚠️ 守卫与"打开判据"两样都注入。判据同样是被真机报过 bug 的地方（2026-10-04
    // 「回车打开的是预览图不是文件」），而第一版探针把它**手抄**进页面
    // ⇒ 回退真源码时探针依然全绿。**同一天犯两次同一个错**（另一次是
    // `isGridKeyBlocked`）⇒ 判据必须是同一份代码。
    const code = fs.readFileSync(path.join(__dirname, 'generated-guard.js'), 'utf8')
        + '\n' + fs.readFileSync(path.join(__dirname, 'generated-decide.js'), 'utf8');
    if (!code.includes('isGridKeyBlocked')) {
        throw new Error('generated-guard.js 里没有 isGridKeyBlocked —— build.mjs 是不是失败了');
    }
    if (!code.includes('decideOpen')) {
        throw new Error('generated-decide.js 里没有 decideOpen —— build-decide.mjs 是不是失败了');
    }
    await win.webContents.executeJavaScript(`${code}\n;true;`);
};

app.whenReady().then(async () => {
    const win = new BrowserWindow({
        show: false,
        width: 1200,
        height: 800,
        webPreferences: { contextIsolation: false, backgroundThrottling: false, offscreen: true },
    });
    win.webContents.on('console-message', (_e, _lvl, msg) => console.log('[page]', msg));

    await win.loadFile(path.join(__dirname, 'index.html'));
    await new Promise(r => setTimeout(r, 500));
    await injectRealGuard(win);
    await new Promise(r => setTimeout(r, 200));

    let body = '';
    try {
        body = await win.webContents.executeJavaScript('__probeAll()');
    } catch (err) {
        body = '执行失败：' + String(err);
    }
    console.log(body);
    const fail = (body.match(/FAIL/g) || []).length;
    const pass = (body.match(/PASS/g) || []).length;
    console.log(`─────────────────────────────\n${pass} PASS / ${fail} FAIL\n`);

    // ⚠️ 别急着 win.destroy()：offscreen 窗口销毁过早会让最后一批 executeJavaScript 丢结果。
    await new Promise(r => setTimeout(r, 300));
    app.exit(fail ? 1 : 0);
});
