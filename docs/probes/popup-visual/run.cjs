/**
 * 无头 Electron 跑三页（手法同 popover-pick / preview-fill）。
 *
 *   env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe docs/probes/popup-visual/run.cjs
 *
 *   ① after.html   —— 改后那一版：量盒模型 / 图标 / 换行
 *   ② before.html  —— 改前那一版：同样的量，作对照
 *   ③ index.html   —— 两版叠在一张图上 → popup-before-after.png
 *
 * ⚠️ 两个环境坑（同 popover-pick）：
 *   1. 本机 shell 注入了 `ELECTRON_RUN_AS_NODE=1` ⇒ 必须 `env -u` 真删掉。
 *   2. 用独立 userData + 关 GPU，避免和 dev 实例抢 GPUPersistentCache。
 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

app.setPath('userData', path.join(os.tmpdir(), 'probe-popup-visual'));
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.disableHardwareAcceleration();

const url = (p) => 'file:///' + path.join(__dirname, p).replace(/\\/g, '/');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
    const win = new BrowserWindow({
        show: false,
        width: 900,
        height: 640,
        webPreferences: { contextIsolation: false, backgroundThrottling: false, offscreen: true },
    });
    win.webContents.on('console-message', (_e, _lvl, msg) => console.log('[page]', msg));

    for (const page of ['after.html', 'before.html']) {
        await win.loadURL(url(page));
        await sleep(1000);
        console.log(`\n########## ${page} ##########`);
        console.log(JSON.stringify(await win.webContents.executeJavaScript('__probe()'), null, 2));
    }

    /* ── 最小复现：**脚本 focus 一个 `tabindex="-1"` 的 div，会不会匹配 `:focus-visible`？** ──
       业主报「弹出层是橙色边框」，项目 CSS 里**没有任何橙色**（已全仓 grep）
       ⇒ 只剩"浏览器默认焦点环"。这一问必须问浏览器自己，不能推理：
       匹配 ⇒ UA 会画 `outline: auto` 的环（色值取自**系统强调色**，所以是橙的）；
       不匹配 ⇒ 焦点环这条解释不成立，得另找。
       顺带答了"为什么在弹层页里先 focus 再量 focusVisible=false"——见下面那条注释。 */
    await win.loadURL('data:text/html,<body style="margin:0"><div id=x tabindex=-1>hi</div></body>');
    console.log('\n########## 最小复现：脚本 focus 一个 tabindex=-1 的 div ##########');
    console.log(JSON.stringify(await win.webContents.executeJavaScript(`(() => {
        const x = document.getElementById('x');
        x.focus();
        const s = getComputedStyle(x);
        const plain = { focusVisible: x.matches(':focus-visible'), outlineStyle: s.outlineStyle, outlineWidth: s.outlineWidth, outlineColor: s.outlineColor };
        if (!plain.focusVisible) {
            x.blur(); x.focus({ focusVisible: true });
            const s2 = getComputedStyle(x);
            plain['forceFocusVisible'] = { focusVisible: x.matches(':focus-visible'), outlineStyle: s2.outlineStyle, outlineWidth: s2.outlineWidth, outlineColor: s2.outlineColor };
        }
        return plain;
    })()`), null, 2));

    /* 抓拍用独立窗口：offscreen 的窗口 capturePage 拿到的可能是空帧 */
    const shotWin = new BrowserWindow({
        show: false,
        width: 860,
        height: 520,
        webPreferences: { contextIsolation: false, backgroundThrottling: false },
    });
    await shotWin.loadURL(url('index.html'));
    await sleep(1800);
    const img = await shotWin.webContents.capturePage();
    const png = path.join(__dirname, 'popup-before-after.png');
    fs.writeFileSync(png, img.toPNG());
    const bytes = fs.statSync(png).size;
    console.log(`\n对照图：${png}  ${bytes} B`);
    if (bytes < 6000) console.log('⚠️ 图片偏小，可能是空帧 —— 把抓拍窗口改成 offscreen:false + show 试');

    app.quit();
}).catch((e) => {
    console.error('PROBE FAILED:', e && e.message ? e.message : e);
    app.exit(1);
});
