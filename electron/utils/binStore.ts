import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import * as fsasync from 'node:fs/promises';
import path from 'node:path';
import config from '../config';
import { decryptBlob } from './cacheCrypto';

export type BinKind = 't' | 'p';
export type BinContentType = 'image/webp' | 'image/jpeg';

export interface BinEntry {
    buf: Buffer;
    contentType: BinContentType;
}

export interface BinKey {
    kind: BinKind;
    sig: string;
}

export interface BinEntryMeta extends BinKey {
    name: string;
}

export interface BinStatsRow extends BinEntryMeta {
    fmt: number;
    size: number;
    createdAt: number;
}

const MIGRATION_BATCH_SIZE = 80;

export let BIN_DIR = path.join(config.userBasePath, 'bin');
export let BIN_DB_PATH = path.join(config.userBasePath, 'bin.sqlite');

let activeDataDir: string | null = null;
let db: DatabaseSync | null = null;
let stmtGet: ReturnType<DatabaseSync['prepare']> | null = null;
let stmtPut: ReturnType<DatabaseSync['prepare']> | null = null;
let stmtSize: ReturnType<DatabaseSync['prepare']> | null = null;
let stmtDel: ReturnType<DatabaseSync['prepare']> | null = null;
let stmtStats: ReturnType<DatabaseSync['prepare']> | null = null;

let loadError: unknown = null;
let readyPromise: Promise<void> | null = null;
let migrationPromise: Promise<void> = Promise.resolve();
let generation = 0;

/** 内存索引：已入库的图片规范名（`<kind>-<lowerHex>.enc`） */
const dbNames = new Set<string>();
/** 待迁移的旧版 `.enc` 文件（canonical name -> 磁盘实际文件名） */
const legacyPending = new Map<string, string>();
let legacyBytesCache: number | null = null;

interface PendingWrite {
    name: string;
    plain: Buffer;
    resolve: () => void;
}
let writeQueue: PendingWrite[] = [];
let flushScheduled = false;

function parseBinName(name?: string): { kind: BinKind; sigHex: string; sigBuf: Buffer; canonical: string } | null {
    const m = /^([tp])-([0-9a-f]+)\.enc$/i.exec(name || '');
    if (!m) return null;
    const kind = m[1].toLowerCase() as BinKind;
    const sigHex = m[2].toLowerCase();
    if (sigHex.length % 2 !== 0) return null;
    return {
        kind,
        sigHex,
        sigBuf: Buffer.from(sigHex, 'hex'),
        canonical: `${kind}-${sigHex}.enc`,
    };
}

export function detectImageFmt(buf: Buffer): 1 | 2 {
    if (
        buf.length >= 12 &&
        buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
        buf.subarray(8, 12).toString('ascii') === 'WEBP'
    ) {
        return 2;
    }
    return 1;
}

function fmtToContentType(fmt: number): BinContentType {
    return fmt === 2 ? 'image/webp' : 'image/jpeg';
}

function closeDbHandle(): void {
    stmtGet = null;
    stmtPut = null;
    stmtSize = null;
    stmtDel = null;
    stmtStats = null;
    if (db) {
        try {
            db.close();
        } catch {
            // ignore close errors during reset
        }
        db = null;
    }
}

function openBinSqlite(dbPath: string): DatabaseSync {
    const database = new DatabaseSync(dbPath);
    database.exec(`
        PRAGMA auto_vacuum = INCREMENTAL;
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        CREATE TABLE IF NOT EXISTS bins (
            kind TEXT NOT NULL,
            sig BLOB NOT NULL,
            fmt INTEGER NOT NULL,
            size INTEGER NOT NULL,
            created_at INTEGER NOT NULL,
            data BLOB NOT NULL,
            PRIMARY KEY (kind, sig)
        ) WITHOUT ROWID;
    `);
    stmtGet = database.prepare('SELECT fmt, data FROM bins WHERE kind = ? AND sig = ?');
    stmtPut = database.prepare(
        'INSERT OR REPLACE INTO bins (kind, sig, fmt, size, created_at, data) VALUES (?, ?, ?, ?, ?, ?)',
    );
    stmtSize = database.prepare('SELECT size FROM bins WHERE kind = ? AND sig = ?');
    stmtDel = database.prepare('DELETE FROM bins WHERE kind = ? AND sig = ?');
    stmtStats = database.prepare('SELECT COUNT(*) AS cnt, COALESCE(SUM(size), 0) AS total FROM bins');
    return database;
}

function putBinsBatchSync(items: { name: string; buf: Buffer }[]): void {
    if (!db || !stmtPut || loadError || items.length === 0) return;

    const valid: {
        canonical: string;
        kind: BinKind;
        sigBuf: Buffer;
        fmt: number;
        size: number;
        buf: Buffer;
    }[] = [];

    for (const item of items) {
        const parsed = parseBinName(item.name);
        if (!parsed) continue;
        valid.push({
            canonical: parsed.canonical,
            kind: parsed.kind,
            sigBuf: parsed.sigBuf,
            fmt: detectImageFmt(item.buf),
            size: item.buf.length,
            buf: item.buf,
        });
    }
    if (valid.length === 0) return;

    const now = Date.now();
    db.exec('BEGIN');
    try {
        for (const row of valid) {
            stmtPut.run(row.kind, row.sigBuf, row.fmt, row.size, now, row.buf);
        }
        db.exec('COMMIT');
    } catch (err) {
        try {
            db.exec('ROLLBACK');
        } catch {
            // ignore rollback error
        }
        throw err;
    }

    for (const row of valid) {
        dbNames.add(row.canonical);
    }
}

function flushWriteQueue(): void {
    flushScheduled = false;
    const batch = writeQueue;
    writeQueue = [];
    if (batch.length === 0) return;

    try {
        putBinsBatchSync(batch.map((w) => ({ name: w.name, buf: w.plain })));
    } catch (e) {
        console.error('[bin] 批量写入失败:', e);
    } finally {
        for (const w of batch) w.resolve();
    }
}

async function runLegacyMigration(gen: number): Promise<void> {
    if (gen !== generation || !db || legacyPending.size === 0) return;

    let migratedCount = 0;
    while (legacyPending.size > 0) {
        if (gen !== generation || !db) return;

        const batch: [string, string][] = [];
        for (const entry of legacyPending.entries()) {
            batch.push(entry);
            if (batch.length >= MIGRATION_BATCH_SIZE) break;
        }

        const decoded: {
            canonical: string;
            filename: string;
            kind: BinKind;
            sigBuf: Buffer;
            fmt: number;
            plain: Buffer;
        }[] = [];
        const failed: string[] = [];

        for (const [canonical, filename] of batch) {
            if (gen !== generation || !db) return;
            const parsed = parseBinName(canonical);
            if (!parsed) {
                failed.push(canonical);
                continue;
            }
            try {
                const enc = await fsasync.readFile(path.join(BIN_DIR, filename));
                const plain = decryptBlob(enc);
                decoded.push({
                    canonical,
                    filename,
                    kind: parsed.kind,
                    sigBuf: parsed.sigBuf,
                    fmt: detectImageFmt(plain),
                    plain,
                });
            } catch (e) {
                console.error('[bin] 旧文件迁移读取/解密失败，跳过:', filename, e);
                failed.push(canonical);
            }
        }

        if (gen !== generation || !db || !stmtPut) return;

        if (decoded.length > 0) {
            const now = Date.now();
            db.exec('BEGIN');
            try {
                for (const item of decoded) {
                    stmtPut.run(item.kind, item.sigBuf, item.fmt, item.plain.length, now, item.plain);
                }
                db.exec('COMMIT');
            } catch (e) {
                try {
                    db.exec('ROLLBACK');
                } catch {
                    // ignore
                }
                console.error('[bin] 旧文件批量写入 bin.sqlite 失败，中止本次后台迁移:', e);
                return;
            }

            for (const item of decoded) {
                dbNames.add(item.canonical);
                legacyPending.delete(item.canonical);
                await fsasync.unlink(path.join(BIN_DIR, item.filename)).catch(() => {});
            }
            migratedCount += decoded.length;
            legacyBytesCache = null;
        }

        for (const canonical of failed) {
            legacyPending.delete(canonical);
        }

        if (legacyPending.size > 0) {
            await new Promise<void>((r) => setImmediate(r));
        }
    }

    if (gen !== generation) return;

    try {
        const remaining = await fsasync.readdir(BIN_DIR);
        if (remaining.length === 0) {
            await fsasync.rmdir(BIN_DIR).catch(() => {});
        }
    } catch {
        // BIN_DIR may not exist
    }

    if (migratedCount > 0) {
        console.log(`[bin] 后台迁移完成：已将 ${migratedCount} 张旧 .enc 图片迁入 bin.sqlite`);
    }
}

/**
 * 初始化（或切换）图片仓。
 * - 默认使用 `config.userBasePath`
 * - 仅打开 `bin.sqlite` 并扫描待迁 `bin/*.enc` 文件名后即 resolve（< 10ms，绝不阻塞 listen）
 * - 后台按 80 张/批渐进迁移旧 `.enc` 文件，每批让出事件循环
 */
export function initBinStore(dataDir?: string): Promise<void> {
    const targetDir = dataDir ?? config.userBasePath;
    if (readyPromise && activeDataDir === targetDir && !loadError) {
        return readyPromise;
    }

    generation++;
    const gen = generation;

    // 清理上一轮未冲刷的写队列
    if (writeQueue.length > 0) {
        const stale = writeQueue;
        writeQueue = [];
        for (const w of stale) w.resolve();
    }
    flushScheduled = false;

    closeDbHandle();
    dbNames.clear();
    legacyPending.clear();
    legacyBytesCache = null;
    loadError = null;

    activeDataDir = targetDir;
    BIN_DIR = path.join(targetDir, 'bin');
    BIN_DB_PATH = path.join(targetDir, 'bin.sqlite');

    readyPromise = (async () => {
        try {
            await fsasync.mkdir(targetDir, { recursive: true });
            const database = openBinSqlite(BIN_DB_PATH);
            if (gen !== generation) {
                database.close();
                return;
            }
            db = database;

            const rows = database.prepare('SELECT kind, hex(sig) AS sigHex FROM bins').iterate() as IterableIterator<{
                kind: string;
                sigHex: string;
            }>;
            for (const row of rows) {
                dbNames.add(`${row.kind}-${row.sigHex.toLowerCase()}.enc`);
            }

            try {
                const files = await fsasync.readdir(BIN_DIR);
                for (const file of files) {
                    const parsed = parseBinName(file);
                    if (parsed) {
                        legacyPending.set(parsed.canonical, file);
                    }
                }
            } catch {
                // 旧 bin/ 目录不存在是正常新库态
            }

            migrationPromise = runLegacyMigration(gen);
        } catch (e) {
            loadError = e;
            closeDbHandle();
            console.error('[bin] 图片仓初始化失败（图片将不可用，其余功能不受影响）:', e);
        }
    })();

    return readyPromise;
}

if (process.env.NODE_ENV !== 'test') {
    void initBinStore().catch(() => {});
}

/** 等图片仓就绪（仅等打开 bin.sqlite + 扫描待迁文件名，绝不等后台迁移完成） */
export function whenBinReady(): Promise<void> {
    return readyPromise ?? initBinStore();
}

/** 图片仓是不是没就绪（只用在下发态：没就绪就不给前端 key，免得满屏 404 白框） */
export function binStoreFailed(): boolean {
    return loadError !== null;
}

export function hasBin(name?: string): boolean {
    const parsed = parseBinName(name);
    if (!parsed) return false;
    return dbNames.has(parsed.canonical) || legacyPending.has(parsed.canonical);
}

export const thumbNameOf = (sig?: string): string | undefined => (sig ? `t-${sig}.enc` : undefined);

export const previewNameOf = (sig?: string): string | undefined => (sig ? `p-${sig}.enc` : undefined);

export function sigOfThumbName(name?: string): string | undefined {
    const m = /^t-([0-9a-f]+)\.enc$/i.exec(name || '');
    return m ? m[1] : undefined;
}

export function getBin(name: string): BinEntry | null {
    const parsed = parseBinName(name);
    if (!parsed) return null;

    if (db && stmtGet && dbNames.has(parsed.canonical)) {
        try {
            const row = stmtGet.get(parsed.kind, parsed.sigBuf) as { fmt: number; data: Uint8Array } | undefined;
            if (row) {
                return {
                    buf: Buffer.from(row.data),
                    contentType: fmtToContentType(row.fmt),
                };
            }
        } catch (e) {
            console.error('[bin] SQLite 读取失败:', name, e);
        }
    }

    const legacyFile = legacyPending.get(parsed.canonical);
    if (legacyFile) {
        try {
            const plain = decryptBlob(fs.readFileSync(path.join(BIN_DIR, legacyFile)));
            return {
                buf: plain,
                contentType: fmtToContentType(detectImageFmt(plain)),
            };
        } catch (e) {
            console.error('[bin] 旧文件读取/解密失败:', name, e);
            legacyPending.delete(parsed.canonical);
            return null;
        }
    }

    return null;
}

/**
 * 写一张图。同 tick 并发调用经由微任务合并入单事务写入 `bin.sqlite`。
 */
export function putBin(name: string, plain: Buffer): Promise<void> {
    if (loadError || !name) return Promise.resolve();
    return new Promise<void>((resolve) => {
        writeQueue.push({ name, plain, resolve });
        if (!flushScheduled) {
            flushScheduled = true;
            queueMicrotask(flushWriteQueue);
        }
    });
}

/** 批量写入多张图（单事务落盘） */
export async function putBinsBatch(items: { name: string; buf: Buffer }[]): Promise<void> {
    if (loadError || items.length === 0) return;
    try {
        putBinsBatchSync(items);
    } catch (e) {
        console.error('[bin] putBinsBatch 写入失败:', e);
    }
}

/**
 * 解密旧版 `.enc` 密文并写入 `bin.sqlite`（供兼容还原路径使用）。
 */
export async function putBinEncrypted(name: string, encrypted: Buffer): Promise<void> {
    if (loadError || !name) return;
    try {
        const plain = decryptBlob(encrypted);
        await putBin(name, plain);
    } catch (e) {
        console.error('[bin] 解密并落盘失败（来自包）:', name, e);
    }
}

/** 全部图片名（内存索引） */
export function listBinNames(): string[] {
    if (legacyPending.size === 0) return [...dbNames];
    const all = new Set<string>(dbNames);
    for (const k of legacyPending.keys()) all.add(k);
    return [...all];
}

/** 全部图片元数据列表 */
export function listBinEntries(): BinEntryMeta[] {
    const out: BinEntryMeta[] = [];
    for (const name of listBinNames()) {
        const parsed = parseBinName(name);
        if (!parsed) continue;
        out.push({ kind: parsed.kind, sig: parsed.sigHex, name: parsed.canonical });
    }
    return out;
}

/** 含尺寸与写入时间戳的轻量图片元数据列表（供设置页盘点孤儿与保护窗判断，不读取 BLOB） */
export function listBinStatsRows(): BinStatsRow[] {
    const out: BinStatsRow[] = [];
    const seen = new Set<string>();

    if (db) {
        const stmt = db.prepare('SELECT kind, sig, fmt, size, created_at FROM bins');
        for (const raw of stmt.iterate()) {
            const row = raw as { kind: BinKind; sig: Uint8Array; fmt: number; size: number; created_at: number };
            const sigHex = Buffer.from(row.sig).toString('hex').toLowerCase();
            const canonical = `${row.kind}-${sigHex}.enc`;
            seen.add(canonical);
            out.push({
                kind: row.kind,
                sig: sigHex,
                name: canonical,
                fmt: Number(row.fmt) || 1,
                size: Number(row.size) || 0,
                createdAt: Number(row.created_at) || 0,
            });
        }
    }

    for (const [canonical, filename] of legacyPending.entries()) {
        if (seen.has(canonical)) continue;
        const parsed = parseBinName(canonical);
        if (!parsed) continue;
        try {
            const st = fs.statSync(path.join(BIN_DIR, filename));
            out.push({
                kind: parsed.kind,
                sig: parsed.sigHex,
                name: canonical,
                fmt: 1,
                size: st.size,
                createdAt: Math.round(st.mtimeMs),
            });
        } catch {
            // 文件可能刚被迁移或删除
        }
    }

    return out;
}

/** 供备份打包读取单条原始图片数据与格式标记 */
export function readBinEntryForBackup(kind: BinKind, sigHex: string): { fmt: number; data: Buffer } | null {
    const normalized = sigHex.toLowerCase();
    if (!/^[0-9a-f]+$/.test(normalized) || normalized.length % 2 !== 0) return null;
    const sigBuf = Buffer.from(normalized, 'hex');

    if (db && stmtGet) {
        try {
            const row = stmtGet.get(kind, sigBuf) as { fmt: number; data: Uint8Array } | undefined;
            if (row) {
                return { fmt: row.fmt, data: Buffer.from(row.data) };
            }
        } catch (e) {
            console.error('[bin] 备份读取 SQLite 失败:', kind, normalized, e);
        }
    }

    const canonical = `${kind}-${normalized}.enc`;
    const legacyFile = legacyPending.get(canonical);
    if (legacyFile) {
        try {
            const plain = decryptBlob(fs.readFileSync(path.join(BIN_DIR, legacyFile)));
            return { fmt: detectImageFmt(plain), data: plain };
        } catch (e) {
            console.error('[bin] 备份读取旧文件失败:', canonical, e);
        }
    }

    return null;
}

/** 批量删除指定图片，并在事务提交后执行 `PRAGMA incremental_vacuum` 归还磁盘空间 */
export async function deleteBinsBatch(keys: BinKey[]): Promise<{ removed: number; freed: number }> {
    if (!db || !stmtSize || !stmtDel || keys.length === 0) {
        return { removed: 0, freed: 0 };
    }

    let removed = 0;
    let freed = 0;
    const removedCanonicals: string[] = [];

    db.exec('BEGIN');
    try {
        for (const key of keys) {
            const normalized = key.sig.toLowerCase();
            if (!/^[0-9a-f]+$/.test(normalized) || normalized.length % 2 !== 0) continue;
            const sigBuf = Buffer.from(normalized, 'hex');
            const canonical = `${key.kind}-${normalized}.enc`;

            const sizeRow = stmtSize.get(key.kind, sigBuf) as { size: number } | undefined;
            const delInfo = stmtDel.run(key.kind, sigBuf);
            if (Number(delInfo.changes) > 0) {
                removed++;
                freed += sizeRow?.size ?? 0;
                removedCanonicals.push(canonical);
            }
        }
        db.exec('COMMIT');
    } catch (err) {
        try {
            db.exec('ROLLBACK');
        } catch {
            // ignore
        }
        throw err;
    }

    for (const canonical of removedCanonicals) {
        dbNames.delete(canonical);
    }

    for (const key of keys) {
        const canonical = `${key.kind}-${key.sig.toLowerCase()}.enc`;
        const legacyFile = legacyPending.get(canonical);
        if (legacyFile) {
            legacyPending.delete(canonical);
            await fsasync.unlink(path.join(BIN_DIR, legacyFile)).catch(() => {});
            legacyBytesCache = null;
        }
    }

    if (removed > 0) {
        db.exec('PRAGMA incremental_vacuum;');
        db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    }

    return { removed, freed };
}

/** 仓库概况（面板/探针用）：条数与总字节 */
export async function binStats(): Promise<{ count: number; bytes: number }> {
    let count = 0;
    let bytes = 0;

    if (db && stmtStats) {
        const row = stmtStats.get() as { cnt: number; total: number } | undefined;
        if (row) {
            count = Number(row.cnt) || 0;
            bytes = Number(row.total) || 0;
        }
    }

    if (legacyPending.size > 0) {
        let extraCount = 0;
        for (const canonical of legacyPending.keys()) {
            if (!dbNames.has(canonical)) extraCount++;
        }
        count += extraCount;

        if (legacyBytesCache === null) {
            let sum = 0;
            for (const [canonical, filename] of legacyPending.entries()) {
                if (dbNames.has(canonical)) continue;
                try {
                    sum += (await fsasync.stat(path.join(BIN_DIR, filename))).size;
                } catch {
                    // ignore missing
                }
            }
            legacyBytesCache = sum;
        }
        bytes += legacyBytesCache;
    }

    return { count, bytes };
}

/** 获取 `bin.sqlite`（含 WAL）占用磁盘字节数 */
export async function getBinDbBytes(): Promise<number | undefined> {
    try {
        const st = await fsasync.stat(BIN_DB_PATH);
        let total = st.size;
        try {
            const walSt = await fsasync.stat(`${BIN_DB_PATH}-wal`);
            total += walSt.size;
        } catch {
            // WAL file may not exist
        }
        return total;
    } catch {
        return undefined;
    }
}

export function getLegacyBinPendingCount(): number {
    return legacyPending.size;
}

export function waitForLegacyMigration(): Promise<void> {
    return migrationPromise;
}

/** 迁移/退出前安全冲刷队列、落盘并关闭 bin.sqlite 句柄 */
export async function closeBinStore(): Promise<void> {
    if (readyPromise) {
        await readyPromise.catch(() => {});
    }
    await migrationPromise.catch(() => {});
    if (writeQueue.length > 0) {
        flushWriteQueue();
    }
    if (db) {
        try {
            db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
        } catch {
            // ignore
        }
    }
    closeDbHandle();
    dbNames.clear();
    legacyPending.clear();
    legacyBytesCache = null;
}

export async function closeBinStoreForTest(): Promise<void> {
    generation++;
    await migrationPromise.catch(() => {});
    if (db) {
        try {
            db.close();
        } catch {
            // ignore
        }
        db = null;
    }
    stmtGet = null;
    stmtPut = null;
    stmtSize = null;
    stmtDel = null;
    stmtStats = null;
    readyPromise = null;
    activeDataDir = null;
    dbNames.clear();
    legacyPending.clear();
    legacyBytesCache = null;
}
