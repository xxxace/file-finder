import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import esbuild from 'esbuild';
import sharp from 'sharp';
import { path as ffmpegPath } from '@ffmpeg-installer/ffmpeg';

const execFileAsync = promisify(execFile);

let tmpDir;
let thumbnail;

function assertIsWebP(buf, label) {
    assert.ok(Buffer.isBuffer(buf), `${label} should be a Buffer`);
    assert.ok(buf.length >= 12, `${label} should be at least 12 bytes`);
    assert.equal(buf.subarray(0, 4).toString('ascii'), 'RIFF', `${label} should start with RIFF`);
    assert.equal(buf.subarray(8, 12).toString('ascii'), 'WEBP', `${label} should have WEBP at offset 8..12`);
}

describe('thumbnail.ts WebP pipeline', () => {
    before(async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ff-thumb-test-'));
        const outfile = path.join(tmpDir, 'thumbnail.mjs');
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
        await esbuild.build({
            entryPoints: [path.resolve('electron/utils/thumbnail.ts')],
            bundle: true,
            platform: 'node',
            format: 'esm',
            plugins: [resolveFromRepo],
            outfile,
        });
        thumbnail = await import(pathToFileURL(outfile).href);
    });

    after(async () => {
        if (tmpDir) {
            await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
        }
    });

    it('1. converts a 2400x1600 PNG to WebP thumb (width 384) and WebP preview (long edge 2048)', async () => {
        const file = path.join(tmpDir, 'large.png');
        await sharp({
            create: {
                width: 2400,
                height: 1600,
                channels: 3,
                background: { r: 64, g: 128, b: 192 },
            },
        })
            .png()
            .toFile(file);

        const { thumb, preview } = await thumbnail.imageRenditions(file);
        assertIsWebP(thumb, 'thumb');
        assertIsWebP(preview, 'preview');

        const thumbMeta = await sharp(thumb).metadata();
        assert.equal(thumbMeta.width, 384);

        const previewMeta = await sharp(preview).metadata();
        assert.equal(Math.max(previewMeta.width, previewMeta.height), 2048);
    });

    it('2. keeps verbatim source JPEG when WebP q86 would be larger (size guard)', async () => {
        const width = 640;
        const height = 480;
        // High-frequency noise so q10 JPEG is much smaller than q86 WebP
        const pixels = Buffer.alloc(width * height * 3);
        for (let i = 0; i < pixels.length; i++) {
            pixels[i] = (i * 131 + (i >> 5) * 17) & 0xff;
        }
        const sourceJpegBuf = await sharp(pixels, { raw: { width, height, channels: 3 } })
            .jpeg({ quality: 10 })
            .toBuffer();

        const file = path.join(tmpDir, 'tiny-q10.jpg');
        await fs.writeFile(file, sourceJpegBuf);

        const { thumb, preview } = await thumbnail.imageRenditions(file);
        assertIsWebP(thumb, 'thumb');
        assert.ok(Buffer.isBuffer(preview), 'preview should be a Buffer');
        assert.equal(preview.equals(sourceJpegBuf), true, 'preview should equal verbatim source JPEG');
    });

    it('3. returns { thumb: null, preview: null } for non-existent file without throwing', async () => {
        const missing = path.join(tmpDir, 'does-not-exist-12345.jpg');
        const res = await thumbnail.imageRenditions(missing);
        assert.deepEqual(res, { thumb: null, preview: null });
    });

    it('4. falls back to ffmpeg transcode when sharp cannot decode input directly', async () => {
        // Generate a BMP via ffmpeg (sharp does not natively decode BMP) and give it a non-standard extension
        const srcPng = path.join(tmpDir, 'fallback-src.png');
        const bmpFile = path.join(tmpDir, 'fallback-image.weirdext');
        await sharp({
            create: {
                width: 800,
                height: 600,
                channels: 3,
                background: { r: 200, g: 100, b: 50 },
            },
        })
            .png()
            .toFile(srcPng);

        await execFileAsync(ffmpegPath, ['-y', '-i', srcPng, '-f', 'image2', '-vcodec', 'bmp', bmpFile]);

        const { thumb, preview } = await thumbnail.imageRenditions(bmpFile);
        assertIsWebP(thumb, 'fallback thumb');
        assertIsWebP(preview, 'fallback preview');

        const thumbMeta = await sharp(thumb).metadata();
        assert.equal(thumbMeta.width, 384);
    });
});
