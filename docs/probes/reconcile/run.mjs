/**
 * 探针 · 增量对账（1.1.0-Q1）
 * ==============================================================================
 * 一行复跑：`node docs/probes/reconcile/run.mjs`
 *
 * 验什么：**同一层目录再扫一次时，没变的缩略图有没有被真的复用** ——
 *        也就是"抽帧"到底有没有被跳过（那是整个优化唯一省下来的东西）。
 *
 * 手法：用 esbuild 打包**真的 `electron/server/index.ts`**，只做四件事：
 *   ① `../utils/thumbnail` → 计数桩（不真解码，只记"抽了几次"）★ 判据就来自这个计数
 *   ② `./assistant`        → 空路由（它依赖 electron，本探针不测它）
 *   ③ `../config`          → 指向 %TEMP% 下的隔离目录 ⇒ **绝不碰真库**
 *   ④ `./nedb`             → 内存版（它是**唯一的落盘点**；且 CJS 打包会 `Dynamic require` 炸）⇒ 探针彻底不写盘
 *   ⑤ 入口文本层注入两处**只属于探针**的东西：
 *        · `listen(3060)` → `listen(0)`（避开主人正在跑的 dev；0 = 随机空闲端口）
 *        · 追加 `export { scanAndCache, findDriveByLetter }` —— 这几个内部函数原先不对外，
 *          这是探针能直接调它们的唯一办法（产品代码里没有这两个导出）
 *
 * 全程只碰 %TEMP%；输出**不含**真实路径、用户名、盘序列号。
 */
import * as esbuild from 'esbuild';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const TMP = os.tmpdir();

// ─────────────────── 1. 夹具：一个假的「一层目录」 ───────────────────
const FIX = path.join(TMP, 'ff-reconcile-fixture');
fs.rmSync(FIX, { recursive: true, force: true });
fs.mkdirSync(path.join(FIX, 'sub'), { recursive: true });
fs.mkdirSync(path.join(FIX, 'sub2'), { recursive: true });

const touch = (p) => fs.writeFileSync(p, '');   // 内容是空的没关系：抽帧已被桩掉，只数次数
for (const f of ['a.png', 'b.png', 'c.png']) touch(path.join(FIX, f));
// `sub/` 里放两张图 ⇒ cover 模式下会收敛成「一个封面条目」（走到 handleCover 那条抽帧路径）
touch(path.join(FIX, 'sub', 'cover.png'));
touch(path.join(FIX, 'sub', 'inner.png'));
// `sub2/` 里**只有一张 avatar.jpg** ⇒ cover 模式下收敛不了（摘掉目录封面名之后没有别的图可选），
// 于是它保持目录形态 ⇒ 走到 `makeDirCover` 那条抽帧路径（"目录自己的脸"）
touch(path.join(FIX, 'sub2', 'avatar.jpg'));

// ─────────────────── 2. 隔离的数据目录（绝不碰真库） ───────────────────
const DATA = path.join(TMP, 'ff-reconcile-data');
fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });
process.env.FF_PROBE_DATA = DATA;      // 必须在 import 打包产物**之前**设好

// ─────────────────── 3. 打包真源码 ───────────────────
const BUILD = path.join(TMP, 'ff-reconcile-build');
fs.rmSync(BUILD, { recursive: true, force: true });
fs.mkdirSync(BUILD, { recursive: true });
const outfile = path.join(BUILD, 'server.mjs');
const entry = path.resolve(repo, 'electron/server/index.ts');
const stubOf = (f) => path.join(here, f);

await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile,
    logLevel: 'silent',
    plugins: [{
        name: 'probe-stubs',
        setup(build) {
            build.onResolve({ filter: /^\.\.\/utils\/thumbnail$/ }, () => ({ path: stubOf('stub-thumbnail.mjs') }));
            build.onResolve({ filter: /^\.\/assistant$/ }, () => ({ path: stubOf('stub-assistant.mjs') }));
            build.onResolve({ filter: /^\.\.\/config$/ }, () => ({ path: stubOf('stub-config.mjs') }));
            // nedb 是 CJS，打进来会 `Dynamic require of "events" is not supported`；
            // 且它是唯一的落盘点 —— 换成内存版，探针就彻底不写盘了
            build.onResolve({ filter: /^\.\/nedb$/ }, () => ({ path: stubOf('stub-nedb.mjs') }));

            // ⚠️ 精确比对路径 —— 否则会把 `server/assistant/index.ts` 也一起注入了
            build.onLoad({ filter: /\.ts$/ }, async (args) => {
                if (path.resolve(args.path) !== entry) return null;
                let src = await fs.promises.readFile(args.path, 'utf8');
                src = src.replace(/listen\(3060/g, 'listen(0');
                src += '\nexport { scanAndCache, findDriveByLetter };\n';
                return { contents: src, loader: 'ts' };
            });
        },
    }],
});

const mod = await import(pathToFileURL(outfile).href);

// ─────────────────── 4. 找到这一层在盘上的地址 ───────────────────
const root = path.parse(FIX).root;            // 例如 'C:\'
const letter = root.slice(0, 1);              // 'C'
const rel = path.relative(root, FIX).split(path.sep).join('/');
const drive = await mod.findDriveByLetter(letter);
if (!drive) {
    console.error('拿不到夹具所在盘的序列号，探针无法继续');
    process.exit(1);
}

// ─────────────────── 5. 断言设施 ───────────────────
let pass = 0;
let fail = 0;
const check = (label, cond, detail) => {
    console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? `   → ${detail}` : ''}`);
    if (cond) pass += 1; else fail += 1;
};

const calls = () => globalThis.__thumbCalls;
const reset = () => { globalThis.__thumbCalls = 0; };

const diskName = (d) => (d.ext ? `${d.name}.${d.ext}` : d.name);
const thumbOf = (doc, name) => {
    const hit = doc.data.find((d) => diskName(d) === name);
    return hit ? (hit.thumb ?? hit.avatar ?? '(无)') : '(条目不存在)';
};
const scan = (mode) => mod.scanAndCache(drive.serial, drive.drive, rel, mode);

// ─────────────────── R1 · 首次：没有旧记录 ⇒ 只能全量抽 ───────────────────
console.log('—— R1 首次扫（folder 模式，无旧记录）——');
reset();
const r1 = await scan('folder');
const n1 = calls();
console.log(`  条目 ${r1.data.length}   抽帧 ${n1}`);
check('条目数 = 5（a/b/c 三张图 + sub / sub2 两个目录）', r1.data.length === 5, `实际 ${r1.data.length}`);
check('首次必须全量抽帧 = 4（3 张图 + sub2 的目录脸）', n1 === 4, `实际 ${n1}`);

// ─────────────────── R2 · ★ 核心判据 ───────────────────
console.log('\n—— R2 紧接着再扫一次 ⇒ ★ 抽帧必须是 0 ——');
reset();
const r2 = await scan('folder');
const n2 = calls();
console.log(`  抽帧 ${n2}`);
check('★ 第二次零抽帧（缩略图全部被复用）', n2 === 0, `实际 ${n2}`);
check(
    '★ 三张图各自的 thumb key 逐一未变',
    ['a.png', 'b.png', 'c.png'].every((f) => thumbOf(r1, f) !== '(无)' && thumbOf(r1, f) === thumbOf(r2, f)),
);
check(
    '★ 目录的脸（sub2/avatar.jpg）同样被复用',
    thumbOf(r1, 'sub2') !== '(无)' && thumbOf(r1, 'sub2') === thumbOf(r2, 'sub2'),
);
// 复用必须**连 base64 一起带回来** —— `wire()` 靠它重新登记内存索引；
// 少带了，渲染层拿到的就是一个查不到的 key（图片全 404）
const hasData = (doc, name) => {
    const e = doc.data.find((d) => diskName(d) === name);
    return !!(e && (e.thumbData || e.avatarThumbData));
};
check(
    '★ 复用回来的条目带着 base64（否则前端 /thumb 会 404）',
    ['a.png', 'b.png', 'c.png', 'sub2'].every((f) => hasData(r2, f)),
);

// ─────────────────── R3 · 新增一个文件 ───────────────────
console.log('\n—— R3 盘上新增 1 个文件 ⇒ 只该抽这 1 张 ——');
touch(path.join(FIX, 'd.png'));
reset();
const r3 = await scan('folder');
const n3 = calls();
console.log(`  条目 ${r3.data.length}   抽帧 ${n3}`);
check('新增被收录（条目数 = 6）', r3.data.length === 6, `实际 ${r3.data.length}`);
check('★ 只抽新增的那 1 张，不是重抽全部', n3 === 1, `实际 ${n3}`);
check(
    '已有三张的 key 没被换掉',
    ['a.png', 'b.png', 'c.png'].every((f) => thumbOf(r2, f) === thumbOf(r3, f)),
);

// ─────────────────── R4 · 删除一个文件 ───────────────────
console.log('\n—— R4 盘上删除 1 个文件 ⇒ 零抽帧、条目减一 ——');
fs.rmSync(path.join(FIX, 'b.png'));
reset();
const r4 = await scan('folder');
const n4 = calls();
console.log(`  条目 ${r4.data.length}   抽帧 ${n4}`);
check('删除被识别（条目数 = 5）', r4.data.length === 5, `实际 ${r4.data.length}`);
check('★ 删除不引发任何抽帧', n4 === 0, `实际 ${n4}`);

// ─────────────────── R5 · cover 模式（handleCover 那条抽帧路径） ───────────────────
console.log('\n—— R5 cover 模式（走 handleCover 收敛路径）——');
reset();
const c1 = await scan('cover');
const cn1 = calls();
reset();
const c2 = await scan('cover');
const cn2 = calls();
console.log(`  首次条目 ${c1.data.length}   抽帧 ${cn1}`);
console.log(`  再次抽帧 ${cn2}`);
check('★ cover 模式下收敛封面同样被复用（零抽帧）', cn2 === 0, `实际 ${cn2}`);
const conv1 = c1.data.find((d) => d.files);
const conv2 = c2.data.find((d) => d.files);
check(
    '收敛条目存在，且它的 thumb 被复用',
    !!(conv1 && conv2 && conv1.thumb && conv1.thumb === conv2.thumb),
);

// ─────────────────── R6 · 同名同大小、只改内容（mtime 变） ───────────────────
// 为什么单列一轮：这是**唯一一条能测出"判据够不够"的用例** ——
// 夹具里的文件是空的（size 恒为 0），所以只改内容时，**光比 size 是发现不了的**。
// "封面被同名替换"正是这种形态，而判错一次就会**永久定格**在旧图。
console.log('\n—— R6 同名同大小、只改 mtime ⇒ 必须重抽那一张 ——');
const m1 = fs.statSync(path.join(FIX, 'a.png')).mtimeMs;
await new Promise((r) => setTimeout(r, 30));
touch(path.join(FIX, 'a.png'));
const m2 = fs.statSync(path.join(FIX, 'a.png')).mtimeMs;
check('夹具前提：mtime 真的变了', m2 !== m1, `${m1} → ${m2}`);
check('夹具前提：size 确实还是 0（比 size 一定发现不了）', fs.statSync(path.join(FIX, 'a.png')).size === 0);

reset();
const r6 = await scan('folder');
const n6 = calls();
console.log(`  抽帧 ${n6}`);
check('★ 源文件变了就必须重抽那 1 张（否则封面会被永久定格）', n6 === 1, `实际 ${n6}`);
check('其它条目依旧复用', thumbOf(r4, 'c.png') === thumbOf(r6, 'c.png'));

// ─────────────────── 收尾 ───────────────────
console.log(`\n==========  ${pass} PASS / ${fail} FAIL  ==========`);
console.log('（夹具与隔离库都在 %TEMP% 下，已删除；全程未碰真库与任何移动硬盘。）');

for (const d of [FIX, DATA, BUILD]) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* 句柄未释放就算了 */ }
}

process.exit(fail ? 1 : 0);
