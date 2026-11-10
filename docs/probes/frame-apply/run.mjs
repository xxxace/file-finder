/**
 * 抽帧 · 写盘分组探针
 *
 * 跑法：node docs/probes/frame-apply/run.mjs
 * 手法同 ../faces/verify.mjs：esbuild 打包**真源文件**，electron 用替身顶掉。
 *
 * 只测一件最容易错、错了会写坏盘的事（计划里的 Review Focus 1）：
 *   **8 个分卷的卡抽一次帧，写盘时必须仍是 1 组、8 个 srcRel 全在。**
 * 少一个 srcRel 就是"封面写好了、7 个视频还躺在外面" —— 用户看到的是文件夹里只有一部。
 */
import { build } from 'esbuild';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const stubPath = path.resolve(repo, 'docs/probes/faces/electron-stub.mjs');

let pass = 0, fail = 0;
const check = (label, ok, detail = '') => {
    ok ? pass++ : fail++;
    console.log(`  ${ok ? '✅' : '❌'} ${label}${ok || !detail ? '' : ` — ${detail}`}`);
};

async function load(entry, tag) {
    const cacheDir = path.join(repo, 'node_modules/.cache');
    await fsp.mkdir(cacheDir, { recursive: true });
    const outfile = path.join(cacheDir, `${tag}-${Date.now()}.mjs`);
    await build({
        entryPoints: [path.join(repo, entry)],
        bundle: true, platform: 'node', format: 'esm', target: 'node22',
        outfile, logLevel: 'silent', packages: 'external',
        alias: { electron: stubPath },
    });
    return import(pathToFileURL(outfile).href);
}

/** 一行抽帧结果（`FrameRow`）：coverUrl 恒 null，字节来自 frameFile */
const frameRow = (o) => ({
    writeRel: '', query: '', hitSite: null, coverUrl: null, title: null, actresses: [],
    status: 'ok', message: '', frame: true, frameFile: 'abc123abc123abcd_a0_p1_s0_nx1.jpg',
    pct: 1, attempt: 0, skipped: 0, ...o,
});

async function main() {
    const { buildGroups } = await load('electron/server/assistant/apply.ts', 'ff-frame-apply');

    // ── 8 个分卷、一张卡、一份帧 ─────────────────────────────
    const rels = ['-A', '-B', '-C', '-1', '-2', '-3', '-4', '-5']
        .map(s => `ACT/${s}.mp4`);
    const rows = rels.map((src, i) => frameRow({
        writeRel: `ACT/TST-001-${i}.jpg`,
        query: 'TST-001',
        kind: 'file',
        name: `TST-001${i}`,
        srcRel: src,
    }));

    const groups = buildGroups(rows);
    check('8 个分卷 → **1 组**（同层同番号收拢）', groups.length === 1, `got ${groups.length}`);

    const g = groups[0] ?? {};
    check('8 个 srcRel **一个不少**', (g.srcRels || []).length === 8, `got ${(g.srcRels || []).length}`);
    check('封面路径 = 番号文件夹同名图', g.coverWriteRel === 'ACT/TST-001/TST-001.jpg', String(g.coverWriteRel));
    check('整组共用同一份帧缓存', g.frameFile === frameRow({}).frameFile, String(g.frameFile));
    check('帧行不被 URL 门槛挡掉（coverUrl 为 null 也要进组）', groups.length > 0);
    check('文件形态仍标记为要搬卷', g.kind === 'file' && g.folderRel === 'ACT/TST-001');

    // ── 目录形态的帧行：只写封面、不搬东西 ───────────────────
    const dirGroups = buildGroups([
        frameRow({ writeRel: 'ACT/TST-002/TST-002.jpg', query: 'TST-002', kind: 'dir', name: 'TST-002' }),
    ]);
    check('目录形态 → 1 组、不搬任何文件', dirGroups.length === 1 && dirGroups[0].srcRels.length === 0);
    check('目录形态 `overwrite:false`（写的是新文件，不备份）', dirGroups[0]?.overwrite === false);
    check('目录形态也带上 frameFile', !!dirGroups[0]?.frameFile);

    // ── 站点行与帧行混在一批：各走各的字节来源，互不污染 ─────
    const siteRow = {
        writeRel: 'ACT/TST-004.jpg', query: 'TST-004', kind: 'dir', name: 'TST-004',
        hitSite: 'x', coverUrl: 'https://example.invalid/a.jpg', title: null, actresses: [],
        status: 'ok', message: '',
    };
    const mixed = buildGroups([
        frameRow({ writeRel: 'ACT/TST-003.jpg', query: 'TST-003', kind: 'dir', name: 'TST-003' }),
        siteRow,
    ]);
    check('混批 → 2 组', mixed.length === 2, `got ${mixed.length}`);
    check('帧行那组带 frameFile', mixed.some(x => !!x.frameFile));
    check('没有 frameFile 的行 → 仍走 URL（不被帧分支吞掉）', mixed.some(x => x.frameFile === null && x.coverUrl));

    console.log(`\nframe-apply probe: ${pass} passed, ${fail} failed`);
    if (fail) process.exit(1);
}

main();
