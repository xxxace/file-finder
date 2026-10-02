/**
 * 验证 · `mergeSubtreeBytes` / `loadSubtreeBytes` 到底算得对不对。
 *
 *   node docs/probes/folder-size/verify.mjs      # 输出写 out.txt
 *
 * 三路交叉，缺一不可：
 *   ① **边界用构造数据** —— `a` vs `ab` 的路径边界、当前目录自己被排除、盘根、
 *      serial 过滤。真库数据**不一定覆盖得到**这些形态，只能自己造。
 *   ② **正确性用真库 + 守恒律** —— 对库里每一条记录当一次 `baseRel`，
 *      校验 Σ(子树) == 该子树内所有记录（除自己）的 bytes 之和。这是**恒等式**，
 *      写错了必然在某条上破。
 *   ③ **独立朴素实现对照** —— 另写一份"先找出子目录名、再逐个做完整前缀匹配"的
 *      朴素版，两条路径不同 ⇒ 归并版里的 slice off-by-one 会被暴露出来。
 *
 * 手法同 run.mjs（拷库 + 改 USERPROFILE + esbuild 打真源文件），
 * 但这里打的是**实现之后**的 `nedb.ts`。
 *
 * ⚠️ **输出脱敏**：真库部分只输出**数字与布尔**，绝不输出 relPath / 目录名 / serial。
 */
import { build } from 'esbuild';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const realDb = path.resolve(process.env.USERPROFILE || process.env.USER || '/', './.file-finder/searchCache.db');

let pass = 0, fail = 0;
const check = (label, ok) => {
    ok ? pass++ : fail++;
    console.log(`  ${ok ? '✅' : '❌'} ${label}`);
};

async function main() {
    // ── 打包真源文件（样板与 run.mjs 同）──────────────────────────────────
    const sandbox = await fsp.mkdtemp(path.join(os.tmpdir(), 'ff-verify-subtree-'));
    const sandboxBase = path.join(sandbox, '.file-finder');
    await fsp.mkdir(sandboxBase, { recursive: true });
    await fsp.copyFile(realDb, path.join(sandboxBase, 'searchCache.db'));
    process.env.USERPROFILE = sandbox;
    process.env.USER = sandbox;

    const cacheDir = path.join(repo, 'node_modules/.cache');
    await fsp.mkdir(cacheDir, { recursive: true });
    const outfile = path.join(cacheDir, `ff-verify.bundle-${Date.now()}.mjs`);
    await build({
        entryPoints: [path.join(repo, 'electron/server/nedb.ts')],
        bundle: true, platform: 'node', format: 'esm', target: 'node22',
        outfile, logLevel: 'silent', packages: 'external',
    });
    const mod = await import(pathToFileURL(outfile).href);
    const { mergeSubtreeBytes, loadSubtreeBytes, loadMeta } = mod;

    // ══ ① 边界：构造数据（占位名，非真实数据）══════════════════════════════
    console.log('\n── ① 边界用例（构造数据）──');
    const S = 'TST00001', OTHER = 'TST00002';
    const rows = [
        { serial: S, relPath: '', bytes: 10 },              // 盘根自己那条
        { serial: S, relPath: 'a', bytes: 1 },              // ⚠️ 与下一行构成路径边界
        { serial: S, relPath: 'ab', bytes: 2 },
        { serial: S, relPath: 'a/x', bytes: 100 },
        { serial: S, relPath: 'a/x/deep', bytes: 1000 },    // 深两层，应归到 x
        { serial: S, relPath: 'a/y', bytes: 200 },
        { serial: S, relPath: 'b', bytes: 4 },
        { serial: OTHER, relPath: 'a/z', bytes: 9999 },     // 别的盘，必须忽略
    ];
    const a = mergeSubtreeBytes(rows, S, 'a');
    check('baseRel="a"：深两层的 a/x/deep 归到直接子目录 x（100+1000=1100）', a.get('x') === 1100);
    check('baseRel="a"：同级兄弟 a/y = 200', a.get('y') === 200);
    check('baseRel="a"：**只有 2 个**子目录（a 自己那条被排除）', a.size === 2);
    check('baseRel="a"：**不吃掉 `ab`**（路径边界，不是裸 startsWith）', !a.has('ab') && !a.has('b'));
    check('baseRel="a"：**不跨界**（别的 serial 的 a/z 不计入）', a.get('x') !== 1100 + 9999);

    const root = mergeSubtreeBytes(rows, S, '');
    check('baseRel=""（盘根）：a = 1+100+1000+200 = 1301', root.get('a') === 1301);
    check('baseRel=""：ab = 2（与 a 分开算）', root.get('ab') === 2);
    check('baseRel=""：b = 4，共 3 个直接子目录', root.get('b') === 4 && root.size === 3);
    check('baseRel=""：盘根自己那条（relPath=""）不计入任何子目录', !root.has(''));

    check('serial 为空 ⇒ 空表（非盘符路径不该聚合）', mergeSubtreeBytes(rows, '', '').size === 0);
    check('serial 不存在 ⇒ 空表', mergeSubtreeBytes(rows, 'NOPE', 'a').size === 0);
    check('库里没有的目录 ⇒ 空表', mergeSubtreeBytes(rows, S, 'nope').size === 0);

    // ══ ②③ 真库：守恒律 + 独立朴素实现对照 ════════════════════════════════
    console.log('\n── ②③ 真库（只输出数字，不输出任何路径/名字）──');
    const metas = await loadMeta({ withBytes: true });
    console.log(`  记录数 ${metas.length}`);

    /** 独立朴素实现：先找出所有直接子目录名，再逐个做**完整**前缀匹配 */
    const naive = (all, serial, baseRel) => {
        const prefix = baseRel ? baseRel + '/' : '';
        const kids = new Set();
        for (const m of all) {
            if (m.serial !== serial) continue;
            if (baseRel && m.relPath === baseRel) continue;
            if (prefix && !m.relPath.startsWith(prefix)) continue;
            const rest = baseRel ? m.relPath.slice(prefix.length) : m.relPath;
            if (!rest) continue;
            const cut = rest.indexOf('/');
            kids.add(cut === -1 ? rest : rest.slice(0, cut));
        }
        const out = new Map();
        for (const k of kids) {
            const childRel = baseRel ? `${baseRel}/${k}` : k;
            let sum = 0;
            for (const m of all) {
                if (m.serial !== serial) continue;
                if (m.relPath === childRel || m.relPath.startsWith(childRel + '/')) sum += m.bytes || 0;
            }
            out.set(k, sum);
        }
        return out;
    };

    let cmpBad = 0, conserveBad = 0, maxKids = 0, layersWithKids = 0, nonZeroLayers = 0;
    const t0 = performance.now();
    for (const base of metas) {
        const got = mergeSubtreeBytes(metas, base.serial, base.relPath);
        const want = naive(metas, base.serial, base.relPath);

        // 对照：两个实现必须逐键逐值一致
        if (got.size !== want.size) cmpBad++;
        else for (const [k, v] of got) if (want.get(k) !== v) { cmpBad++; break; }

        if (got.size) layersWithKids++;
        if (got.size && [...got.values()].some(v => v > 0)) nonZeroLayers++;
        maxKids = Math.max(maxKids, got.size);

        // 守恒律：Σ(全部子目录子树) == 该子树内**除自己**外所有记录的 bytes 之和
        const prefix = base.relPath ? base.relPath + '/' : '';
        let expect = 0;
        for (const m of metas) {
            if (m.serial !== base.serial) continue;
            if (base.relPath && m.relPath === base.relPath) continue;
            if (prefix && !m.relPath.startsWith(prefix)) continue;
            if (!m.relPath) continue;
            expect += m.bytes || 0;
        }
        const actual = [...got.values()].reduce((n, v) => n + v, 0);
        if (actual !== expect) conserveBad++;
    }
    const elapsed = performance.now() - t0;

    check(`三路对照：**每一条**记录的归并结果都一致（${metas.length} 条，不一致 0）`, cmpBad === 0);
    check(`守恒律：Σ(子树) == 子树内记录 bytes 之和（破了 ${conserveBad} 条）`, conserveBad === 0);
    console.log(`  有子目录的层：${layersWithKids} · 其中至少一个子目录 > 0 的层：${nonZeroLayers} · 单层最多子目录数：${maxKids}`);
    console.log(`  ${metas.length} 层全跑一遍（含朴素实现对照）合计 ${elapsed.toFixed(1)} ms`);

    // ── ④ 交付路径（含 loadMeta 取数）的真实成本 ──────────────────────────
    console.log('\n── ④ loadSubtreeBytes（含 loadMeta 取数）单次耗时 ──');
    const times = [];
    for (let i = 0; i < 7; i++) {
        const t = performance.now();
        await loadSubtreeBytes(metas[0].serial, metas[0].relPath);
        times.push(performance.now() - t);
    }
    times.sort((a, b) => a - b);
    console.log(`  最小 ${times[0].toFixed(2)} ms · 中位 ${times[3].toFixed(2)} ms · 最大 ${times[times.length - 1].toFixed(2)} ms`);
    check('单次 < 16ms（readFolder 是热路径，不进一帧的预算）', times[3] < 16);

    // ── ⑤ 键一致性：`subBytes` 的键必须用**原始目录名**，不能用 `getFilename()` ──
    // `getFilename` 是"去掉最后一个扩展名"的（给文件条目拆 name/ext 用），
    // 而库里的 relPath 段是 `readdir` 给的原样名字。目录名带点就会对不上。
    // 这一段证明那种目录名**真实存在**，不是理论担忧 —— 所以查表必须用 `file`。
    console.log('\n── ⑤ 键一致性（目录名带点的有多少）──');
    const docs = await mod.readExternalCache(path.join(sandboxBase, 'searchCache.db'));
    let dirTotal = 0, dirWithDot = 0;
    for (const d of docs) {
        for (const it of (d.data || [])) {
            if (it.type !== 'folder') continue;
            dirTotal++;
            // 目录条目带 ext ⇒ 原始目录名里有点（`v1.2` 这类）。只统计个数，不输出名字。
            if (it.ext) dirWithDot++;
        }
    }
    console.log(`  目录条目 ${dirTotal} 个 · 其中**原始名带点**的 ${dirWithDot} 个（${(dirWithDot / Math.max(1, dirTotal) * 100).toFixed(1)}%）`);
    // ⚠️ 这一条**不是判据** —— 它量的是"当前数据里有没有这种形态"，不是"实现对不对"。
    // 0 个只说明**这条分叉没被真实数据覆盖**，所以要分清证据等级：
    //   · "库里键 = readdir 原始名" —— **静态事实**（`relPath` 就是这么写进去的）
    //   · "用 `getFilename` 会查不到" —— **按契约的推理**，当前库上**未实测**
    // 两个方向都不该拿"当前数据恰好没有"去当结论 —— 那正是拿快照当事实。
    console.log(`  ${dirWithDot > 0
        ? '⚠️ 库里存在这种目录名 ⇒ 这条分叉被真实数据覆盖'
        : 'ℹ️ 库里 0 个 ⇒ **这条分叉未被真实数据覆盖**；"必须用原始名"是按契约推出来的（未实测）'}`);

    // ── ⑥ 端到端：**从缓存里读出来的那一层**，目录条目查得到 size 吗 ────────────
    // 这一段针对的正是上一版漏掉的失效模式：**浏览已缓存的目录不经过 `readFolder`**
    // （走 `findCache` 短路），所以补 size 必须在**下发态**做。
    // 这里拿真库里每条记录的 `data`（= `cached.data` 的样子）**模拟 `wire()` 那一步**，
    // 验证"条目名 → 子树表键"真的对得上 —— 这是端到端链路里唯一没被测过的接缝。
    console.log('\n── ⑥ 端到端：cached.data 里的目录条目查得到 size 吗 ──');
    let dirItems = 0, hitDiskName = 0, hitRawName = 0, hitPositive = 0, layers = 0;
    for (const doc of docs) {
        const sub = mergeSubtreeBytes(metas, doc.serial, doc.relPath);
        if (!sub.size) continue;
        layers++;
        for (const it of (doc.data || [])) {
            if (it.type !== 'folder') continue;
            dirItems++;
            // 实现里用的规则（`diskNameOf`）：真名 = name + '.' + ext
            const diskName = it.ext ? `${it.name}.${it.ext}` : it.name;
            const byDisk = sub.get(diskName);
            if (byDisk !== undefined) { hitDiskName++; if (byDisk > 0) hitPositive++; }
            // 对照：直接用 `item.name`（削过扩展名的）查
            if (sub.get(it.name) !== undefined) hitRawName++;
        }
    }
    console.log(`  有子树表的层 ${layers} · 其中的目录条目 ${dirItems} 个`);
    console.log(`  用**真名**（diskNameOf 规则）查到：${hitDiskName}（${(hitDiskName / Math.max(1, dirItems) * 100).toFixed(0)}%）`);
    console.log(`  其中 size > 0 的：${hitPositive}`);
    console.log(`  对照·直接用 item.name 查：${hitRawName}（当前数据下两者相同，因为库里没有带点目录名）`);
    check(`端到端：cached.data 的目录条目绝大多数查得到（${hitDiskName}/${dirItems}）`, hitDiskName >= dirItems * 0.9);
    check(`端到端：查到的里面绝大多数 size > 0（${hitPositive}/${hitDiskName}）`, hitPositive >= hitDiskName * 0.9);

    await fsp.rm(sandbox, { recursive: true, force: true }).catch(() => undefined);
    await fsp.rm(outfile, { force: true }).catch(() => undefined);
    console.log(`\n${fail === 0 ? '✅' : '❌'} 通过 ${pass} / 失败 ${fail}`);
    if (fail) process.exitCode = 1;
}

main().catch(e => {
    console.error('PROBE FAILED:', e && e.message ? e.message : e);
    process.exit(1);
});
