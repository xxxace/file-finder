/**
 * 女优头像安全写入（任务驱动）
 * ===========================================================================
 * 2026-11-08 从「一次性 POST」改成 job：调用方起任务后立刻拿到 jobId，
 * 进度/暂停/终止全部走既有的 `/assistant/jobs` 通道 —— 与补封面共用同一套语义。
 *
 * 强约束（承接原实现，一条没放松）：
 * 1. 在线盘闸门：盘离线 ⇒ 整批直接失败，不写盘、不动缓存
 * 2. 旧图备份：目标目录已有 avatar.jpg ⇒ 先备份到数据目录
 * 3. 8 并发下载/写入；**暂停 = 不再取新条，在飞的跑完**
 * 4. 多 CDN 镜像自动回退
 * 5. 转 JPEG 后原子写入：`.avatar-<pid>-<time>.tmp -> avatar.jpg`
 * 6. 收尾统一失效缓存（目录 + 父目录），避免界面停在旧脸
 */
import * as fsasync from 'node:fs/promises';
import path from 'node:path';
import { getDrives } from '../../utils/driveIdentity';
import { removeCache } from '../nedb';
import type { OpenMode } from '../nedb';
import { queueCacheWrite } from '../index';
import { bumpProgress, finishJob, pushRow } from './jobs';
import type { Job } from './jobs';
import { toJpeg, download } from './apply';
import { GFRIENDS_MIRRORS } from './gfriends';

export interface AvatarApplyItem {
    relDir: string;
    avatarUrl: string;
}

/** 一条写入结果。`relDir` 是前端把结果贴回对应行的唯一键 */
export interface AvatarApplyRow {
    relDir: string;
    ok: boolean;
    message: string;
}

export interface AvatarApplyDeps {
    dataDir: string;
    previewCache?: Map<string, { buf: Buffer; type: string | null }>;
    scanAndCache?: (serial: string, drive: string, relPath: string, mode: OpenMode) => Promise<unknown>;
}

/** 并发度：这一批是"下载 + 一次小写入"，瓶颈在网络，8 是实测比较稳的值 */
const CONCURRENCY = 8;

function dirOf(rel: string): string {
    const i = rel.lastIndexOf('/');
    return i === -1 ? '' : rel.slice(0, i);
}

/** 清掉路径里的绝对前缀，只留盘内相对路径（防跨目录写入） */
function cleanRelOf(rel: string): string {
    return path.normalize(rel).replace(/^([\\/]+)/, '').replace(/^[A-Za-z]:[\\/]+/, '');
}

/**
 * 在线盘闸门 → 返回盘根（如 `H:/`）。
 * 离线直接抛：调用方把整批判失败，而不是一条条去试。
 */
async function requireOnlineRoot(serial: string): Promise<string> {
    let drives = await getDrives();
    let drive = drives.find(d => d.serial.toUpperCase() === serial.toUpperCase());
    if (!drive || !drive.root) {
        drives = await getDrives(true);
        drive = drives.find(d => d.serial.toUpperCase() === serial.toUpperCase());
    }
    if (!drive || !drive.root) {
        throw new Error(`目标磁盘 (${serial}) 处于离线状态，禁止执行写盘与缓存操作`);
    }
    return drive.root;
}

/**
 * 将头像图片原子写入目标目录，若已存在旧头像则先备份。
 */
export async function saveAvatarFile(
    serial: string,
    relDir: string,
    targetDir: string,
    jpegBuffer: Buffer,
    dataDir: string
): Promise<boolean> {
    const targetFile = path.join(targetDir, 'avatar.jpg');

    // 1. 若旧头像存在，先备份至数据目录
    try {
        await fsasync.access(targetFile);
        const backupDir = path.join(dataDir, 'backups', serial, cleanRelOf(relDir));
        await fsasync.mkdir(backupDir, { recursive: true });
        await fsasync.copyFile(targetFile, path.join(backupDir, 'avatar.jpg'));
    } catch {
        // 旧文件不存在，无需备份
    }

    // 2. 临时文件原子写入
    const tmp = path.join(targetDir, `.avatar-${process.pid}-${Date.now()}.tmp`);
    try {
        await fsasync.mkdir(targetDir, { recursive: true });
        await fsasync.writeFile(tmp, jpegBuffer);
        await fsasync.rename(tmp, targetFile);
        return true;
    } catch (e) {
        console.error(`[avatarApply] 写入头像失败 (${targetFile}):`, e);
        return false;
    } finally {
        fsasync.unlink(tmp).catch(() => {});
    }
}

/** 若 URL 来自 Gfriends，生成各镜像的等价 URL 用于容灾回退 */
function getCandidateUrls(originalUrl: string): string[] {
    for (const mirror of GFRIENDS_MIRRORS) {
        if (originalUrl.startsWith(mirror)) {
            const rel = originalUrl.slice(mirror.length);
            return GFRIENDS_MIRRORS.map(m => `${m}${rel}`);
        }
    }
    return [originalUrl];
}

/** 稳健下载：优先走 Chromium net.request（原生代理/防盗链），失败兜底 Node fetch */
async function downloadBuffer(url: string, timeoutMs = 8000): Promise<Buffer | null> {
    try {
        const r = await download(url, AbortSignal.timeout(timeoutMs));
        if (r.status === 200 && r.buf && r.buf.length > 0) return r.buf;
    } catch {
        // net.request 失败或单测环境没有 electron net，回退到 Node fetch
    }

    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        const headers: Record<string, string> = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        };
        if (url.includes('javbus.com') || url.includes('dmm.co.jp')) {
            headers['Referer'] = 'https://www.javbus.com/';
        }
        const res = await fetch(url, { signal: controller.signal, headers });
        clearTimeout(timer);
        if (res.ok) return Buffer.from(await res.arrayBuffer());
    } catch {
        // fetch 失败
    }
    return null;
}

/**
 * 取图并转标准 JPEG：
 * 1. 预览内存缓存命中 ⇒ 0 网络开销（用户刚在界面看过这张图）
 * 2. 未命中 ⇒ 多镜像容灾下载，成功后回填缓存
 */
export async function fetchAndTranscode(
    url: string,
    previewCache?: Map<string, { buf: Buffer; type: string | null }>
): Promise<Buffer | null> {
    const cached = previewCache?.get(url);
    if (cached?.buf && cached.buf.length > 0) {
        const jpeg = await toJpeg(cached.buf);
        if (jpeg) return jpeg;
    }

    for (const targetUrl of getCandidateUrls(url)) {
        const rawBuf = await downloadBuffer(targetUrl, 6000);
        if (rawBuf && rawBuf.length > 0) {
            previewCache?.set(url, { buf: rawBuf, type: 'image/jpeg' });
            const jpeg = await toJpeg(rawBuf);
            if (jpeg) return jpeg;
        }
    }

    console.warn(`[avatarApply] 尝试所有镜像后下载失败: ${url}`);
    return null;
}

/**
 * 跑一批头像写入。**不返回结果** —— 结果全在 job 里（rows + progress + message），
 * 前端靠轮询读快照，这样"关掉面板再回来"还能看到同一批。
 */
export async function runAvatarApplyJob(
    serial: string,
    items: AvatarApplyItem[],
    job: Job<AvatarApplyRow>,
    deps: AvatarApplyDeps
): Promise<void> {
    const { dataDir, previewCache, scanAndCache } = deps;

    try {
        const diskRoot = await requireOnlineRoot(serial);
        const invalidateDirs = new Set<string>();
        let next = 0;
        let written = 0;

        const worker = async (): Promise<void> => {
            for (;;) {
                if (job.cancelled) return;
                /**
                 * ⚠️ **先看队列空不空，再等闸门**（同 `grab.ts` 那条注释，这里是第二处）。
                 * 反过来写：最后一条已经取走时点「暂停」，worker 会永远挂在 gate 上，
                 * `Promise.all` 不 resolve ⇒ job 永远停在 paused，前端一直显示「已暂停 n/n」。
                 */
                if (next >= items.length) return;
                // 暂停闸门：挂在这里，等 resume / cancel 放行。
                // 放在 `next++` **之前** —— 否则暂停期间条码还在往前走，
                // 继续时会跳号，进度看着像"自己跑了几条"。
                await job.gate.wait();
                if (job.cancelled) return;

                const index = next++;
                if (index >= items.length) return;
                const item = items[index];
                const rel = cleanRelOf(item.relDir);
                const targetDir = path.resolve(diskRoot, rel);

                const done = (ok: boolean, message: string, dirs: string[] = []) => {
                    if (ok) written += 1;
                    for (const d of dirs) invalidateDirs.add(d);
                    pushRow(job, { relDir: item.relDir, ok, message });
                    bumpProgress(job, {
                        processed: job.progress.processed + 1,
                        hits: written,
                        misses: job.progress.processed + 1 - written,
                        current: '',
                    });
                };

                if (!targetDir.startsWith(path.resolve(diskRoot))) {
                    done(false, '非法路径，禁止跨目录操作');
                    continue;
                }

                bumpProgress(job, { current: item.relDir });

                const jpegBuf = await fetchAndTranscode(item.avatarUrl, previewCache);
                if (!jpegBuf) {
                    done(false, '头像下载或转码失败（已尝试多镜像回退）');
                    continue;
                }

                // abort 是控制流：整批收尾，不记成"这条失败"
                if (job.cancelled) return;

                const saved = await saveAvatarFile(serial, rel, targetDir, jpegBuf, dataDir);
                if (!saved) {
                    done(false, '原子写盘失败');
                    continue;
                }
                done(true, '已写入', [rel, dirOf(rel)]);
            }
        };

        await Promise.allSettled(
            Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker),
        );

        await invalidate(serial, invalidateDirs, scanAndCache);

        const { processed, total } = job.progress;
        if (job.cancelled) {
            finishJob(job, 'cancelled',
                `已终止：写了 ${written} 个（处理到 ${processed}/${total}，剩 ${total - processed} 个没写）`);
        } else {
            finishJob(job, 'done', `写入完成：成功 ${written}，失败 ${processed - written}`);
        }
    } catch (e) {
        finishJob(job, 'error', e instanceof Error ? e.message : String(e));
    }
}

/**
 * 收尾失效。有 `scanAndCache` 就重建缓存（写盘后重扫，界面立刻是新脸）；
 * 没有就只清缓存文档。
 */
async function invalidate(
    serial: string,
    dirs: Set<string>,
    scanAndCache?: AvatarApplyDeps['scanAndCache'],
): Promise<void> {
    if (!dirs.size) return;

    if (!scanAndCache) {
        await Promise.all([...dirs].map(dir => queueCacheWrite(serial, dir, 'cover', () => removeCache(serial, dir, 'cover'))));
        return;
    }

    const drive = await getDrives().then(ds => ds.find(d => d.serial.toUpperCase() === serial.toUpperCase()));
    if (!drive?.drive) {
        // 盘在半途中掉了：退回只清缓存，别让整批白写
        await Promise.all([...dirs].map(dir => queueCacheWrite(serial, dir, 'cover', () => removeCache(serial, dir, 'cover'))));
        return;
    }

    for (const dir of dirs) {
        try {
            await scanAndCache(serial, drive.drive, dir, 'cover');
        } catch (e) {
            console.error('[avatarApply] 重建缓存失败:', dir, e);
        }
    }
}
