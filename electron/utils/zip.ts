import fs from 'node:fs';
import * as fsasync from 'node:fs/promises';
import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';

/**
 * 极简 **store-only** ZIP —— 只做"把若干个文件装进一个文件"和"从中取出"。
 *
 * 为什么自己写而不是引依赖：仓库里没有任何 zip/tar 依赖（实测 `package.json`），
 * 而这个格式简单到不值得为它引一个包。
 *
 * 为什么**不压缩**：装进来的东西已经压不动了 —— 库是逐行 AES 密文、
 * `bin/` 里的图片是加密后的 JPEG 字节（实测 `gzip(JPEG)` ≈ 原大小，见
 * `docs/probes/thumb-tier/`）。store-only 因此不损失任何体积，还省掉一整条 inflate 路径。
 *
 * 为什么格式值得自己实现（而不是"随便存个 blob"）：ZIP 是 **Windows 资源管理器双击就能打开**
 * 的格式 —— 主人要的"导出只有一个文件、用户没有心理负担"就落在这一点上
 * （备份文件随时可以自己看一眼里面有什么，而不是一个只有本程序认识的魔数文件）。
 *
 * 压缩策略（2026-10-05 改）：**逐条目可选 deflate，默认仍 store**。
 *   - `bin/*.enc`（加密后的 JPEG，熵≈8bit/byte）压不动 —— 实测 50 个样本 gzip 后
 *     反而大 0.05% ⇒ 一律 store，省掉一整条 inflate 路径。
 *   - 库文件 `searchCache.db` 若**已是密文**同样压不动（base64 是伪随机串，实测只压 26%）。
 *     但**解密后**的明文 JSON 重复度极高（字段名、路径前缀），实测 **442 KB → 81 KB（压掉 74%）**
 *     ⇒ 所以入包的库**先在内存里解成明文、再用 deflateRaw 压**（见 server/index.ts 的打包/解包）。
 *   - 判据：`method` 逐条目决定，解包侧按 method 分派 ⇒ 两种条目能混在同一个包里。
 *
 * 局限（知情）：不写 ZIP64 ⇒ 单个文件与总大小都必须小于 4 GB；条目数小于 65535。
 * 我们的量级（库几 MB + 图片几百 MB）离得很远。超了会**明确抛错**，不会静默写坏。
 */

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;

/** ZIP 压缩方式。0=store（原样），8=deflate（此处用 raw deflate，不带 zlib 头） */
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

/** MS-DOS 时间戳（ZIP 用的那种）。没有它有些解压器会显示 1980 年，不算错误但不体面 */
function dosDateTime(d: Date): { time: number; date: number } {
    const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (Math.floor(d.getSeconds() / 2));
    const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    return { time, date };
}

export interface ZipSource {
    /** 在包里的路径（统一用 `/`） */
    name: string;
    /** 本地磁盘上的文件 */
    file: string;
    /**
     * 压缩方式。缺省 `store`（原样）；`deflate` 时内容会被 raw-deflate 压一遍。
     *
     * ⚠️ 由**调用方**决定而不是这里自动嗅探：调用方知道这份内容是什么
     * （密文 / 明文 JSON / 已压缩的图片），比按前几个字节猜准得多。
     */
    compress?: 'store' | 'deflate';
}

/**
 * 把若干文件写成一个 zip。
 *
 * 用**流写**而不是先在内存里拼 buffer：`bin/` 加起来可能几百 MB，
 * 拼进内存是一次完全没必要的峰值。
 * （deflate 条目会在内存里压一次 —— 那是库文件，几百 KB 级，可接受。）
 */
export async function writeZip(target: string, entries: ZipSource[]): Promise<number> {
    const out = fs.createWriteStream(target);
    const write = (buf: Buffer) => new Promise<void>((resolve, reject) => {
        out.write(buf, (err) => (err ? reject(err) : resolve()));
    });

    const { time, date } = dosDateTime(new Date());
    const central: Buffer[] = [];
    let offset = 0;
    let total = 0;

    try {
        for (const e of entries) {
            const raw = await fsasync.readFile(e.file);
            const nameBuf = Buffer.from(e.name.replace(/\\/g, '/'), 'utf8');

            // store 时 data === raw；deflate 时 data 是压过的字节
            const method = e.compress === 'deflate' ? METHOD_DEFLATE : METHOD_STORE;
            const data = method === METHOD_DEFLATE ? deflateRawSync(raw) : raw;
            // ⚠️ CRC 取的是**原始未压缩内容**（ZIP 规范）—— 取错会让所有解压器报 CRC 不符
            const crc = crc32(raw) >>> 0;
            if (data.length >= 0xffffffff || offset >= 0xffffffff) {
                throw new Error('内容超过 4 GB，这个 zip 不支持（需要 ZIP64）');
            }

            const local = Buffer.alloc(30);
            local.writeUInt32LE(LOCAL_SIG, 0);
            local.writeUInt16LE(20, 4);            // 需要的版本
            local.writeUInt16LE(0, 6);             // 标志位：无
            local.writeUInt16LE(method, 8);        // 方式：0=store / 8=deflate
            local.writeUInt16LE(time, 10);
            local.writeUInt16LE(date, 12);
            local.writeUInt32LE(crc, 14);
            local.writeUInt32LE(data.length, 18);   // 压缩后大小
            local.writeUInt32LE(raw.length, 22);    // 原始大小
            local.writeUInt16LE(nameBuf.length, 26);
            local.writeUInt16LE(0, 28);            // 额外字段长度

            await write(Buffer.concat([local, nameBuf]));
            await write(data);
            offset += 30 + nameBuf.length + data.length;
            total += data.length;

            const cd = Buffer.alloc(46);
            cd.writeUInt32LE(CENTRAL_SIG, 0);
            cd.writeUInt16LE(20, 4);               // 生成方版本
            cd.writeUInt16LE(20, 6);               // 需要的版本
            cd.writeUInt16LE(0, 8);
            cd.writeUInt16LE(method, 10);
            cd.writeUInt16LE(time, 12);
            cd.writeUInt16LE(date, 14);
            cd.writeUInt32LE(crc, 16);
            cd.writeUInt32LE(data.length, 20);      // 压缩后大小
            cd.writeUInt32LE(raw.length, 24);       // 原始大小
            cd.writeUInt16LE(nameBuf.length, 28);
            cd.writeUInt16LE(0, 30);               // 额外
            cd.writeUInt16LE(0, 32);               // 注释
            cd.writeUInt16LE(0, 34);               // 起始磁盘
            cd.writeUInt16LE(0, 36);               // 内部属性
            cd.writeUInt32LE(0, 38);               // 外部属性
            cd.writeUInt32LE(offset - (30 + nameBuf.length + data.length), 42);
            central.push(Buffer.concat([cd, nameBuf]));
        }

        if (entries.length > 0xffff) throw new Error('条目数超过 65535，这个 zip 实现不支持（需要 ZIP64）');

        const cdBuf = Buffer.concat(central);
        await write(cdBuf);
        const eocd = Buffer.alloc(22);
        eocd.writeUInt32LE(EOCD_SIG, 0);
        eocd.writeUInt16LE(0, 4);
        eocd.writeUInt16LE(0, 6);
        eocd.writeUInt16LE(entries.length, 8);
        eocd.writeUInt16LE(entries.length, 10);
        eocd.writeUInt32LE(cdBuf.length, 12);
        eocd.writeUInt32LE(offset, 16);
        eocd.writeUInt16LE(0, 20);
        await write(eocd);
    } finally {
        await new Promise<void>((resolve) => out.end(resolve));
    }

    return total;
}

export interface ZipEntry {
    name: string;
    /** **压缩后**在包里的字节数（readZipEntry 按它切数据） */
    size: number;
    /** 原始未压缩大小（仅供调用方参考，不用于切片） */
    rawSize: number;
    /** 本地头在包里的偏移 */
    offset: number;
    /** 0=store / 8=deflate。用于 `readZipEntry` 决定要不要 inflate */
    method: number;
}

/** 读中央目录（不碰文件数据） */
export async function listZip(zipPath: string): Promise<ZipEntry[]> {
    const fd = await fsasync.open(zipPath, 'r');
    try {
        const { size } = await fd.stat();
        if (size < 22) throw new Error('不是一份 zip（太小）');

        // EOCD 在末尾，注释最长 64KB ⇒ 从后往前找最多 64KB + 22
        const tailLen = Math.min(size, 22 + 0xffff);
        const tail = Buffer.alloc(tailLen);
        await fd.read(tail, 0, tailLen, size - tailLen);
        let eocd = -1;
        for (let i = tail.length - 22; i >= 0; i--) {
            if (tail.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
        }
        if (eocd < 0) throw new Error('不是一份 zip（找不到中央目录结束标记）');

        const count = tail.readUInt16LE(eocd + 10);
        const cdSize = tail.readUInt32LE(eocd + 12);
        const cdOffset = tail.readUInt32LE(eocd + 16);

        const cd = Buffer.alloc(cdSize);
        await fd.read(cd, 0, cdSize, cdOffset);

        const entries: ZipEntry[] = [];
        let p = 0;
        for (let i = 0; i < count; i++) {
            if (cd.readUInt32LE(p) !== CENTRAL_SIG) throw new Error('zip 中央目录损坏');
            const method = cd.readUInt16LE(p + 10);
            // ⚠️ `size` 必须是**压缩后**大小（中央目录偏移 +20），不是原始大小（+24）。
            // `readZipEntry` 按它切字节 —— 取成原始大小会把压缩数据后面的字节也切进来，
            // inflate 直接报 "unexpected end of file"（store 时两者相同，所以这个错只在 deflate 上现形）。
            const compSize = cd.readUInt32LE(p + 20);
            const rawSize = cd.readUInt32LE(p + 24);
            const nameLen = cd.readUInt16LE(p + 28);
            const extraLen = cd.readUInt16LE(p + 30);
            const commentLen = cd.readUInt16LE(p + 32);
            const offset = cd.readUInt32LE(p + 42);
            const name = cd.subarray(p + 46, p + 46 + nameLen).toString('utf8');
            if (method !== METHOD_STORE && method !== METHOD_DEFLATE) {
                throw new Error(`zip 里 ${name} 用了不支持的方式（method=${method}），只认 store/deflate`);
            }
            entries.push({ name, size: compSize, rawSize, offset, method });
            p += 46 + nameLen + extraLen + commentLen;
        }
        return entries;
    } finally {
        await fd.close();
    }
}

/** 取出一个条目的内容（按 method 分派：store 直接切，deflate 切完再 inflate） */
export async function readZipEntry(zipPath: string, entry: ZipEntry): Promise<Buffer> {
    const fd = await fsasync.open(zipPath, 'r');
    try {
        const head = Buffer.alloc(30);
        await fd.read(head, 0, 30, entry.offset);
        if (head.readUInt32LE(0) !== LOCAL_SIG) throw new Error('zip 本地头损坏');
        const nameLen = head.readUInt16LE(26);
        const extraLen = head.readUInt16LE(28);
        const dataOffset = entry.offset + 30 + nameLen + extraLen;
        const buf = Buffer.alloc(entry.size);
        await fd.read(buf, 0, entry.size, dataOffset);
        return entry.method === METHOD_DEFLATE ? inflateRawSync(buf) : buf;
    } finally {
        await fd.close();
    }
}
