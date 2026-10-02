/**
 * 实测 · 「封面糊脸」在真库里的规模，以及**零读盘判据**到底能不能立住。
 *
 *   node docs/probes/cover-blur/scan.mjs      # 输出写 out-scan.txt
 *
 * 要回答的问题（方案的前提，不实测就不许下结论）：
 *   ① 缓存库里的封面卡，到底有几分之几带着 `thumbData`（判据的可用分母有多大）；
 *   ② 这些缩略图的**像素宽度**分布长什么样 —— 有没有一批明显偏小的（= 糊脸）；
 *   ③ 判据本身成不成立：`scaleToThumb` 只在 `原图宽 > 480` 时缩，
 *      所以 **缩略图宽 == min(原图宽, 480)** 是恒等式 —— 缩略图宽 < 480
 *      ⟺ 原图宽 < 480。这一段只是把这个恒等式**用真数据跑一遍**看有没有反例。
 *
 * 手法同 `../folder-size/verify.mjs`（拷库 + 改 USERPROFILE + esbuild 打真源文件）。
 *
 * ⚠️ **输出脱敏**：只输出数字与分桶，绝不输出 relPath / 目录名 / serial / 任何站点信息。
 */
import { build } from 'esbuild';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const realDb = path.resolve(process.env.USERPROFILE || process.env.USER || '/', './.file-finder/searchCache.db');

/** 缩略图上限（与 `electron/utils/thumbnail.ts` 的 THUMB_WIDTH 必须一致） */
const THUMB_WIDTH = 480;

/**
 * data URI → JPEG 宽高。**只解前 16KB base64**，不解码整张图 —— 判据要能进
 * scan 的热路径（零读盘、微秒级），不能真去解码 1247 张图。
 */
function dataUriSize(uri) {
    const comma = uri.indexOf(',');
    if (comma === -1) return null;
    const head = uri.slice(0, comma);
    if (!/;base64/.test(head)) return null;
    const buf = Buffer.from(uri.slice(comma + 1, comma + 1 + 16384), 'base64');
    return jpegSize(buf);
}

/** 扫 JPEG 标记段找 SOF（baseline C0 / progressive C2 …），拿宽高。找不到返回 null */
function jpegSize(buf) {
    if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
    let i = 2;
    while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) { i++; continue; }          // 填充字节
        const m = buf[i + 1];
        if (m === 0xff || m === 0x01 || (m >= 0xd0 && m <= 0xd9)) { i += 2; continue; }
        const len = buf.readUInt16BE(i + 2);
        if (len < 2) return null;
        // SOF0..SOF15，排除 DHT(C4) / JPG(C8) / DAC(CC)
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
            return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
        }
        i += 2 + len;
    }
    return null;
}

async function main() {
    const sandbox = await fsp.mkdtemp(path.join(os.tmpdir(), 'ff-probe-blur-'));
    const sandboxBase = path.join(sandbox, '.file-finder');
    await fsp.mkdir(sandboxBase, { recursive: true });
    const dbPath = path.join(sandboxBase, 'searchCache.db');
    await fsp.copyFile(realDb, dbPath);
    process.env.USERPROFILE = sandbox;
    process.env.USER = sandbox;

    const cacheDir = path.join(repo, 'node_modules/.cache');
    await fsp.mkdir(cacheDir, { recursive: true });
    const outfile = path.join(cacheDir, `ff-probe-blur-${Date.now()}.mjs`);
    await build({
        entryPoints: [path.join(repo, 'electron/server/nedb.ts')],
        bundle: true, platform: 'node', format: 'esm', target: 'node22',
        outfile, logLevel: 'silent', packages: 'external',
    });
    const mod = await import(pathToFileURL(outfile).href);
    const docs = await mod.readExternalCache(dbPath);

    // ══ ① 分母：封面库里"有脸"的条目一共有多少 ══════════════════════════════
    console.log('── ① 分母（缓存库里"已有脸"的条目）──');
    let coverDocs = 0;
    let imgItems = 0, imgWithThumb = 0, folderItems = 0, folderWithFace = 0, folderWithThumb = 0;
    /** 判据输入：{ w, h, src: 'card' | 'avatar' } */
    const sizes = [];

    for (const d of docs) {
        if (d.mode !== 'cover') continue;
        coverDocs++;
        for (const it of (d.data || [])) {
            if (it.type === 'image') {
                imgItems++;
                if (it.thumbData) {
                    imgWithThumb++;
                    const s = dataUriSize(it.thumbData);
                    if (s) sizes.push({ ...s, src: 'card' });
                }
            } else if (it.type === 'folder') {
                folderItems++;
                if (it.avatar) {
                    folderWithFace++;
                    if (it.avatarThumbData) {
                        folderWithThumb++;
                        const s = dataUriSize(it.avatarThumbData);
                        if (s) sizes.push({ ...s, src: 'avatar' });
                    }
                }
            }
        }
    }
    console.log(`  cover 文档 ${coverDocs} 条`);
    console.log(`  封面卡(type:image) ${imgItems} 个 · 带 thumbData 的 ${imgWithThumb} 个（${pct(imgWithThumb, imgItems)}）`);
    console.log(`  子目录(type:folder) ${folderItems} 个 · 有脸(avatar) ${folderWithFace} 个 · 其中带 avatarThumbData ${folderWithThumb} 个`);
    console.log(`  ⇒ 可判定的缩略图样本 ${sizes.length} 张`);

    // ══ ② 宽度分布（分来源 + 细档）═══════════════════════════════════════════
    console.log('\n── ② 缩略图像素宽度分布（缩略图宽 == min(原图宽, 480)）──');
    const buckets = [[0, 100], [100, 150], [150, 200], [200, 300], [300, 400], [400, THUMB_WIDTH], [THUMB_WIDTH, THUMB_WIDTH + 1], [THUMB_WIDTH + 1, 1e9]];
    const label = ([lo, hi]) =>
        hi === THUMB_WIDTH + 1 ? `== ${THUMB_WIDTH}`
            : hi > 1e8 ? `> ${THUMB_WIDTH}`
                : lo === 0 ? `< 100`
                    : `${lo}–${hi - 1}`;
    for (const b of buckets) {
        const n = sizes.filter(s => s.w >= b[0] && s.w < b[1]).length;
        console.log(`  宽 ${label(b).padEnd(10)} ${String(n).padStart(5)} 张  ${pct(n, sizes.length)}`);
    }
    const small = sizes.filter(s => s.w < THUMB_WIDTH);
    console.log(`\n  ⇒ 宽度 < ${THUMB_WIDTH}（= 原图窄于 ${THUMB_WIDTH}）共 ${small.length} 张 / ${sizes.length}`);

    // 分来源：封面卡（站点图/自带图） vs 目录脸（avatar/cover）—— 两类可能根本不是同一种东西
    console.log('\n── ②b 分来源（card = 封面卡 · avatar = 目录脸）──');
    for (const src of ['card', 'avatar']) {
        const g = sizes.filter(s => s.src === src);
        const sm = g.filter(s => s.w < THUMB_WIDTH);
        console.log(`  ${src.padEnd(7)} 样本 ${String(g.length).padStart(5)} · 宽度 < ${THUMB_WIDTH} 的 ${String(sm.length).padStart(4)}（${pct(sm.length, g.length)}）`);
    }

    // 小图最集中的尺寸档 —— 看"是不是某个固定尺寸"（固定尺寸 = 某个来源的缩略图）
    const byWH = new Map();
    for (const s of small) {
        const k = `${s.w}×${s.h}`;
        byWH.set(k, (byWH.get(k) || 0) + 1);
    }
    const top = [...byWH.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    console.log('\n  小图最集中的**具体尺寸**（尺寸 × 张数）：' + top.map(([k, n]) => `${k}×${n}`).join(' · '));
    const top1 = top[0];
    if (top1) {
        const [w, h] = top1[0].split('×').map(Number);
        const same = small.filter(s => s.w === w && s.h === h).length;
        const which = ['card', 'avatar'].map(src => {
            const g = sizes.filter(s => s.src === src && s.w === w && s.h === h).length;
            return `${src} ${g}`;
        }).join(' · ');
        console.log(`  其中 ${top1[0]} 占 ${same} 张（来源分布：${which}）`);
    }

    // ══ ②c 目录脸的糊脸里，有多少是「分类目录」（本来就不该补封面）═══════════
    // 决定方案范围：`scan.ts` 既有决策是"分类目录跳过"（里面还有子目录的目录不是一部
    // 作品，给它塞封面会把"分类"画成"作品"）。若糊的目录脸绝大多数是分类目录，
    // 它们**不该被处理**；只有"一部片一个目录"的那种才是真目标。
    console.log('\n── ②c 目录脸糊脸 → 分类目录 vs 单片目录 ──');
    const byRel = new Map();
    for (const d of docs) if (d.mode === 'cover') byRel.set(`${d.serial}|${d.relPath}`, d.data || []);

    let faceSmall = 0, faceCategory = 0, faceSingle = 0, faceNoDoc = 0;
    for (const d of docs) {
        if (d.mode !== 'cover') continue;
        for (const it of (d.data || [])) {
            if (it.type !== 'folder' || !it.avatar || !it.avatarThumbData) continue;
            const s = dataUriSize(it.avatarThumbData);
            if (!s || s.w >= THUMB_WIDTH) continue;
            faceSmall++;
            // 子目录的**真名**（readFolder 存的是去扩展名的 name + ext，要拼回去）
            const childName = it.ext ? `${it.name}.${it.ext}` : it.name;
            const child = byRel.get(`${d.serial}|${joinRel(d.relPath, childName)}`);
            if (!child) faceNoDoc++;
            else if (child.some(c => c.type === 'folder')) faceCategory++;
            else faceSingle++;
        }
    }
    console.log(`  目录脸里偏小的：${faceSmall}`);
    console.log(`    · 分类目录（里面有子目录，本来就不补）：${faceCategory}`);
    console.log(`    · 单片目录（真正可补的目标）：${faceSingle}`);
    console.log(`    · 子目录从没被扫过（判不出来）：${faceNoDoc}`);

    const smallCards = sizes.filter(s => s.src === 'card' && s.w < THUMB_WIDTH).length;
    console.log(`\n  ⇒ 方案真正的目标量级：封面卡 ${smallCards} + 单片目录脸 ${faceSingle}`);

    // ══ ③ 恒等式有没有反例 + 竖版/横版形态 ═════════════════════════════════
    console.log('\n── ③ 形态核对（不该出现"缩略图宽 > 480"）──');
    const over = sizes.filter(s => s.w > THUMB_WIDTH);
    console.log(`  宽 > ${THUMB_WIDTH} 的：${over.length} 张 ${over.length ? '⚠️ 恒等式被破，判据要重看' : '✅ 0 张 ⇒ 恒等式成立'}`);
    const tall = sizes.filter(s => s.h > s.w).length;
    console.log(`  竖版（高 > 宽）：${tall} 张（${pct(tall, sizes.length)}） · 横版：${sizes.length - tall} 张`);

    // ══ ④ 按"每张脸"汇总：盘上有多少"脸"是小的 ═════════════════════════════
    console.log('\n── ④ 结论数字（写进方案用）──');
    console.log(`  能判定尺寸的"脸" ${sizes.length} 张，其中宽度 < ${THUMB_WIDTH} 的 ${small.length} 张（${pct(small.length, sizes.length)}）`);
    if (small.length) {
        const w = small.map(s => s.w).sort((a, b) => a - b);
        console.log(`  小图宽度：最小 ${w[0]} · 中位 ${w[Math.floor(w.length / 2)]} · 最大 ${w[w.length - 1]}`);
    }

    await fsp.rm(sandbox, { recursive: true, force: true }).catch(() => undefined);
    await fsp.rm(outfile, { force: true }).catch(() => undefined);
}

function joinRel(parent, name) { return parent ? `${parent}/${name}` : name; }

function pct(n, total) {
    return `${((n / Math.max(1, total)) * 100).toFixed(1)}%`;
}

main().catch(e => {
    console.error('PROBE FAILED:', e && e.message ? e.message : e);
    process.exit(1);
});
