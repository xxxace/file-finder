/**
 * 补封面 · 抽帧（把视频关键帧当封面）
 * ===========================================================================
 * 立场：**抽帧是"另一个取图来源"，不是另一条写入链路。**
 * 它产出的行与抓取同形（`FrameRow extends GrabRow`），进同一个 job 表、驱动同一张卡、
 * 经同一个 `/assistant/apply` 写盘。差别只有一处：写盘取字节时读本地缓存文件，而不是下载 URL。
 *
 * 三件事必须成立：
 *   1. **先上卡、再写入**。抽出来的帧只落系统盘缓存，盘上一个字节都不动；用户看了满意才写。
 *      （他要"每次往前些，防止黑色当封面"——没有预览就没有这个"再来一帧"的循环。）
 *   2. **帧缓存一张卡一份**。8 个分卷共用一张脸；按 writeRel 各存一份等于抽 8 次。
 *   3. **引用关系由缓存记录判定**（`readFrameIndex` / `inventory`）。卡键可复算 ⇒ 不需要
 *      sidecar 之类的第二份账；"已经补上正式封面"的卡不在"仍缺封面"集合里，它的帧自然是废的。
 */
import * as fsasync from 'node:fs/promises';
import path from 'node:path';
import { nativeImage } from 'electron';
import { getDrives } from '../../utils/driveIdentity';
import { frameJpeg } from '../../utils/thumbnail';
import { cardKeyOf, key16Of } from './cardKey';
import { FLAT_RATIO, FLAT_SAMPLE, PCT_LADDER, flatRatio, pctOf } from './frameMath';
import { isVideo } from '../videoExt';
import { loadMeta } from '../nedb';
import { scanMissingCovers } from './scan';
import type { ScanTarget } from './scan';
import type { GrabRow } from './grab';
import type { Job } from './jobs';
import { bumpProgress, finishJob, pushRow } from './jobs';

/** 抽帧失败的原因。归到 `status:'error'`，不扩 `GrabStatus` 枚举（界面按它换一句人话） */
export type FrameWhy = 'no-video' | 'probe-failed' | 'no-frame' | 'offline';

export interface FrameRow extends GrabRow {
    frame: true;
    /** 帧缓存文件名（不含目录）。同一张卡的所有 writeRel 共用一个 */
    frameFile: string;
    /** 实际用的档位（百分比） */
    pct: number;
    /** 阶梯下标。下次「换一帧」= attempt + 1 */
    attempt: number;
    /** 这一张自动跳过了几档纯色帧 */
    skipped: number;
    why?: FrameWhy;
}

/** 纯色帧最多往下跳几档（跳满就认了，否则一部片能耗十几秒） */
const MAX_SKIP = 3;

/**
 * 片花 / 预告的关键词。`kind:'dir'` 的目标要在目录里挑一个视频，而这类文件常与正片同目录
 * 且**文件名排序靠前**（`sample` 的 s 比多数数字小）—— 不剔除就会把片花当封面。
 * 不用"取最大的那个"：`readdir` 只给名字，比大小要 n 次 `stat`，那就是 n 次寻道。
 */
const SAMPLE_RE = /(?:^|[^a-z])(sample|trailer|preview|teaser|cm)(?:[^a-z]|$)|特典|予告|预告/i;

const frameDirOf = (dataDir: string, serial: string) => path.join(dataDir, 'frames', serial);

/** 帧缓存文件名。`nonce` 每次变 ⇒ 预览 URL 跟着变 ⇒ 换一帧不会被浏览器缓存顶住 */
export function frameFileName(k16: string, attempt: number, pct: number, skipped: number, nonce: string): string {
    return `${k16}_a${attempt}_p${pct}_s${skipped}_n${nonce}.jpg`;
}

/** 帧缓存绝对路径。文件名必须已过白名单（路由层负责），这里只拼接 */
export function framePath(dataDir: string, serial: string, file: string): string {
    return path.join(frameDirOf(dataDir, serial), file);
}

/** 从文件名解析元数据。不符合命名的一律 null（半截文件 / 用户手放的东西） */
const FRAME_NAME_RE = /^([0-9a-f]{16})_a(\d{1,2})_p(\d{1,3})_s(\d)_n([0-9a-z]+)\.jpg$/;

function parseFrameName(file: string): { k16: string; attempt: number; pct: number; skipped: number } | null {
    const m = FRAME_NAME_RE.exec(file);
    if (!m) return null;
    return { k16: m[1], attempt: Number(m[2]), pct: Number(m[3]), skipped: Number(m[4]) };
}

/** 盘内相对路径拼接 / 取父目录（本地实现，避免与 server/index.ts 成环） */
const joinRel = (parent: string, name: string) => (parent ? `${parent}/${name}` : name);

/** 卡 → 它的目标们（一张多分卷卡有多个 writeRel） */
function groupByCard(targets: ScanTarget[]): Map<string, ScanTarget[]> {
    const out = new Map<string, ScanTarget[]>();
    for (const t of targets) {
        const key = cardKeyOf({ kind: t.kind, writeRel: t.writeRel, query: t.query });
        const list = out.get(key);
        if (list) {
            if (!list.some(x => x.writeRel === t.writeRel)) list.push(t);
        } else out.set(key, [t]);
    }
    return out;
}

/** 文件名自然序比较（`TST-2` 排在 `TST-10` 前面） */
const natural = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

/**
 * 挑一个能抽帧的视频：`kind:'file'` 用 `srcRel`（扫描时已给），`kind:'dir'` 现场 readdir 找。
 *
 * `kind:'dir'` 会**读一次盘**（readdir，不 stat），这是 spec §八 明列的那一次；
 * 盘离线时根本走不到这里（路由层已挡）。
 */
async function pickVideo(root: string, absOf: (rel: string) => string, t: ScanTarget): Promise<{ rel: string; abs: string } | null> {
    if (t.kind === 'file') {
        if (!t.srcRel) return null;
        return { rel: t.srcRel, abs: absOf(t.srcRel) };
    }
    // 目录形态：目录自己就是影片（scan 的 addFolderFace 只在"目录名能认出番号"时产出）
    const dirRel = t.writeRel.slice(0, t.writeRel.lastIndexOf('/'));
    let names: string[];
    try {
        names = await fsasync.readdir(absOf(dirRel));
    } catch {
        return null;
    }
    const videos = names
        .filter(n => !SAMPLE_RE.test(n) && isVideo(n.slice(n.lastIndexOf('.') + 1)))
        .sort(natural);
    if (!videos.length) return null;
    const rel = joinRel(dirRel, videos[0]);
    return { rel, abs: absOf(rel) };
}

/** 把 JPEG 缩到 64×64 取位图，算最大同色占比。解不开返回 1（当作废帧，宁可往后跳一档） */
function flatnessOf(jpg: Buffer): number {
    const img = nativeImage.createFromBuffer(jpg);
    if (img.isEmpty()) return 1;
    const small = img.resize({ width: FLAT_SAMPLE, height: FLAT_SAMPLE });
    const { width, height } = small.getSize();
    return flatRatio(small.toBitmap(), width, height);
}

/**
 * 抽一张能用的帧：从 `start` 档往后，遇到纯色就再往后（最多跳 MAX_SKIP 档）。
 * 返回 null = 这一部抽不出来（调用方记 `no-frame`，不写半张图）。
 */
async function extractCard(
    videoAbs: string,
    start: number,
): Promise<{ jpg: Buffer; attempt: number; pct: number; skipped: number } | null> {
    let attempt = start;
    let skipped = 0;
    for (;;) {
        const pct = pctOf(attempt);
        const jpg = await frameJpeg(videoAbs, pct);
        if (!jpg) return null;

        const flat = flatnessOf(jpg) >= FLAT_RATIO;
        // 跳满 MAX_SKIP 档、或已经到阶梯末档 ⇒ 认了这一张（再往后也不会更好）
        const canSkip = flat && skipped < MAX_SKIP && attempt < PCT_LADDER.length - 1;
        if (!canSkip) return { jpg, attempt, pct, skipped };

        attempt += 1;
        skipped += 1;
    }
}

/**
 * 跑一次抽帧任务。**串行、一次一部** —— 机械盘上并发抽帧只会让寻道更密、整体更慢。
 */
export async function runFrameJob(
    serial: string,
    targets: ScanTarget[],
    job: Job<FrameRow>,
    dataDir: string,
): Promise<void> {
    const drive = (await getDrives(true)).find(d => d.serial === serial);
    if (!drive) {
        finishJob(job, 'error', '这块盘现在不在线，插上盘再抽帧');
        return;
    }
    const root = drive.root.endsWith('/') || drive.root.endsWith('\\') ? drive.root : `${drive.root}/`;
    const absOf = (rel: string) => path.join(root, rel.replace(/\//g, path.sep));

    const cards = groupByCard(targets);
    bumpProgress(job, { total: cards.size, processed: 0, hits: 0, misses: 0 });
    if (!cards.size) {
        finishJob(job, 'done', '没有可抽帧的目标');
        return;
    }

    const dir = frameDirOf(dataDir, serial);
    await fsasync.mkdir(dir, { recursive: true }).catch(() => { });

    let hits = 0;
    let misses = 0;

    /** 一条失败/成功的记账口：一张卡的所有 writeRel 都要各推一行，否则写盘只知道一个分卷 */
    const pushFor = (list: ScanTarget[], row: Omit<FrameRow, 'writeRel' | 'kind' | 'name' | 'query' | 'srcRel'>) => {
        for (const t of list) {
            pushRow(job, {
                ...row,
                writeRel: t.writeRel,
                kind: t.kind,
                name: t.name,
                query: t.query ?? t.name,
                srcRel: t.srcRel,
            } as FrameRow);
        }
    };

    try {
        for (const [key, list] of cards) {
            if (job.cancelled) break;
            await job.gate.wait(); // 暂停：当前这一部抽完就停
            if (job.cancelled) break;

            bumpProgress(job, { current: list[0].name });
            const k16 = key16Of(key);
            const video = await pickVideo(root, absOf, list[0]);

            if (!video) {
                misses += 1;
                pushFor(list, {
                    frame: true, frameFile: '', pct: 0, attempt: 0, skipped: 0,
                    status: 'error', why: 'no-video', coverUrl: null, hitSite: null,
                    title: null, actresses: [], message: '这个目录里没有能抽帧的视频',
                });
            } else {
                // 上一次抽到第几档，由**已存在的帧文件名**告知（无需前端传状态）：
                // 换一帧 = 往后一档；上次抽失败（没有帧文件）= 从 0 重来。
                const prev = await fsasync.readdir(dir).catch(() => [] as string[]);
                const start = Math.min(
                    prev.map(parseFrameName).filter(f => f?.k16 === k16).reduce((m, f) => Math.max(m, f!.attempt + 1), 0),
                    PCT_LADDER.length - 1,
                );

                const got = await extractCard(video.abs, start);
                // 重抽失败但**上一帧还在** ⇒ 继续用上一帧，别把已经拿到的好封面弄丢了
                const prevFile = prev.find(f => parseFrameName(f)?.k16 === k16);
                const prevMeta = prevFile ? parseFrameName(prevFile) : null;

                if (!got && prevFile && prevMeta) {
                    misses += 1;
                    pushFor(list, {
                        frame: true, frameFile: prevFile, pct: prevMeta.pct,
                        attempt: prevMeta.attempt, skipped: prevMeta.skipped,
                        status: 'ok', coverUrl: null, hitSite: null, title: null, actresses: [],
                        message: '重抽失败，仍用上一帧',
                    });
                } else if (!got) {
                    misses += 1;
                    pushFor(list, {
                        frame: true, frameFile: '', pct: 0, attempt: 0, skipped: 0,
                        status: 'error', why: 'no-frame', coverUrl: null, hitSite: null,
                        title: null, actresses: [], message: '抽帧失败（视频读不出时长或取不到画面）',
                    });
                } else {
                    const nonce = Date.now().toString(36);
                    const file = frameFileName(k16, got.attempt, got.pct, got.skipped, nonce);
                    const tmp = path.join(dir, `${file}.tmp`);
                    await fsasync.writeFile(tmp, got.jpg);
                    await fsasync.rename(tmp, path.join(dir, file)); // 原子落位：读不到写一半的图
                    // 同一条逻辑对象的替换：同卡旧帧删掉，只留最新这一张
                    for (const old of prev) {
                        if (parseFrameName(old)?.k16 === k16 && old !== file) {
                            fsasync.unlink(path.join(dir, old)).catch(() => { });
                        }
                    }
                    hits += 1;
                    pushFor(list, {
                        frame: true, frameFile: file, pct: got.pct, attempt: got.attempt, skipped: got.skipped,
                        status: 'ok', coverUrl: null, hitSite: null, title: null, actresses: [], message: '',
                    });
                }
            }

            bumpProgress(job, { processed: (job.progress.processed ?? 0) + 1, hits, misses });
        }
    } catch (e) {
        finishJob(job, 'error', e instanceof Error ? e.message : String(e));
        return;
    }

    if (job.cancelled) {
        finishJob(job, 'cancelled', `已终止，抽到 ${hits} 部`);
        return;
    }
    finishJob(job, 'done', `抽帧结束：${hits} 部有封面，${misses} 部抽不出`);
}

/**
 * 回填：这块盘上**已经抽过的**帧，按 writeRel 列出来（打开/重扫面板后接着用）。
 *
 * 只 readdir + 算卡键，**零读盘**（移动盘一个字节都不碰）。卡键可复算 ⇒ 不需要 sidecar。
 *
 * 返回里带 `kind/query/srcRel/name`：写盘时这些帧可能**不在任何 job 里**
 * （关面板重开后 job 已经回收），`/assistant/apply` 要能把它们补成完整的行喂给 `buildGroups`。
 */
export interface FrameIndexEntry extends GrabRow {
    frame: true;
    frameFile: string;
    pct: number;
    attempt: number;
    skipped: number;
}

export async function readFrameIndex(
    dataDir: string,
    serial: string,
    targets: ScanTarget[],
): Promise<FrameIndexEntry[]> {
    const files = await fsasync.readdir(frameDirOf(dataDir, serial)).catch(() => [] as string[]);
    if (!files.length) return [];

    // 卡键 → 该卡最新的帧文件（同卡理论上只有一个，多出来的是上次没删干净的）
    const latest = new Map<string, { file: string; pct: number; attempt: number; skipped: number }>();
    for (const f of files) {
        const p = parseFrameName(f);
        if (!p) continue;
        const cur = latest.get(p.k16);
        if (!cur || p.attempt >= cur.attempt) {
            latest.set(p.k16, { file: f, pct: p.pct, attempt: p.attempt, skipped: p.skipped });
        }
    }
    if (!latest.size) return [];

    const out: FrameIndexEntry[] = [];
    for (const [key, list] of groupByCard(targets)) {
        const hit = latest.get(key16Of(key));
        if (!hit) continue;
        for (const t of list) {
            out.push({
                writeRel: t.writeRel, query: t.query ?? t.name, hitSite: null, coverUrl: null,
                title: null, actresses: [], status: 'ok', message: '',
                kind: t.kind, name: t.name, srcRel: t.srcRel,
                frame: true, frameFile: hit.file, pct: hit.pct, attempt: hit.attempt, skipped: hit.skipped,
            });
        }
    }
    return out;
}

/**
 * 无引用的帧至少要多"老"才列出来。
 *
 * 为什么需要这个门槛（2026-11-10 复核发现）：引用判据只有一条 —— "这张卡还缺不缺封面"。
 * 而「换封面」的卡**本来就有封面**（用户是要换掉），它永远不会出现在"仍缺封面"集合里，
 * 于是刚抽出来的那张帧会被当场判成垃圾。24 小时是给它留的工作窗口：
 * 换封面是当场就写完的动作，超过一天还没写的基本就是忘了。
 */
const ORPHAN_MIN_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * 帧缓存盘点用的辅助：把这块盘"仍缺封面"的卡键集合算出来（纯缓存，零读盘）。
 * 集合外的帧 = 没人引用了（作品已删/改名/换盘/后来补上了正式封面）。
 *
 * ⚠️ `maxDocs: Infinity` 不是可选项 —— 默认 3000 截断会让超出上限的卡"消失"，
 *    它们的帧被判成孤儿，用户点清理就真删了还能用的东西。
 */
export async function liveKeysOf(serial: string): Promise<Map<string, ScanTarget[]>> {
    const res = await scanMissingCovers(serial, '', { maxDocs: Infinity });
    return groupByCard(res.targets);
}

/** 帧缓存里的一项（设置页列表用） */
export interface FrameCacheItem {
    file: string;
    serial: string;
    bytes: number;
    mtime: number;
    pct: number;
    attempt: number;
    /** `true` = 系统判定为"没有引用"，可以清 */
    orphan: boolean;
}

export interface FrameInventory {
    /** 全部帧（张数 / 字节），用来显示区块头 */
    total: number;
    bytes: number;
    /** 其中被判为无引用的（只列这些给用户看） */
    orphans: FrameCacheItem[];
    /** 仍被引用的张数（不列，只用于"共 N 张 / M 张在用"这种说明） */
    live: number;
    /** 因为盘不在线而没核实到的张数（级二跳过的那批） */
    offlineSkipped: number;
}

/** 帧目录下的盘序列号（一个子目录一块盘）。没有帧就返回空数组 */
async function serialsWithFrames(dataDir: string): Promise<string[]> {
    const entries = await fsasync.readdir(path.join(dataDir, 'frames'), { withFileTypes: true }).catch(() => []);
    return entries.filter(e => e.isDirectory()).map(e => e.name);
}

/**
 * 盘点（级一，**零读盘**）：只读系统盘 + 缓存记录，移动硬盘一个字节都不碰。
 *
 * 判据只有一条：帧的卡键还在不在"仍缺封面"的集合里。已经补上正式封面的卡不在集合里，
 * 它的抽帧帧自然判废 —— 这就是主人说的"有封面且有抽帧封面，指定是要废弃的"。
 *
 * @param verify 级二：对仍判"在用"的项，按盘上真实路径 stat 一次。**只 stat 有帧的那几项**，
 *   不是扫盘；盘离线就整批跳过并计入 `offlineSkipped`。
 */
export async function inventoryFrames(dataDir: string, verify = false): Promise<FrameInventory> {
    const serials = await serialsWithFrames(dataDir);

    // 只有**有缓存记录**的盘才敢判"没人要了"：缓存库被清空/重建时，
    // 所有盘都会"没有任何卡"，那种情况下把帧全判成孤儿就是一场灾难。
    const known = new Set((await loadMeta()).map(m => m.serial));

    const out: FrameInventory = { total: 0, bytes: 0, orphans: [], live: 0, offlineSkipped: 0 };
    const drives = verify ? await getDrives(true) : [];

    for (const serial of serials) {
        const dir = frameDirOf(dataDir, serial);
        const files = await fsasync.readdir(dir, { withFileTypes: true }).catch(() => []);
        const jpgs = files.filter(e => e.isFile() && FRAME_NAME_RE.test(e.name)).map(e => e.name);
        if (!jpgs.length) continue;

        const sizes = new Map<string, { bytes: number; mtime: number }>();
        for (const f of jpgs) {
            const st = await fsasync.stat(path.join(dir, f)).catch(() => null);
            if (st) sizes.set(f, { bytes: st.size, mtime: st.mtimeMs });
        }

        const canJudge = known.has(serial);
        const liveByKey16 = new Map<string, ScanTarget[]>();
        if (canJudge) {
            for (const [k, v] of await liveKeysOf(serial)) liveByKey16.set(key16Of(k), v);
        }
        const drive = drives.find(d => d.serial === serial);
        const root = drive ? (drive.root.endsWith('/') || drive.root.endsWith('\\') ? drive.root : `${drive.root}/`) : '';

        for (const file of jpgs) {
            const meta = parseFrameName(file)!;
            const size = sizes.get(file);
            out.total += 1;
            out.bytes += size?.bytes ?? 0;

            const targets = liveByKey16.get(meta.k16);
            // 判不了的盘（没有缓存记录）一律算"在用"：宁可不列，也不能让用户误删
            if (!canJudge || targets?.length) {
                // 级二：盘在线才核实"缓存说的还在"是不是真的还在
                if (verify && targets?.length && drive && root) {
                    const t = targets[0];
                    const rel = t.kind === 'file' ? t.srcRel : t.writeRel.slice(0, t.writeRel.lastIndexOf('/'));
                    if (rel) {
                        const alive = await fsasync.stat(path.join(root, rel.replace(/\//g, path.sep)))
                            .then(() => true, () => false);
                        if (!alive) {
                            out.orphans.push({ file, serial, bytes: size?.bytes ?? 0, mtime: size?.mtime ?? 0, pct: meta.pct, attempt: meta.attempt, orphan: true });
                            continue;
                        }
                    }
                } else if (verify && targets?.length && !drive) {
                    out.offlineSkipped += 1;
                }
                out.live += 1;
                continue;
            }

            // 卡已经不需要这张帧了 —— 但刚抽出来的那张先留着（见 ORPHAN_MIN_AGE_MS）
            if ((size?.mtime ?? 0) > Date.now() - ORPHAN_MIN_AGE_MS) {
                out.live += 1;
                continue;
            }
            out.orphans.push({
                file, serial, bytes: size?.bytes ?? 0, mtime: size?.mtime ?? 0,
                pct: meta.pct, attempt: meta.attempt, orphan: true,
            });
        }
    }

    return out;
}

/**
 * 清掉无引用的帧。**不信任前端传的文件名**：重算一遍盘点，只删确实落在孤儿集合里的。
 * 重算是零读盘的一遍扫描，不引入"清理列表过期"的窗口。
 */
export async function purgeFrames(
    dataDir: string,
    files: string[],
): Promise<{ removed: number; freed: number; skipped: number }> {
    const want = new Set(files.filter(f => FRAME_NAME_RE.test(f)));
    if (!want.size) return { removed: 0, freed: 0, skipped: 0 };

    const inv = await inventoryFrames(dataDir, false);
    let removed = 0;
    let freed = 0;
    for (const item of inv.orphans) {
        if (!want.has(item.file)) continue;
        try {
            await fsasync.unlink(framePath(dataDir, item.serial, item.file));
            removed += 1;
            freed += item.bytes;
        } catch {
            // 删不掉（被占用 / 已不在）—— 最后按 want.size - removed 统计算作 skipped，不打断整批
        }
    }
    // 想删但已经不在孤儿集合里的（期间被重抽了 / 盘插回来了）一个都不动
    return { removed, freed, skipped: want.size - removed };
}
