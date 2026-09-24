/**
 * 探针：`runFfmpeg` 的超时 `cmd.kill()` 能不能真的终止 **ffprobe 阶段**？
 *
 * 静态读出来的事实（本探针负责证实/证伪，逐行可复算）：
 *   1. `screenshots({timestamps:['1%']})` 内部是 `async.waterfall`，第一段
 *      `computeTimemarks` 要先 `self.ffprobe(...)` 拿到时长，才能把 '1%' 换成秒。
 *      → **最先跑起来的子进程是 ffprobe，不是 ffmpeg。**
 *   2. `extractFrame` 的写法 `runFfmpeg(ffmpeg(p).screenshots({...}), ...)`
 *      里，`screenshots()` **同步返回**（waterfall 还没跑），
 *      → `runFfmpeg` 的 20 秒计时器**是在 ffprobe 阶段就开始计时的**。
 *   3. `fluent-ffmpeg/lib/processor.js`：
 *        proto.kill = function (signal) {
 *          if (!this.ffmpegProc) { this.logger.warn('No running ffmpeg process, cannot send signal'); }
 *          else { this.ffmpegProc.kill(signal || 'SIGKILL'); }
 *        };
 *      而 `ffmpegProc` 是在 `_spawnFfmpeg` 的 `processCB` 里才赋值的（processor.js:445）。
 *   4. `fluent-ffmpeg/lib/ffprobe.js:155`：
 *        var ffprobe = spawn(path, ['-show_streams','-show_format',...]);
 *      —— **局部变量**，没挂到命令对象上，`cmd.kill()` 够不着。
 *
 * 推断：20 秒超时若落在 ffprobe 阶段（盘拔了 / 坏道 / USB 掉线，ffprobe 卡在读上），
 *      `cmd.kill()` 走 warn 分支，**一个进程都没杀**，孤儿 ffprobe 继续攥着移动硬盘的句柄。
 *
 * 观测手段：给 `child_process.spawn` 装一个**只读钩子**记录 ffprobe 的 pid，
 *          之后用 `process.kill(pid, 0)` 判活 —— 不做任何行为改写，也不用 taskkill 全杀。
 *
 * 不碰外盘：素材用 lavfi 现生成到 %TEMP%（由外部命令预先备好，见文件尾注释）；
 *          卡死用「永不写入也不关闭的 stdin 管道」模拟 —— 机制与「ffprobe 卡在读盘」
 *          相同：进程阻塞在 read，命令对象够不着它。
 *
 * 跑法：node docs/probes/ffprobe-kill-leak.mjs
 */

import { path as ffmpegPath } from '@ffmpeg-installer/ffmpeg';
import { path as ffprobePath } from '@ffprobe-installer/ffprobe';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// ---- 只读钩子：记录每个被 spawn 出来的子进程（不改行为）
//
// ⚠️ 两个坑，两版都栽过：
//  1. `import cp from 'node:child_process'` 拿到的是 Node 给内置模块合成的 ESM 外观对象，
//     改它**不影响** CJS 那一份 → 必须 `createRequire` 拿真的。
//  2. fluent-ffmpeg 是在**模块顶层** `var spawn = require('child_process').spawn`
//     把函数引用**抓走**的 → 必须先打钩子，再 `await import('fluent-ffmpeg')`。
const cjsCp = createRequire(import.meta.url)('node:child_process');
const spawned = [];
const origSpawn = cjsCp.spawn;
cjsCp.spawn = function (cmd, args, opts) {
    const child = origSpawn.call(this, cmd, args, opts);
    spawned.push({ bin: path.basename(String(cmd)), args: (args || []).join(' '), pid: child.pid });
    return child;
};

const ffmpeg = (await import('fluent-ffmpeg')).default;
ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

const TMP = os.tmpdir();
const SRC = path.join(TMP, 'ffprobe-leak-src.mp4');
const OUT_DIR = path.join(TMP, 'ffprobe-leak-out');
fs.mkdirSync(OUT_DIR, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isAlive = (pid) => {
    try { process.kill(pid, 0); return true; } catch { return false; }
};
const lastProbe = () => [...spawned].reverse().find((s) => s.bin.startsWith('ffprobe'));
const reapAll = () => {
    for (const s of spawned) if (isAlive(s.pid)) { try { process.kill(s.pid, 'SIGKILL'); } catch { } }
};

if (!fs.existsSync(SRC)) {
    console.error('缺少测试素材：' + SRC);
    console.error('先生成（lavfi，写 %TEMP%，不碰外盘）：');
    console.error(`  "${ffmpegPath}" -y -f lavfi -i testsrc=duration=2:size=320x240:rate=10 -pix_fmt yuv420p "${SRC}"`);
    process.exit(2);
}

const results = {};

// ---------------------------------------------------------- A：正常文件
// 目的：证明「ffprobe 先跑、ffmpeg 后跑」，且 ffprobe 存在的那段时间里 cmd.ffmpegProc 是空的。
async function testA() {
    spawned.length = 0;
    const cmd = ffmpeg(SRC).screenshots({ timestamps: ['1%'], filename: 'a.jpg', folder: OUT_DIR });

    let ffmpegProcUndefinedWhileFfprobeAlive = false;
    let ffprobePid = 0;
    const t0 = Date.now();
    const timer = setInterval(() => {
        const p = lastProbe();
        if (p && isAlive(p.pid) && ffprobePid === 0) ffprobePid = p.pid;
        if (ffprobePid && isAlive(ffprobePid) && cmd.ffmpegProc === undefined) {
            ffmpegProcUndefinedWhileFfprobeAlive = true;
        }
    }, 1);

    await new Promise((res) => {
        cmd.on('end', res).on('error', () => res());
        setTimeout(res, 3000);
    });
    clearInterval(timer);

    const spawnedList = spawned.map((s) => s.bin + ' ' + s.args.slice(0, 60));
    results.A = {
        '子进程启动顺序': spawnedList,
        'ffprobe 存活期间 cmd.ffmpegProc 曾为 undefined': ffmpegProcUndefinedWhileFfprobeAlive,
        'ffprobe 阶段耗时(ms)': spawned.length > 1 ? Date.now() - t0 : -1,
        '产出帧存在': fs.existsSync(path.join(OUT_DIR, 'a.jpg')),
    };
}

// ---------------------------------------------------------- B：卡住的 ffprobe
async function testB() {
    spawned.length = 0;
    // 'pipe:0' → ffprobe 的参数就是这个字面量；它的 stdin 是 spawn 默认管道，
    // 我们不写、不关 → ffprobe 永久阻塞在 read。
    const cmd = ffmpeg('pipe:0').screenshots({ timestamps: ['1%'], filename: 'b.jpg', folder: OUT_DIR });
    cmd.on('error', () => { });

    await sleep(1500);
    const p = lastProbe();
    const before = p ? isAlive(p.pid) : false;
    const ffmpegProcBefore = cmd.ffmpegProc !== undefined;

    cmd.kill('SIGKILL'); // ← 与 runFfmpeg 超时分支逐字相同

    await sleep(2000);
    const after = p ? isAlive(p.pid) : false;

    results.B = {
        '被 spawn 的子进程': spawned.map((s) => s.bin),
        'kill 前 ffprobe 存活': before,
        'kill 前 cmd.ffmpegProc 是否已存在': ffmpegProcBefore,
        'kill 后 ffprobe 存活': after,
        '判定': before && after ? '❌ kill() 未杀掉 ffprobe —— 泄漏成立' : '✅ kill() 生效',
    };
    reapAll();
}

// ---------------------------------------------------------- C：连续触发是否累积
async function testC() {
    spawned.length = 0;
    const alive = [];
    for (let i = 0; i < 5; i++) {
        const cmd = ffmpeg('pipe:0').screenshots({ timestamps: ['1%'], filename: `c${i}.jpg`, folder: OUT_DIR });
        cmd.on('error', () => { });
        await sleep(400);
        cmd.kill('SIGKILL');
        alive.push(spawned.filter((s) => isAlive(s.pid)).length);
    }
    results.C = { '每轮 kill 后仍存活的子进程数': alive, '说明': '线性增长 = 每次都会多留一个孤儿' };
    reapAll();
}

console.log('素材: ' + SRC + ' (' + fs.statSync(SRC).size + ' B)');
await testA();
await testB();
await testC();
console.log(JSON.stringify(results, null, 2));
reapAll();
process.exit(0);
