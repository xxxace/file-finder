import assert from 'node:assert/strict';
import test from 'node:test';
import * as esbuild from 'esbuild';
import path from 'node:path';
import os from 'node:os';
import { mkdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const outfile = path.join(here, '.tmp-gfriends.mjs');

await esbuild.build({
    entryPoints: [path.join(repo, 'electron/server/assistant/gfriends.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile,
    logLevel: 'silent',
    external: ['electron'],
});

const {
    cleanActressName,
    normalizeChineseKana,
    matchGfriends,
    getAvatarUrl,
    flattenFiletree,
} = await import(pathToFileURL(outfile).href);

try {
    const fs = await import('node:fs');
    fs.unlinkSync(outfile);
} catch {}

test('cleanActressName removes multiple tags, full-width brackets, and years', () => {
    assert.equal(cleanActressName('[S1] 三上悠亚 (2020)'), '三上悠亚');
    assert.equal(cleanActressName('河北彩花 [4K]'), '河北彩花');
    assert.equal(cleanActressName('【唯美】桥本有菜'), '桥本有菜');
    assert.equal(cleanActressName('三上悠亚（2020）'), '三上悠亚');
    assert.equal(cleanActressName('（独家）三上悠亚'), '三上悠亚');
    assert.equal(cleanActressName('[S1] [4K] 三上悠亚'), '三上悠亚');
    assert.equal(cleanActressName('三上悠亚 [S1] (2020)'), '三上悠亚');
    assert.equal(cleanActressName('  三上悠亜  '), '三上悠亜');
    assert.equal(cleanActressName('SSNI-001'), ''); // pure movie code should be rejected
    assert.equal(cleanActressName('12345'), ''); // pure number should be rejected
});

test('matchGfriends finds actress in index with alias/kanji mapping', () => {
    const mockIndex = {
        version: '1.0',
        updatedAt: Date.now(),
        actors: {
            '三上悠亜': 'Content/S/三上悠亜.jpg',
            '河北彩花': 'Content/K/河北彩花.jpg',
            '橋本ありな': 'Content/H/橋本ありな.jpg',
        },
    };

    // Direct match
    const hit1 = matchGfriends('三上悠亜', mockIndex);
    assert.ok(hit1);
    assert.equal(hit1.matchedName, '三上悠亜');
    assert.equal(hit1.avatarPath, 'Content/S/三上悠亜.jpg');

    // Simplified to Traditional Kanji match
    const hit2 = matchGfriends('三上悠亚', mockIndex);
    assert.ok(hit2);
    assert.equal(hit2.matchedName, '三上悠亜');

    // Alias mapping match (桥本有菜 -> 橋本ありな)
    const hitAlias = matchGfriends('桥本有菜', mockIndex);
    assert.ok(hitAlias);
    assert.equal(hitAlias.matchedName, '橋本ありな');

    // Unmatched
    const hit3 = matchGfriends('未知路人甲', mockIndex);
    assert.equal(hit3, null);
});

test('getAvatarUrl generates valid CDN urls', () => {
    const path = 'Content/S/三上悠亜.jpg';
    const url0 = getAvatarUrl(path, 0);
    assert.ok(url0.includes('fastly.jsdelivr.net'));
    assert.ok(decodeURIComponent(url0).includes('三上悠亜'));

    const url1 = getAvatarUrl(path, 1);
    assert.ok(url1.includes('cdn.jsdelivr.net'));

    const url2 = getAvatarUrl(path, 2);
    assert.ok(url2.includes('raw.githubusercontent.com'));
});

test('flattenFiletree preserves directory path and strips query params from Gfriends tree', () => {
    const mockTree = {
        Content: {
            'z-ラグジュTV': {
                '黒瀬萌衣.jpg': 'AI-Fix-黒瀬萌衣.jpg?t=1607433809',
            },
            'S': {
                '三上悠亜.jpg': '三上悠亜.jpg?t=1607433809',
            },
        },
    };

    const actors = {};
    flattenFiletree(mockTree, '', actors);

    assert.equal(actors['黒瀬萌衣'], 'Content/z-ラグジュTV/AI-Fix-黒瀬萌衣.jpg');
    assert.equal(actors['三上悠亜'], 'Content/S/三上悠亜.jpg');

    const url = getAvatarUrl(actors['黒瀬萌衣'], 0);
    assert.ok(url.includes('Content/z-%E3%83%A9%E3%82%B0%E3%82%B8%E3%83%A5TV/'));
    assert.ok(!url.includes('%3Ft'));
});
