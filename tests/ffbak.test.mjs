import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

let tempHome;
let dataDir;
let bundleDir;
let ffbak;
let server;
let nedb;
let binStore;
let zip;
let cacheCrypto;
let hitsStore;
let playlistStore;

const resolveFromRepo = {
    name: 'resolve-from-repo',
    setup(build) {
        build.onResolve({ filter: /^electron$/ }, () => ({
            path: 'electron-stub',
            namespace: 'electron-stub',
        }));
        build.onLoad({ filter: /.*/, namespace: 'electron-stub' }, () => ({
            contents: 'export const BrowserWindow = {}; export const session = {}; export const app = {}; export const net = {}; export const nativeImage = {}; export default {};',
            loader: 'js',
        }));
        build.onResolve({ filter: /^[^./]/ }, (args) => {
            if (args.kind === 'entry-point') return;
            if (/^[A-Za-z]:/.test(args.path)) return;
            if (args.path.startsWith('node:')) return { external: true };
            try {
                return { path: import.meta.resolve(args.path), external: true };
            } catch {
                return { external: true };
            }
        });
    },
};

function makeFakeJpeg(seed, size = 64) {
    const header = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]);
    const body = Buffer.alloc(size);
    for (let i = 0; i < size; i++) {
        body[i] = (seed * 31 + i * 17) & 0xff;
    }
    return Buffer.concat([header, body]);
}

function makeFakeWebp(seed, size = 64) {
    const body = Buffer.alloc(size);
    for (let i = 0; i < size; i++) {
        body[i] = (seed * 47 + i * 13) & 0xff;
    }
    const header = Buffer.alloc(12);
    header.write('RIFF', 0, 'ascii');
    header.writeUInt32LE(4 + body.length, 4);
    header.write('WEBP', 8, 'ascii');
    return Buffer.concat([header, body]);
}

function sha1Hex(buf) {
    return crypto.createHash('sha1').update(buf).digest('hex');
}

describe('.ffbak streaming backup & dual-format restore/merge', () => {
    before(async () => {
        process.env.NODE_ENV = 'test';
        tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'ff-ffbak-home-'));
        process.env.USERPROFILE = tempHome;
        dataDir = path.join(tempHome, '.file-finder');
        await fs.mkdir(dataDir, { recursive: true });

        bundleDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ff-ffbak-bundle-'));

        const entryFile = path.join(bundleDir, 'entry.ts');
        const outFile = path.join(bundleDir, 'bundle.mjs');
        const toPosix = (p) => path.resolve(p).replace(/\\/g, '/');
        await fs.writeFile(
            entryFile,
            [
                `export * as ffbak from '${toPosix('electron/utils/ffbak.ts')}';`,
                `export * as server from '${toPosix('electron/server/index.ts')}';`,
                `export * as nedb from '${toPosix('electron/server/nedb.ts')}';`,
                `export * as binStore from '${toPosix('electron/utils/binStore.ts')}';`,
                `export * as zip from '${toPosix('electron/utils/zip.ts')}';`,
                `export * as cacheCrypto from '${toPosix('electron/utils/cacheCrypto.ts')}';`,
                `export * as hitsStore from '${toPosix('electron/server/assistant/hits.ts')}';`,
                `export * as playlistStore from '${toPosix('electron/server/playlistStore.ts')}';`,
            ].join('\n'),
            'utf8'
        );

        await esbuild.build({
            entryPoints: [entryFile],
            bundle: true,
            platform: 'node',
            format: 'esm',
            plugins: [resolveFromRepo],
            outfile: outFile,
        });

        const mod = await import(pathToFileURL(outFile).href);
        ffbak = mod.ffbak;
        server = mod.server;
        nedb = mod.nedb;
        binStore = mod.binStore;
        zip = mod.zip;
        cacheCrypto = mod.cacheCrypto;
        hitsStore = mod.hitsStore;
        playlistStore = mod.playlistStore;

        await binStore.initBinStore(dataDir);
        await nedb.initCacheDb(dataDir);
    });

    after(async () => {
        if (bundleDir) await fs.rm(bundleDir, { recursive: true, force: true }).catch(() => {});
        if (tempHome) await fs.rm(tempHome, { recursive: true, force: true }).catch(() => {});
    });

    it('1. writeFfbak + readFfbakMetaAndVerify + streamFfbakImages roundtrip with obfuscated meta and exact image bytes', async () => {
        const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ff-ffbak-rt-'));
        try {
            const target = path.join(workDir, 'test.ffbak');
            const jpegBuf = makeFakeJpeg(1, 128);
            const webpBuf = makeFakeWebp(2, 256);
            const sig1 = sha1Hex(jpegBuf);
            const sig2 = sha1Hex(webpBuf);

            const meta = {
                manifest: {
                    format: 1,
                    app: 'file-finder',
                    createdAt: '2026-11-26 21:00:00',
                    cacheVersion: 3,
                    includePreviews: true,
                    dbEntries: 1,
                    images: 2,
                    playlists: 1,
                    hits: 1,
                },
                cacheEntries: [
                    {
                        v: 3,
                        serial: 'DISK-SECRET-SERIAL',
                        relPath: 'Movies/SecretTitle',
                        mode: 'folder',
                        count: 1,
                        create_at: '2026-11-26 20:00:00',
                        data: [{ dir: 'Movies/SecretTitle', name: 'Sample', isDirectory: false, size: 1024, sig: sig1 }],
                    },
                ],
                disks: { 'DISK-SECRET-SERIAL': { label: 'MyDrive', firstSeenAt: 1000, lastSeenAt: 2000 } },
                playlists: [{ id: 'pl_1', name: 'FavoritesSecret', createdAt: 1000, items: [] }],
                hits: [{ id: 'hit_1', coverUrl: 'https://example.com/a.jpg', at: 1000 }],
            };

            const res = await ffbak.writeFfbak(target, {
                includePreviews: true,
                meta,
                images: [
                    { kind: 't', fmt: 1, sigHex: sig1, data: jpegBuf },
                    { kind: 'p', fmt: 2, sigHex: sig2, data: webpBuf },
                ],
            });

            assert.equal(res.imageCount, 2);
            assert.ok(res.bytes > 0);
            assert.equal(await ffbak.detectBackupFormat(target), 'ffbak');

            const rawFile = await fs.readFile(target);
            assert.equal(rawFile.subarray(0, 4).toString('ascii'), 'FFBK');
            assert.equal(rawFile.subarray(rawFile.length - 4).toString('ascii'), 'FEND');
            // JSON plaintext must not be readable in raw file
            assert.equal(rawFile.includes(Buffer.from('DISK-SECRET-SERIAL', 'utf8')), false);
            assert.equal(rawFile.includes(Buffer.from('FavoritesSecret', 'utf8')), false);

            const verified = await ffbak.readFfbakMetaAndVerify(target);
            assert.equal(verified.version, 1);
            assert.equal(verified.includePreviews, true);
            assert.equal(verified.binCount, 2);
            assert.deepEqual(verified.meta, meta);

            const extracted = [];
            await ffbak.streamFfbakImages(target, verified.imagesOffset, verified.binCount, (entry) => {
                extracted.push(entry);
            });

            assert.equal(extracted.length, 2);
            assert.equal(extracted[0].kind, 't');
            assert.equal(extracted[0].fmt, 1);
            assert.equal(extracted[0].sigHex, sig1);
            assert.equal(extracted[0].data.equals(jpegBuf), true);

            assert.equal(extracted[1].kind, 'p');
            assert.equal(extracted[1].fmt, 2);
            assert.equal(extracted[1].sigHex, sig2);
            assert.equal(extracted[1].data.equals(webpBuf), true);
        } finally {
            await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
        }
    });

    it('2. readFfbakMetaAndVerify rejects truncated files, corrupted MetaChunk, corrupted image DataCRC32, and corrupted FEND', async () => {
        const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ff-ffbak-corrupt-'));
        try {
            const validPath = path.join(workDir, 'valid.ffbak');
            const img = makeFakeJpeg(9, 100);
            const sig = sha1Hex(img);
            await ffbak.writeFfbak(validPath, {
                includePreviews: false,
                meta: {
                    manifest: { format: 1, app: 'file-finder', createdAt: '2026-11-26', cacheVersion: 3, includePreviews: false, dbEntries: 0, images: 1, playlists: 0, hits: 0 },
                    cacheEntries: [],
                    disks: {},
                    playlists: [],
                    hits: [],
                },
                images: [{ kind: 't', fmt: 1, sigHex: sig, data: img }],
            });
            const orig = await fs.readFile(validPath);

            // 2a. Truncated tail
            const truncPath = path.join(workDir, 'trunc.ffbak');
            await fs.writeFile(truncPath, orig.subarray(0, orig.length - 2));
            await assert.rejects(() => ffbak.readFfbakMetaAndVerify(truncPath));

            // 2b. Corrupted MetaChunk byte (offset 20 is start of MetaChunk)
            const badMetaPath = path.join(workDir, 'bad-meta.ffbak');
            const badMeta = Buffer.from(orig);
            badMeta[21] ^= 0xff;
            await fs.writeFile(badMetaPath, badMeta);
            await assert.rejects(() => ffbak.readFfbakMetaAndVerify(badMetaPath), /CRC|校验|Meta/i);

            // 2c. Corrupted image DataCRC32 or Data byte
            const badImgPath = path.join(workDir, 'bad-img.ffbak');
            const badImg = Buffer.from(orig);
            badImg[badImg.length - 10] ^= 0xff;
            await fs.writeFile(badImgPath, badImg);
            await assert.rejects(() => ffbak.readFfbakMetaAndVerify(badImgPath), /CRC|校验|图片|data/i);

            // 2d. Corrupted FEND footer
            const badFooterPath = path.join(workDir, 'bad-footer.ffbak');
            const badFooter = Buffer.from(orig);
            badFooter[badFooter.length - 1] = 0x00;
            await fs.writeFile(badFooterPath, badFooter);
            await assert.rejects(() => ffbak.readFfbakMetaAndVerify(badFooterPath), /FEND|结尾|footer|尾/i);
        } finally {
            await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
        }
    });

    it('3. lightweight mode (includePreviews: false) excludes p- previews and is significantly smaller', async () => {
        const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ff-ffbak-lite-'));
        try {
            // Seed DB + binStore with 1 thumb and 1 large preview
            const thumbBuf = makeFakeWebp(10, 128);
            const prevBuf = makeFakeJpeg(11, 64 * 1024);
            const sig = sha1Hex(thumbBuf);

            await binStore.putBin(binStore.thumbNameOf(sig), thumbBuf);
            await binStore.putBin(binStore.previewNameOf(sig), prevBuf);

            await nedb.replaceAllCacheDocs([
                {
                    v: 3,
                    serial: 'DISK-LITE',
                    relPath: 'Lite',
                    mode: 'folder',
                    count: 1,
                    create_at: '2026-11-26 10:00:00',
                    data: [{ dir: 'Lite', name: 'Item1', isDirectory: false, size: 500, sig }],
                },
            ]);

            const fullPath = path.join(workDir, 'full.ffbak');
            const litePath = path.join(workDir, 'lite.ffbak');

            const fullRes = await server.runBackupToFile(dataDir, fullPath, true);
            const liteRes = await server.runBackupToFile(dataDir, litePath, false);

            assert.equal(fullRes.manifest.images, 2);
            assert.equal(liteRes.manifest.images, 1);
            assert.ok(liteRes.bytes < fullRes.bytes / 2);

            const liteVerified = await ffbak.readFfbakMetaAndVerify(litePath);
            assert.equal(liteVerified.includePreviews, false);
            assert.equal(liteVerified.binCount, 1);
            const imgs = [];
            await ffbak.streamFfbakImages(litePath, liteVerified.imagesOffset, liteVerified.binCount, (e) => imgs.push(e));
            assert.equal(imgs.length, 1);
            assert.equal(imgs[0].kind, 't');
        } finally {
            await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
        }
    });

    it('4. integration: skips orphan images, add-merges playlists & hits, and supports legacy .zip restore & merge', async () => {
        const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ff-ffbak-int-'));
        try {
            // 4a. Seed active image + orphan image
            const activeThumb = makeFakeWebp(21, 100);
            const activeSig = sha1Hex(activeThumb);
            const orphanThumb = makeFakeWebp(22, 100);
            const orphanSig = sha1Hex(orphanThumb);

            await binStore.putBin(binStore.thumbNameOf(activeSig), activeThumb);
            await binStore.putBin(binStore.thumbNameOf(orphanSig), orphanThumb);

            await nedb.replaceAllCacheDocs([
                {
                    v: 3,
                    serial: 'DISK-1',
                    relPath: 'A',
                    mode: 'folder',
                    count: 1,
                    create_at: '2026-11-26 12:00:00',
                    data: [{ dir: 'A', name: 'Active', isDirectory: false, size: 100, sig: activeSig }],
                },
            ]);
            await playlistStore.mergePlaylists(dataDir, [
                {
                    id: 'pl_local',
                    name: 'LocalList',
                    createdAt: 1000,
                    items: [{ id: 'it_1', serial: 'DISK-1', relPath: 'A', name: 'Active', type: 'image', size: 100, sig: activeSig, addedAt: 1000 }],
                },
            ]);
            await hitsStore.mergeHits(dataDir, [
                { id: 'hit_local', coverUrl: 'https://example.com/local.jpg', at: 1000 },
            ]);

            const bak1 = path.join(workDir, 'bak1.ffbak');
            const bak1Res = await server.runBackupToFile(dataDir, bak1, true);
            // Orphan image must be skipped
            assert.equal(bak1Res.manifest.images, 1);

            const bak1Meta = await ffbak.readFfbakMetaAndVerify(bak1);
            assert.equal(bak1Meta.meta.hits.length, 1);
            assert.equal(bak1Meta.meta.playlists.length >= 1, true);

            // Mutate local state (new playlist + new hit) then restore bak1 -> playlists & hits must be add-merged (not wiped)
            await playlistStore.mergePlaylists(dataDir, [
                {
                    id: 'pl_extra',
                    name: 'ExtraList',
                    createdAt: 2000,
                    items: [],
                },
            ]);
            await hitsStore.mergeHits(dataDir, [
                { id: 'hit_extra', coverUrl: 'https://example.com/extra.jpg', at: 2000 },
            ]);

            await server.runRestoreFromFile(dataDir, bak1);
            const plsAfterRestore = await playlistStore.loadPlaylists(dataDir);
            assert.ok(plsAfterRestore.some((p) => p.id === 'pl_local'));
            assert.ok(plsAfterRestore.some((p) => p.id === 'pl_extra'));
            const hitsAfterRestore = await hitsStore.exportActiveHits(dataDir);
            assert.ok(hitsAfterRestore.some((h) => h.id === 'hit_local'));
            assert.ok(hitsAfterRestore.some((h) => h.id === 'hit_extra'));

            // 4b. Legacy .zip with AES-encrypted bin/*.enc + v2 thumbData
            const zipPath = path.join(workDir, 'legacy.zip');
            const legacyStage = path.join(workDir, 'legacy-stage');
            await fs.mkdir(legacyStage, { recursive: true });

            const zipImg = makeFakeJpeg(33, 96);
            const zipSig = sha1Hex(zipImg);
            const v2Thumb = makeFakeJpeg(34, 80);
            const v2Sig = sha1Hex(v2Thumb);

            const encBinFile = path.join(legacyStage, `t-${zipSig}.enc`);
            await fs.writeFile(encBinFile, cacheCrypto.encryptBlob(zipImg));

            const dbPlain = [
                JSON.stringify({
                    v: 3,
                    serial: 'DISK-ZIP',
                    relPath: 'FromZip',
                    mode: 'folder',
                    count: 1,
                    create_at: '2026-11-26 15:00:00',
                    data: [{ dir: 'FromZip', name: 'ZipItem', isDirectory: false, size: 200, sig: zipSig }],
                }),
                JSON.stringify({
                    v: 2,
                    serial: 'DISK-V2',
                    relPath: 'FromV2',
                    mode: 'folder',
                    count: 1,
                    create_at: '2026-11-26 15:00:00',
                    data: [{ dir: 'FromV2', name: 'V2Item', isDirectory: false, size: 300, thumbData: `data:image/jpeg;base64,${v2Thumb.toString('base64')}` }],
                }),
                JSON.stringify({ $$indexCreated: { fieldName: 'serial', unique: false, sparse: false } }),
            ].join('\n') + '\n';

            const dbFile = path.join(legacyStage, 'searchCache.db');
            const dkFile = path.join(legacyStage, 'disks.json');
            const mfFile = path.join(legacyStage, 'manifest.json');
            const plFile = path.join(legacyStage, 'playlists.json');
            await fs.writeFile(dbFile, dbPlain, 'utf8');
            await fs.writeFile(dkFile, JSON.stringify({ 'DISK-ZIP': { label: 'ZipDrive', firstSeenAt: 100, lastSeenAt: 200 } }), 'utf8');
            await fs.writeFile(mfFile, JSON.stringify({ format: 1, app: 'file-finder' }), 'utf8');
            await fs.writeFile(plFile, JSON.stringify([{ id: 'pl_zip', name: 'ZipList', createdAt: 3000, items: [] }]), 'utf8');

            await zip.writeZip(zipPath, [
                { name: 'manifest.json', file: mfFile, compress: 'deflate' },
                { name: 'searchCache.db', file: dbFile, compress: 'deflate' },
                { name: 'disks.json', file: dkFile, compress: 'deflate' },
                { name: 'playlists.json', file: plFile, compress: 'deflate' },
                { name: `bin/t-${zipSig}.enc`, file: encBinFile, compress: 'store' },
            ]);

            assert.equal(await ffbak.detectBackupFormat(zipPath), 'zip');

            // Merge legacy zip
            await server.runMergeCache(dataDir, zipPath);
            const mergedZipDoc = await nedb.findCache('DISK-ZIP', 'FromZip', 'folder');
            assert.ok(mergedZipDoc);
            assert.equal(binStore.getBin(binStore.thumbNameOf(zipSig))?.buf.equals(zipImg), true);

            // Restore legacy zip (including v2 thumbData migration)
            await server.runRestoreFromFile(dataDir, zipPath);
            const restoredV2Doc = await nedb.findCache('DISK-V2', 'FromV2', 'folder');
            assert.ok(restoredV2Doc);
            assert.equal(restoredV2Doc.data[0].sig, v2Sig);
            assert.equal(binStore.getBin(binStore.thumbNameOf(v2Sig))?.buf.equals(v2Thumb), true);
            const plsAfterZipRestore = await playlistStore.loadPlaylists(dataDir);
            assert.ok(plsAfterZipRestore.some((p) => p.id === 'pl_zip'));
        } finally {
            await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
        }
    });
});
