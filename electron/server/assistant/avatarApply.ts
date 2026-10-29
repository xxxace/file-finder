/**
 * 女优头像安全写入与缓存失效
 * ===========================================================================
 * 强约束：
 * 1. 在线盘闸门：如果盘处于离线状态（未在 getDrives() 中找到挂载路径），坚决拒绝写盘与缓存操作。
 * 2. 旧图备份：如果目标目录已有 avatar.jpg，先备份到 ~/.file-finder/backups/<serial>/<relDir>/avatar.jpg
 * 3. 限制并发下载与写入（3 并发）
 * 4. 转 JPEG 后原子写入：.avatar-<pid>-<time>.tmp -> avatar.jpg
 * 5. 缓存失效：同时失效当前目录与其父目录的 'cover' 缓存，以便让目录在网格立即长脸
 */
import * as fsasync from 'node:fs/promises';
import path from 'node:path';
import { getDrives } from '../../utils/driveIdentity';
import { removeCache } from '../nedb';
import { toJpeg } from './apply';

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
 * 下载单个图片并转成标准 JPEG Buffer
 */
async function fetchAndTranscode(url: string): Promise<Buffer | null> {
    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 12000);
        const res = await fetch(url, { signal: controller.signal });
        clearTimeout(timer);

        if (!res.ok) {
            console.warn(`[avatarApply] 下载失败 HTTP ${res.status}: ${url}`);
            return null;
        }

        const arrayBuf = await res.arrayBuffer();
        const rawBuf = Buffer.from(arrayBuf);
        return await toJpeg(rawBuf);
    } catch (e) {
        console.error(`[avatarApply] 网络请求失败 (${url}):`, e);
        return null;
    }
}

/**
 * 批量应用女优头像回收：
 * 强制检查盘在线状态，受控并发下载并原子写盘，最后失效对应层级缓存。
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

    // ── ① 在线盘强校验闸门 ──
    const drives = await getDrives();
    const drive = drives.find(d => d.serial.toUpperCase() === serial.toUpperCase());

    if (!drive || !drive.root) {
        const errMessage = `目标磁盘 (${serial}) 处于离线状态，禁止执行写盘与缓存操作`;
        for (const it of items) {
            result.logs.push({ relDir: it.relDir, status: 'error', message: errMessage });
        }
        result.failed = items.length;
        return result;
    }

    const diskRoot = drive.root; // e.g. "H:/"
    const concurrency = 3;

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
                        message: '头像下载或图片转码失败',
                    });
                    return;
                }

                const saved = await saveAvatarFile(serial, item.relDir, targetDir, jpegBuf, dataDir);
                if (saved) {
                    result.succeeded += 1;
                    result.logs.push({ relDir: item.relDir, status: 'ok' });

                    // ── ③ 缓存失效（同时失效女优目录本身及父层目录） ──
                    removeCache(serial, item.relDir, 'cover').catch(() => {});
                    removeCache(serial, dirOf(item.relDir), 'cover').catch(() => {});
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

    return result;
}
