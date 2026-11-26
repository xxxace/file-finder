import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import zlib from 'node:zlib';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

let bundleDir;
let gfriends;
let hits;

describe('auxCache: gfriends zstd & hits compaction/merge', () => {
    before(async () => {
        bundleDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ff-auxcache-bundle-'));
        const gfriendsOut = path.join(bundleDir, 'gfriends.mjs');
        const hitsOut = path.join(bundleDir, 'hits.mjs');

        await Promise.all([
            esbuild.build({
                entryPoints: [path.resolve('electron/server/assistant/gfriends.ts')],
                bundle: true,
                platform: 'node',
                format: 'esm',
                packages: 'external',
                outfile: gfriendsOut,
            }),
            esbuild.build({
                entryPoints: [path.resolve('electron/server/assistant/hits.ts')],
                bundle: true,
                platform: 'node',
                format: 'esm',
                packages: 'external',
                outfile: hitsOut,
            }),
        ]);

        gfriends = await import(pathToFileURL(gfriendsOut).href);
        hits = await import(pathToFileURL(hitsOut).href);
    });

    after(async () => {
        if (bundleDir) {
            await fs.rm(bundleDir, { recursive: true, force: true }).catch(() => {});
        }
    });

    it('1. gfriends migrates legacy filetree.json to filetree.zst, deletes legacy json, and reads back identically', async () => {
        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ff-gfriends-test-'));
        try {
            const cacheDir = path.join(tmpDir, 'gfriends');
            await fs.mkdir(cacheDir, { recursive: true });

            const actors = {};
            for (let i = 0; i < 500; i++) {
                const name = `Actress_${String(i).padStart(3, '0')}`;
                actors[name] = `Content/A/${name}.jpg`;
            }
            const legacyIndex = {
                version: '1.0',
                updatedAt: Date.now(),
                actors,
            };
            const legacyJsonPath = path.join(cacheDir, 'filetree.json');
            const zstPath = path.join(cacheDir, 'filetree.zst');
            const rawJson = JSON.stringify(legacyIndex);
            await fs.writeFile(legacyJsonPath, rawJson, 'utf8');

            const loaded = await gfriends.ensureGfriendsIndex(tmpDir, false);
            assert.deepEqual(loaded, legacyIndex);

            // Legacy filetree.json must be deleted
            await assert.rejects(fs.stat(legacyJsonPath), { code: 'ENOENT' });

            // New filetree.zst must exist and be significantly smaller than JSON
            const zstStat = await fs.stat(zstPath);
            assert.ok(zstStat.size > 0, 'filetree.zst should be non-empty');
            assert.ok(
                zstStat.size < Buffer.byteLength(rawJson, 'utf8') * 0.5,
                `expected zst (${zstStat.size}) to be < 50% of json (${Buffer.byteLength(rawJson, 'utf8')})`
            );

            // Decompressing filetree.zst directly yields identical JSON
            const zstBuf = await fs.readFile(zstPath);
            const decompressed = zlib.zstdDecompressSync(zstBuf).toString('utf8');
            assert.deepEqual(JSON.parse(decompressed), legacyIndex);

            // Subsequent call reads directly from filetree.zst
            const reloaded = await gfriends.ensureGfriendsIndex(tmpDir, false);
            assert.deepEqual(reloaded, legacyIndex);
        } finally {
            await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
        }
    });

    it('2. compactHits removes duplicate ids and tombstone lines, keeping only latest active records', async () => {
        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ff-hits-compact-'));
        try {
            const jsonlPath = path.join(tmpDir, 'assistant-hits.jsonl');
            const lines = [
                JSON.stringify({
                    id: 'SSNI-001',
                    hitSite: 'siteA',
                    coverUrl: 'https://example.com/old.jpg',
                    title: 'Old Title',
                    actresses: [{ name: 'A' }],
                    at: '2026-01-01T00:00:00.000Z',
                }),
                JSON.stringify({
                    id: 'SSNI-001',
                    hitSite: 'siteB',
                    coverUrl: 'https://example.com/new.jpg',
                    title: 'New Title',
                    actresses: [{ name: 'A' }],
                    at: '2026-02-01T00:00:00.000Z',
                }),
                JSON.stringify({
                    id: 'DEAD-002',
                    hitSite: 'siteA',
                    coverUrl: 'https://example.com/dead.jpg',
                    title: 'Dead',
                    actresses: [],
                    at: '2026-01-10T00:00:00.000Z',
                }),
                JSON.stringify({
                    id: 'DEAD-002',
                    hitSite: '',
                    coverUrl: '',
                    title: null,
                    actresses: [],
                    at: '2026-02-10T00:00:00.000Z',
                }),
                JSON.stringify({
                    id: 'IPX-100',
                    hitSite: 'siteC',
                    coverUrl: 'https://example.com/ipx100.jpg',
                    title: 'IPX 100',
                    actresses: [{ name: 'B' }],
                    at: '2026-01-15T00:00:00.000Z',
                }),
            ];
            await fs.writeFile(jsonlPath, `${lines.join('\n')}\n`, 'utf8');

            const stats = await hits.compactHits(tmpDir);
            assert.equal(stats.beforeLines, 5);
            assert.equal(stats.afterLines, 2);

            const afterText = await fs.readFile(jsonlPath, 'utf8');
            const afterLines = afterText.trim().split('\n').filter(Boolean);
            assert.equal(afterLines.length, 2);

            const exported = await hits.exportActiveHits(tmpDir);
            assert.equal(exported.length, 2);
            const map = new Map(exported.map(r => [r.id, r]));
            assert.equal(map.get('SSNI-001')?.coverUrl, 'https://example.com/new.jpg');
            assert.equal(map.get('IPX-100')?.coverUrl, 'https://example.com/ipx100.jpg');
            assert.equal(map.has('DEAD-002'), false);
        } finally {
            await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
        }
    });

    it('3. loadHits triggers auto-compaction when totalLines exceeds hits.size * 1.2 + 20', async () => {
        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ff-hits-autocompact-'));
        try {
            const jsonlPath = path.join(tmpDir, 'assistant-hits.jsonl');
            const lines = [];
            for (let i = 0; i < 30; i++) {
                lines.push(JSON.stringify({
                    id: 'SAME-001',
                    hitSite: 'siteA',
                    coverUrl: `https://example.com/${i}.jpg`,
                    title: `Title ${i}`,
                    actresses: [],
                    at: `2026-01-${String((i % 28) + 1).padStart(2, '0')}T00:00:00.000Z`,
                }));
            }
            await fs.writeFile(jsonlPath, `${lines.join('\n')}\n`, 'utf8');

            const map = await hits.loadHits(tmpDir);
            assert.equal(map.size, 1);
            assert.equal(map.get('SAME-001')?.coverUrl, 'https://example.com/29.jpg');

            // Give any async compaction a brief tick if needed, though ideally loadHits completes it
            await new Promise(r => setTimeout(r, 50));
            const afterText = await fs.readFile(jsonlPath, 'utf8');
            const afterLines = afterText.trim().split('\n').filter(Boolean);
            assert.equal(afterLines.length, 1);
        } finally {
            await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
        }
    });

    it('4. mergeHits keeps newer non-tombstone records and does not overwrite newer local records', async () => {
        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ff-hits-merge-'));
        try {
            const jsonlPath = path.join(tmpDir, 'assistant-hits.jsonl');
            const localRecords = [
                {
                    id: 'KEEP-LOCAL',
                    hitSite: 'localSite',
                    coverUrl: 'https://local.example/keep.jpg',
                    title: 'Local Newer',
                    actresses: [{ name: 'Local' }],
                    at: '2026-05-01T10:00:00.000Z',
                },
                {
                    id: 'UPDATE-ME',
                    hitSite: 'localSite',
                    coverUrl: 'https://local.example/old.jpg',
                    title: 'Local Older',
                    actresses: [{ name: 'Old' }],
                    at: '2026-01-01T10:00:00.000Z',
                },
            ];
            await fs.writeFile(
                jsonlPath,
                `${localRecords.map(r => JSON.stringify(r)).join('\n')}\n`,
                'utf8'
            );

            const incoming = [
                {
                    id: 'KEEP-LOCAL',
                    hitSite: 'remoteSite',
                    coverUrl: 'https://remote.example/older.jpg',
                    title: 'Remote Older',
                    actresses: [{ name: 'Remote' }],
                    at: '2026-03-01T10:00:00.000Z',
                },
                {
                    id: 'UPDATE-ME',
                    hitSite: 'remoteSite',
                    coverUrl: 'https://remote.example/newer.jpg',
                    title: 'Remote Newer',
                    actresses: [{ name: 'New' }],
                    at: '2026-06-01T10:00:00.000Z',
                },
                {
                    id: 'ADD-NEW',
                    hitSite: 'remoteSite',
                    coverUrl: 'https://remote.example/new.jpg',
                    title: 'Brand New',
                    actresses: [{ name: 'Brand' }],
                    at: '2026-04-01T10:00:00.000Z',
                },
                {
                    id: 'IGNORE-TOMBSTONE',
                    hitSite: '',
                    coverUrl: '',
                    title: null,
                    actresses: [],
                    at: '2026-07-01T10:00:00.000Z',
                },
            ];

            const res = await hits.mergeHits(tmpDir, incoming);
            assert.deepEqual(res, { added: 1, updated: 1 });

            const merged = await hits.loadHits(tmpDir);
            assert.equal(merged.size, 3);
            assert.equal(merged.get('KEEP-LOCAL')?.coverUrl, 'https://local.example/keep.jpg');
            assert.equal(merged.get('UPDATE-ME')?.coverUrl, 'https://remote.example/newer.jpg');
            assert.equal(merged.get('ADD-NEW')?.coverUrl, 'https://remote.example/new.jpg');
            assert.equal(merged.has('IGNORE-TOMBSTONE'), false);

            // Verify no leftover .tmp files
            const files = await fs.readdir(tmpDir);
            assert.equal(files.some(f => f.endsWith('.tmp')), false);
        } finally {
            await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
        }
    });
});
