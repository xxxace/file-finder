import { nativeImage } from 'electron';
import type { NativeImage } from 'electron';
import ffmpeg from 'fluent-ffmpeg';
import { path as ffmpegPath } from '@ffmpeg-installer/ffmpeg';
import { path as ffprobePath } from '@ffprobe-installer/ffprobe';
import os from 'node:os';
import path from 'node:path';
import * as fsasync from 'node:fs/promises';
import { spawn } from 'node:child_process';

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

/**
 * 缩略图宽度（网格用）。
 *
 * 网格是 `calc(100% / 6)` + `flexible.ts` 的 rem 方案：
 *   1200px 窗口 → 每格约 180 x 144 px
 *   2048px 窗口 → 每格约 340 x 272 px
 *
 * ⚠️ 2026-10-04 由 480 / q82 下调到 **384 / q78**，依据是**用真库实测**（不是估的）：
 * `docs/probes/thumb-tier/`（Electron + 同一个 nativeImage 编码器，取样他自己库里
 * 1236 张真缩略图里的 400 张）：
 *   480/q82  均值 39 KB（存成 base64 就是 47~52 KB —— 主人说的"50 多 KB"）
 *   384/q78  均值 **23 KB**  ← 采用
 *   360/q75  均值 20 KB
 *   320/q72  均值 15 KB
 * 本机 dpr = 1.25（逻辑 2048×1280 / 物理 2560×1600）⇒ 网格一格约 422 设备像素，
 * 384 档是 **1.1 倍插值**（照片缩略图上看不出差别）。要"零插值"得 440px，但那样只能省 38%
 * 而不是 56% —— 权衡后选 384。**这个数随时可以调（改了只是重扫一层的成本）。**
 */
export const THUMB_WIDTH = 384;

/** JPEG 质量（网格缩略图用）。与 THUMB_WIDTH 一组，依据同上（`docs/probes/thumb-tier/`） */
export const THUMB_QUALITY = 78;

/**
 * 预览大图的长边上限。
 *
 * 依据：预览最多铺到 `(窗口宽−32) × (窗口高−32)`，本机最大化窗口是 2048×1280 逻辑、
 * dpr 1.25 ⇒ 设备像素约 2520 ⇒ 2048 长边最坏是 **1.23 倍插值**（照片看不出）。
 * 再大一档（2560）只对"超过 2048 的大图"有意义，却要多花约 40% 体积 ⇒ 不值得。
 *
 * ⚠️ 绝大多数源图（中位 800×538）**根本不到这个上限** ⇒ 它们走"原样存"那条路
 * （见 `verbatimPreview`），既不重编码也不损失质量。
 */
export const PREVIEW_LONG_EDGE = 2048;

/**
 * 预览大图的 JPEG 质量（只在"必须重编码"时才用到：源图超大、或源图是 nativeImage 解不开的格式）。
 * 比网格缩略图的 78 高一档 —— 它是给人放大看的"好"那一份。
 */
export const PREVIEW_QUALITY = 82;

/**
 * "原样存"的体积上限。
 *
 * 源图是不超过 2048 长边的 JPEG 时，**直接存源字节**（不重编码）：
 *   ① 质量零损失（JPEG 二次编码必掉画质）；
 *   ② 零 CPU（扫描一张图省一次编码）；
 *   ③ 体积与重编码同量级（实测原图均值 161 KB base64 ⇒ 约 120 KB 裸字节）。
 * 超过这个上限就重编码 —— 那种是异常大图，压一压更划算。
 */
export const PREVIEW_VERBATIM_MAX = 1.5 * 1024 * 1024;

/** 一次解码产出的**两个**尺寸。`thumb` 给网格，`preview` 给点开的大图。两者恒为 JPEG */
export interface Renditions {
    thumb: Buffer | null;
    preview: Buffer | null;
}

/** 按比例缩到 `THUMB_WIDTH` 宽，输出 JPEG。只在原图更宽时才缩 —— 避免把小图放大糊掉 */
export function scaleToThumb(img: NativeImage): Buffer {
    const { width } = img.getSize();
    const scaled = width > THUMB_WIDTH ? img.resize({ width: THUMB_WIDTH, quality: 'good' }) : img;
    return scaled.toJPEG(THUMB_QUALITY);
}

/** 按长边缩到 `PREVIEW_LONG_EDGE`（只缩不放），输出 JPEG */
function scaleToPreview(img: NativeImage): Buffer {
    const { width, height } = img.getSize();
    if (Math.max(width, height) <= PREVIEW_LONG_EDGE) return img.toJPEG(PREVIEW_QUALITY);
    return (width >= height
        ? img.resize({ width: PREVIEW_LONG_EDGE, quality: 'good' })
        : img.resize({ height: PREVIEW_LONG_EDGE, quality: 'good' })
    ).toJPEG(PREVIEW_QUALITY);
}

/**
 * 源字节能不能**原样**当大图用（见 `PREVIEW_VERBATIM_MAX` 的说明）。
 * 只放行 JPEG —— PNG 照片往往比同画质 JPEG 大好几倍，存它不划算。
 */
function verbatimOf(buf: Buffer, img: NativeImage): Buffer | null {
    const isJpeg = buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
    if (!isJpeg || buf.length > PREVIEW_VERBATIM_MAX) return null;
    const { width, height } = img.getSize();
    return Math.max(width, height) <= PREVIEW_LONG_EDGE ? buf : null;
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
 * nativeImage 解码 + 缩放。解不开返回 null（不区分"文件不存在"和"格式不支持"）。
 *
 * ⚠️ 2026-10-04 从 `createFromPath` 改成"**先读一次字节、再 `createFromBuffer`**"：
 * 因为"原样存大图"需要源字节，而多读一次文件就是多碰一次移动硬盘。
 * 一次 readFile 同时喂给解码和原样存 —— **新增的读盘量是 0**。
 * 快路径解不开时**照旧走 ffmpeg 兜底**（WebP 等），所以换了入口也不会少支持一种格式。
 */
async function decodeImage(filepath: string): Promise<{ img: NativeImage; verbatim: Buffer | null } | null> {
    let buf: Buffer;
    try {
        buf = await fsasync.readFile(filepath);
    } catch {
        return null;
    }

    const img = nativeImage.createFromBuffer(buf);
    if (!img.isEmpty()) return { img, verbatim: verbatimOf(buf, img) };

    // 兜底：nativeImage 解不开（WebP / PSD / 改了后缀的…）→ 用**已经内置**的 ffmpeg 转 PNG，
    // 再交给**同一条**缩放链路。缩放规则与输出质量仍然只有一处定义。
    //
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
        // 转出来的 PNG 不原样用（全尺寸 PNG 常常比 JPEG 大一个数量级），交给 scaleToPreview
        const png = nativeImage.createFromBuffer(await fsasync.readFile(out));
        return png.isEmpty() ? null : { img: png, verbatim: null };
    } finally {
        // 中转文件写在**系统盘**临时目录（不是移动硬盘），且无论成败立刻删掉
        fsasync.unlink(out).catch(() => { });
    }
}

/** 图片条目：一次解码 → 网格缩略图 + 预览大图 */
export async function imageRenditions(filepath: string): Promise<Renditions> {
    const decoded = await decodeImage(filepath);
    if (!decoded) return { thumb: null, preview: null };
    return {
        thumb: scaleToThumb(decoded.img),
        preview: decoded.verbatim ?? scaleToPreview(decoded.img),
    };
}

/**
 * 视频条目：抽第 1% 帧到**系统盘临时目录**（不是移动硬盘），再用同一条链路出两个尺寸，
 * 最后删掉临时帧。
 *
 * 为什么不让 ffmpeg 直接出目标尺寸：
 *   fluent-ffmpeg 的 `screenshots({size})` 只接受 `WxH` 字面量，
 *   实测 `size: '480x-1'` 会抛 `Invalid size parameter`；
 *   写死固定尺寸又会把非 16:9 的视频拉伸变形。
 *   而 `-ss 1%` 只在 screenshots 内部有效，手写 outputOptions 用百分比定位会直接失败。
 * 所以：ffmpeg 负责"取到一帧"，nativeImage 负责"按比例缩放"，各做各的。
 */
export async function videoRenditions(filepath: string): Promise<Renditions> {
    const name = `ff-frame-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`;
    const frame = path.join(os.tmpdir(), name);

    try {
        const ok = await extractFrame(filepath, frame);
        if (!ok) return { thumb: null, preview: null };
        // ⚠️ 必须 await：imageRenditions 是异步的（内部可能走 ffmpeg 兜底），
        // 不 await 的话 finally 会**先**删掉临时帧，解码读的是一张已经不存在的文件
        return await imageRenditions(frame);
    } finally {
        // 无论成功失败都清掉临时帧，不留垃圾在盘上
        fsasync.unlink(frame).catch(() => { });
    }
}

/**
 * 外部子进程超时（毫秒）。**ffprobe 探测、抽帧、图片转码三处共用**这一个值。
 *
 * 为什么必须有：这三处是全项目**仅有的** await 外部子进程的地方，而它们原本只有
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
 *
 * ⚠️ 注意「**每个子进程各算 20 秒**」：ffprobe 和它后面的 ffmpeg 是两段独立的等待
 * （`extractFrame` 串行 await），所以最坏情况是 20 + 20 = 40 秒。
 * 这是刻意的 —— 两段各有各的卡死理由，共用一个 deadline 反而会让「ffprobe 慢」
 * 把 ffmpeg 的预算吃掉。
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

/**
 * 自己 spawn ffprobe 取时长（秒）。取不到 —— ffprobe 报错、超时被杀、或输出不是
 * 合法正数 —— 一律返回 null（调用方据此放弃抽帧）。
 *
 * **为什么不用 `ffmpeg.ffprobe()`**：跟着 fluent-ffmpeg 走同样够不着子进程。
 * `lib/ffprobe.js:155` 是 `var ffprobe = spawn(...)` —— 一个**局部变量**，
 * 从没挂到命令对象上 → 调用方拿不到 pid → 卡住时没有任何办法把它杀掉。
 * 自己 spawn 才能把句柄握在自己手里（`child.kill` 直接作用于我们持有的那个 pid）。
 *
 * **为什么只查 `format=duration`**：这是"拿到时长"所需的最小查询。ffprobe 是在
 * **移动硬盘上的源文件**上跑的，少读一点就是少碰盘一点 —— 不抄 ffmpeg.ffprobe()
 * 默认那份 `-show_streams -show_format` 的全量元数据。
 */
function probeDuration(filepath: string): Promise<number | null> {
    return new Promise((resolve) => {
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;

        const child = spawn(ffprobePath, [
            '-v', 'error',
            '-show_entries', 'format=duration',
            '-of', 'default=noprint_wrappers=1:nokey=1',
            filepath,
        ], { windowsHide: true }); // windowsHide 与 fluent-ffmpeg 内部一致：不闪黑框

        const finish = (seconds: number | null) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            resolve(seconds);
        };

        let stdout = '';
        child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });

        child.on('error', (e: Error) => {
            console.error('[thumbnail] ffprobe 启动失败:', filepath, e.message);
            finish(null);
        });
        child.on('close', (code) => {
            if (code !== 0) {
                finish(null);
                return;
            }
            const seconds = Number(stdout.trim());
            finish(Number.isFinite(seconds) && seconds > 0 ? seconds : null);
        });

        timer = setTimeout(() => {
            console.error('[thumbnail] ffprobe 超时，已终止子进程:', filepath);
            // 这是**我们自己**spawn 出来的进程，句柄就在手上，直接杀。
            // 对比 `cmd.kill()`：后者要先赌命令对象里已经存了 pid（ffprobe 阶段它是 undefined）
            try { child.kill('SIGKILL'); } catch { }
            finish(null);
        }, FFMPEG_TIMEOUT_MS);
    });
}

/**
 * 取一帧（视频缩略图用）。
 *
 * **为什么不能写 `timestamps: ['1%']`**（下一个人大概率想改回去，所以写在这儿）：
 * `'1%'` 是**百分比**形式，会命中 fluent-ffmpeg 的 `computeTimemarks`
 * （`recipes.js:169-211`）→ 它必须先 `self.ffprobe(...)` 拿到时长，才能把 `1%`
 * 换算成秒 → **命令里会多出一个我们自己够不着的 ffprobe 子进程**
 * （局部变量，见 `probeDuration` 的注释）。而 20 秒计时器从 `screenshots()`
 * 那一刻就起跑，所以**超时完全可能落在 ffprobe 窗口**：`cmd.kill()` 那时走的是
 * `logger.warn('No running ffmpeg process')` 分支，**一个进程都没杀掉** ——
 * 孤儿 ffprobe 继续攥着移动硬盘上源视频的句柄。
 * §13 实测：连续触发 5 次，存活数 1/2/3/4/5 **线性累积**。
 *
 * 现在改成"**先自己（带超时、手里有 pid、能杀）拿时长 → 传数字秒**"：
 * `computeTimemarks` 的判据是 `timemarks.some(t => /^[\d.]+%$/.test(t))`，
 * 收到数字时直接为假、跳过，**命令里只剩 ffmpeg** → `runFfmpeg` 的 20 秒超时
 * 就覆盖了整条链路（ffprobe 那一段由 `probeDuration` 自己覆盖）。
 *
 * ⚠️ 抽帧位置仍然是**时长的 1%**，不是固定秒数 —— 1% 是刻意选的，躲开片头黑场。
 * 取不到时长就返回 false，**不要**退化成固定时间点（那等于又去拍黑场）。
 */
async function extractFrame(filepath: string, frame: string): Promise<boolean> {
    const duration = await probeDuration(filepath);
    if (duration === null) return false;

    return runFfmpeg(
        ffmpeg(filepath).screenshots({
            timestamps: [duration * 0.01],
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

/**
 * 供「补封面」的写盘层复用（`apply.ts`）：nativeImage 解不开的封面图（多为
 * 改了后缀的 WebP）从这条链路转出 PNG 再走 JPEG 编码。只放行这一条复用出口，
 * 转码参数（`-frames:v 1`、`min(960,iw)`）仍然只有这一处定义。
 */
export { transcodeImage };
