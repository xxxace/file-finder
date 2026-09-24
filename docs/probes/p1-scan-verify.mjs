/**
 * P1 批量扫描 · 服务端侧的端到端验证（一切夹具在 %TEMP%，不碰 E:/F:）。
 *
 * 验两件事 —— 都是**真实产物**在跑，不是复刻：
 *   A. 并发保护：同一主键 **8 个并发请求** → 库里活记录**恰好 1 条**
 *      对照组 = 只把那段队列还原成"裸 remove + 裸 insert"的同一个产物，应当 >1 条
 *      → 判据有区分力（不是空过）
 *   B. 两个模式的语义：`补全`（不带 noCache）**不重读**已缓存目录；
 *      `重扫`（每层 noCache=true）才重读
 *
 * 做法（照 docs/VERIFY-P0-2026-09-24.md §四 的配方）：
 *   把 `electron/` 复制两份到 %TEMP%，**只改被复制的那份**（端口 + 还原并发修复），
 *   esbuild 打成 CJS（external 全部裸模块，与生产 notBundle 契约一致），
 *   给 `electron` 放一个替身包，两个变体在**同一进程**里各起一个服务（端口/数据目录隔离）。
 *
 * ⚠️ 为什么不是"每个变体 spawn 一个从进程"（P0 那次的做法）：本环境里
 * `spawnSync` 一律 **EBUSY**（连禁沙箱也一样）—— 已实测，见交付文档。所以改成同进程、
 * 换 `USERPROFILE` 后 `require` 各自产物：`config.userBasePath` 是模块加载时算的，
 * 所以每个变体仍然落在自己的数据目录上，隔离度不变。
 *
 * 复算：node docs/probes/p1-scan-verify.mjs
 * 前置状态：每次自建全新的 %TEMP% 目录，不需要手清（P0 那次踩过脏库的坑）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import Module, { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const require = createRequire(import.meta.url);
const REPO = fileURLToPath(new URL('../..', import.meta.url));
const PROBE = path.join(os.tmpdir(), `ff-p1-verify-${Date.now()}`);
const PORTS = { after: 3063, before: 3064 };

// 产物是"external 全部裸模块"（与生产 notBundle 契约一致），而它落在 %TEMP% 里，
// 靠目录向上找不到仓库的 node_modules —— 用 NODE_PATH 补，`_initPaths()` 让它立即生效。
// PROBE/node_modules 里那个 `electron` 替身仍然**优先**（同一次解析里离得更近）
process.env.NODE_PATH = [path.join(REPO, 'node_modules'), process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
Module._initPaths();

/** 夹具：全部是文本，**没有图片/视频** → 这条链路一次 ffmpeg 都不会起 */
const FIXTURE = {
    'r.txt': '',
    'A/a.txt': '',
    'A/sub/s.txt': '',
    'A/sub/deep/d.txt': '',
    'B/b.txt': '',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function write(p, content) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
}

/** 复制一份 electron/ 并按变体打补丁（只改副本）。返回补丁后的源码目录与产物路径 */
async function prepare(variant) {
    const srcDir = path.join(PROBE, `src-${variant}`);
    fs.cpSync(path.join(REPO, 'electron'), srcDir, { recursive: true });

    const indexFile = path.join(srcDir, 'server', 'index.ts');
    let src = fs.readFileSync(indexFile, 'utf8');
    const must = (before, after, what) => {
        const parts = src.split(before);
        if (parts.length !== 2) throw new Error(`补丁失败(${variant} / ${what})：命中 ${parts.length - 1} 次`);
        src = parts.join(after);
    };

    // 端口：不能撞用户正在跑的 3060
    must('app.listen(3060,', `app.listen(${PORTS[variant]},`, '端口');

    if (variant === 'before') {
        // 只还原"把两步收进队列"这一处，其余全部保持工作区原样 —— 单变量对照
        must(`    await queueCacheWrite(serial, relPath, mode, async () => {
        // 先删后插：nedb 是 append-only，直接 insert 会在文件里留下两份，
        // 而且 findCache 会取到旧的那份
        await removeCache(serial, relPath, mode);
        await insertCache(doc);
    });`, `    await removeCache(serial, relPath, mode);
    await insertCache(doc);`, '还原队列');

        must(`    const cached = noCache ? null : await findCache(serial, relPath, mode);
    const doc = cached ?? (await scanAndCache(serial, drive, relPath, mode));`,
            `    if (noCache) await removeCache(serial, relPath, mode);
    const cached = noCache ? null : await findCache(serial, relPath, mode);
    const doc = cached ?? (await scanAndCache(serial, drive, relPath, mode));`, '还原孤立 remove');
    }
    fs.writeFileSync(indexFile, src);

    // electron 替身包：只补 nativeImage（夹具全是文本，实际一次都不会被调到）
    const stub = path.join(PROBE, 'node_modules', 'electron');
    write(path.join(stub, 'package.json'), JSON.stringify({ name: 'electron', version: '0.0.0', main: 'index.js' }));
    write(path.join(stub, 'index.js'), `exports.nativeImage = { createFromPath(fp) {
  let size = 0; try { size = require('node:fs').statSync(fp).size; } catch {}
  const ok = size > 0;
  return { isEmpty: () => !ok, getSize: () => ({ width: 800, height: 600 }), resize() { return this; }, toJPEG: () => Buffer.from('STUB-JPEG:' + size) };
} };\n`);

    const entry = path.join(PROBE, `entry-${variant}.ts`);
    const outfile = path.join(PROBE, 'out', `${variant}.cjs`);
    write(entry, `export { LOCAL_TOKEN } from './src-${variant}/server/token';\nimport './src-${variant}/server/index';\n`);
    await esbuild.build({
        entryPoints: [entry], outfile, bundle: true,
        platform: 'node', format: 'cjs', packages: 'external', logLevel: 'silent',
    });
    return { outfile, dataDir: path.join(PROBE, `data-${variant}`) };
}

/**
 * 数库里某个主键的**活记录 id**。
 *
 * ⚠️ nedb 是 append-only：`remove` 不删行，只追加一条 `{ $$deleted: true, _id }`。
 * 所以**光"跳过 $$deleted 行"是错的** —— 那会把"已经被删掉的旧记录"也算成活的
 * （这个坑我当场踩了：naive 数法给出 10 条，按 `_id` 过滤才是 1 条）。
 *
 * 返回 id 列表而不是条数：id 变没变本身就是"有没有真的写过这一层"的直接证据。
 */
function liveIds(dataDir, serial, relPath) {
    const raw = fs.readFileSync(path.join(dataDir, '.file-finder', 'searchCache.db'), 'utf8');
    const dead = new Set();
    const rows = [];
    for (const line of raw.split('\n')) {
        if (!line) continue;
        let d;
        try { d = JSON.parse(line); } catch { continue; }
        if (d.$$deleted) { if (d._id) dead.add(d._id); continue; }
        if (d.$$indexCreated) continue;
        rows.push(d);
    }
    return rows
        .filter((d) => d.serial === serial && d.relPath === relPath && d.mode === 'cover' && !dead.has(d._id))
        .map((d) => d._id);
}

async function scenario(variant, { outfile, dataDir }, root) {
    fs.mkdirSync(dataDir, { recursive: true });
    // 必须在 require 之前设好：userBasePath 是模块加载时算的
    process.env.USERPROFILE = dataDir;
    const PORT = PORTS[variant];
    const TOKEN = require(outfile).LOCAL_TOKEN;

    const get = (url) => new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${PORT}${url}${url.includes('?') ? '&' : '?'}t=${TOKEN}`, (res) => {
            let body = '';
            res.on('data', (c) => { body += c; });
            res.on('end', () => {
                try { resolve(JSON.parse(body)); }
                catch { reject(new Error(`非 JSON(${res.statusCode}): ${body.slice(0, 200)}`)); }
            });
        }).on('error', reject);
    });
    const open = (p, noCache) =>
        get(`/openFolder?path=${encodeURIComponent(p)}&mode=cover${noCache ? '&noCache=true' : ''}`);
    const disks = () => get('/getDisks');
    const history = (pageNo, pageSize) => get(`/getHistory?pageNo=${pageNo}&pageSize=${pageSize}`);

    const out = { variant };

    // 等就绪（app.listen 是异步的）
    for (let i = 0; i < 200; i++) {
        try { await disks(); out.ready = true; break; } catch { await sleep(100); }
    }
    if (!out.ready) throw new Error(`${variant} 的服务没起来`);

    const serialOf = {};
    for (const d of (await disks()).disks) if (d.drive) serialOf[d.drive.toUpperCase()] = d.serial;
    const drive = (/^([A-Za-z]):/.exec(root) || [])[1].toUpperCase();
    const SERIAL = serialOf[drive];

    // 盘内相对路径（缓存键用的那个）
    const relOf = (p) => p.slice(2).replace(/^[/\\]+/, '').replace(/\\/g, '/');
    // 相对夹具根的名字（'' = 根），断言用它 —— 与探针目录的绝对路径无关，换台机器也能复算
    const rel2root = (p) => p.slice(root.length).replace(/^[/\\]+/, '').replace(/\\/g, '/');

    // ===== 阶段 1：模拟"用户已经看过根目录和 A"（这两条缓存由浏览动作写下）
    await open(root, false);
    await open(`${root}/A`, false);

    // ===== 阶段 2：已缓存集合（= 前端 fetchScanContext 的做法：(serial, relPath)，小写比较）
    const keys = new Set();
    for (const r of (await history(1, 500)).records) keys.add(`${r.serial}|${r.relPath}`.toLowerCase());
    out.已缓存 = [...keys].map((k) => rel2root(`${drive}:/${k.split('|')[1]}`)).sort();

    // ===== 阶段 3：复刻前端的扫描循环（**只是驱动，不是被测代码** —— 被测的是服务端产物）
    const keyOf = (p) => (SERIAL ? `${SERIAL}|${relOf(p)}`.toLowerCase() : null);
    async function walk(rescan) {
        const queue = [root];
        const visited = [];
        let scanned = 0;
        while (queue.length) {
            const dir = queue.shift();
            const items = await open(dir, rescan);
            const k = keyOf(dir);
            if (rescan || k === null || !keys.has(k)) scanned++;
            visited.push(rel2root(dir));
            for (const item of items) {
                // = 前端的 fullPathOf：目录名要带 ext 才是盘上的真名（目录名里可以有".")
                // `item.dir` 已经是服务端补过盘符的完整路径，直接拼即可
                if (item.type === 'folder') queue.push(`${item.dir}/${item.name}${item.ext ? '.' + item.ext : ''}`);
            }
        }
        return { visited: visited.sort(), scanned };
    }

    const w1 = await walk(false);
    out.walk1 = w1;

    // ===== 阶段 4：「补全」不重读已缓存目录，「重扫」才重读
    fs.writeFileSync(path.join(root, 'A', 'late.txt'), 'late');
    const idsBefore = liveIds(dataDir, SERIAL, relOf(`${root}/A`));
    const w2 = await walk(false);
    // 记录 id 没变 = 这一层连**写**都没发生过（比"内容里没有 late"更硬）
    out.补全前后_A的记录id未变 = JSON.stringify(idsBefore) === JSON.stringify(liveIds(dataDir, SERIAL, relOf(`${root}/A`)));
    out.补全后_A条目 = (await open(`${root}/A`, false)).map((i) => i.name).sort();

    const w3 = await walk(true);
    out.重扫后_A条目 = (await open(`${root}/A`, false)).map((i) => i.name).sort();
    out.walk2_scanned = w2.scanned;
    out.walk3_scanned = w3.scanned;

    // ===== 阶段 5：同主键并发写入（P1 把它从"偶发"变成"必然"）
    // 全部带 noCache=true：拿掉"findCache 可能刚好没命中"的运气，
    // 让 8 个请求必然全部落到 scanAndCache 上 —— 这正是并发保护要挡的形态
    const B = `${root}/B`;
    const resps = await Promise.all(Array.from({ length: 8 }, () => open(B, true)));
    out.并发请求数 = resps.length;
    out.并发响应条目数 = resps.map((r) => r.length);
    await sleep(300);   // 给持久化留落地窗口（P0 的教训：对照组要给同样的窗口）
    out.并发后_B的活记录数 = liveIds(dataDir, SERIAL, relOf(B)).length;

    // ===== 阶段 6：`/getHistory` 分页取全（前端 fetchScanContext 依赖的分页契约）
    // 为什么要单独验：这一步行只错一点（比如只取了第一页），后果是"已缓存的目录被当成没缓存"
    // → 整棵树被重扫一遍 —— 正是用户最怕的"撞移动硬盘"。而它在小库上永远看不出来。
    // 所以先造出 >1 页的记录（205 个目录），再走**和前端逐字相同**的取全循环。
    const WIDE = 205;
    const wideName = (i) => `d${String(i).padStart(3, '0')}`;
    for (let i = 0; i < WIDE; i++) write(path.join(root, 'wide', wideName(i), 'x.txt'), '');
    for (let i = 0; i < WIDE; i++) await open(`${root}/wide/${wideName(i)}`, false);

    const PAGE = 200;
    const all = new Set();
    let pages = 0;
    let total = 0;
    for (let pageNo = 1; ; pageNo++) {
        const res = await history(pageNo, PAGE);
        pages++;
        total = Number(res.total) || 0;
        for (const r of res.records) all.add(`${r.serial}|${r.relPath}`.toLowerCase());
        if (pageNo * PAGE >= total) break;
        if (pageNo > 100) throw new Error('分页循环没有终止条件，会死循环');
    }
    out.分页 = {
        服务端total: total,
        取到条数: all.size,
        页数: pages,
        wide到齐: Array.from({ length: WIDE }, (_, i) => all.has(`${SERIAL}|${relOf(`${root}/wide/${wideName(i)}`)}`.toLowerCase()))
            .filter(Boolean).length,
    };

    delete out.ready;
    return out;
}

// ===== 开始 =====
fs.mkdirSync(PROBE, { recursive: true });

/**
 * 每个变体一棵**全新的**夹具树。
 * ⚠️ 踩过的坑：第一版两个变体共用一棵树，而阶段 4 会往 A 里写 `late.txt` ——
 * 第二个变体的"阶段 1 播种"就带着 late.txt 了，于是"补全不该看到 late"被判成 FAIL。
 * **夹具是前置状态的一部分**（P0 的"探针可复算性 = 脚本 + 前置状态"同一个教训）。
 */
const roots = {};
const results = {};
for (const variant of ['after', 'before']) {
    const root = path.join(PROBE, `tree-${variant}`);
    roots[variant] = root;
    for (const [rel, content] of Object.entries(FIXTURE)) write(path.join(root, rel), content);
    results[variant] = await scenario(variant, await prepare(variant), root);
}

// ===== 断言 =====
const expectedVisited = ['', 'A', 'A/sub', 'A/sub/deep', 'B'].sort();
// 阶段 6 结束时库里应当有：夹具那 5 个目录 + 205 个 wide 目录
const expectedKeys = 5 + 205;
const checks = [];
const check = (name, ok, detail) => checks.push({ 判据: name, 结果: ok ? 'PASS' : 'FAIL', 实测: detail });

for (const v of ['after', 'before']) {
    const r = results[v];
    check(`${v} · 递归覆盖全部 5 个目录（含已缓存的 A 下面的 sub / deep）`,
        JSON.stringify(r.walk1.visited) === JSON.stringify(expectedVisited), r.walk1.visited);
    check(`${v} · 补全模式"已扫 n" = 3（B / sub / deep 这三个当时没缓存）`,
        r.walk1.scanned === 3, r.walk1.scanned);
    check(`${v} · 补全模式不重读已缓存目录（A 里新加的 late.txt 不该出现）`,
        !r.补全后_A条目.includes('late'), r.补全后_A条目);
    check(`${v} · 补全模式对已缓存目录连"写"都没发生（记录 _id 未变）`,
        r.补全前后_A的记录id未变 === true, r.补全前后_A的记录id未变);
    check(`${v} · 重扫模式确实重读（A 里新加的 late.txt 出现了）`,
        r.重扫后_A条目.includes('late'), r.重扫后_A条目);
    check(`${v} · 重扫模式每层都重扫（已扫 5 / 5）`,
        r.walk3_scanned === 5, r.walk3_scanned);
    check(`${v} · /getHistory 真的走了多页（页数 ≥ 2）`,
        r.分页.页数 >= 2, r.分页.页数);
    check(`${v} · 分页取全把 ${expectedKeys} 个不同主键一个不漏`,
        r.分页.取到条数 === expectedKeys, r.分页);
    check(`${v} · 分页后 205 个新目录一个不漏`,
        r.分页.wide到齐 === 205, r.分页.wide到齐);
}

// 服务端 total 数的是"记录行"，不是"不同主键"。并发修复没做时，同主键会留下多条活记录
// → total 被撑大。所以这条判据是两个变体各验一个方向，它同时也是那个缺陷的第二个指纹
check('after · 库里没有重复记录（服务端 total = 不同主键数）',
    results.after.分页.服务端total === expectedKeys, results.after.分页.服务端total);
check('before · 对照组 total 被重复记录撑大（同一缺陷的第二个指纹）',
    results.before.分页.服务端total > expectedKeys, results.before.分页.服务端total);

check('after · 8 个并发同键请求后，活记录 = 1（并发保护生效）',
    results.after.并发后_B的活记录数 === 1, results.after.并发后_B的活记录数);
check('before · 对照组应 > 1 条（证明判据有区分力，不是空过）',
    results.before.并发后_B的活记录数 > 1, results.before.并发后_B的活记录数);
check('after · 8 个并发请求都真的扫到了 B（各返回 1 个条目）',
    JSON.stringify(results.after.并发响应条目数) === JSON.stringify([1, 1, 1, 1, 1, 1, 1, 1]),
    results.after.并发响应条目数);

const failed = checks.filter((c) => c.结果 === 'FAIL');
console.log(JSON.stringify({ 探针目录: PROBE, 夹具根: roots, 变体结果: results, 判据: checks, 未通过: failed.length }, null, 2));
process.exit(failed.length ? 1 : 0);
