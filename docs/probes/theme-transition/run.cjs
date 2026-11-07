/**
 * 探针 · 主题切换时右下角到底有没有露出「旧主题」的缝
 *
 * 一行复跑：`bash docs/probes/theme-transition/run.sh`
 *
 * 判据为什么这么设计：
 *   ① 主人报的是**白色间隙、只在下边和右边**。白色 = 浅色主题的 #f1f2f3，深色切换时露出它才看得见
 *      ⇒ 只看「切到 dark 的那一轮」右/下两条边的**最外 2 像素**，那里在探针页面里必定是纯背景；
 *   ② 缝是**动画进行中**才出现的（结束就换成真实 DOM），所以必须逐帧看，不能只看终态；
 *   ③ 不 disable-gpu、不 offscreen —— 抖动/露底这类问题只存在于真实合成路径上。
 *
 * 环境坑：
 *   · `show: false` 的窗口合成器可能不推进动画 ⇒ 用 `showInactive()`；
 *   · 回调里 `toBitmap()` 很慢（1440×900 ≈ 5MB/帧），会掉帧但**不会漏掉缝**（缝是持续存在的）。
 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

app.setPath('userData', path.join(os.tmpdir(), 'probe-theme-transition'));
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');

const lines = [];
const log = (s = '') => { lines.push(s); console.log(s); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lum = (b, g, r) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** 追踪红点质心（物理像素）。净变换若严格恒等，整个动画期间它应当纹丝不动 */
function scanMark(image, w, h) {
    const cw = Math.min(48, w), chh = Math.min(48, h);
    const x0 = Math.max(0, Math.min(w - cw, Math.round(900 * (w / 1426.4)) - cw / 2));
    const y0 = Math.max(0, Math.min(h - chh, Math.round(600 * (h / 838.4)) - chh / 2));
    const crop = image.crop({ x: x0, y: y0, width: cw, height: chh });
    const b = crop.toBitmap();
    let sx = 0, sy = 0, n = 0;
    for (let y = 0; y < chh; y++) {
        for (let x = 0; x < cw; x++) {
            const i = (y * cw + x) * 4;
            if (b[i + 2] > 200 && b[i + 1] < 100 && b[i] < 100) { sx += x; sy += y; n++; }
        }
    }
    if (!n) return { n: 0, mx: NaN, my: NaN };
    return { n, mx: +(x0 + sx / n).toFixed(2), my: +(y0 + sy / n).toFixed(2) };
}

/** 裁出最外 3 列 / 3 行再转位图（整图 5MB/帧会把帧率打到 20fps，漏掉瞬时缝） */
function scanEdges(image, w, h) {
    const out = {
        right: 0, bottom: 0,
        rightY: [Infinity, -Infinity], bottomX: [Infinity, -Infinity],
        maxRight: 0, maxBottom: 0,
    };
    const rimg = image.crop({ x: Math.max(0, w - 3), y: 0, width: Math.min(3, w), height: h });
    const rb = rimg.toBitmap();
    const rw = rimg.getSize().width;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < rw; x++) {
            const i = (y * rw + x) * 4;
            const L = lum(rb[i], rb[i + 1], rb[i + 2]);
            if (L > out.maxRight) out.maxRight = L;
            if (L > 180) {
                out.right++;
                if (y < out.rightY[0]) out.rightY[0] = y;
                if (y > out.rightY[1]) out.rightY[1] = y;
            }
        }
    }
    const bimg = image.crop({ x: 0, y: Math.max(0, h - 3), width: w, height: Math.min(3, h) });
    const bb = bimg.toBitmap();
    const bh = bimg.getSize().height;
    for (let y = 0; y < bh; y++) {
        for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4;
            const L = lum(bb[i], bb[i + 1], bb[i + 2]);
            if (L > out.maxBottom) out.maxBottom = L;
            if (L > 180) {
                out.bottom++;
                if (x < out.bottomX[0]) out.bottomX[0] = x;
                if (x > out.bottomX[1]) out.bottomX[1] = x;
            }
        }
    }
    out.maxRight = Math.round(out.maxRight);
    out.maxBottom = Math.round(out.maxBottom);
    return out;
}

async function captureRound(win, label, expect) {
    const frames = [];
    const t0 = Date.now();
    win.webContents.beginFrameSubscription(false, (image) => {
        const { width, height } = image.getSize();
        // ⚠️ 只扫红点（48²）。加回边缘扫描/diff 会把帧率打到 20fps，测不出真实流畅度。
        const m = scanMark(image, width, height);
        frames.push({ t: Date.now() - t0, ...m });
    });
    await win.webContents.executeJavaScript('document.getElementById("tog").click()');
    await sleep(1100);
    win.webContents.endFrameSubscription();

    const ys = frames.filter((f) => f.n > 0).map((f) => f.my);
    const xs = frames.filter((f) => f.n > 0).map((f) => f.mx);
    const gaps = [];
    for (let i = 1; i < frames.length; i++) gaps.push(frames[i].t - frames[i - 1].t);
    const anim = frames.filter((f) => f.t < 700);
    const animGaps = [];
    for (let i = 1; i < anim.length; i++) animGaps.push(anim[i].t - anim[i - 1].t);
    const avg = animGaps.length ? animGaps.reduce((a, b) => a + b, 0) / animGaps.length : 0;

    log(`\n── ${label}（期望主题 = ${expect}）──`);
    log(`  帧数 ${frames.length} · 动画期(0~700ms) 帧数 ${anim.length} · 平均帧间隔 ${avg.toFixed(1)}ms ≈ ${avg ? (1000 / avg).toFixed(0) : '?'}fps`);
    log(`  红点 x: ${Math.min(...xs)} ~ ${Math.max(...xs)}   y: ${Math.min(...ys)} ~ ${Math.max(...ys)}` +
        `  ⇒ 漂移 x ${(Math.max(...xs) - Math.min(...xs)).toFixed(2)} y ${(Math.max(...ys) - Math.min(...ys)).toFixed(2)} 物理像素`);
    const uniq = [...new Set(ys.map((v) => v.toFixed(1)))];
    log(`  红点 y 出现过的取值: ${uniq.join(' / ')}`);
    log(`  红点 x 出现过的取值: ${[...new Set(xs.map((v) => v.toFixed(1)))].join(' / ')}`);
    return { frames, label, drift: Math.max(...ys) - Math.min(...ys), fps: avg ? 1000 / avg : 0 };
}

app.whenReady().then(async () => {
    const win = new BrowserWindow({
        show: false,
        width: 1440,
        height: 900,
        webPreferences: { contextIsolation: false, backgroundThrottling: false },
    });
    win.webContents.on('console-message', (_e, _l, m) => { if (!/Security Warning/.test(m)) log('[page] ' + m); });
    await win.loadFile(path.join(__dirname, 'index.html'));
    win.showInactive();
    await sleep(1200);

    const env = await win.webContents.executeJavaScript('__env()');
    log('══ 环境 ══');
    for (const [k, v] of Object.entries(env)) log(`  ${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
    log(`  窗口: 1440×900`);
    log(`  真实视口(CSS): w=${env.docRect.w} h=${env.docRect.h}  ·  DPR=${env.dpr}`);
    log(`  innerWidth/Height: ${env.innerW}×${env.innerH}  ⇒ 取整损失 w=${(env.docRect.w - env.innerW).toFixed(2)} h=${(env.docRect.h - env.innerH).toFixed(2)}`);
    log(`  物理像素: ${Math.round(env.docRect.w * env.dpr)}×${Math.round(env.docRect.h * env.dpr)}`);

    const r1 = await captureRound(win, '第 1 轮 light → dark', 'dark');
    await sleep(400);
    const r2 = await captureRound(win, '第 2 轮 dark → light', 'light');

    log('\n══ 结论 ══');
    log(`① light→dark：红点漂移 ${r1.drift.toFixed(2)} 物理像素（0 = 画面完全静止） · ${r1.fps.toFixed(0)}fps`);
    log(`② dark→light：红点漂移 ${r2.drift.toFixed(2)} 物理像素 · ${r2.fps.toFixed(0)}fps`);
    log(`③ 取整损失: w=${(env.docRect.w - env.innerW).toFixed(2)}px h=${(env.docRect.h - env.innerH).toFixed(2)}px · DPR=${env.dpr}`);

    // 证据只走 stdout，由 run.sh 重定向进 out.txt（两个写者抢同一个文件会截断）
    app.quit();
}).catch((e) => {
    console.error('PROBE FAILED:', e && e.message ? e.message : e);
    app.exit(1);
});
