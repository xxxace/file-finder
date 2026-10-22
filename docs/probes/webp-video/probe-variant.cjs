/**
 * 变体探针：真库里有 13/16 的 webp 无缩略图、90/222 的视频无缩略图。
 * 合成一份"标准 webp / 标准 mp4"却能成功（见 probe.cjs）⇒ 失败一定和**具体文件特征**有关。
 *
 * 这里现场造出真实片源里最常见的几种"坏脾气"文件，逐个跑 app 自己的链路：
 *   webp：动图 / 带 alpha / 大尺寸 / 极小
 *   mp4 ：fragmented（moov 在前、无总时长）/ 带内嵌封面（attached_pic）/ 极短
 *
 *   bash docs/probes/webp-video/run.sh variant
 */
const { app } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const ffprobePath = require('@ffprobe-installer/ffprobe').path;
const { imageRenditions, videoRenditions } = require('./bundle.cjs');

const OUT = path.join(os.tmpdir(), 'ff-probe-variant');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const SRC_PNG = path.join(__dirname, '../../../build/icon.png');

function run(bin, args) {
    return new Promise((resolve) => {
        const c = spawn(bin, args, { windowsHide: true });
        let err = '';
        c.stderr.on('data', d => { err += d.toString(); });
        c.stdout.on('data', () => { });
        c.on('close', code => resolve({ ok: code === 0, code, tail: err.slice(-200) }));
        c.on('error', e => resolve({ ok: false, code: -1, tail: String(e) }));
    });
}

/** 只查 format=duration —— 与 probeDuration 一模一样的那一条查询 */
function probeDuration(file) {
    return new Promise((resolve) => {
        const c = spawn(ffprobePath, [
            '-v', 'error', '-show_entries', 'format=duration',
            '-of', 'default=noprint_wrappers=1:nokey=1', file,
        ], { windowsHide: true });
        let out = '';
        c.stdout.on('data', d => { out += d.toString(); });
        c.on('close', code => resolve({ code, raw: out.trim() }));
    });
}

const ff = (...args) => run(ffmpegPath, ['-y', ...args]);

(async () => {
    await app.whenReady();
    const r = { webp: {}, mp4: {} };

    // ── webp 变体 ──
    const webpCases = {
        'anim.webp': ['-i', SRC_PNG, '-vf', 'scale=320:-2', '-c:v', 'libwebp', '-loop', '0', '-t', '2', '-r', '5'],
        'alpha.webp': ['-i', SRC_PNG, '-vf', 'scale=320:-2,format=rgba', '-c:v', 'libwebp', '-lossless', '1'],
        'big.webp': ['-i', SRC_PNG, '-vf', 'scale=2400:-2', '-c:v', 'libwebp', '-q:v', '90'],
    };
    for (const [name, args] of Object.entries(webpCases)) {
        const f = path.join(OUT, name);
        const mk = await ff(...args, f);
        r.webp[name] = {
            made: mk.ok,
            bytes: fs.existsSync(f) ? fs.statSync(f).size : 0,
            ...(mk.ok ? await imageRenditions(f).then(({ thumb }) => ({ thumbBytes: thumb ? thumb.length : 0 })) : {}),
        };
    }

    // ── mp4 变体 ──
    const mp4Cases = {
        // 标准：moov 在尾（ffmpeg 默认 faststart 关）
        'normal.mp4': ['-f', 'lavfi', '-i', 'testsrc=duration=3:size=320x240:rate=15', '-pix_fmt', 'yuv420p'],
        // fragmented：空 moov + 分片，很多下载器/录制器的产物
        'frag.mp4': ['-f', 'lavfi', '-i', 'testsrc=duration=3:size=320x240:rate=15', '-pix_fmt', 'yuv420p',
            '-movflags', 'frag_keyframe+empty_moov'],
        // faststart：moov 在前
        'fast.mp4': ['-f', 'lavfi', '-i', 'testsrc=duration=3:size=320x240:rate=15', '-pix_fmt', 'yuv420p',
            '-movflags', 'faststart'],
        // 极短（0.4 秒）—— 1% 落在 0.004 秒
        'short.mp4': ['-f', 'lavfi', '-i', 'testsrc=duration=0.4:size=320x240:rate=15', '-pix_fmt', 'yuv420p'],
        // 带内嵌封面（attached_pic）—— 很多片子有
        'poster.mp4': ['-f', 'lavfi', '-i', 'testsrc=duration=3:size=320x240:rate=15', '-i', SRC_PNG,
            '-map', '0:v', '-map', '1:v', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
            '-c:v:1', 'mjpeg', '-disposition:v:1', 'attached_pic', '-t', '3'],
    };
    for (const [name, args] of Object.entries(mp4Cases)) {
        const f = path.join(OUT, name);
        const mk = await ff(...args, f);
        if (!mk.ok) { r.mp4[name] = { made: false, tail: mk.tail }; continue; }
        const dur = await probeDuration(f);
        const rd = await videoRenditions(f);
        r.mp4[name] = {
            made: true,
            bytes: fs.statSync(f).size,
            probe: dur,
            thumbBytes: rd.thumb ? rd.thumb.length : 0,
        };
    }

    console.log(JSON.stringify(r, null, 2));
    fs.writeFileSync(path.join(__dirname, 'out-variant.txt'), JSON.stringify(r, null, 2));
    app.exit(0);
})();
