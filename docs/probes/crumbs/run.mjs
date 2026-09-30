/**
 * 探针 · 面包屑纯函数（真源码 `src/utils/index.ts`，先打印后断言）
 * 一行复跑：`node docs/probes/crumbs/run.mjs`
 *
 * ⚠️ 证据必须落 `out.txt`：`.gitignore` 第 3 行是 `*.log`，写 `out.log` 进不了仓库、
 * 文档引用会变成死链（本项目踩过四次）。
 * ⚠️ 本探针**零读盘**：只喂假路径，不碰 `searchCache.db`、不 stat 任何盘。
 */
import * as esbuild from 'esbuild';
import path from 'node:path';
import os from 'node:os';
import { mkdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const outDir = path.join(os.tmpdir(), 'ff-crumbs-probe');
mkdirSync(outDir, { recursive: true });
const outfile = path.join(outDir, 'utils.mjs');

await esbuild.build({
    entryPoints: [path.join(repo, 'src/utils/index.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile,
    logLevel: 'silent',
});

const { ancestorsOf, foldPath, foldCrumbList } = await import(pathToFileURL(outfile).href);

const names = (p) => ancestorsOf(p).map((c) => c.name);
const kinds = (p) => ancestorsOf(p).map((c) => c.kind);
const paths = (p) => ancestorsOf(p).map((c) => c.path);
/** 折叠结果压成"看得见的东西"：head / 被折的段 / 尾段 */
const foldNames = (p, max = 4) => {
    const f = foldCrumbList(ancestorsOf(p), max);
    return f === null ? null : [f.head.name, f.hidden.map((c) => c.name), f.tail.map((c) => c.name)];
};

let bad = 0;
const rows = [];
function check(说明, 输入, 实际, 期望) {
    const a = JSON.stringify(实际);
    const e = JSON.stringify(期望);
    const ok = a === e;
    if (!ok) bad += 1;
    rows.push({ 说明, 输入: String(输入), 期望: e, 实际: a, 结果: ok ? 'OK' : '**不符**' });
}

/* ── ① 在线盘符路径 ───────────────────────────────────────────── */
check('在线：段名', 'E:/videos', names('E:/videos'), ['E:', 'videos']);
check('在线：首段是 root（⇒ 不可点）', 'E:/videos', kinds('E:/videos'), ['root', 'dir']);
check('在线：每段路径逐级拼回', 'E:/videos', paths('E:/videos'), ['E:/', 'E:/videos']);
check('回斜杠也认', 'E:\\videos', names('E:\\videos'), ['E:', 'videos']);

/* ── ② 盘根 / 尾斜杠：不能产生空段 ───────────────────────────── */
check('盘根带尾斜杠', 'E:/', names('E:/'), ['E:']);
check('盘符不带斜杠', 'E:', names('E:'), ['E:']);
check('盘根路径 = E:/', 'E:/', paths('E:/'), ['E:/']);

/* ── ③ 深链展开 ─────────────────────────────────────────────── */
check('六段全展开', 'E:/a/b/c/d/videos', names('E:/a/b/c/d/videos'),
    ['E:', 'a', 'b', 'c', 'd', 'videos']);

/* ── ④ 折叠：保首尾，当前层永远在末段 ────────────────────────── */
check('六段 ⇒ 首 + (3 段被折) + 末2（共显示 4 个）', 'E:/a/b/c/d/videos', foldNames('E:/a/b/c/d/videos'),
    ['E:', ['a', 'b', 'c'], ['d', 'videos']]);
check('四段 ⇒ 不折（边界，全显）', 'F:/a/b/c', foldNames('F:/a/b/c'), null);
// ⚠️ S-2 的正面证据：五段时 `…` 必须代表 **2 段**。若末段取 3（旧规则），
// 这里 `…` 只代表 1 段 —— 那就该把那一段直接显示，而不是白让用户多点击一次。
check('五段 ⇒ … 代表 2 段（不是 1 段）', 'E:/a/b/c/d', foldNames('E:/a/b/c/d'),
    ['E:', ['a', 'b'], ['c', 'd']]);
// 防御性不变量：把阈值调小到 3 时，`…` 会只代表 1 段 ⇒ 必须放弃折叠、改为全显。
// （在默认 max=4 下这条路径不可达 —— 所以它是**防御**，不是活缺陷，别当成"已修 bug"。）
check('max=3 时 `…` 只代表 1 段 ⇒ 放弃折叠', 'E:/a/b/c', foldNames('E:/a/b/c', 3), null);

/* ── ⑤ 离线只读锚点 ─────────────────────────────────────────── */
check('锚点：首段名 = 离线(后4位)', '#CD72/videos/示例演员A', names('#CD72/videos/示例演员A'),
    ['离线(CD72)', 'videos', '示例演员A']);
check('锚点：首段是 root', '#CD72/videos', kinds('#CD72/videos'), ['root', 'dir']);
check('锚点：路径保留 # 前缀可回传服务端', '#CD72/videos', paths('#CD72/videos'),
    ['#CD72', '#CD72/videos']);

/* ── ⑥ UNC / 网络位置兜底（S-5）────────────────────────────── */
check('UNC 不抛异常且可读', '\\\\server\\share\\x', names('\\\\server\\share\\x'),
    ['server', 'share', 'x']);
check('UNC 首段仍是 root', '\\\\server\\share\\x', kinds('\\\\server\\share\\x'),
    ['root', 'dir', 'dir']);

/* ── ⑦ 中文 / 空格 / & ：原名保留（转义交给 encodeURIComponent）── */
check('中文 + 空格 + &', 'E:/示例 作品 & 标题/子目录', names('E:/示例 作品 & 标题/子目录'),
    ['E:', '示例 作品 & 标题', '子目录']);

/* ── ⑧ 空值 / 异常输入：一律不抛 ────────────────────────────── */
check('空串', '', names(''), []);
check('只有斜杠', '/', names('/'), []);
check('null 兜底', null, names(null), []);

/* ── ⑨ foldPath（给 chip 用，单个字符串）───────────────────── */
check('foldPath 短路径不动', 'E:/videos', foldPath('E:/videos'), 'E:/videos');
check('foldPath 长路径保尾', 'E:/a/b/c/d/videos', foldPath('E:/a/b/c/d/videos'), 'E:/…/d/videos');
check('foldPath 锚点', '#CD72/a/b/c/d', foldPath('#CD72/a/b/c/d'), '离线(CD72)/…/c/d');
check('foldPath 空值', '', foldPath(''), '');

console.table(rows);
console.log(`\n${rows.length - bad}/${rows.length} 符合期望；不符 ${bad} 条`);
process.exitCode = bad ? 1 : 0;
