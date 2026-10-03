/**
 * 验证 · 离线盘下拉框漏项 —— 「已知盘全集」到底该从哪来。
 *
 *   node docs/probes/disk-offline-set/probe.mjs      # 输出重定向到 out.txt
 *
 * 病：`/getDisks` 的离线盘列表原来取 `Object.keys(disks.json)` 当全集，而注册表只在
 * `?refresh=true`（用户点「刷新」）时才登记 ⇒ "插过 / 扫过 / 从没点过刷新"的盘不在里面，
 * 它的缓存记录还在库里，下拉框里却**没有任何选项**能过滤它。
 *
 * 三路交叉（判据只认第 ② 条，①②③ 的关系见每条的文字说明）：
 *   ① **真数据对照** —— 真库的 serial 集合 vs 真注册表的键，看旧实现漏了几块。
 *      ⚠️ 这条**不是判据**：数字随用户点不点「刷新」而变，0 只说明"这次没踩到"。
 *   ② **恒等式（判据）** —— 「库里每个不在线的 serial 都必须在 offline 里」。
 *      它对**任何** drives 取值、任何库都成立，所以不受当前数据形态影响。
 *   ③ **构造边界** —— 空注册表 / 库空 / 部分在线 / 交集去重。真库不一定覆盖得到。
 *   ④ **空值点** —— 修复必然让 `offline` 含"注册表里没有的 serial"，
 *      照原样写 `registry[s].label` 就是 `undefined.label` ⇒ 整个 `/getDisks` 500。
 *
 * 手法同 folder-size/verify.mjs：拷真库+真注册表到沙箱、把 USERPROFILE 指过去、esbuild 打真源文件。
 * **本探针不扫任何盘符**（drives 一律构造），零读盘。
 *
 * ⚠️ **输出脱敏**：只输出数字与布尔，绝不输出 serial / 盘符 / relPath / 目录名。
 */
import { build } from 'esbuild';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const realBase = path.resolve(process.env.USERPROFILE || process.env.USER || '/', './.file-finder');

let pass = 0, fail = 0;
const check = (label, ok) => {
    ok ? pass++ : fail++;
    console.log(`  ${ok ? '✅' : '❌'} ${label}`);
};
const throws = (fn) => { try { fn(); return false; } catch { return true; } };

/** 修复前的实现 —— 逐字复刻（`driveIdentity.ts` 改动前的那 4 行） */
const legacy = (registry, drives) => {
    const online = new Set(drives.map((d) => d.serial));
    return Object.keys(registry).filter((serial) => !online.has(serial));
};

/** 把 serial 列表包成 DriveInfo[]（本探针不碰盘符，只测集合运算） */
const driveStubs = (serials) => serials.map((s) => ({ serial: s, drive: 'T', root: 'T:/', label: '' }));

async function main() {
    // ── 沙箱：拷真库 + 真注册表，USERPROFILE 指过去（config.ts 读它）──────────
    const sandbox = await fsp.mkdtemp(path.join(os.tmpdir(), 'ff-disk-set-'));
    const sandboxBase = path.join(sandbox, '.file-finder');
    await fsp.mkdir(sandboxBase, { recursive: true });
    await fsp.copyFile(path.join(realBase, 'searchCache.db'), path.join(sandboxBase, 'searchCache.db'));
    let hasRegistry = true;
    try {
        await fsp.copyFile(path.join(realBase, 'disks.json'), path.join(sandboxBase, 'disks.json'));
    } catch { hasRegistry = false; }
    process.env.USERPROFILE = sandbox;
    process.env.USER = sandbox;

    // ── 打真源文件（样板同 folder-size/verify.mjs）─────────────────────────
    const cacheDir = path.join(repo, 'node_modules/.cache');
    await fsp.mkdir(cacheDir, { recursive: true });
    const bundleOf = async (entry, tag) => {
        const outfile = path.join(cacheDir, `ff-disk-set.${tag}-${Date.now()}.mjs`);
        await build({
            entryPoints: [path.join(repo, entry)],
            bundle: true, platform: 'node', format: 'esm', target: 'node22',
            outfile, logLevel: 'silent', packages: 'external',
        });
        return import(pathToFileURL(outfile).href);
    };
    const di = await bundleOf('electron/utils/driveIdentity.ts', 'di');
    const nedb = await bundleOf('electron/server/nedb.ts', 'nedb');

    const { offlineSerials } = di;
    const registry = await di.readRegistry();
    const metas = await nedb.loadMeta();
    const libSerials = [...new Set(metas.map((m) => m.serial))];
    const regKeys = Object.keys(registry);

    // ══ ① 真数据对照（**参考值，非判据**）══════════════════════════════════
    console.log('\n── ① 真数据：库 vs 注册表（只输出数字）──');
    const onlyInLib = libSerials.filter((s) => !(s in registry));
    console.log(`  注册表文件存在：${hasRegistry} · 注册表里的盘 ${regKeys.length} · 库里的盘 ${libSerials.length}`);
    console.log(`  库里有、注册表**没有**的盘：${onlyInLib.length} 块（它们的记录总数 ${metas.filter((m) => onlyInLib.includes(m.serial)).length} 条）`);
    console.log(`  ℹ️ 这个数字随"用户有没有点过刷新"变化 ⇒ **不作判据**，只说明本次踩没踩到。`);

    // ══ ② 恒等式：库里每个不在线的 serial 都必须在 offline 里（**判据**）══════
    console.log('\n── ② 恒等式（判据）：libSerials \\ online ⊆ offline ──');
    const knownSet = () => new Set([...regKeys, ...libSerials]);
    const scenarios = [
        ['drives = ∅（一块都不在线）', []],
        ['drives = 库里前一半', libSerials.slice(0, Math.ceil(libSerials.length / 2))],
        ['drives = 库里全部', libSerials],
        ['drives = 注册表全部', regKeys],
        ['drives = 与之完全不相交（构造）', ['ZZZZ0001', 'ZZZZ0002']],
    ];
    let newBad = 0, oldBad = 0;
    for (const [name, onlineSerials] of scenarios) {
        const drives = driveStubs(onlineSerials);
        const online = new Set(onlineSerials);
        const want = libSerials.filter((s) => !online.has(s));

        const gotNew = offlineSerials(knownSet(), drives);
        const gotOld = legacy(registry, drives);
        if (!want.every((s) => gotNew.includes(s))) { newBad++; console.log(`     ↳ 新版破于：${name}`); }
        if (!want.every((s) => gotOld.includes(s))) oldBad++;
    }
    check(`新版：${scenarios.length} 种在线组合全部满足恒等式（破 ${newBad}）`, newBad === 0);
    // ⚠️ 这条**不能当判据**：它依赖"真库此刻恰好有一块盘不在注册表里"，
    // 而那个状态随用户点没点过「刷新」变化 —— 实测 2026-10-03 有 1 块（3 条记录），
    // 2026-10-04 复跑已变成 0 块 ⇒ 它会假 FAIL。**稳定的复现在 ③ 段**（构造数据，与真库无关）。
    console.log(`  ℹ️ 旧版：同一组真库场景里破 ${oldBad} 处 —— **只作观察、不作判据**`);

    // ══ ③ 构造边界 ═════════════════════════════════════════════════════════
    console.log('\n── ③ 构造边界（占位 serial，非真实值）──');
    const R = { AAAAAAAA: { label: '', firstSeenAt: '', lastSeenAt: '' }, BBBBBBBB: { label: '', firstSeenAt: '', lastSeenAt: '' } };
    const L = ['AAAAAAAA', 'BBBBBBBB', 'CCCCCCCC'];
    const D = driveStubs(['BBBBBBBB']);

    const out = offlineSerials(new Set([...Object.keys(R), ...L]), D);
    check('库里有、注册表没有的 CCCCCCCC ⇒ 出现在离线表（修复目标）', out.includes('CCCCCCCC'));
    check('旧实现在同一输入上漏掉 CCCCCCCC（复现）', !legacy(R, D).includes('CCCCCCCC'));
    check('在线中的 BBBBBBBB 不出现在离线表', !out.includes('BBBBBBBB'));
    check('注册表独有的盘不回归：把 AAAAAAAA 拔掉后仍在（库里有它时）', out.includes('AAAAAAAA'));
    check('交集去重：AAAAAAAA 只出现一次（registry 与库重叠）', out.filter((s) => s === 'AAAAAAAA').length === 1);

    check('库为空 ⇒ 离线表 = 注册表 - 在线（退化成原行为）',
        JSON.stringify(offlineSerials(new Set(Object.keys(R)), D)) === JSON.stringify(['AAAAAAAA']));
    check('注册表为空 ⇒ 离线表 = 库 - 在线（旧实现此处会返回空，即"整库消失"）',
        JSON.stringify(offlineSerials(new Set(L), D)) === JSON.stringify(['AAAAAAAA', 'CCCCCCCC']));
    check('两边都空 ⇒ 空表（返回数组，不是 null/undefined）',
        Array.isArray(offlineSerials(new Set(), [])) && offlineSerials(new Set(), []).length === 0);
    check('known 接受任意 Iterable（Set 直传 / 数组都行）',
        offlineSerials(new Set(['DDDDDDDD']), []).length === 1 && offlineSerials(['DDDDDDDD'], []).length === 1);

    // ══ ④ 空值点：修复带来的那条连带改动为什么必需 ═════════════════════════════
    console.log('\n── ④ 空值点（`offline` 现在可能含注册表之外的盘）──');
    const tinyReg = { AAAAAAAA: { label: 'x', firstSeenAt: '', lastSeenAt: '' } };
    check('`registry[缺失].label` 会抛 TypeError（按原样写就是 /getDisks 500）', throws(() => tinyReg['CCCCCCCC'].label));
    check('`registry[缺失]?.label || ""` 不抛（第 3 处改动的理由）', !throws(() => tinyReg['CCCCCCCC']?.label || ''));

    await fsp.rm(sandbox, { recursive: true, force: true }).catch(() => undefined);
    console.log(`\n${fail === 0 ? '✅' : '❌'} 通过 ${pass} / 失败 ${fail}`);
    if (fail) process.exitCode = 1;
}

main().catch((e) => {
    console.error('PROBE FAILED:', e && e.message ? e.message : e);
    process.exit(1);
});
