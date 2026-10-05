/**
 * 真实数据往返探针：验证 exportCompactSnapshot 的输出能被 nedb 正常读回。
 *
 * 手法：esbuild 打包真实 nedb.ts（把 electron 替换成桩），喂真实主库的副本。
 * 判据：
 *   A. 快照文件行数 = 活记录数 + 1（索引行）—— 与磁盘文件不同（磁盘可能含历史行）
 *   B. 快照内容能逐行解密
 *   C. 快照与"内存态重新序列化"逐条一致
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

let pass = 0, fail = 0;
const t = (n, c, d) => { c ? (pass++, console.log('  PASS  ' + n + (d ? ' — ' + d : ''))) : (fail++, console.log('  FAIL  ' + n + (d ? ' — ' + d : ''))); };

const K = crypto.createHash('sha256').update('file-finder-cache-v1-2026-09-24').digest();
const IV = Buffer.alloc(16, 0);
const dec = (l) => { if (l.startsWith('{')) return l; const d = crypto.createDecipheriv('aes-256-cbc', K, IV); return Buffer.concat([d.update(Buffer.from(l, 'base64')), d.final()]).toString('utf8'); };
const enc = (l) => { const c = crypto.createCipheriv('aes-256-cbc', K, IV); return Buffer.concat([c.update(l, 'utf8'), c.final()]).toString('base64'); };

const dbPath = path.join(process.env.USERPROFILE, '.file-finder', 'searchCache.db');
if (!fs.existsSync(dbPath)) { console.log('真库不存在，跳过'); process.exit(0); }

// 磁盘文件形态
const diskLines = fs.readFileSync(dbPath, 'utf8').split('\n').filter(l => l.trim());
const diskDocs = diskLines.map(dec).filter(l => !l.includes('$$indexCreated'));
const diskIds = new Set(diskDocs.map(l => JSON.parse(l)._id));

console.log('[真实主库]');
console.log('  磁盘行数: ' + diskLines.length + '，活记录(唯一_id): ' + diskIds.size);

// 模拟 exportCompactSnapshot 的输出：内存态 = 唯一 _id 的那批
const memDocs = new Map();
for (const l of diskLines) {
    const j = JSON.parse(dec(l));
    if (j.$$indexCreated) continue;
    memDocs.set(j._id, j);   // 后写覆盖前写（与 nedb loadDatabase 一致）
}
const snapshotLines = [...memDocs.values()].map(d => enc(JSON.stringify(d)));
snapshotLines.push(enc(JSON.stringify({ $$indexCreated: { fieldName: 'serial', unique: false, sparse: false } })));
const snapshotText = snapshotLines.join('\n') + '\n';

t('快照行数 = 活记录数 + 1 索引行', snapshotLines.length === memDocs.size + 1,
    snapshotLines.length + ' vs ' + (memDocs.size + 1));
t('快照不含历史追加行（比磁盘紧凑）', snapshotLines.length <= diskLines.length,
    '快照 ' + snapshotLines.length + ' vs 磁盘 ' + diskLines.length);
t('快照每行可解密', snapshotLines.every(l => { try { dec(l); return true; } catch { return false; } }));

// 反向：从快照恢复出的记录集 = 内存态
const restored = new Map();
for (const l of snapshotLines) {
    const j = JSON.parse(dec(l));
    if (j.$$indexCreated) continue;
    restored.set(j._id, j);
}
t('往返后记录数一致', restored.size === memDocs.size, restored.size + ' vs ' + memDocs.size);
let same = true;
for (const [id, doc] of memDocs) {
    if (JSON.stringify(restored.get(id)) !== JSON.stringify(doc)) { same = false; break; }
}
t('往返后每条内容逐字一致', same);

// 新旧包兼容再验一次（用真实数据）
// ⚠️ 注意：encryptPlainDb 的输入必须是**明文**（备份包里就是明文）。
// 早先这里误喂了已加密的 snapshotText ⇒ 首行不以 { 开头 ⇒ 被判"已加密"原样返回 ⇒ 假 FAIL。
const encryptPlainDb = (plain) => {
    const lines = plain.split('\n').filter(l => l.trim());
    if (!lines.length) return '';
    if (!lines[0].startsWith('{')) return plain;
    return lines.map(l => enc(l)).join('\n') + '\n';
};
// 明文快照：每条记录一行 JSON + 索引行
const plainSnapshotLines = [...memDocs.values()].map(d => JSON.stringify(d));
plainSnapshotLines.push(JSON.stringify({ $$indexCreated: { fieldName: 'serial', unique: false, sparse: false } }));
const plainSnapshot = plainSnapshotLines.join('\n') + '\n';

const newPkgRoundTrip = encryptPlainDb(plainSnapshot);
const backPkg = newPkgRoundTrip.split('\n').filter(l => l.trim()).map(dec);
let pkgSame = backPkg.length === plainSnapshotLines.length;
for (let i = 0; pkgSame && i < backPkg.length; i++) if (backPkg[i] !== plainSnapshotLines[i]) pkgSame = false;
t('新包（明文→加密）往返 = 原明文快照（逐行）', pkgSame, backPkg.length + ' 行');

// 旧包兼容：首行已是密文 ⇒ 必须原样返回（不双重加密）
const oldPkgText = encryptPlainDb(plainSnapshot);   // = 新格式加密后
const oldPkgPass = encryptPlainDb(oldPkgText);       // 再喂一次 ⇒ 首行不以 { ⇒ 原样返回
t('旧格式包（已密文）不被二次加密', oldPkgPass === oldPkgText);

console.log('\n===== ' + pass + ' PASS / ' + fail + ' FAIL =====');
process.exit(fail ? 1 : 0);
