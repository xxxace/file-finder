/**
 * `fileNameSort.ts` 的只读探针 —— 跑**真源码**。
 *
 * 断言的是业主 2026-11-11 报的那一条：`TST-003-2.mp4` 不应该排在 `TST-003.mp4` 前面。
 * 顺带钉住"自然序"（`-2` 在 `-10` 前）和"母文件在分片前"（`TST-001` 在 `TST-001A` 前）。
 *
 * ⚠️ 只读探针，不扫盘、不写缓存、不碰 `~/.file-finder`。
 */
import * as esbuild from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');

const res = await esbuild.build({
    entryPoints: [path.resolve(repo, 'src/views/FileFinder/fileNameSort.ts')],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    write: false,
    logLevel: 'silent',
});
const mod = { exports: {} };
new Function('module', 'exports', 'require', res.outputFiles[0].text)(mod, mod.exports, () => ({}));
const { compareFileName } = mod.exports;

let pass = 0;
const fails = [];

/** `[先, 后]` —— 断言前者必须排在后者前面。 */
const ORDER = [
    ['TST-003.mp4', 'TST-003-2.mp4'],        // 业主报的那一对
    ['TST-003.mp4', 'TST-003-10.mp4'],
    ['TST-003-2.mp4', 'TST-003-10.mp4'],     // 自然序：2 在 10 前
    ['TST-001.mp4', 'TST-001A.mp4'],
    ['TST-001A.mp4', 'TST-001B.mp4'],
    ['CD1.mp4', 'CD10.mp4'],
    ['a.mp4', 'b.mkv'],                        // 纯字典序
];

for (const [first, second] of ORDER) {
    const ok = compareFileName(first, second) < 0 && compareFileName(second, first) > 0;
    console.log(`${ok ? 'ok  ' : 'FAIL'}  ${first.padEnd(20)} < ${second}`);
    if (ok) pass++;
    else fails.push(`${first} 应该排在 ${second} 前面`);
}

/** 整串排序 —— 人眼一眼能验的那种。 */
const LIST = [
    'TST-003-10.mp4', 'TST-003-2.mp4', 'TST-003.mp4', 'TST-003-3.mkv',
    'TST-001B.mp4', 'TST-001A.mp4', 'TST-001.mp4',
];
const EXPECTED = [
    'TST-001.mp4', 'TST-001A.mp4', 'TST-001B.mp4',
    'TST-003.mp4', 'TST-003-2.mp4', 'TST-003-3.mkv', 'TST-003-10.mp4',
];
const sorted = [...LIST].sort(compareFileName);
const listOk = JSON.stringify(sorted) === JSON.stringify(EXPECTED);
console.log(`\n${listOk ? 'ok  ' : 'FAIL'}  整表排序`);
console.log(sorted.map((s) => `       ${s}`).join('\n'));
if (listOk) pass++;
else fails.push(`整表排序得到 ${JSON.stringify(sorted)}`);

/** 大小写不敏感：两个只在大小写上不同的名字，比较器不许返回非 0（否则顺序随引擎摇摆）。 */
const caseOk = compareFileName('abc.mp4', 'ABC.mp4') === 0;
console.log(`\n${caseOk ? 'ok  ' : 'FAIL'}  大小写不敏感`);
if (caseOk) pass++;
else fails.push('大小写不同的同名文件比较结果不为 0');

/** 同 stem 不同扩展名：不许返回 0（靠第二段兜住，不能指望 sort 稳定）。 */
const extOk = compareFileName('a.mp4', 'a.mkv') !== 0;
console.log(`${extOk ? 'ok  ' : 'FAIL'}  同 stem 不同扩展名有确定顺序`);
if (extOk) pass++;
else fails.push('a.mp4 与 a.mkv 比较结果为 0');

const total = ORDER.length + 3;
console.log(`\n${pass}/${total} 通过`);
if (fails.length) {
    console.log('\n失败：');
    fails.forEach((f) => console.log(`  - ${f}`));
    process.exitCode = 1;
}
