/**
 * 抽帧 · 纯函数探针（Task 1 的 RED/GREEN 载体）
 *
 * 本项目没有测试框架（主人明令别写 TDD 式假测试）⇒ 用这个只读脚本代替：
 * 全部断言都是纯函数，不碰盘、不碰 electron、不碰数据库。
 *
 * 跑法：node --experimental-strip-types docs/probes/frame-math/run.mjs
 */
import { cardKeyOf, key16Of } from '../../../electron/server/assistant/cardKey.ts';
import { PCT_LADDER, pctOf, flatRatio } from '../../../electron/server/assistant/frameMath.ts';

let pass = 0;
const fails = [];

function eq(name, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (ok) pass += 1;
    else fails.push(`${name}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
}

function ok(name, cond, detail = '') {
    if (cond) pass += 1;
    else fails.push(`${name}${detail ? `\n  ${detail}` : ''}`);
}

// ── 卡键 ────────────────────────────────────────────────────
// 裸文件：同层 + 同番号 = 一部片。层目录必须由 writeRel 反推（与 apply 的 buildGroups 同口径）
eq('cardKey 裸文件', cardKeyOf({ kind: 'file', writeRel: 'A/B/TST-001.jpg', query: 'TST-001' }), 'file|A/B|TST-001');
// 目录形态：一个目标一张卡 —— 只用 writeRel 会把同层的第二个吞掉，所以带 kind 前缀
eq('cardKey 目录', cardKeyOf({ kind: 'dir', writeRel: 'A/TST-001/TST-001.jpg' }), 'dir|A/TST-001/TST-001.jpg');
eq('cardKey 覆盖', cardKeyOf({ kind: 'cover', writeRel: 'A/TST-001.jpg' }), 'cover|A/TST-001.jpg');
// 盘根下的裸文件（没有父目录）不能崩
eq('cardKey 盘根', cardKeyOf({ kind: 'file', writeRel: 'TST-001.jpg', query: 'TST-001' }), 'file||TST-001');

const k = key16Of('file|A/B|TST-001');
ok('key16 长度 16', k.length === 16, `got ${k.length}`);
ok('key16 小写 hex', /^[0-9a-f]{16}$/.test(k), `got ${k}`);
ok('key16 稳定', key16Of('file|A/B|TST-001') === k);
ok('key16 区分卡键', key16Of('file|A/B|TST-001') !== key16Of('file|A/B|TST-002'));

// ── 阶梯 ────────────────────────────────────────────────────
eq('阶梯首档', pctOf(0), 1);
eq('阶梯次档', pctOf(1), 2);
eq('阶梯末档', pctOf(PCT_LADDER.length - 1), 50);
eq('阶梯越界钳到末档', pctOf(99), 50);
eq('阶梯负数钳到首档', pctOf(-3), 1);
eq('阶梯单调递增', PCT_LADDER.every((v, i) => i === 0 || v > PCT_LADDER[i - 1]), true);

// ── 纯色判定 ────────────────────────────────────────────────
const W = 64;
const H = 64;

/** 前 flatPct% 的像素涂同一种颜色，其余涂成互不相同的颜色 */
function synth(flatPct, color = [0, 0, 0]) {
    const buf = Buffer.alloc(W * H * 4);
    const flatCount = Math.round(W * H * flatPct / 100);
    for (let i = 0; i < W * H; i++) {
        const p = i * 4;
        if (i < flatCount) {
            buf[p] = color[0]; buf[p + 1] = color[1]; buf[p + 2] = color[2];
        } else {
            // 每个像素都落在不同桶：低 3 位随机、高位跟着序号走
            buf[p] = (i * 7) & 0xff; buf[p + 1] = (i * 13) & 0xff; buf[p + 2] = (i * 29) & 0xff;
        }
        buf[p + 3] = 255;
    }
    return buf;
}

ok('纯黑全屏 = 1.0', flatRatio(synth(100), W, H) === 1);
ok('纯白全屏 ≥ .9', flatRatio(synth(100, [255, 255, 255]), W, H) >= 0.9);
ok('95% 同色 ≥ .9', flatRatio(synth(95), W, H) >= 0.9);
ok('80% 同色 < .9', flatRatio(synth(80), W, H) < 0.9);
ok('全噪声 < .5', flatRatio(synth(0), W, H) < 0.5);
ok('空输入不崩', flatRatio(Buffer.alloc(0), 0, 0) === 0);

// ── 结果 ────────────────────────────────────────────────────
console.log(`frame-math probe: ${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log(`FAIL ${f}`);
if (fails.length) process.exit(1);
