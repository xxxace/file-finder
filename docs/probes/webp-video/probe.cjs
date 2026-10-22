/**
 * 真 Electron 探针：WebP 图片 + 无封面视频，到底卡在哪一步。
 *
 *   bash docs/probes/webp-video/run.sh
 *
 * 被测的是 **app 自己的模块**（bundle 进来的 imageRenditions / videoRenditions），
 * 不是另写一份近似实现 —— 否则验的不是同一段代码。
 *
 * 素材全部现场合成到系统临时目录（用内置 ffmpeg），不碰移动硬盘、不碰真库。
 */
const { app, nativeImage } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const ffprobePath = require('@ffprobe-installer/ffprobe').path;
const { imageRenditions, videoRenditions } = require('./bundle.cjs');

const OUT = path.join(os.tmpdir(), 'ff-probe-webp');
fs.mkdirSync(OUT, { recursive: true });

const SRC_PNG = path.join(__dirname, '../../../build/icon.png');
const WEBP = path.join(OUT, 'a.webp');
const MP4 = path.join(OUT, 'a.mp4');
const NOEXT = path.join(OUT, 'noext');

/** 跑一条命令，返回 { ok, code, stderr } */
function run(bin, args) {
    return new Promise((resolve) => {
        const c = spawn(bin, args, { windowsHide: true });
        let err = '';
        c.stderr.on('data', d => { err += d.toString(); });
        c.on('close', code => resolve({ ok: code === 0, code, stderr: err.slice(-400) }));
        c.on('error', e => resolve({ ok: false, code: -1, stderr: String(e) }));
    });
}

const jpegOf = (buf) => buf && buf.length > 2 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;

(async () => {
    await app.whenReady();
    const r = {};

    // ── 合成素材 ──
    r.makeWebp = await run(ffmpegPath, ['-y', '-i', SRC_PNG, '-c:v', 'libwebp', '-q:v', '80', WEBP]);
    r.makeMp4 = await run(ffmpegPath, [
        '-y', '-f', 'lavfi', '-i', 'testsrc=duration=3:size=320x240:rate=15',
        '-pix_fmt', 'yuv420p', MP4,
    ]);
    r.sizes = {
        webp: fs.existsSync(WEBP) ? fs.statSync(WEBP).size : null,
        mp4: fs.existsSync(MP4) ? fs.statSync(MP4).size : null,
    };

    // ── ① nativeImage 自己认不认 webp（判据：isEmpty / 尺寸）──
    if (r.sizes.webp) {
        const img = nativeImage.createFromBuffer(fs.readFileSync(WEBP));
        r.nativeWebp = { isEmpty: img.isEmpty(), size: img.getSize() };
    }

    // ── ② app 的图片链路（会走 ffmpeg 兜底）──
    r.image = await imageRenditions(WEBP).then(({ thumb, preview }) => ({
        thumbBytes: thumb ? thumb.length : 0,
        thumbIsJpeg: jpegOf(thumb),
        previewBytes: preview ? preview.length : 0,
    }));

    // ── ③ 无扩展名副本：模拟"改了后缀"的图（decodeImage 的兜底判据依赖路径存在）──
    if (r.sizes.webp) {
        fs.copyFileSync(WEBP, NOEXT);
        r.imageNoExt = await imageRenditions(NOEXT).then(({ thumb }) => ({ thumbBytes: thumb ? thumb.length : 0 }));
    }

    // ── ④ 视频：ffprobe 时长 + app 的抽帧链路 ──
    if (r.sizes.mp4) {
        const p = await new Promise((resolve) => {
            const c = spawn(ffprobePath, [
                '-v', 'error', '-show_entries', 'format=duration',
                '-of', 'default=noprint_wrappers=1:nokey=1', MP4,
            ], { windowsHide: true });
            let out = '';
            c.stdout.on('data', d => { out += d.toString(); });
            c.on('close', code => resolve({ code, out: out.trim() }));
        });
        r.probeDuration = p;
        r.video = await videoRenditions(MP4).then(({ thumb, preview }) => ({
            thumbBytes: thumb ? thumb.length : 0,
            thumbIsJpeg: jpegOf(thumb),
            previewBytes: preview ? preview.length : 0,
        }));
    }

    // ── ⑤ 回归样本：容器 60s / 视频流只有 0.5s ──
    //    旧实现只查 `format=duration` ⇒ 抽 1% = 0.6s ⇒ 落在视频流之外 ⇒ ffmpeg exit 0 但零输出。
    //    新实现先查 `stream=duration`（0.5s）⇒ 抽 0.005s ⇒ 有帧。
    const LONG = path.join(OUT, 'long.mp4');
    r.makeLong = await run(ffmpegPath, [
        '-y', '-f', 'lavfi', '-i', 'testsrc=duration=0.5:size=320x240:rate=10',
        '-f', 'lavfi', '-i', 'sine=frequency=440:duration=60',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
        '-map', '0:v', '-map', '1:a', LONG,
    ]);
    if (fs.existsSync(LONG)) {
        const fmt = await new Promise((resolve) => {
            const c = spawn(ffprobePath, ['-v', 'error', '-show_entries', 'format=duration',
                '-of', 'default=noprint_wrappers=1:nokey=1', LONG], { windowsHide: true });
            let out = '';
            c.stdout.on('data', d => { out += d.toString(); });
            c.on('close', () => resolve(out.trim()));
        });
        r.longDurations = { formatSeconds: fmt };
        r.videoLongContainer = await videoRenditions(LONG).then(({ thumb }) => ({
            thumbBytes: thumb ? thumb.length : 0,
        }));
    }

    console.log(JSON.stringify(r, null, 2));
    fs.writeFileSync(path.join(__dirname, 'out.txt'), JSON.stringify(r, null, 2));
    app.exit(0);
})();
