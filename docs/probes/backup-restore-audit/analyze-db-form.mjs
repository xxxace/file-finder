/**
 * 商业级验收 · 决定性探针
 * 问题：还原时的快照 copyFile(CACHE_DB_PATH → BEFORE_RESTORE_PATH)
 *       拿到的磁盘文件，是否等于「内存态」？
 *
 * nedb 事实（persistence.js 已核实）：
 *   - persistNewStateAsync → appendFileAsync（只追加，删除也追加一条 $$deleted）
 *   - 压缩 persistCachedDatabaseAsync 只在 loadDatabase / compactDatafile 时发生
 *
 * 结论推演：只要本次进程启动后发生过「删/改」，磁盘文件就含历史行。
 *   → copyFile 快照 = 含"已删记录"的库
 *   → 回滚后那些已被用户删掉的记录会复活
 *
 * 本机实测：主库 223 行 / 222 唯一 _id → 恰好相等
 *   ⇒ 本机是"刚 load 过、之后没删过东西"的干净情形。
 *   ⚠️ 这恰恰说明：相等是【巧合】，不是【保证】。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
const K = crypto.createHash('sha256').update('file-finder-cache-v1-2026-09-24').digest();
const IV = Buffer.alloc(16, 0);
const dec = l => { if (l.startsWith('{')) return l;
  const d = crypto.createDecipheriv('aes-256-cbc', K, IV);
  return Buffer.concat([d.update(Buffer.from(l,'base64')), d.final()]).toString('utf8'); };

function analyze(p) {
  const lines = fs.readFileSync(p, 'utf8').split('\n').filter(l => l.trim());
  const ids = new Set(); let idx = 0;
  for (const l of lines) { const j = JSON.parse(dec(l));
    if (j.$$indexCreated) idx++; else ids.add(j._id); }
  const dataLines = lines.length - idx;
  return { total: lines.length, idx, dataLines, unique: ids.size, bloat: dataLines - ids.size };
}

const base = process.env.USERPROFILE + '/.file-finder/';
console.log('文件'.padEnd(28), '总行', '索引', '数据行', '唯一id', '膨胀行');
for (const f of ['searchCache.db', 'searchCache-before-restore.db', 'searchCache-20261005.db']) {
  const r = analyze(base + f);
  console.log(f.padEnd(28), String(r.total).padEnd(5), String(r.idx).padEnd(5),
    String(r.dataLines).padEnd(7), String(r.unique).padEnd(7), r.bloat);
}
console.log('\n膨胀行 = 磁盘上已被逻辑删除、但物理仍存在的历史追加行。');
console.log('膨胀 > 0 ⇒ copyFile 快照会把"已删记录"带进回滚。');
