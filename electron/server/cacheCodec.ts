import zlib from 'node:zlib';
import type { FileInfo, FileInfoFiles, FileKind } from './index';

interface SlimFileEntry {
    n: string;
    s: number;
}

interface SlimFileInfo {
    d?: string;
    n: string;
    t: FileKind;
    i?: boolean;
    s: number;
    e?: string;
    f?: SlimFileEntry[];
    g?: string;
    sb?: number;
    sm?: number;
}

const ZSTD_OPTIONS = {
    params: {
        [zlib.constants.ZSTD_c_compressionLevel]: 9,
    },
};

/**
 * 将 `FileInfo[]` 精简为短键结构并使用 Zstd (level 9) 压缩为 BLOB。
 * - 若 `item.dir === docRelPath` 则省略 `d`
 * - 若 `item.isDirectory === (item.type === 'folder')` 则省略 `i`
 */
export function encodeCacheData(relPath: string, items: FileInfo[]): Buffer {
    const slim: SlimFileInfo[] = new Array(items.length);
    for (let idx = 0; idx < items.length; idx++) {
        const it = items[idx];
        const entry: SlimFileInfo = {
            n: it.name,
            t: it.type,
            s: it.size,
        };
        if (it.dir !== relPath) {
            entry.d = it.dir;
        }
        const defaultIsDir = it.type === 'folder';
        if (Boolean(it.isDirectory) !== defaultIsDir) {
            entry.i = Boolean(it.isDirectory);
        }
        if (it.ext !== undefined) entry.e = it.ext;
        if (it.files !== undefined) {
            entry.f = it.files.map((f: FileInfoFiles) => ({ n: f.name, s: f.size }));
        }
        if (it.sig !== undefined) entry.g = it.sig;
        if (it.srcBytes !== undefined) entry.sb = it.srcBytes;
        if (it.srcMtime !== undefined) entry.sm = it.srcMtime;
        slim[idx] = entry;
    }
    const jsonBuf = Buffer.from(JSON.stringify(slim), 'utf8');
    return zlib.zstdCompressSync(jsonBuf, ZSTD_OPTIONS);
}

/**
 * 将 Zstd 压缩的 BLOB 解压并还原为完整的 `FileInfo[]`。
 */
export function decodeCacheData(relPath: string, blob: Buffer | Uint8Array): FileInfo[] {
    const plain = zlib.zstdDecompressSync(blob);
    const slim = JSON.parse(plain.toString('utf8')) as SlimFileInfo[];
    if (!Array.isArray(slim)) return [];

    const out: FileInfo[] = new Array(slim.length);
    for (let idx = 0; idx < slim.length; idx++) {
        const raw = slim[idx];
        const item: FileInfo = {
            dir: raw.d !== undefined ? raw.d : relPath,
            name: raw.n,
            isDirectory: raw.i !== undefined ? Boolean(raw.i) : raw.t === 'folder',
            type: raw.t,
            size: raw.s,
        };
        if (raw.e !== undefined) item.ext = raw.e;
        if (raw.f !== undefined) {
            item.files = raw.f.map((f) => ({ name: f.n, size: f.s }));
        }
        if (raw.g !== undefined) item.sig = raw.g;
        if (raw.sb !== undefined) item.srcBytes = raw.sb;
        if (raw.sm !== undefined) item.srcMtime = raw.sm;
        out[idx] = item;
    }
    return out;
}
