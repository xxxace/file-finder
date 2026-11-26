import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import esbuild from 'esbuild';
import { pathToFileURL } from 'node:url';

process.env.NODE_ENV = 'test';

const tmpBuildDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ff-cleanup-test-build-'));
const entryTs = path.join(tmpBuildDir, 'entry.ts');
const bundleOut = path.join(tmpBuildDir, 'bundle.mjs');

await fs.writeFile(
    entryTs,
    `
export * from ${JSON.stringify(path.resolve('electron/server/storageCleanup.ts'))};
export { initCacheDb, insertCache, closeCacheDbForTest } from ${JSON.stringify(path.resolve('electron/server/nedb.ts'))};
export { initBinStore, putBin, hasBin, closeBinStoreForTest } from ${JSON.stringify(path.resolve('electron/utils/binStore.ts'))};
`,
    'utf8',
);

esbuild.buildSync({
    entryPoints: [entryTs],
    bundle: true,
    platform: 'node',
    format: 'esm',
    external: ['node:*', 'electron', 'sharp'],
    outfile: bundleOut,
});

const mod = await import(pathToFileURL(bundleOut).href);

const {
    inventoryRedundantStorage,
    readCleanupAsset,
    purgeRedundantStorage,
    initCacheDb,
    insertCache,
    closeCacheDbForTest,
    initBinStore,
    putBin,
    hasBin,
    closeBinStoreForTest,
} = mod;

function makeSig(label) {
    return crypto.createHash('sha1').update(label).digest('hex');
}

const FAKE_WEBP = Buffer.concat([Buffer.from('RIFF\x10\x00\x00\x00WEBPVP8 '), crypto.randomBytes(2048)]);
const FAKE_JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(2048)]);

test('1. 安全闸门：cache.sqlite 为空时拒绝将 bin.sqlite 判为孤儿', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ff-cleanup-empty-'));
    try {
        await initCacheDb(dir);
        await initBinStore(dir);
        const sig = makeSig('empty-db-img');
        await putBin(`t-${sig}.enc`, FAKE_WEBP);

        const inv = await inventoryRedundantStorage(dir, { nowMs: Date.now() + 2 * 3600_000 });
        assert.equal(inv.orphanBins.length, 0);
        assert.ok(inv.blockedReason && inv.blockedReason.length > 0);
        assert.equal(inv.binTotal.count, 1);
    } finally {
        await closeBinStoreForTest();
        await closeCacheDbForTest();
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test('2. 孤儿盘点与 1 小时写入保护窗：仅清理超过保护窗且无引用的图片', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ff-cleanup-orphan-'));
    try {
        await initCacheDb(dir);
        await initBinStore(dir);

        const liveSig = makeSig('live');
        const plSig = makeSig('playlist-only');
        const oldOrphanSig = makeSig('old-orphan');
        const freshOrphanSig = makeSig('fresh-orphan');

        await insertCache({
            v: 3,
            serial: 'AABB1122',
            relPath: 'movies',
            mode: 'cover',
            count: 1,
            create_at: '2026-11-26 10:00:00',
            data: [{ dir: 'movies', name: 'A', isDirectory: false, type: 'image', size: 100, sig: liveSig }],
        });
        await fs.writeFile(
            path.join(dir, 'playlists.json'),
            JSON.stringify([{ id: 'pl_1', name: 'fav', createdAt: 1, items: [{ id: 'i1', serial: 'AABB1122', relPath: 'x', name: 'B', type: 'image', size: 100, sig: plSig, addedAt: 1 }] }]),
            'utf8',
        );

        await putBin(`t-${liveSig}.enc`, FAKE_WEBP);
        await putBin(`t-${plSig}.enc`, FAKE_WEBP);
        await putBin(`t-${oldOrphanSig}.enc`, FAKE_WEBP);
        await putBin(`p-${oldOrphanSig}.enc`, FAKE_JPEG);

        // 模拟 2 小时后写入 freshOrphan，在 nowMs = +2h+10m 时 freshOrphan 仍在 1h 保护窗内，而 oldOrphan 已超 1h
        const tAfter2h = Date.now() + 2 * 3600_000;
        const invBeforeFresh = await inventoryRedundantStorage(dir, { nowMs: tAfter2h });
        assert.equal(invBeforeFresh.blockedReason, undefined);
        const orphanNames = invBeforeFresh.orphanBins.map((b) => b.name).sort();
        assert.deepEqual(orphanNames, [`p-${oldOrphanSig}.enc`, `t-${oldOrphanSig}.enc`]);

        // 新写入一张图并立即用当前时间检查：应受 1h 保护窗保护
        await putBin(`t-${freshOrphanSig}.enc`, FAKE_WEBP);
        const invNow = await inventoryRedundantStorage(dir);
        assert.equal(invNow.orphanBins.length, 0);

        // 读取孤儿资源预览
        const asset = await readCleanupAsset(dir, 'bin', `t-${oldOrphanSig}.enc`);
        assert.ok(asset);
        assert.equal(asset.contentType, 'image/webp');
        assert.deepEqual(asset.buf, FAKE_WEBP);

        // 清理孤儿（同时传入 liveSig 试图越权删除，服务端必须忽略 liveSig 只删确认孤儿）
        const purgeRes = await purgeRedundantStorage(
            dir,
            { orphanBins: [`t-${oldOrphanSig}.enc`, `p-${oldOrphanSig}.enc`, `t-${liveSig}.enc`] },
            { nowMs: tAfter2h },
        );
        assert.equal(purgeRes.removed, 2);
        assert.ok(purgeRes.freed > 0);
        assert.equal(hasBin(`t-${oldOrphanSig}.enc`), false);
        assert.equal(hasBin(`p-${oldOrphanSig}.enc`), false);
        assert.equal(hasBin(`t-${liveSig}.enc`), true);
    } finally {
        await closeBinStoreForTest();
        await closeCacheDbForTest();
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test('3. 旧封面备份、残留文件盘点与路径穿越防护', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ff-cleanup-backups-'));
    try {
        await initCacheDb(dir);
        await initBinStore(dir);

        const covBackupDir = path.join(dir, 'assistant', 'cover-backup', 'SER1');
        const avatarBackupDir = path.join(dir, 'backups', 'SER1', 'ActorA');
        await fs.mkdir(covBackupDir, { recursive: true });
        await fs.mkdir(avatarBackupDir, { recursive: true });

        const covFile = path.join(covBackupDir, '2026-11-26__abc__cover.jpg');
        const avFile = path.join(avatarBackupDir, 'avatar.jpg');
        await fs.writeFile(covFile, FAKE_JPEG);
        await fs.writeFile(avFile, FAKE_JPEG);

        const leftover1 = path.join(dir, 'searchCache.db.migrated.bak');
        const leftover2 = path.join(dir, 'cache-before-restore.sqlite');
        await fs.writeFile(leftover1, Buffer.alloc(1024, 1));
        await fs.writeFile(leftover2, Buffer.alloc(2048, 2));

        const inv = await inventoryRedundantStorage(dir);
        assert.equal(inv.coverBackups.length, 2);
        assert.equal(inv.leftovers.length, 2);

        // 路径穿越攻击必须被拒绝
        const evilAsset = await readCleanupAsset(dir, 'backup', '../../package.json');
        assert.equal(evilAsset, null);

        // 合法备份图预览
        const validBackup = inv.coverBackups[0];
        const loaded = await readCleanupAsset(dir, 'backup', validBackup.key);
        assert.ok(loaded);
        assert.equal(loaded.contentType, 'image/jpeg');

        // 清理备份与残留（夹带非法路径必须被忽略）
        const res = await purgeRedundantStorage(dir, {
            coverBackups: [validBackup.key, '../evil.jpg'],
            leftovers: ['searchCache.db.migrated.bak', '../package.json'],
        });
        assert.equal(res.removed, 2);

        const invAfter = await inventoryRedundantStorage(dir);
        assert.equal(invAfter.coverBackups.length, 1);
        assert.equal(invAfter.leftovers.length, 1);
    } finally {
        await closeBinStoreForTest();
        await closeCacheDbForTest();
        await fs.rm(dir, { recursive: true, force: true });
    }
});
