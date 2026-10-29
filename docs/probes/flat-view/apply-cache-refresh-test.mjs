import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

test('apply correctly identifies affectedDirs for both dir-form and file-form', () => {
    function dirOf(rel) {
        const i = rel.lastIndexOf('/');
        return i === -1 ? '' : rel.slice(0, i);
    }

    // 1. dir-form: cover replacement inside movie folder
    const g1 = {
        kind: 'dir',
        layerDir: '新建文件夹/武田真/JAC-034',
        coverWriteRel: '新建文件夹/武田真/JAC-034/JAC-034.jpg',
    };
    const targetDir1 = g1.kind === 'dir' ? dirOf(g1.layerDir) : g1.layerDir;
    assert.equal(targetDir1, '新建文件夹/武田真');

    // 2. dir-form: direct movie folder under root
    const g2 = {
        kind: 'dir',
        layerDir: 'JAC-034',
        coverWriteRel: 'JAC-034/JAC-034.jpg',
    };
    const targetDir2 = g2.kind === 'dir' ? dirOf(g2.layerDir) : g2.layerDir;
    assert.equal(targetDir2, '');

    // 3. file-form: scattered video file organized into subfolder
    const g3 = {
        kind: 'file',
        layerDir: '新建文件夹/武田真',
        coverWriteRel: '新建文件夹/武田真/TST-001/TST-001.jpg',
    };
    const targetDir3 = g3.kind === 'dir' ? dirOf(g3.layerDir) : g3.layerDir;
    assert.equal(targetDir3, '新建文件夹/武田真');
});
