/**
 * 探针（**只读**）：盘清 `~/.file-finder/` 里每个 nedb 数据文件的记录版本分布 + 内容重叠。
 *
 * 为什么必须知道这个：`dropLegacyRecords()` 的判据是 `{v:{$ne:CACHE_VERSION}}`，
 * 而 nedb 的 `$ne` **会匹配"字段不存在"**（已实测）。也就是说：
 *   **任何一条「没有 v 字段」的记录，都会在下次启动时被删掉。**
 * 所以要回答的不是"设计上会不会误删"，而是两个更硬的问题：
 *   1. **现在活库里有没有这种记录？** 有 → 下次启动就会少数据（P0 是止血）；没有 → P0 只是防未来。
 *   2. **备份里被删掉的记录，内容是不是已经不在活库里了？** 是 → 真的丢了；不是 → 没丢。
 *
 * nedb 的数据文件就是**逐行 JSON**（外加 `{"$$indexCreated":...}` 这种元数据行），
 * 直接按行 parse 即可，不需要起 nedb、不写任何东西、不碰任何外盘。
 *
 * 跑法：node docs/probes/cache-v-audit.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = path.join(os.homedir(), '.file-finder');

/**
 * 旧格式留下的 `fs.Stats` 字段（v1 的 FileInfo = fs.Stats & {...}）。
 *
 * ⚠️ `mode` 必须排掉：本项目自己也有一列叫 `mode`（`'cover'` / `'folder'`），
 * 只按**键名**数会把它算成"旧 fs.Stats 泄漏" —— 这是典型的影子判据。
 * 所以这里按**值的类型**判：`fs.Stats.mode` 是数字，本项目的是字符串。
 */
const STAT_FIELDS = [
    'dev', 'ino', 'nlink', 'uid', 'gid', 'rdev', 'blksize', 'blocks',
    'atimeMs', 'mtimeMs', 'ctimeMs', 'birthtimeMs', 'atime', 'mtime', 'ctime', 'birthtime',
];

function parseLines(file) {
    const raw = fs.readFileSync(file, 'utf8');
    const out = [];
    let bad = 0;
    for (const line of raw.split('\n')) {
        const s = line.trim();
        if (!s) continue;
        try {
            out.push(JSON.parse(s));
        } catch {
            bad++;
        }
    }
    return { out, bad };
}

const isRecord = (r) => !r.$$indexCreated && !r.$$deleted;

function summarize(file) {
    const full = path.join(DIR, file);
    const { out, bad } = parseLines(full);
    const records = out.filter(isRecord);
    const meta = out.length - records.length;

    const noV = records.filter((r) => !('v' in r));
    const vDist = {};
    for (const r of records.filter((r) => 'v' in r)) vDist[r.v] = (vDist[r.v] || 0) + 1;

    const statLeaks = { 'mode(数字型=真 fs.Stats)': records.filter((r) => typeof r.mode === 'number').length };
    for (const k of STAT_FIELDS) {
        const n = records.filter((r) => k in r).length;
        if (n) statLeaks[k] = n;
    }

    return {
        字节: fs.statSync(full).size,
        记录数: records.length,
        解析失败行: bad,
        元数据行: meta,
        '没有 v 字段的记录数': noV.length,
        v分布: vDist,
        顶层字段并集: [...new Set(records.flatMap((r) => Object.keys(r)))].sort(),
        '旧 fs.Stats 字段出现处数(按类型判)': statLeaks,
        records,
    };
}

const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.db')).sort();
const all = {};
for (const f of files) all[f] = summarize(f);

// ---- 逐条摊开（每条只留结构信息，不打印 base64）
const detail = {};
for (const [f, s] of Object.entries(all)) {
    detail[f] = s.records.map((r) => ({
        _id: r._id,
        v: 'v' in r ? r.v : '(缺)',
        mode: r.mode,
        serial: r.serial,
        relPath: r.relPath ?? (typeof r.dir === 'string' ? 'DIR=' + r.dir.slice(0, 48) : undefined),
        count: r.count,
        dataLen: Array.isArray(r.data) ? r.data.length : r.data ? 1 : 0,
        create_at: r.create_at,
    }));
}

const liveKey = files.find((f) => !/-\d{8}\.db$/.test(f));
const key = (r) => `${r.serial}|${r.relPath}|${r.mode}`;

console.log('=== 概览 ===');
for (const [f, s] of Object.entries(all)) {
    const { records, ...rest } = s;
    console.log(f, JSON.stringify(rest, null, 2));
}

console.log('\n=== 逐条 ===');
for (const [f, rows] of Object.entries(detail)) {
    console.log('\n' + f);
    console.table(rows);
}

if (liveKey) {
    const liveSet = new Set(all[liveKey].records.map(key));
    const liveNoV = all[liveKey].records.filter((r) => !('v' in r) || r.v !== 2);
    console.log('\n=== 判据 ===');
    console.log(`活库 ${liveKey}: ${all[liveKey].records.length} 条，下次启动会被 dropLegacyRecords 删掉的有 ${liveNoV.length} 条`);

    for (const f of files.filter((x) => x !== liveKey)) {
        const rows = all[f].records;
        const missed = rows.filter((r) => !liveSet.has(key(r)));
        const already = rows.length - missed.length;
        console.log(
            `备份 ${f}: ${rows.length} 条 —— 活库里**已有** ${already} 条，` +
            `**真的不在活库里** ${missed.length} 条`
        );
        if (missed.length) console.table(missed.map((r) => ({ mode: r.mode, serial: r.serial, relPath: r.relPath, count: r.count })));
    }
}
