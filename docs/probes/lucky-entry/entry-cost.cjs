/**
 * 只读探针：卡包"入场那一段"到底在哪些像素上掉帧。
 *
 * 为什么拿**参考站**做实验台而不是我们的组件：参考站在 420px 下是"丝滑"的基准，
 * 把它当作被试，只改一个变量（尺寸/遮罩/旋转侧面/光影），就能把"面积"和"我们的代码"
 * 两件事分开。跑的是 `holo-reverse/index.html`（file:// 直开，零构建）里那条**同款飞入**
 * —— `enter()` 的起始位姿与弹簧与我们都一样。
 *
 * ⚠️ 这是离屏软件光栅（没有 GPU），绝对毫秒数不能当真，只能读**同一台机器上的相对差**。
 *
 * 用法：`electron docs/probes/lucky-entry/entry-cost.cjs`（参考站在别的路径时设 `HOLO_PAGE`）
 */
const { app, BrowserWindow } = require('electron');
const { pathToFileURL } = require('node:url');
const { resolve } = require('node:path');

/** 参考站页面。默认取同级仓库；换地方就设 `HOLO_PAGE`，别把本机路径写死 */
const PAGE = pathToFileURL(
    process.env.HOLO_PAGE || resolve(__dirname, '../../../../holo-reverse/index.html'),
).href;

/** 每个变体只改一处，其余不动 */
const VARIANTS = [
    ['base-420', ''],
    ['ph665', ':root{--ph:665px}'],
    ['ph665 - rims', ':root{--ph:665px} .rim{display:none}'],
    ['ph665 rims 无clip', ':root{--ph:665px} .rim{clip-path:none!important}'],
    ['ph665 rims 无Z', ':root{--ph:665px} .rim{transform:none!important}'],
    ['ph665 rims 无Z无clip', ':root{--ph:665px} .rim{transform:none!important;clip-path:none!important}'],
    ['ph665 - mask', ':root{--ph:665px} .skin{mask:none}'],
    ['ph665 - 全部皮肤', ':root{--ph:665px} .skin{mask:none;background:var(--pack)} .skin::before,.skin::after,.rim{display:none}'],
    ['ph665 复跑', ':root{--ph:665px}'],
];

const MEASURE = `new Promise(res => {
    const btn = document.getElementById('again');
    btn.hidden = false;
    const gaps = []; let last = performance.now(); const t0 = last;
    function tick(now) {
        gaps.push(now - last); last = now;
        if (now - t0 < 1400) requestAnimationFrame(tick); else res(gaps);
    }
    btn.click();
    requestAnimationFrame(tick);
})`;

const stats = (gaps) => {
    const s = gaps.slice(1).sort((a, b) => a - b);
    const at = (q) => s[Math.min(s.length - 1, Math.floor(s.length * q))] ?? 0;
    return {
        frames: gaps.length,
        p50: +at(0.5).toFixed(1),
        p90: +at(0.9).toFixed(1),
        max: +Math.max(...gaps).toFixed(1),
        over24: s.filter(v => v > 24).length,
        over50: s.filter(v => v > 50).length,
    };
};

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
    // 竖屏窗口：包不至于被裁掉一半，量到的就是整只包
    const win = new BrowserWindow({
        width: 900,
        height: 1000,
        show: false,
        webPreferences: { offscreen: true, backgroundThrottling: false },
    });
    win.webContents.setFrameRate(60);
    await win.loadURL(PAGE);
    await new Promise(r => setTimeout(r, 1800));   // 让首包的飞入跑完

    const rows = [];
    for (const [name, css] of VARIANTS) {
        await win.webContents.executeJavaScript(`(() => {
            document.getElementById('v-probe')?.remove();
            const st = document.createElement('style');
            st.id = 'v-probe';
            st.textContent = ${JSON.stringify(css)};
            document.head.append(st);
            return document.querySelector('.pack').offsetWidth;
        })()`);
        await new Promise(r => setTimeout(r, 200));
        const gaps = await win.webContents.executeJavaScript(MEASURE);
        rows.push({ name, pw: await win.webContents.executeJavaScript('document.querySelector(".pack").offsetWidth'), ...stats(gaps) });
    }

    console.log('变体              包宽 帧    p50   p90   max  >24ms >50ms');
    for (const r of rows) {
        console.log(
            `${r.name.padEnd(18)}${String(r.pw).padStart(4)} ${String(r.frames).padStart(3)}  `
            + `${String(r.p50).padStart(5)} ${String(r.p90).padStart(5)} ${String(r.max).padStart(5)}  `
            + `${String(r.over24).padStart(5)} ${String(r.over50).padStart(5)}`,
        );
    }
    app.quit();
});
