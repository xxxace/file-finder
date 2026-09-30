// 一次性只读探针：从真库里算出「大小」维度的可用性。
//   1) 行级：每条缓存记录（= 一个目录层）能算出多大的字节量？多少条记录算不出？
//   2) 盘级 / 全库：合计多少？有没有「父子两层各算一次」的双算风险？
// 全程只读、不写盘、不碰移动硬盘。用法：node docs/probes/cache-panel-size.mjs
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
    try {
        const d = JSON.parse(dec(line));
        if (d.serial !== undefined) docs.push(d);   // 跳过 nedb 的 $$indexCreated 行
    } catch { /* ignore */ }
}

const mb = n => `${(n / 1024 / 1024).toFixed(1)} MB`;
const gb = n => `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;

const key = d => `${d.serial}\u0000${d.relPath}\u0000${d.mode}`;
const live = new Map();
for (const d of docs) live.set(key(d), d);
const recs = [...live.values()];

// ---- 行级：一条记录能算出多少字节？ ----
let recBytes = 0, noData = 0, emptyData = 0, allZero = 0;
const rows = [];
for (const d of recs) {
    const data = d.data;
    if (!Array.isArray(data)) { noData += 1; rows.push({ d, bytes: 0, entries: 0, zero: 0, folders: 0 }); continue; }
    if (!data.length) emptyData += 1;
    let bytes = 0, zero = 0, folders = 0;
    for (const it of data) {
        const s = typeof it?.size === 'number' ? it.size : 0;
        if (it?.type === 'folder') folders += 1;
        if (!s) zero += 1; else bytes += s;
    }
    if (!bytes) allZero += 1;
    recBytes += bytes;
    rows.push({ d, bytes, entries: data.length, zero, folders });
}

// ---- 双算检测：某记录的父路径也在缓存里吗？ ----
const paths = new Set(recs.map(d => `${d.serial}\u0000${d.relPath}`));
let withCachedParent = 0, parentBytes = 0;
for (const r of rows) {
    const rp = r.d.relPath;
    if (!rp) continue;
    const cut = rp.lastIndexOf('/');
    const parent = cut === -1 ? '' : rp.slice(0, cut);
    if (paths.has(`${r.d.serial}\u0000${parent}`)) { withCachedParent += 1; parentBytes += r.bytes; }
}

// ---- 盘级 / 全库 ----
const bySerial = new Map();
for (const r of rows) {
    const s = bySerial.get(r.d.serial) || { recs: 0, entries: 0, bytes: 0, folders: 0, latest: '' };
    s.recs += 1; s.entries += r.entries; s.bytes += r.bytes; s.folders += r.folders;
    if ((r.d.create_at || '') > s.latest) s.latest = r.d.create_at;
    bySerial.set(r.d.serial, s);
}

console.log('=== 行级（每条记录 = 一个目录层） ===');
console.log(`记录数            : ${recs.length}`);
console.log(`没有 data 数组    : ${noData}`);
console.log(`data 为空数组     : ${emptyData}`);
console.log(`整条记录字节为 0  : ${allZero}`);
console.log(`行级合计          : ${gb(recBytes)}  <-- 含父子双算，不是权威总量`);
console.log(`能算出量的记录    : ${recs.length - allZero - noData} / ${recs.length}`);

const sorted = [...rows].sort((a, b) => b.bytes - a.bytes);
console.log('\n最大的 8 条：');
for (const r of sorted.slice(0, 8)) {
    console.log(`  ${String(r.bytes).padStart(13)}  ${gb(r.bytes).padStart(9)}  条目 ${String(r.entries).padStart(4)}  目录条目 ${String(r.folders).padStart(3)}  ${r.d.serial}/${r.d.relPath}`);
}
console.log('最小的 5 条：');
for (const r of sorted.slice(-5)) {
    console.log(`  ${String(r.bytes).padStart(13)}  ${gb(r.bytes).padStart(9)}  条目 ${String(r.entries).padStart(4)}  ${r.d.serial}/${r.d.relPath}`);
}

console.log('\n=== 双算风险检测 ===');
console.log(`父路径也在缓存里的记录 : ${withCachedParent} / ${recs.length}`);
console.log(`这些记录合计          : ${gb(parentBytes)}`);

console.log('\n=== 盘级合计（含双算，仅作量级参考） ===');
for (const [serial, s] of [...bySerial].sort((a, b) => b[1].bytes - a[1].bytes)) {
    console.log(`  ${serial}  目录 ${String(s.recs).padStart(4)}  条目 ${String(s.entries).padStart(5)}  文件夹条目 ${String(s.folders).padStart(4)}  ${gb(s.bytes).padStart(10)}  最近 ${s.latest}`);
}
