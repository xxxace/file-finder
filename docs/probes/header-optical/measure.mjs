/**
 * 顶栏地址槽的**光学居中**测量 —— 只读、零依赖除 ffmpeg、不上浏览器。
 *
 * 为什么要有它：`视觉对齐` 这句话没有判据就一直靠吵。这个脚本把"槽中线"和
 * "每一块墨迹的重心"都算成数，直接打出差值（物理 px 与逻辑 px 各一份）。
 *
 *      node docs/probes/header-optical/measure.mjs <地址槽截图.png> [--dpr=1.25] [--tol=0.5]
 *
 * 用法：把顶栏地址槽**连同一圈背景**截下来（背景必须有，脚本靠"逐行中位亮度"
 * 找槽的上下边界）。截图不必裁得多准，槽整条在里面就行。
 *
 * 退出码：所有墨迹块都落在容差内 = 0；有偏差 = 1（可以直接串在别的流程后面）。
 *
 * ⚠️ 脱敏：**不打印入参路径**（探针产物最容易带用户名与绝对路径）。
 * ⚠️ 为什么不用 node 的 png 解码：本仓库没有 pngjs/sharp，装了也是多一个依赖；
 *    项目自带 ffmpeg，转 rgb24 裸数据一行就够。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { path as ffmpegPath } from '@ffmpeg-installer/ffmpeg';

const args = process.argv.slice(2);
const src = args.find(a => !a.startsWith('--'));
if (!src) {
    console.error('用法: node docs/probes/header-optical/measure.mjs <截图.png> [--dpr=1.25] [--tol=0.5]');
    process.exit(2);
}
const num = (name, dflt) => {
    const hit = args.find(a => a.startsWith(`--${name}=`));
    return hit ? Number(hit.split('=')[1]) : dflt;
};
const DPR = num('dpr', 1.25);
const TOL = num('tol', 0.5);

/** ffmpeg 取尺寸（-i 无输出时会以非零码退出，但 stderr 里有尺寸） */
let W = 0, H = 0;
try {
    execFileSync(ffmpegPath, ['-hide_banner', '-i', src], { stdio: 'pipe' });
} catch (e) {
    const m = String(e.stderr || '').match(/,\s(\d+)x(\d+)[,\s]/);
    if (!m) throw new Error('取不到图片尺寸');
    W = Number(m[1]);
    H = Number(m[2]);
}

const rawPath = join(tmpdir(), `ff-optical-${process.pid}.rgb`);
execFileSync(ffmpegPath, ['-y', '-loglevel', 'error', '-i', src, '-f', 'rawvideo', '-pix_fmt', 'rgb24', rawPath]);
const buf = readFileSync(rawPath);
try { unlinkSync(rawPath); } catch { /* 删不掉只是留个临时文件 */ }

const R = (x, y) => buf[(y * W + x) * 3];
const G = (x, y) => buf[(y * W + x) * 3 + 1];
const B = (x, y) => buf[(y * W + x) * 3 + 2];
const luma = (x, y) => (R(x, y) * 299 + G(x, y) * 587 + B(x, y) * 114) / 1000;

// ── 1. 找槽：逐行中位亮度里**出现次数最多**的那一档就是槽底色 ───────────────
const rowMedian = [];
for (let y = 0; y < H; y++) {
    const arr = [];
    for (let x = 0; x < W; x++) arr.push(luma(x, y));
    arr.sort((a, b) => a - b);
    rowMedian.push(Math.round(arr[arr.length >> 1]));
}
const freq = new Map();
for (const v of rowMedian) freq.set(v, (freq.get(v) || 0) + 1);
let fill = 0, best = -1;
for (const [v, n] of freq) if (n > best) { best = n; fill = v; }
const slotRows = rowMedian.map((v, y) => (Math.abs(v - fill) <= 3 ? y : -1)).filter(y => y >= 0);
if (slotRows.length < 8) {
    console.error(`找不到地址槽（逐行中位数没有稳定的一档；最多的一档只占 ${best} 行）`);
    process.exit(2);
}
const slotTop = slotRows[0], slotBottom = slotRows[slotRows.length - 1];
const slotMid = (slotTop + slotBottom) / 2;

// ── 2. 逐列找墨迹，按 x 间隙聚成块 ─────────────────────────────────────────
const INK = 25;                       // 比槽底色亮多少算"有东西"
const isInk = (x, y) => luma(x, y) - fill > INK || R(x, y) - G(x, y) > 40;
const cols = [];
for (let x = 0; x < W; x++) {
    let has = false;
    for (let y = slotTop; y <= slotBottom && !has; y++) if (isInk(x, y)) has = true;
    cols.push(has);
}
const runs = [];
for (let x = 0; x < W; x++) {
    if (!cols[x]) continue;
    const last = runs[runs.length - 1];
    if (last && x - last.x1 <= 4) last.x1 = x;
    else runs.push({ x0: x, x1: x });
}

// ── 3. 每块：bbox + 亮度加权重心 ───────────────────────────────────────────
const blocks = runs.map(({ x0, x1 }) => {
    let t = H, b = -1, sy = 0, sw = 0, red = 0, n = 0;
    for (let y = slotTop; y <= slotBottom; y++) {
        for (let x = x0; x <= x1; x++) {
            if (!isInk(x, y)) continue;
            if (y < t) t = y;
            if (y > b) b = y;
            const w = Math.max(1, luma(x, y) - fill);
            sy += y * w; sw += w; n++;
            if (R(x, y) - G(x, y) > 40) red++;
        }
    }
    return {
        x0, x1, top: t, bottom: b,
        centroid: sy / sw,
        mid: (t + b) / 2,
        redRatio: n ? red / n : 0,
        height: b - t + 1,
    };
});

const fmt = v => (v >= 0 ? `+${v.toFixed(2)}` : v.toFixed(2));
console.log(`图 ${W}×${H} · DPR ${DPR} · 槽 y ${slotTop}..${slotBottom}（${slotBottom - slotTop + 1} 物理 = ${((slotBottom - slotTop + 1) / DPR).toFixed(1)} 逻辑）`);
console.log(`槽中线 = ${slotMid.toFixed(2)}`);
console.log('');
console.log('  x 范围        高   重心    bbox中线   重心−中线（物理 / 逻辑）   判定   可能是');
let bad = 0;
for (const b of blocks) {
    const d = b.centroid - slotMid;
    const dl = d / DPR;
    const ok = Math.abs(dl) <= TOL;
    if (!ok) bad++;
    const kind = b.redRatio > 0.35 ? '红角标' : b.height <= 10 ? '分隔符' : '文字';
    console.log(
        `${String(b.x0).padStart(4)}–${String(b.x1).padEnd(4)}  ${String(b.height).padStart(3)}  ${b.centroid.toFixed(2)}  ${b.mid.toFixed(2).padStart(7)}   ${fmt(d).padStart(6)} / ${fmt(dl).padStart(6)}          ${ok ? 'OK  ' : '偏了'}   ${kind}`,
    );
}
console.log('');
if (bad) {
    console.log(`✗ ${bad} 块超过 ±${TOL} 逻辑 px。负=偏高、正=偏低。`);
    process.exit(1);
}
console.log(`✓ 全部落在 ±${TOL} 逻辑 px 内。`);
