/**
 * 探针 · 找缺封面的分类规则（真代码 + 夹具）
 * ===========================================================================
 * 一行复跑：`node docs/probes/scan-rules/run.mjs`
 *
 * 做法：用 esbuild 把**真实的** `electron/server/assistant/scan.ts` 打包成 ESM，
 * 只把它的 `../nedb` 解析到一个读夹具 JSON 的桩上（`stub-nedb.mjs`），
 * 然后喂假缓存文档、断言输出的目标清单。
 * → 验的是真分类逻辑，不是它的复制品。
 */
import * as esbuild from 'esbuild';
import path from 'node:path';
import os from 'node:os';
import { mkdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const entry = path.join(repo, 'electron/server/assistant/scan.ts');
const stub = path.join(here, 'stub-nedb.mjs');

const outDir = path.join(os.tmpdir(), 'ff-scan-probe');
mkdirSync(outDir, { recursive: true });
const outfile = path.join(outDir, 'scan.mjs');

await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile,
    logLevel: 'silent',
    plugins: [
        {
            name: 'stub-nedb',
            setup(build) {
                build.onResolve({ filter: /^\.\.\/nedb$/ }, () => ({ path: stub }));
            },
        },
    ],
});

process.env.FF_SCAN_FIXTURE = path.join(here, 'fixture.json');
const { scanMissingCovers } = await import(pathToFileURL(outfile).href);

/** 把目标压成 "writeRel (kind)" 便于比对 */
const flat = r => r.targets.map(t => `${t.writeRel} [${t.kind}]`);

// ── 用例 1：扫整个 film 层 ────────────────────────────────────────────────
const r1 = await scanMissingCovers('SERIAL01', 'film');
assert.deepEqual(flat(r1), [
    'film/TST-218.jpg [file]',            // 裸视频 → 同名 jpg
    'film/SSIS-001/SSIS-001.jpg [dir]',       // 没脸影片目录 → 目录的同名封面（用户拍板：与文件夹同名，cover.jpg 是保留名）
    'film/ABP-123/ABP-123.jpg [dir]',        // 没扫过的没脸目录 → 仍给目标（hasVideo 未知）
    'film/TST-088/TST-088.jpg [dir]',        // 影片目录里的**分卷**（名字解析不出）也只算一个目标
    'film/合集/AAA-001/AAA-001.jpg [dir]',   // 分类目录的**子**影片目录照样补（不是给分类自己塞脸）
    'film/合集/BBB-002/BBB-002.jpg [dir]',
], '用例1 目标清单不对');

assert.equal(r1.skippedCategory, 1, '用例1 分类目录应为 1（合集本身不该被塞脸）');
assert.deepEqual(
    r1.unmatched,
    [{ dir: 'film', name: '新建文件夹' }],
    '用例1 "认不出番号"只应列出新建文件夹（它不是失败清单，是另一类问题）',
);

// 回归锁（真机实测暴露的顺序缺陷，2026-09-25）：
// `film/TST-088/` 里是 `TST-088A_FHD` / `TST-088B_FHD`。目录名本身就是番号，
// 分卷名解析不出**是正常的**（分卷要折进目录的脸）。修复前这两个会同时：
//   · 产出 film/TST-088/TST-088.jpg 目标  · 又被报进 unmatched
// 一个文件两种身份 = 自相矛盾的清单。这条断言锁住"容器判断先于条目判断"。
const uw = r1.unmatched.map(u => u.name);
assert.ok(!uw.includes('TST-088A_FHD'), '分卷名不该进 unmatched（目录名已是番号）');
assert.ok(!uw.includes('TST-088B_FHD'), '分卷名不该进 unmatched（目录名已是番号）');
assert.equal(
    r1.targets.filter(t => t.writeRel === 'film/TST-088/TST-088.jpg').length,
    1,
    '两个分卷只应汇成 1 个目录目标',
);

// 不该出现的东西
const all = r1.targets.map(t => t.writeRel).join('\n');
for (const bad of ['MIAA-111', 'SSNI-777', 'HAS-FACE', 'ZZZ-001', 'YYY-001', '新建文件夹']) {
    assert.ok(!all.includes(bad), `用例1 不该出现 ${bad}`);
}

// kind:'dir' 的目标写在**目标目录自己的**路径下；dir 字段是它的父目录
const ssis = r1.targets.find(t => t.writeRel === 'film/SSIS-001/SSIS-001.jpg');
assert.equal(ssis.dir, 'film', 'SSIS-001 的 dir 应为父目录 film');
assert.equal(ssis.name, 'SSIS-001');
assert.equal(ssis.hasVideo, true, 'SSIS-001 已扫过、里面有视频 → hasVideo 应为 true');

const abp = r1.targets.find(t => t.writeRel === 'film/ABP-123/ABP-123.jpg');
assert.equal(abp.hasVideo, undefined, 'ABP-123 从没扫过 → hasVideo 应为 undefined');

// ── 用例 2：直接扫某个影片目录本身（用户在片子里点"找缺封面"）────────────
const r2 = await scanMissingCovers('SERIAL01', 'film/SSIS-001');
assert.deepEqual(flat(r2), ['film/SSIS-001/SSIS-001.jpg [dir]'], '用例2 应只给目录的脸，同名封面文件（cover.jpg 已弃用）');

// ── 用例 3：范围外 / 其它盘一律不受影响 ──────────────────────────────────
const r3 = await scanMissingCovers('SERIAL01', 'other');
assert.deepEqual(flat(r3), ['other/ZZZ-001.jpg [file]'], '用例3 应只看 other');

console.log('✅ scan-rules 全部通过（3 个用例）');
