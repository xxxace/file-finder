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
import os from 'node:os';
import crypto from 'node:crypto';
import { net, nativeImage, session } from 'electron';
import { getDrives } from '../../utils/driveIdentity';
import { removeCache } from '../nedb';
import { transcodeImage } from '../../utils/thumbnail';
import { enqueue, hostOf } from './queue';
import { appendTombstone } from './hits';
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
        if (r.status !== 'ok' || !r.coverUrl) continue;

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
            const key = `${overwrite ? 'cover' : 'dir'}|${r.writeRel}`;
            if (!groups.has(key)) {
                groups.set(key, {
                    key, kind: 'dir', query: r.query, coverWriteRel: r.writeRel,
                    layerDir: dirOf(r.writeRel), folderRel: '', srcRels: [],
                    coverUrl: r.coverUrl, overwrite,
                });
            }
            continue;
        }

        // 文件形态：同层同番号的所有分卷 → 一个番号文件夹，封面与文件夹同名
        const layerDir = dirOf(r.writeRel);
        const key = `file|${layerDir}|${r.query}`;
        let g = groups.get(key);
        if (!g) {
            g = {
                key, kind: 'file', query: r.query,
                coverWriteRel: joinRel(joinRel(layerDir, r.query), `${r.query}.jpg`),
                layerDir,
                folderRel: joinRel(layerDir, r.query),
                srcRels: [],
                coverUrl: r.coverUrl,
                overwrite: false,
            };
            groups.set(key, g);
        }
        if (r.srcRel && !g.srcRels.includes(r.srcRel)) g.srcRels.push(r.srcRel);
    }
    return [...groups.values()];
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
    try {
        for (const g of groups) {
            if (job.cancelled) break;

            bumpProgress(job, { current: g.folderRel || g.layerDir });
            const notes: string[] = [];

            // ── ⓪ 覆盖前备份（只 `cover` 形态 = 换封面）────────────────────────
            // PRD D7 明文「覆盖前先备份」。备份落**系统盘**的数据目录 ——
            // 刻意**不在移动硬盘上留 `.bak`**（多一个文件、脏，而写盘本身就在碰盘）。
            //
            // ⚠️ 备份失败 ⇒ **放弃覆盖**。宁可这一条记失败，也绝不在"没有退路"的情况下
            // 覆盖用户自己的文件。源文件不存在（缓存过期 / 已被手动删）**不算失败** ——
            // 本来就没有东西可毁，让流程照常走。
            if (g.overwrite) {
                const b = await backupCover(root, g.coverWriteRel, dataDir, serial);
                if (!b.ok) {
                    appendLog(dataDir, `${new Date().toISOString()}\t${serial}\t${g.coverWriteRel}\tfail\t原图备份失败，已跳过（没有覆盖）`);
                    pushRow(job, {
                        writeRel: g.coverWriteRel,
                        ok: false,
                        message: '原图备份失败，这条没写（你的文件没被动过）',
                    });
                    bumpProgress(job, { processed: job.progress.processed + 1, current: '' });
                    continue;
                }
                // ⚠️ 备份路径必须**留下痕迹**：PRD D7 说的"覆盖前先备份"只有配上"备份在哪"
                // 才真的可还原。只记数据目录内的**相对路径** —— 绝对路径又长又带用户名，
                // 日志里没必要（数据目录本身就是固定的）。
                if (b.file) notes.push(`原图已备份：${b.file}`);
            }

            // ── ① 建番号文件夹 + 搬分卷（只文件形态；同卷 rename，瞬时、不复制数据） ──
            if (g.kind === 'file') {
                const absFolder = `${root}${g.folderRel}`;
                try {
                    // 文件夹可能已存在（用户手动建过 / 上次搬过一半）—— 直接往里搬
                    await fsasync.mkdir(absFolder, { recursive: true });
                } catch (e) {
                    notes.push(`建文件夹失败：${e instanceof Error ? e.message : e}`);
                }
                let moved = 0;
                for (const src of g.srcRels) {
                    if (job.cancelled) break;
                    // 搬迁时把视频主名的英文字母转大写（用户 2026-09-25 拍板：
                    // a1b1.mp4 → A1B1.mp4；只转主名，扩展名不动；仅此一处转，不做别的改名）
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
            } else {
                notes.push(g.overwrite ? '覆盖原封面（已备份到数据目录）' : '已有文件夹，只补封面');
            }

            // ── ② 下载封面（Chromium 网络栈 + 抓取用的同一个 session） ──
            let buf: Buffer | null = null;
            let why = '';
            // URL 本身永久坏了（404 / 返回的不是图）。真坏了就给命中缓存立墓碑，
            // 否则下次抓取还会复用这条死链，永远失败。
            let urlBad = false;
            try {
                const res = await enqueue(hostOf(g.coverUrl), () =>
                    download(g.coverUrl, job.controller.signal),
                );
                if (res.status === 200) {
                    buf = res.buf;
                } else {
                    why = `下载失败（HTTP ${res.status}）`;
                    urlBad = true;
                }
            } catch (e) {
                // abort 是控制流：整批直接收尾，不记成"这条失败"
                if (job.cancelled) break;
                // 网络错误不算 URL 坏（可能只是暂时断网），不立墓碑
                why = e instanceof Error ? e.message : String(e);
            }

            // ── ③ 转 JPEG → 目标目录内 tmp → rename 原子写 ──
            let ok = false;
            if (buf) {
                const abs = `${root}${g.coverWriteRel}`;
                const absDir = path.dirname(abs);
                const jpg = await toJpeg(buf);
                if (!jpg) {
                    why = '图片解不出来（可能不是图），没写';
                    urlBad = true;
                } else {
                    const tmp = path.join(absDir, `.cover-${process.pid}-${Date.now()}.tmp`);
                    try {
                        // 目标目录理论上必然存在（file 形态刚建过、dir 形态来自缓存）。
                        // recursive 兜一下"目录被用户手动删了"的情况，省得整批死在这。
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
                }
            }

            // ── ④ 失效目录缓存（写完不失效，UI 永远是旧脸） ──
            if (ok) {
                written += 1;
                // 文件形态：视频搬走 + 新文件夹长脸，都发生在**层目录**的缓存文档里；
                // 目录形态：影片目录自己多了 cover.jpg，父目录的缓存里它长了脸 —— 两边都要失效。
                removeCache(serial, g.layerDir, 'cover').catch(() => {});
                if (g.kind === 'dir') removeCache(serial, dirOf(g.layerDir), 'cover').catch(() => {});
                appendLog(dataDir, `${new Date().toISOString()}\t${serial}\t${g.coverWriteRel}\tok\t${notes.join('；')}`);
            } else {
                appendLog(dataDir, `${new Date().toISOString()}\t${serial}\t${g.coverWriteRel}\tfail\t${why}\t${notes.join('；')}`);
                // URL 永久坏 → 命中缓存立墓碑，下次抓取重新真抓
                if (urlBad && g.query) appendTombstone(dataDir, g.query);
            }

            pushRow(job, {
                writeRel: g.coverWriteRel,
                ok,
                message: ok ? notes.join('；') : `${notes.join('；')}；封面没写成：${why}`,
            });
            bumpProgress(job, { processed: job.progress.processed + 1, hits: written, current: '' });
        }

        const { processed, total } = job.progress;
        if (job.cancelled) {
            finishJob(job, 'cancelled', `已取消：写了 ${written} 组（处理到 ${processed}/${total}）`);
        } else {
            const failed = processed - written;
            finishJob(job, 'done', `写入完成：成功 ${written}，失败 ${failed}`);
        }
    } catch (e) {
        finishJob(job, 'error', e instanceof Error ? e.message : String(e));
    }
}

/**
 * 任意图片字节 → 真 JPEG。
 *   JPEG 本尊 → 原样返回（零损耗零转码）；
 *   PNG / 其它 nativeImage 认的 → 解码后重编；
 *   nativeImage 解不开（典型：改后缀的 WebP）→ ffmpeg 兜底转 PNG 再编（复用
 *   thumbnail.ts 的 `transcodeImage`，中转文件在系统盘临时目录，用完即删）。
 * 都失败返回 null —— 调用方把这一行记成失败，不写半截文件。
 */
async function toJpeg(buf: Buffer): Promise<Buffer | null> {
    if (isJpeg(buf)) return buf;

    const img = nativeImage.createFromBuffer(buf);
    if (!img.isEmpty()) return img.toJPEG(COVER_JPEG_QUALITY);

    // ffmpeg 兜底：源写系统盘临时目录（不碰移动硬盘），转 PNG → 解码 → 编 JPEG
    const rand = Math.random().toString(36).slice(2, 8);
    const src = path.join(os.tmpdir(), `ff-cover-src-${process.pid}-${Date.now()}-${rand}.bin`);
    const out = path.join(os.tmpdir(), `ff-cover-out-${process.pid}-${Date.now()}-${rand}.png`);
    try {
        await fsasync.writeFile(src, buf);
        if (!(await transcodeImage(src, out))) return null;
        const png = await fsasync.readFile(out);
        const decoded = nativeImage.createFromBuffer(png);
        return decoded.isEmpty() ? null : decoded.toJPEG(COVER_JPEG_QUALITY);
    } catch {
        return null;
    } finally {
        fsasync.unlink(src).catch(() => {});
        fsasync.unlink(out).catch(() => {});
    }
}

/** 是不是 JPEG 本尊（FF D8 FF）。是的话原样落盘，不再走一遍有损编码 */
function isJpeg(buf: Buffer): boolean {
    return buf.length > 2 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
}

/** 写入 JPEG 的质量。封面本来就是有损的再分发，90 在体积和观感上是常见的稳态点 */
const COVER_JPEG_QUALITY = 90;

/**
 * 经 Chromium 网络栈下载一张图。
 *
 * 为什么不用 `net.fetch`：Electron 44 的 RequestInit 类型只放行了
 * `bypassCustomProtocolHandlers`，`session` 选项不在类型里；而 `net.request`
 * 的 options 从类型到运行时都明确支持 `session` + `useSessionCookies` ——
 * 用它才能把「和抓取页面同一个 session（CF cookie 自动带上）」写成类型保证。
 *
 * 导出给「预览代理」复用（index.ts 的 /assistant/preview）：预览和写盘必须走
 * **同一条下载通道**，预览能显示的就一定能写入。
 */
export function download(
    url: string,
    signal: AbortSignal,
): Promise<{ status: number; buf: Buffer; type: string | null }> {
    return new Promise((resolve, reject) => {
        const req = net.request({
            url,
            session: session.fromPartition('persist:assistant'),
            useSessionCookies: true,
        });
        let settled = false;
        const done = (fn: () => void) => {
            if (settled) return;
            settled = true;
            fn();
        };

        signal.addEventListener('abort', () => {
            try { req.abort(); } catch { /* 已结束 */ }
        }, { once: true });

        req.on('response', res => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk: Buffer) => chunks.push(chunk));
            res.on('end', () => done(() => resolve({
                status: res.statusCode ?? 0,
                buf: Buffer.concat(chunks),
                type: (res.headers['content-type'] as string | undefined) ?? null,
            })));
            res.on('error', (e: Error) => done(() => reject(e)));
        });
        req.on('error', (e: Error) => done(() => reject(e)));
        req.end();
    });
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
        // 失败行也收：分组可能已经搬完了分卷才在封面这步失败，层目录同样变过样
        const a = dirOf(f[2]);
        if (a) dirs.add(a);
        const b = dirOf(a);
        if (b) dirs.add(b);
    }
    return [...dirs];
}
