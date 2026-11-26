import * as fsasync from 'node:fs/promises';
import path from 'node:path';
import { collectReferencedSigsFromCache } from './nedb';
import { binStats, deleteBinsBatch, getBin, listBinStatsRows } from '../utils/binStore';
import type { BinKey } from '../utils/binStore';

const ORPHAN_BIN_GRACE_MS = 60 * 60 * 1000;
const BACKUP_IMAGE_RE = /\.(jpe?g|png|webp|gif|bmp)$/i;
const BIN_KEY_RE = /^([tp])-([0-9a-f]{40})\.enc$/i;

export interface OrphanBinItem {
    kind: 't' | 'p';
    sig: string;
    name: string;
    bytes: number;
    createdAt: number;
    fmt: number;
}

export interface BackupImageItem {
    key: string;
    label: string;
    bytes: number;
    mtime: number;
}

export interface LeftoverFileItem {
    name: string;
    bytes: number;
    mtime: number;
    kind: 'file' | 'dir';
}

export interface RedundantStorageInventory {
    orphanBins: OrphanBinItem[];
    coverBackups: BackupImageItem[];
    leftovers: LeftoverFileItem[];
    binTotal: { count: number; bytes: number };
    blockedReason?: string;
}

async function readPlaylistSigs(dataDir: string): Promise<Set<string>> {
    const sigs = new Set<string>();
    try {
        const raw = await fsasync.readFile(path.join(dataDir, 'playlists.json'), 'utf8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
            for (const pl of parsed) {
                if (!Array.isArray(pl?.items)) continue;
                for (const it of pl.items) {
                    if (typeof it?.sig === 'string' && it.sig) {
                        sigs.add(it.sig.toLowerCase());
                    }
                }
            }
        }
    } catch {
        // playlists.json 不存在或损坏时忽略
    }
    return sigs;
}

async function walkBackupImages(dataDir: string, rootRel: string, out: BackupImageItem[]): Promise<void> {
    const absRoot = path.join(dataDir, rootRel);
    async function walk(curAbs: string, curRel: string) {
        const entries = await fsasync.readdir(curAbs, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
            const nextAbs = path.join(curAbs, entry.name);
            const nextRel = `${curRel}/${entry.name}`;
            if (entry.isDirectory()) {
                await walk(nextAbs, nextRel);
            } else if (entry.isFile() && BACKUP_IMAGE_RE.test(entry.name)) {
                const st = await fsasync.stat(nextAbs).catch(() => null);
                if (!st) continue;
                const parts = nextRel.split('/');
                const label = parts.slice(-2).join('/');
                out.push({
                    key: nextRel,
                    label,
                    bytes: st.size,
                    mtime: Math.round(st.mtimeMs),
                });
            }
        }
    }
    await walk(absRoot, rootRel);
}

async function scanLeftoverFiles(dataDir: string): Promise<LeftoverFileItem[]> {
    const out: LeftoverFileItem[] = [];
    const entries = await fsasync.readdir(dataDir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
        if (entry.isFile()) {
            const isLeftover =
                entry.name === 'searchCache.db.migrated.bak' ||
                entry.name === 'searchCache-before-restore.db' ||
                entry.name === 'cache-before-restore.sqlite' ||
                /^searchCache-\d{8}\.db$/.test(entry.name);
            if (!isLeftover) continue;
            const st = await fsasync.stat(path.join(dataDir, entry.name)).catch(() => null);
            if (st) {
                out.push({
                    name: entry.name,
                    bytes: st.size,
                    mtime: Math.round(st.mtimeMs),
                    kind: 'file',
                });
            }
        } else if (entry.isDirectory() && entry.name === 'bin') {
            const binFiles = await fsasync.readdir(path.join(dataDir, 'bin')).catch(() => null);
            if (binFiles && binFiles.length === 0) {
                const st = await fsasync.stat(path.join(dataDir, 'bin')).catch(() => null);
                out.push({
                    name: 'bin',
                    bytes: 0,
                    mtime: st ? Math.round(st.mtimeMs) : 0,
                    kind: 'dir',
                });
            }
        }
    }
    return out.sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name));
}

function resolveAllowedBackupPath(dataDir: string, key: string): string | null {
    if (!key || typeof key !== 'string' || key.includes('\0')) return null;
    const norm = key.replace(/\\/g, '/').replace(/^\/+/, '');
    if (!norm || norm.includes('..') || path.isAbsolute(norm)) return null;

    const resolved = path.resolve(dataDir, norm);
    const allowedRoots = [
        path.resolve(dataDir, 'assistant', 'cover-backup'),
        path.resolve(dataDir, 'backups'),
    ];
    for (const root of allowedRoots) {
        if (resolved.startsWith(root + path.sep)) {
            return resolved;
        }
    }
    return null;
}

function sniffImageContentType(buf: Buffer): string {
    if (
        buf.length >= 12 &&
        buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
        buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
    ) {
        return 'image/webp';
    }
    if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
        return 'image/png';
    }
    return 'image/jpeg';
}

export async function inventoryRedundantStorage(
    dataDir: string,
    opts?: { nowMs?: number },
): Promise<RedundantStorageInventory> {
    const nowMs = opts?.nowMs ?? Date.now();
    const binTotal = await binStats();
    const orphanBins: OrphanBinItem[] = [];
    let blockedReason: string | undefined;

    const cacheRefs = await collectReferencedSigsFromCache();
    if (!cacheRefs.ok) {
        blockedReason = '缓存库不可用，已暂停孤儿图片盘点以防误删';
    } else if (cacheRefs.count === 0) {
        blockedReason = '缓存库暂无记录，已暂停孤儿图片盘点以防误删';
    } else {
        const plSigs = await readPlaylistSigs(dataDir);
        const referenced = new Set<string>(cacheRefs.sigs);
        for (const s of plSigs) referenced.add(s);

        for (const row of listBinStatsRows()) {
            if (referenced.has(row.sig.toLowerCase())) continue;
            if (nowMs - row.createdAt < ORPHAN_BIN_GRACE_MS) continue;
            orphanBins.push({
                kind: row.kind,
                sig: row.sig,
                name: row.name,
                bytes: row.size,
                createdAt: row.createdAt,
                fmt: row.fmt,
            });
        }
        orphanBins.sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name));
    }

    const coverBackups: BackupImageItem[] = [];
    await walkBackupImages(dataDir, 'assistant/cover-backup', coverBackups);
    await walkBackupImages(dataDir, 'backups', coverBackups);
    coverBackups.sort((a, b) => b.mtime - a.mtime);

    const leftovers = await scanLeftoverFiles(dataDir);

    return {
        orphanBins,
        coverBackups,
        leftovers,
        binTotal,
        ...(blockedReason ? { blockedReason } : {}),
    };
}

export async function readCleanupAsset(
    dataDir: string,
    category: 'bin' | 'backup',
    key: string,
): Promise<{ buf: Buffer; contentType: string } | null> {
    if (category === 'bin') {
        if (!BIN_KEY_RE.test(key)) return null;
        return getBin(key);
    }
    if (category === 'backup') {
        const abs = resolveAllowedBackupPath(dataDir, key);
        if (!abs || !BACKUP_IMAGE_RE.test(abs)) return null;
        try {
            const buf = await fsasync.readFile(abs);
            return { buf, contentType: sniffImageContentType(buf) };
        } catch {
            return null;
        }
    }
    return null;
}

export async function purgeRedundantStorage(
    dataDir: string,
    payload: { orphanBins?: string[]; coverBackups?: string[]; leftovers?: string[] },
    opts?: { nowMs?: number },
): Promise<{ removed: number; freed: number }> {
    const inv = await inventoryRedundantStorage(dataDir, opts);
    let removed = 0;
    let freed = 0;

    if (Array.isArray(payload.orphanBins) && payload.orphanBins.length > 0 && !inv.blockedReason) {
        const validOrphans = new Map(inv.orphanBins.map((o) => [o.name.toLowerCase(), o]));
        const keysToDelete: BinKey[] = [];
        for (const rawName of payload.orphanBins) {
            const hit = validOrphans.get(String(rawName).toLowerCase());
            if (hit) {
                keysToDelete.push({ kind: hit.kind, sig: hit.sig });
                validOrphans.delete(hit.name.toLowerCase());
            }
        }
        if (keysToDelete.length > 0) {
            const res = await deleteBinsBatch(keysToDelete);
            removed += res.removed;
            freed += res.freed;
        }
    }

    if (Array.isArray(payload.coverBackups) && payload.coverBackups.length > 0) {
        const validBackups = new Map(inv.coverBackups.map((b) => [b.key, b]));
        for (const key of payload.coverBackups) {
            const item = validBackups.get(key);
            if (!item) continue;
            validBackups.delete(key);
            const abs = resolveAllowedBackupPath(dataDir, item.key);
            if (!abs) continue;
            try {
                await fsasync.unlink(abs);
                removed += 1;
                freed += item.bytes;
            } catch {
                // 已不存在或被占用
            }
        }
    }

    if (Array.isArray(payload.leftovers) && payload.leftovers.length > 0) {
        const validLeftovers = new Map(inv.leftovers.map((l) => [l.name, l]));
        for (const name of payload.leftovers) {
            const item = validLeftovers.get(name);
            if (!item) continue;
            validLeftovers.delete(name);
            const abs = path.join(dataDir, item.name);
            try {
                if (item.kind === 'dir') {
                    await fsasync.rmdir(abs);
                } else {
                    await fsasync.unlink(abs);
                }
                removed += 1;
                freed += item.bytes;
            } catch {
                // 忽略
            }
        }
    }

    return { removed, freed };
}
