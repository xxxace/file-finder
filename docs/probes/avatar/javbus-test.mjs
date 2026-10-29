import assert from 'node:assert/strict';
import test from 'node:test';
import * as esbuild from 'esbuild';
import path from 'node:path';
import os from 'node:os';
import * as fsasync from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const outfile = path.join(here, '.tmp-javbus.mjs');

await esbuild.build({
    entryPoints: [path.join(repo, 'electron/server/assistant/javbus.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile,
    logLevel: 'silent',
    alias: {
        electron: path.join(repo, 'docs/probes/electron-stub.mjs'),
    },
    external: ['@seald-io/nedb', 'fluent-ffmpeg'],
});

const {
    parseJavBusSearchHtml,
    toKanjiQuery,
    readJavBusCache,
    writeJavBusCache,
} = await import(pathToFileURL(outfile).href);

try {
    const fs = await import('node:fs');
    fs.unlinkSync(outfile);
} catch {}

test('parseJavBusSearchHtml extracts exact actress avatar from search HTML', () => {
    const sampleHtml = `
    <div class="row">
        <a class="avatar-box text-center" href="https://www.javbus.com/star/ok8">
            <div class="photo-frame">
                <img src="/pics/actress/ok8_a.jpg" title="三上悠亜">
            </div>
            <span>三上悠亜</span>
        </a>
        <a class="avatar-box text-center" href="https://www.javbus.com/star/9za">
            <div class="photo-frame">
                <img src="https://www.javbus.com/pics/actress/9za_a.jpg" title="河北彩花">
            </div>
            <span>河北彩花</span>
        </a>
    </div>
    `;

    const match1 = parseJavBusSearchHtml(sampleHtml, '三上悠亜');
    assert.ok(match1);
    assert.equal(match1.matchedName, '三上悠亜');
    assert.equal(match1.starId, 'ok8');
    assert.equal(match1.avatarUrl, 'https://www.javbus.com/pics/actress/ok8_a.jpg');

    const match2 = parseJavBusSearchHtml(sampleHtml, '河北彩花');
    assert.ok(match2);
    assert.equal(match2.matchedName, '河北彩花');
    assert.equal(match2.starId, '9za');
    assert.equal(match2.avatarUrl, 'https://www.javbus.com/pics/actress/9za_a.jpg');

    const matchNone = parseJavBusSearchHtml(sampleHtml, '波多野结衣');
    assert.equal(matchNone, null);
});

test('toKanjiQuery maps simplified Chinese to Japanese Kanji for JavBus query', () => {
    assert.equal(toKanjiQuery('三上悠亚'), '三上悠亜');
    assert.equal(toKanjiQuery('相泽南'), '相沢南');
    assert.equal(toKanjiQuery('波多野结衣'), '波多野結衣');
    assert.equal(toKanjiQuery('高桥圣子'), '高橋聖子');
});

test('readJavBusCache and writeJavBusCache persist results to disk', async () => {
    const tmpDir = await fsasync.mkdtemp(path.join(os.tmpdir(), 'ff-javbus-test-'));
    const initial = await readJavBusCache(tmpDir);
    assert.deepEqual(initial, {});

    await writeJavBusCache(tmpDir, {
        '三上悠亜': {
            matchedName: '三上悠亜',
            avatarUrl: 'https://www.javbus.com/pics/actress/ok8_a.jpg',
            starId: 'ok8',
            updatedAt: Date.now(),
        },
    });

    const loaded = await readJavBusCache(tmpDir);
    assert.equal(loaded['三上悠亜']?.avatarUrl, 'https://www.javbus.com/pics/actress/ok8_a.jpg');

    await fsasync.rm(tmpDir, { recursive: true, force: true });
});
