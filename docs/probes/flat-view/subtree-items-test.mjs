import assert from 'node:assert/strict';
import test from 'node:test';
import * as esbuild from 'esbuild';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const outfile = path.join(here, '.tmp-nedb.mjs');

await esbuild.build({
    entryPoints: [path.join(repo, 'electron/server/nedb.ts')],
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
    mergeSubtreeLeafItems,
    findSubtreeLeafItems,
} = await import(pathToFileURL(outfile).href);

try {
    fs.unlinkSync(outfile);
} catch {}

test('mergeSubtreeLeafItems filters folders and flattens leaf items', () => {
    const mockRows = [
        // 1. Root directory itself
        {
            serial: 'AAAA1111',
            relPath: 'JAV',
            mode: 'cover',
            data: [
                { dir: 'JAV', name: '三上悠亚', type: 'folder', isDirectory: true },
                { dir: 'JAV', name: '河北彩花', type: 'folder', isDirectory: true },
                { dir: 'JAV', name: 'README', ext: 'txt', type: 'file', isDirectory: false },
            ],
        },
        // 2. Child directory 1
        {
            serial: 'AAAA1111',
            relPath: 'JAV/三上悠亚',
            mode: 'cover',
            data: [
                { dir: 'JAV/三上悠亚', name: 'SSNI-001', ext: 'mp4', type: 'video', isDirectory: false },
                { dir: 'JAV/三上悠亚', name: 'SSNI-002', ext: 'mp4', type: 'video', isDirectory: false },
                { dir: 'JAV/三上悠亚', name: 'sub-folder', type: 'folder', isDirectory: true },
            ],
        },
        // 3. Child directory 2
        {
            serial: 'AAAA1111',
            relPath: 'JAV/河北彩花',
            mode: 'cover',
            data: [
                { dir: 'JAV/河北彩花', name: 'IPX-123', ext: 'mp4', type: 'video', isDirectory: false },
            ],
        },
        // 4. Another drive (should be skipped)
        {
            serial: 'BBBB2222',
            relPath: 'JAV/三上悠亚',
            mode: 'cover',
            data: [
                { dir: 'JAV/三上悠亚', name: 'OTHER-999', ext: 'mp4', type: 'video', isDirectory: false },
            ],
        },
        // 5. Unrelated folder on same drive (should be skipped)
        {
            serial: 'AAAA1111',
            relPath: 'OTHER',
            mode: 'cover',
            data: [
                { dir: 'OTHER', name: 'NOPE-000', ext: 'mp4', type: 'video', isDirectory: false },
            ],
        },
    ];

    const result = mergeSubtreeLeafItems(mockRows, 'AAAA1111', 'JAV');
    const names = result.map(it => it.name);

    assert.deepEqual(names, ['SSNI-001', 'SSNI-002', 'IPX-123', 'README']);
    assert.equal(result.every(it => it.type !== 'folder' && !it.isDirectory), true);
});

test('mergeSubtreeLeafItems works with empty baseRel (disk root)', () => {
    const mockRows = [
        {
            serial: 'AAAA1111',
            relPath: '',
            mode: 'cover',
            data: [
                { dir: '', name: 'root-movie', ext: 'mp4', type: 'video', isDirectory: false },
                { dir: '', name: 'dir1', type: 'folder', isDirectory: true },
            ],
        },
        {
            serial: 'AAAA1111',
            relPath: 'dir1',
            mode: 'cover',
            data: [
                { dir: 'dir1', name: 'child-movie', ext: 'mp4', type: 'video', isDirectory: false },
            ],
        },
    ];

    const result = mergeSubtreeLeafItems(mockRows, 'AAAA1111', '');
    const names = result.map(it => it.name);
    assert.deepEqual(names, ['root-movie', 'child-movie']);
});

test('mergeSubtreeLeafItems preserves natural DFS flat order: [3,[1,2,4],[5,7],[6,8],9]', () => {
    const mockRows = [
        {
            serial: 'DISK1',
            relPath: 'root',
            mode: 'cover',
            data: [
                { dir: 'root', name: '3', ext: 'mp4', type: 'video', isDirectory: false },
                { dir: 'root', name: 'folderA', type: 'folder', isDirectory: true },
                { dir: 'root', name: 'folderB', type: 'folder', isDirectory: true },
                { dir: 'root', name: 'folderC', type: 'folder', isDirectory: true },
                { dir: 'root', name: '9', ext: 'mp4', type: 'video', isDirectory: false },
            ],
        },
        {
            serial: 'DISK1',
            relPath: 'root/folderA',
            mode: 'cover',
            data: [
                { dir: 'root/folderA', name: '1', ext: 'mp4', type: 'video', isDirectory: false },
                { dir: 'root/folderA', name: '2', ext: 'mp4', type: 'video', isDirectory: false },
                { dir: 'root/folderA', name: '4', ext: 'mp4', type: 'video', isDirectory: false },
            ],
        },
        {
            serial: 'DISK1',
            relPath: 'root/folderB',
            mode: 'cover',
            data: [
                { dir: 'root/folderB', name: '5', ext: 'mp4', type: 'video', isDirectory: false },
                { dir: 'root/folderB', name: '7', ext: 'mp4', type: 'video', isDirectory: false },
            ],
        },
        {
            serial: 'DISK1',
            relPath: 'root/folderC',
            mode: 'cover',
            data: [
                { dir: 'root/folderC', name: '6', ext: 'mp4', type: 'video', isDirectory: false },
                { dir: 'root/folderC', name: '8', ext: 'mp4', type: 'video', isDirectory: false },
            ],
        },
    ];

    const result = mergeSubtreeLeafItems(mockRows, 'DISK1', 'root');
    const names = result.map(it => it.name);
    // User expectation: 3, 1, 2, 4, 5, 7, 6, 8, 9 (NOT sorted 1, 2, 3...)
    assert.deepEqual(names, ['3', '1', '2', '4', '5', '7', '6', '8', '9']);
});

test('mergeSubtreeLeafItems deduplicates by path and disk name', () => {
    const mockRows = [
        {
            serial: 'AAAA1111',
            relPath: 'JAV',
            mode: 'cover',
            data: [
                { dir: 'JAV/三上悠亚', name: 'SSNI-001', ext: 'mp4', type: 'video', isDirectory: false },
            ],
        },
        {
            serial: 'AAAA1111',
            relPath: 'JAV/三上悠亚',
            mode: 'cover',
            data: [
                { dir: 'JAV/三上悠亚', name: 'SSNI-001', ext: 'mp4', type: 'video', isDirectory: false },
            ],
        },
    ];

    const result = mergeSubtreeLeafItems(mockRows, 'AAAA1111', 'JAV');
    assert.equal(result.length, 1);
});
