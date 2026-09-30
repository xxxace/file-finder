/* 只读探针：把"纯数字文件名"放回它们的目录上下文里，验证 FC2 假设
 *
 * 假设：那些形如 `1000011` 的条目 = 丢了 `FC2-PPV-` 前缀的 FC2 番号。
 * 若成立，它们应当与 `FC2-PPV-xxxxxxx`（前缀完整的）**同目录共存**，
 * 且数字位数落在 FC2 的 ID 量级（6~7 位）。
 *
 * 手法：复用 nedb.ts 里的加密契约（固定 key/IV，确定性 AES-256-CBC），
 * 只读地把 searchCache.db 解回明文 JSON。**不写任何文件、不碰移动盘。**
 *
 * 用法：node docs/probes/fc2-ctx.mjs [dbPath]
 */
import fs from 'node:fs';
import readline from 'node:readline';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

const DB =
    process.argv[2] ||
    path.join(os.homedir(), '.file-finder', 'searchCache.db');

// 与 electron/server/nedb.ts 逐字同源。改了那边这里必须同步（只读探针，容忍）
const KEY = crypto.createHash('sha256').update('file-finder-cache-v1-2026-09-24').digest();
const IV = Buffer.alloc(16, 0);

function decryptLine(line) {
    if (line.startsWith('{')) return line; // 明文旧行
    const d = crypto.createDecipheriv('aes-256-cbc', KEY, IV);
    return Buffer.concat([d.update(Buffer.from(line, 'base64')), d.final()]).toString('utf8');
}

const docs = [];
const rl = readline.createInterface({
    input: fs.createReadStream(DB, { encoding: 'utf8' }),
    crlfDelay: Infinity,
});
let bad = 0;
for await (const raw of rl) {
    const line = raw.trim();
    if (!line) continue;
    try {
        docs.push(JSON.parse(decryptLine(line)));
    } catch {
        bad++;
    }
}
console.log(`docs=${docs.length}  解不开=${bad}`);

// ---------- 1. 全局：所有条目的名字形态统计 ----------
const isNum = n => /^\d+$/.test(n);
const entries = [];
for (const d of docs) {
    for (const e of d.data || []) {
        entries.push({ serial: d.serial, relPath: d.relPath, mode: d.mode, ...e });
    }
}
const numeric = entries.filter(e => isNum(e.name));
console.log(`条目总数=${entries.length}  其中"纯数字名"=${numeric.length}`);

const byLen = {};
for (const e of numeric) byLen[e.name.length] = (byLen[e.name.length] || 0) + 1;
console.log('纯数字名的位数分布：', JSON.stringify(byLen));

// ---------- 2. 前缀完整的 FC2 长什么样 ----------
const fc2Full = entries.filter(e => /FC2[-_ ]?PPV/i.test(e.name));
console.log(`\n名字里带 FC2-PPV 前缀的条目=${fc2Full.length}（ID 位数分布见下）`);
const fc2Len = {};
for (const e of fc2Full) {
    const m = e.name.match(/(\d+)\s*$/);
    if (m) fc2Len[m[1].length] = (fc2Len[m[1].length] || 0) + 1;
}
console.log('  FC2-PPV 后随数字的位数分布：', JSON.stringify(fc2Len));
for (const e of fc2Full) {
    console.log(`  [${e.type}] ${e.relPath} / ${e.name}${e.ext ? '.' + e.ext : ''}`);
}

// ---------- 3. 关键：纯数字条目的**同目录共存**证据 ----------
// 对每个含纯数字的目录(doc)，看它同批条目里有没有 FC2 前缀 / FC2 风格标题
const docsWithNum = new Map();
for (const e of numeric) {
    const k = `${e.serial}|${e.relPath}|${e.mode}`;
    if (!docsWithNum.has(k)) docsWithNum.set(k, []);
    docsWithNum.get(k).push(e.name);
}
console.log(`\n含纯数字条目的目录数=${docsWithNum.size}`);

let coexist = 0;
const shown = [];
for (const [k, names] of docsWithNum) {
    const [serial, relPath, mode] = k.split('|');
    const doc = docs.find(
        d => d.serial === serial && d.relPath === relPath && d.mode === mode,
    );
    const all = (doc?.data || []).map(e => e.name);
    const hasFc2 = all.some(n => /FC2[-_ ]?PPV/i.test(n));
    if (hasFc2) coexist++;
    if (shown.length < 6) {
        shown.push({
            k,
            count: all.length,
            numericCount: names.length,
            hasFc2,
            sample: all.slice(0, 14),
        });
    }
}
console.log(`其中"同目录存在 FC2-PPV 前缀条目"的目录=${coexist}`);
console.log('\n—— 抽样（前 6 个含纯数字的目录，按原序前 14 项）——');
for (const s of shown) {
    console.log(`\n${s.k}\n  条目 ${s.count} 个（纯数字 ${s.numericCount}）  hasFC2=${s.hasFc2}`);
    s.sample.forEach((n, i) => console.log(`   ${String(i + 1).padStart(2)}. ${isNum(n) ? '[NUM] ' : '      '}${n}`));
}
