import assert from 'node:assert/strict';
import test from 'node:test';
import * as esbuild from 'esbuild';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';

process.env.NODE_ENV = 'test';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const outfile = path.join(here, '.tmp-server-flat.mjs');

await esbuild.build({
    entryPoints: [path.join(repo, 'electron/server/index.ts')],
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

const { openFolderController } = await import(pathToFileURL(outfile).href);

try {
    fs.unlinkSync(outfile);
} catch {}

test('openFolderController is exported and handles flat=true query param', async () => {
    assert.equal(typeof openFolderController, 'function');

    let responseData = null;
    let statusCode = 200;

    const mockRes = {
        writeHead(status) {
            statusCode = status;
        },
        end(chunk) {
            responseData = JSON.parse(chunk);
        },
    };

    const mockReq = {
        params: new URLSearchParams('path=#NONEXISTENT/test&flat=true'),
    };

    // Non-root anchor with flat=true must NOT be flattened, should fall through to normal read and fail with notCached
    await assert.rejects(
        async () => {
            await openFolderController(mockReq, mockRes);
        },
        (err) => err?.kind === 'notCached'
    );
});
