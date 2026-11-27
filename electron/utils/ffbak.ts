import fs from 'node:fs';
import * as fsasync from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';

export const FFBAK_MAGIC = 'FFBK';
export const FFBAK_FOOTER = 'FEND';
export const FFBAK_VERSION = 1;

const HEADER_SIZE = 20; // Magic(4) + Version(2) + Flags(2) + HeaderMask(4) + MetaChunkLen(4) + MetaChunkCRC32(4)
const BIN_COUNT_SIZE = 4;
const FRAME_HEADER_SIZE = 30; // Kind(1) + Fmt(1) + Sig(20) + DataLen(4) + DataCRC32(4)
const FOOTER_SIZE = 4;
const SIG_BYTES = 20;

export interface FfbakManifest {
    format: number;
    app: 'file-finder';
    createdAt: string;
    cacheVersion: number;
    includePreviews: boolean;
    dbEntries: number;
    images: number;
    playlists: number;
    hits: number;
    siteRules?: number;
}

export interface FfbakMetaBundle {
    manifest: FfbakManifest;
    cacheEntries: unknown[];
    disks: Record<string, unknown>;
    playlists: unknown[];
    hits: unknown[];
    siteRules?: unknown[];
}

export interface FfbakImageInput {
    kind: 't' | 'p';
    fmt: 1 | 2;
    sigHex: string;
    data: Buffer;
}

export interface FfbakImageEntry {
    kind: 't' | 'p';
    fmt: number;
    sigHex: string;
    data: Buffer;
}

function applyXorMask(buf: Buffer, mask: number): Buffer {
    const out = Buffer.from(buf);
    const m0 = mask & 0xff;
    const m1 = (mask >>> 8) & 0xff;
    const m2 = (mask >>> 16) & 0xff;
    const m3 = (mask >>> 24) & 0xff;
    const m = [m0, m1, m2, m3];
    for (let i = 0; i < out.length; i++) {
        out[i] ^= m[i & 3];
    }
    return out;
}

function writeToStream(stream: fs.WriteStream, chunk: Buffer): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        const onError = (err: Error) => {
            cleanup();
            reject(err);
        };
        const onDrain = () => {
            cleanup();
            resolve();
        };
        const cleanup = () => {
            stream.off('error', onError);
            stream.off('drain', onDrain);
        };
        stream.on('error', onError);
        const ok = stream.write(chunk);
        if (ok) {
            cleanup();
            resolve();
        } else {
            stream.on('drain', onDrain);
        }
    });
}

function closeStream(stream: fs.WriteStream): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        stream.end((err?: Error | null) => {
            if (err) reject(err);
            else resolve();
        });
    });
}

async function readExact(fh: fsasync.FileHandle, len: number, position: number, label: string): Promise<Buffer> {
    const buf = Buffer.allocUnsafe(len);
    let offset = 0;
    while (offset < len) {
        const { bytesRead } = await fh.read(buf, offset, len - offset, position + offset);
        if (bytesRead === 0) {
            throw new Error(`备份文件已截断（读取 ${label} 时提前结束）`);
        }
        offset += bytesRead;
    }
    return buf;
}

/**
 * 探测备份文件格式：`.ffbak`（FFBK）、`.zip`（PK）或未知。
 */
export async function detectBackupFormat(filePath: string): Promise<'ffbak' | 'zip' | 'unknown'> {
    const fh = await fsasync.open(filePath, 'r');
    try {
        const buf = Buffer.alloc(4);
        const { bytesRead } = await fh.read(buf, 0, 4, 0);
        if (bytesRead < 4) return 'unknown';
        if (buf.toString('ascii') === FFBAK_MAGIC) return 'ffbak';
        if (buf[0] === 0x50 && buf[1] === 0x4b && ((buf[2] === 0x03 && buf[3] === 0x04) || (buf[2] === 0x05 && buf[3] === 0x06))) {
            return 'zip';
        }
        return 'unknown';
    } finally {
        await fh.close();
    }
}

/**
 * 流式写入 `.ffbak` 备份文件（临时文件写完原子 rename）。
 */
export async function writeFfbak(
    targetPath: string,
    opts: {
        includePreviews: boolean;
        meta: FfbakMetaBundle;
        images: AsyncIterable<FfbakImageInput> | Iterable<FfbakImageInput>;
    },
): Promise<{ bytes: number; imageCount: number }> {
    await fsasync.mkdir(path.dirname(targetPath), { recursive: true });
    const tmpPath = `${targetPath}.tmp-${process.pid}-${Date.now().toString(36)}`;

    const metaJson = Buffer.from(JSON.stringify(opts.meta), 'utf8');
    const compressedMeta = zlib.zstdCompressSync(metaJson, {
        params: { [zlib.constants.ZSTD_c_compressionLevel]: 19 },
    });
    const headerMask = crypto.randomBytes(4).readUInt32LE(0);
    const maskedMeta = applyXorMask(compressedMeta, headerMask);
    const metaCrc32 = zlib.crc32(maskedMeta) >>> 0;

    const header = Buffer.allocUnsafe(HEADER_SIZE);
    header.write(FFBAK_MAGIC, 0, 'ascii');
    header.writeUInt16LE(FFBAK_VERSION, 4);
    header.writeUInt16LE(opts.includePreviews ? 1 : 0, 6);
    header.writeUInt32LE(headerMask, 8);
    header.writeUInt32LE(maskedMeta.length, 12);
    header.writeUInt32LE(metaCrc32, 16);

    const binCountOffset = HEADER_SIZE + maskedMeta.length;
    const binCountPlaceholder = Buffer.alloc(BIN_COUNT_SIZE);

    const stream = fs.createWriteStream(tmpPath);
    let totalBytes = 0;
    let imageCount = 0;

    try {
        await writeToStream(stream, header);
        totalBytes += header.length;

        await writeToStream(stream, maskedMeta);
        totalBytes += maskedMeta.length;

        await writeToStream(stream, binCountPlaceholder);
        totalBytes += binCountPlaceholder.length;

        for await (const img of opts.images) {
            const sigBuf = Buffer.from(img.sigHex, 'hex');
            if (sigBuf.length !== SIG_BYTES) {
                throw new Error(`图片签名长度非法：${img.sigHex}`);
            }
            const frameHeader = Buffer.allocUnsafe(FRAME_HEADER_SIZE);
            frameHeader.writeUInt8(img.kind === 'p' ? 2 : 1, 0);
            frameHeader.writeUInt8(img.fmt === 2 ? 2 : 1, 1);
            sigBuf.copy(frameHeader, 2);
            frameHeader.writeUInt32LE(img.data.length, 22);
            frameHeader.writeUInt32LE(zlib.crc32(img.data) >>> 0, 26);

            await writeToStream(stream, frameHeader);
            await writeToStream(stream, img.data);
            totalBytes += frameHeader.length + img.data.length;
            imageCount += 1;
        }

        const footer = Buffer.from(FFBAK_FOOTER, 'ascii');
        await writeToStream(stream, footer);
        totalBytes += footer.length;

        await closeStream(stream);

        // 回填实际 BinCount
        const fh = await fsasync.open(tmpPath, 'r+');
        try {
            const countBuf = Buffer.allocUnsafe(BIN_COUNT_SIZE);
            countBuf.writeUInt32LE(imageCount, 0);
            await fh.write(countBuf, 0, BIN_COUNT_SIZE, binCountOffset);
        } finally {
            await fh.close();
        }

        await fsasync.rename(tmpPath, targetPath);
        return { bytes: totalBytes, imageCount };
    } catch (err) {
        if (!stream.closed) {
            stream.destroy();
        }
        await fsasync.rm(tmpPath, { force: true }).catch(() => {});
        throw err;
    }
}

/**
 * 完整校验 `.ffbak` 文件头、MetaChunk CRC32、所有图片帧长度与 CRC32 以及末尾 FEND 魔数，
 * 并解析返回元数据与图片区偏移。任何损坏均在返回前抛出明确错误。
 */
export async function readFfbakMetaAndVerify(filePath: string): Promise<{
    version: number;
    includePreviews: boolean;
    meta: FfbakMetaBundle;
    imagesOffset: number;
    binCount: number;
}> {
    const stat = await fsasync.stat(filePath);
    const fileSize = stat.size;
    if (fileSize < HEADER_SIZE + BIN_COUNT_SIZE + FOOTER_SIZE) {
        throw new Error('备份文件过小，不是有效的 .ffbak 文件');
    }

    const fh = await fsasync.open(filePath, 'r');
    try {
        const header = await readExact(fh, HEADER_SIZE, 0, '文件头');
        if (header.toString('ascii', 0, 4) !== FFBAK_MAGIC) {
            throw new Error('备份文件魔数无效（非 FFBK）');
        }
        const version = header.readUInt16LE(4);
        if (version < 1 || version > FFBAK_VERSION) {
            throw new Error(`不支持的 .ffbak 版本（v${version}），请升级应用后再试`);
        }
        const flags = header.readUInt16LE(6);
        const includePreviews = (flags & 1) !== 0;
        const headerMask = header.readUInt32LE(8);
        const metaChunkLen = header.readUInt32LE(12);
        const metaChunkCrc32 = header.readUInt32LE(16);

        if (HEADER_SIZE + metaChunkLen + BIN_COUNT_SIZE + FOOTER_SIZE > fileSize) {
            throw new Error('备份文件已截断（MetaChunk 长度超出文件大小）');
        }

        const maskedMeta = await readExact(fh, metaChunkLen, HEADER_SIZE, 'MetaChunk');
        const actualMetaCrc = zlib.crc32(maskedMeta) >>> 0;
        if (actualMetaCrc !== metaChunkCrc32) {
            throw new Error('MetaChunk CRC32 校验失败，备份文件已损坏');
        }

        let meta: FfbakMetaBundle;
        try {
            const compressed = applyXorMask(maskedMeta, headerMask);
            const plainBuf = zlib.zstdDecompressSync(compressed);
            meta = JSON.parse(plainBuf.toString('utf8')) as FfbakMetaBundle;
        } catch (err) {
            throw new Error(`MetaChunk 解压或解析失败：${err instanceof Error ? err.message : String(err)}`);
        }

        const binCountOffset = HEADER_SIZE + metaChunkLen;
        const binCountBuf = await readExact(fh, BIN_COUNT_SIZE, binCountOffset, 'BinCount');
        const binCount = binCountBuf.readUInt32LE(0);
        const imagesOffset = binCountOffset + BIN_COUNT_SIZE;

        let cursor = imagesOffset;
        for (let i = 0; i < binCount; i++) {
            if (cursor + FRAME_HEADER_SIZE + FOOTER_SIZE > fileSize) {
                throw new Error(`备份文件已截断（第 ${i + 1} 张图片帧头不完整）`);
            }
            const frameHeader = await readExact(fh, FRAME_HEADER_SIZE, cursor, `图片帧 #${i + 1} 头`);
            const kindByte = frameHeader.readUInt8(0);
            const fmtByte = frameHeader.readUInt8(1);
            if ((kindByte !== 1 && kindByte !== 2) || (fmtByte !== 1 && fmtByte !== 2)) {
                throw new Error(`第 ${i + 1} 张图片帧类型或格式标记无效`);
            }
            const dataLen = frameHeader.readUInt32LE(22);
            const dataCrc32 = frameHeader.readUInt32LE(26);
            cursor += FRAME_HEADER_SIZE;

            if (cursor + dataLen + FOOTER_SIZE > fileSize) {
                throw new Error(`备份文件已截断（第 ${i + 1} 张图片数据不完整）`);
            }
            const data = await readExact(fh, dataLen, cursor, `图片帧 #${i + 1} 数据`);
            const actualDataCrc = zlib.crc32(data) >>> 0;
            if (actualDataCrc !== dataCrc32) {
                throw new Error(`第 ${i + 1} 张图片 DataCRC32 校验失败，备份文件已损坏`);
            }
            cursor += dataLen;
        }

        if (cursor + FOOTER_SIZE !== fileSize) {
            throw new Error('备份文件长度与帧结构不匹配（可能已截断或存在多余尾部数据）');
        }
        const footer = await readExact(fh, FOOTER_SIZE, cursor, 'FEND 结尾魔数');
        if (footer.toString('ascii') !== FFBAK_FOOTER) {
            throw new Error('备份文件结尾 FEND 魔数无效，文件已损坏');
        }

        return { version, includePreviews, meta, imagesOffset, binCount };
    } finally {
        await fh.close();
    }
}

/**
 * 顺序流式读取已校验的 `.ffbak` 图片区，逐张回调处理。
 */
export async function streamFfbakImages(
    filePath: string,
    imagesOffset: number,
    binCount: number,
    onImage: (entry: FfbakImageEntry) => Promise<void> | void,
): Promise<void> {
    if (binCount <= 0) return;
    const fh = await fsasync.open(filePath, 'r');
    try {
        let cursor = imagesOffset;
        for (let i = 0; i < binCount; i++) {
            const frameHeader = await readExact(fh, FRAME_HEADER_SIZE, cursor, `图片帧 #${i + 1} 头`);
            const kind: 't' | 'p' = frameHeader.readUInt8(0) === 2 ? 'p' : 't';
            const fmt = frameHeader.readUInt8(1);
            const sigHex = frameHeader.subarray(2, 22).toString('hex');
            const dataLen = frameHeader.readUInt32LE(22);
            cursor += FRAME_HEADER_SIZE;

            const data = await readExact(fh, dataLen, cursor, `图片帧 #${i + 1} 数据`);
            cursor += dataLen;

            await onImage({ kind, fmt, sigHex, data });
        }
    } finally {
        await fh.close();
    }
}
