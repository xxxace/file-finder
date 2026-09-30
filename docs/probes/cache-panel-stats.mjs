// 一次性只读探针：算出「缓存记录」面板真实的总览数字（盘数/目录数/条目数/最近扫描/库大小）。
// 手法照抄 docs/probes/scan-real/stub-real-nedb.mjs：同一套 key/IV 解行，**全程只读、不写盘、不碰移动硬盘**。
// 用法：node docs/probes/cache-panel-stats.mjs
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

const lines = [];
const rl = readline.createInterface({ input: fs.createReadStream(DB, { encoding: 'utf8' }), crlfDelay: Infinity });
for await (const raw of rl) {
    const line = raw.trim();
    if (line) lines.push(line);
}

const docs = [];
let corrupt = 0;
let indexLines = 0;
for (const line of lines) {
    try {
        const d = JSON.parse(dec(line));
        // ⚠️ **必须跳过 nedb 的索引元数据行**（`{ $$indexCreated: … }`）：
        // 它不是一条记录，但会被 JSON.parse 出来、且 serial/mode 都是 undefined，
        // 于是被归进一个 `undefined` 桶 → 目录数多 1、盘数多 1（本轮踩过，214/6 vs 真实 213/5）。
        // 服务端的 `loadMeta()` 走 nedb 的 find()，返回的是**真文档**，不会有这一行 ——
        // 探针要和它对得上，就必须同样跳过。
        if (d && d.$$indexCreated !== undefined) { indexLines += 1; continue; }
        docs.push(d);
    } catch { corrupt += 1; }
}

// nedb 语义：同一主键后写的覆盖先写的（append-only，读时最后一条生效）
const live = new Map();
for (const d of docs) live.set(`${d.serial}\u0000${d.relPath}\u0000${d.mode}`, d);

const bySerial = new Map();
let entries = 0;
let lastScanAt = '';
let noCount = 0;
for (const d of live.values()) {
    const s = bySerial.get(d.serial) || { folders: 0, entries: 0, lastScanAt: '', maxPath: '' };
    s.folders += 1;
    s.entries += d.count || 0;
    entries += d.count || 0;
    if (!d.count && d.count !== 0) noCount += 1;
    if ((d.create_at || '') > s.lastScanAt) s.lastScanAt = d.create_at;
    if ((d.create_at || '') > lastScanAt) lastScanAt = d.create_at;
    bySerial.set(d.serial, s);
}

const dbBytes = fs.statSync(DB).size;
console.log(`库文件        : ${DB}`);
console.log(`库大小        : ${dbBytes} B (${(dbBytes / 1024 / 1024).toFixed(1)} MB)`);
console.log(`文件行数      : ${lines.length}`);
console.log(`其中索引元数据: ${indexLines}（跳过，不当记录）`);
console.log(`可解出行      : ${docs.length}   解不开(损坏): ${corrupt}`);
console.log(`活记录(去主键): ${live.size}`);
// ⚠️ 死行 = 文件行数 − 索引元数据行 − 活记录。不减掉索引行的话，
// 那 2 行"被覆盖"的假象会混进来（本轮踩过：报 2 死行，其实死行是 0）。
console.log(`死行(被覆盖)  : ${lines.length - indexLines - live.size}`);
console.log(`记录无 count  : ${noCount}`);
console.log(`盘数(有缓存)  : ${bySerial.size}`);
console.log(`目录数        : ${live.size}`);
console.log(`条目数        : ${entries}`);
console.log(`最近扫描      : ${lastScanAt}`);
console.log('v 版本分布    :', JSON.stringify([...live.values()].reduce((a, d) => (a[d.v] = (a[d.v] || 0) + 1, a), {})));
console.log('mode 分布     :', JSON.stringify([...live.values()].reduce((a, d) => (a[d.mode] = (a[d.mode] || 0) + 1, a), {})));
console.log('--- 按盘 ---');
for (const [serial, s] of [...bySerial].sort((a, b) => b[1].folders - a[1].folders)) {
    console.log(`  ${serial}  目录 ${String(s.folders).padStart(4)}  条目 ${String(s.entries).padStart(6)}  最近 ${s.lastScanAt}`);
}
