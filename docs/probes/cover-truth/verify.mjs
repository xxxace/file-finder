/**
 * 验证 · 补封面的「真话」与「不动盘」（2026-11-10）
 *
 *   node docs/probes/cover-truth/verify.mjs > out.txt
 *
 * 测三件事（都是这次改动最容易写错、也是最要命的地方）：
 *  ① `isUsableCoverUrl` / `getVerifiedCover`：空链接、blob/data、相对地址一律不算封面
 *  ② `buildGroups`：形态不对的 URL 不许进写盘分组（尤其 file 形态 —— 它会新建文件夹+搬视频）
 *  ③ `runApply` 在封面下载失败时**盘上零改动**：不 mkdir、不 rename、不写封面
 *
 * 手法：esbuild 打**真源文件**，electron / 盘根 / 缓存 / 收藏夹用替身顶掉；
 * `net.request` 故意抛错模拟"读回空内容 / 下载失败"。盘根指向临时目录，
 * 就算被测逻辑写错也不会碰到真实盘。结论只输出数字与布尔，不涉及任何真实路径。
 */
import { build } from 'esbuild';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const stubPath = path.join(here, 'stubs.mjs');

let pass = 0, fail = 0;
const check = (label, ok) => { ok ? pass++ : fail++; console.log(`  ${ok ? '✅' : '❌'} ${label}`); };

const STUBBED = new Set([
    'electron', '../../utils/driveIdentity', '../nedb', '../playlistStore', './hits',
]);
/**
 * esbuild 的 `alias` 不接受相对路径 ⇒ 用 onResolve 精确匹配导入串。
 * 其余一律返回 null 交回默认解析（node: 内建、node_modules 包都不动）。
 */
const stubPlugin = {
    name: 'cover-truth-stubs',
    setup(b) {
        b.onResolve({ filter: /.*/ }, args => (STUBBED.has(args.path) ? { path: stubPath } : null));
    },
};

async function load(entry, tag) {
    const cacheDir = path.join(repo, 'node_modules/.cache');
    await fsp.mkdir(cacheDir, { recursive: true });
    const outfile = path.join(cacheDir, `${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.mjs`);
    await build({
        entryPoints: [path.join(repo, entry)],
        bundle: true, platform: 'node', format: 'esm', target: 'node22',
        outfile, logLevel: 'silent', packages: 'external', plugins: [stubPlugin],
    });
    return import(pathToFileURL(outfile).href);
}

const row = (o = {}) => ({
    // file 形态的 writeRel 是**层里的占位封面名**，不是最终路径；
    // buildGroups 会自己拼成 `<层>/<番号>/<番号>.jpg`（与 docs/probes/faces/verify.mjs 同口径）
    writeRel: 'L/A.jpg', query: 'A', hitSite: 'site', coverUrl: 'https://example.invalid/cover.jpg',
    title: null, actresses: [], status: 'ok', message: '', kind: 'file', srcRel: 'L/a.mp4', ...o,
});

/** 递归列出临时盘根里的条目数（只数个数，不打印路径） */
async function countEntries(dir) {
    let n = 0;
    for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
        n += 1;
        if (e.isDirectory()) n += await countEntries(path.join(dir, e.name));
    }
    return n;
}

async function main() {
    const sandbox = await fsp.mkdtemp(path.join(os.tmpdir(), 'ff-probe-cover-truth-'));
    const diskRoot = path.join(sandbox, 'disk');
    const dataDir = path.join(sandbox, 'data');
    await fsp.mkdir(diskRoot, { recursive: true });
    await fsp.mkdir(dataDir, { recursive: true });
    process.env.FF_PROBE_ROOT = diskRoot;

    // ── ① URL 形态判据 ────────────────────────────────────────────────
    console.log('── ① 什么才算一条封面链接 ──');
    const { isUsableCoverUrl, getVerifiedCover } = await load('electron/server/assistant/coverImage.ts', 'ff-cover-image');
    const bad = ['', '   ', undefined, null, 'null', 'undefined', 'about:blank', 'javascript:void(0)',
        'blob:https://x/y', 'data:image/png;base64,AAA', '/pics/cover/a.jpg', 'https://', 'a b c'];
    check(`${bad.length} 种空/错链接全部被拒`, bad.every(u => !isUsableCoverUrl(u)));
    check('http/https 绝对地址放行',
        isUsableCoverUrl('https://pics.example/a.jpg') && isUsableCoverUrl('http://x/y.webp?t=1'));

    const emptyCheck = await getVerifiedCover('', AbortSignal.timeout(2000));
    check('getVerifiedCover 对空链接：ok=false / jpg=null / urlBad=true',
        emptyCheck.ok === false && emptyCheck.jpg === null && emptyCheck.urlBad === true);

    // ── ② 写盘分组 ───────────────────────────────────────────────────
    console.log('\n── ② buildGroups：坏链接不许进分组 ──');
    const { buildGroups, runApply } = await load('electron/server/assistant/apply.ts', 'ff-cover-apply');
    const { createJob } = await load('electron/server/assistant/jobs.ts', 'ff-cover-jobs');
    const badRows = [
        row({ coverUrl: '' }), row({ coverUrl: 'blob:https://x/y' }),
        row({ coverUrl: 'data:image/png;base64,AAA' }), row({ coverUrl: '/pics/a.jpg' }),
    ];
    check('file 形态 + 4 种坏链接 → 0 组（不会新建文件夹、不会搬视频）',
        buildGroups(badRows).length === 0);
    check('正常的 ok 行仍能成组（对照组，防止改坏）', buildGroups([row()]).length === 1);

    // ── ③ 下载失败时盘上零改动（真跑 runApply）─────────────────────────
    console.log('\n── ③ 封面下载失败 ⇒ 盘上零改动 ──');
    const before = await countEntries(diskRoot);
    const job = createJob('apply', 1);
    await runApply('PROBE', [row()], job, dataDir);
    const after = await countEntries(diskRoot);
    check(`盘根条目数没变（before=${before} / after=${after}）`, before === after);
    check('结果行是 ok:false（记失败，不谎报写入）', job.rows.length === 1 && job.rows[0].ok === false);
    check('结果行说清了失败原因', /封面没写成/.test(job.rows[0].message || ''));
    check('任务正常收尾（不是 error / 挂死）', job.status === 'done');

    // 空链接连分组都进不去，更不该动盘
    const job2 = createJob('apply', 1);
    await runApply('PROBE', [row({ coverUrl: '' })], job2, dataDir);
    check('空链接那批：0 组、0 行、盘根仍不变',
        job2.rows.length === 0 && (await countEntries(diskRoot)) === before);

    // ── ④ 对照组：真拿到封面 ⇒ 封面先落盘、视频才搬进去 ──────────────
    // 这条专防"为了修失败把成功路径也改坏"。
    console.log('\n── ④ 对照组：真封面 ⇒ 封面 + 搬迁都完成 ──');
    await fsp.mkdir(path.join(diskRoot, 'L'), { recursive: true });
    await fsp.writeFile(path.join(diskRoot, 'L', 'a.mp4'), 'video');
    process.env.FF_PROBE_NET = 'ok';
    const job3 = createJob('apply', 1);
    await runApply('PROBE', [row()], job3, dataDir);
    const coverPath = path.join(diskRoot, 'L', 'A', 'A.jpg');
    const movedPath = path.join(diskRoot, 'L', 'A', 'A.mp4');
    const has = async (p) => fsp.stat(p).then(() => true).catch(() => false);
    check('结果行 ok=true，任务 done', job3.rows.length === 1 && job3.rows[0].ok === true && job3.status === 'done');
    check('封面文件真的写出来了', await has(coverPath));
    check('视频被搬进番号文件夹且主名转大写', await has(movedPath) && !(await has(path.join(diskRoot, 'L', 'a.mp4'))));
    check('没有残留的 .tmp 半截文件',
        (await fsp.readdir(path.join(diskRoot, 'L', 'A'))).every(n => !n.endsWith('.tmp')));
    delete process.env.FF_PROBE_NET;

    // ── ⑤ 卡片标题：名字本身，不带尾部斜杠 ────────────────────────────
    console.log('\n── ⑤ 卡片标题不该带 / ──');
    const { buildCoverItems } = await load('src/views/FileFinder/assistant/coverModel.ts', 'ff-cover-model');
    const opts = { live: false, selected: new Set() };
    const dirCard = buildCoverItems(
        [{ kind: 'dir', dir: 'L', name: 'FC2-PPV-1001424', writeRel: 'L/FC2-PPV-1001424.jpg' }],
        [], [], opts,
    )[0];
    const fileCard = buildCoverItems(
        [{ kind: 'file', dir: 'L', name: 'a.mp4', writeRel: 'L/A.jpg', query: 'FC2-PPV-1001424' }],
        [], [], opts,
    )[0];
    check('dir 形态标题 = 文件夹名（无尾斜杠）', dirCard.title === 'FC2-PPV-1001424');
    check('file 形态标题 = 番号（无尾斜杠）', fileCard.title === 'FC2-PPV-1001424');
    check('形态仍由 kindText 表达，没有丢信息', dirCard.kindText === '新建' && fileCard.kindText === '裸文件');

    await fsp.rm(sandbox, { recursive: true, force: true }).catch(() => undefined);
    console.log(`\n${fail === 0 ? '✅' : '❌'} 通过 ${pass} / 失败 ${fail}`);
    if (fail) process.exitCode = 1;
}

main().catch(e => {
    console.error('PROBE FAILED:', e && e.message ? e.message : e);
    process.exit(1);
});
