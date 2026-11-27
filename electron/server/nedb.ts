import { DatabaseSync, backup } from 'node:sqlite';
import * as fs from 'node:fs';
import * as fsasync from 'node:fs/promises';
import readline from 'node:readline';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import dayjs from 'dayjs';
import config from '../config';
import { initBinStore, putBin, hasBin, thumbNameOf } from '../utils/binStore';
import { decryptLine } from '../utils/cacheCrypto';
import { encodeCacheData, decodeCacheData } from './cacheCodec';
import type { FileInfo } from './index';

export type OpenMode = 'cover' | 'folder';

export const CACHE_VERSION = 3;

export interface SearchCache {
    _id?: string;
    /** 格式版本。见 CACHE_VERSION */
    v: number;
    /** 卷序列号，8 位大写十六进制 */
    serial: string;
    /** 盘内相对路径，'' 表示盘根 */
    relPath: string;
    mode: OpenMode;
    /** 条目数 */
    count: number;
    data: FileInfo[];
    create_at: string;
    /** 这份缓存产出时，目录自己的 mtime（`stat(dir).mtimeMs`） */
    dirMtime?: number;
}

/** 不含 data 的轻量视图。列表和按盘统计只用得到这些 */
export type CacheMeta = Omit<SearchCache, 'data'>;

export interface Pagination {
    total: number;
    current: number;
    size: number;
}

export interface BrowseHistory {
    records: (CacheMeta & { bytes?: number; path: string; online: boolean })[];
}

export type BrowseHistoryWithPagination = Pagination & BrowseHistory;

export interface InitCacheDbOptions {
    putBin?: (name: string, bytes: Buffer) => Promise<void>;
}

let activeDataDir = config.userBasePath;

export let CACHE_DB_PATH = path.join(activeDataDir, 'cache.sqlite');
export let BEFORE_RESTORE_PATH = path.join(activeDataDir, 'cache-before-restore.sqlite');

let db: DatabaseSync | null = null;
let loadError: Error | null = null;
let restoring = false;
let initPromise: Promise<void> | null = null;
let decodeSpy: (() => void) | null = null;

/** 仅用于测试：注入 decodeCacheData 调用计数探针 */
export function setDecodeSpyForTest(fn: (() => void) | null): void {
    decodeSpy = fn;
}

/** 仅用于测试：关闭当前打开的 SQLite 句柄 */
export async function closeCacheDbForTest(): Promise<void> {
    closeDbHandle();
}

/** 迁移/退出前安全落盘并关闭 SQLite 句柄 */
export async function closeCacheDb(): Promise<void> {
    if (initPromise) {
        await initPromise.catch(() => {});
    }
    if (db) {
        try {
            db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
        } catch {
            // ignore
        }
    }
    closeDbHandle();
}

function closeDbHandle(): void {
    if (db) {
        try {
            db.close();
        } catch {
            // ignore
        }
        db = null;
    }
}

function openSqliteConnection(filePath: string): DatabaseSync {
    const conn = new DatabaseSync(filePath);
    try {
        applyPragmasAndSchema(conn);
        return conn;
    } catch (err) {
        try {
            conn.close();
        } catch {
            // ignore
        }
        throw err;
    }
}

interface CacheBlobRow {
    serial: string;
    rel_path_lower: string;
    mode: OpenMode;
    rel_path: string;
    v: number;
    count: number;
    create_at: string;
    dir_mtime: number | null;
    data_zstd: Uint8Array;
}

function rowToSearchCache(row: CacheBlobRow): SearchCache {
    return {
        _id: synthId(row.serial, row.rel_path_lower, row.mode),
        v: row.v,
        serial: row.serial,
        relPath: row.rel_path,
        mode: row.mode,
        count: row.count,
        data: decodeRowData(row.rel_path, row.data_zstd),
        create_at: row.create_at,
        ...(row.dir_mtime !== null ? { dirMtime: row.dir_mtime } : {}),
    };
}

function decodeRowData(relPath: string, blob: Buffer | Uint8Array): FileInfo[] {
    if (decodeSpy) decodeSpy();
    return decodeCacheData(relPath, blob);
}

function synthId(serial: string, relPathLower: string, mode: string): string {
    return `${serial}\0${relPathLower}\0${mode}`;
}

function computeBytes(data: FileInfo[] | undefined): number {
    if (!Array.isArray(data)) return 0;
    let total = 0;
    for (let i = 0; i < data.length; i++) {
        total += data[i].size || 0;
    }
    return total;
}

function applyPragmasAndSchema(conn: DatabaseSync): void {
    conn.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        PRAGMA busy_timeout = 5000;
        PRAGMA auto_vacuum = INCREMENTAL;

        CREATE TABLE IF NOT EXISTS cache_entries (
            serial TEXT NOT NULL,
            rel_path_lower TEXT NOT NULL,
            mode TEXT NOT NULL,
            rel_path TEXT NOT NULL,
            v INTEGER NOT NULL,
            count INTEGER NOT NULL,
            bytes INTEGER NOT NULL,
            create_at TEXT NOT NULL,
            dir_mtime REAL,
            data_zstd BLOB NOT NULL,
            PRIMARY KEY (serial, rel_path_lower, mode)
        ) WITHOUT ROWID;

        CREATE INDEX IF NOT EXISTS idx_cache_serial_mode
            ON cache_entries (serial, mode);
    `);
}

function assertUsable(): DatabaseSync {
    if (restoring) {
        throw new Error('缓存库正在还原，请稍后再试');
    }
    if (loadError) {
        throw new Error(`缓存库不可用：${loadError.message}`);
    }
    if (!db) {
        throw new Error('缓存库尚未初始化');
    }
    return db;
}

async function ensureReady(): Promise<DatabaseSync> {
    if (initPromise) {
        await initPromise;
    }
    return assertUsable();
}

async function fileExists(p: string): Promise<boolean> {
    try {
        await fsasync.access(p);
        return true;
    } catch {
        return false;
    }
}

/**
 * 清洗单条记录中的 v2 遗留缩略图字段（`thumbData`/`avatarThumbData`），
 * 将图片写入 bin 仓并补齐 `sig`，升级 `v = CACHE_VERSION`。
 */
async function upgradeLegacyDocThumbs(
    doc: SearchCache,
    putBinFn: (name: string, bytes: Buffer) => Promise<void>,
): Promise<{ changed: boolean; movedImgs: number }> {
    let changed = false;
    let movedImgs = 0;
    if (!Array.isArray(doc.data)) return { changed, movedImgs };

    for (const item of doc.data as unknown as Array<Record<string, unknown>>) {
        const legacy = (item.thumbData || item.avatarThumbData) as string | undefined;
        const hadLegacy = 'thumb' in item || 'thumbData' in item || 'avatar' in item
            || 'avatarThumbData' in item || 'avatarSrc' in item;
        if (!legacy && !hadLegacy) continue;

        try {
            if (typeof legacy === 'string' && legacy.includes(',')) {
                const bytes = Buffer.from(legacy.slice(legacy.indexOf(',') + 1), 'base64');
                if (bytes.length) {
                    const sig = crypto.createHash('sha1').update(bytes).digest('hex');
                    await putBinFn(`t-${sig}.enc`, bytes);
                    item.sig = sig;
                    movedImgs++;
                }
            }
        } catch (e) {
            console.error('[cacheDb] 迁移单张图片失败（跳过这一条）:', e);
        }

        delete item.thumb;
        delete item.thumbData;
        delete item.avatar;
        delete item.avatarThumbData;
        delete item.avatarSrc;
        changed = true;
    }

    if (doc.v !== CACHE_VERSION) {
        doc.v = CACHE_VERSION;
        changed = true;
    }
    return { changed, movedImgs };
}

/**
 * 从 NeDB 文本行流中解析出活跃文档集合（跳过 `$$indexCreated`，应用 `$$deleted`）。
 */
async function parseNedbLines(filePath: string): Promise<SearchCache[]> {
    const byId = new Map<string, SearchCache>();
    let fallbackIdx = 0;

    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    for await (const rawLine of rl) {
        const line = rawLine.trim();
        if (!line) continue;

        const plain = decryptLine(line);
        const parsed = JSON.parse(plain) as Record<string, unknown>;
        if (!parsed || typeof parsed !== 'object') continue;
        if ('$$indexCreated' in parsed) continue;

        const id = typeof parsed._id === 'string' ? parsed._id : `__anon_${fallbackIdx++}`;
        if (parsed.$$deleted === true) {
            byId.delete(id);
            continue;
        }

        if (typeof parsed.serial === 'string' && typeof parsed.mode === 'string') {
            byId.set(id, parsed as unknown as SearchCache);
        }
    }

    return Array.from(byId.values());
}

/**
 * 一次性迁移：当目录中存在旧 `searchCache.db` 且尚未建立 `cache.sqlite` 时，
 * 流式解析旧库、提取 v2 内联缩略图、写入 `cache.sqlite.migrating` 并原子替换。
 */
async function migrateLegacyNedbFile(
    dataDir: string,
    legacyPath: string,
    targetSqlitePath: string,
    putBinFn: (name: string, bytes: Buffer) => Promise<void>,
): Promise<void> {
    const migratingPath = path.join(dataDir, 'cache.sqlite.migrating');
    await fsasync.rm(migratingPath, { force: true }).catch(() => {});
    await fsasync.rm(`${migratingPath}-wal`, { force: true }).catch(() => {});
    await fsasync.rm(`${migratingPath}-shm`, { force: true }).catch(() => {});

    const docs = await parseNedbLines(legacyPath);

    let movedImgs = 0;
    for (const doc of docs) {
        if (doc.v !== CACHE_VERSION) {
            const res = await upgradeLegacyDocThumbs(doc, putBinFn);
            movedImgs += res.movedImgs;
        }
    }

    const tempDb = new DatabaseSync(migratingPath);
    try {
        applyPragmasAndSchema(tempDb);
        const insertStmt = tempDb.prepare(`
            INSERT OR REPLACE INTO cache_entries
            (serial, rel_path_lower, mode, rel_path, v, count, bytes, create_at, dir_mtime, data_zstd)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        const expectedKeys = new Set<string>();
        tempDb.exec('BEGIN IMMEDIATE');
        try {
            for (const doc of docs) {
                const relPath = doc.relPath || '';
                const relPathLower = relPath.toLowerCase();
                expectedKeys.add(synthId(doc.serial, relPathLower, doc.mode));
                const items = Array.isArray(doc.data) ? doc.data : [];
                const bytes = computeBytes(items);
                const blob = encodeCacheData(relPath, items);
                insertStmt.run(
                    doc.serial,
                    relPathLower,
                    doc.mode,
                    relPath,
                    doc.v ?? CACHE_VERSION,
                    doc.count ?? items.length,
                    bytes,
                    doc.create_at || '',
                    doc.dirMtime ?? null,
                    blob,
                );
            }
            tempDb.exec('COMMIT');
        } catch (err) {
            tempDb.exec('ROLLBACK');
            throw err;
        }

        const countRow = tempDb.prepare('SELECT COUNT(*) AS cnt FROM cache_entries').get() as { cnt: number } | undefined;
        if (!countRow || countRow.cnt !== expectedKeys.size) {
            throw new Error(`迁移行数校验失败：预期 ${expectedKeys.size}，实际 ${countRow?.cnt ?? 'unknown'}`);
        }
        tempDb.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } finally {
        tempDb.close();
    }

    await fsasync.rm(`${migratingPath}-wal`, { force: true }).catch(() => {});
    await fsasync.rm(`${migratingPath}-shm`, { force: true }).catch(() => {});
    await fsasync.rename(migratingPath, targetSqlitePath);

    const backupLegacyPath = path.join(dataDir, 'searchCache.db.migrated.bak');
    await fsasync.rename(legacyPath, backupLegacyPath);
    console.log(`[cacheDb] 已从 NeDB 迁移 ${docs.length} 条记录（提取 ${movedImgs} 张 v2 缩略图）到 cache.sqlite`);
}

/**
 * 初始化（或切换）缓存数据库目录。
 * - 默认使用 `config.userBasePath`
 * - 测试环境可传入临时目录，若已有打开句柄会先安全关闭
 */
export async function initCacheDb(dataDir?: string, opts?: InitCacheDbOptions): Promise<void> {
    const run = async () => {
        closeDbHandle();
        loadError = null;

        activeDataDir = dataDir ?? config.userBasePath;
        CACHE_DB_PATH = path.join(activeDataDir, 'cache.sqlite');
        BEFORE_RESTORE_PATH = path.join(activeDataDir, 'cache-before-restore.sqlite');

        await fsasync.mkdir(activeDataDir, { recursive: true });

        const putBinFn = opts?.putBin ?? (async (name: string, bytes: Buffer) => {
            await initBinStore();
            await putBin(name, bytes);
        });

        const legacyPath = path.join(activeDataDir, 'searchCache.db');
        if ((await fileExists(legacyPath)) && !(await fileExists(CACHE_DB_PATH))) {
            await migrateLegacyNedbFile(activeDataDir, legacyPath, CACHE_DB_PATH, putBinFn);
        }

        db = openSqliteConnection(CACHE_DB_PATH);
    };

    const p = run()
        .catch((err) => {
            loadError = err instanceof Error ? err : new Error(String(err));
            console.error('[cacheDb] 缓存库载入失败:', loadError);
            throw loadError;
        })
        .finally(() => {
            if (initPromise === p) {
                initPromise = null;
            }
        });
    initPromise = p;
    await p;
}

if (process.env.NODE_ENV !== 'test') {
    void initCacheDb().catch(() => {
        // loadError 已记录，后续请求由 assertUsable() 响亮抛出
    });
}

/**
 * 从磁盘重新打开主库文件（还原 / 回滚之后调用）。
 */
export async function reloadFromDisk(): Promise<void> {
    initPromise = null;
    closeDbHandle();
    try {
        db = openSqliteConnection(CACHE_DB_PATH);
        loadError = null;
    } catch (err) {
        loadError = err instanceof Error ? err : new Error(String(err));
        throw loadError;
    }
}

/**
 * 若库中仍存在旧版本（v < CACHE_VERSION）的记录（例如还原了旧快照），
 * 将其中的 v2 base64 缩略图搬出到 bin 仓并升级版本号。
 */
export async function migrateLegacyThumbs(): Promise<void> {
    let conn: DatabaseSync;
    try {
        conn = await ensureReady();
    } catch {
        return;
    }

    type RawRow = {
        serial: string;
        rel_path_lower: string;
        mode: OpenMode;
        rel_path: string;
        v: number;
        count: number;
        create_at: string;
        dir_mtime: number | null;
        data_zstd: Uint8Array;
    };

    const oldRows = conn.prepare(`
        SELECT serial, rel_path_lower, mode, rel_path, v, count, create_at, dir_mtime, data_zstd
        FROM cache_entries
        WHERE v != ?
    `).all(CACHE_VERSION) as RawRow[];

    if (oldRows.length === 0) return;

    await initBinStore();
    const putBinFn = async (name: string, bytes: Buffer) => {
        await putBin(name, bytes);
    };

    const updateStmt = conn.prepare(`
        UPDATE cache_entries
        SET v = ?, data_zstd = ?
        WHERE serial = ? AND rel_path_lower = ? AND mode = ?
    `);

    let movedDocs = 0;
    let movedImgs = 0;

    for (const row of oldRows) {
        try {
            const data = decodeRowData(row.rel_path, row.data_zstd);
            const doc: SearchCache = {
                v: row.v,
                serial: row.serial,
                relPath: row.rel_path,
                mode: row.mode,
                count: row.count,
                data,
                create_at: row.create_at,
                ...(row.dir_mtime !== null ? { dirMtime: row.dir_mtime } : {}),
            };
            const res = await upgradeLegacyDocThumbs(doc, putBinFn);
            if (!res.changed) continue;

            const blob = encodeCacheData(doc.relPath, doc.data);
            updateStmt.run(CACHE_VERSION, blob, row.serial, row.rel_path_lower, row.mode);
            movedDocs++;
            movedImgs += res.movedImgs;
        } catch (e) {
            console.error('[cacheDb] 迁移单条记录失败（跳过）:', row.serial, row.rel_path, e);
        }
    }

    if (movedDocs > 0) {
        console.log(`[cacheDb] 图片出库迁移完成：${movedDocs} 条记录 / ${movedImgs} 张图片`);
    }
}

export function beginRestore(): void {
    restoring = true;
}

export function endRestore(): void {
    restoring = false;
}

export async function getCacheDbBytes(): Promise<number | undefined> {
    try {
        const st = await fsasync.stat(CACHE_DB_PATH);
        let total = st.size;
        try {
            const walSt = await fsasync.stat(`${CACHE_DB_PATH}-wal`);
            total += walSt.size;
        } catch {
            // no wal
        }
        return total;
    } catch {
        return undefined;
    }
}

export async function snapshotCacheTo(destPath: string): Promise<void> {
    const conn = await ensureReady();
    await fsasync.rm(destPath, { force: true }).catch(() => {});
    await backup(conn, destPath);
}

/** 安全回滚：先关闭当前 SQLite 句柄并清理 WAL/SHM，再覆盖主库文件并重连 */
export async function restoreCacheFromSnapshot(snapshotPath: string): Promise<void> {
    closeDbHandle();
    await fsasync.rm(`${CACHE_DB_PATH}-wal`, { force: true }).catch(() => {});
    await fsasync.rm(`${CACHE_DB_PATH}-shm`, { force: true }).catch(() => {});
    await fsasync.copyFile(snapshotPath, CACHE_DB_PATH);
    await reloadFromDisk();
}

export async function cacheBackup(): Promise<void> {
    const dest = CACHE_DB_PATH.replace(/\.sqlite$/, `${dayjs().format('-YYYYMMDD')}.sqlite`);
    await snapshotCacheTo(dest);
}

export async function exportAllCacheDocs(): Promise<SearchCache[]> {
    const conn = await ensureReady();
    const rows = conn.prepare(`
        SELECT serial, rel_path_lower, mode, rel_path, v, count, create_at, dir_mtime, data_zstd
        FROM cache_entries
    `).all() as unknown as CacheBlobRow[];

    return rows.map(rowToSearchCache);
}

export async function replaceAllCacheDocs(docs: SearchCache[]): Promise<void> {
    const conn = await ensureReady();
    const insertStmt = conn.prepare(`
        INSERT OR REPLACE INTO cache_entries
        (serial, rel_path_lower, mode, rel_path, v, count, bytes, create_at, dir_mtime, data_zstd)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    conn.exec('BEGIN IMMEDIATE');
    try {
        conn.exec('DELETE FROM cache_entries');
        for (const doc of docs) {
            const relPath = doc.relPath || '';
            const items = Array.isArray(doc.data) ? doc.data : [];
            const bytes = computeBytes(items);
            const blob = encodeCacheData(relPath, items);
            insertStmt.run(
                doc.serial,
                relPath.toLowerCase(),
                doc.mode,
                relPath,
                doc.v ?? CACHE_VERSION,
                doc.count ?? items.length,
                bytes,
                doc.create_at || '',
                doc.dirMtime ?? null,
                blob,
            );
        }
        conn.exec('COMMIT');
    } catch (err) {
        conn.exec('ROLLBACK');
        throw err;
    }
}

export async function exportSnapshotPlain(): Promise<string> {
    const docs = await exportAllCacheDocs();
    const lines = docs.map((doc) => JSON.stringify(doc));
    lines.push(JSON.stringify({ $$indexCreated: { fieldName: 'serial', unique: false, sparse: false } }));
    return lines.join('\n') + '\n';
}

export async function exportCompactSnapshot(dest: string): Promise<void> {
    await snapshotCacheTo(dest);
}

/**
 * 读一份外部缓存库（支持新的 `.sqlite` 与旧版 NeDB 密文/明文文件），用于备份合并。
 */
export async function readExternalCache(file: string): Promise<SearchCache[]> {
    const dir = await fsasync.mkdtemp(path.join(os.tmpdir(), 'ff-merge-'));
    const copy = path.join(dir, 'source.db');
    try {
        await fsasync.copyFile(file, copy);

        // 先探测 SQLite 文件头（"SQLite format 3\0"）
        const fh = await fsasync.open(copy, 'r');
        const header = Buffer.alloc(16);
        try {
            await fh.read(header, 0, 16, 0);
        } finally {
            await fh.close();
        }

        if (header.toString('ascii', 0, 15) === 'SQLite format 3') {
            const extDb = new DatabaseSync(copy, { readOnly: true });
            try {
                const rows = extDb.prepare(`
                    SELECT serial, rel_path_lower, mode, rel_path, v, count, create_at, dir_mtime, data_zstd
                    FROM cache_entries
                `).all() as unknown as CacheBlobRow[];
                return rows.map(rowToSearchCache);
            } finally {
                extDb.close();
            }
        }

        return await parseNedbLines(copy);
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`这个文件读不出来或不是一份可用的缓存库（${msg}）`);
    } finally {
        await fsasync.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
}

export async function findCache(serial: string, relPath: string, mode: OpenMode): Promise<SearchCache | null> {
    const conn = await ensureReady();
    const row = conn.prepare(`
        SELECT serial, rel_path_lower, mode, rel_path, v, count, create_at, dir_mtime, data_zstd
        FROM cache_entries
        WHERE serial = ? AND rel_path_lower = ? AND mode = ?
    `).get(serial, (relPath || '').toLowerCase(), mode) as {
        serial: string;
        rel_path_lower: string;
        mode: OpenMode;
        rel_path: string;
        v: number;
        count: number;
        create_at: string;
        dir_mtime: number | null;
        data_zstd: Uint8Array;
    } | undefined;

    if (!row || row.v !== CACHE_VERSION) return null;

    return {
        _id: synthId(row.serial, row.rel_path_lower, row.mode),
        v: row.v,
        serial: row.serial,
        relPath: row.rel_path,
        mode: row.mode,
        count: row.count,
        data: decodeRowData(row.rel_path, row.data_zstd),
        create_at: row.create_at,
        ...(row.dir_mtime !== null ? { dirMtime: row.dir_mtime } : {}),
    };
}

export async function insertCache(doc: SearchCache): Promise<void> {
    const conn = await ensureReady();
    const relPath = doc.relPath || '';
    const items = Array.isArray(doc.data) ? doc.data : [];
    const bytes = computeBytes(items);
    const blob = encodeCacheData(relPath, items);

    conn.prepare(`
        INSERT OR REPLACE INTO cache_entries
        (serial, rel_path_lower, mode, rel_path, v, count, bytes, create_at, dir_mtime, data_zstd)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        doc.serial,
        relPath.toLowerCase(),
        doc.mode,
        relPath,
        doc.v ?? CACHE_VERSION,
        doc.count ?? items.length,
        bytes,
        doc.create_at || '',
        doc.dirMtime ?? null,
        blob,
    );
}

export async function removeCache(serial: string, relPath: string, mode: OpenMode): Promise<number> {
    const conn = await ensureReady();
    const res = conn.prepare(`
        DELETE FROM cache_entries
        WHERE serial = ? AND rel_path_lower = ? AND mode = ?
    `).run(serial, (relPath || '').toLowerCase(), mode);
    return Number(res.changes ?? 0);
}

export interface MetaQuery {
    withBytes?: boolean;
    sortBy?: 'path' | 'count' | 'bytes' | 'create_at';
    dir?: 1 | -1;
}

function sortMeta<T extends CacheMeta & { bytes?: number }>(rows: T[], q: MetaQuery): T[] {
    const key = q.sortBy ?? 'create_at';
    const dir = q.dir ?? (key === 'path' ? 1 : -1);
    const cmp = (a: T, b: T) => {
        if (key === 'path') {
            return a.serial === b.serial
                ? a.relPath.localeCompare(b.relPath, 'zh')
                : a.serial.localeCompare(b.serial);
        }
        if (key === 'count') return (a.count || 0) - (b.count || 0);
        if (key === 'bytes') return (a.bytes || 0) - (b.bytes || 0);
        return (a.create_at || '').localeCompare(b.create_at || '');
    };
    return rows.sort((a, b) => cmp(a, b) * dir);
}

/**
 * 只取元数据（直接读取预计算的 `bytes` 与 `count`，零 Zstd 解压）。
 */
export async function loadMeta(q: MetaQuery = {}): Promise<(CacheMeta & { bytes?: number })[]> {
    const conn = await ensureReady();
    const rows = conn.prepare(`
        SELECT serial, rel_path_lower, mode, rel_path, v, count, bytes, create_at, dir_mtime
        FROM cache_entries
    `).all() as Array<{
        serial: string;
        rel_path_lower: string;
        mode: OpenMode;
        rel_path: string;
        v: number;
        count: number;
        bytes: number;
        create_at: string;
        dir_mtime: number | null;
    }>;

    const mapped = rows.map((row) => ({
        _id: synthId(row.serial, row.rel_path_lower, row.mode),
        v: row.v,
        serial: row.serial,
        relPath: row.rel_path,
        mode: row.mode,
        count: row.count,
        create_at: row.create_at,
        ...(row.dir_mtime !== null ? { dirMtime: row.dir_mtime } : {}),
        ...(q.withBytes ? { bytes: row.bytes || 0 } : {}),
    })) as (CacheMeta & { bytes?: number })[];

    return sortMeta(mapped, q);
}

export async function loadSubtreeBytes(serial: string, baseRel: string): Promise<Map<string, number>> {
    if (!serial) return new Map();
    return mergeSubtreeBytes(await loadMeta({ withBytes: true }), serial, baseRel);
}

/**
 * 归并算法本体。纯函数 —— 不碰库、不碰盘、不碰文件系统。
 */
export function mergeSubtreeBytes(
    rows: (CacheMeta & { bytes?: number })[],
    serial: string,
    baseRel: string,
): Map<string, number> {
    const out = new Map<string, number>();
    if (!serial) return out;

    const prefix = baseRel ? baseRel + '/' : '';
    for (const m of rows) {
        if (m.serial !== serial) continue;
        if (baseRel && m.relPath === baseRel) continue;
        if (prefix && !m.relPath.startsWith(prefix)) continue;
        const rest = baseRel ? m.relPath.slice(prefix.length) : m.relPath;
        if (!rest) continue;
        const cut = rest.indexOf('/');
        const child = cut === -1 ? rest : rest.slice(0, cut);
        out.set(child, (out.get(child) || 0) + (m.bytes || 0));
    }
    return out;
}

/**
 * 纯函数：从一组缓存记录中归并提取指定子树内的全部叶子条目（非目录项）。
 */
export function mergeSubtreeLeafItems(
    rows: SearchCache[],
    serial: string,
    baseRel: string,
): FileInfo[] {
    if (!serial) return [];
    const baseLower = (baseRel || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    const prefix = baseLower ? `${baseLower}/` : '';
    const seen = new Set<string>();
    const leaves: FileInfo[] = [];

    const docByPath = new Map<string, FileInfo[]>();
    for (const doc of rows) {
        if (doc.serial === serial && Array.isArray(doc.data)) {
            const rel = (doc.relPath || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
            docByPath.set(rel, doc.data);
        }
    }

    const visitedDirs = new Set<string>();

    function collect(relLower: string) {
        if (visitedDirs.has(relLower)) return;
        visitedDirs.add(relLower);
        const items = docByPath.get(relLower);
        if (!items) return;

        for (const it of items) {
            if (it.type === 'folder' || it.isDirectory) {
                const childRel = it.dir ? `${it.dir}/${it.name}` : it.name;
                const childLower = childRel.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
                collect(childLower);
            } else {
                const diskName = it.ext ? `${it.name}.${it.ext}` : it.name;
                const key = `${it.dir || ''}/${diskName}`.toLowerCase();
                if (!seen.has(key)) {
                    seen.add(key);
                    leaves.push(it);
                }
            }
        }
    }

    collect(baseLower);

    for (const doc of rows) {
        if (doc.serial !== serial) continue;
        const curLower = (doc.relPath || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
        const isChild = prefix ? curLower.startsWith(prefix) : true;
        if (isChild && !visitedDirs.has(curLower)) {
            collect(curLower);
        }
    }

    return leaves;
}

export async function findSubtreeLeafItems(
    serial: string,
    baseRel: string,
    mode: OpenMode = 'cover',
): Promise<FileInfo[]> {
    if (!serial) return [];
    const conn = await ensureReady();
    const rawRows = conn.prepare(`
        SELECT serial, rel_path_lower, mode, rel_path, v, count, create_at, dir_mtime, data_zstd
        FROM cache_entries
        WHERE serial = ? AND mode = ?
    `).all(serial, mode) as unknown as CacheBlobRow[];

    return mergeSubtreeLeafItems(rawRows.map(rowToSearchCache), serial, baseRel);
}

export async function compact(): Promise<void> {
    const conn = await ensureReady();
    conn.exec('PRAGMA incremental_vacuum; PRAGMA wal_checkpoint(TRUNCATE);');
}

export interface TunnelCoverItem {
    id: string;
    name: string;
    dir: string;
    relPath: string;
    key: string;
    serial: string;
    sig: string;
    type: string;
    ext?: string;
    size?: number;
    files?: FileInfo['files'];
}

const GENERIC_COVER_NAMES = new Set([
    'cover', 'folder', 'front', 'avatar', 'thumb', 'thumbnail',
    'poster', 'default', 'preview', 'fanart', 'back', 'cd', 'disc',
]);

export function workKeyOf(it: { name?: string; dir?: string }): string {
    const raw = (it.name || '').trim();
    const base = raw.replace(/\.[^./\\]+$/, '').trim().toLowerCase();
    if (base && !GENERIC_COVER_NAMES.has(base)) {
        return base;
    }
    const dir = (it.dir || '').replace(/\\/g, '/').replace(/\/+$/, '');
    const parts = dir.split('/').filter(Boolean);
    const leaf = parts.length > 0 ? parts[parts.length - 1] : '';
    return leaf ? leaf.replace(/\.[^./\\]+$/, '').trim().toLowerCase() : base || 'untitled';
}

export function collectTunnelCovers(
    rows: Iterable<SearchCache>,
    hasBinFn: (name: string) => boolean,
    serial?: string,
): TunnelCoverItem[] {
    const seenSig = new Set<string>();
    const seenWork = new Set<string>();
    const seenPath = new Set<string>();
    const items: TunnelCoverItem[] = [];

    for (const doc of rows) {
        if (serial && doc.serial !== serial) continue;
        if (!Array.isArray(doc.data)) continue;

        for (const it of doc.data) {
            if (!it.sig || it.isDirectory || it.type === 'folder') continue;
            const thumbName = thumbNameOf(it.sig);
            if (!thumbName || !hasBinFn(thumbName)) continue;

            if (seenSig.has(it.sig)) continue;

            const wk = workKeyOf(it);
            if (wk && seenWork.has(wk)) continue;

            const pathKey = `${doc.serial}:${it.dir || ''}/${it.name}`.toLowerCase();
            if (seenPath.has(pathKey)) continue;

            seenSig.add(it.sig);
            if (wk) seenWork.add(wk);
            seenPath.add(pathKey);

            items.push({
                id: `${doc.serial}:${it.dir || ''}/${it.name}`,
                name: it.name,
                dir: it.dir || '',
                relPath: doc.relPath || '',
                key: `${it.dir || ''}/${it.name}`,
                serial: doc.serial,
                sig: it.sig,
                type: it.type,
                ext: it.ext,
                size: it.size,
                files: it.files,
            });
        }
    }

    return items;
}

export async function findAllCachedCovers(serial?: string): Promise<TunnelCoverItem[]> {
    const conn = await ensureReady();
    const sql = serial
        ? `SELECT serial, rel_path_lower, mode, rel_path, v, count, create_at, dir_mtime, data_zstd FROM cache_entries WHERE serial = ?`
        : `SELECT serial, rel_path_lower, mode, rel_path, v, count, create_at, dir_mtime, data_zstd FROM cache_entries`;
    const stmt = conn.prepare(sql);
    const iter = (serial ? stmt.iterate(serial) : stmt.iterate()) as IterableIterator<CacheBlobRow>;

    function* streamDocs(): Generator<SearchCache> {
        for (const row of iter) {
            yield rowToSearchCache(row);
        }
    }

    return collectTunnelCovers(streamDocs(), (name) => hasBin(name), serial);
}

/**
 * 收集当前缓存库中所有引用的缩略图/预览图 `sig` 集合，用于孤儿清理等场景的安全检查。
 */
export async function collectReferencedSigsFromCache(): Promise<{ ok: boolean; count: number; sigs: Set<string> }> {
    const sigs = new Set<string>();
    try {
        const conn = await ensureReady();
        const iter = conn.prepare('SELECT rel_path, data_zstd FROM cache_entries').iterate() as IterableIterator<{
            rel_path: string;
            data_zstd: Uint8Array;
        }>;
        let count = 0;
        for (const row of iter) {
            count++;
            const items = decodeRowData(row.rel_path, row.data_zstd);
            for (const it of items) {
                if (it.sig) sigs.add(it.sig);
            }
        }
        return { ok: true, count, sigs };
    } catch {
        return { ok: false, count: 0, sigs };
    }
}

export interface GlobalSearchHit {
    serial: string;
    docRelPath: string;
    item: FileInfo;
}

export interface GlobalSearchResult {
    hits: GlobalSearchHit[];
    total: number;
    truncated: boolean;
}

export type GlobalSearchSort = 'relevance' | 'name' | 'disk' | 'size';
export type SortOrder = 'asc' | 'desc';

const searchCollator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });

/**
 * 跨盘全局搜索：遍历所有 `mode = 'cover'` 缓存条目，按关键词匹配条目名或内部文件名。
 * 支持按综合相关度、名称、盘符、大小排序，排序后再截取前 `limit` 条。
 */
export async function searchAllCachedItems(
    keyword: string,
    limit = 200,
    driveMap?: Map<string, string>,
    sort: GlobalSearchSort = 'relevance',
    order: SortOrder = 'asc',
): Promise<GlobalSearchResult> {
    const kw = keyword.trim().toLowerCase();
    if (!kw || limit <= 0) {
        return { hits: [], total: 0, truncated: false };
    }
    const conn = await ensureReady();
    const iter = conn.prepare(`
        SELECT serial, rel_path, data_zstd
        FROM cache_entries
        WHERE mode = 'cover'
    `).iterate() as IterableIterator<{
        serial: string;
        rel_path: string;
        data_zstd: Uint8Array;
    }>;

    const seen = new Set<string>();
    const matches: Array<GlobalSearchHit & { onlineRank: number; matchRank: number; diskKey: string }> = [];

    for (const row of iter) {
        const drive = driveMap?.get(row.serial.toUpperCase());
        const onlineRank = drive ? 0 : 1;
        const diskKey = drive || row.serial;
        const items = decodeRowData(row.rel_path, row.data_zstd);
        for (const item of items) {
            const nameLower = (item.name || '').toLowerCase();
            let matchRank = -1;
            if (nameLower === kw) {
                matchRank = 0;
            } else if (nameLower.startsWith(kw)) {
                matchRank = 1;
            } else if (nameLower.includes(kw)) {
                matchRank = 2;
            } else if (Array.isArray(item.files) && item.files.some(f => (f.name || '').toLowerCase().includes(kw))) {
                matchRank = 3;
            }
            if (matchRank < 0) continue;

            const dedupKey = `${row.serial}\0${(item.dir || '').toLowerCase()}\0${nameLower}\0${item.type}`;
            if (seen.has(dedupKey)) continue;
            seen.add(dedupKey);

            matches.push({
                serial: row.serial,
                docRelPath: row.rel_path || '',
                item,
                onlineRank,
                matchRank,
                diskKey,
            });
        }
    }

    const dir = order === 'desc' ? -1 : 1;
    matches.sort((a, b) => {
        if (sort === 'name') {
            return (
                dir * searchCollator.compare(a.item.name || '', b.item.name || '')
                || a.onlineRank - b.onlineRank
                || a.diskKey.localeCompare(b.diskKey)
            );
        }
        if (sort === 'disk') {
            return (
                dir * (a.onlineRank - b.onlineRank)
                || dir * a.diskKey.localeCompare(b.diskKey)
                || searchCollator.compare(a.item.name || '', b.item.name || '')
            );
        }
        if (sort === 'size') {
            return (
                dir * ((a.item.size || 0) - (b.item.size || 0))
                || searchCollator.compare(a.item.name || '', b.item.name || '')
            );
        }
        return (
            a.onlineRank - b.onlineRank
            || a.matchRank - b.matchRank
            || searchCollator.compare(a.item.name || '', b.item.name || '')
            || a.diskKey.localeCompare(b.diskKey)
        );
    });

    const total = matches.length;
    const truncated = total > limit;
    const hits: GlobalSearchHit[] = matches.slice(0, limit).map(({ serial, docRelPath, item }) => ({
        serial,
        docRelPath,
        item,
    }));

    return { hits, total, truncated };
}

function splitDiskName(diskName: string): { name: string; ext: string } {
    const i = diskName.lastIndexOf('.');
    return i === -1 ? { name: diskName, ext: '' } : { name: diskName.substring(0, i), ext: diskName.substring(i + 1) };
}

function joinDiskName(item: { name: string; ext?: string }): string {
    return item.ext ? `${item.name}.${item.ext}` : item.name;
}

function rewriteRelPrefix(dir: string, oldPrefix: string, newPrefix: string): { changed: boolean; dir: string } {
    const dirLower = dir.toLowerCase();
    const oldLower = oldPrefix.toLowerCase();
    if (dirLower === oldLower) return { changed: true, dir: newPrefix };
    if (dirLower.startsWith(`${oldLower}/`)) {
        return { changed: true, dir: `${newPrefix}${dir.slice(oldPrefix.length)}` };
    }
    return { changed: false, dir };
}

/**
 * 磁盘重命名后同步更新 SQLite `cache_entries`：
 * 1) 更新父目录缓存中对应条目的 name/ext（及 cover 模式收敛卡的 dir/files）；
 * 2) 若重命名对象是文件夹，同步迁移该文件夹及其所有子目录的缓存键与内部 dir。
 */
export async function renameCacheEntries(params: {
    serial: string;
    parentRelPath: string;
    oldDiskName: string;
    newDiskName: string;
    isDirectory: boolean;
    parentDirMtime?: number;
    /** 目录内部同步改名的文件映射（key 为小写旧文件名，value 为新文件名） */
    innerRenames?: Map<string, string>;
}): Promise<void> {
    const { serial, parentRelPath, oldDiskName, newDiskName, isDirectory, parentDirMtime, innerRenames } = params;
    if (!serial) return;
    const conn = await ensureReady();

    const parentLower = (parentRelPath || '').toLowerCase();
    const oldLower = oldDiskName.toLowerCase();
    const { name: newName, ext: newExt } = splitDiskName(newDiskName);
    const oldChildRel = parentRelPath ? `${parentRelPath}/${oldDiskName}` : oldDiskName;
    const newChildRel = parentRelPath ? `${parentRelPath}/${newDiskName}` : newDiskName;
    const oldChildLower = oldChildRel.toLowerCase();

    conn.exec('BEGIN IMMEDIATE');
    try {
        const parentRows = conn.prepare(`
            SELECT serial, rel_path_lower, mode, rel_path, v, count, create_at, dir_mtime, data_zstd
            FROM cache_entries
            WHERE serial = ? AND rel_path_lower = ?
        `).all(serial, parentLower) as unknown as CacheBlobRow[];

        const updateParentStmt = conn.prepare(`
            UPDATE cache_entries
            SET data_zstd = ?, dir_mtime = COALESCE(?, dir_mtime)
            WHERE serial = ? AND rel_path_lower = ? AND mode = ?
        `);

        for (const row of parentRows) {
            const items = decodeRowData(row.rel_path, row.data_zstd);
            let modified = false;

            for (const it of items) {
                if (it.dir.toLowerCase() === parentLower && joinDiskName(it).toLowerCase() === oldLower) {
                    it.name = newName;
                    it.ext = newExt;
                    modified = true;
                }
                if (isDirectory) {
                    const rw = rewriteRelPrefix(it.dir, oldChildRel, newChildRel);
                    if (rw.changed) {
                        it.dir = rw.dir;
                        modified = true;
                    }
                    // 合体文件卡片（dir === oldChildRel）内部同步改名时，同步更新封面名与 files 清单
                    if (innerRenames && innerRenames.size > 0 && it.dir.toLowerCase() === newChildRel.toLowerCase()) {
                        const coverOld = joinDiskName(it).toLowerCase();
                        const coverNew = innerRenames.get(coverOld);
                        if (coverNew) {
                            const sp = splitDiskName(coverNew);
                            it.name = sp.name;
                            it.ext = sp.ext;
                            modified = true;
                        }
                        if (Array.isArray(it.files)) {
                            for (const f of it.files) {
                                const fNew = innerRenames.get(f.name.toLowerCase());
                                if (fNew) {
                                    f.name = fNew;
                                    modified = true;
                                }
                            }
                        }
                    }
                } else if (Array.isArray(it.files) && it.dir.toLowerCase() === parentLower) {
                    for (const f of it.files) {
                        if (f.name.toLowerCase() === oldLower) {
                            f.name = newDiskName;
                            modified = true;
                        }
                    }
                }
            }

            if (modified) {
                const nextBlob = encodeCacheData(row.rel_path, items);
                updateParentStmt.run(
                    nextBlob,
                    parentDirMtime ?? null,
                    row.serial,
                    row.rel_path_lower,
                    row.mode,
                );
            }
        }

        if (isDirectory) {
            const allRows = conn.prepare(`
                SELECT serial, rel_path_lower, mode, rel_path, v, count, bytes, create_at, dir_mtime, data_zstd
                FROM cache_entries
                WHERE serial = ?
            `).all(serial) as unknown as (CacheBlobRow & { bytes: number })[];

            const deleteStmt = conn.prepare(`
                DELETE FROM cache_entries
                WHERE serial = ? AND rel_path_lower = ? AND mode = ?
            `);
            const insertStmt = conn.prepare(`
                INSERT OR REPLACE INTO cache_entries
                (serial, rel_path_lower, mode, rel_path, v, count, bytes, create_at, dir_mtime, data_zstd)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);

            for (const row of allRows) {
                if (row.rel_path_lower !== oldChildLower && !row.rel_path_lower.startsWith(`${oldChildLower}/`)) {
                    continue;
                }
                const nextRelPath = `${newChildRel}${row.rel_path.slice(oldChildRel.length)}`;
                const nextRelLower = nextRelPath.toLowerCase();
                const items = decodeRowData(row.rel_path, row.data_zstd);
                for (const it of items) {
                    const rw = rewriteRelPrefix(it.dir, oldChildRel, newChildRel);
                    if (rw.changed) it.dir = rw.dir;
                    if (innerRenames && innerRenames.size > 0 && row.rel_path_lower === oldChildLower
                        && it.dir.toLowerCase() === newChildRel.toLowerCase()) {
                        const fNew = innerRenames.get(joinDiskName(it).toLowerCase());
                        if (fNew) {
                            const sp = splitDiskName(fNew);
                            it.name = sp.name;
                            it.ext = sp.ext;
                        }
                    }
                }
                const nextBlob = encodeCacheData(nextRelPath, items);
                deleteStmt.run(row.serial, row.rel_path_lower, row.mode);
                insertStmt.run(
                    row.serial,
                    nextRelLower,
                    row.mode,
                    nextRelPath,
                    row.v,
                    row.count,
                    row.bytes,
                    row.create_at,
                    row.dir_mtime,
                    nextBlob,
                );
            }
        }

        conn.exec('COMMIT');
    } catch (e) {
        conn.exec('ROLLBACK');
        throw e;
    }
}

export default {
    initCacheDb,
    reloadFromDisk,
    findCache,
    insertCache,
    removeCache,
    loadMeta,
    loadSubtreeBytes,
    findSubtreeLeafItems,
    findAllCachedCovers,
    searchAllCachedItems,
    exportAllCacheDocs,
    replaceAllCacheDocs,
    snapshotCacheTo,
    getCacheDbBytes,
    collectReferencedSigsFromCache,
};
