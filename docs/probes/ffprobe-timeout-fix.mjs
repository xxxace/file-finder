/**
 * 探针：验证 `electron/utils/thumbnail.ts` 的 **ffprobe 超时修复**（UPGRADE-PLAN §16.2 任务 B）。
 *
 * 要证明两件事：
 *   A. **回归** —— 正常视频仍能出缩略图；且抽帧位置是"**时长的 1%**"（传进去的是**数字秒**，
 *      不是 `'1%'`），命令里只有一个 ffprobe（我们自己那个），没有第二个。
 *   B. **修复** —— ffprobe 卡住时，20 秒超时**真的把它杀掉**（不再留孤儿），
 *      而且因为拿不到时长，**不会再去起 ffmpeg**。
 *
 * 关键手法：**直接 import 真的 thumbnail.ts**，不是把逻辑抄一份进探针。
 *   两个障碍及绕法：
 *     ① 它是 .ts —— Node 22.22.2 默认开启 type stripping，可直接 import。
 *     ② 它 `import { nativeImage } from 'electron'` —— 纯 Node 没有 Electron 运行时，
 *        用 loader 把 'electron' 换成极简替身（见 electron-stub.mjs）。
 *
 * 观测手段（两条独立通道，互相印证）：
 *   ① 给 `child_process.spawn` 装**只读钩子**记 pid（不做行为改写）。
 *      两个坑照抄 ffprobe-kill-leak.mjs：a) 必须打 CJS 那一份；b) 必须先打钩子再 import 目标模块。
 *   ② `tasklist` 装 OS 层核对 —— 完全不用我们的钩子，避免"钩子自己骗自己"。
 *
 * 不碰外盘：素材用 lavfi 现生成到 %TEMP%；"卡住"用**永不写入的 stdin 管道**模拟
 *          （机制与"ffprobe 卡在读移动硬盘"相同：进程阻塞在 read，命令对象够不着它）。
 *
 * 跑法：node docs/probes/ffprobe-timeout-fix.mjs
 */

import { register, createRequire } from 'node:module';
import { path as ffmpegPath } from '@ffmpeg-installer/ffmpeg';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// ① 把 'electron' 换成替身（必须在 import thumbnail.ts **之前**注册）
register(new URL('./esm-stub-loader.mjs', import.meta.url));

// ② 只读钩子记录被 spawn 的子进程。
//    ⚠️ 顺序很关键：这里**不能**用 `import { execFileSync } from 'node:child_process'` ——
//    ESM import 会被提升到打钩子之前执行，那会先把内建的 ESM 外观对象造出来（快照住原版 spawn），
//    钩子就失效了。所以 node:child_process 全部走 createRequire 取 CJS 那一份。
const cjsCp = createRequire(import.meta.url)('node:child_process');
const spawned = [];
const origSpawn = cjsCp.spawn;
cjsCp.spawn = function (cmd, args, opts) {
    const child = origSpawn.call(this, cmd, args, opts);
    spawned.push({ bin: path.basename(String(cmd)), args: (args || []).map(String), pid: child.pid });
    return child;
};
const execFileSync = cjsCp.execFileSync;
const spawnSync = cjsCp.spawnSync;

// ③ 现在才 import 被测模块 —— 它内部的 `import { spawn } from 'node:child_process'`
//    会拿到我们刚换上的那一版（下面 selfCheck 会当场验证这件事）。
const thumb = await import('../../electron/utils/thumbnail.ts');
const esmCp = await import('node:child_process');

const TMP = os.tmpdir();
const SRC = path.join(TMP, 'ffprobe-fix-normal.mp4');
const OUT_DIR = path.join(TMP, 'ffprobe-fix-out');
fs.mkdirSync(OUT_DIR, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const isProbe = (s) => s.bin.startsWith('ffprobe');
const probeSpawns = () => spawned.filter(isProbe);
const ffmpegSpawns = () => spawned.filter((s) => s.bin.startsWith('ffmpeg'));
const reapAll = () => {
    for (const s of spawned) if (isAlive(s.pid)) { try { process.kill(s.pid, 'SIGKILL'); } catch { } }
};

/** OS 层核对：数当前机器上真实的 ffprobe 进程数（不依赖钩子） */
function ffprobeCountViaTasklist() {
    try {
        const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq ffprobe.exe', '/NH'], { encoding: 'utf8' });
        return out.split('\n').filter((l) => /ffprobe\.exe/i.test(l)).length;
    } catch {
        return -1;
    }
}

const results = {};

// ---------------------------------------------------------- 0：钩子自检
// 如果 ESM 侧拿到的 spawn 不是我们打的钩子，后面所有 pid 证据都不成立 —— 必须先证明它成立。
results['0_钩子自检'] = {
    'ESM 侧 spawn 与 CJS 侧(被钩子替换后)是同一个函数': esmCp.spawn === cjsCp.spawn,
    'ESM 侧 spawn 不是原版': esmCp.spawn !== origSpawn,
};

// ---------------------------------------------------------- 素材：lavfi 现生成
if (!fs.existsSync(SRC)) {
    const r = spawnSync(ffmpegPath, [
        '-y', '-f', 'lavfi', '-i', 'testsrc=duration=42:size=320x240:rate=1',
        '-pix_fmt', 'yuv420p', SRC,
    ], { windowsHide: true, encoding: 'utf8' });
    if (r.status !== 0) {
        console.error('生成素材失败:', r.stderr);
        process.exit(2);
    }
}
const srcStat = fs.statSync(SRC);
// 42 秒 → 1% 应该是 0.42 秒（42 * 0.01 = 0.42000000000000004）
const EXPECT_PREFIX = '0.42';

// ---------------------------------------------------------- A：正常文件（回归）
async function testA() {
    spawned.length = 0;
    const t0 = Date.now();
    const buf = await thumb.videoThumb(SRC);
    const elapsed = Date.now() - t0;

    const probes = probeSpawns();
    const frames = ffmpegSpawns().filter((s) => s.args.includes('-ss'));
    const ssIdx = frames[0] ? frames[0].args.indexOf('-ss') : -1;
    const ssValue = ssIdx >= 0 ? frames[0].args[ssIdx + 1] : null;

    results.A_正常文件回归 = {
        '返回类型': buf ? `Buffer(${buf.length} B)` : String(buf),
        '抽帧耗时(ms)': elapsed,
        'ffprobe 被 spawn 次数': probes.length,
        'ffmpeg 被 spawn 次数': ffmpegSpawns().length,
        '抽帧命令里的 -ss 值': ssValue,
        [EXPECT_PREFIX + ' 开头 = 时长的 1%，而不是 "1%"']: typeof ssValue === 'string' && ssValue.startsWith(EXPECT_PREFIX),
        '抽帧命令完整参数': frames[0] ? frames[0].args.join(' ') : '(未捕获到)',
        '判定': (buf && probes.length === 1 && typeof ssValue === 'string' && ssValue.startsWith(EXPECT_PREFIX))
            ? '✅ 出图；位置=时长的 1%；只有 1 个 ffprobe（我们自己那个）'
            : '❌ 与预期不符',
    };
    reapAll();
}

// ---------------------------------------------------------- B：ffprobe 卡住 → 超时是否杀掉
async function testB(roundLabel) {
    const beforeTasklist = ffprobeCountViaTasklist();
    spawned.length = 0;

    const t0 = Date.now();
    // 'pipe:0' → ffprobe 的参数就是 "pipe:0"；它的 stdin 是 spawn 默认的管道，
    // 我们不写、不关 → ffprobe 永久阻塞在 read（等价于"卡在读移动硬盘"）。
    const promise = thumb.videoThumb('pipe:0');

    await sleep(2000); // 等它真的起来
    const entry = [...probeSpawns()].reverse()[0];
    const pid = entry ? entry.pid : 0;
    const aliveDuring = pid ? isAlive(pid) : false;
    const tasklistDuring = ffprobeCountViaTasklist();

    const buf = await promise;          // 20 秒超时到点后 settle
    const elapsed = Date.now() - t0;
    const aliveAfter = pid ? isAlive(pid) : false;
    const tasklistAfter = ffprobeCountViaTasklist();

    const out = {
        '卡住期间 ffprobe pid': pid,
        '卡住期间 pid 存活(钩子)': aliveDuring,
        '卡住期间 tasklist 计数(OS)': tasklistDuring,
        '超时到点耗时(ms)': elapsed,
        '超时后同一 pid 存活(钩子)': aliveAfter,
        '超时后 tasklist 计数(OS)': tasklistAfter,
        '本次 tasklist 基线': beforeTasklist,
        '返回值': String(buf),
        'ffmpeg 是否被 spawn(应为 0)': ffmpegSpawns().length,
        '判定': (aliveDuring && !aliveAfter && tasklistAfter <= beforeTasklist && buf === null && ffmpegSpawns().length === 0)
            ? '✅ 超时真的杀掉了 ffprobe；无孤儿；未起 ffmpeg'
            : '❌ 与预期不符',
    };
    reapAll();
    return out;
}

console.log('素材: ' + SRC + ' (' + srcStat.size + ' B, 42s)');
await testA();
results.B_超时杀进程_第1轮 = await testB('第1轮');
results.B_超时杀进程_第2轮 = await testB('第2轮');

console.log(JSON.stringify(results, null, 2));
console.log('最终 tasklist ffprobe 计数: ' + ffprobeCountViaTasklist());
reapAll();
process.exit(0);
