// 一次性只读探针：找出缓存库里"字段不完整"的记录（没有 v / mode / serial / count）。
// 只读、不写盘、不碰移动硬盘。用法：node docs/probes/cache-panel-ghost.mjs
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

const rl = readline.createInterface({
    input: fs.createReadStream(DB, { encoding: 'utf8' }),
    crlfDelay: Infinity,
});
let i = 0;
let bad = 0;
for await (const raw of rl) {
    i += 1;
    const line = raw.trim();
    if (!line) continue;
    let d;
    try { d = JSON.parse(dec(line)); } catch { console.log(`line ${i}: 解不开`); continue; }
    if (d.v === undefined || d.mode === undefined || d.serial === undefined || d.count === undefined) {
        bad += 1;
        const { data, ...meta } = d;
        console.log(`line ${i}  字段残缺:`, JSON.stringify(meta));
        console.log(`         data:`, Array.isArray(data) ? `数组(${data.length} 项)` : typeof data);
        console.log(`         字段全表:`, Object.keys(d).join(', '));
    }
}
console.log(`--- 共 ${i} 行，字段残缺 ${bad} 条 ---`);
