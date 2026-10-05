/**
 * 探针 · `.crumb-text` 顶部到底有没有被 overflow 裁切
 *
 * 一行复跑：`bash docs/probes/crumb-clip/run.sh`（会先重建真实 scoped CSS，再重建 out.txt）
 *
 * 用**真实编译产物** CSS（`../header-width/css-real.generated.css`）+ 真 naive-ui + 真 Chromium。
 *
 * 判据为什么这么设计：
 *   ① 字形墨迹的溢出（ink overflow）**不进** scrollHeight ⇒ 量盒子永远量不到，必须像素级；
 *   ② 被裁时剩下的墨迹**正好从裁剪边界开始**，所以"墨迹顶 vs 盒子顶"在看被裁的渲染时永远是 0，
 *      看不出丢了东西 ⇒ 真判据是「**同位置、只把裁剪盒撑大**」的对照（padding 撑 padding-box
 *      + 负 margin 抵消布局），两列的像素差就是被裁掉的墨迹。
 *
 * 环境坑照抄 docs/probes/header-width/run.cjs。
 *
 * ⚠️ 本探针踩过的三个坑（别重犯）：
 *   ① 截图框把**上一行的标签文字**框进来了 ⇒ 差异全都是标签（把标签行排除在扫描区间外）；
 *   ② 旋钮写在 `.nav-zone.k-*` 上，而 `.nav-zone` 漏了 `data-v-probe` ⇒ **所有旋钮静默失效**，
 *      探针连报三轮"0 裁切"（真实 scoped CSS 与探针覆盖都要求那个属性）⇒ 每次跑完先看
 *      「旋钮生效校验」那几行；
 *   ③ 窗口高度不够 ⇒ `capturePage` 抛 UnknownVizError（行数 × 行高要装得下）。
 */
const { app, BrowserWindow, nativeImage } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

app.setPath('userData', path.join(os.tmpdir(), 'probe-crumb-clip-final'));
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.disableHardwareAcceleration();

const lines = [];
const log = (s = '') => { lines.push(s); console.log(s); };
/** ⚠️ 证据必须落 .txt：`console.table` 不进 out.txt ⇒ 统一走这个（同时写屏与写文件） */
function table(rows) {
    log(require('node:util').inspect(rows, { depth: null, compact: false, breakLength: 170, maxArrayLength: null }));
}
const lum = (b, g, r) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** 只在 tag 内部统计：y∈[3+1, 31-1)（排除上一行文字与 tag 上下边框） */
const REG = { y0: 4, y1: 30 };

function inkOf(img, w, x0, x1, thr = 140) {
    const b = img.toBitmap();
    let top = -1, bottom = -1, ink = 0;
    for (let y = REG.y0; y < REG.y1; y++) {
        let has = false;
        for (let x = x0; x < x1; x++) {
            const i = (y * w + x) * 4;
            if (lum(b[i], b[i + 1], b[i + 2]) < thr) { has = true; ink++; }
        }
        if (has) { if (top < 0) top = y; bottom = y; }
    }
    return { top, bottom, ink };
}

function diffTag(a, b, w, x0, x1, thr = 10) {
    const A = a.toBitmap(), B = b.toBitmap();
    let pixels = 0; const hit = [];
    for (let y = REG.y0; y < REG.y1; y++) {
        let n = 0;
        for (let x = x0; x < x1; x++) {
            const i = (y * w + x) * 4;
            if (Math.abs(A[i] - B[i]) > thr || Math.abs(A[i + 1] - B[i + 1]) > thr || Math.abs(A[i + 2] - B[i + 2]) > thr) n++;
        }
        if (n) { pixels += n; hit.push(y); }
    }
    return { pixels, from: hit[0] ?? -1, to: hit[hit.length - 1] ?? -1 };
}

function upscale(img, w, h, k) {
    const s = img.toBitmap();
    const out = Buffer.alloc(w * k * h * k * 4);
    for (let y = 0; y < h * k; y++) for (let x = 0; x < w * k; x++) {
        const si = ((y / k) | 0) * w * 4 + ((x / k) | 0) * 4, di = (y * w * k + x) * 4;
        out[di] = s[si]; out[di + 1] = s[si + 1]; out[di + 2] = s[si + 2]; out[di + 3] = s[si + 3];
    }
    return nativeImage.createFromBitmap(out, { width: w * k, height: h * k });
}

app.whenReady().then(async () => {
    const win = new BrowserWindow({
        show: false, width: 1000, height: 1260,
        webPreferences: { contextIsolation: false, backgroundThrottling: false, offscreen: true },
    });
    win.webContents.on('console-message', (_e, _l, m) => { if (!/Security Warning/.test(m)) log('[page] ' + m); });
    await win.loadFile(path.join(__dirname, 'index.html'));
    await new Promise((r) => setTimeout(r, 1500));

    const geom = await win.webContents.executeJavaScript('__probe()');
    const font = await win.webContents.executeJavaScript('__fontMetrics()');
    const rects = await win.webContents.executeJavaScript('__rects()');
    const W = rects[0].width, H = rects[0].height;
    const G = (id) => geom.find((x) => x.id === id);

    log(`══ 真 scoped CSS（docs/probes/header-width/css-real.generated.css）· dpr ${geom[0].dpr} · 截图框 ${W}×${H}（tag 顶在框内 y=3）══`);
    log(`   tag 高 = ${[...new Set(geom.map((g) => g.tag.h))].join('/')}px（应恒为 28）`);

    log('\n── 字体自己的度量（bold 14px）。line-height:1 ⇒ 行盒只有 14px，字体内容区若 >14px 就会被切 ──');
    table(font);

    const shots = {};
    for (const r of rects) shots[r.id] = await win.webContents.capturePage(r);

    const combos = [...new Set(rects.map((r) => r.id.replace(/\|(before|beforeBig|cur|curBig)$/, '')))];
    const rows = [];
    for (const c of combos) {
        const [fid, text] = c.split('|');
        const gCur = G(`${c}|cur`), gCurBig = G(`${c}|curBig`), gBefore = G(`${c}|before`);
        const w = Math.min(gCur.tag宽, gBefore.tag宽);
        const x0 = 8, x1 = Math.max(9, Math.round(6 + w - 2));
        const dBefore = diffTag(shots[`${c}|before`], shots[`${c}|beforeBig`], W, x0, x1);
        const dCur = diffTag(shots[`${c}|cur`], shots[`${c}|curBig`], W, x0, x1);
        const ink = inkOf(shots[`${c}|curBig`], W, x0, x1);
        const cropY = rects.find((r) => r.id === `${c}|curBig`).y;
        // 当前列仍在裁的盒子的并集边界（padding box）
        const tops = [], bots = [];
        if (gCur.文本盒overflow === 'hidden') { tops.push(gCur.文本盒.t); bots.push(gCur.文本盒.t + gCur.文本盒.h); }
        if (gCur.内容盒overflow === 'hidden') { tops.push(gCur.内容盒.t); bots.push(gCur.内容盒.t + gCur.内容盒.h); }
        const clipTop = Math.max(...tops);
        rows.push({
            组合: `${fid} / ${text}`,
            行高_修复前: gBefore.行高,
            行高_当前: gCur.行高,
            文本盒高_修复前: gBefore.文本盒.h,
            文本盒高_当前: gCur.文本盒.h,
            真墨迹高: +(ink.bottom - ink.top + 1).toFixed(1),
            真墨迹顶相对tag顶: ink.top < 0 ? '—' : +(cropY + ink.top + 0.5 - gCurBig.tag.t).toFixed(1),
            裁剪盒顶相对tag顶: +(clipTop - gCur.tag.t).toFixed(1),
            顶余量: ink.top < 0 ? '—' : +((cropY + ink.top + 0.5) - clipTop).toFixed(1),
            修复前被裁: dBefore.pixels,
            修复前裁在: dBefore.pixels ? `${dBefore.from - 3}~${dBefore.to - 3}px` : '—',
            当前被裁: dCur.pixels,
            当前裁在: dCur.pixels ? `${dCur.from - 3}~${dCur.to - 3}px` : '—',
        });
    }
    log('\n── 每个组合：①②（line-height:1）与 ③④（当前 scoped CSS）各与自己的"裁剪盒撑大"对照 ──');
    table(rows);

    log('\n── 旋钮生效校验：各列行高（「修复前」必须是 14px，否则说明探针旋钮失效、整轮结论作废）──');
    for (const k of ['before', 'beforeBig', 'cur', 'curBig']) {
        log(`  ${k}: 行高 = ${[...new Set(geom.filter((g) => g.id.endsWith('|' + k)).map((g) => g.行高))].join('/')}`);
    }
    log('  lh09 抽样: ' + geom.filter((g) => g.id.startsWith('lh09')).slice(0, 2)
        .map((g) => `${g.id} lh=${g.行高} tag="${g.tagClass}" text="${g.textClass}"`).join(' | '));

    const still = rows.filter((r) => r.当前被裁 > 0);
    const was = rows.filter((r) => r.修复前被裁 > 0);
    const slack = rows.filter((r) => typeof r.顶余量 === 'number').sort((a, b) => a.顶余量 - b.顶余量);
    log('\n── 结论 ──');
    log(`① line-height:1（修复前）被裁的组合：${was.length}/${rows.length}` +
        (was.length ? '  →  ' + was.map((r) => `${r.组合}(${r.修复前被裁}px @ ${r.修复前裁在})`).join('；') : ''));
    log(`② 当前 scoped CSS 被裁的组合：${still.length}/${rows.length}` +
        (still.length ? '  →  ' + still.map((r) => `${r.组合}(${r.当前被裁}px @ ${r.当前裁在})`).join('；') : ''));
    log(`③ 顶余量最小的 4 组：` + slack.slice(0, 4).map((r) => `${r.组合}=${r.顶余量}px`).join('  '));
    log(`④ 行高：修复前 ${[...new Set(rows.map((r) => r.行高_修复前))].join('/')} · 当前 ${[...new Set(rows.map((r) => r.行高_当前))].join('/')}`);
    log(`   文本盒高：修复前 ${[...new Set(rows.map((r) => r.文本盒高_修复前))].join('/')} · 当前 ${[...new Set(rows.map((r) => r.文本盒高_当前))].join('/')}`);
    log(`⑤ tag 高（布局不变性）= ${[...new Set(geom.map((g) => g.tag.h))].join('/')}px · 文本盒 overflow = ${[...new Set(geom.map((g) => g.文本盒overflow))].join('/')} · 横向截断 = ${[...new Set(geom.map((g) => g.横向被裁))].join('/')}`);

    const show = (was.length ? was.slice(0, 2) : rows.slice(0, 2)).map((r) => r.组合.replace(/ \/ /, '|'));
    for (const c of show) {
        for (const k of ['before', 'beforeBig', 'cur', 'curBig']) {
            const id = `${c}|${k}`;
            if (shots[id]) fs.writeFileSync(path.join(__dirname, `zoom-${c.replace(/\|/g, '_')}-${k}.png`), upscale(shots[id], W, H, 8).toPNG());
        }
    }
    log(`⑥ 放大 8× 目视证据已存：${show.length * 4} 张 zoom-*.png`);

    fs.writeFileSync(path.join(__dirname, 'out.txt'), lines.join('\n') + '\n');
    app.quit();
}).catch((e) => {
    console.error('PROBE FAILED:', e && e.message ? e.message : e);
    app.exit(1);
});
