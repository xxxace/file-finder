/**
 * 探针 · 首页盘卡片的"落点"计算（真源码 `electron/server/diskTops.ts`，先打印后断言）。
 * 一行复跑：`node docs/probes/disk-tops/run.mjs`
 *
 * 为什么需要它：这段判据连错三轮（最小深度 → 同级折叠 → 反斜杠），
 * 光靠 typecheck 证明不了；真机验证要插着盘、扫过某些层 —— 那要读盘。
 * ⇒ 只喂假数据，**零读盘**，断言直接照业主原话（2026-11-11 第五版）。
 *
 * ⚠️ 证据落 `out.txt`（`.gitignore` 有 `*.log`，写 .log 进不了仓库）。
 */
import * as esbuild from 'esbuild';
import path from 'node:path';
import os from 'node:os';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const outDir = path.join(os.tmpdir(), 'ff-disk-tops-probe');
mkdirSync(outDir, { recursive: true });
const outfile = path.join(outDir, 'diskTops.mjs');

// `diskTops.ts` 零 import ⇒ esbuild 直接打包，无需 alias
await esbuild.build({
    entryPoints: [path.join(repo, 'electron/server/diskTops.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile,
    logLevel: 'silent',
});

const { diskTops } = await import(pathToFileURL(outfile).href);

/** 造一份"缓存记录"：只给 relPath + count */
const rows = (list) => list.map(([relPath, count = 1]) => ({ relPath, count }));

/** 断言用：只取 relPath 序列 */
const rel = (tops) => tops.map(t => t.relPath);

/** 两个假地址构造器**逐字照抄服务端那两个**（`toFullPath` / `toAnchorPath`）：盘根不留尾斜杠 */
const full = (r) => (r ? `H:/${r}` : 'H:');
const anchor = (r) => (r ? `#SER/${r}` : '#SER');
const tops = (list) => diskTops(rows(list), { path: full });

const lines = [];
const fails = [];
const log = (s) => { lines.push(s); console.log(s); };

function check(name, actual, expected) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    const ok = a === e;
    log(`${ok ? 'PASS' : 'FAIL'}  ${name}\n      实得 ${a}\n      期望 ${e}`);
    if (!ok) fails.push(name);
}

log('=== 首页盘落点（diskTops）· 2026-11-11 第五版判据 ===\n');

/* ① 业主原话 A：父层自己也缓存过 ⇒ 子层被覆盖 */
check(
    'media/SET-A + A + B ⇒ 只给 media/SET-A',
    rel(tops([['media/SET-A'], ['media/SET-A/A'], ['media/SET-A/B']])),
    ['media/SET-A'],
);

/* ② 业主原话 B：父层没缓存 ⇒ 子层**自己**就是顶层（绝不折成 media/SET-B） */
check(
    'media/SET-B 没扫过 ⇒ 给 media/SET-B/COLL-A（不许折成 SET-B）',
    rel(tops([['media/SET-B/COLL-A']])),
    ['media/SET-B/COLL-A'],
);

/* ③ 业主原话合起来：D 盘就这两条，**且顺序是路径序**（业主第二次纠正：SET-A 应该在 SET-B 上面） */
check(
    'D 盘 = media/SET-A + media/SET-B/COLL-A（SET-A 在前）',
    rel(tops([
        ['media/SET-A'], ['media/SET-A/A'], ['media/SET-A/B'], ['media/SET-B/COLL-A'],
    ])),
    ['media/SET-A', 'media/SET-B/COLL-A'],
);

/* ④ 业主原话 C：离线盘只有一条 ⇒ 前端不弹菜单（判据 = 长度 1） */
check(
    '离线单条 ⇒ 长度 1（不弹菜单）',
    diskTops(rows([['disk/album-x']]), { path: anchor }).length,
    1,
);

/* ⑤ 反斜杠子层 + 已缓存的父层（2026-11-11 截图那组） */
check(
    '反斜杠子层 ⇒ 被父层覆盖',
    rel(tops([['videos', 35], ['videos\\aaa', 5], ['videos\\bbb', 2]])),
    ['videos'],
);

/* ⑥ 反斜杠的**兄弟**、父层没缓存 ⇒ 两条各自是顶层（不是折成 videos） */
check(
    '父层没缓存的反斜杠兄弟 ⇒ 两条都留',
    rel(tops([['videos\\a'], ['videos\\b']])).sort(),
    ['videos/a', 'videos/b'],
);

/* ⑦ 大小写漂移也认父子 */
check(
    'Videos 与 videos/xxx 认成一家人',
    rel(tops([['Videos'], ['videos/xxx1'], ['videos/xxx2']])),
    ['Videos'],
);

/* ⑧ 盘根缓存过 ⇒ 下面一律不算入口 */
check(
    '盘根缓存过 ⇒ 只剩盘根',
    rel(tops([[''], ['videos'], ['videos/xxx1']])),
    [''],
);

/* ⑨ 深 3 层的独苗：原样 */
check('深 3 层的独苗 ⇒ 原样', rel(tops([['a/b/c']])), ['a/b/c']);

/* ⑩ 两片互不相干的地盘 */
check(
    '互不相干的支线 ⇒ 各给各的',
    rel(tops([['videos2/xxx1'], ['music2/yyy1']])).sort(),
    ['music2/yyy1', 'videos2/xxx1'].sort(),
);

/* ⑪ 同一层两种写法 / 两种缓存模式 ⇒ 去重一条，count 取大 */
check(
    '同层两条记录 ⇒ 去重 + count 取大',
    diskTops(rows([['videos', 3], ['videos', 9], ['videos\\', 4]]), { path: full })
        .map(t => [t.relPath, t.count]),
    [['videos', 9]],
);

/* ⑫ 地址与展示名（离线用锚点、根不留尾斜杠） */
const one = diskTops(rows([['a/b/c']]), { path: full });
check('path / name', [one[0].path, one[0].name], ['H:/a/b/c', 'c']);
const rootOnly = diskTops(rows([['']]), { path: anchor });
check('盘根的地址与名字', [rootOnly[0].path, rootOnly[0].name], ['#SER', '盘根']);

/* ⑬ 离线地址必须保留库里原样的反斜杠（否则缓存主键查不到） */
check(
    '离线地址保留反斜杠',
    diskTops(rows([['videos\\aaa']]), { path: anchor }).map(t => t.path),
    ['#SER/videos\\aaa'],
);

/* ⑭ 排序：**路径序**，与输入顺序无关（条目数不参与排序） */
check(
    '排序按路径、不看条目数',
    rel(tops([['zzz', 1], ['bbb', 999], ['aaa', 2]])),
    ['aaa', 'bbb', 'zzz'],
);

/* ⑮ 空输入 */
check('没有缓存记录 ⇒ 空数组', rel(tops([])), []);


/* ⑯ 记录带**尾分隔符**（`videos\`）⇒ 地址必须削干净，不能拼出 `H:/videos\` */
const tail = diskTops(rows([['videos\\', 4], ['videos/a', 1]]), { path: full });
check('尾部反斜杠记录 ⇒ 地址无尾分隔符', tail.map(t => [t.relPath, t.path]), [['videos', 'H:/videos']]);

log(`\n=== ${fails.length ? `失败 ${fails.length} 项：${fails.join(' / ')}` : '全部通过'} ===`);
writeFileSync(path.join(here, 'out.txt'), lines.join('\n') + '\n', 'utf8');
if (fails.length) process.exitCode = 1;
