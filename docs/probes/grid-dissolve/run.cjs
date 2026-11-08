/**
 * 验「整块内容换掉的那一帧，网格是不是已经不可见了」。
 *
 *   bash docs/probes/grid-dissolve/run.sh
 *
 * 为什么值得单开一个探针：这一招的全部价值押在一件事上 —— **跳跃发生在看不见的那一帧**。
 * 若 `flush: 'post'` 之后的第一帧仍然是 opacity 1（WAAPI 的动画下一帧才真正开始），
 * 那就是"先硬切一帧、再淡入"，观感反而更差（闪一下）。这件事只能量，不能想。
 *
 * 对照组 ② 跑的是同一路径但**不写 `fill`**，用来证明 `fill: 'backwards'` 不是可选项。
 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const os = require('node:os');

app.setPath('userData', path.join(os.tmpdir(), 'probe-grid-dissolve'));
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.disableHardwareAcceleration();

app.whenReady().then(async () => {
    const win = new BrowserWindow({
        show: false,
        width: 900,
        height: 620,
        webPreferences: { contextIsolation: false, backgroundThrottling: false, offscreen: true },
    });
    win.webContents.on('console-message', (_e, _lvl, msg) => console.log('[page]', msg));

    await win.loadFile(path.join(__dirname, 'index.html'));
    // ⚠️ zoomFactor 按 origin 持久化在 userData ⇒ 不显示复位会影响几何；本探针只看 opacity，
    //    但留这一行是纪律（crumb-motion/run.cjs 就是被它坑过 749→352.54）。
    win.webContents.setZoomFactor(1);
    await new Promise((r) => setTimeout(r, 600));

    console.log('Chromium =', process.versions.chrome);
    const r = await win.webContents.executeJavaScript('__test()');
    console.log(await win.webContents.executeJavaScript('document.getElementById("out").textContent'));

    const judge = (name, x) => {
        console.log(`\n${name}`);
        console.log(`  内容已换成新的 = ${x['内容已换成新的']}；动画数量 = ${x['动画数量']}`);
        console.log(`  ⭐ 换完内容、还没画出第一帧时的透明度 = ${x['此刻的透明度']}`);
        const keys = Object.keys(x).filter(k => k.startsWith('currentTime='));
        keys.forEach(k => console.log(`     ${k} → ${x[k]}`));
        return x['此刻的透明度'];
    };

    const a = judge('① 实际实现（fill: backwards）', r.real);
    const b = judge('② 对照（不写 fill）', r.noFill);

    console.log('\n结论：' + (a !== null && a <= 0.01
        ? `✅ 换完内容、还没作画的那一刻已经是 opacity ${a} ⇒ 跳跃发生在看不见的那一帧，观感是溶解。`
        : `❌ 那一刻 opacity 是 ${a} ⇒ 会闪一下再淡入，这一招不成立。`));
    console.log('  对照（不写 fill）同一时刻 = ' + b + ' —— ' +
        (b !== null && b > 0.5
            ? "`fill: 'backwards'` **不是装饰**：缺了它那一帧直接以 " + b + " 露出来。"
            : '两组都是 0，说明 fill 在当前 Chromium 上可有可无（保留仍无害）。'));

    app.quit();
});
