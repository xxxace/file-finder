/**
 * 只读审查探针：核实 HANDOVER-2026-10-03.md §1.1 的两个数字
 *   ① 「原始 data[] 是 78 MB」         —— 文档说不能下发
 *   ② 「投影 {name,dir,size,type,serial} 约 ~100 KB」 —— 文档说可下发
 * 不读移动硬盘；只解密缓存库文件（本地副本）。输出已脱敏（只打印统计量，不打印任何文件/目录名）。
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

const KEY = crypto.createHash('sha256').update('file-finder-cache-v1-2026-09-24').digest();
const IV = Buffer.alloc(16, 0);

const dbPath = path.join(os.homedir(), '.file-finder', 'searchCache.db');
const raw = fs.readFileSync(dbPath, 'utf8');
const lines = raw.split('\n').filter(l => l.trim().length);

let corrupt = 0;
const records = [];
for (const line of lines) {
    try {
        let plain = line;
        if (!line.startsWith('{')) {
            const d = crypto.createDecipheriv('aes-256-cbc', KEY, IV);
            plain = Buffer.concat([d.update(Buffer.from(line, 'base64')), d.final()]).toString('utf8');
        }
        records.push(JSON.parse(plain));
    } catch {
        corrupt += 1;
    }
}

const dead = records.filter(r => r.$$deleted || r._id === undefined && r.serial === undefined);
const live = records.filter(r => r.serial !== undefined);

let entryCount = 0;
let dataBytes = 0;         // 原始 data[] 全部字段序列化
let thumbBytes = 0;        // 其中 base64 缩略图两字段
let projBytes = 0;         // 投影
let nameBytes = 0;
const typeHist = {};
const proj = [];

function bl(s) { return Buffer.byteLength(s, 'utf8'); }

for (const r of live) {
    const data = Array.isArray(r.data) ? r.data : [];
    entryCount += data.length;
    dataBytes += bl(JSON.stringify(data));
    for (const e of data) {
        typeHist[e.type] = (typeHist[e.type] || 0) + 1;
        thumbBytes += bl(e.thumbData || '') + bl(e.avatarThumbData || '');
        const p = { name: e.name, dir: e.dir, size: e.size, type: e.type, serial: r.serial };
        proj.push(p);
        nameBytes += bl(String(e.name || ''));
    }
}
projBytes = bl(JSON.stringify(proj));

const out = [];
out.push(`# 审查探针输出（只读，已脱敏）  ${new Date().toISOString()}`);
out.push(`db 文件: searchCache.db (位于用户配置目录，非仓库)`);
out.push(`db 文件字节: ${fs.statSync(dbPath).size}`);
out.push(`明文行(记录)总数: ${records.length}   活记录: ${live.length}   解析失败行: ${corrupt}`);
out.push(`条目总数 Σdata.length: ${entryCount}`);
out.push(`原始 data[] 序列化总字节: ${dataBytes}  ( ${(dataBytes/1048576).toFixed(2)} MB )`);
out.push(`  其中 base64 缩略图两字段: ${thumbBytes}  ( ${(thumbBytes/1048576).toFixed(2)} MB )`);
out.push(`投影 {name,dir,size,type,serial} 序列化总字节: ${projBytes}  ( ${(projBytes/1024).toFixed(1)} KB )`);
out.push(`  name 字段合计: ${(nameBytes/1024).toFixed(1)} KB`);
out.push(`投影 / 原始 = ${(projBytes/dataBytes*100).toFixed(2)} %`);
out.push(`类型分布: ${JSON.stringify(typeHist)}`);
out.push(`平均每条目: 原始 ${(dataBytes/entryCount).toFixed(0)} B ; 投影 ${(projBytes/entryCount).toFixed(0)} B`);

const txt = out.join('\n') + '\n';
fs.writeFileSync(new URL('./out.txt', import.meta.url), txt, 'utf8');
console.log(txt);
