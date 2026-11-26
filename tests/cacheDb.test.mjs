import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

let bundleDir;
let cacheCodec;
let nedb;
let cacheCrypto;

const resolveFromRepo = {
    name: 'resolve-from-repo',
    setup(build) {
        build.onResolve({ filter: /^[^./]/ }, (args) => {
            if (args.kind === 'entry-point') return;
            if (args.path.startsWith('node:')) return { external: true };
            try {
                return { path: import.meta.resolve(args.path), external: true };
            } catch {
                return { external: true };
            }
        });
    },
};

describe('cacheCodec & cache.sqlite storage layer', () => {
    before(async () => {
        process.env.NODE_ENV = 'test';
        bundleDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ff-cachedb-bundle-'));

        const codecOut = path.join(bundleDir, 'cacheCodec.mjs');
        const nedbOut = path.join(bundleDir, 'nedb.mjs');
        const cryptoOut = path.join(bundleDir, 'cacheCrypto.mjs');

        await Promise.all([
            esbuild.build({
                entryPoints: [path.resolve('electron/server/cacheCodec.ts')],
                bundle: true,
                platform: 'node',
                format: 'esm',
                plugins: [resolveFromRepo],
                outfile: codecOut,
            }),
            esbuild.build({
                entryPoints: [path.resolve('electron/server/nedb.ts')],
                bundle: true,
                platform: 'node',
                format: 'esm',
                plugins: [resolveFromRepo],
                outfile: nedbOut,
            }),
            esbuild.build({
                entryPoints: [path.resolve('electron/utils/cacheCrypto.ts')],
                bundle: true,
                platform: 'node',
                format: 'esm',
                plugins: [resolveFromRepo],
                outfile: cryptoOut,
            }),
        ]);

        cacheCodec = await import(pathToFileURL(codecOut).href);
        nedb = await import(pathToFileURL(nedbOut).href);
        cacheCrypto = await import(pathToFileURL(cryptoOut).href);
    });

    after(async () => {
        if (bundleDir) {
            await fs.rm(bundleDir, { recursive: true, force: true }).catch(() => {});
        }
    });

    it('1. encodeCacheData / decodeCacheData roundtrips files, folders, and converged covers with significant compression', () => {
        const relPath = 'Movies/2026';
        const items = [
            {
                dir: 'Movies/2026',
                name: 'SubFolder',
                isDirectory: true,
                type: 'folder',
                size: 0,
            },
            {
                dir: 'Movies/2026',
                name: 'poster',
                ext: 'jpg',
                isDirectory: false,
                type: 'image',
                size: 204800,
                sig: '0123456789abcdef0123456789abcdef01234567',
                srcMtime: 1730000000123.5,
                srcBytes: 204800,
            },
            {
                dir: 'Movies/2026/ABC-123',
                name: 'cover',
                ext: 'jpg',
                isDirectory: false,
                type: 'image',
                size: 1048576000,
                sig: 'fedcba9876543210fedcba9876543210fedcba98',
                srcMtime: 1730000009999,
                srcBytes: 512000,
                files: [
                    { name: 'cover.jpg', size: 512000 },
                    { name: 'ABC-123.mp4', size: 1048064000 },
                ],
            },
        ];
        // Add extra repeated entries so zstd compression ratio is clearly visible
        for (let i = 0; i < 20; i++) {
            items.push({
                dir: 'Movies/2026',
                name: `track-${String(i).padStart(2, '0')}`,
                ext: 'mp4',
                isDirectory: false,
                type: 'video',
                size: 1024 * (i + 1),
                sig: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                srcMtime: 1730000000000 + i,
                srcBytes: 1024 * (i + 1),
            });
        }

        const plainSize = Buffer.byteLength(JSON.stringify(items), 'utf8');
        const blob = cacheCodec.encodeCacheData(relPath, items);
        assert.ok(Buffer.isBuffer(blob), 'encoded output must be a Buffer');
        assert.ok(blob.length < plainSize * 0.6, `expected compressed blob (${blob.length}) < 60% of plain JSON (${plainSize})`);

        const decoded = cacheCodec.decodeCacheData(relPath, blob);
        assert.deepEqual(decoded, items);
    });

    it('2. cache.sqlite CRUD & case-insensitive relPath contract with upsert replacement', async () => {
        const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ff-db-crud-'));
        try {
            await nedb.initCacheDb(dataDir);

            const doc1 = {
                v: nedb.CACHE_VERSION,
                serial: 'AABBCCDD',
                relPath: 'Actors/Julia',
                mode: 'cover',
                count: 1,
                data: [
                    {
                        dir: 'Actors/Julia',
                        name: 'cover',
                        ext: 'jpg',
                        isDirectory: false,
                        type: 'image',
                        size: 12345,
                    },
                ],
                create_at: '2026-11-26 10:00:00',
                dirMtime: 1730000000,
            };

            await nedb.insertCache(doc1);

            const hit = await nedb.findCache('AABBCCDD', 'actors/julia', 'cover');
            assert.ok(hit, 'case-insensitive findCache should hit');
            assert.equal(hit.relPath, 'Actors/Julia');
            assert.equal(hit.data.length, 1);
            assert.equal(hit.data[0].size, 12345);

            // Upsert with same primary key (different casing) should replace without duplicates
            const doc2 = {
                ...doc1,
                relPath: 'Actors/JULIA',
                count: 2,
                data: [
                    ...doc1.data,
                    {
                        dir: 'Actors/JULIA',
                        name: 'movie',
                        ext: 'mp4',
                        isDirectory: false,
                        type: 'video',
                        size: 90000,
                    },
                ],
            };
            await nedb.insertCache(doc2);

            const metaAll = await nedb.loadMeta({});
            assert.equal(metaAll.length, 1, 'duplicate primary key insert must replace existing row');
            assert.equal(metaAll[0].count, 2);

            const removed = await nedb.removeCache('AABBCCDD', 'ACTORS/JULIA', 'cover');
            assert.equal(removed, 1);
            const afterRemove = await nedb.findCache('AABBCCDD', 'Actors/Julia', 'cover');
            assert.equal(afterRemove, null);
        } finally {
            await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
        }
    });

    it('3. loadMeta({ withBytes: true, sortBy: "path", dir: 1 }) returns precomputed bytes, count, synthetic _id without calling decodeCacheData', async () => {
        const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ff-db-meta-'));
        try {
            await nedb.initCacheDb(dataDir);

            await nedb.insertCache({
                v: nedb.CACHE_VERSION,
                serial: '22222222',
                relPath: 'B/Dir',
                mode: 'cover',
                count: 2,
                data: [
                    { dir: 'B/Dir', name: 'a', ext: 'jpg', isDirectory: false, type: 'image', size: 100 },
                    { dir: 'B/Dir', name: 'b', ext: 'mp4', isDirectory: false, type: 'video', size: 250 },
                ],
                create_at: '2026-11-26 10:00:00',
            });
            await nedb.insertCache({
                v: nedb.CACHE_VERSION,
                serial: '11111111',
                relPath: 'A/Dir',
                mode: 'folder',
                count: 1,
                data: [
                    { dir: 'A/Dir', name: 'sub', isDirectory: true, type: 'folder', size: 0 },
                ],
                create_at: '2026-11-26 11:00:00',
            });

            let decodeCalls = 0;
            nedb.setDecodeSpyForTest(() => {
                decodeCalls++;
            });

            const rows = await nedb.loadMeta({ withBytes: true, sortBy: 'path', dir: 1 });
            nedb.setDecodeSpyForTest(null);

            assert.equal(decodeCalls, 0, 'loadMeta must NOT call decodeCacheData');
            assert.equal(rows.length, 2);
            assert.equal(rows[0].serial, '11111111');
            assert.equal(rows[0].bytes, 0);
            assert.equal(rows[0].count, 1);
            assert.equal(rows[0]._id, '11111111\0a/dir\0folder');

            assert.equal(rows[1].serial, '22222222');
            assert.equal(rows[1].bytes, 350);
            assert.equal(rows[1].count, 2);
            assert.equal(rows[1]._id, '22222222\0b/dir\0cover');
        } finally {
            nedb.setDecodeSpyForTest(null);
            await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
        }
    });

    it('4. findSubtreeLeafItems and findAllCachedCovers filter and decode matching entries', async () => {
        const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ff-db-tree-'));
        try {
            await nedb.initCacheDb(dataDir);

            await nedb.insertCache({
                v: nedb.CACHE_VERSION,
                serial: '33333333',
                relPath: 'Root',
                mode: 'cover',
                count: 2,
                data: [
                    { dir: 'Root', name: 'Sub', isDirectory: true, type: 'folder', size: 0 },
                    { dir: 'Root', name: 'root-vid', ext: 'mp4', isDirectory: false, type: 'video', size: 500 },
                ],
                create_at: '2026-11-26 10:00:00',
            });
            await nedb.insertCache({
                v: nedb.CACHE_VERSION,
                serial: '33333333',
                relPath: 'Root/Sub',
                mode: 'cover',
                count: 1,
                data: [
                    { dir: 'Root/Sub', name: 'sub-img', ext: 'jpg', isDirectory: false, type: 'image', size: 300, sig: 'deadbeef' },
                ],
                create_at: '2026-11-26 10:01:00',
            });
            await nedb.insertCache({
                v: nedb.CACHE_VERSION,
                serial: '33333333',
                relPath: 'RootExtra',
                mode: 'cover',
                count: 1,
                data: [
                    { dir: 'RootExtra', name: 'other', ext: 'mp4', isDirectory: false, type: 'video', size: 700 },
                ],
                create_at: '2026-11-26 10:02:00',
            });

            const leaves = await nedb.findSubtreeLeafItems('33333333', 'Root', 'cover');
            assert.deepEqual(leaves.map((x) => x.name), ['sub-img', 'root-vid']);

            const covers = nedb.collectTunnelCovers(
                await nedb.exportAllCacheDocs(),
                (name) => name === 't-deadbeef.enc',
                '33333333',
            );
            assert.equal(covers.length, 1);
            assert.equal(covers[0].name, 'sub-img');
            assert.equal(covers[0].sig, 'deadbeef');
        } finally {
            await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
        }
    });

    it('5. migrates legacy searchCache.db (encrypted, $$deleted, plaintext, v2 thumbData) into cache.sqlite and backs up old file', async () => {
        const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ff-db-migrate-'));
        try {
            const legacyPath = path.join(dataDir, 'searchCache.db');
            const pngBytes = Buffer.from('fake-legacy-thumb-bytes');
            const expectedSig = crypto.createHash('sha1').update(pngBytes).digest('hex');
            const dataUrl = `data:image/jpeg;base64,${pngBytes.toString('base64')}`;

            const encDoc = {
                _id: 'doc-enc',
                v: 3,
                serial: '44444444',
                relPath: 'EncDir',
                mode: 'cover',
                count: 1,
                data: [{ dir: 'EncDir', name: 'a', ext: 'mp4', isDirectory: false, type: 'video', size: 100 }],
                create_at: '2026-11-25 10:00:00',
            };
            const deletedDoc = {
                _id: 'doc-del',
                v: 3,
                serial: '44444444',
                relPath: 'DeletedDir',
                mode: 'cover',
                count: 1,
                data: [{ dir: 'DeletedDir', name: 'gone', ext: 'mp4', isDirectory: false, type: 'video', size: 50 }],
                create_at: '2026-11-25 10:00:00',
            };
            const deletedTombstone = { _id: 'doc-del', $$deleted: true };
            const plainDoc = {
                _id: 'doc-plain',
                v: 3,
                serial: '44444444',
                relPath: 'PlainDir',
                mode: 'folder',
                count: 1,
                data: [{ dir: 'PlainDir', name: 'p', ext: 'jpg', isDirectory: false, type: 'image', size: 200 }],
                create_at: '2026-11-25 10:00:00',
            };
            const v2Doc = {
                _id: 'doc-v2',
                v: 2,
                serial: '55555555',
                relPath: 'LegacyV2',
                mode: 'cover',
                count: 1,
                data: [
                    {
                        dir: 'LegacyV2',
                        name: 'hero',
                        ext: 'jpg',
                        isDirectory: false,
                        type: 'image',
                        size: 300,
                        thumb: 'legacy',
                        thumbData: dataUrl,
                        avatarThumbData: dataUrl,
                    },
                ],
                create_at: '2026-10-01 10:00:00',
            };

            const lines = [
                cacheCrypto.encryptLine(JSON.stringify(encDoc)),
                cacheCrypto.encryptLine(JSON.stringify(deletedDoc)),
                cacheCrypto.encryptLine(JSON.stringify(deletedTombstone)),
                JSON.stringify(plainDoc),
                cacheCrypto.encryptLine(JSON.stringify(v2Doc)),
                JSON.stringify({ $$indexCreated: { fieldName: 'serial', unique: false, sparse: false } }),
            ].join('\n') + '\n';

            await fs.writeFile(legacyPath, lines, 'utf8');

            const writtenBins = [];
            await nedb.initCacheDb(dataDir, {
                putBin: async (name, bytes) => {
                    writtenBins.push({ name, bytes });
                },
            });

            // Active records migrated (3 total, deletedDoc excluded)
            const meta = await nedb.loadMeta({});
            assert.equal(meta.length, 3);
            assert.equal(await nedb.findCache('44444444', 'DeletedDir', 'cover'), null);

            const hitEnc = await nedb.findCache('44444444', 'EncDir', 'cover');
            assert.ok(hitEnc);
            const hitPlain = await nedb.findCache('44444444', 'PlainDir', 'folder');
            assert.ok(hitPlain);

            const hitV2 = await nedb.findCache('55555555', 'LegacyV2', 'cover');
            assert.ok(hitV2);
            assert.equal(hitV2.v, nedb.CACHE_VERSION);
            assert.equal(hitV2.data[0].sig, expectedSig);
            assert.equal('thumbData' in hitV2.data[0], false);
            assert.equal('thumb' in hitV2.data[0], false);
            assert.equal('avatarThumbData' in hitV2.data[0], false);

            assert.equal(writtenBins.length, 1);
            assert.equal(writtenBins[0].name, `t-${expectedSig}.enc`);
            assert.equal(writtenBins[0].bytes.equals(pngBytes), true);

            // Old file renamed to searchCache.db.migrated.bak
            await assert.rejects(() => fs.stat(legacyPath));
            const bakStat = await fs.stat(path.join(dataDir, 'searchCache.db.migrated.bak'));
            assert.ok(bakStat.isFile());
        } finally {
            await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
        }
    });

    it('6. collectReferencedSigsFromCache returns empty ok on empty db and ok: false on corrupt db', async () => {
        const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ff-db-sigs-'));
        try {
            await nedb.initCacheDb(dataDir);
            const emptyRes = await nedb.collectReferencedSigsFromCache();
            assert.equal(emptyRes.ok, true);
            assert.equal(emptyRes.count, 0);
            assert.equal(emptyRes.sigs.size, 0);

            // Corrupt the sqlite file
            await nedb.closeCacheDbForTest();
            await fs.writeFile(path.join(dataDir, 'cache.sqlite'), 'not a valid sqlite database');
            await assert.rejects(() => nedb.initCacheDb(dataDir));
            const corruptRes = await nedb.collectReferencedSigsFromCache();
            assert.equal(corruptRes.ok, false);
        } finally {
            await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
        }
    });

    it('7. reloadFromDisk recovers cleanly after a failed/corrupted initCacheDb once a valid DB is restored', async () => {
        const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ff-db-recover-'));
        try {
            // Create a valid snapshot first
            await nedb.initCacheDb(dataDir);
            await nedb.insertCache({
                v: nedb.CACHE_VERSION,
                serial: '66666666',
                relPath: 'Recovered',
                mode: 'cover',
                count: 1,
                data: [{ dir: 'Recovered', name: 'ok', ext: 'jpg', isDirectory: false, type: 'image', size: 123 }],
                create_at: '2026-11-26 12:00:00',
            });
            const backupFile = path.join(dataDir, 'valid-backup.sqlite');
            await nedb.snapshotCacheTo(backupFile);

            // Corrupt active DB and fail initCacheDb
            await nedb.closeCacheDbForTest();
            await fs.writeFile(path.join(dataDir, 'cache.sqlite'), 'corrupted-bytes');
            await assert.rejects(() => nedb.initCacheDb(dataDir));
            await assert.rejects(() => nedb.loadMeta({}));

            // Restore valid DB file and call reloadFromDisk()
            await fs.copyFile(backupFile, path.join(dataDir, 'cache.sqlite'));
            await nedb.reloadFromDisk();

            const meta = await nedb.loadMeta({});
            assert.equal(meta.length, 1);
            assert.equal(meta[0].relPath, 'Recovered');
        } finally {
            await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
        }
    });

    it('8. restoreCacheFromSnapshot cleanly rolls back an open WAL DB on Windows', async () => {
        const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ff-db-rollback-'));
        try {
            await nedb.initCacheDb(dataDir);
            await nedb.insertCache({
                v: nedb.CACHE_VERSION,
                serial: '77777777',
                relPath: 'Before',
                mode: 'cover',
                count: 1,
                data: [{ dir: 'Before', name: 'old', ext: 'jpg', isDirectory: false, type: 'image', size: 100 }],
                create_at: '2026-11-26 12:00:00',
            });
            const snapPath = path.join(dataDir, 'snap.sqlite');
            await nedb.snapshotCacheTo(snapPath);

            // Mutate live DB (still open with WAL)
            await nedb.replaceAllCacheDocs([
                {
                    v: nedb.CACHE_VERSION,
                    serial: '88888888',
                    relPath: 'After',
                    mode: 'cover',
                    count: 1,
                    data: [{ dir: 'After', name: 'new', ext: 'jpg', isDirectory: false, type: 'image', size: 200 }],
                    create_at: '2026-11-26 13:00:00',
                },
            ]);
            assert.equal((await nedb.loadMeta({}))[0].relPath, 'After');

            // Roll back while DB handle is still open
            await nedb.restoreCacheFromSnapshot(snapPath);
            const meta = await nedb.loadMeta({});
            assert.equal(meta.length, 1);
            assert.equal(meta[0].relPath, 'Before');
        } finally {
            await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
        }
    });
});
