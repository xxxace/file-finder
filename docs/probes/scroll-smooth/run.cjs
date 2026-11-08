/**
 * 量原生平滑滚动（`behavior: 'smooth'`）在这版 Chromium 上的两个数：
 *   ① 一格 / 四格各要滚多久（= 主人问的"滚动的速度"）
 *   ② 长按时**每 60ms 追加一格**，每一步刚追加完落后多少
 *      —— 落后 > 一格就说明光标已经不在视口里，那正是"长按不能平滑"的判据。
 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const os = require('node:os');

app.setPath('userData', path.join(os.tmpdir(), 'probe-scroll-smooth'));
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.disableHardwareAcceleration();

app.whenReady().then(async () => {
    const win = new BrowserWindow({
        show: false,
        width: 520,
        height: 520,
        webPreferences: { contextIsolation: false, backgroundThrottling: false, offscreen: true },
    });
    win.webContents.on('console-message', (_e, _lvl, msg) => console.log('[page]', msg));

    await win.loadFile(path.join(__dirname, 'index.html'));
    win.webContents.setZoomFactor(1);
    await new Promise((r) => setTimeout(r, 600));

    console.log('Chromium =', process.versions.chrome);
    const r = await win.webContents.executeJavaScript('__test()');
    console.log(await win.webContents.executeJavaScript('document.getElementById("out").textContent'));

    const s1 = r.single;
    console.log('\n① 单次平滑滚动的速度');
    s1.forEach(x => console.log(`   ${x.距离}px → ${x.到位耗时ms}ms`));
    console.log('   轨迹 150px：' + JSON.stringify(s1[0]['轨迹(每约40ms取一点)'].slice(0, 8)));

    const sm = r.smooth;
    const ins = r.instant;
    console.log('\n② 长按（每 60ms 一格）—— 平滑');
    console.log('   每步刚追加完的落后(px)：' + JSON.stringify(sm.每步刚追加完的落后));
    console.log(`   最大落后 ${sm.最大落后}px（一格 = 150px）`);
    console.log(`   追加结束后 600ms 位置 = ${sm['600ms 后位置']}（目标 1200）`);
    console.log('\n③ 长按（每 60ms 一格）—— 瞬时（现状）');
    console.log('   每步刚追加完的落后(px)：' + JSON.stringify(ins.每步刚追加完的落后));

    const worst = sm.最大落后;
    console.log('\n结论：' +
        (worst > 150
            ? `❌ 长按时平滑滚动最多落后 ${worst}px > 一格(150px) ⇒ 光标会被滚出视口，**长按必须保持瞬时**。`
            : `✅ 长按时最大落后 ${worst}px < 一格 ⇒ 平滑在长按下也能跟上。`));

    app.quit();
});
