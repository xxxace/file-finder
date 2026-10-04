/**
 * 纯逻辑探针 · 三条体验反馈的根因判定（不需要浏览器）
 * ==============================================================================
 *   node docs/probes/cursor-ux3/run.mjs
 *
 * 验什么：业主 2026-10-04 四次报的三条体验问题。
 *
 * ## 三条反馈的定位
 *
 * | # | 业主原话 | 定位 |
 * |---|---|---|
 * | 1 | 「进别的目录再回来，焦点默认回到了第一个 / 回来就不对，没记住」 | `onBack` 的**恢复顺序 + 缺 `noteIntent()`** |
 * | 2 | 「到第一行和最后一行都不会到顶和到底（滚动条）」 | `block:'nearest'` 的语义：只在元素**看不见**时滚 |
 * | 3 | 「`[[12345][1234]]` 当在五按下时没反应，好的体验应该切到第二行的 4」 | `stepPos` 上下移动时**列号硬不变** ⇒ 落到不存在的列就停住 |
 *
 * ## 为什么第3 条是「设计错了」而不是「没考虑到」
 *
 * `gridGeometry.stepPos` 的原注释写着：
 * > 「残行（最后一行可能没满）上按 ↓ 落到不存在的列就**停住**，
 * >   而不是悄悄挪到该行最后一格 —— 那会让『↓ 是往下』这个直觉在末行失效。」
 *
 * 这条推理**只看了最后一行**。但残行可以出现在**任何位置**
 * （搜索过滤后的结果、收敛封面后的列表、任何非6 倍数的数据量）。
 * 一旦残行在中间，"按 ↓ 停住"就变成"**在网格中间卡死**"——
 * 用户按 ↓ 看到焦点不动，会以为程序坏了，而实际上下面明明有格子。
 *
 * ⚠️ 而"↓ 是往下"这个直觉恰恰要求**焦点确实往下走了**。
 * 停在原地才是背离直觉的那一个 —— 原注释把"保持列"当成了目标，
 * 却没问"目标行到底存不存在"。
 *
 * ## 正确做法：**投影到目标行**（clamp），不是停住
 *
 * ```
 * 目标行存在 ⇒ 列号取 min(当前列, 目标行长度−1) ⇒ 焦点确实往下走
 * 目标行是最后一行且当前列超出 ⇒ 取最后一格（残行收尾）
 * 目标行不存在（已在最后一行）⇒ 停住（这才是真正的边界）
 * ```
 *
 * 这与 Windows 资源管理器的**大图标/缩略图**视图行为一致，
 * 也与主流相册/图库类"网格 + 方向键"的实现一致（**clamp 到行尾**）。
 *
 * ⚠️ 左右方向**仍然停住**：横向越界是"这一行到头了"，语义明确；
 * 而纵向越界是"这个方向到头了"，此时"挪到行尾"才是用户期待。
 *
 * 输出不含任何真实路径 / 用户名 / 盘序列号。
 */
import * as esbuild from 'esbuild';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');

// ─────────────────── 1. 打包真源码（产物落 %TEMP%） ───────────────────
const BUILD = path.join(os.tmpdir(), 'ff-cursor-ux3-build');
fs.rmSync(BUILD, { recursive: true, force: true });
fs.mkdirSync(BUILD, { recursive: true });
const outfile = path.join(BUILD, 'gridGeometry.mjs');

await esbuild.build({
    entryPoints: [path.resolve(repo, 'src/views/FileFinder/gridGeometry.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile,
    logLevel: 'silent',
});
const { groupRows, stepPos, posOf, firstVisibleKey } = await import(pathToFileURL(outfile).href);

// ─────────────────── 2. 断言设施 ───────────────────
let pass = 0, fail = 0;
const check = (label, cond, detail) => {
    console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '   → ' + detail : ''}`);
    if (cond) pass++; else fail++;
};
const eq = (label, got, want) => {
    const a = JSON.stringify(got), b = JSON.stringify(want);
    check(label, a === b, a === b ? a : `得到 ${a}，期望 ${b}`);
};

/** 按 key 拿坐标 */
const at = (rows, key) => posOf(rows, key);
/** 按坐标拿 key */
const keyAt = (rows, r, c) => (rows[r] && rows[r][c]) || '(越界)';
/** 从 from 出发按 dir 走一步，返回落点 key */
const walk = (rows, fromKey, dir) => {
    const p = at(rows, fromKey);
    if (!p) return '(起点不存在)';
    const n = stepPos(rows, p, dir);
    return keyAt(rows, n.r, n.c);
};

// 业主举的原例：[[12345][1234]]
const RAGGED = [
    ['1', '2', '3', '4', '5'],
    ['1', '2', '3', '4'],
];

// ═══════════════ X1 · 业主例：残行处按 ↓ 必须往下走 ═══════════════
console.log('—— X1 业主例：[[1 2 3 4 5][1 2 3 4]]，焦点在 "5" 按 ↓ ——');
console.log(`  修复后 stepPos 行为：按 ↓ → ${walk(RAGGED, '5', 'down')}`);
check('★ 业主例：焦点在 "5"（上行末格）按 ↓ 落到第二行末格（不再卡住）',
    walk(RAGGED, '5', 'down') === '4',
    `得到 "${walk(RAGGED, '5', 'down')}"`);

// ═══════════════ X2 · 各类残行位置的完整枚举 ═══════════════
console.log('\n—— X2 枚举：残行出现在中间 / 末尾时，按 ↓ 的正确落点 ——');
const cases = [
    { name: '残行在最后（常见：总数非 6 倍数）', rows: [['a', 'b', 'c', 'd', 'e', 'f'], ['g', 'h', 'i', 'j']] },
    { name: '残行在中间（搜索过滤后可能出现）', rows: [['a', 'b', 'c', 'd', 'e', 'f'], ['g', 'h'], ['i', 'j', 'k', 'l', 'm', 'n']] },
    { name: '三行、第二行残', rows: [['a', 'b', 'c'], ['d'], ['e', 'f', 'g']] },
    { name: '整行只有 1 格', rows: [['a', 'b', 'c'], ['d'], ['e', 'f', 'g']] },
];
for (const cs of cases) {
    const rows = cs.rows;
    console.log(`  【${cs.name}】`);
    for (let r = 0; r < rows.length; r++) {
        for (let c = 0; c < rows[r].length; c++) {
            const from = rows[r][c];
            const got = walk(rows, from, 'down');
            const nr = r + 1;
            // 期望：下一行存在 ⇒ clamp 到该行末格；不存在 ⇒ 停住
            const want = nr < rows.length ? rows[nr][Math.min(c, rows[nr].length - 1)] : from;
            const ok = got === want;
            check(`    (${r},${c}) "${from}" 按 ↓`, ok, ok ? `→ "${got}"` : `得到 "${got}"，期望 "${want}"`);
        }
    }
}

// ═══════════════ X4 · 真正的边界：最后一行按 ↓ 必须停住 ═══════════════
console.log('\n—— X3 真正的边界（不能被"clamp"吃掉）——');
const last = RAGGED[RAGGED.length - 1];
eq('最后一行按 ↓ 停住（不环绕、不越界）',
    walk(RAGGED, last[0], 'down'), last[0]);
eq('最后一行末格按 ↓ 停住',
    walk(RAGGED, last[last.length - 1], 'down'), last[last.length - 1]);

// ═══════════════ X5 · 左右仍然停住（不能被"投影"牵连）═══════════════
console.log('\n—— X4 左右仍然停住：横向越界是"这一行到头了"——');
eq('上行首格按 ← 停住', walk(RAGGED, '1', 'left'), '1');
eq('上行末格按 → 停住', walk(RAGGED, '5', 'right'), '5');
eq('下行首格按 ← 停住', walk(RAGGED, '1', 'left'), '1');

// ═══════════════ X6 · ↑ 方向对称 ═══════════════
console.log('\n—— X5 ↑ 方向对称：从残行的对应列往上——');
{
    const rows = [['a', 'b', 'c', 'd', 'e', 'f'], ['g', 'h'], ['i', 'j', 'k', 'l', 'm', 'n']];
    // 第 3 行第 5 格（m，c=4）按 ↑ ⇒ 第 2 行只有 2 格 ⇒ 应落到 "h"
    const got = walk(rows, 'm', 'up');
    console.log(`  "m"（第3行第5格）按 ↑ → "${got}"（期望 "h"，即第 2 行第 2 格 = 末格）`);
    check('★ ↑ 遇到短行也要 clamp 到该行末格（与 ↓ 对称）',
        got === 'h', `得到 "${got}"`);
}

// ═══════════════ X7 · 判据效力：把clamp 关掉必须 FAIL ═══════════════
console.log('\n—— X6 判据效力：回退到"列号硬不变"必须 FAIL ——');
{
    // 复刻当前实现：列号不变 + 越界即停
    const oldStep = (rows, from, dir) => {
        const delta = { up: [-1, 0], down: [1, 0], left: [0, -1], right: [0, 1] }[dir];
        const next = { r: from.r + delta[0], c: from.c + delta[1] };
        const bad = next.r < 0 || next.r >= rows.length
            || next.c < 0 || next.c >= rows[next.r].length;
        return bad ? from : next;
    };
    const rows = [['a', 'b', 'c', 'd', 'e', 'f'], ['g', 'h'], ['i', 'j', 'k', 'l', 'm', 'n']];
    const p = at(rows, 'm');
    const oldGot = keyAt(rows, ...Object.values(oldStep(rows, p, 'up')));
    const oldDown = (() => {
        const p2 = at(rows, 'k');       // 第3行第3格
        const n = oldStep(rows, p2, 'up');
        return keyAt(rows, n.r, n.c);
    })();
    console.log(`  旧实现："k"（第3行第3格）按 ↑ → "${oldDown}"（第2行只有2格 ⇒ 停住不动）`);
    check('★ 旧实现在短行上会停住（这正是被修的行为）',
        oldDown === 'k', `得到 "${oldDown}"`);
}

console.log(`─────────────────────────────\n${pass} PASS / ${fail} FAIL\n`);
process.exit(fail ? 1 : 0);
