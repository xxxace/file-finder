// 一次性只读探针：量「面板加总览」的代价 —— 在内存里对 213 条 data 求和要多久。
// 结论用来判断"给 /getDisks 加 stats 字段"是否可接受。只读、不写盘、不碰移动硬盘。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import crypto from 'node:crypto';

const DB = path.join(os.homedir(), '.file-finder', 'searchCache.db');
const KEY = crypto.createHash('sha256').update('file-finder-cache-v1-2026-09-24').digest();
const IV = Buffer.alloc(16, 0);
function dec(l) {
    if (l.startsWith('{')) return l;
    const d = crypto.createDecipheriv('aes-256-cbc', KEY, IV);
    return Buffer.concat([d.update(Buffer.from(l, 'base64')), d.final()]).toString('utf8');
}

const t0 = Date.now();
const rl = readline.createInterface({ input: fs.createReadStream(DB, { encoding: 'utf8' }), crlfDelay: Infinity });
const docs = [];
for await (const raw of rl) {
    const l = raw.trim();
    if (!l) continue;
    try { const d = JSON.parse(dec(l)); if (d.serial !== undefined) docs.push(d); } catch { /* ignore */ }
}
const tParse = Date.now() - t0;

const t1 = Date.now();
let sink = 0;
for (let r = 0; r < 30; r++) {
    sink = 0;
    for (const d of docs) {
        if (!Array.isArray(d.data)) continue;
        for (const it of d.data) sink += it.size || 0;
    }
}
const tAgg = (Date.now() - t1) / 30;

console.log(`载入整库(读 85MB + 解密 + JSON.parse) ${docs.length} 条 : ${tParse} ms   ← 进程启动只做一次`);
console.log(`内存里遍历求和一次                                  : ${tAgg.toFixed(2)} ms   ← 每次打开面板要做的`);
console.log(`求和结果(校验用)                                    : ${(sink / 1024 ** 4).toFixed(3)} TB`);
console.log(`当前进程堆占用                                      : ${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(0)} MB`);
