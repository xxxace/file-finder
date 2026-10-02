/**
 * 探针 · 「文件夹显示大小」值不值得做 —— 一次聚合到底要多少钱？
 *
 *   node docs/probes/folder-size/run.mjs        # 输出写 out.txt（bash run.sh 同效）
 *
 * 要回答的三个问题：
 *   ① `loadMeta({withBytes:true})`（唯一现成的纯内存聚合）**一次要多久**；
 *   ② 拿它给"一屏里的所有子目录"各算一次子树总量，总成本是多少；
 *   ③ **有多少目录是算得出来的**（= 缓存的命中率）—— 这决定这个功能有没有用。
 *
 * 手法（照 `docs/skills` 里 real-module-probe 那套）：
 *   esbuild 把**真源文件** `electron/server/nedb.ts` 打成 bundle，在**纯 Node** 里跑。
 *   它只 import `@seald-io/nedb` / node 内置 / `../config` / `dayjs`，
 *   唯一的项目内依赖 `import type { FileInfo } from './index'` 是 **type-only**，
 *   esbuild 会擦掉 ⇒ 不会把 electron 拖进来，所以**不需要 electron 替身**。
 *
 * ⚠️ **不碰真库**：`config.userBasePath` 读 `process.env.USERPROFILE`，
 *    所以先把库**拷**到临时目录、把 USERPROFILE 指过去再 import。
 *    真库全程只读一次（copyFile）。理由：`loadDatabase()` 末尾会**无条件整库重写**，
 *    而 dev 实例可能正开着那个文件。
 *
 * ⚠️ **输出必须脱敏**（仓库铁律）：只写**数字**，绝不写 serial / relPath / 目录名。
 */
import { build } from 'esbuild';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');

/** 真库的位置：与 electron/config/index.ts 的 getUserBasePath() 同一算法 */
const realBase = path.resolve(process.env.USERPROFILE || process.env.USER || '/', './.file-finder');
const realDb = path.join(realBase, 'searchCache.db');

const log = (s) => console.log(s);

async function main() {
    if (!fs.existsSync(realDb)) {
        throw new Error(`找不到真库：${realDb}（路径由 USERPROFILE 推出，不打印内容）`);
    }
    const dbBytes = (await fsp.stat(realDb)).size;

    // ── 1. 拷到临时目录，把 USERPROFILE 指过去 ─────────────────────────────
    const sandbox = await fsp.mkdtemp(path.join(os.tmpdir(), 'ff-folder-size-'));
    const sandboxBase = path.join(sandbox, '.file-finder');
    await fsp.mkdir(sandboxBase, { recursive: true });
    await fsp.copyFile(realDb, path.join(sandboxBase, 'searchCache.db'));
    process.env.USERPROFILE = sandbox;
    process.env.USER = sandbox;
    log(`真库大小 ${(dbBytes / 1024 / 1024).toFixed(1)} MB → 已拷贝到临时目录（真库只读，不碰）`);

    // ── 2. 打真源文件 ──────────────────────────────────────────────────────
    // ⚠️ bundle 必须落在**项目内**：`packages: 'external'` 意味着运行时还要按
    // node_modules 解析 `@seald-io/nedb`，而临时目录向上找不到项目的 node_modules。
    // 放 `node_modules/.cache/` —— 它天然不入库（node_modules 被 .gitignore 挡住）。
    const cacheDir = path.join(repo, 'node_modules/.cache');
    await fsp.mkdir(cacheDir, { recursive: true });
    const outfile = path.join(cacheDir, `ff-folder-size.bundle-${Date.now()}.mjs`);
    await build({
        entryPoints: [path.join(repo, 'electron/server/nedb.ts')],
        bundle: true,
        platform: 'node',
        format: 'esm',
        target: 'node22',
        outfile,
        logLevel: 'silent',
        // 第三方包留在外面，从项目 node_modules 解析（避免 CJS 包被硬塞进 ESM）
        packages: 'external',
    });
    const mod = await import(pathToFileURL(outfile).href);
    const { loadMeta } = mod;

    // ── 3. 等库加载完（loadDatabase 是模块顶层异步起的，没有 ready 事件）────
    let rows = [];
    const tLoad = Date.now();
    for (let i = 0; i < 60; i++) {
        await new Promise(r => setTimeout(r, 500));
        try {
            rows = await loadMeta({ withBytes: true });
            if (rows.length) break;
        } catch { /* 加载中 */ }
    }
    if (!rows.length) throw new Error('库加载超时或为空');
    log(`库就绪：${rows.length} 条记录（等待 ${((Date.now() - tLoad) / 1000).toFixed(1)}s，含首次加载）`);

    // ── 4. 核心：一次 loadMeta 多少钱 ──────────────────────────────────────
    const times = [];
    for (let i = 0; i < 9; i++) {
        const t = performance.now();
        await loadMeta({ withBytes: true });
        times.push(performance.now() - t);
    }
    times.sort((a, b) => a - b);
    const median = times[Math.floor(times.length / 2)];
    log(`\n── ① loadMeta({withBytes}) 单次耗时（9 次）──`);
    log(`  最小 ${times[0].toFixed(2)} ms · 中位 ${median.toFixed(2)} ms · 最大 ${times[times.length - 1].toFixed(2)} ms`);

    // ── 5. 模拟：给每个目录算一次"子树总字节" ──────────────────────────────
    // ⚠️ **先确认真实分隔符**，不能猜：猜错的话 `startsWith(root + sep)` 对深层目录
    // 全返回 false ⇒ 子树总量退化成"只有自己那一层" ⇒ 命中率虚高、结论也就错了。
    const nSlash = rows.filter(r => r.relPath.includes('/')).length;
    const nBackslash = rows.filter(r => r.relPath.includes('\\')).length;
    const nFlat = rows.filter(r => r.relPath === '').length;
    const sep = nBackslash > nSlash ? '\\' : '/';
    log(`\n── 路径形态自检（决定前缀匹配怎么写）──`);
    log(`  含 '/' 的 ${nSlash} 条 · 含 '\\' 的 ${nBackslash} 条 · 盘根（空 relPath）${nFlat} 条`);
    log(`  ⇒ 采用分隔符 '${sep}'${nSlash > 0 && nBackslash > 0 ? ' ⚠️ 两种都存在，需人工确认' : ''}`);

    // 前缀匹配必须按**路径边界**：`H:/a` 不能吃掉 `H:/ab`
    const inSubtree = (child, root) => root === '' || child === root || child.startsWith(root + sep);

    const t0 = performance.now();
    let withSize = 0;
    let zeroSize = 0;
    const roots = rows.map(r => ({ serial: r.serial, relPath: r.relPath }));
    for (const root of roots) {
        let sum = 0;
        for (const m of rows) {
            if (m.serial === root.serial && inSubtree(m.relPath, root.relPath)) sum += m.bytes || 0;
        }
        if (sum > 0) withSize++; else zeroSize++;
    }
    const tSubtree = performance.now() - t0;
    log(`\n── ② 最坏情况：给**每一条**记录各算一次子树总量（O(n²)，n=${rows.length}）──`);
    log(`  总耗时 ${tSubtree.toFixed(2)} ms · 摊到每条 ${(tSubtree / rows.length).toFixed(3)} ms`);

    // ── 6. 命中率：有多少目录算得出 > 0 ────────────────────────────────────
    const bytesPositive = rows.filter(r => (r.bytes || 0) > 0).length;
    log(`\n── ③ 命中率（决定功能价值）──`);
    log(`  记录数 ${rows.length}`);
    log(`  这一层本身有内容（bytes > 0）的：${bytesPositive} 条（${(bytesPositive / rows.length * 100).toFixed(0)}%）`);
    log(`  子树总量 > 0（能给父级提供大小）的：${withSize} 条（${(withSize / rows.length * 100).toFixed(0)}%）`);
    log(`  子树算不出来（= 没被扫过）：${zeroSize} 条`);
    const totalBytes = rows.reduce((n, r) => n + (r.bytes || 0), 0);
    log(`  全库合计 ${(totalBytes / 1024 / 1024 / 1024 / 1024).toFixed(2)} TB（纯内存求和，零读盘）`);

    // ── 6b. ⭐ 真·功能价值：**浏览某一层时，网格里的子文件夹有几个算得出大小** ──
    // 上面 ③ 量的是"缓存记录本身能不能算出大小" —— 那**不是**用户要的东西。
    // 用户要的是：进到一个目录，网格里列出的**那些子文件夹**各自多大。
    // 而子文件夹有没有大小，取决于**它自己有没有被扫过**（有记录才有 bytes）。
    // ⇒ 必须拿 `data` 里的 folder 条目去库里对。`loadMeta` 把 data 剥掉了，
    //   所以这里用 `readExternalCache`（它读的是同一份文件，含 data）。
    log(`\n── ④ 真·功能价值：网格里的子文件夹，有几个能显示大小 ──`);
    const docs = await mod.readExternalCache(path.join(sandboxBase, 'searchCache.db'));
    const haveRecord = new Set(docs.map(d => `${d.serial}|${d.relPath}`));
    /** 子树总量（一次性建表，O(n²) 已在 ② 量过：2 ms 级） */
    const subtreeOf = new Map();
    for (const d of docs) {
        let sum = 0;
        for (const m of docs) {
            if (m.serial === d.serial && inSubtree(m.relPath, d.relPath)) sum += (m.data || []).reduce((n, it) => n + (it.size || 0), 0);
        }
        subtreeOf.set(`${d.serial}|${d.relPath}`, sum);
    }

    let subTotal = 0;
    let subKnown = 0;
    let layersWithSub = 0;
    for (const d of docs) {
        const kids = (d.data || []).filter(it => it.type === 'folder');
        if (!kids.length) continue;
        layersWithSub++;
        for (const kid of kids) {
            subTotal++;
            const key = `${d.serial}|${d.relPath ? d.relPath + '/' + kid.name : kid.name}`;
            if (haveRecord.has(key) && (subtreeOf.get(key) || 0) > 0) subKnown++;
        }
    }
    const pct = subTotal ? (subKnown / subTotal * 100) : 0;
    log(`  有子文件夹的层数：${layersWithSub}（平均每层 ${(subTotal / Math.max(1, layersWithSub)).toFixed(1)} 个子文件夹）`);
    log(`  子文件夹总数 ${subTotal} · **能算出大小的 ${subKnown}（${pct.toFixed(0)}%）** · 算不出的 ${subTotal - subKnown}`);
    log(`  ⇒ 这个百分比才是用户实际会看到的命中率：剩下那些 hover 出来仍是「—」`);

    // ── 7. 结论判据 ────────────────────────────────────────────────────────
    log(`\n── 判据 ──`);
    const checks = [
        [`单次聚合中位 ${median.toFixed(2)} ms < 16ms（不进一帧的预算）`, median < 16],
        [`最坏情况 O(n²) 总耗时 ${tSubtree.toFixed(1)} ms < 50ms`, tSubtree < 50],
        [`**子文件夹**能算出大小的比例 ${pct.toFixed(0)}% ≥ 50%`, pct >= 50],
    ];
    for (const [label, pass] of checks) log(`  ${pass ? '✅' : '❌'} ${label}`);

    await fsp.rm(sandbox, { recursive: true, force: true }).catch(() => undefined);
    await fsp.rm(outfile, { force: true }).catch(() => undefined);
    log('\n（临时目录与 bundle 已清理）');
}

main().catch(e => {
    console.error('PROBE FAILED:', e && e.message ? e.message : e);
    process.exit(1);
});
