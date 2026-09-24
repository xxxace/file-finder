/**
 * 探针（**不需要成功 spawn 子进程**）：证明"传数字时间点 → fluent-ffmpeg 不再内部起 ffprobe"。
 *
 * 背景（§13 / §16.2）：`screenshots({timestamps:['1%']})` 走的是 `recipes.js:169-211`
 * 的 `computeTimemarks` 百分比分支 → 必须调 `self.ffprobe(...)` 拿时长 → 那就是
 * `lib/ffprobe.js:155` 里够不着的那个孤儿进程来源。换成数字则**跳过整个分支**。
 *
 * 本探针直接验证这个**分支决策本身**：给命令对象的 `ffprobe` 方法套一层
 * **只读探针**（不改行为，只记"有没有被调用"）。分支判断发生在任何 spawn **之前**，
 * 所以即使这台机器 spawn 一律 EBUSY（沙箱），本探针的结论依然成立。
 *
 * 另外用 `cmd._getArguments()`（fluent-ffmpeg 自带的"只算不跑"）读出最终 ffmpeg
 * 命令行，确认定位参数是 `-ss 0.42` 这种**数字秒**，而不是 `%` 百分比。
 *
 * 跑法：node docs/probes/ffprobe-timemark-branch.mjs
 */

import ffmpeg from 'fluent-ffmpeg';
import { path as ffmpegPath } from '@ffmpeg-installer/ffmpeg';
import { path as ffprobePath } from '@ffprobe-installer/ffprobe';
import os from 'node:os';
import path from 'node:path';

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

const TMP = os.tmpdir();
const SRC = path.join(TMP, 'ffprobe-branch-dummy.mp4');   // 只用来拼命令行，不会被读到
const OUT_DIR = path.join(TMP, 'ffprobe-branch-out');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 起一个 screenshots 命令，记录它有没有去调内部的 ffprobe，再读回最终命令行 */
async function observe(timemark) {
    const cmd = ffmpeg(SRC).screenshots({
        timestamps: [timemark],
        filename: 'branch.jpg',
        folder: OUT_DIR,
    });
    cmd.on('error', () => { });   // 沙箱里 spawn 必 EBUSY，吞掉

    let ffprobeCalled = false;
    const origFfprobe = cmd.ffprobe;
    cmd.ffprobe = function (...args) {
        ffprobeCalled = true;
        return origFfprobe.apply(this, args);
    };

    // 等 waterfall 走完（百分比分支要等 ffprobe 回调，数字分支同步过）
    await sleep(600);

    let args = [];
    try { args = cmd._getArguments(); } catch { }
    const ssIdx = args.indexOf('-ss');
    return {
        '传入的时间点': JSON.stringify(timemark),
        '内部 ffprobe 是否被调用': ffprobeCalled,
        '最终命令行里的 -ss 值': ssIndexToString(args, ssIdx),
        '命令行里是否出现 % 百分比': args.some((a) => String(a).includes('%')),
        '完整命令行': args.join(' '),
    };
}

function ssIndexToString(args, i) {
    return i >= 0 ? String(args[i + 1]) : '(命令行里没有 -ss)';
}

const results = {};
// 0.42 用 `42 * 0.01` 写，和 thumbnail.ts 里 `duration * 0.01` 逐字同形
results['1_传数字(修复后的写法：42 秒 × 0.01)'] = await observe(42 * 0.01);
results['2_传字符串百分比(修复前的写法)'] = await observe('1%');

console.log(JSON.stringify(results, null, 2));
process.exit(0);
