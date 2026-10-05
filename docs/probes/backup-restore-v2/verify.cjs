/**
 * 备份/还原 v2 验收探针（2026-10-05）
 *
 * 验证四件事（每件都必须 PASS，否则新方案不能上线）：
 *   A. zip 的 deflate/store 混合读写正确（含 CRC 校验）
 *   B. 明文 → encryptLine → 写文件 → decryptLine 往返逐字一致
 *   C. 旧包（密文原样）兼容：encryptPlainDb 不能双重加密
 *   D. 真实体积收益（库明文 deflate 后 vs 原密文 store）
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { crc32, deflateRawSync, inflateRawSync } = require('zlib');

// ---- 项目真实逻辑（复刻自源文件）----
const K = crypto.createHash('sha256').update('file-finder-cache-v1-2026-09-24').digest();
const IV = Buffer.alloc(16, 0);
const encryptLine = (line) => {
    const c = crypto.createCipheriv('aes-256-cbc', K, IV);
    return Buffer.concat([c.update(line, 'utf8'), c.final()]).toString('base64');
};
const decryptLine = (line) => {
    if (line.startsWith('{')) return line;
    const d = crypto.createDecipheriv('aes-256-cbc', K, IV);
    return Buffer.concat([d.update(Buffer.from(line, 'base64')), d.final()]).toString('utf8');
};

let pass = 0, fail = 0;
const t = (name, cond, detail) => {
    if (cond) { pass++; console.log('  PASS  ' + name + (detail ? ' — ' + detail : '')); }
    else { fail++; console.log('  FAIL  ' + name + (detail ? ' — ' + detail : '')); }
};

// ============ A. zip 混合读写 ============
console.log('\n[A] zip deflate/store 混合读写');
const LOCAL_SIG = 0x04034b50, CENTRAL_SIG = 0x02014b50, EOCD_SIG = 0x06054b50;
function buildZip(entries) {
    const parts = [];
    const central = [];
    let offset = 0;
    for (const e of entries) {
        const raw = e.raw;
        const method = e.compress === 'deflate' ? 8 : 0;
        const data = method === 8 ? deflateRawSync(raw) : raw;
        const crc = crc32(raw) >>> 0;
        const nameBuf = Buffer.from(e.name, 'utf8');
        const local = Buffer.alloc(30);
        local.writeUInt32LE(LOCAL_SIG, 0);
        local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6); local.writeUInt16LE(method, 8);
        local.writeUInt16LE(0, 10); local.writeUInt16LE(0x2821, 12);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(data.length, 18); local.writeUInt32LE(raw.length, 22);
        local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);
        parts.push(Buffer.concat([local, nameBuf]), data);
        const cd = Buffer.alloc(46);
        cd.writeUInt32LE(CENTRAL_SIG, 0);
        cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6);
        cd.writeUInt16LE(0, 8); cd.writeUInt16LE(method, 10);
        cd.writeUInt16LE(0, 12); cd.writeUInt16LE(0x2821, 14);
        cd.writeUInt32LE(crc, 16);
        cd.writeUInt32LE(data.length, 20); cd.writeUInt32LE(raw.length, 24);
        cd.writeUInt16LE(nameBuf.length, 28);
        cd.writeUInt16LE(0, 30); cd.writeUInt16LE(0, 32); cd.writeUInt16LE(0, 34);
        cd.writeUInt16LE(0, 36); cd.writeUInt32LE(0, 38);
        cd.writeUInt32LE(offset, 42);
        central.push(Buffer.concat([cd, nameBuf]));
        offset += 30 + nameBuf.length + data.length;
    }
    const cdBuf = Buffer.concat(central);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(EOCD_SIG, 0);
    eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(cdBuf.length, 12); eocd.writeUInt32LE(offset, 16);
    eocd.writeUInt16LE(0, 20);
    return Buffer.concat([...parts, cdBuf, eocd]);
}
function parseZip(buf) {
    let eocd = -1;
    for (let i = buf.length - 22; i >= 0; i--) if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
    const count = buf.readUInt16LE(eocd + 10);
    const cdOffset = buf.readUInt32LE(eocd + 16);
    const out = [];
    let p = cdOffset;
    for (let i = 0; i < count; i++) {
        const method = buf.readUInt16LE(p + 10);
        const crc = buf.readUInt32LE(p + 16);
        const comp = buf.readUInt32LE(p + 20);
        const nameLen = buf.readUInt16LE(p + 28);
        const extraLen = buf.readUInt16LE(p + 30);
        const commentLen = buf.readUInt16LE(p + 32);
        const offset = buf.readUInt32LE(p + 42);
        const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
        const hNameLen = buf.readUInt16LE(offset + 26);
        const hExtraLen = buf.readUInt16LE(offset + 28);
        const dOff = offset + 30 + hNameLen + hExtraLen;
        const compData = buf.subarray(dOff, dOff + comp);
        const rawData = method === 8 ? inflateRawSync(compData) : compData;
        out.push({ name, method, crc, rawData });
        p += 46 + nameLen + extraLen + commentLen;
    }
    return out;
}

const plainJson = Buffer.from('{"_id":"abc","serial":"FE8CDC72","relPath":"x"}', 'utf8');
const imgData = crypto.randomBytes(4096);
const zipBuf = buildZip([
    { name: 'manifest.json', raw: Buffer.from('{"format":1}', 'utf8'), compress: 'deflate' },
    { name: 'searchCache.db', raw: plainJson, compress: 'deflate' },
    { name: 'bin/t-aaa.enc', raw: imgData },
]);
const parsed = parseZip(zipBuf);
t('3 个条目全部解出', parsed.length === 3, '实际 ' + parsed.length);
const dbE = parsed.find(e => e.name === 'searchCache.db');
t('库条目用 deflate', dbE.method === 8);
t('库条目 inflate 后逐字一致', dbE.rawData.equals(plainJson));
t('库条目 CRC 与原始内容一致', (crc32(dbE.rawData) >>> 0) === dbE.crc);
const imgE = parsed.find(e => e.name === 'bin/t-aaa.enc');
t('图片条目用 store', imgE.method === 0);
t('图片字节逐字一致', imgE.rawData.equals(imgData));
const mfE = parsed.find(e => e.name === 'manifest.json');
t('manifest 用 deflate', mfE.method === 8);

// ============ B. 往返 ============
console.log('\n[B] 明文 → encryptLine → 磁盘 → decryptLine 往返');
const sampleJson = JSON.stringify({ _id: 'x1', v: 3, serial: 'FE8CDC72', relPath: 'a/b', data: [{ name: 'test.mp4', size: 123 }] });
const enc = encryptLine(sampleJson);
t('密文不含换行', !enc.includes('\n'));
t('往返逐字一致', decryptLine(enc) === sampleJson);

// ============ C. 旧包兼容 ============
console.log('\n[C] 新旧包兼容判定（encryptPlainDb 逻辑）');
const encryptPlainDb = (plain) => {
    const lines = plain.split('\n').filter(l => l.trim());
    if (!lines.length) return '';
    const alreadyEncrypted = !lines[0].startsWith('{');
    if (alreadyEncrypted) return plain;
    return lines.map(l => encryptLine(l)).join('\n') + '\n';
};
const newPkg = '{"$$indexCreated":{"fieldName":"serial"}}\n' + sampleJson + '\n';
const encNew = encryptPlainDb(newPkg);
t('新格式包：被加密（首行不再以 { 开头）', !encNew.split('\n')[0].startsWith('{'));
t('新格式包：解密后逐行还原', decryptLine(encNew.split('\n')[0]) === '{"$$indexCreated":{"fieldName":"serial"}}');
const oldPkg = encryptLine('{"$$indexCreated":{"fieldName":"serial"}}') + '\n' + enc + '\n';
const encOld = encryptPlainDb(oldPkg);
t('旧格式包：原样返回（不双重加密）', encOld === oldPkg);
t('旧格式包：仍能解密出原文', decryptLine(encOld.split('\n')[0]) === '{"$$indexCreated":{"fieldName":"serial"}}');

// ============ D. 体积 ============
console.log('\n[D] 真实库的体积收益');
const realDb = path.join(process.env.USERPROFILE, '.file-finder', 'searchCache.db');
if (fs.existsSync(realDb)) {
    const raw = fs.readFileSync(realDb);
    const lines = raw.toString('utf8').split('\n').filter(l => l.trim());
    const plainStr = lines.map(decryptLine).join('\n') + '\n';
    const deflated = deflateRawSync(Buffer.from(plainStr, 'utf8'));
    console.log('  现状（密文 store）: ' + (raw.length / 1024).toFixed(1) + ' KB');
    console.log('  新方案（明文 deflate）: ' + (deflated.length / 1024).toFixed(1) + ' KB');
    console.log('  明文原大小: ' + (plainStr.length / 1024).toFixed(1) + ' KB');
    t('新方案体积 <= 现状 60%', deflated.length <= raw.length * 0.6,
        '省 ' + (100 - deflated.length / raw.length * 100).toFixed(1) + '%');
} else {
    console.log('  (跳过：真库不存在)');
}

console.log('\n===== ' + pass + ' PASS / ' + fail + ' FAIL =====');
process.exit(fail ? 1 : 0);
