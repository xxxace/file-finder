/**
 * 探针 · 面包屑渲染布局（真源码 `src/views/FileFinder/crumbRows.ts`，先打印后断言）
 * 一行复跑：`node docs/probes/crumbs/layout.mjs`
 *
 * 验的是**重构后等价性**：折叠 / 不折叠两条路走同一个函数，
 * 展开态必须逐段等于 `ancestorsOf()` 的原序列，折叠态必须是「首段 + … + 当前段」。
 *
 * ⚠️ 本探针**零读盘**：只喂假路径。
 * ⚠️ 证据落 `out.txt`（`.gitignore` 有 `*.log`，写 .log 进不了仓库）。
 */
import * as esbuild from 'esbuild';
import path from 'node:path';
import os from 'node:os';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const outDir = path.join(os.tmpdir(), 'ff-crumb-layout-probe');
mkdirSync(outDir, { recursive: true });
const outfile = path.join(outDir, 'crumbRows.mjs');

// `crumbRows.ts` 对 `@/utils` 只有 `import type` ⇒ 编译期被擦除，esbuild 无需 alias
await esbuild.build({
    entryPoints: [path.join(repo, 'src/views/FileFinder/crumbRows.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile,
    logLevel: 'silent',
});

const { buildCrumbLayout } = await import(pathToFileURL(outfile).href);

/* ── 假数据：手搓 PathCrumb，不走 ancestorsOf（那是另一个探针的事） ── */
const P = (names) => {
    const out = [];
    let acc = '';
    names.forEach((name, i) => {
        acc = i === 0 ? `${name}:/` : `${acc.replace(/\/$/, '')}/${name}`;
        out.push({ name, path: acc, kind: i === 0 ? 'root' : 'dir' });
    });
    return out;
};
const names = (rows) => rows.map((r) => r.name).join(' › ');

let pass = 0;
let fail = 0;
const check = (label, actual, expected) => {
    const ok = actual === expected;
    ok ? pass++ : fail++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}\n      → ${actual}${ok ? '' : `\n      期望 ${expected}`}`);
};

/* ── 1. 展开态（<= 4 段）：必须逐段等于原序列 ── */
{
    const c = P(['F', 'videos', 'a', 'b']);
    const L = buildCrumbLayout(c, null);
    check('展开态 head = 首段', names([L.head]), 'F');
    check('展开态没有折叠占位', String(L.fold), 'null');
    check('展开态 tail = 其余各段', names(L.tail), 'videos › a › b');
    check('展开态首段不是当前段', String(L.headCurrent), 'false');
}

/* ── 2. 只有一段（盘根）：首段自己就是当前段 ── */
{
    const L = buildCrumbLayout(P(['F']), null);
    check('单段 tail 为空', String(L.tail.length), '0');
    check('单段首段 = 当前段（要有加粗与角标）', String(L.headCurrent), 'true');
}

/* ── 3. 折叠态：首段 + `…` + 当前段 ── */
{
    const c = P(['F', 'videos', 'a', 'b', 'c']);
    // 与 utils 的 foldCrumbList 同构（max=4）
    const fold = { head: c[0], hidden: c.slice(1, c.length - 1), tail: c.slice(-1) };
    const L = buildCrumbLayout(c, fold);
    check('折叠态 head = 首段', names([L.head]), 'F');
    check('折叠态占位在 head 之后', names([L.fold]), '…');
    check('折叠态 tail 只剩当前段', names(L.tail), 'c');
    check('折叠态被折掉的层数', String(fold.hidden.length), '3');
}

/* ── 4. key 唯一性：空 path（清单屏首段）不能塌成同一个 key ── */
{
    const playlist = [
        { name: '收藏', path: '', kind: 'root' },
        { name: '某清单', path: '@pl:abc', kind: 'dir' },
    ];
    const L = buildCrumbLayout(playlist, null);
    const keys = [L.head.key, ...L.tail.map((r) => r.key)];
    check('清单屏 key 不为空', String(keys.includes('')), 'false');
    check('清单屏 key 两两不同', String(new Set(keys).size), String(keys.length));
    check('清单屏名称', names([L.head, ...L.tail]), '收藏 › 某清单');
}

/* ── 5. 空路径：什么都不渲染（不能抛） ── */
{
    const L = buildCrumbLayout([], null);
    check('空路径 head = null', String(L.head), 'null');
    check('空路径 tail 为空', String(L.tail.length), '0');
}

/* ── 6. 折叠占位不得混进 tail（否则模板会渲染两个 `…`） ── */
{
    const c = P(['E', 'x', 'y', 'z', 'w', 'v']);
    const fold = { head: c[0], hidden: c.slice(1, -1), tail: c.slice(-1) };
    const L = buildCrumbLayout(c, fold);
    check('tail 里不含 `…`', String(L.tail.some((r) => r.name === '…')), 'false');
    check('head 与 fold 不重复', String(L.head.key === L.fold.key), 'false');
}

const summary = `\n${pass} PASS / ${fail} FAIL\n`;
console.log(summary);
writeFileSync(path.join(here, 'layout-out.txt'), summary + '\n(详细输出见终端)\n');
if (fail) process.exit(1);
