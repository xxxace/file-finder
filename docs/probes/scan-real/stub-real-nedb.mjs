// 探针用：把 scan.ts 的 `../nedb` 换成"**读真实 searchCache.db**"的桩。
// 只换数据源，scan.ts 一字节不改；**全程只读**（解密 + 内存），不写盘、不碰移动盘。
import fs from 'node:fs';
import readline from 'node:readline';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

const DB = process.env.FF_REAL_DB || path.join(os.homedir(), '.file-finder', 'searchCache.db');
// 与 electron/server/nedb.ts 同源（固定 key/IV，确定性加密）
const KEY = crypto.createHash('sha256').update('file-finder-cache-v1-2026-09-24').digest();
const IV = Buffer.alloc(16, 0);

function dec(line) {
    if (line.startsWith('{')) return line;
    const d = crypto.createDecipheriv('aes-256-cbc', KEY, IV);
    return Buffer.concat([d.update(Buffer.from(line, 'base64')), d.final()]).toString('utf8');
}

let cache = null;
async function load() {
    if (cache) return cache;
    const docs = [];
    const rl = readline.createInterface({
        input: fs.createReadStream(DB, { encoding: 'utf8' }),
        crlfDelay: Infinity,
    });
    for await (const raw of rl) {
        const line = raw.trim();
        if (!line) continue;
        try {
            docs.push(JSON.parse(dec(line)));
        } catch {
            /* corrupt 行忽略（真实 nedb 会比例判损坏，这里只需样本） */
        }
    }
    const metas = docs.map(({ data, ...m }) => m);
    const map = new Map(docs.map(d => [`${d.serial}|${d.relPath}|${d.mode}`, d]));
    cache = { docs, metas, map };
    return cache;
}

export async function loadMeta() {
    return (await load()).metas;
}

export async function findCache(serial, relPath, mode) {
    const c = await load();
    return Promise.resolve(c.map.get(`${serial}|${relPath}|${mode}`) ?? null);
}

/** 探针专用：拿原始文档，供上层打印上下文 */
export async function rawDocs() {
    return (await load()).docs;
}
