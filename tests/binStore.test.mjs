import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

let bundleDir;
let binStore;
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

function makeFakeJpeg(seed) {
    // JPEG SOI + APP0 marker + deterministic payload
    const header = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]);
    const body = crypto.createHash('sha256').update(`jpeg-${seed}`).digest();
    return Buffer.concat([header, body]);
}

function makeFakeWebp(seed) {
    // RIFF....WEBP header + deterministic payload
    const payload = crypto.createHash('sha256').update(`webp-${seed}`).digest();
    const header = Buffer.alloc(12);
    header.write('RIFF', 0, 'ascii');
    header.writeUInt32LE(4 + payload.length, 4);
    header.write('WEBP', 8, 'ascii');
    return Buffer.concat([header, payload]);
}

function sha1Hex(buf) {
    return crypto.createHash('sha1').update(buf).digest('hex');
}

describe('bin.sqlite storage & progressive legacy migration', () => {
    before(async () => {
        process.env.NODE_ENV = 'test';
        bundleDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ff-binstore-bundle-'));

        const binStoreOut = path.join(bundleDir, 'binStore.mjs');
        const cryptoOut = path.join(bundleDir, 'cacheCrypto.mjs');

        await Promise.all([
            esbuild.build({
                entryPoints: [path.resolve('electron/utils/binStore.ts')],
                bundle: true,
                platform: 'node',
                format: 'esm',
                plugins: [resolveFromRepo],
                outfile: binStoreOut,
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

        binStore = await import(pathToFileURL(binStoreOut).href);
        cacheCrypto = await import(pathToFileURL(cryptoOut).href);
    });

    after(async () => {
        if (bundleDir) {
            await fs.rm(bundleDir, { recursive: true, force: true }).catch(() => {});
        }
    });

    it('1. stores WebP and JPEG buffers via putBin / putBinsBatch with accurate fmt & contentType', async () => {
        const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ff-bin-fmt-'));
        try {
            await binStore.initBinStore(dataDir);
            await binStore.whenBinReady();

            const jpegBuf = makeFakeJpeg(1);
            const webpBuf = makeFakeWebp(2);
            const jpegSig = sha1Hex(jpegBuf);
            const webpSig = sha1Hex(webpBuf);

            const tJpeg = binStore.thumbNameOf(jpegSig);
            const pWebp = binStore.previewNameOf(webpSig);

            // Concurrent putBin calls should coalesce cleanly
            await Promise.all([
                binStore.putBin(tJpeg, jpegBuf),
                binStore.putBin(pWebp, webpBuf),
            ]);

            assert.equal(binStore.hasBin(tJpeg), true);
            assert.equal(binStore.hasBin(pWebp), true);

            const gotJpeg = binStore.getBin(tJpeg);
            assert.ok(gotJpeg);
            assert.equal(gotJpeg.contentType, 'image/jpeg');
            assert.equal(gotJpeg.buf.equals(jpegBuf), true);

            const gotWebp = binStore.getBin(pWebp);
            assert.ok(gotWebp);
            assert.equal(gotWebp.contentType, 'image/webp');
            assert.equal(gotWebp.buf.equals(webpBuf), true);

            const backupJpeg = binStore.readBinEntryForBackup('t', jpegSig);
            assert.ok(backupJpeg);
            assert.equal(backupJpeg.fmt, 1);
            assert.equal(backupJpeg.data.equals(jpegBuf), true);

            const backupWebp = binStore.readBinEntryForBackup('p', webpSig);
            assert.ok(backupWebp);
            assert.equal(backupWebp.fmt, 2);
            assert.equal(backupWebp.data.equals(webpBuf), true);

            // putBinsBatch also works
            const jpegBuf2 = makeFakeJpeg(3);
            const sig2 = sha1Hex(jpegBuf2);
            const tJpeg2 = binStore.thumbNameOf(sig2);
            await binStore.putBinsBatch([{ name: tJpeg2, buf: jpegBuf2 }]);

            assert.equal(binStore.hasBin(tJpeg2), true);
            const stats = await binStore.binStats();
            assert.equal(stats.count, 3);
            assert.equal(stats.bytes, jpegBuf.length + webpBuf.length + jpegBuf2.length);
            assert.equal(binStore.listBinEntries().length, 3);
        } finally {
            await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
        }
    });

    it('2. non-blocking whenBinReady + dual-read fallback + progressive 80-item batch migration of 120 .enc files', async () => {
        const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ff-bin-migrate-'));
        try {
            const legacyDir = path.join(dataDir, 'bin');
            await fs.mkdir(legacyDir, { recursive: true });

            const items = [];
            for (let i = 0; i < 120; i++) {
                const plain = makeFakeJpeg(`legacy-${i}`);
                const sig = sha1Hex(plain);
                const kind = i % 2 === 0 ? 't' : 'p';
                const name = `${kind}-${sig}.enc`;
                const enc = cacheCrypto.encryptBlob(plain);
                await fs.writeFile(path.join(legacyDir, name), enc);
                items.push({ name, plain, kind, sig });
            }

            await binStore.initBinStore(dataDir);
            await binStore.whenBinReady();

            // whenBinReady() must resolve before background migration finishes
            assert.ok(
                binStore.getLegacyBinPendingCount() > 0,
                'expected pending legacy .enc files immediately after whenBinReady()',
            );

            // During migration, all 120 items must be readable via dual-source fallback
            for (const item of items) {
                assert.equal(binStore.hasBin(item.name), true, `hasBin failed during migration for ${item.name}`);
            }
            const sampleMid = binStore.getBin(items[119].name);
            assert.ok(sampleMid);
            assert.equal(sampleMid.contentType, 'image/jpeg');
            assert.equal(sampleMid.buf.equals(items[119].plain), true);

            // Wait for background migration to complete
            await binStore.waitForLegacyMigration();

            assert.equal(binStore.getLegacyBinPendingCount(), 0);
            const stats = await binStore.binStats();
            assert.equal(stats.count, 120);

            // Legacy bin/ directory should have no .enc files left (and be removed if empty)
            let remainingEnc = [];
            try {
                remainingEnc = (await fs.readdir(legacyDir)).filter((f) => f.endsWith('.enc'));
            } catch {
                remainingEnc = [];
            }
            assert.equal(remainingEnc.length, 0);

            // All 120 entries remain readable from bin.sqlite with exact bytes
            for (const item of items) {
                assert.equal(binStore.hasBin(item.name), true);
                const got = binStore.getBin(item.name);
                assert.ok(got);
                assert.equal(got.contentType, 'image/jpeg');
                assert.equal(got.buf.equals(item.plain), true);
            }
        } finally {
            await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
        }
    });

    it('3. deleteBinsBatch removes rows and reclaims disk space via incremental_vacuum', async () => {
        const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ff-bin-vacuum-'));
        try {
            await binStore.initBinStore(dataDir);
            await binStore.whenBinReady();

            const batch = [];
            const keys = [];
            for (let i = 0; i < 20; i++) {
                const payload = crypto.randomBytes(64 * 1024); // 64 KB incompressible random data
                const sig = sha1Hex(payload);
                batch.push({ name: `p-${sig}.enc`, buf: payload });
                keys.push({ kind: 'p', sig });
            }
            await binStore.putBinsBatch(batch);

            const beforeBytes = await binStore.getBinDbBytes();
            assert.ok(beforeBytes && beforeBytes > 1024 * 1024, `expected >1MB before delete, got ${beforeBytes}`);

            // Delete 18 out of 20 entries
            const toDelete = keys.slice(0, 18);
            const res = await binStore.deleteBinsBatch(toDelete);
            assert.equal(res.removed, 18);
            assert.equal(res.freed, 18 * 64 * 1024);

            for (let i = 0; i < 18; i++) {
                assert.equal(binStore.hasBin(`p-${keys[i].sig}.enc`), false);
            }
            for (let i = 18; i < 20; i++) {
                assert.equal(binStore.hasBin(`p-${keys[i].sig}.enc`), true);
            }

            const afterBytes = await binStore.getBinDbBytes();
            assert.ok(
                afterBytes !== undefined && afterBytes < beforeBytes * 0.35,
                `expected bin.sqlite (${afterBytes}) to shrink significantly from ${beforeBytes}`,
            );
        } finally {
            await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
        }
    });
});
