import { nativeImage } from 'electron';
import type { NativeImage } from 'electron';
import ffmpeg from 'fluent-ffmpeg';
import { path as ffmpegPath } from '@ffmpeg-installer/ffmpeg';
import { path as ffprobePath } from '@ffprobe-installer/ffprobe';
import os from 'node:os';
import path from 'node:path';
import * as fsasync from 'node:fs/promises';

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

/**
 * 缩略图宽度。
 *
 * 网格是 `calc(100% / 6)` + `flexible.ts` 的 rem 方案：
 *   1200px 窗口 → 每格约 180 x 144 px
 *   1920px 窗口 → 每格约 320 x 256 px
 * 480 是 1200px 下显示宽度的 2.7 倍、1920px 下的 1.5 倍，已超过 2 倍 HiDPI 的经验值。
 * 实测原始封面中位 800x538 —— 800 缩到 480 在 180px 的格子里看不出差别。
 * 觉得不够清晰直接调大这个数，是可逆的。
 */
export const THUMB_WIDTH = 480;

/** JPEG 质量。82 在 480px 这个尺寸上肉眼无损，体积约为同尺寸 PNG 的 1/3（已实测） */
export const THUMB_QUALITY = 82;

/** 按比例缩到 THUMB_WIDTH 宽，输出 JPEG。只在原图更宽时才缩 —— 避免把小图放大糊掉 */
export function scaleToThumb(img: NativeImage): Buffer {
    const { width } = img.getSize();
    const scaled = width > THUMB_WIDTH ? img.resize({ width: THUMB_WIDTH, quality: 'good' }) : img;
    return scaled.toJPEG(THUMB_QUALITY);
}

/**
 * nativeImage 解码 + 缩放。解不开返回 null（不区分"文件不存在"和"格式不支持"）。
 *
 * 注意 createFromPath 是**同步**的：读文件 + 解码 + 缩放都在调用线程上。
 * 一张 800px JPEG 大约十几毫秒，所以调用方（makeThumb）每张之间会让出一次事件循环。
 */
function decodeImage(filepath: string): Buffer | null {
    try {
        const img = nativeImage.createFromPath(filepath);
        if (img.isEmpty()) return null;
        return scaleToThumb(img);
    } catch (e) {
        console.error('[thumbnail] 图片缩略失败:', filepath, e);
        return null;
    }
}

async function fileExists(filepath: string): Promise<boolean> {
    try {
        await fsasync.access(filepath);
        return true;
    } catch {
        return false;
    }
}

/**
 * 图片缩略图：常规格式全程在内存里完成 —— 不落盘、不写临时文件、不碰移动硬盘。
 *
 * **nativeImage 只认 PNG / JPEG，解不了 WebP。** 而这恰恰是一个真实的封面形态：
 * 实测 `D:/sample/videos/TST-PPV-1000001/TST-PPV-1000001.jpg` 的头部是
 * `RIFF....WEBP` —— 一个改成 `.jpg` 后缀的 WebP（750×421）。
 * 而 `server/index.ts` 选封面的正则 `/\.(jpe?g|png|bmp|gif|svg|psd|webp)$/i` 是**放行 webp/psd/svg** 的，
 * 也就是"承诺支持的格式"比"真能解的格式"多 —— 这些封面会被收敛成条目却拿到空缩略图，
 * 渲染层按 `type` 分支，于是画出一张**空白卡片**（没有任何报错，也看不出是"坏了"还是"格式不支持"）。
 *
 * 所以这里补一层兜底：nativeImage 解不开时，用**已经内置**的 ffmpeg 把图转成 PNG，
 * 再交给**同一条** `scaleToThumb` 缩放链路 —— 缩放规则（只在更宽时才缩）和输出质量
 * 都仍然只有一处定义，兜底只扩宽"能读进来的输入格式"，不改任何下游行为。
 */
export async function imageThumb(filepath: string): Promise<Buffer | null> {
    const direct = decodeImage(filepath);
    if (direct) return direct;

    // ⚠️ 兜底前**必须先确认文件真的存在**。nativeImage 对"文件不存在"同样返回空图，
    // 而 makeDirCover 是逐个名字盲试的（先 avatar.jpg 再 cover.jpg），
    // 不挡掉这一档，每个没有 avatar.jpg 的目录都会白起一个 ffmpeg 子进程。
    if (!(await fileExists(filepath))) return null;

    const out = path.join(
        os.tmpdir(),
        `ff-image-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`
    );

    try {
        if (!(await transcodeImage(filepath, out))) return null;
        return decodeImage(out);
    } finally {
        // 中转文件写在**系统盘**临时目录（不是移动硬盘），且无论成败立刻删掉
        fsasync.unlink(out).catch(() => { });
    }
}

/**
 * 视频缩略图：抽第 1% 帧到**系统盘临时目录**（不是移动硬盘），
 * 再用 nativeImage 按比例缩放成 JPEG，最后删掉临时帧。
 *
 * 为什么不让 ffmpeg 直接出 480px：
 *   fluent-ffmpeg 的 screenshots({size}) 只接受 `WxH` 字面量，
 *   实测 `size: '480x-1'` 会抛 `Invalid size parameter`；
 *   写死 `480x270` 又会把非 16:9 的视频拉伸变形。
 *   而 `-ss 1%` 只在 screenshots 内部有效，手写 outputOptions 用百分比定位会直接失败。
 * 所以：ffmpeg 负责"取到一帧"，nativeImage 负责"按比例缩放"，各做各的。
 */
export async function videoThumb(filepath: string): Promise<Buffer | null> {
    const name = `ff-frame-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`;
    const frame = path.join(os.tmpdir(), name);

    try {
        const ok = await extractFrame(filepath, frame);
        if (!ok) return null;
        // ⚠️ 必须 await：imageThumb 现在是异步的（内部可能走 ffmpeg 兜底），
        // 不 await 的话 finally 会**先**删掉临时帧，解码读的是一张已经不存在的文件
        return await imageThumb(frame);
    } finally {
        // 无论成功失败都清掉临时帧，不留垃圾在盘上
        fsasync.unlink(frame).catch(() => { });
    }
}

/**
 * ffmpeg 子进程超时（毫秒）。抽帧和图片转码**共用**这一个值。
 *
 * 为什么必须有：这两处是全项目**仅有的** await 外部子进程的地方，而它们原本只有
 * ffmpeg 的 `'end'` / `'error'` 两个出口。下列情况下 ffmpeg 可能既不结束也不报错 ——
 * **读取过程中拔掉移动硬盘、碰到坏文件、USB 掉线但句柄未失效** ——
 * `resolve` 永不触发 → `await makeThumb` 永不返回 → `readFolder` 的串行循环卡死
 * → `/openFolder` 响应永不发出，而 HTTP 层也没有兜底
 * （Node 的 server 默认 `requestTimeout = 0`，实测 6 秒后请求仍是 pending）。
 * fluent-ffmpeg 自己**没有**超时默认值：源码里只有 `if (self.options.timeout)`，
 * 而它的 options 默认不含这个键。
 *
 * 20 秒是实测单次抽帧（约 0.3~0.9 秒）的 20 倍以上，图片转码更是毫秒级，
 * 正常文件绝不会被误杀；真卡住时，让用户等 20 秒也比等一个永远不来的响应好。
 */
const FFMPEG_TIMEOUT_MS = 20000;

/** `ffmpeg()` 返回的命令对象。用 ReturnType 拿，避免再 import 一份类型 */
type FfmpegCmd = ReturnType<typeof ffmpeg>;

/**
 * 跑一个**已经配置好并已启动**的 ffmpeg 命令，带超时和强杀保护。
 *
 * 这是全项目唯一的"等外部子进程"咽喉点：抽帧（extractFrame）和图片转码
 * （transcodeImage）都从这儿过。上一版这段保护只写死在 extractFrame 里，
 * 加图片兜底时就等于要抄第二份 —— 抄漏一处就少一层保护。
 *
 * 超时一到就 `kill()` 掉子进程再 resolve(false) —— 光 resolve 不够，
 * 那个 ffmpeg 进程会一直拿着移动硬盘的句柄不放。
 * `settled` 保证三条出口（end / error / timeout）里只有**第一条**生效：
 * kill 之后 fluent-ffmpeg 还会补发一个 'error'，不挡住就会重复 resolve。
 */
function runFfmpeg(cmd: FfmpegCmd, what: string, src: string): Promise<boolean> {
    return new Promise((resolve) => {
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;

        const finish = (ok: boolean) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            resolve(ok);
        };

        cmd.on('end', () => finish(true))
            .on('error', (e: Error) => {
                console.error(`[thumbnail] ${what}失败:`, src, e.message);
                finish(false);
            });

        timer = setTimeout(() => {
            console.error(`[thumbnail] ${what}超时，已终止子进程:`, src);
            // SIGKILL 是 fluent-ffmpeg 自己的默认值（`signal || 'SIGKILL'`），
            // 这里显式写出来是为了满足类型声明 —— Windows 上 Node 会直接 TerminateProcess，
            // 强杀正是我们要的：确保它立刻松开移动硬盘的句柄
            try { cmd.kill('SIGKILL'); } catch { }
            finish(false);
        }, FFMPEG_TIMEOUT_MS);
    });
}

/** 取一帧（视频缩略图用）。`screenshots()` 内部会自己 `run()`，所以拿回来就能挂监听 */
function extractFrame(filepath: string, frame: string): Promise<boolean> {
    return runFfmpeg(
        ffmpeg(filepath).screenshots({
            timestamps: ['1%'],
            filename: path.basename(frame),
            folder: path.dirname(frame),
        }),
        '抽帧',
        filepath
    );
}

/**
 * 中转图的最大宽度。
 *
 * **这不是最终缩略图尺寸**（那是 `THUMB_WIDTH`，由 `scaleToThumb` 唯一决定），
 * 只是"别让中转文件爆掉"的上限：一张 6000px 的 WebP 转成全尺寸 PNG 会有几十 MB，
 * 而这个文件虽然落在系统盘临时目录、几毫秒后就删掉，也没必要写那么大。
 * 取 960 = 最终宽度 480 的 2 倍，缩放质量看不出差别。
 *
 * `min(iw,960)` 而不是直接 `960`：和 `scaleToThumb` 同一条规矩 —— **只缩不放**，
 * 小图（比如这张 750px 的 WebP）不能因为兜底就被拉大。
 */
const TRANSCODE_MAX_WIDTH = 960;

/**
 * 把 nativeImage 解不开的图片转成 PNG（中转文件，调用方负责删）。
 *
 * 输出 PNG 而不是 JPEG：后面 `scaleToThumb` 还要按 82 的质量编一次 JPEG，
 * 中转这一步不该再叠一次有损压缩。
 */
function transcodeImage(filepath: string, out: string): Promise<boolean> {
    // 分两步写：`run()` 的返回类型是 void，不能直接链上来当命令对象用
    const cmd = ffmpeg(filepath)
        .outputOptions([
            '-frames:v', '1',
            '-vf', `scale='min(${TRANSCODE_MAX_WIDTH},iw)':-2`,
        ])
        .output(out);
    cmd.run();
    return runFfmpeg(cmd, '图片转码', filepath);
}
