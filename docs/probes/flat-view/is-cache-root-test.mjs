import assert from 'node:assert/strict';
import test from 'node:test';
import * as esbuild from 'esbuild';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const outfile = path.join(here, '.tmp-is-root.mjs');

await esbuild.build({
    entryPoints: [path.join(repo, 'electron/server/nedb.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile,
    logLevel: 'silent',
    packages: 'external',
    alias: {
        electron: path.join(repo, 'docs/probes/electron-stub.mjs'),
    },
});

const { checkIsCacheRoot } = await import(pathToFileURL(outfile).href);
try { fs.unlinkSync(outfile); } catch {}

test('checkIsCacheRoot correctly identifies true collection roots vs subfolders', () => {
    const cachedPaths = [
        'download/videos',
        'download/videos/愛川すず',
        'download/videos/待处理',
        'download/videos/結城モナ',
        'videos',
        'videos/安齋らら',
        'videos/北嶋あん',
    ];

    // 1. download/videos is a true root
    assert.equal(checkIsCacheRoot(cachedPaths, 'download/videos'), true);

    // 2. download/videos/愛川すず is an actress folder -> not a root
    assert.equal(checkIsCacheRoot(cachedPaths, 'download/videos/愛川すず'), false);

    // 3. videos is a true root
    assert.equal(checkIsCacheRoot(cachedPaths, 'videos'), true);

    // 4. videos/安齋らら is an actress folder -> not a root
    assert.equal(checkIsCacheRoot(cachedPaths, 'videos/安齋らら'), false);

    // 5. movie folder (not in cache or leaf) -> not a root
    assert.equal(checkIsCacheRoot(cachedPaths, 'download/videos/愛川すず/SIRO-4519'), false);
    assert.equal(checkIsCacheRoot(cachedPaths, 'videos/安齋らら/SSNI-001'), false);
});
