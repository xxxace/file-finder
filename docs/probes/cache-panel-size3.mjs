// 只读探针 · 第三轮：**精确**判定父子双算（前一轮只给了必要不充分条件）。
//
// 判据：收敛条目（type!=='folder' 且 size>0）的名字**会变成封面图文件名**（如 cover.jpg → "cover"），
// 而未收敛的子目录保留目录名（type==='folder'，size=0）。
// 所以：若 R 的某个"非 folder 条目"的名字 ∈ R 的子记录名字集合 → 那条内容被算了两遍。
//
// 只读、不写盘、不碰移动硬盘。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import crypto from 'node:crypto';

const DB = process.env.FF_REAL_DB || path.join(os.homedir(), '.file-finder', 'searchCache.db');
const KEY = crypto.createHash('sha256').update('file-finder-cache-v1-2026-09-24').digest();
const IV = Buffer.alloc(16, 0);
function dec(l) {
    if (l.startsWith('{')) return l;
    const d = crypto.createDecipheriv('aes-256-cbc', KEY, IV);
    return Buffer.concat([d.update(Buffer.from(l, 'base64')), d.final()]).toString('utf8');
}
const rl = readline.createInterface({ input: fs.createReadStream(DB, { encoding: 'utf8' }), crlfDelay: Infinity });
const docs = [];
for await (const raw of rl) {
    const line = raw.trim();
    if (!line) continue;
    try { const d = JSON.parse(dec(line)); if (d.serial !== undefined) docs.push(d); } catch { /* ignore */ }
}
const gb = n => `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
const live = new Map();
for (const d of docs) live.set(`${d.serial}\u0000${d.relPath}\u0000${d.mode}`, d);
const recs = [...live.values()];
const byPath = new Map(recs.map(d => [`${d.serial}\u0000${d.relPath}`, d]));
const kidsOf = d => recs.filter(o => {
    if (o === d || o.serial !== d.serial) return false;
    const rp = o.relPath;
    if (!rp) return false;
    const cut = rp.lastIndexOf('/');
    return (cut === -1 ? '' : rp.slice(0, cut)) === d.relPath;
});

let dupTotal = 0;
const dupRows = [];
for (const d of recs) {
    const kids = kidsOf(d);
    if (!kids.length) continue;
    const kidNames = new Set(kids.map(k => k.relPath.split('/').pop()));
    const data = Array.isArray(d.data) ? d.data : [];
    let dup = 0;
    const hits = [];
    for (const it of data) {
        if (it.type === 'folder') continue;
        if (kidNames.has(it.name)) { dup += it.size || 0; hits.push(`${it.name}(${gb(it.size || 0)})`); }
    }
    if (dup > 0) { dupTotal += dup; dupRows.push({ d, dup, hits, kids: kids.length }); }
}

console.log('=== 精确双算检测 ===');
console.log(`会被双算的记录层 : ${dupRows.length}`);
console.log(`双算量            : ${gb(dupTotal)}`);
if (dupRows.length) {
    for (const r of dupRows) {
        console.log(`  ${gb(r.dup).padStart(10)}  父=${r.d.serial}/${r.d.relPath || '(盘根)'}  子记录 ${r.kids} 条  命中: ${r.hits.join(', ')}`);
    }
} else {
    console.log('  → **没有任何非 folder 条目的名字与子记录同名** ⇒ 不存在父子双算，盘级合计可信。');
}

// 反证：确认"有子记录的目录"在父记录里确实表现为 folder 条目（size 0）
console.log('\n=== 反证：子记录在父记录里的形态 ===');
let checked = 0, asFolder = 0, asOther = 0;
for (const d of recs) {
    if (!Array.isArray(d.data)) continue;
    for (const it of d.data) {
        const childPath = d.relPath ? `${d.relPath}/${it.name}` : it.name;
        const child = byPath.get(`${d.serial}\u0000${childPath}`);
        if (!child) continue;
        checked += 1;
        if (it.type === 'folder') asFolder += 1; else asOther += 1;
    }
}
console.log(`"父记录条目 + 同名子记录"配对 : ${checked} 对`);
console.log(`  父层表现为 folder 条目(size 0) : ${asFolder}`);
console.log(`  父层表现为非 folder 条目      : ${asOther}`);

// 盘级总量：给出"去重后"的上界与下界
const allBytes = recs.reduce((n, d) => n + (Array.isArray(d.data) ? d.data.reduce((m, it) => m + (it.size || 0), 0) : 0), 0);
console.log(`\n全库行级合计(含双算) : ${gb(allBytes)}`);
console.log(`扣掉实测双算         : ${gb(allBytes - dupTotal)}`);
