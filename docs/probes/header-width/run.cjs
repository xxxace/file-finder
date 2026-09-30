/**
 * 无头 Electron 跑 index.html，用**真实 Chromium 布局**量「头部有几行」。
 *
 *   env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe docs/probes/header-width/run.cjs
 * 或跑 run.sh（会把输出写进 out.txt）。
 *
 * 为什么要真 Chromium：这个问题是**布局计算**（换行、flex 收缩、文本截断），
 * happy-dom 不做真实布局（getBoundingClientRect 全是 0）。页面里加载的是真的
 * naive-ui UMD + vue.global，所以量到的是真组件 + 真 CSS。
 *
 * 三个环境坑照抄 docs/probes/table-scroll/run.cjs（那里踩过、注释写全了）：
 *   1. 本机 shell 注入了 ELECTRON_RUN_AS_NODE=1 —— 必须 `env -u` 真删掉，设空串没用。
 *   2. 换独立 userData + 禁 GPU —— dev 实例占着默认 userData 的 GPUPersistentCache。
 *   3. show:false 的窗口在 Windows 上不参与合成、rAF 不推进 ⇒ offscreen + 关后台节流。
 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const os = require('node:os');

app.setPath('userData', path.join(os.tmpdir(), 'probe-header-width'));
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.disableHardwareAcceleration();

app.whenReady().then(async () => {
    const win = new BrowserWindow({
        show: false,
        width: 2000,
        height: 900,
        webPreferences: { contextIsolation: false, backgroundThrottling: false, offscreen: true },
    });
    win.webContents.on('console-message', (_e, _lvl, msg) => console.log('[page]', msg));

    await win.loadFile(path.join(__dirname, 'index.html'));
    await new Promise(r => setTimeout(r, 1500));

    const out = await win.webContents.executeJavaScript('__probeAll()');
    console.table(out);

    /**
     * 判据只有三条，全部对应"头部高度取决于内容"这个原始问题：
     *   ① **头部高是常量** —— 它在四档窗口宽度下必须完全一致（这一条是核心）
     *   ② 当前段可见 —— 折叠后"我在哪"不能被挤出屏幕
     *   ③ 工具条不溢出
     * `old` 变体只作对照打印，不参与判定。
     */
    const news = out.filter(r => r.变体 === 'new');
    const heights = [...new Set(news.map(r => r.头部高))];
    const bad = news.filter(r => r.当前段可见 !== true || !r.工具条未溢出);
    const ok = heights.length === 1 && bad.length === 0;

    console.log(`\nnew 变体头部高（各宽度）：${news.map(r => r.窗口宽 + '→' + r.头部高 + 'px').join('  ')}`);
    console.log(`old 变体头部高（各宽度）：${out.filter(r => r.变体 === 'old').map(r => r.窗口宽 + '→' + r.头部高 + 'px').join('  ')}`);
    console.log(`new 头部截断段数：${news.map(r => r.有截断的段数).join('/')}`);
    console.log(ok
        ? '\n✅ new：头部高在四档宽度下**完全一致**（常量），当前段可见、工具条不溢出'
        : `\n❌ new：头部高各档=${heights.join(',')}（要求完全一致）；另有 ${bad.length} 条不满足`);
    app.quit();
}).catch(e => {
    console.error('PROBE FAILED:', e && e.message ? e.message : e);
    app.exit(1);
});
