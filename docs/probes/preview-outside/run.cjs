/**
 * 无头 Electron 跑 dist/index.html，验「关闭预览层时 src 不被清空」。
 *
 *   env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe docs/probes/preview-outside/run.cjs [buggy|fixed]
 *
 * ⚠️ 三个环境坑（与 preview-nav 同源，都踩过，别改）：
 *   1. 本机 shell 注入 `ELECTRON_RUN_AS_NODE=1`，直接跑 electron 会被当成 node ⇒
 *      必须 `env -u` **真删掉**（设空字符串没用）。
 *   2. 独立 userData + 禁 GPU：项目的 dev 实例占着默认 userData 的 GPUPersistentCache，
 *      共用会让 GPU 进程反复崩、渲染进程加载失败（ERR_FAILED）。
 *   3. 窗口必须 offscreen：show:false 时 Windows 上不参与合成 ⇒ rAF 不推进 ⇒
 *      淡出动画的每一帧都测不到（本探针的全部判据都在 rAF 上）。
 *
 * **默认跑 buggy 模式**（`?mode=` 缺省即修复前）—— 探针必须先能抓到那个缺陷，
 * 否则一条PASS 说明不了任何事。要验修复后传 `fixed`。
 *
 * 本探针**不**自己驱动页面：页面里的 main.js 已经跑完断言并把 PASS/FAIL 打到 console，
 * 这里只转发。之所以不塞进 executeJavaScript：判据要逐帧读 DOM，
 * 放页面里能保住 rAF 时序、也不用来回序列化。
 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const os = require('node:os');

const MODE = process.argv[2] === 'fixed' ? 'fixed' : 'buggy';

app.setPath('userData', path.join(os.tmpdir(), 'probe-preview-outside'));
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.disableHardwareAcceleration();

const wait = (ms) => new Promise(r => setTimeout(r, ms));

app.whenReady().then(async () => {
    const win = new BrowserWindow({
        show: false,
        width: 1600,
        height: 900,
        webPreferences: { contextIsolation: false, backgroundThrottling: false, offscreen: true },
    });

    const lines = [];
    win.webContents.on('console-message', (_e, lvl, msg) => {
        const text = String(msg);
        // 收页面上所有断言输出（page.log 会带 [page] 前缀）
        if (/PASS|FAIL|probe error|---|视口/.test(text)) {
            lines.push(text);
            console.log(text);
        }
        if (String(lvl) === '3' && /error/i.test(text)) console.log('[page:err]', text);
    });

    await win.loadFile(path.join(__dirname, 'dist', 'index.html'), { search: `?mode=${MODE}` });
    await wait(2500);

    const failed = lines.filter(l => l.startsWith('FAIL')).length;
    const passed = lines.filter(l => l.startsWith('PASS')).length;
    console.log(`\n== 探针汇总（${MODE}）：${passed} PASS / ${failed} FAIL ==`);
    if (passed + failed === 0) {
        console.log('✗ 一条断言都没跑到 —— 页面脚本可能没执行起来');
        process.exitCode = 1;
    } else if (failed > 0) {
        process.exitCode = 1;
    }
    app.quit();
});
