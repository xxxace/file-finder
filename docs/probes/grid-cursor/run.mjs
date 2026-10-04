/**
 * 探针 · 网格几何（方向键导航的纯逻辑部分）
 * ==============================================================================
 * 一行复跑：`node docs/probes/grid-cursor/run.mjs`
 *
 * 验什么：**网格的行结构怎么数出来、方向键怎么走**。
 *
 * 为什么必须探针而不能靠真机目视：
 *   列数是**响应式**的（`--item-width` 在 5 个断点里是 100%/6 → 20% → 33.33% → 50% → 100%，
 *   也就是 6/5/3/2/1 列，`index.vue:1867` + `1940-1958`）。目视只能验当前窗口的那一种列数，
 *   **证伪不了**"3 列时按 ↓ 会不会跳错格"。这必须一次把 5 种列数全喂完。
 *
 * 手法：esbuild 打包**真的** `src/views/FileFinder/gridGeometry.ts`（不是复刻一份），
 *      产物落在 `os.tmpdir()`，探针**零读盘**（除了打包时读源码）。
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

// ─────────────────── 1. 打包真源码（产物落 %TEMP%，不落探针目录） ───────────────────
const BUILD = path.join(os.tmpdir(), 'ff-grid-cursor-build');
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
let pass = 0;
let fail = 0;
const check = (label, cond, detail) => {
    console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? `   → ${detail}` : ''}`);
    if (cond) pass += 1; else fail += 1;
};
const eq = (label, got, want) => {
    const a = JSON.stringify(got);
    const b = JSON.stringify(want);
    check(label, a === b, a === b ? a : `得到 ${a}，期望 ${b}`);
};

/**
 * 造一批格子。
 * @param cols  列数
 * @param rows  行数
 * @param jitter 给每格加一个**浮点噪声**（模拟真实 `getBoundingClientRect` 的返回值）
 */
const ROW_H = 200;                 // 行高（与 `groupRows` 的容差论证一致：远大于 1px）
const cellsOf = (cols, rows, jitter = 0) => {
    const out = [];
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            // 同一行内噪声相同（同行必须被归到一起），行间差异远大于容差
            const noise = jitter ? (r * cols + c) % 2 === 0 ? 0 : jitter : 0;
            out.push({ key: `k${r}-${c}`, rowTop: r * ROW_H + noise });
        }
    }
    return out;
};

/**
 * 造一批格子，但只保留**前 `total` 个** —— 用来做"最后一屏不满"。
 * key 与 top 都按 `cols` 连续排下去，这样它就是真实场景下那一屏的末尾。
 */
const cellsUntil = (cols, total) => {
    const out = [];
    for (let i = 0; i < total; i++) {
        out.push({ key: `k${Math.floor(i / cols)}-${i % cols}`, rowTop: Math.floor(i / cols) * ROW_H });
    }
    return out;
};

// ─────────────────── R1 · 行分组：6/5/3/2/1 列 ───────────────────
console.log('—— R1 行分组：五种列数各认得对吗 ——');
for (const cols of [6, 5, 3, 2, 1]) {
    const rows = groupRows(cellsOf(cols, 4));
    const ok = rows.length === 4 && rows.every(r => r.length === cols);
    check(
        `${cols} 列 × 4 行 → 分成 4 行、每行 ${cols} 格`,
        ok,
        `实得 ${rows.length} 行，每行 ${rows.map(r => r.length).join('/')}`,
    );
    // 第一格与第一行第一格的 key 必须对得上（顺序 = DOM 顺序 = fileList 顺序）
    eq(`${cols} 列：rows[0][0] 是第一格`, rows[0]?.[0], 'k0-0');
}

// ─────────────────── R2 · 残行：最后一行不满（最常见的一屏末尾） ───────────────────
console.log('\n—— R2 残行：14 个格子在 6 列下 ——');
{
    const rows = groupRows(cellsUntil(6, 14));
    eq('行数', rows.length, 3);
    eq('前两行满 6 格', [rows[0].length, rows[1].length], [6, 6]);
    eq('最后一行只有 2 格', rows[2].length, 2);
}

// ─────────────────── R3 · 浮点噪声：同一行必须归到一起（判据容差要够用） ───────────────────
console.log('\n—— R3 浮点噪声：0.3px 抖动不该把一行拆成两行 ——');
{
    const rows = groupRows(cellsOf(6, 3, 0.3));
    eq('3 行 6 列在0.3px 噪声下仍分成 3 行', rows.length, 3);
    check('每行仍是 6 格', rows.every(r => r.length === 6), rows.map(r => r.length).join('/'));
}
{
    // 反向：行间差异（本夹具 200px）必须**不会**被误判成同一行
    const rows = groupRows(cellsOf(6, 3));
    eq('行间 200px 差异必须被当成不同行', rows.length, 3);
}

// ─────────────────── R4 · 边界：到头停住，不环绕（本方案的核心取舍） ───────────────────
console.log('\n—— R4 边界：四个方向到头都停住 ——');
{
    const rows = groupRows(cellsOf(6, 3));
    // 第 1 行第 1 格：↑ 出界、← 出界 ⇒ 都不动
    eq('左上角按 ↑ 停住', stepPos(rows, { r: 0, c: 0 }, 'up'), { r: 0, c: 0 });
    eq('左上角按 ← 停住', stepPos(rows, { r: 0, c: 0 }, 'left'), { r: 0, c: 0 });
    // 最后一行最后一格：↓ / → 出界
    const last = { r: 2, c: 5 };
    eq('右下角按 ↓ 停住', stepPos(rows, last, 'down'), last);
    eq('右下角按 → 停住', stepPos(rows, last, 'right'), last);
    // ⛔ 环绕是本方案明确**不做**的：第 1 行按 ← 若回到第 6 格就是环绕
    const wrapped = stepPos(rows, { r: 0, c: 0 }, 'left');
    check('第 1 行第 1 格按 ← **没有**跳到第 6 格（= 没环绕）', wrapped.c === 0, JSON.stringify(wrapped));
}

// ─────────────────── R5 · 残行上的上下：投影到目标行（2026-10-04 修正）───────────────────
console.log('\n—— R5 残行上的上下：投影到目标行，而不是停住 ——');
{
    // 3 行：前两行各 6 格，最后一行只有 2 格（同 R2）⇒ 行号 0 / 1 / 2
    const rows = groupRows(cellsUntil(6, 14));
    eq('确认是 3 行、末行 2 格', [rows.length, rows[2].length], [3, 2]);

    // 满行 → 满行：列号保持不变
    eq('第0行c=3 按 ↓ 落到第 1 行第 4 格（满行之间列号不变）',
        stepPos(rows, { r: 0, c: 3 }, 'down'), { r: 1, c: 3 });

    // 满行 → 末行，且末行**有**那一列 ⇒ 正常落
    eq('第1行c=0 按 ↓ 落到末行第 1 格（末行有 c=0）',
        stepPos(rows, { r: 1, c: 0 }, 'down'), { r: 2, c: 0 });
    eq('第1行c=1 按 ↓ 落到末行第 2 格（末行有 c=1）',
        stepPos(rows, { r: 1, c: 1 }, 'down'), { r: 2, c: 1 });

    // ⚠️ 满行 → 短行，且末行**没有**那一列（末行只有 c=0/c=1）
    //
    // ⚠️⚠️ **这条断言在 2026-10-04 被推翻过一次。**
    // 它原来锁的是「**停住**」，理由是"悄悄挪列会让『↓ 就是往下』的直觉失效"。
    // 业主真机报：`[[1 2 3 4 5][1 2 3 4]]` 焦点在 `5` 按 ↓ **没反应**。
    //
    // 那条理由**只看了"最后一行"**，漏了残行可以出现在**任何位置**
    // （搜索过滤后、封面收敛后、任何非列数整数倍的数据量）。
    // 一旦残行在中间，"按 ↓ 停住"就变成**在网格中间卡死** ——
    // 用户按 ↓ 看到焦点不动会以为程序坏了，而下面明明有格子。
    //
    // ⇒ 正解是**投影到目标行的末格**：`min(列号, 目标行长度−1)`。
    // 「↓ 是往下」这个直觉要求的恰恰是**焦点确实往下走了**，停在原地才是背离直觉的那一个。
    eq('第1行c=5 按 ↓ 落到末行**末格** c=1（投影，不卡住）',
        stepPos(rows, { r: 1, c: 5 }, 'down'), { r: 2, c: 1 });
    // 反向对称：从末行往上，列号同样投影
    eq('末行c=1 按 ↑ 回到第 1 行第 2 格',
        stepPos(rows, { r: 2, c: 1 }, 'up'), { r: 1, c: 1 });
    // ⚠️ 末行c=0 按 ↑：第 1 行有 c=0 ⇒ 不投影
    eq('末行c=0 按 ↑ 回到第 1 行第 1 格（上一行有这一列，不投影）',
        stepPos(rows, { r: 2, c: 0 }, 'up'), { r: 1, c: 0 });

    // ★ 残行在**中间**才是真正的坑（业主没提，但更严重）：搜索过滤后就会出现
    const mid = [['a', 'b', 'c', 'd', 'e', 'f'], ['g', 'h'], ['i', 'j', 'k', 'l', 'm', 'n']];
    eq('残行在中间：c=5 按 ↓ 落到短行末格 c=1（不停住）',
        stepPos(mid, { r: 0, c: 5 }, 'down'), { r: 1, c: 1 });
    eq('残行在中间：短行 c=1 按 ↓ 落到满行 c=1（恢复原列）',
        stepPos(mid, { r: 1, c: 1 }, 'down'), { r: 2, c: 1 });
    eq('残行在中间：满行 c=4 按 ↑ 落到短行末格 c=1（↑ 同样投影）',
        stepPos(mid, { r: 2, c: 4 }, 'up'), { r: 1, c: 1 });

    // ★ 真正的边界不能被投影吃掉：已在最后一行 ⇒ 停住
    eq('末行按 ↓ 停住（真边界）', stepPos(rows, { r: 2, c: 1 }, 'down'), { r: 2, c: 1 });
    eq('首行按 ↑ 停住（真边界）', stepPos(rows, { r: 0, c: 3 }, 'up'), { r: 0, c: 3 });

    // ★ 左右**不投影**：横向越界是"这一行到头了"，与纵向语义不同
    eq('第0行c=5 按 → 停住（横向不投影）', stepPos(rows, { r: 0, c: 5 }, 'right'), { r: 0, c: 5 });
    eq('末行c=1 按 → 停住（末行到头）', stepPos(rows, { r: 2, c: 1 }, 'right'), { r: 2, c: 1 });
    eq('第0行c=0 按 ← 停住（首列）', stepPos(rows, { r: 0, c: 0 }, 'left'), { r: 0, c: 0 });
    //短行的第 0 格按 → 正常走
    eq('短行c=0 按 → 到c=1（短行内正常横移）', stepPos(mid, { r: 1, c: 0 }, 'right'), { r: 1, c: 1 });
}

// ─────────────────── R6 · 退化输入：空 / 单行 / 单元素 ───────────────────
console.log('\n—— R6 退化输入 ——');
{
    eq('空网格 → 分组为空', groupRows([]), []);
    eq('空网格 → posOf 为 null', posOf([], 'x'), null);
    eq('空网格 → firstVisibleKey 为空串', firstVisibleKey([], [], 500), '');

    const one = groupRows([{ key: 'only', rowTop: 0 }]);
    eq('单元素 → 1 行 1 格', one, [['only']]);
    const p = { r: 0, c: 0 };
    eq('单元素：四个方向全部不动（唯一格是所有方向的边界）',
        ['up', 'down', 'left', 'right'].map(d => stepPos(one, p, d)),
        [p, p, p, p]);

    const row = groupRows(cellsOf(4, 1));
    eq('单行 4 格 → 只有上下被挡，左右能走',
        ['up', 'down', 'left', 'right'].map(d => stepPos(row, { r: 0, c: 1 }, d)),
        [{ r: 0, c: 1 }, { r: 0, c: 1 }, { r: 0, c: 0 }, { r: 0, c: 2 }]);
}

// ─────────────────── R7 · posOf：坐标是布局的函数，不是存下来的状态 ───────────────────
console.log('\n—— R7 posOf：同一批 key 在不同列数下坐标不同（证明不能存坐标） ——');
{
    /**
     * 同一批 key（`k0`…`k17`，**顺序连续**）按不同列数铺开。
     * key 本身不编码列数 —— 这样同一个 key 在两种布局下的坐标才会真的不同。
     * （`cellsUntil` 的 key 里带行列号，用它做这个断言会得到"坐标恰好相同"的假象）
     */
    const flat = (cols, total) => {
        const out = [];
        for (let i = 0; i < total; i++) out.push({ key: `k${i}`, rowTop: Math.floor(i / cols) * ROW_H });
        return out;
    };
    const six = groupRows(flat(6, 18));
    const three = groupRows(flat(3, 18));
    eq('6 列：k7 在第 1 行第 2 格', posOf(six, 'k7'), { r: 1, c: 1 });
    eq('3 列：k7 在第 2 行第 2 格（**同一 key，坐标不同**）', posOf(three, 'k7'), { r: 2, c: 1 });
    eq('同一 key 两次查询都非空（不是野 key）',
        [posOf(six, 'k7') !== null, posOf(three, 'k7') !== null], [true, true]);
    eq('不存在的 key → null（野 cursorKey 靠这个判失效）', posOf(six, 'ghost'), null);
}

// ─────────────────── R8 · 首次激活落点：与**可视区相交**的第一行 ───────────────────
console.log('\n—— R8 首次激活落点（双边界：必须与可视区相交）——');
{
    // 5 行 × 6 格，rowTops = 0 / 200 / 400 / 600 / 800
    const rows = groupRows(cellsOf(6, 5));
    const tops = rows.map((_, r) => r * 200);

    // 场景 1：视口覆盖 -1000 ~ 500 ⇒ 相交的行是 0/1/2，落最靠上的第 0 行
    eq('视口 -1000~500 → 落第 0 行（相交且最靠上）',
        firstVisibleKey(rows, tops, -1000, 500), 'k0-0');
    // 场景 2：视口 -1000 ~ 50 ⇒ 只相交第 0 行
    eq('视口 -1000~50（只露出第 0 行）→ 落第 0 行',
        firstVisibleKey(rows, tops, -1000, 50), 'k0-0');

    // ⚠️ 场景 3：**屏幕停在中间**（`onBack` 恢复 `scrollY` 之后的真实状态）
    //   视口 350 ~ 650 ⇒ 相交的是第 2 行（top=400）
    //   ⛔ 旧判据只给下界时会返回第 0 行（top=0 是很大的负数 ⇒ 恒 < 650），
    //   也就是**选择器落在屏幕上方看不见的地方**，随后 scrollIntoView 把视口拉到顶。
    eq('★视口 350~650（屏幕停在中间）→ 落第 2 行（**在视口内**，不是第 0 行）',
        firstVisibleKey(rows, tops, 350, 650), 'k2-0');

    // 场景 4：视口刚好贴着一行的上沿（浮点边界）
    eq('视口 200~650（上沿正好在第 1 行 top 上）→ 落第 1 行',
        firstVisibleKey(rows, tops, 200, 650), 'k1-0');

    // 场景 5：视口在所有行**上方**（内容太短 / 容器异常）⇒ 兜底，不返回空串
    eq('视口 -2000~-1900（在所有行上方）→ 兜底落第 0 行（不能返回空串）',
        firstVisibleKey(rows, tops, -2000, -1900), 'k0-0');
    eq('视口 2000~2100（在所有行下方）→ 同样兜底',
        firstVisibleKey(rows, tops, 2000, 2100), 'k0-0');

    // 反向：⛔ 旧判据（只给下界）在场景 3 会给出什么 —— 锁住这个反例，
    // 免得将来有人"简化"回单边界。
    const oldJudge = (rts, vb) => { for (let r = 0; r < rows.length; r++) if (rts[r] < vb - 1) return rows[r][0]; return rows[0][0]; };
    check('（对照）旧判据在"屏幕停在中间"时落在**看不见**的第 0 行（这正是被修的 bug）',
        oldJudge(tops, 650) === 'k0-0' && firstVisibleKey(rows, tops, 350, 650) !== 'k0-0',
        `旧判据 ${oldJudge(tops, 650)} vs 新判据 ${firstVisibleKey(rows, tops, 350, 650)}`);

    // 容器量不到时的退路（useGridCursor 传 ±Infinity）
    eq('退路：视口 -Inf~+Inf → 落第 0 行',
        firstVisibleKey(rows, tops, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY), 'k0-0');
}

// ───────────────────汇总 ───────────────────
console.log(`\n─────────────────────────────\n${pass} PASS / ${fail} FAIL\n`);
fs.writeFileSync(path.join(here, 'out.txt'),
    `grid-cursor 探针\n${new Date().toISOString()}\n${pass} PASS / ${fail} FAIL\n` +
    `（一���复跑：node docs/probes/grid-cursor/run.mjs）\n`);
process.exit(fail ? 1 : 0);
