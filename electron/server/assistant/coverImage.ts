/**
 * 管理助手 · 「什么才算一张可用封面」的唯一判据
 * ===========================================================================
 * 抽取、预览、写盘三处原先各信各的：抽到一个 `f.cover` 字符串就算命中，
 * 预览把这个字符串塞进 `<img src>`，写盘拿它去下载。**没有任何一处验证过它真是一张图**
 * ⇒ 空链接 / 占位图 / 404 一路绿灯：界面碎图、报"已抓到"、点了写入还能把视频
 * 搬进新建的空文件夹，产出一部"没有封面的作品"。
 *
 * 这里把判据收成一句话：**能下载、且能解码成 JPEG 的字节，才叫封面**。
 * 三处（grab / preview / apply）都只调 `getVerifiedCover()` 这一个函数。
 *
 * ⚠️ 已验证的 JPEG 字节按 URL 缓存在进程内（`coverBytes`）：
 *    抓取时验过一次 ⇒ 预览与写盘直接复用**同一份字节**，既不重复出网，
 *    也保证"预览里看到的那张"就是"写进盘的那张"。缓存没命中（重启 / 淘汰）
 *    时会自动重新下载验证，所以它不是正确性前提，只是省一次请求。
 */
import * as fsasync from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { net, nativeImage, session } from 'electron';
import { transcodeImage, COVER_JPEG_QUALITY } from '../../utils/thumbnail';
import { CappedPreviewCache } from './previewCache';
import { CancelledError, hostOf } from './queue';

/** 写入 JPEG 的质量。封面本来就是有损的再分发，90 是体积与观感的稳态点。定义在 `thumbnail.ts`（唯一定义处，抽帧与下载共用一档） */

/** 已验证字节的预算（与预览缓存分开：那边混放头像原图，语义不同，不能共用一个 Map） */
const verifiedBytes = new CappedPreviewCache(32 * 1024 * 1024, 200);

/**
 * URL 形态闸门。`data:` / `blob:` / 相对地址 / 带空白的 CSS 碎片一律拒绝 ——
 * 它们过不了本项目的下载通道（`net.request`），留着只会变成"命中了却显示不出来"。
 * ⚠️ 抽取脚本（rules.ts）里那个 `looksUrl` 只管"不像一整串 CSS"，管不了能不能下载，
 *    两处判据不同、不要互删。
 */
export function isUsableCoverUrl(url: unknown): url is string {
    if (typeof url !== 'string' || !url.trim()) return false;
    let u: URL;
    try { u = new URL(url); } catch { return false; }
    return (u.protocol === 'http:' || u.protocol === 'https:') && !!u.host;
}

export interface CoverCheck {
    ok: boolean;
    /** 已解码并转成真 JPEG 的字节；ok=false 时恒为 null */
    jpg: Buffer | null;
    /** 这条 URL 本身坏了（形态错 / HTTP 非 200 / 解不出图）⇒ 该给命中缓存立墓碑 */
    urlBad: boolean;
    why: string;
}

/** 限速方式由调用方给：grab 用 runPaced、apply 用 enqueue、preview 直接发 */
export type CoverGate = <T>(host: string, task: () => Promise<T>, signal?: AbortSignal) => Promise<T>;
const direct: CoverGate = <T>(_host: string, task: () => Promise<T>): Promise<T> => task();

/**
 * 取一张**真的能用**的封面。所有消费者只认这个返回值。
 *
 * 顺序即判据：形态 → 缓存 → 下载 → 非空 → 解码转 JPEG。
 * 任何一环不过就 `ok:false`，绝不返回"半张图"。
 */
export async function getVerifiedCover(
    url: string,
    signal: AbortSignal,
    gate: CoverGate = direct,
): Promise<CoverCheck> {
    if (!isUsableCoverUrl(url)) {
        return { ok: false, jpg: null, urlBad: true, why: '封面链接不合法（不是 http/https 绝对地址）' };
    }
    const cached = verifiedBytes.get(url);
    if (cached?.buf?.length) return { ok: true, jpg: cached.buf, urlBad: false, why: '' };

    let raw: Buffer;
    let status: number;
    try {
        const r = await gate(hostOf(url), () => download(url, signal), signal);
        status = r.status;
        raw = r.buf;
    } catch (e) {
        // 取消是控制流，不能被记成"这条抓失败了"
        if (signal.aborted || e instanceof CancelledError) throw new CancelledError();
        // 网络错误不算 URL 坏（可能只是暂时断网）⇒ 不立墓碑
        return { ok: false, jpg: null, urlBad: false, why: e instanceof Error ? e.message : String(e) };
    }
    if (status !== 200 || !raw.length) {
        return { ok: false, jpg: null, urlBad: true, why: `下载失败（HTTP ${status} / 空内容）` };
    }
    const jpg = await toJpeg(raw);
    if (!jpg) return { ok: false, jpg: null, urlBad: true, why: '图片解不出来（可能不是图）' };

    verifiedBytes.set(url, { buf: jpg, type: 'image/jpeg' });
    return { ok: true, jpg, urlBad: false, why: '' };
}

/**
 * 经 Chromium 网络栈下载一张图。
 *
 * 为什么不用 `net.fetch`：Electron 44 的 RequestInit 类型只放行了
 * `bypassCustomProtocolHandlers`，`session` 选项不在类型里；而 `net.request`
 * 的 options 从类型到运行时都明确支持 `session` + `useSessionCookies` ——
 * 用它才能把「和抓取页面同一个 session（CF cookie 自动带上）」写成类型保证。
 */
export function download(
    url: string,
    signal: AbortSignal,
): Promise<{ status: number; buf: Buffer; type: string | null }> {
    return new Promise((resolve, reject) => {
        // ⚠️ 这两行是**取消/超时不挂死**的保证：Electron 的 ClientRequest 被 abort 之后
        //    不保证再发 'error' 或 'response' ⇒ 只靠那两个事件，Promise 会永远悬着，
        //    抓取 worker / 预览请求就卡死在那里。这里自己把 Promise 收掉。
        if (signal.aborted) { reject(new CancelledError()); return; }
        const req = net.request({
            url,
            session: session.fromPartition('persist:assistant'),
            useSessionCookies: true,
        });
        if (/javbus|buscdn|\/pics\/|dmm/i.test(url)) {
            req.setHeader('Referer', 'https://www.javbus.com/');
        }
        req.setHeader('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
        let settled = false;
        const done = (fn: () => void) => {
            if (settled) return;
            settled = true;
            fn();
        };

        signal.addEventListener('abort', () => {
            done(() => reject(new CancelledError()));
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
 * 任意图片字节 → 真 JPEG。
 *   JPEG 本尊 → 原样返回（零损耗零转码）；
 *   PNG / 其它 nativeImage 认的 → 解码后重编；
 *   解不开（典型：改后缀的 WebP）→ ffmpeg 兜底转 PNG 再编，中转文件在系统盘临时目录。
 * 都失败返回 null —— 调用方把这一行记成失败，不写半截文件。
 */
export async function toJpeg(buf: Buffer): Promise<Buffer | null> {
    if (isJpeg(buf)) return buf;

    const img = nativeImage.createFromBuffer(buf);
    if (!img.isEmpty()) return img.toJPEG(COVER_JPEG_QUALITY);

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
