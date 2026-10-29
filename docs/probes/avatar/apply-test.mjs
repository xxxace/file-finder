import assert from 'node:assert/strict';
import test from 'node:test';
import * as esbuild from 'esbuild';
import path from 'node:path';
import os from 'node:os';
import * as fsasync from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const outfile = path.join(here, '.tmp-avatarApply.mjs');

await esbuild.build({
    entryPoints: [path.join(repo, 'electron/server/assistant/avatarApply.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile,
    logLevel: 'silent',
    alias: {
        electron: path.join(repo, 'docs/probes/electron-stub.mjs'),
    },
    external: ['@seald-io/nedb', 'fluent-ffmpeg', '@ffmpeg-installer/ffmpeg', '@ffprobe-installer/ffprobe'],
});

const {
    applyActressAvatars,
    saveAvatarFile,
} = await import(pathToFileURL(outfile).href);

try {
    const fs = await import('node:fs');
    fs.unlinkSync(outfile);
} catch {}

test('applyActressAvatars rejects offline drives', async () => {
    // Non-existent serial
    const res = await applyActressAvatars('OFFLINE99', [{ relDir: 'JAV/Test', avatarUrl: 'http://example.com/1.jpg' }], os.tmpdir());
    assert.equal(res.succeeded, 0);
    assert.equal(res.failed, 1);
    assert.ok(res.logs[0].message.includes('离线'));
});

test('saveAvatarFile writes avatar.jpg atomically and creates backup if existing', async () => {
    const testDir = await fsasync.mkdtemp(path.join(os.tmpdir(), 'ff-test-avatar-'));
    const targetDir = path.join(testDir, '三上悠亚');
    await fsasync.mkdir(targetDir, { recursive: true });

    const avatarPath = path.join(targetDir, 'avatar.jpg');
    // Pre-create an old avatar to test backup
    await fsasync.writeFile(avatarPath, Buffer.from('old-image-bytes'));

    // New jpeg bytes (FF D8 FF)
    const newBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
    const dataDir = path.join(testDir, 'data');

    const ok = await saveAvatarFile('TEST0001', 'JAV/三上悠亚', targetDir, newBytes, dataDir);
    assert.equal(ok, true);

    // Verify avatar.jpg was updated
    const written = await fsasync.readFile(avatarPath);
    assert.deepEqual(written, newBytes);

    // Verify backup was created
    const backupPath = path.join(dataDir, 'backups', 'TEST0001', 'JAV/三上悠亚', 'avatar.jpg');
    const backupContent = await fsasync.readFile(backupPath, 'utf8');
    assert.equal(backupContent, 'old-image-bytes');

    await fsasync.rm(testDir, { recursive: true, force: true });
});
