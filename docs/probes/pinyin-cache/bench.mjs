/**
 * 基准 · 搜索过滤的拼音开销（真源码 `filterByName.ts` + `hooks/usePinYin.ts`）
 * 一行复跑：`node docs/probes/pinyin-cache/bench.mjs`
 *
 * 为什么量它：平铺把一屏从"几十条"变成"几千条"，而 `filterByName` 在**每个按键**上
 * 对**每一条**跑一次拼音转换（搜索词以字母开头时）。缓存加在 `usePinYin` 里，
 * 这里量的是"冷 / 热"两拍 —— **冷的那一拍 ≈ 没缓存时每敲一个字母的成本**。
 *
 * ⚠️ 零读盘、零 DOM：只喂构造数据。
 */
import * as esbuild from 'esbuild';
import path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const outDir = path.join(repo, 'node_modules/.cache/ff-pinyin-bench');
mkdirSync(outDir, { recursive: true });
const outfile = path.join(outDir, 'filterByName.mjs');

await esbuild.build({
    entryPoints: [path.join(repo, 'src/views/FileFinder/filterByName.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile,
    alias: { '@': path.join(repo, 'src') },     // `filterByName` 用 `@/hooks/usePinYin`
    logLevel: 'silent',
});

const { filterByName } = await import(pathToFileURL(outfile).href);

const lines = [];
const log = (s) => { lines.push(s); console.log(s); };

/** 造 N 条假条目：名字形如 `SSIS-123 某中文标题`，前缀集中（贴近真实：同批同系列） */
function makeList(n) {
    const prefixes = ['SSIS', 'SNIS', 'SSNI', 'ABP', 'MIAA', 'IPX', 'STARS', 'PRED'];
    return Array.from({ length: n }, (_, i) => ({
        dir: `cat${i % 40}`,
        name: `${prefixes[i % prefixes.length]}-${100 + i} 中文标题第${i}号`,
        ext: 'mp4',
        type: 'file',
        size: 1,
    }));
}

const time = (fn) => {
    const t0 = process.hrtime.bigint();
    const out = fn();
    return { ms: Number(process.hrtime.bigint() - t0) / 1e6, n: out.length };
};

log('条数      查询   冷（≈无缓存时每键成本）   热（同一按键重复）  命中条数');
log('-'.repeat(78));

for (const n of [3000, 16000, 60000]) {
    const list = makeList(n);
    for (const q of ['s', 'ss', 'ssi']) {
        const cold = time(() => filterByName(list, q));
        const warm = time(() => filterByName(list, q));
        log(`${String(n).padStart(6)}    "${q}"`.padEnd(18)
            + `${cold.ms.toFixed(1).padStart(8)} ms`.padEnd(24)
            + `${warm.ms.toFixed(1).padStart(8)} ms`.padEnd(22)
            + String(cold.n));
    }
    log('');
}

writeFileSync(path.join(here, 'bench.txt'), lines.join('\n') + '\n');
log('已写入 bench.txt');
