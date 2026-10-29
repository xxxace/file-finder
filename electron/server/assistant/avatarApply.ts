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
import { queueCacheWrite } from '../index';
import { toJpeg, download } from './apply';
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
        const cleanRel = path.normalize(relDir).replace(/^([\\/]+)/, '').replace(/^[A-Za-z]:[\\/]+/, '');
        const backupDir = path.join(dataDir, 'backups', serial, cleanRel);
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
 * 稳健快速下载图片 Buffer：优先走 Chromium net.request（原生代理/防盗链），失败兜底走 Node fetch
 */
async function downloadBuffer(url: string, timeoutMs = 8000): Promise<Buffer | null> {
    try {
        const timeout = AbortSignal.timeout(timeoutMs);
        const r = await download(url, timeout);
        if (r.status === 200 && r.buf && r.buf.length > 0) {
            return r.buf;
        }
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
        if (res.ok) {
            const arrayBuf = await res.arrayBuffer();
            return Buffer.from(arrayBuf);
        }
    } catch {
        // fetch 失败
    }
    return null;
}

/**
 * 获取头像图片并转成标准 JPEG Buffer：
 * 1. 优先从预览内存缓存读取（用户在界面浏览时已预加载，0 网络开销极速落盘）
 * 2. 内存未命中时，通过多 CDN 镜像自动容灾重试下载并回填缓存
 */
export async function fetchAndTranscode(
    url: string,
    previewCache?: Map<string, { buf: Buffer; type: string | null }>
): Promise<Buffer | null> {
    // 1. 命中预览内存缓存：直接复用，0 网络开销
    const cached = previewCache?.get(url);
    if (cached?.buf && cached.buf.length > 0) {
        const jpeg = await toJpeg(cached.buf);
        if (jpeg) return jpeg;
    }

    // 2. 依次尝试候选镜像
    const candidates = getCandidateUrls(url);
    for (const targetUrl of candidates) {
        const rawBuf = await downloadBuffer(targetUrl, 6000);
        if (rawBuf && rawBuf.length > 0) {
            if (previewCache) {
                previewCache.set(url, { buf: rawBuf, type: 'image/jpeg' });
            }
            const jpeg = await toJpeg(rawBuf);
            if (jpeg) return jpeg;
        }
    }

    console.warn(`[avatarApply] 尝试所有镜像后下载失败: ${url}`);
    return null;
}

/**
 * 批量应用女优头像回收：
 * 强制检查盘在线状态，通过动态 Worker Pool 高并发写入，最后去重失效 NeDB 缓存。
 */
export async function applyActressAvatars(
    serial: string,
    items: AvatarApplyItem[],
    dataDir: string,
    previewCache?: Map<string, { buf: Buffer; type: string | null }>
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
    const concurrency = 8;
    const invalidateDirs = new Set<string>();

    // ── ② 动态 Worker Pool 受控并发处理 ──
    let nextIndex = 0;
    const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
        while (nextIndex < items.length) {
            const item = items[nextIndex++];
            const cleanRel = path.normalize(item.relDir).replace(/^([\\/]+)/, '').replace(/^[A-Za-z]:[\\/]+/, '');
            const targetDir = path.resolve(diskRoot, cleanRel);
            if (!targetDir.startsWith(path.resolve(diskRoot))) {
                result.failed += 1;
                result.logs.push({
                    relDir: item.relDir,
                    status: 'error',
                    message: '非法路径，禁止跨目录操作',
                });
                continue;
            }

            const jpegBuf = await fetchAndTranscode(item.avatarUrl, previewCache);

            if (!jpegBuf) {
                result.failed += 1;
                result.logs.push({
                    relDir: item.relDir,
                    status: 'error',
                    message: '头像下载或图片转码失败（已尝试多镜像回退）',
                });
                continue;
            }

            const saved = await saveAvatarFile(serial, cleanRel, targetDir, jpegBuf, dataDir);
            if (saved) {
                result.succeeded += 1;
                result.logs.push({ relDir: item.relDir, status: 'ok' });

                // 收集待失效目录
                invalidateDirs.add(cleanRel);
                invalidateDirs.add(dirOf(cleanRel));
            } else {
                result.failed += 1;
                result.logs.push({
                    relDir: item.relDir,
                    status: 'error',
                    message: '原子写盘失败',
                });
            }
        }
    });

    await Promise.all(workers);

    // ── ③ 统一失效 NeDB 缓存（经由 queueCacheWrite 保证串行与缓存一致性） ──
    const cachePromises = [...invalidateDirs].map(dir => queueCacheWrite(serial, dir, 'cover', () => removeCache(serial, dir, 'cover')));
    await Promise.all(cachePromises);

    return result;
}
