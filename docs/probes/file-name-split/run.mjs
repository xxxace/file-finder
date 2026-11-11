/**
 * `fileNameSplit.ts` 的只读探针 —— 跑**真源码**，不是手抄一份。
 *
 * 判据只有一条，但它是整个"中间省略"成立的前提：
 *
 *   ① `head + tail === name` 恒成立
 *      —— 两段是**同一个名字的切分**，不是两份加工。拼不回去就说明切错位了，
 *        界面会显示出一个不存在的文件名（比省略得难看严重得多）。
 *   ② `tail` 必须以扩展名结尾、且不含省略号
 *      —— 尾段是"永不省略"的那一半，扩展名和 A/B 全靠它保住。
 *
 * ⚠️ 为什么必须引真源码：第一版探针把判据**手抄**进脚本，回退真源码时探针依然全绿
 *    （`docs/probes/grid-cursor-focus/` 记过同一个错）⇒ 断言的就变成"我抄的对不对"。
 */
import * as esbuild from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');

const res = await esbuild.build({
    entryPoints: [path.resolve(repo, 'src/views/FileFinder/fileNameSplit.ts')],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    write: false,
    logLevel: 'silent',
});
const mod = { exports: {} };
new Function('module', 'exports', 'require', res.outputFiles[0].text)(mod, mod.exports, () => ({}));
const { splitFileName, TAIL_KEEP } = mod.exports;

/** 真实盘上会出现的形状 + 边界。 */
const CASES = [
    'TST-001A.mp4',
    'TST-001B.mp4',
    'abc.mp4',
    'a.mp4',
    '前編.mp4',
    '[TST-002]完全版 特典映像 前編.mp4',
    '[TST-002]完全版 特典映像 後編.mp4',
    'a.b.c.mp4',
    'README',
    '.mp4',
    'x.MKV',
    '这是一个非常非常非常长的中文文件名没有任何扩展名',
];

let pass = 0;
const fails = [];

for (const name of CASES) {
    const { head, tail } = splitFileName(name);
    const joined = head + tail;
    const ext = name.lastIndexOf('.') > 0 ? name.slice(name.lastIndexOf('.')) : '';
    const hasEllipsis = head.includes('…') || tail.includes('…');
    const problems = [];
    if (joined !== name) problems.push(`拼回不一致: "${joined}"`);
    if (hasEllipsis) problems.push('切分结果自带省略号');
    if (ext && !tail.endsWith(ext)) problems.push(`尾段没以 "${ext}" 结尾`);
    if (ext && tail.length - ext.length > TAIL_KEEP) problems.push(`尾段多保留了 ${tail.length - ext.length} 字符`);

    const line = `${problems.length ? 'FAIL' : 'ok  '}  ${JSON.stringify(name).padEnd(44)} head=${JSON.stringify(head).padEnd(32)} tail=${JSON.stringify(tail)}`;
    console.log(line);
    if (problems.length) fails.push(`${name}: ${problems.join('; ')}`);
    else pass++;
}

console.log(`\n${pass}/${CASES.length} 通过`);
if (fails.length) {
    console.log('\n失败：');
    fails.forEach((f) => console.log(`  - ${f}`));
    process.exitCode = 1;
}
