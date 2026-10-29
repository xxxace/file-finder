import assert from 'node:assert/strict';
import test from 'node:test';
import * as esbuild from 'esbuild';
import path from 'node:path';
import os from 'node:os';
import { mkdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const outfile = path.join(here, '.tmp-avatarScan.mjs');

await esbuild.build({
    entryPoints: [path.join(repo, 'electron/server/assistant/avatarScan.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile,
    logLevel: 'silent',
    alias: {
        electron: path.join(repo, 'docs/probes/electron-stub.mjs'),
    },
    external: ['@seald-io/nedb'],
});

const {
    filterAndMatchCandidates,
} = await import(pathToFileURL(outfile).href);

// Clean up temporary bundle
try {
    const fs = await import('node:fs');
    fs.unlinkSync(outfile);
} catch {}

test('filterAndMatchCandidates filters folders and matches against Gfriends', () => {
    const mockEntries = [
        // 1. Valid actress folder without avatar
        { dir: 'JAV', name: '三上悠亚', type: 'folder', isDirectory: true, size: 0 },
        // 2. Movie code folder without avatar -> must be filtered out
        { dir: 'JAV', name: 'SSNI-001', type: 'folder', isDirectory: true, size: 0 },
        // 3. Movie code with suffix -> must be filtered out
        { dir: 'JAV', name: 'IPX-123-C', type: 'folder', isDirectory: true, size: 0 },
        // 4. Folder that already has an avatar (sig has value) -> must be filtered out
        { dir: 'JAV', name: '河北彩花', type: 'folder', isDirectory: true, size: 0, sig: 'some-hash' },
        // 5. Video file -> must be filtered out
        { dir: 'JAV', name: 'TST-001', type: 'video', isDirectory: false, size: 1000 },
        // 6. Valid actress with brackets
        { dir: 'JAV', name: '[S1] 桥本有菜 (2020)', type: 'folder', isDirectory: true, size: 0 },
        // 7. Unknown actress
        { dir: 'JAV', name: '未知路人', type: 'folder', isDirectory: true, size: 0 },
    ];

    const mockIndex = {
        version: '1.0',
        updatedAt: Date.now(),
        actors: {
            '三上悠亜': 'Content/S/三上悠亜.jpg',
            '橋本ありな': 'Content/H/橋本ありな.jpg',
        },
    };

    const candidates = filterAndMatchCandidates('JAV', mockEntries, mockIndex);

    // Only "三上悠亚", "[S1] 桥本有菜 (2020)", and "未知路人" should be candidates
    assert.equal(candidates.length, 3);

    const c1 = candidates.find(c => c.folderName === '三上悠亚');
    assert.ok(c1);
    assert.equal(c1.cleanName, '三上悠亚');
    assert.equal(c1.status, 'matched');
    assert.equal(c1.matchedName, '三上悠亜');
    assert.ok(c1.avatarUrl.includes('fastly.jsdelivr.net'));

    const c2 = candidates.find(c => c.folderName === '[S1] 桥本有菜 (2020)');
    assert.ok(c2);
    assert.equal(c2.cleanName, '桥本有菜');
    assert.equal(c2.status, 'matched');
    assert.equal(c2.matchedName, '橋本ありな');

    const c3 = candidates.find(c => c.folderName === '未知路人');
    assert.ok(c3);
    assert.equal(c3.cleanName, '未知路人');
    assert.equal(c3.status, 'unmatched');
    assert.equal(c3.matchedName, null);
    assert.equal(c3.avatarUrl, null);
});
