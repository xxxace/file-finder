/**
 * 实测 · Windows 上「原子写覆盖已有文件」到底行不行。
 *
 *   node docs/probes/cover-blur/rename-overwrite.mjs      # 输出写 out-rename.txt
 *
 * 为什么必须实测：方案要给"糊脸"**覆盖**新封面，而 `apply.ts` 的原子写是
 * `writeFile(tmp)` + `rename(tmp, abs)`。`fs.rename` 在 POSIX 上覆盖目标，
 * 在 Windows 上是 libuv 走 `MoveFileExW` —— 文档里写着带 `MOVEFILE_REPLACE_EXISTING`，
 * 但"文档写着"不等于"这台机器上实测成立"，而这里的结论决定方案能不能一行改完。
 *
 * 只碰**系统临时目录**，不碰移动硬盘、不碰缓存库。
 */
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ff-probe-rename-'));
let pass = 0, fail = 0;
const check = (label, ok) => { ok ? pass++ : fail++; console.log(`  ${ok ? '✅' : '❌'} ${label}`); };

try {
    const abs = path.join(dir, 'cover.jpg');
    const tmp = path.join(dir, '.cover-123.tmp');

    // 旧封面（模拟已有的糊图），新内容写 tmp 后 rename 覆盖
    await fsp.writeFile(abs, Buffer.from('OLD-IMAGE-BYTES'));
    await fsp.writeFile(tmp, Buffer.from('NEW-BIGGER-IMAGE-BYTES'));

    let err = null;
    try {
        await fsp.rename(tmp, abs);
    } catch (e) {
        err = e;
    }
    check(`rename 覆盖已存在文件不抛错（${err ? `${err.code}: ${err.message}` : '无错'}）`, !err);

    const after = (await fsp.readFile(abs)).toString();
    check('覆盖后内容 = 新内容（不是旧的、也不是两者拼接）', after === 'NEW-BIGGER-IMAGE-BYTES');
    check('tmp 已消失（rename 是搬走，不是复制）', !(await exists(tmp)));

    // 对照：跨卷 rename 会失败（EXDEV）—— 说明"tmp 必须写在目标目录内"这条约束是真的
    const otherDrive = process.platform === 'win32' ? 'C:/Windows/Temp' : '/tmp';
    if (path.resolve(otherDrive) !== path.resolve(os.tmpdir())) {
        const cross = path.join(otherDrive, `ff-probe-cross-${process.pid}.tmp`);
        try {
            await fsp.writeFile(cross, Buffer.from('X'));
            let crossErr = null;
            try { await fsp.rename(cross, path.join(dir, 'cross.jpg')); } catch (e) { crossErr = e; }
            console.log(`  ℹ️ 跨目录 rename（${crossErr ? crossErr.code : '成功'}）—— 同卷内才成立这一点**不额外验证**，只是旁证`);
            await fsp.rm(cross, { force: true }).catch(() => undefined);
        } catch { /* 目标目录不可写就算了，这一条只是旁证 */ }
    }
} finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
}

async function exists(p) {
    try { await fsp.access(p); return true; } catch { return false; }
}

console.log(`\n${fail === 0 ? '✅' : '❌'} 通过 ${pass} / 失败 ${fail}`);
if (fail) process.exitCode = 1;
