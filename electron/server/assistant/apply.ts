/**
 * 管理助手 · 写盘（apply，原 Phase 2B）
 * ===========================================================================
 * 抓取（grab）只拿 URL 不落盘；这里把「命中的封面」真正写进移动硬盘。
 * 输入是一个已完成的 grab job 的结果行（可选 picks 白名单），输出是**按"一部片"分组**的
 * 写盘结果（同样活在 job 里）。
 *
 * 行为定义（2026-09-25 用户明确，**取代**早期"只写封面、不搬动"的决策）：
 *
 *   - **文件形态**（裸视频散在某一层）：以番号建一个**同名文件夹**，把这一部的**全部分卷**
 *     rename 进去，封面写成 `<番号>/<番号>.jpg`（与文件夹同名 —— 用户 2026-09-25 拍板）。
 *     上一层从此看到的是一张带脸的文件夹卡。
 *   - **目录形态**（一部片已经在一个文件夹里，如 `TST-088/`）：什么都不搬，
 *     只补 `<目录名>.jpg` 给这个目录长脸。
 *   - **换封面形态**（`kind:'cover'`，2026-10-02 新增）：目标是**用户已有的那个封面文件**，
 *     直接**覆盖**它（文件名不变）—— 破坏性，所以**写入前必须先备份**（见 `backupCover`）。
 *
 * ⚠️ `cover.jpg` / `avatar.jpg` 是"目录头像"保留名，助手在**新建**时永不写这两个名字
 *（它们由 `makeDirCover` 探、由 `handleCover` 摘）。`cover` 形态例外：它写的是
 * 用户**已经在用的**那个文件 —— 那不是"抢名字"，是"替换既有数据"，且必须留备份。
 *
 * 硬约束：
 *
 *  1. **搬迁只用 rename**。源和目标都在同一块盘上，同卷 rename 是瞬时的、不复制数据 ——
 *     遵守"少碰移动硬盘"第一原则。目标文件已存在、源文件不在了（缓存过期）等冲突
 *     一律**跳过并记录**，不覆盖、不删除、不中断整批，不做回滚。
 *
 *  2. **下载走 Chromium 网络栈**。cf_clearance 与 IP+UA+TLS 三绑定，不能拿 URL 出去给
 *     Node fetch。用 Electron 的 `net.request` + `persist:assistant` session ——
 *     和抓取页面同一个 session（CF cookie 自动带上）。
 *
 *  3. **转真 JPEG**。站点给的"jpg"实际常是 WebP/PNG 改后缀（thumbnail.ts 里有实测记录）。
 *     直接落盘，缩略图链路（nativeImage）解不开 → 空白卡片。所以写之前一律转成真 JPEG。
 *     ⚠️ 判据本体在 `coverImage.ts`：抓取 / 预览 / 写盘共用一份 `getVerifiedCover()`。
 *
 *  5. **⚠️ 先拿到封面，再动盘**（2026-11-10 主人报「点了写入多了一堆没封面的
 *     `A/A.mp4`」）：原顺序是「建文件夹 + rename 搬视频 → 再下载封面」，下载或解码
 *     一失败，视频已经进了新建的文件夹、封面却没有 ⇒ 盘上多出一批永远没脸的作品，
 *     而且 rename 不可逆。现在下载 + 解码 + 封面落盘全部成功之后才搬视频；
 *     任何一步失败 ⇒ **盘上一个字节都不动**（本次新建的空文件夹也会收掉）。
 *
 *  4. **写完必须失效目录缓存**。写完不失效，UI 命中缓存直接下发旧脸 —— "界面没变"
 *     会被当成"没写成功"。文件形态失效所在层（视频搬走了 + 新文件夹长脸，都在这一层
 *     的缓存文档里）；目录形态失效影片目录自己 + 它的父目录（目录的脸长在父目录缓存里）。
 *
 * 原子写：临时文件写在**目标目录内**（同一卷上 rename 才是原子的），写完改名成最终名。
 * 临时名用 `.cover-*.tmp` —— 中途断电/拔盘最多留一个隐藏的半截文件，不会顶掉旧封面。
 */
import * as fsasync from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { getDrives } from '../../utils/driveIdentity';
import { findCache, removeCache } from '../nedb';
import type { OpenMode } from '../nedb';
import { patchItemByLocation } from '../playlistStore';
import { enqueue, CancelledError } from './queue';
import { appendTombstone } from './hits';
import { cardKeyOf } from './cardKey';
import { getVerifiedCover, isUsableCoverUrl, toJpeg } from './coverImage';
import type { CoverCheck } from './coverImage';
import { framePath } from './frame';
import type { GrabRow } from './grab';
import type { Job } from './jobs';
import { bumpProgress, finishJob, pushRow } from './jobs';

/** 一行写盘结果（= 一部片 / 一个分组）。ok = 封面真的写进盘了（rename 完成才算） */
export interface ApplyRow {
    /** 封面最终位置（盘内相对路径） */
    writeRel: string;
    ok: boolean;
    message: string;
}

/** 一部片的写盘动作。文件形态带 srcRels（要搬的分卷），目录形态为空 */
interface ApplyGroup {
    /** 分组键：`file|层目录|番号` / `dir|写入路径` / `cover|写入路径` */
    key: string;
    kind: 'file' | 'dir';
    /** 番号（墓碑缓存要用） */
    query: string;
    /** 封面最终位置（盘内相对路径） */
    coverWriteRel: string;
    /** 文件形态 = 分卷所在的层；目录形态 = 影片目录自己 */
    layerDir: string;
    /** 文件形态 = 番号文件夹（盘内相对路径）；目录形态 = '' */
    folderRel: string;
    /** 要搬进番号文件夹的源视频（盘内相对路径，含扩展名） */
    srcRels: string[];
    coverUrl: string;
    /**
     * 帧缓存文件名（`frame.ts` 的 `FrameRow.frameFile`）。非空 ⇒ 这一组的封面字节来自
     * **本地抽帧**，不下载。两者互斥：帧行没有 coverUrl，抓取行没有 frameFile。
     */
    frameFile: string | null;
    /**
     * `true` = 目标是**用户已有的那个封面文件**（`kind:'cover'`）⇒ 写入前必须先备份。
     * `false` = 写的是**新文件** `<目录名>.jpg`（`kind:'dir'`）⇒ 无破坏、不备份。
     */
    overwrite: boolean;
}

/** 盘内相对路径拼接 */
function joinRel(parent: string, name: string): string {
    return parent ? `${parent}/${name}` : name;
}

/** 取路径的最后一段 */
function baseOf(rel: string): string {
    const i = rel.lastIndexOf('/');
    return i === -1 ? rel : rel.slice(i + 1);
}

function dirOf(rel: string): string {
    const i = rel.lastIndexOf('/');
    return i === -1 ? '' : rel.slice(0, i);
}

/** 目录在不在。只用来判断"这个空文件夹是不是本次新建的"，不读内容、不递归 */
async function exists(abs: string): Promise<boolean> {
    try { await fsasync.access(abs); return true; } catch { return false; }
}

/**
 * 把命中行折成"一部片"分组。分卷（`AAA-123-A`/`TST-014-01…08`）在 scan/parse 阶段
 * 就归一到同一番号了，这里按 `(所在层, 番号)` 再收拢一次：同一部的所有分卷
 * 进同一个文件夹、共用一张封面 —— 用户 2026-09-25 的要求。
 *
 * 封面命名（用户拍板）：与文件夹**同名**（`AAA-123/AAA-123.jpg`）。
 * `cover.jpg`/`avatar.jpg` 是"目录头像"保留名，助手**新建时**永不写。
 * 形态判定用 GrabRow.kind（scan 透传），**不靠 writeRel 的文件名猜**。
 *
 * `export` 仅为探针可测（`docs/probes/faces/verify.mjs`）—— 纯函数、只依赖入参，
 * 测试它不需要碰盘也不需要 electron。
 */
export function buildGroups(rows: GrabRow[]): ApplyGroup[] {
    const groups = new Map<string, ApplyGroup>();
    for (const r of rows) {
        // 门槛两条腿：站点行要有能下载的 URL，帧行要有本地字节来源（`frame === true`）。
        // 帧行的 coverUrl 恒为 null —— 只判 URL 会把抽帧结果整批挡在写盘之外。
        if (r.status !== 'ok' || (!isUsableCoverUrl(r.coverUrl) && !r.frame)) continue;

        if (r.kind === 'dir' || r.kind === 'cover') {
            // 两者都是「**只写封面、不搬任何东西**」，区别只在写哪、有没有破坏：
            //   · dir   → 写**新文件** `<目录名>.jpg`；`handleCover` 会摘掉旧的
            //             `avatar.jpg`/`cover.jpg`，新图自动成为脸 —— **旧文件一个不动**。
            //   · cover → **覆盖**用户已有的那个封面文件（换封面）⇒ 破坏性，写入前必须先备份。
            //
            // ⚠️ 分组键必须带 `writeRel`，**不能只用 layerDir**：同一层可能有多个待写目标
            //（`演员A/` 下同时有 `TST-001/`、`TST-002/`…）。原版用 `dir|layerDir` 作键，
            // 后面同层的会被 `groups.has()` 吞掉、**静默丢失**。这里一并修掉。
            const overwrite = r.kind === 'cover';
            const key = cardKeyOf({ kind: overwrite ? 'cover' : 'dir', writeRel: r.writeRel });
            if (!groups.has(key)) {
                groups.set(key, {
                    key, kind: 'dir', query: r.query, coverWriteRel: r.writeRel,
                    layerDir: dirOf(r.writeRel), folderRel: '', srcRels: [],
                    coverUrl: r.coverUrl ?? '', frameFile: r.frameFile ?? null, overwrite,
                });
            }
            continue;
        }

        // 文件形态：同层同番号的所有分卷 → 一个番号文件夹，封面与文件夹同名
        const layerDir = dirOf(r.writeRel);
        const key = cardKeyOf({ kind: 'file', writeRel: r.writeRel, query: r.query });
        let g = groups.get(key);
        if (!g) {
            g = {
                key, kind: 'file', query: r.query,
                coverWriteRel: joinRel(joinRel(layerDir, r.query), `${r.query}.jpg`),
                layerDir,
                folderRel: joinRel(layerDir, r.query),
                srcRels: [],
                coverUrl: r.coverUrl ?? '',
                // 文件形态取**该组第一条带帧的行**：同一张卡的分卷行共用一张脸，
                // 只要有一行带 frameFile，整组（连同全部 srcRels）就走本地字节。
                frameFile: r.frameFile ?? null,
                overwrite: false,
            };
            groups.set(key, g);
        }
        if (r.srcRel && !g.srcRels.includes(r.srcRel)) g.srcRels.push(r.srcRel);
    }
    return [...groups.values()];
}

/**
 * 帧行的字节来源：读系统盘缓存文件，**不出网**。
 *
 * 形状与 `getVerifiedCover` 的返回值一致（`CoverCheck`），让 `runApply` 只保留一个分支点：
 * 走到这里之后，站点封面与抽帧封面完全同路（备份 / 原子写 / 搬迁 / 日志都不分叉）。
 * `urlBad` 恒 false：没有 URL 可怪，缓存没了就让用户重抽一次。
 */
async function localCover(dataDir: string, serial: string, file: string): Promise<CoverCheck> {
    let raw: Buffer;
    try {
        raw = await fsasync.readFile(framePath(dataDir, serial, file));
    } catch {
        return { ok: false, jpg: null, urlBad: false, why: '抽帧缓存不在了，重抽一次' };
    }
    if (!raw.length) return { ok: false, jpg: null, urlBad: false, why: '抽帧缓存是空文件' };
    const jpg = await toJpeg(raw);
    if (!jpg) return { ok: false, jpg: null, urlBad: false, why: '抽帧图解不出来' };
    return { ok: true, jpg, urlBad: false, why: '' };
}

/**
 * 跑写盘任务。`rows` 必须来自 grab 结果里 status==='ok' 且带 coverUrl 的行
 * （调用方过滤，见 index.ts）；`picks` 是前端确认弹窗勾选的 writeRel 白名单
 * （不传 = 全写）。
 */
export async function runApply(
    serial: string,
    rows: GrabRow[],
    job: Job<ApplyRow>,
    dataDir: string,
    picks?: string[],
    scanAndCache?: (serial: string, drive: string, relPath: string, mode: OpenMode) => Promise<unknown>,
): Promise<void> {
    // 盘必须在线：写盘的路径从「卷序列号 → 当前盘符」现场反查。
    // 盘符不是身份、序列号才是 —— 拿缓存里冻过的盘符写盘等于往别的盘上写。
    const drive = (await getDrives(true)).find(d => d.serial === serial);
    if (!drive) {
        finishJob(job, 'error', '这块盘现在不在线，插上盘再写入');
        return;
    }
    const root = drive.root.endsWith('/') || drive.root.endsWith('\\') ? drive.root : `${drive.root}/`;

    const picked = picks?.length ? rows.filter(r => picks.includes(r.writeRel)) : rows;
    const groups = buildGroups(picked);
    bumpProgress(job, { total: groups.length });
    if (!groups.length) {
        finishJob(job, 'done', '没有可写入的项');
        return;
    }

    let written = 0;
    const affectedDirs = new Set<string>();
    /** 只有真正写成了的组才能进「同步收藏夹」——失败的组盘上什么都没变 */
    const okGroups: ApplyGroup[] = [];

    /** 一条失败的统一记账口：三个失败分支不许各写一遍 */
    const fail = (g: ApplyGroup, why: string, notes: string[], urlBad: boolean) => {
        appendLog(dataDir, `${new Date().toISOString()}\t${serial}\t${g.coverWriteRel}\tfail\t${why}\t${notes.join('；')}`);
        // URL 永久坏 → 命中缓存立墓碑，下次抓取重新真抓
        if (urlBad && g.query) appendTombstone(dataDir, g.query);
        pushRow(job, {
            writeRel: g.coverWriteRel, ok: false,
            message: `${notes.join('；')}；封面没写成：${why}`,
        });
        bumpProgress(job, { processed: job.progress.processed + 1, current: '' });
    };

    try {
        for (const g of groups) {
            if (job.cancelled) break;
            // 暂停：当前这一部写完就停，剩下的留在队列里等「继续」——
            // 半途停在一个分组中间（分卷搬了一半）比停下来更糟
            await job.gate.wait();
            if (job.cancelled) break;

            bumpProgress(job, { current: g.folderRel || g.layerDir });
            const notes: string[] = [];

            // ── ① 判据先行：拿到能解码成 JPEG 的字节，**此刻盘上一个字节都没动** ──
            // 与 grab / preview 共用 `getVerifiedCover`（形态 → 下载 → 非空 → 解码）。
            // 抓取时验过的字节大多已在 `verifiedBytes` 里 ⇒ 这里连网络都不出。
            let cover: CoverCheck;
            try {
                cover = g.frameFile
                    ? await localCover(dataDir, serial, g.frameFile)
                    : await getVerifiedCover(g.coverUrl, job.controller.signal, enqueue);
            } catch (e) {
                // 取消是控制流，不是"这一部写失败"
                if (job.cancelled || e instanceof CancelledError) break;
                throw e;
            }
            if (!cover.ok) {
                fail(g, cover.why, notes, cover.urlBad);
                continue;
            }
            const jpg = cover.jpg!;

            // ── ② 覆盖前备份（只 `cover` 形态 = 换封面）────────────────────────
            // PRD D7 明文「覆盖前先备份」。备份落**系统盘**的数据目录 ——
            // 刻意**不在移动硬盘上留 `.bak`**（多一个文件、脏，而写盘本身就在碰盘）。
            // ⚠️ 备份失败 ⇒ 放弃覆盖：宁可记失败，也不在"没有退路"时覆盖用户的文件。
            if (g.overwrite) {
                const b = await backupCover(root, g.coverWriteRel, dataDir, serial);
                if (!b.ok) {
                    fail(g, '原图备份失败，这条没写（你的文件没被动过）', notes, false);
                    continue;
                }
                // D7 的"可还原"靠这条兑现：日志里留下备份在数据目录内的相对路径
                if (b.file) notes.push(`原图已备份：${b.file}`);
                notes.push('覆盖原封面（已备份到数据目录）');
            } else {
                notes.push(g.kind === 'dir' ? '已有文件夹，只补封面' : '新建番号文件夹');
            }

            // ── ③ 封面落盘：目标目录内 tmp → rename 原子写 ──────────────────────
            // ⚠️ 只在这里建文件夹，且只在「本次新建」时记下来 —— 万一封面写失败，
            //    要能把这空文件夹收掉（非递归 rmdir，非空就失败，不会碰用户文件）。
            const abs = `${root}${g.coverWriteRel}`;
            const absDir = path.dirname(abs);
            const tmp = path.join(absDir, `.cover-${process.pid}-${Date.now()}.tmp`);
            let createdFolder = false;
            let ok = false;
            let why = '';
            try {
                createdFolder = g.kind === 'file' && !(await exists(absDir));
                await fsasync.mkdir(absDir, { recursive: true });
                await fsasync.writeFile(tmp, jpg);
                await fsasync.rename(tmp, abs);
                ok = true;
            } catch (e) {
                why = e instanceof Error ? e.message : String(e);
            } finally {
                // rename 成功后 tmp 已不存在；失败时把半截文件清掉（不是删盘上旧文件）
                fsasync.unlink(tmp).catch(() => {});
            }
            if (!ok) {
                if (createdFolder) await fsasync.rmdir(absDir).catch(() => {});
                fail(g, why, notes, false);
                continue;
            }

            // ── ④ 搬分卷（只文件形态；同卷 rename，瞬时、不复制数据）────────────
            // 封面已经躺在文件夹里了 —— 从这里开始，就算某一卷 rename 失败，
            // 也只会是"少搬了一卷"，绝不会是"多了一部没脸的作品"。
            if (g.kind === 'file') {
                let moved = 0;
                for (const src of g.srcRels) {
                    if (job.cancelled) break;
                    // 视频主名的英文字母转大写（用户 2026-09-25 拍板：a1b1.mp4 → A1B1.mp4；
                    // 只转主名，扩展名不动；仅此一处转，不做别的改名）
                    const base = baseOf(src);
                    const dot = base.lastIndexOf('.');
                    const newName =
                        (dot === -1 ? base : base.slice(0, dot)).replace(/[a-z]/g, c => c.toUpperCase()) +
                        (dot === -1 ? '' : base.slice(dot));
                    try {
                        await fsasync.rename(`${root}${src}`, `${root}${g.folderRel}/${newName}`);
                        moved += 1;
                    } catch (e) {
                        // 目标同名文件已存在 / 源已不在（缓存过期）—— 跳过这卷，不覆盖不删除
                        notes.push(`${base} 没搬（${e instanceof Error ? e.message : e}）`);
                    }
                }
                notes.unshift(`搬入 ${moved}/${g.srcRels.length} 个分卷`);
            }

            // ── ⑤ 失效目录缓存（写完不失效，UI 永远是旧脸） ──
            // 帧缓存到此已落盘到移动硬盘，系统盘那一份没人再引用 ⇒ 立刻回收。
            // 放这里而不是更早：写失败时要留着它给用户重试。
            if (g.frameFile) fsasync.unlink(framePath(dataDir, serial, g.frameFile)).catch(() => {});
            written += 1;
            okGroups.push(g);
            // 文件形态：视频搬走 + 新文件夹长脸，都发生在**层目录**的缓存文档里；
            // 目录形态：影片目录自己多了 cover.jpg，父目录的缓存里它长了脸 —— 两边都要失效。
            const targetDir = g.kind === 'dir' ? dirOf(g.layerDir) : g.layerDir;
            if (scanAndCache) {
                affectedDirs.add(targetDir);
                if (g.layerDir) removeCache(serial, g.layerDir, 'cover').catch(() => {});
            } else {
                removeCache(serial, g.layerDir, 'cover').catch(() => {});
            }
            if (!scanAndCache && g.kind === 'dir') removeCache(serial, dirOf(g.layerDir), 'cover').catch(() => {});
            appendLog(dataDir, `${new Date().toISOString()}\t${serial}\t${g.coverWriteRel}\tok\t${notes.join('；')}`);

            pushRow(job, {
                writeRel: g.coverWriteRel,
                ok,
                message: notes.join('；'),
            });
            bumpProgress(job, { processed: job.progress.processed + 1, hits: written, current: '' });
        }

        if (scanAndCache && drive && affectedDirs.size) {
            for (const dir of affectedDirs) {
                try {
                    await scanAndCache(serial, drive.drive, dir, 'cover');
                } catch (e) {
                    console.error('[apply] 写入后重建缓存失败:', dir, e);
                }
            }
        }

        // ── ⑥ 主动同步收藏夹（只把**真写成了**的组交过去） ──
        try {
            await syncPlaylistsAfterApply(dataDir, serial, okGroups, (s, r, m) => findCache(s, r, m));
        } catch (e) {
            console.error('[apply] 同步收藏夹失败:', e);
        }

        const { processed, total } = job.progress;
        if (job.cancelled) {
            finishJob(job, 'cancelled', `已终止：写了 ${written} 组（处理到 ${processed}/${total}，剩 ${total - processed} 组没写）`);
        } else {
            const failed = processed - written;
            finishJob(job, 'done', `写入完成：成功 ${written}，失败 ${failed}`);
        }
    } catch (e) {
        finishJob(job, 'error', e instanceof Error ? e.message : String(e));
    }
}

/**
 * 助手写盘完成后，主动同步收藏夹（playlists.json）：
 * 1. 单视频被整理进同名文件夹（kind === 'file'）：将旧路径 (serial, layerDir, query)
 *    更新为新文件夹代言卡路径 (serial, folderRel, query)，type 升级为 'image'，并同步新 sig 与 files
 * 2. 换封面/补封面（kind === 'dir' 或 overwrite）：同步最新封面 sig
 */
export async function syncPlaylistsAfterApply(
    dataDir: string,
    serial: string,
    groups: Array<{ kind: 'file' | 'dir'; query: string; layerDir: string; folderRel: string }>,
    findCacheFn: (serial: string, relPath: string, mode: OpenMode) => Promise<any>,
): Promise<void> {
    for (const g of groups) {
        if (g.kind === 'file') {
            const cache = await findCacheFn(serial, g.layerDir, 'cover');
            const hit = cache?.data?.find((e: any) => e.name === g.query && (e.type === 'image' || e.dir === g.folderRel));
            // 守卫：只有当真正确认生成了封面代言卡时，才触发条目迁移，避免任务失败时盲目改写
            if (hit && (hit.type === 'image' || hit.sig)) {
                await patchItemByLocation(dataDir, serial, g.layerDir, g.query, {
                    relPath: g.folderRel,
                    type: 'image',
                    sig: hit.sig,
                    files: Array.isArray(hit.files) ? hit.files : undefined,
                    size: typeof hit.size === 'number' ? hit.size : undefined,
                });
            }
        } else if (g.kind === 'dir') {
            const parentDir = dirOf(g.layerDir);
            const cache = await findCacheFn(serial, parentDir, 'cover');
            const hit = cache?.data?.find((e: any) => e.name === g.query || e.dir === g.layerDir);
            if (hit?.sig) {
                await patchItemByLocation(dataDir, serial, g.layerDir, g.query, {
                    sig: hit.sig,
                    files: Array.isArray(hit.files) ? hit.files : undefined,
                    size: typeof hit.size === 'number' ? hit.size : undefined,
                });
            }
        }
    }
}

/**
 * 覆盖前把原图备份到**系统盘**的数据目录（`~/.file-finder/assistant/cover-backup/<serial>/`）。
 *
 * 返回（调用方据此决定要不要继续）：
 *   - `{ ok: true }`  —— 已备份好；**或**源文件本来就不存在（没有可毁的东西）⇒ 可以继续写
 *   - `{ ok: true, file }` —— 已备份，`file` 是**数据目录内的相对路径**（写进 `apply.log`，
 *                             这样"备份在哪"是可追溯的 —— D7 的"可还原"义务靠这一条兑现）
 *   - `{ ok: false }` —— 读取/写备份失败 ⇒ 调用方**必须放弃覆盖**
 *
 * 文件名 = `<时间戳>__<路径哈希>__<原文件名尾巴>`，**一层平铺**、不重建目录树：
 * 盘内相对路径可能很长（`演员名/番号/子目录/…`），Windows 有 260 字符的路径上限，
 * 直接照搬会写失败。哈希保唯一，尾巴保人还能看出是哪张。
 */
async function backupCover(
    root: string, rel: string, dataDir: string, serial: string,
): Promise<{ ok: boolean; file?: string }> {
    const abs = `${root}${rel}`;
    let buf: Buffer;
    try {
        buf = await fsasync.readFile(abs);
    } catch (e) {
        // ENOENT：这张脸已经不在盘上了（缓存过期 / 用户手动删过）。
        // 没有可备份的东西 = 没有可毁的东西 ⇒ 放行，让后面的写入照常走。
        return { ok: (e as NodeJS.ErrnoException)?.code === 'ENOENT' };
    }

    try {
        const dir = path.join(dataDir, 'assistant', 'cover-backup', serial);
        await fsasync.mkdir(dir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const hash = crypto.createHash('sha1').update(rel).digest('hex').slice(0, 10);
        const tail = baseOf(rel).replace(/[\\/]/g, '_').slice(-48);
        const name = `${stamp}__${hash}__${tail}`;
        await fsasync.writeFile(path.join(dir, name), buf);
        return { ok: true, file: `assistant/cover-backup/${serial}/${name}` };
    } catch (e) {
        console.error('[assistant/apply] 备份原封面失败:', rel, e);
        return { ok: false };
    }
}

/** 追加 apply.log（数据目录里，不碰移动硬盘）。写日志失败只打控制台 —— 不能让它连累写盘结果 */
function appendLog(dataDir: string, line: string): void {
    fsasync.appendFile(path.join(dataDir, 'apply.log'), `${line}\n`, 'utf8').catch(e => {
        console.error('[assistant/apply] 写 apply.log 失败:', e);
    });
}

/**
 * 从 apply.log 收集这块盘上**写过的目录**（「深度重扫」用）。
 *
 * 背景：扫描是零读盘、只认缓存的。用户在盘上手动删过图之后，缓存还停在旧样子
 * —— 尤其 apply 写完会失效那几层缓存（防旧脸），失效后没人浏览过的目录对扫描
 * **完全不可见**。深度重扫要把这些目录真读一遍重建缓存，目录清单就来自这份日志
 * （它精确记录了助手碰过哪些层，不用全盘走一遍）。
 *
 * 新格式里封面一律是 `.../cover.jpg`，所以对每行取两级父目录：
 *   dir-form：dirOf = 影片目录自己；file-form：dirOf = 番号文件夹、dirOf² = 分卷原在的层。
 * 两个都收（去重）—— 多重建一个目录只是把缓存刷成盘上现状，无害。
 */
export async function readWrittenDirs(dataDir: string, serial: string): Promise<string[]> {
    let text = '';
    try {
        text = await fsasync.readFile(path.join(dataDir, 'apply.log'), 'utf8');
    } catch {
        return []; // 还没写入过任何东西
    }
    const dirs = new Set<string>();
    for (const line of text.split('\n')) {
        const f = line.split('\t');
        if (f.length < 3 || f[1] !== serial) continue;
        // 失败行也收（无害）：2026-11-10 起「先拿封面再动盘」，失败时盘上零改动，
        // 但日志里仍有这条路径；多重扫一个目录只是把缓存刷成盘上现状。
        const a = dirOf(f[2]);
        if (a) dirs.add(a);
        const b = dirOf(a);
        if (b) dirs.add(b);
    }
    return [...dirs];
}
