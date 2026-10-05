/**
 * 商业级验收探针：还原链的「快照是否可靠」
 *
 * 判据（来自代码）：
 *   restoreFromFile:  copyFile(CACHE_DB_PATH → BEFORE_RESTORE_PATH)
 *   CACHE_DB_PATH 是磁盘上的文件，而 nedb 是【整库内存 + 追加写】
 *
 * 核心问题：磁盘文件 = "活记录"压缩后的样子吗？还是含大量历史追加行？
 *   若磁盘文件 ≠ 内存态（比如刚做过删除/更新，内存已删但文件还留着旧行）
 *   → copyFile 快照 = 一份"含已删记录的库"，回滚后那些记录会复活。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';

const CACHE_KEY = crypto.createHash('sha256').update('file-finder-cache-v1-2026-09-24').digest();
const CACHE_IV = Buffer.alloc(16, 0);
function dec(line) {
    if (line.startsWith('{')) return line;
    const d = crypto.createDecipheriv('aes-256-cbc', CACHE_KEY, CACHE_IV);
    return Buffer.concat([d.update(Buffer.from(line, 'base64')), d.final()]).toString('utf8');
}

const dbPath = process.env.USERPROFILE + '/.file-finder/searchCache.db';
const raw = fs.readFileSync(dbPath, 'utf8');
const lines = raw.split('\n').filter(l => l.trim());

// 模拟 nedb 的 loadDatabase：逐行读，后者覆盖前者的 _id
const byId = new Map();
let idxLines = 0;
for (const l of lines) {
    const j = JSON.parse(dec(l));
    if (j.$$indexCreated) { idxLines++; continue; }
    byId.set(j._id, j);   // 同 _id 后写覆盖前写
}
console.log('=== 磁盘文件形态 ===');
console.log('文件总行数（含索引行）:', lines.length);
console.log('索引行:', idxLines);
console.log('唯一 _id（= nedb 恢复出的记录数）:', byId.size);
console.log('');
console.log('判据：磁盘行数 - 索引行 =', lines.length - idxLines, '，唯一 _id =', byId.size);
if (lines.length - idxLines === byId.size) {
    console.log('✅ 磁盘文件是"压缩态"：无历史追加残留 ⇒ copyFile 快照 = 内存态，可靠');
} else {
    console.log('⚠️ 磁盘文件含', (lines.length - idxLines - byId.size), '行历史追加残留 ⇒ 快照会含已删记录');
}
