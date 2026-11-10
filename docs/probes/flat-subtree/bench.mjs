/**
 * 基准 · 平铺视图的服务端成本（真源码 `electron/server/nedb.ts` 的 `mergeSubtreeLeafItems`）
 * 一行复跑：`node docs/probes/flat-subtree/bench.mjs`
 *
 * 为什么要有它：2026-11-10 把 flat 从"只许盘根"放开到"任意层级"之后，
 * 平铺不再是偶尔用一次的功能 ⇒ 必须知道它**随库大小怎么涨**。
 * 这里只喂构造数据、只测纯函数，**零读盘、不碰 nedb**。
 *
 * 输出：三档库规模 × （盘根 / 中间层 / 叶子层）的耗时、结果条数、JSON 体积、堆增长。
 */
import * as esbuild from 'esbuild';
import path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const outDir = path.join(repo, 'node_modules/.cache/ff-flat-subtree-bench');
mkdirSync(outDir, { recursive: true });
const outfile = path.join(outDir, 'nedb.mjs');

await esbuild.build({
    entryPoints: [path.join(repo, 'electron/server/nedb.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile,
    packages: 'external',
    external: ['electron'],
    logLevel: 'silent',
});

const { mergeSubtreeLeafItems } = await import(pathToFileURL(outfile).href);

const SERIAL = 'SN-BENCH';
const lines = [];
const log = (s) => { lines.push(s); console.log(s); };

const leaf = (name, d) => ({ name, ext: 'mp4', type: 'file', dir: d, size: 20 * 1024 * 1024, thumb: `t${name}`, sig: `s${name}` });
const folder = (name, d) => ({ name, type: 'folder', dir: d, size: 0 });

/** 造一个盘：`dirs` 个目录，每个 `per` 个作品；层数固定两层（root / 分类 / 女优） */
function makeRows(dirs, per) {
    const rows = [{ serial: SERIAL, relPath: '', mode: 'cover', data: [] }];
    const categories = Math.max(1, Math.round(dirs / 50));          // 每个分类下 50 个女优目录
    if (categories > 1) {
        for (let c = 0; c < categories; c++) rows[0].data.push(folder(`cat${c}`, ''));
    }
    for (let i = 0; i < dirs; i++) {
        const cat = categories > 1 ? `cat${i % categories}` : '';
        const parent = cat;
        if (cat && rows[0].data.length && i < categories) { /* 分类条目已加 */ }
        const rel = cat ? `${cat}/act${i}` : `act${i}`;
        // 父目录的 data 里挂上这个子目录（除了第一层分类）
        if (!cat) rows[0].data.push(folder(`act${i}`, ''));
        else {
            let doc = rows.find((r) => r.relPath === parent);
            if (!doc) { doc = { serial: SERIAL, relPath: parent, mode: 'cover', data: [] }; rows.push(doc); }
            doc.data.push(folder(`act${i}`, parent));
        }
        const data = [];
        for (let k = 0; k < per; k++) data.push(leaf(`v${i}-${k}`, rel));
        rows.push({ serial: SERIAL, relPath: rel, mode: 'cover', data });
    }
    return rows;
}

function bench(title, rows, base, rounds = 3) {
    let out;
    const times = [];
    for (let i = 0; i < rounds; i++) {
        const t0 = process.hrtime.bigint();
        out = mergeSubtreeLeafItems(rows, SERIAL, base);
        times.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
    const bytes = JSON.stringify(out).length;
    log(`${title.padEnd(34)} 条数=${String(out.length).padStart(6)}  JSON=${(bytes / 1048576).toFixed(2)}MB  耗时=${times.map((t) => t.toFixed(1)).join('/')}ms`);
    return out.length;
}

log('库规模                    场景                               结果');
log('-'.repeat(96));

for (const [dirs, per] of [[500, 6], [2000, 8], [6000, 10]]) {
    const rows = makeRows(dirs, per);
    const heapBefore = process.memoryUsage().heapUsed;
    const tag = `${dirs} 目录 × ${per} 作品 = ${dirs * per} 条`;
    log(`\n【${tag}】docs=${rows.length}`);
    bench('盘根平铺（base=""）', rows, '');
    const mid = rows.length > 3 ? rows[Math.floor(rows.length / 2)].relPath : '';
    bench(`中间层平铺（base="${mid}"）`, rows, mid);
    bench('叶子层平铺（末条目录）', rows, rows[rows.length - 1].relPath);
    const heapAfter = process.memoryUsage().heapUsed;
    log(`堆增长（本轮全部结果仍在引用中）：${((heapAfter - heapBefore) / 1048576).toFixed(1)}MB`);
}

writeFileSync(path.join(here, 'bench.txt'), lines.join('\n') + '\n');
log('\n已写入 bench.txt');
