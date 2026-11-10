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
const baseOf = (rel: string) => rel.slice(rel.lastIndexOf('/') + 1);

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
                if (!got) {
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
 */
export async function readFrameIndex(
    dataDir: string,
    serial: string,
    targets: ScanTarget[],
): Promise<{ writeRel: string; frameFile: string; pct: number; attempt: number; skipped: number }[]> {
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

    const out: { writeRel: string; frameFile: string; pct: number; attempt: number; skipped: number }[] = [];
    for (const [key, list] of groupByCard(targets)) {
        const hit = latest.get(key16Of(key));
        if (!hit) continue;
        for (const t of list) out.push({ writeRel: t.writeRel, frameFile: hit.file, pct: hit.pct, attempt: hit.attempt, skipped: hit.skipped });
    }
    return out;
}

/**
 * 帧缓存盘点用的辅助：把这块盘"仍缺封面"的卡键集合算出来（纯缓存，零读盘）。
 * 集合外的帧 = 没人引用了（作品已删/改名/换盘/后来补上了正式封面）。
 */
export async function liveKeysOf(serial: string): Promise<Map<string, ScanTarget[]>> {
    const res = await scanMissingCovers(serial, '');
    return groupByCard(res.targets);
}

/** 写盘成功后回收那一张帧（已落盘，不再需要） */
export async function dropFrames(dataDir: string, serial: string, frameFiles: string[]): Promise<void> {
    const dir = frameDirOf(dataDir, serial);
    for (const f of frameFiles) {
        if (!f) continue;
        await fsasync.unlink(path.join(dir, baseOf(f))).catch(() => { });
    }
}
