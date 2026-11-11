import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');

console.log('=== Probe: Tunnel Covers Aggregation (Task 1) ===\n');

const outfile = path.join(here, 'tmp-nedb-bundle.mjs');

await esbuild.build({
    entryPoints: [path.join(repo, 'electron/server/nedb.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile,
    logLevel: 'silent',
    external: ['@seald-io/nedb', 'node:*', 'crypto', 'path', 'os', 'dayjs'],
});

const { collectTunnelCovers } = await import(pathToFileURL(outfile).href);

if (typeof collectTunnelCovers !== 'function') {
    console.error('FAIL: collectTunnelCovers is not a function');
    process.exit(1);
}

// 1. Mock rows
const mockRows = [
    {
        serial: 'SER1',
        relPath: 'Movies/Action',
        data: [
            { name: 'Film A', dir: 'Movies/Action', sig: 'aaa111', type: 'video', isDirectory: false },
            { name: 'SubDir', dir: 'Movies/Action', type: 'folder', isDirectory: true }, // should be excluded
            { name: 'NoSig', dir: 'Movies/Action', type: 'video', isDirectory: false }, // should be excluded
        ],
    },
    {
        serial: 'SER1',
        relPath: 'Movies/Comedy',
        data: [
            { name: 'Film B', dir: 'Movies/Comedy', sig: 'bbb222', type: 'video', isDirectory: false },
            { name: 'Film A', dir: 'Movies/Action', sig: 'aaa111', type: 'video', isDirectory: false }, // duplicate should be deduped
        ],
    },
    {
        serial: 'SER2',
        relPath: 'Series/Drama',
        data: [
            { name: 'Episode 1', dir: 'Series/Drama', sig: 'ccc333', type: 'video', isDirectory: false },
            { name: 'MissingBin', dir: 'Series/Drama', sig: 'missing', type: 'video', isDirectory: false }, // missing from binStore should be excluded
        ],
    },
];

const mockHasBin = (name) => {
    return name === 't-aaa111.enc' || name === 't-bbb222.enc' || name === 't-ccc333.enc';
};

// Test A: All disks
const all = collectTunnelCovers(mockRows, mockHasBin);
assert.strictEqual(all.length, 3, 'Should collect 3 valid items across all disks');
assert.deepStrictEqual(all.map(x => x.name), ['Film A', 'Film B', 'Episode 1']);
console.log('PASS: Test A (All disks aggregation & deduplication)');

// Test B: Filter by disk serial
const ser1Only = collectTunnelCovers(mockRows, mockHasBin, 'SER1');
assert.strictEqual(ser1Only.length, 2, 'Should filter by SER1 only');
assert.deepStrictEqual(ser1Only.map(x => x.name), ['Film A', 'Film B']);
console.log('PASS: Test B (Filter by serial)');

// Test C: Exclude folder and missing bin
const ser2Only = collectTunnelCovers(mockRows, mockHasBin, 'SER2');
assert.strictEqual(ser2Only.length, 1, 'Should exclude missing bin and folders');
assert.strictEqual(ser2Only[0].name, 'Episode 1');
console.log('PASS: Test C (Exclude folder and missing bin)');

console.log('\nAll assertions passed!');
