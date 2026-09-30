/**
 * 探针 · 番号解析现状（真代码 `match.ts`，先打印后断言）
 * 一行复跑：`node docs/probes/parse-title/run.mjs`
 */
import * as esbuild from 'esbuild';
import path from 'node:path';
import os from 'node:os';
import { mkdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const outDir = path.join(os.tmpdir(), 'ff-parse-title-probe');
mkdirSync(outDir, { recursive: true });
const outfile = path.join(outDir, 'match.mjs');

await esbuild.build({
    entryPoints: [path.join(repo, 'electron/server/assistant/match.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile,
    logLevel: 'silent',
});

const { parseTitle } = await import(pathToFileURL(outfile).href);

/** [输入, 期望 id（'' = 应当认不出）, 备注] */
const CASES = [
    // ── 来自用户 2026-09-25 真机自测日志的真实文件名 ──
    ['tst64 - 示例片商', '', '真机日志：无番号的作品名'],
    ['FC2-PPV-1000001', 'FC2-PPV-1000001', '真机日志：FC2 多段番号'],
    ['tst26 - 示例片商', '', '真机日志：无番号的作品名'],
    ['TST-560', 'TST-560', '真机日志：命中'],
    ['TST-1127', 'TST-1127', '真机日志：命中'],

    // ── 标准与常见变体 ──
    ['TST-218', 'TST-218', '标准'],
    ['ABC-123', 'ABC-123', '标准'],
    ['[javbus] abp-123 4K', 'ABP-123', '带站名前后缀'],
    ['SSIS-001 CD1', 'SSIS-001', '分卷 CD1'],
    ['ABC-123-CD2', 'ABC-123', '分卷 CD2'],
    ['ABC-123 part2', 'ABC-123', '分卷 part2'],
    // ── 用户 2026-09-25 点名的两种分卷形态：必须归一到同一番号（一部片只发一次请求）──
    ['AAA-123-A', 'AAA-123', '分卷字母后缀 -A/-B'],
    ['AAA-123-B', 'AAA-123', '分卷字母后缀 -A/-B'],
    ['TST-014-01', 'TST-014', '分卷两位数字后缀 -01…-08'],
    ['TST-014-08', 'TST-014', '分卷两位数字后缀 -01…-08'],

    // ── 无分隔 / 特殊前缀系列（真实存在）──
    ['SSIS001', '', '连写无分隔 → 一律不识别（宁可漏不可错，见 match.ts 注释）'],
    ['HEYZO-1234', 'HEYZO-1234', 'HEYZO 系列'],
    ['SIRO-4321', 'SIRO-4321', 'SIRO 系列'],
    ['1PONDO-100001_001', '1PONDO-100001', '数字开头 + 下划线段'],
    ['200GANA-1001', '200GANA-1001', 'GANA 系列'],
    ['FC2PPV-1000001', 'FC2-PPV-1000001', 'FC2 连写变体'],

    // ── 应当认不出（没有番号）──
    ['无番号的片子', '', '纯中文'],
    ['示例片商 精选', '', '系列名'],
    ['新建文件夹', '', '中文目录名'],
];

let bad = 0;
const rows = CASES.map(([input, want, note]) => {
    const got = parseTitle(input).id;
    const ok = got === want;
    if (!ok) bad += 1;
    return { 输入: input, 期望: want || '(不识别)', 实际: got || '(不识别)', 结果: ok ? 'OK' : '**不符**', 备注: note };
});
console.table(rows);
console.log(`\n${CASES.length - bad}/${CASES.length} 符合期望；不符 ${bad} 条`);
process.exitCode = bad ? 1 : 0;
