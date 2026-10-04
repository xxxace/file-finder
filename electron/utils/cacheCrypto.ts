import crypto from 'node:crypto';

/**
 * 缓存层的两把"钥匙"和两种用法 —— **唯一真相源**。
 *
 * 原来 `CACHE_KEY` / `CACHE_IV` 长在 `server/nedb.ts` 里（私有）。2026-10-04 把图片
 * 搬出库、落成 `bin/` 下的独立文件之后，库和这些图片文件必须用**同一把密钥**，
 * 于是把它提到这里 —— 抄第二份就等于"改密码时漏改一处 = 一半数据打不开"。
 */

/**
 * ⚠️ **这个常量一旦改动，所有已存在的缓存库和 bin 图片都读不出来**（密文对不上 ⇒ 全部作废）。
 * 所以它**写死在这里，不是配置项**。别做成可配的，也别"顺手换个 key"。
 *
 * 强度（**诚实版**）：**固定密钥 = 混淆级别**。防的是"随手用记事本打开看一眼"，
 * **不防有心人** —— 解包之后挖源码能拿到这个字符串。需求就是这个，**匹配**；
 * 不要对外宣称这是安全存储，也不要把强度当成"改密钥"的理由。
 */
const CACHE_KEY = crypto.createHash('sha256').update('file-finder-cache-v1-2026-09-24').digest();

/**
 * 库专用固定 IV。
 *
 * **必须确定性加密** —— 同一个 `relPath` 每次出来的密文必须一模一样，
 * 否则 nedb 的 `serial` 索引和 `findCache({ serial, relPath, mode })` 全部失效：
 * 同一份数据每次加密结果不同 = 键在变，查不回来。
 * 固定 IV 会泄露"相同明文 → 相同密文"，在"防随手打开"这个目标下无所谓。
 *
 * ⚠️ **只给库用**。图片文件用 `encryptBlob`（每文件随机 IV）—— 那边没有确定性要求，
 * 就没必要继承固定 IV 的弱点。
 */
const CACHE_IV = Buffer.alloc(16, 0);

/**
 * 写盘前：一行明文 JSON → 一行 base64 密文。
 *
 * ⚠️ 输出**绝不能含 `\n`**（nedb 文档明说：含换行会导致数据丢失）。
 * 这也是选 base64 而不是裸二进制的原因 —— base64 字符集天然没有换行。
 */
export function encryptLine(line: string): string {
    const cipher = crypto.createCipheriv('aes-256-cbc', CACHE_KEY, CACHE_IV);
    return Buffer.concat([cipher.update(line, 'utf8'), cipher.final()]).toString('base64');
}

/**
 * 读盘后：一行密文 → 一行明文 JSON。
 *
 * **兼容明文行**（旧库"零迁移代码"的关键）：明文行以 `{` 开头，而 base64 字集里没有 `{`，
 * 所以判据不会误伤密文。只要这里放行明文，nedb 启动时那次整库重写就会把整库自动变成密文。
 *
 * 解不开的密文**要抛错、不要吞**：nedb 会把该行算作 corrupt，超过阈值（默认 10%）就拒绝启动
 * —— 那正是我们要的"响亮失败"。吞掉它反而会让"密钥不对"变成一份**悄悄少了很多行的库**。
 */
export function decryptLine(line: string): string {
    if (line.startsWith('{')) return line;
    const decipher = crypto.createDecipheriv('aes-256-cbc', CACHE_KEY, CACHE_IV);
    return Buffer.concat([decipher.update(Buffer.from(line, 'base64')), decipher.final()]).toString('utf8');
}

/**
 * 图片文件用：明文 → `[16 字节随机 IV][密文]`。
 *
 * 为什么每个文件一个随机 IV：这里**没有确定性要求**（文件名由内容指纹决定，不靠密文比对），
 * 那就该用标准做法 —— 固定 IV 会让"内容相同前缀"在密文里也相同，白送信息。
 */
export function encryptBlob(plain: Buffer): Buffer {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', CACHE_KEY, iv);
    return Buffer.concat([iv, cipher.update(plain), cipher.final()]);
}

/** 图片文件用：`[16 字节 IV][密文]` → 明文。长度不对或解不开 → 抛（调用方自己降级） */
export function decryptBlob(blob: Buffer): Buffer {
    if (blob.length <= 16) throw new Error('bin 文件太小，不像一份加密图片');
    const iv = blob.subarray(0, 16);
    const decipher = crypto.createDecipheriv('aes-256-cbc', CACHE_KEY, iv);
    return Buffer.concat([decipher.update(blob.subarray(16)), decipher.final()]);
}
