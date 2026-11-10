/**
 * 探针 · 平铺视图的"从自身向下"边界（真源码 `electron/server/nedb.ts` 的
 * `mergeSubtreeLeafItems`，先打印后断言）
 * 一行复跑：`node docs/probes/flat-subtree/model.mjs`
 *
 * 验的是 2026-11-10 放开"平铺只许盘根"之后**唯一真正有风险的那一条**：
 * 传一个**中间层**路径进去，它必须只摊**这个路径下面**的叶子，
 * 不许把父级 / 兄弟目录的东西也摊进来（那会让"平铺"变成"整盘"）。
 *
 * ⚠️ 零读盘：只喂假 rows，不碰 nedb、不碰任何盘。
 * ⚠️ 产物落 `out.txt`。
 */
import * as esbuild from 'esbuild';
import path from 'node:path';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const outDir = path.join(repo, 'node_modules/.cache/ff-flat-subtree-probe');
mkdirSync(outDir, { recursive: true });
const outfile = path.join(outDir, 'nedb.mjs');

/* `packages: 'external'`：node_modules 里的包（@seald-io/nedb / dayjs）全部外部化，
   本仓的 .ts 照常打包 —— 这样既拿得到真源码，又不会把 nedb 打进 bundle。 */
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

const lines = [];
const log = (s) => { lines.push(s); console.log(s); };
let n = 0;
const ok = (title, fn) => { fn(); n++; log(`PASS  ${title}`); };

const SERIAL = 'SN-TEST';
const dir = (d) => (d ? d : '');
/** 叶子（作品） */
const leaf = (name, d) => ({ name, ext: 'mp4', type: 'file', dir: dir(d), size: 1 });
/** 目录条目 */
const folder = (name, d) => ({ name, type: 'folder', dir: dir(d), size: 0 });
const doc = (relPath, data) => ({ serial: SERIAL, relPath, mode: 'cover', data });

/* 假数据：一个盘根，下面 videos（两个演员目录）与 trash（一个作品） */
const ROWS = [
    doc('', [folder('videos', ''), folder('trash', '')]),
    doc('videos', [folder('ActressA', 'videos'), folder('ActressB', 'videos'), leaf('loose', 'videos')]),
    doc('videos/ActressA', [leaf('a1', 'videos/ActressA'), leaf('a2', 'videos/ActressA')]),
    doc('videos/ActressB', [leaf('b1', 'videos/ActressB')]),
    doc('trash', [leaf('x1', 'trash')]),
    /* 兜底支路：父目录 data 里**没有**列出它，但它的记录确实存在 */
    doc('videos/ActressC', [leaf('c1', 'videos/ActressC')]),
];

const names = (items) => items.map((i) => i.name).sort();

try {
    ok('盘根：摊到整盘的叶子（含兄弟目录 trash）', () => {
        assert.deepEqual(names(mergeSubtreeLeafItems(ROWS, SERIAL, '')), ['a1', 'a2', 'b1', 'c1', 'loose', 'x1']);
    });

    ok('中间层 videos：只摊它下面的，**不含**兄弟 trash 的 x1', () => {
        assert.deepEqual(names(mergeSubtreeLeafItems(ROWS, SERIAL, 'videos')), ['a1', 'a2', 'b1', 'c1', 'loose']);
    });

    ok('三层 ActressA：只摊自己的两个作品', () => {
        assert.deepEqual(names(mergeSubtreeLeafItems(ROWS, SERIAL, 'videos/ActressA')), ['a1', 'a2']);
    });

    ok('兜底支路：父 data 没列 ActressC，也要摊到它的 c1', () => {
        assert.ok(names(mergeSubtreeLeafItems(ROWS, SERIAL, 'videos')).includes('c1'));
    });

    ok('大小写 / 反斜杠 / 尾斜杠都不影响判界', () => {
        assert.deepEqual(names(mergeSubtreeLeafItems(ROWS, SERIAL, 'Videos\\ActressA/')), ['a1', 'a2']);
    });

    ok('别的盘的记录一律不进（serial 过滤）', () => {
        const mixed = [...ROWS, { serial: 'OTHER', relPath: 'videos/ActressA', mode: 'cover', data: [leaf('zz', 'videos/ActressA')] }];
        assert.deepEqual(names(mergeSubtreeLeafItems(mixed, SERIAL, 'videos')), ['a1', 'a2', 'b1', 'c1', 'loose']);
    });

    log(`\nPASS  全部 ${n} 条断言通过`);
} catch (err) {
    log(`\nFAIL  ${n} 条通过后失败：${err?.message ?? err}`);
    writeFileSync(path.join(here, 'out.txt'), lines.join('\n') + '\n');
    process.exit(1);
}

writeFileSync(path.join(here, 'out.txt'), lines.join('\n') + '\n');
