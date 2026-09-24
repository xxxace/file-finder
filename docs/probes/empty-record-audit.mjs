/**
 * 探针（**只读**）：验证「读盘失败 → 写入 count:0 假空记录」这条缺陷
 * 是否**已经在真实库上发生过**。
 *
 * 背景（docs/UX-DESIGN-INPUT-2026-09-24.md §2.3）：
 *   readFolder 把「读不到」和「真的空目录」都 `return []`
 *   → scanAndCache 无条件写 count:0 → 覆盖旧记录
 * 这是**推理**。本探针要找的是**现实证据**：
 *   活库里有没有 count === 0 的记录？它们对应的真实目录是不是真的空？
 *
 * nedb 数据文件 = 逐行 JSON。同 _id 后写的胜出，`$$deleted` 表示删除。
 * 纯只读，不起 nedb，不写任何东西。只读 C: 盘上的库文件 + disks.json。
 *
 * 跑法：node docs/probes/empty-record-audit.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = path.join(os.homedir(), '.file-finder');
const LIVE = path.join(DIR, 'searchCache.db');

const raw = fs.readFileSync(LIVE, 'utf8');
const lines = raw.split('\n').map((s) => s.trim()).filter(Boolean);

/** nedb 语义：同 _id 最后一条胜出；$$deleted 是墓碑 */
const map = new Map();
let bad = 0;
for (const line of lines) {
    let d;
    try {
        d = JSON.parse(line);
    } catch {
        bad++;
        continue;
    }
    if (d.$$indexCreated) continue;
    if (d.$$deleted) {
        map.delete(d._id);
        continue;
    }
    map.set(d._id, d);
}

const recs = [...map.values()];
console.log('=== 活库概览 ===');
console.log('文件字节:', fs.statSync(LIVE).size);
console.log('物理行数:', lines.length, '| 解析失败行:', bad);
console.log('去重后记录数:', recs.length);

const dataLenOf = (r) => (Array.isArray(r.data) ? r.data.length : r.data ? 1 : 0);

console.log('\n=== A. count / data 为空的记录（假空候选） ===');
const empties = recs.filter((r) => (r.count ?? 0) === 0 || dataLenOf(r) === 0);
if (!empties.length) console.log('(无)');
for (const r of empties) {
    console.log(
        JSON.stringify({
            _id: r._id,
            v: r.v,
            serial: r.serial,
            relPath: r.relPath,
            mode: r.mode,
            count: r.count,
            dataLen: dataLenOf(r),
            create_at: r.create_at,
        })
    );
}

console.log('\n=== B. count 与 data.length 不一致的记录 ===');
const mismatch = recs.filter((r) => r.count !== dataLenOf(r));
if (!mismatch.length) console.log('(无)');
for (const r of mismatch) {
    console.log(JSON.stringify({ relPath: r.relPath, mode: r.mode, count: r.count, dataLen: dataLenOf(r) }));
}

console.log('\n=== C. 全部记录（按 create_at） ===');
console.table(
    recs
        .sort((a, b) => String(a.create_at).localeCompare(String(b.create_at)))
        .map((r) => ({
            serial: r.serial,
            relPath: r.relPath,
            mode: r.mode,
            count: r.count,
            dataLen: dataLenOf(r),
            create_at: r.create_at,
        }))
);

console.log('\n=== D. disks.json（盘符 ↔ 序列号映射） ===');
try {
    console.log(fs.readFileSync(path.join(DIR, 'disks.json'), 'utf8'));
} catch (e) {
    console.log('读不到 disks.json:', String(e));
}

console.log('\n=== E. mode 分布 ===');
const byMode = {};
for (const r of recs) byMode[`${r.mode}`] = (byMode[`${r.mode}`] || 0) + 1;
console.log(byMode);
