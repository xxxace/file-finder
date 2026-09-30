// 只读探针 · 第二轮：把三个"必须证伪"的点量出来
//   A) 父子双算到底有多大？（只对"自己字节>0 且父路径也缓存过"的记录才可能发生）
//   B) 库里 count=0 的记录是"真空目录"还是历史缺陷留下的伤疤？
//   C) 3 条"整条字节为 0"的记录是什么形态？
// 全程只读、不写盘、不碰移动硬盘。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import crypto from 'node:crypto';

const DB = process.env.FF_REAL_DB || path.join(os.homedir(), '.file-finder', 'searchCache.db');
const KEY = crypto.createHash('sha256').update('file-finder-cache-v1-2026-09-24').digest();
const IV = Buffer.alloc(16, 0);
function dec(line) {
    if (line.startsWith('{')) return line;
    const d = crypto.createDecipheriv('aes-256-cbc', KEY, IV);
    return Buffer.concat([d.update(Buffer.from(line, 'base64')), d.final()]).toString('utf8');
}

const rl = readline.createInterface({ input: fs.createReadStream(DB, { encoding: 'utf8' }), crlfDelay: Infinity });
const docs = [];
for await (const raw of rl) {
    const line = raw.trim();
    if (!line) continue;
    try { const d = JSON.parse(dec(line)); if (d.serial !== undefined) docs.push(d); } catch { /* ignore */ }
}
const gb = n => `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
const k = d => `${d.serial}\u0000${d.relPath}\u0000${d.mode}`;
const live = new Map();
for (const d of docs) live.set(k(d), d);
const recs = [...live.values()];
const byPath = new Map(recs.map(d => [`${d.serial}\u0000${d.relPath}`, d]));

function bytesOf(d) {
    if (!Array.isArray(d.data)) return 0;
    return d.data.reduce((n, it) => n + (typeof it?.size === 'number' ? it.size : 0), 0);
}
function parentOf(d) {
    const rp = d.relPath;
    if (!rp) return null;
    const cut = rp.lastIndexOf('/');
    return byPath.get(`${d.serial}\u0000${cut === -1 ? '' : rp.slice(0, cut)}`) || null;
}

console.log('=== A) 父子双算：真正可能发生的集合 ===');
const risky = [];
for (const d of recs) {
    const b = bytesOf(d);
    if (b > 0 && parentOf(d)) risky.push({ d, b });
}
const riskSum = risky.reduce((n, r) => n + r.b, 0);
console.log(`"自己字节>0 且父记录也缓存过"的记录 : ${risky.length} / ${recs.length}`);
console.log(`这些记录合计                        : ${gb(riskSum)}`);
console.log(`其中父记录的字节量 >0 的（真会双算）: ${risky.filter(r => bytesOf(parentOf(r.d)) > 0).length} 条`);
const parentHasBytes = risky.filter(r => bytesOf(parentOf(r.d)) > 0);
if (parentHasBytes.length) {
    console.log('  这些是真正会被算两次的：');
    for (const r of parentHasBytes.slice(0, 12)) {
        console.log(`    ${gb(r.b).padStart(10)}  ${r.d.serial}/${r.d.relPath}   ←父 ${parentOf(r.d).relPath || '(盘根)'} 自身字节 ${gb(bytesOf(parentOf(r.d)))}`);
    }
} else {
    console.log('  → 结论：所有"有父记录"的父记录自身字节都是 0（它只列目录条目，size=0）');
    console.log('    ⇒ **实际不存在父子双算**，盘级合计是可信的。');
}

console.log('\n=== B) count=0 的记录：是真空目录，还是历史伤疤？ ===');
const zeros = recs.filter(d => (d.count || 0) === 0);
console.log(`count=0 的记录共 ${zeros.length} 条：`);
for (const d of zeros) {
    const p = parentOf(d);
    const seg = d.relPath.split('/').pop();
    // 父记录的条目里，有没有一个同名条目？它是什么类型？
    let inParent = '父记录未缓存';
    if (p && Array.isArray(p.data)) {
        const hit = p.data.find(it => it.name === seg);
        inParent = hit ? `父层有「${hit.name}」type=${hit.type} size=${hit.size}` : '父层条目里查无此名';
    }
    console.log(`  ${d.serial}/${d.relPath}`);
    console.log(`     create_at=${d.create_at}  count=${d.count}  data=${Array.isArray(d.data) ? d.data.length : 'n/a'}  ${inParent}`);
}

console.log('\n=== C) 整条字节为 0 的记录（会被"0 B"误导的形态） ===');
for (const d of recs) {
    if (bytesOf(d) !== 0) continue;
    const data = Array.isArray(d.data) ? d.data : [];
    const byType = data.reduce((a, it) => (a[it.type] = (a[it.type] || 0) + 1, a), {});
    console.log(`  ${d.serial}/${d.relPath || '(盘根)'}  count=${d.count}  ${gb(0)}  条目类型分布=${JSON.stringify(byType)}`);
}

console.log('\n=== D) 父记录自身字节>0 的记录（可能就是"收敛了子目录"的那类） ===');
const withBytesAndChild = recs.filter(d => bytesOf(d) > 0 && recs.some(o => o !== d && o.serial === d.serial && parentOf(o) === d));
console.log(`共 ${withBytesAndChild.length} 条：`);
for (const d of withBytesAndChild.slice(0, 10)) {
    const kids = recs.filter(o => o.serial === d.serial && parentOf(o) === d);
    console.log(`  ${gb(bytesOf(d)).padStart(10)}  ${d.serial}/${d.relPath || '(盘根)'}  子记录 ${kids.length} 条: ${kids.map(x => x.relPath.split('/').pop()).join(', ')}`);
}
