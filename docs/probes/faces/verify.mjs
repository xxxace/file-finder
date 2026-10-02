/**
 * 验证 · 「换封面」的两块新逻辑
 *
 *   node docs/probes/faces/verify.mjs      # 输出写 out-verify.txt
 *
 * 测两件事（都是这次新写/改动的、**最容易写错**的地方）：
 *
 *   ① `collectFaces`（scan.ts）—— 把"选中位置"展开成目标清单（零读盘）。
 *      · 边界：空 picks / 不存在的盘 / 不存在的目录
 *      · 真库：从库里自己挑一个"有脸"的位置 → 选中它 → 必须只出它自己
 *      · 幂等：同一个位置选两次 → 不重复
 *
 *   ② `buildGroups`（apply.ts）—— 命中行 → 写盘分组。
 *      · `cover` 形态必须标 `overwrite:true`（写入前要备份）、且**不搬任何文件**
 *      · ⚠️ **同一层多个目标不能被吞**（原版用 `dir|layerDir` 作键，第二个会静默丢失）
 *      · `file` 形态（建文件夹 + 搬分卷）的既有行为**一个字没变**
 *
 * 手法同 `../folder-size/verify.mjs`：拷库 + 改 USERPROFILE + esbuild 打**真源文件**；
 * electron 用一个只给形状的替身顶掉（被测逻辑不碰它）。
 *
 * ⚠️ **输出脱敏**：真库部分只输出**数字与布尔**，绝不输出 relPath / 目录名 / serial。
 */
import { build } from 'esbuild';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const realDb = path.resolve(process.env.USERPROFILE || process.env.USER || '/', './.file-finder/searchCache.db');
const stubPath = path.join(here, 'electron-stub.mjs');

let pass = 0, fail = 0;
const check = (label, ok) => { ok ? pass++ : fail++; console.log(`  ${ok ? '✅' : '❌'} ${label}`); };

/** 打真源文件的 bundle，并 import 它 */
async function load(entry, tag) {
    const cacheDir = path.join(repo, 'node_modules/.cache');
    await fsp.mkdir(cacheDir, { recursive: true });
    const outfile = path.join(cacheDir, `${tag}-${Date.now()}.mjs`);
    await build({
        entryPoints: [path.join(repo, entry)],
        bundle: true, platform: 'node', format: 'esm', target: 'node22',
        outfile, logLevel: 'silent', packages: 'external',
        alias: { electron: stubPath },
    });
    return import(pathToFileURL(outfile).href);
}

/** 造一行"命中"的 grab 结果 */
const row = (o) => ({
    writeRel: '', query: '', hitSite: null, coverUrl: 'https://example.invalid/x/y.jpg',
    title: null, actresses: [], status: 'ok', message: '', ...o,
});


/** 这个"有脸目录"是不是分类目录（它自己的文档里还有子目录）—— 与 collectFaces 的闸门同口径 */
function isCategoryDir(docs, serial, atDir, name) {
    const selfRel = atDir ? `${atDir}/${name}` : name;
    const self = docs.find(d => d.serial === serial && d.relPath === selfRel);
    return !!(self && (self.data || []).some(c => c.type === 'folder'));
}

async function main() {
    // ══ ② buildGroups（纯函数，不需要库）════════════════════════════════════
    console.log('── ② buildGroups：分组与形态 ──');
    const { buildGroups } = await load('electron/server/assistant/apply.ts', 'ff-faces-apply');

    // 同层两个"没脸目录"目标 —— 原版按 `dir|layerDir` 分组，第二个会被吞掉
    const twoDirs = buildGroups([
        row({ writeRel: 'ACT/TST-001/TST-001.jpg', kind: 'dir', query: 'TST-001' }),
        row({ writeRel: 'ACT/TST-002/TST-002.jpg', kind: 'dir', query: 'TST-002' }),
    ]);
    check(`同层两个 dir 目标 → **2 组**（分组键必须带 writeRel，不能只按层）`, twoDirs.length === 2);
    check('  两组的写入路径各不相同', new Set(twoDirs.map(g => g.coverWriteRel)).size === 2);
    check('  dir 形态 `overwrite:false`（写的是新文件，不需要备份）', twoDirs.every(g => g.overwrite === false));
    check('  dir 形态不搬任何东西（srcRels 空、folderRel 空）', twoDirs.every(g => g.srcRels.length === 0 && g.folderRel === ''));

    // 「换封面」的 cover 形态
    const oneCover = buildGroups([
        row({ writeRel: 'ACT/TST-001/TST-001.jpg', kind: 'cover', query: 'TST-001' }),
    ]);
    check('cover 形态 → `overwrite:true`（apply 会先备份原图）', oneCover.length === 1 && oneCover[0].overwrite === true);
    check('cover 形态写入路径 = 目标自己（原文件被覆盖，名字不变）', oneCover[0].coverWriteRel === 'ACT/TST-001/TST-001.jpg');
    check('cover 形态不搬任何东西', oneCover[0].srcRels.length === 0 && oneCover[0].folderRel === '');

    // cover 与 dir 指向同一路径时不能互吞（键里带 kind 前缀）
    const mixed = buildGroups([
        row({ writeRel: 'ACT/TST-001/TST-001.jpg', kind: 'cover', query: 'TST-001' }),
        row({ writeRel: 'ACT/TST-001/TST-001.jpg', kind: 'dir', query: 'TST-001' }),
    ]);
    check('同一路径的 cover 与 dir 是两个不同的组（不会互吞）', mixed.length === 2);

    // 未命中 / 没 URL 的行不进分组
    check('未命中的行不参与分组',
        buildGroups([row({ status: 'no-match', coverUrl: null, kind: 'cover' })]).length === 0);

    // ⭐ 回归：file 形态的既有行为一个字没变
    const vol = buildGroups([
        row({ writeRel: 'L/TST-003-a.jpg', kind: 'file', query: 'TST-003', srcRel: 'L/TST-003-a.mp4' }),
        row({ writeRel: 'L/TST-003-b.jpg', kind: 'file', query: 'TST-003', srcRel: 'L/TST-003-b.mp4' }),
    ]);
    check('回归·file 形态：同层同番号的分卷收拢成 1 组、2 个源文件',
        vol.length === 1 && vol[0].srcRels.length === 2);
    check('回归·file 形态：封面 = `<层>/<番号>/<番号>.jpg`、会搬（folderRel 非空）',
        vol[0].coverWriteRel === 'L/TST-003/TST-003.jpg' && vol[0].folderRel === 'L/TST-003');
    check('回归·file 形态 `overwrite:false`', vol[0].overwrite === false);

    // ══ ① collectFaces（要真库）════════════════════════════════════════════
    console.log('\n── ① collectFaces：从缓存展开（真库，只输出数字/布尔）──');
    const sandbox = await fsp.mkdtemp(path.join(os.tmpdir(), 'ff-probe-faces-'));
    const sandboxBase = path.join(sandbox, '.file-finder');
    await fsp.mkdir(sandboxBase, { recursive: true });
    const dbPath = path.join(sandboxBase, 'searchCache.db');
    await fsp.copyFile(realDb, dbPath);
    process.env.USERPROFILE = sandbox;
    process.env.USER = sandbox;

    const { collectFaces } = await load('electron/server/assistant/scan.ts', 'ff-faces-scan');
    const { readExternalCache } = await load('electron/server/nedb.ts', 'ff-faces-nedb');
    const { parseTitle } = await load('electron/server/assistant/match.ts', 'ff-faces-match');

    check('空 picks → 空目标（不发无谓的缓存查询）', (await collectFaces('ANY', [])).length === 0);
    check('不存在的盘 → 空目标', (await collectFaces('NOPE0000', [{ dir: '', name: 'zzz', kind: 'item' }])).length === 0);

    // 从库里自己挑一个"有脸"的位置（不写死任何真实名字）
    const docs = (await readExternalCache(dbPath)).filter(d => d.mode === 'cover');
    let pick = null, isImage = false;
    for (const d of docs) {
        if (!d.relPath) continue;                       // 跳过盘根，便于后面构造"父目录"
        for (const e of d.data || []) {
            if (e.type === 'image') { pick = { dir: e.dir || d.relPath, name: e.name, ext: e.ext, kind: 'item' }; isImage = true; break; }
            if (e.type === 'folder' && e.avatar) { pick = { dir: e.dir || d.relPath, name: e.name, ext: e.ext, kind: 'item' }; isImage = false; break; }
        }
        if (pick) { pick.__serial = d.serial; break; }
    }

    if (!pick) {
        console.log('  ℹ️ 真库里没找到"有脸"的条目 —— 这几条断言**未覆盖**（不算通过也不算失败）');
    } else {
        const serial = pick.__serial;
        const targeted = await collectFaces(serial, [{ dir: pick.dir, name: pick.name, ext: pick.ext, kind: 'item' }]);
        check('选中一个具体条目 → 恰好展开出 1 条目标', targeted.length === 1);
        check(`  目标形态与来源一致（image → cover / folder+avatar → dir）：${isImage ? 'cover' : 'dir'}`,
            targeted.length === 1 && targeted[0].kind === (isImage ? 'cover' : 'dir'));

        const rel = targeted[0]?.writeRel ?? '';
        check('  cover 的写入路径 = 那一层 + 封面文件名（覆盖原文件）',
            !isImage || rel === (pick.dir ? `${pick.dir}/${pick.ext ? `${pick.name}.${pick.ext}` : pick.name}` : (pick.ext ? `${pick.name}.${pick.ext}` : pick.name)));
        check('  dir 的写入路径 = 目录 + `<目录名>.jpg`（新建，与补封面同规则）',
            isImage || rel.endsWith(`/${pick.ext ? `${pick.name}.${pick.ext}` : pick.name}/${pick.name}.jpg`));

        // ⭐ 查询词（用户真机实测的那个坑）：封面卡的 `name` 是**封面图文件名**，
        // 可能是 `cover`/`1` 这类 —— 拿它解析番号必然失败，抓取端会静默跳过。
        // `collectFaces` 必须先把"该搜什么"算好（用目录名兜底）。
        check('条目名能解析出番号时，query 必须与它一致',
            targeted.every(t => {
                const byName = parseTitle(t.name).id;
                return !byName || t.query === byName;
            }));
        // 至少有一条目标带上了 query（否则说明这批目标在抓取端会被全部跳过）
        const withQuery = targeted.filter(t => t.query).length;
        console.log(`  ℹ️ 带 query 的目标：${withQuery} / ${targeted.length}`);
        check('至少有一条目标带得上可搜的查询词（否则点了等于没点）', withQuery >= 1);

        // 幂等：同一个位置选两次不该出两条
        const twice = await collectFaces(serial, [
            { dir: pick.dir, name: pick.name, ext: pick.ext, kind: 'item' },
            { dir: pick.dir, name: pick.name, ext: pick.ext, kind: 'item' },
        ]);
        check('同一位置重复选中 → 只有 1 条（去重生效）', twice.length === 1);

        // ⭐ 路径口径回归：主界面下发的是**完整路径**（`toWire` 补了盘符），必须也匹配得上
        const withDrive = await collectFaces(serial, [
            { dir: `Z:/${pick.dir}`, name: pick.name, ext: pick.ext, kind: 'item' },
        ]);
        check('完整路径 `Z:/…` 与盘内相对路径得到**同一条**目标',
            withDrive.length === targeted.length && withDrive[0]?.writeRel === targeted[0]?.writeRel);

        // ⭐ 离线只读锚点形态：`#<serial>/<rel>`
        const withAnchor = await collectFaces(serial, [
            { dir: `#${serial}/${pick.dir}`, name: pick.name, ext: pick.ext, kind: 'item' },
        ]);
        check('只读锚点 `#<serial>/…` 也能匹配', withAnchor.length === targeted.length
            && withAnchor[0]?.writeRel === targeted[0]?.writeRel);

        // ⭐ 反斜杠路径：`toFullPath` 现在一定给 `/`，但别的调用点未必；
        // 分隔符不归一会让整条匹配静默失效，所以这里钉住它
        const withBackslash = await collectFaces(serial, [
            { dir: `Z:\\${pick.dir.replace(/\//g, '\\')}`, name: pick.name, ext: pick.ext, kind: 'item' },
        ]);
        check('反斜杠完整路径 `Z:\\…` 也能匹配（分隔符归一）',
            withBackslash.length === targeted.length && withBackslash[0]?.writeRel === targeted[0]?.writeRel);

        // ⭐ 边界：盘根完整路径是 `H:`（**不带斜杠**，见 driveIdentity 的 toFullPath）、
        // 以及空 dir —— 都不能抛，只返回空
        check('盘根形态 `Z:`（无斜杠）→ 空且不抛',
            (await collectFaces(serial, [{ dir: 'Z:', name: 'no-such-thing', kind: 'item' }])).length === 0);
        check('空 dir → 空且不抛',
            (await collectFaces(serial, [{ dir: '', name: 'no-such-thing', kind: 'item' }])).length === 0);

        // 展开父目录：必须**是超集**（至少包含上面那一条）
        const parent = pick.dir.includes('/') ? pick.dir.slice(0, pick.dir.lastIndexOf('/')) : '';
        const dirName = pick.dir.includes('/') ? pick.dir.slice(pick.dir.lastIndexOf('/') + 1) : pick.dir;
        if (dirName) {
            const expanded = await collectFaces(serial, [
                { dir: parent, name: dirName, kind: 'dir' },
            ]);
            check(`选父目录 → 展开成 ${expanded.length} 条（≥1），且**包含**刚才那条`,
                expanded.length >= 1 && expanded.some(t => t.writeRel === targeted[0].writeRel));
            check('  展开结果里没有重复的写入路径', new Set(expanded.map(t => t.writeRel)).size === expanded.length);
        } else {
            console.log('  ℹ️ 选中的条目在盘根那一层，跳过"展开父目录"这一段');
        }
    }

    // ══ ③ ⭐ 全库穷举：库里**每一条**"有脸"条目都按"前端会传的形态"喂一遍 ══════════
    // 这一段专为"真机弹窗一条都没有"而加：前面的断言都是**单条**（挑第一条试），
    // 而真机现象是"挑了几个、一个都没匹配上"。**只有全量跑一遍才找得出反例形态。**
    console.log('\n── ③ 全库穷举：每一条"有脸"条目都按前端形态喂一遍 ──');
    {
        const bySerial = new Map();
        for (const d of docs) {
            for (const e of d.data || []) {
                const isImage = e.type === 'image';
                const isFaceDir = e.type === 'folder' && !!e.avatar;
                if (!isImage && !isFaceDir) continue;
                // ⚠️ 分类目录要**排除在分母之外**：`collectFaces` 的闸门会有意挡掉它们
                //（给分类目录写 `<目录名>.jpg` 永远不会生效），那不是匹配失败。
                if (isFaceDir && isCategoryDir(docs, d.serial, e.dir || d.relPath, e.name)) continue;
                if (!bySerial.has(d.serial)) bySerial.set(d.serial, []);
                // ⚠️ 逐字模拟主界面下发的 item：
                //   · `dir` 是**完整路径**（`toWire` 的 `toFullPath` 给 `H:/x`；盘根是 `H:`）
                //   · `name` / `ext` 原样（下发只走白名单、不加工）
                //   · `kind` 由 `type` 推（前端就是这么判的）
                bySerial.get(d.serial).push({
                    dir: `Z:/${e.dir || d.relPath}`,
                    name: e.name,
                    ext: e.ext,
                    kind: 'item',
                });
            }
        }

        let totalPicks = 0, totalGot = 0, serials = 0;
        for (const [serial, picks] of bySerial) {
            serials += 1;
            totalPicks += picks.length;
            const got = await collectFaces(serial, picks);
            totalGot += got.length;
            if (got.length !== picks.length) {
                // ⚠️ 只报数量差，**不做逐条对照** —— `kind:'dir'`（有脸目录）的 writeRel 是
                // `<目录>/<目录名>.jpg`，比选中位置多一层，拿它对 selfRel 逐条比会全线误报
                // （这正是这版探针第一稿的错）。数量一致就够了。
                console.log(`  ⚠️ 某块盘：传 ${picks.length} 条、只命中 ${got.length} 条`);
            }
        }
        check(`全库 ${serials} 块盘 / ${totalPicks} 条"有脸"条目，**全部**按前端形态命中（实得 ${totalGot}）`,
            totalGot === totalPicks);
    }

    // ══ ④ ⭐ 全库穷举（另一种形态）：按「选中目录格子」传（`kind:'dir'`）══════════════
    // 这是用户最可能的用法（"按演员 / 按文件夹"就是选目录），而它走的是**另一条匹配分支**
    //（scopes 展开，不是 singles 精确匹配）—— ③ 只覆盖了 `kind:'item'`，等于漏测一半。
    console.log('\n── ④ 全库穷举（`kind:\'dir\'`，选目录格子）──');
    {
        const bySerial = new Map();
        for (const d of docs) {
            for (const e of d.data || []) {
                const isImage = e.type === 'image';
                const isFaceDir = e.type === 'folder' && !!e.avatar;
                if (!isImage && !isFaceDir) continue;
                // `kind:'dir'` 只在"选中目录格子"时出现 ⇒ 条目必须是目录（folder+avatar）
                if (!isFaceDir) continue;
                if (!bySerial.has(d.serial)) bySerial.set(d.serial, []);
                bySerial.get(d.serial).push({ dir: `Z:/${e.dir || d.relPath}`, name: e.name, ext: e.ext, kind: 'dir' });
            }
        }

        let totalPicks = 0, totalGot = 0, serials = 0;
        for (const [serial, picks] of bySerial) {
            serials += 1;
            totalPicks += picks.length;
            const got = await collectFaces(serial, picks);
            totalGot += got.length;
            if (!got.length) console.log(`  ⚠️ 某块盘：传 ${picks.length} 个目录 → **一条都没展开出来**`);
        }
        // 展开应当**至少**每条目录都产出自己（多数情况更多：目录里可能还有别的有脸条目）
        check(`全库 ${serials} 块盘 / ${totalPicks} 个"有脸目录"（kind:'dir'）展开出 ${totalGot} 条目标（≥ ${totalPicks}）`,
            totalGot >= totalPicks && totalGot > 0);
    }

    // ══ ⑤ ⭐ 分类目录闸门：里面还有子目录的**绝不能**进目标清单 ══════════════════
    // 给它写 `<目录名>.jpg` **永远不会生效** —— `handleCover` 第一关"有子目录 → return null"
    // 就挡住了，结果只多一个垃圾文件、界面还报"写入成功"。与 `evaluateDocs` 的
    // `skippedCategory` 是同一道闸，两边的判据必须一致。
    console.log('\n── ⑤ 分类目录闸门 ──');
    {
        const byRel = new Map();
        for (const d of docs) byRel.set(`${d.serial}|${d.relPath}`, d.data || []);

        const dirPicks = [];
        for (const d of docs) {
            for (const e of d.data || []) {
                if (e.type !== 'folder' || !e.avatar) continue;
                dirPicks.push({ serial: d.serial, pick: { dir: `Z:/${e.dir || d.relPath}`, name: e.name, ext: e.ext, kind: 'dir' } });
            }
        }

        let checked = 0, leaked = 0;
        for (const { serial, pick } of dirPicks) {
            const got = await collectFaces(serial, [pick]);
            for (const t of got) {
                if (t.kind !== 'dir') continue;
                checked += 1;
                // 该目录自己的文档里若还有 folder 条目 ⇒ 分类目录 ⇒ 不该出现在目标里。
                // ⚠️ 位置要从 `writeRel`（`<目录>/<目录名>.jpg`）反推 —— `t.dir` 是
                // **条目所在层**（对 folder 条目来说是父层），拿它查到的永远是父层自己，
                // 于是"父层里有子目录"恒真 ⇒ 全线误报（这版探针第一稿就是这么错的）。
                const selfRel = t.writeRel.slice(0, t.writeRel.lastIndexOf('/'));
                const child = byRel.get(`${serial}|${selfRel}`);
                if (child && child.some(c => c.type === 'folder')) leaked += 1;
            }
        }
        console.log(`  ℹ️ 检查了 ${checked} 个 dir 形态目标`);
        check(`目标清单里**不含任何分类目录**（泄漏 ${leaked} 个）`, leaked === 0);
    }

    // ══ ⑥ ⭐ 查询词兜底：名字认不出番号时，必须用它**代表的目录名**（不是父层）══════
    // 这是「层错位」那个 bug 的同型残留：`selfRel`/`dir` 都换成 `atDir` 了，`query` 漏了。
    // 而常规断言挑到的那条卡片"名字本身就是番号"，兜底分支**结构上永远测不到**。
    console.log('\n── ⑥ 查询词兜底分支 ──');
    {
        let sample = null;
        for (const d of docs) {
            for (const e of d.data || []) {
                if (e.type !== 'image') continue;
                if (parseTitle(e.name).id) continue;                 // 名字能解析 ⇒ 走不到兜底
                const at = e.dir || d.relPath;
                if (parseTitle(at.split('/').pop() || '').id) { sample = { d, e, at }; break; }
            }
            if (sample) break;
        }
        if (!sample) {
            console.log('  ℹ️ 真库里没有"名字认不出、目录名能认出"的封面卡 ⇒ **这条分支未被真实数据覆盖**');
            console.log('     （判据本身已按 `atDir` 实现，但没有真实样本能证明它）');
        } else {
            const r = await collectFaces(sample.d.serial, [
                { dir: `Z:/${sample.at}`, name: sample.e.name, ext: sample.e.ext, kind: 'item' },
            ]);
            check('名字认不出番号时，query 由**它代表的目录名**兜底（不是父层演员名）',
                r.length === 1 && !!r[0].query);
        }
    }

    await fsp.rm(sandbox, { recursive: true, force: true }).catch(() => undefined);
    console.log(`\n${fail === 0 ? '✅' : '❌'} 通过 ${pass} / 失败 ${fail}`);
    if (fail) process.exitCode = 1;
}
main().catch(e => {
    console.error('PROBE FAILED:', e && e.message ? e.message : e);
    process.exit(1);
});
