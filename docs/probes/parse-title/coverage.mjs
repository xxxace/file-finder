/**
 * 探针 · 番号识别**覆盖率**（真实缓存库 → 真实 unmatched 集合）
 * ===========================================================================
 * 用途：`match.ts` 的候选链是否有"漏"，只能拿真实库说话。
 * 本探针**只读系统盘的缓存文件**（`~/.file-finder/searchCache.db`），
 * **零读盘、零写盘、零网络**，不启动 Electron。
 *
 * 做法：
 *   ① 按 `nedb.ts` 的同一套算法解密每一行（AES-256-CBC / 固定 key+IV，见 nedb.ts:119-159）
 *   ② 按 `_id` 去重（nedb 追加写，后出现的胜）
 *   ③ 复刻 `scan.ts: evaluateDocs()` 的判据，算出**真实的 unmatched 集合**
 *   ④ 再对全库所有名字跑一遍 `parseTitle`，把"认不出"的按形态聚类
 *
 * 输出：**只打 stdout**（脱敏：不打印盘序列号 / 绝对路径 / 用户名）。
 * 一行复跑：node docs/probes/parse-title/coverage.mjs
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as esbuild from 'esbuild';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');

// ── 真实 parseTitle（bundle 真代码，不复制一份规则）────────────────────────
const outDir = path.join(os.tmpdir(), 'ff-parse-title-probe');
fs.mkdirSync(outDir, { recursive: true });
const outfile = path.join(outDir, 'match.mjs');
await esbuild.build({
    entryPoints: [path.join(repo, 'electron/server/assistant/match.ts')],
    bundle: true, format: 'esm', platform: 'node', outfile, logLevel: 'silent',
});
const { parseTitle } = await import(pathToFileURL(outfile).href);

// ── 解密缓存库（与 nedb.ts 逐字同算法）────────────────────────────────────
const KEY = crypto.createHash('sha256').update('file-finder-cache-v1-2026-09-24').digest();
const IV = Buffer.alloc(16, 0);
function dec(line) {
    if (line.startsWith('{')) return line;
    const d = crypto.createDecipheriv('aes-256-cbc', KEY, IV);
    return Buffer.concat([d.update(Buffer.from(line, 'base64')), d.final()]).toString('utf8');
}

const dbPath = path.join(os.homedir(), '.file-finder', 'searchCache.db');
const lines = fs.readFileSync(dbPath, 'utf8').split('\n');
const byId = new Map();
let bad = 0;
for (const line of lines) {
    if (!line.trim()) continue;
    try {
        const o = JSON.parse(dec(line));
        byId.set(o._id, o);
    } catch { bad += 1; }
}
const docs = [...byId.values()].filter(d => !d.$$deleted);
console.log(`库：${docs.length} 条记录（解密失败行 ${bad}）`);
console.log('样例字段：', Object.keys(docs[0] || {}).join(', '));

// ── 复刻 evaluateDocs（scan.ts:189-287）──────────────────────────────────
const joinRel = (p, n) => (p ? `${p}/${n}` : n);
const baseName = r => (r ? r.slice(r.lastIndexOf('/') + 1) : '');
const parentOf = r => (r.lastIndexOf('/') === -1 ? '' : r.slice(0, r.lastIndexOf('/')));

function evaluate(docsOfSerial) {
    const map = new Map();
    for (const d of docsOfSerial) map.set(d.relPath, d.data || []);

    const unmatched = [];
    let skippedCategory = 0;
    for (const [dir, entries] of map) {
        const faced = new Set(entries.filter(e => e.type === 'image').map(e => e.name));
        const selfName = baseName(dir);
        const selfIsMovieDir = !!parseTitle(selfName).id;
        const hasImage = entries.some(e => e.type === 'image');
        for (const e of entries) {
            if (e.type === 'video') {
                if (faced.has(e.name)) continue;
                if (selfIsMovieDir) continue;          // 容器已定，条目不再解析
                if (!parseTitle(e.name).id) unmatched.push({ dir, name: e.name, kind: 'video' });
                continue;
            }
            if (e.type !== 'folder' || e.sig) continue;
            const child = map.get(joinRel(dir, e.name));
            if (child && child.some(c => c.type === 'folder')) { skippedCategory += 1; continue; }
            if (!parseTitle(e.name).id) unmatched.push({ dir, name: e.name, kind: 'dir' });
        }
    }
    return { unmatched, skippedCategory };
}

// ── 按盘跑（serial 脱敏成 #1..#n）────────────────────────────────────────
const serials = [...new Set(docs.filter(d => d.mode === 'cover').map(d => d.serial))];
let allUnmatched = [];
console.log(`\n── 真实 unmatched（只看 mode='cover'，与界面同判）──`);
serials.forEach((s, i) => {
    const r = evaluate(docs.filter(d => d.serial === s && d.mode === 'cover'));
    allUnmatched = allUnmatched.concat(r.unmatched);
    console.log(`盘#${i + 1}: 认不出 ${String(r.unmatched.length).padStart(3)} 条 · 分类目录跳过 ${r.skippedCategory}`);
});
console.log(`合计 ${allUnmatched.length} 条\n`);
for (const u of allUnmatched) console.log(`  [${u.kind}] ${u.dir} / ${u.name}`);

// ── 全库名字（含目录名/视频名/图片名）里"认不出"的形态聚类 ─────────────────
// 判据：名字里**含数字**才可能是番号；纯中文/纯字母名字是作品名或演员名，天然无番号。
const names = new Set();
for (const d of docs) {
    if (d.mode !== 'cover') continue;
    names.add(baseName(d.relPath));
    for (const e of d.data || []) if (e.type !== 'image') names.add(e.name);
}
const numNames = [...names].filter(n => n && /\d/.test(n) && !parseTitle(n).id);
console.log(`\n── 含数字但认不出（${numNames.length} 个，全是潜在的"漏"）──`);
// 粗聚类：按"被什么挡住的"分组
const buckets = new Map();
function bucketOf(n) {
    const t = n.replace(/[[\]()【】]/g, ' ').replace(/\s+/g, ' ').trim();
    if (/\d+[A-Za-z]+\s*[-_ ]\s*\d+/.test(t)) return 'A 数字前缀+字母（如 200GANA / 3D2DBD）';
    if (/[A-Za-z]\d[A-Za-z0-9]*\s*[-_ ]\s*\d+/.test(t)) return 'B 字母段内含数字（如 X28-123 / TST2A3B-21）';
    if (/[A-Za-z]{2,}\s*[-_ ]\s*[A-Za-z]+\d+/.test(t)) return 'C 数字段带字母前缀（如 TSK-S51）';
    if (/^[A-Za-z]{2,}\d{2,}$/.test(t)) return 'D 纯连写（如 TST001）';
    if (!/[-_ ]/.test(t)) return 'E 无分隔符（其它）';
    return 'F 其它';
}
for (const n of numNames) {
    const b = bucketOf(n);
    if (!buckets.has(b)) buckets.set(b, []);
    buckets.get(b).push(n);
}
for (const [b, arr] of [...buckets.entries()].sort()) {
    console.log(`\n${b}  — ${arr.length} 个`);
    for (const n of arr.slice(0, 12)) console.log(`   · ${n}`);
    if (arr.length > 12) console.log(`   … 还有 ${arr.length - 12} 个`);
}
