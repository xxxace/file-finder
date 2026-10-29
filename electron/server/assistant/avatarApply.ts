/**
 * 女优头像安全写入与缓存失效
 * ===========================================================================
 * 强约束：
 * 1. 在线盘闸门：如果盘处于离线状态（未在 getDrives() 中找到挂载路径），坚决拒绝写盘与缓存操作（抛错返回 400）。
 * 2. 旧图备份：如果目标目录已有 avatar.jpg，先备份到 ~/.file-finder/backups/<serial>/<relDir>/avatar.jpg
 * 3. 限制并发下载与写入（3 并发）
 * 4. 多 CDN 镜像自动回退：默认 fastly 失败则自动重试 cdn.jsdelivr.net / raw.githubusercontent.com
 * 5. 转 JPEG 后原子写入：.avatar-<pid>-<time>.tmp -> avatar.jpg
 * 6. 缓存失效：同时失效当前目录与其父目录的 'cover' 缓存，并等待 NeDB 清除完成后再返回，避免刷新竞态
 */
import * as fsasync from 'node:fs/promises';
import path from 'node:path';
import { getDrives } from '../../utils/driveIdentity';
import { removeCache } from '../nedb';
import { toJpeg } from './apply';
import { GFRIENDS_MIRRORS } from './gfriends';

export interface AvatarApplyItem {
    relDir: string;
    avatarUrl: string;
}

export interface AvatarApplyLog {
    relDir: string;
    status: 'ok' | 'error';
    message?: string;
}

export interface AvatarApplyResult {
    total: number;
    succeeded: number;
    failed: number;
    logs: AvatarApplyLog[];
}

function dirOf(rel: string): string {
    const i = rel.lastIndexOf('/');
    return i === -1 ? '' : rel.slice(0, i);
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
        const backupDir = path.join(dataDir, 'backups', serial, relDir);
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

/**
 * 若给定的 URL 来自 Gfriends，提取出相对路径并生成各个可用镜像 URL 列表，用于容灾回退。
 */
function getCandidateUrls(originalUrl: string): string[] {
    for (const mirror of GFRIENDS_MIRRORS) {
        if (originalUrl.startsWith(mirror)) {
            const rel = originalUrl.slice(mirror.length);
            return GFRIENDS_MIRRORS.map(m => `${m}${rel}`);
        }
    }
    return [originalUrl];
}

/**
 * 下载单个图片并转成标准 JPEG Buffer，支持多 CDN 镜像自动重试回退。
 */
async function fetchAndTranscode(url: string): Promise<Buffer | null> {
    const candidates = getCandidateUrls(url);

    for (const targetUrl of candidates) {
        try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 6000);
            const res = await fetch(targetUrl, { signal: controller.signal });
            clearTimeout(timer);

            if (!res.ok) {
                continue;
            }

            const arrayBuf = await res.arrayBuffer();
            const rawBuf = Buffer.from(arrayBuf);
            const jpeg = await toJpeg(rawBuf);
            if (jpeg) return jpeg;
        } catch {
            // 当前镜像超时或失败，自动重试下一个镜像
        }
    }

    console.warn(`[avatarApply] 尝试所有镜像后下载失败: ${url}`);
    return null;
}

/**
 * 批量应用女优头像回收：
 * 强制检查盘在线状态，受控并发下载并原子写盘，最后等待缓存失效完成。
 */
export async function applyActressAvatars(
    serial: string,
    items: AvatarApplyItem[],
    dataDir: string
): Promise<AvatarApplyResult> {
    const result: AvatarApplyResult = {
        total: items.length,
        succeeded: 0,
        failed: 0,
        logs: [],
    };

    if (!items.length) {
        return result;
    }

    // ── ① 在线盘强校验闸门：离线盘坚决抛错拒绝 ──
    let drives = await getDrives();
    let drive = drives.find(d => d.serial.toUpperCase() === serial.toUpperCase());
    if (!drive || !drive.root) {
        drives = await getDrives(true);
        drive = drives.find(d => d.serial.toUpperCase() === serial.toUpperCase());
    }

    if (!drive || !drive.root) {
        throw new Error(`目标磁盘 (${serial}) 处于离线状态，禁止执行写盘与缓存操作`);
    }

    const diskRoot = drive.root; // e.g. "H:/"
    const concurrency = 3;
    const cachePromises: Promise<number>[] = [];

    // ── ② 受控并发处理 ──
    for (let i = 0; i < items.length; i += concurrency) {
        const batch = items.slice(i, i + concurrency);
        await Promise.all(
            batch.map(async (item) => {
                const targetDir = path.join(diskRoot, item.relDir);
                const jpegBuf = await fetchAndTranscode(item.avatarUrl);

                if (!jpegBuf) {
                    result.failed += 1;
                    result.logs.push({
                        relDir: item.relDir,
                        status: 'error',
                        message: '头像下载或图片转码失败（已尝试多镜像回退）',
                    });
                    return;
                }

                const saved = await saveAvatarFile(serial, item.relDir, targetDir, jpegBuf, dataDir);
                if (saved) {
                    result.succeeded += 1;
                    result.logs.push({ relDir: item.relDir, status: 'ok' });

                    // ── ③ 缓存失效（同时失效女优目录本身及父层目录） ──
                    cachePromises.push(removeCache(serial, item.relDir, 'cover'));
                    cachePromises.push(removeCache(serial, dirOf(item.relDir), 'cover'));
                } else {
                    result.failed += 1;
                    result.logs.push({
                        relDir: item.relDir,
                        status: 'error',
                        message: '原子写盘失败',
                    });
                }
            })
        );
    }

    // ── ④ 等待所有缓存清除完成，杜绝前端刷新竞态 ──
    await Promise.all(cachePromises);

    return result;
}
