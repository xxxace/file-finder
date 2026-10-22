/**
 * 探针 · 番号候选链 A/B（真实全库 1471 条目上对比现有规则 vs 候选规则）
 * ===========================================================================
 * 目的：`match.ts` 该不该放宽、放宽多少，**只能用真实数据判**。
 * 本探针**只读系统盘缓存**（零读盘/零网络/不启 Electron），
 * 在全库所有名字（目录名 + 视频名 + 图片名）上跑两套规则，输出**差异集**：
 *   · 原本认不出 → 现在认出   （= 补上的漏，逐条人工判断对不对）
 *   · 原本认出   → 变成别的   （= 回归风险，必须为空）
 *   · 原本认不出 → 仍认不出   （= 仍不覆盖的形态）
 *
 * 输出只打 stdout，不打印盘序列号/绝对路径。
 *
 * ⚠️ 合并后它会"自证"：`CAND` 一旦与 `match.ts` 完全一致，差异集**恒为 0**（只说明两套规则相同）。
 *    再试新想法必须把 `CAND` 换成**候选**规则，否则 0 差异 = 什么都没测。
 * 一行复跑：node docs/probes/parse-title/ab.mjs
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as esbuild from 'esbuild';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');

// ── 现有真实实现 ─────────────────────────────────────────────────────────
const outDir = path.join(os.tmpdir(), 'ff-parse-title-probe');
fs.mkdirSync(outDir, { recursive: true });
const outfile = path.join(outDir, 'match.mjs');
await esbuild.build({
    entryPoints: [path.join(repo, 'electron/server/assistant/match.ts')],
    bundle: true, format: 'esm', platform: 'node', outfile, logLevel: 'silent',
});
const { parseTitle: current } = await import(pathToFileURL(outfile).href);

// ── 候选规则（**尚未写进源码**，只在本探针里试）──────────────────────────
// 诊断：现有链的两个形态缺口来自同一个假设 ——「字母段=纯字母、数字段=纯数字」。
// 真实番号里字母数字可以在两侧任意混（字母序号型 TSK-S51 / 字母段混数字型 TST2A3B-21 / 混前缀 X28-123）。
// 唯一可靠信号不是字符类型，而是「有分隔符 + 两侧各是紧凑 token + 至少一侧含数字」。
const CAND = [
    // ① FC2（不变）
    { re: /\bFC2[-_ ]?PPV[-_ ]?(\d{3,8})(?![0-9A-Za-z])/i, build: m => `FC2-PPV-${m[1]}` },
    // ②′ 通用：字母段**允许含数字**（TST2A3B-21 / X28-123），数字段仍须纯数字；
    //     分隔符**去掉空格** —— 空格是最弱的分隔符，英文标题天然含空格
    //     （实测：`示例歌手 - XYZ (2018 - ...)` 被认成 `XYZ-2018`）
    {
        re: /\b(\d{0,3}[A-Za-z][A-Za-z0-9]{1,7})[-_](\d{2,6})(?![0-9A-Za-z])/,
        build: m => `${m[1].toUpperCase()}-${m[2]}`,
    },
    // ③′ 数字段带**单个字母前缀**（TSK-S51 / 及 -S01/-C02 这类系列）
    {
        re: /\b([A-Za-z][A-Za-z0-9]{1,7})[-_]([A-Za-z]\d{1,5})(?![0-9A-Za-z])/,
        build: m => `${m[1].toUpperCase()}-${m[2].toUpperCase()}`,
    },
    // ④′ 日期型：6 位数字 - 2~4 位序号（Caribbean / 1pondo 的 MMDDYY-NNN）
    //     ⚠️ 左段必须 6 位：这是与分卷 `1-2` / `10-1` 的唯一可分信号
    {
        re: /\b(\d{6})[-_](\d{2,4})(?![0-9A-Za-z])/,
        build: m => `${m[1]}-${m[2]}`,
    },
];
function candidate(base) {
    let s = base.trim().replace(/[[\]()【】]/g, ' ').replace(/\s+/g, ' ').trim();
    let part;
    const pm = s.match(/[-_ ]?(?:cd|part|disc|disk)\s*([0-9]{1,2})$/i) || s.match(/[-_ ]([0-9])$/);
    if (pm && pm.index !== undefined) { part = Number(pm[1]); s = s.slice(0, pm.index).trim(); }
    let id = '';
    for (const p of CAND) { const m = s.match(p.re); if (m) { id = p.build(m); break; } }
    return { id, base: id || s.toUpperCase(), part };
}

// ── 读全库 ───────────────────────────────────────────────────────────────
const KEY = crypto.createHash('sha256').update('file-finder-cache-v1-2026-09-24').digest();
const IV = Buffer.alloc(16, 0);
function dec(line) {
    if (line.startsWith('{')) return line;
    const d = crypto.createDecipheriv('aes-256-cbc', KEY, IV);
    return Buffer.concat([d.update(Buffer.from(line, 'base64')), d.final()]).toString('utf8');
}
const dbPath = path.join(os.homedir(), '.file-finder', 'searchCache.db');
const byId = new Map();
for (const line of fs.readFileSync(dbPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { const o = JSON.parse(dec(line)); byId.set(o._id, o); } catch { /* 跳过坏行 */ }
}
const docs = [...byId.values()].filter(d => !d.$$deleted && d.mode === 'cover');
const baseName = r => (r ? r.slice(r.lastIndexOf('/') + 1) : '');

/** 全库所有"名字"（目录名 + 非图片条目名）；图片名是封面文件名，天然无番号，排除 */
const all = new Set();
for (const d of docs) {
    all.add(baseName(d.relPath));
    for (const e of d.data || []) if (e.type !== 'image') all.add(e.name);
}
const names = [...all].filter(Boolean).sort();

// ── 跑 A/B ───────────────────────────────────────────────────────────────
const gained = [], changed = [], still = [];
let same = 0;
for (const n of names) {
    const a = current(n).id, b = candidate(n).id;
    if (a === b) { same += 1; continue; }
    if (!a && b) gained.push([n, b]);
    else if (a && b) changed.push([n, a, b]);
    else still.push([n, a, b]); // 理论上不会发生（b 是超集）
}
console.log(`全库名字 ${names.length} 个（${docs.length} 条 cover 文档）`);
console.log(`  一致 ${same} · 新认出 ${gained.length} · 值变了 ${changed.length} · 反而认不出 ${still.length}\n`);

console.log(`── ⭐ 新认出（该不该认，逐条看）──`);
for (const [n, b] of gained) console.log(`  ${JSON.stringify(n)}  →  ${b}`);

console.log(`\n── ⚠️ 值变了（回归风险，必须逐条看）──`);
if (!changed.length) console.log('  （无）');
for (const [n, a, b] of changed) console.log(`  ${JSON.stringify(n)}  ${a}  →  ${b}`);

console.log(`\n── ❌ 反而认不出（不可能，出现即逻辑错）──`);
if (!still.length) console.log('  （无）');
for (const [n] of still) console.log(`  ${JSON.stringify(n)}`);

// ── 现有解析链的自检：把"认出"的全部打出来抽查 ──────────────────────────
console.log(`\n── 现有规则认出的名字（抽样 40，看有无误判）──`);
const recognized = names.filter(n => current(n).id).map(n => [n, current(n).id]);
console.log(`  共 ${recognized.length} 个`);
for (const [n, id] of recognized.slice(0, 40)) console.log(`  ${JSON.stringify(n)}  →  ${id}`);
