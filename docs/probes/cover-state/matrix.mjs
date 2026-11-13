/**
 * 补封面 · 卡片状态矩阵（只读，无副作用，不碰任何盘）
 * ===========================================================================
 * 为什么要它：一张卡的状态由 **4 个数据源**组合出来
 *   (`targets` / `grabRows` / `applyRows` / `inflight`)
 * 组合空间很大，而真机点一遍只能撞到 happy path。2026-11-14 那批问题
 * （写入成功却显示"待写入"、抽帧角标被读成"已完成"、排队看不出区别）全部是
 * **某个组合没被走过**，不是某一行写错。
 *
 * 跑法：`node docs/probes/cover-state/matrix.mjs`
 * 判据：全 PASS 才算这块没坏。**改 coverModel 之前先跑一遍，改完再跑一遍。**
 *
 * 它直接转译 `coverModel.ts` 后 import —— 用的是同一份源码，不是复刻一份逻辑。
 */
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';

const SRC = 'src/views/FileFinder/assistant/coverModel.ts';
const js = transformSync(readFileSync(SRC, 'utf8'), { loader: 'ts', format: 'esm' }).code;
const { buildCoverItems } = await import(
    `data:text/javascript;base64,${Buffer.from(js).toString('base64')}`
);

let pass = 0;
let fail = 0;
const t = (name, got, want) => {
    const ok = got === want;
    if (ok) pass += 1;
    else fail += 1;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `   want=${JSON.stringify(want)} got=${JSON.stringify(got)}`}`);
};

const target = (over = {}) => ({
    kind: 'file', dir: 'd', name: 'A-1', writeRel: 'd/A-1.jpg', query: 'A-1', ...over,
});
const row = (over = {}) => ({ writeRel: 'd/A-1.jpg', status: 'ok', coverUrl: null, ...over });
const one = (targets, grabRows = [], applyRows = [], opts = {}) =>
    buildCoverItems(targets, grabRows, applyRows, opts)[0];

// ── ① 还没扫到任何东西 ────────────────────────────────
{
    const c = one([target()]);
    t('空：state = idle', c.state, 'idle');
    t('空：没有角标', c.badge ?? '', '');
}

// ── ② 任务在跑、这张已选中、还没轮到 ──────────────────
{
    const c = one([target()], [], [], { live: true, selected: new Set(['d/A-1.jpg']) });
    t('排队：state 仍是 idle（不转圈）', c.state, 'idle');
    t('排队：badge = 排队', c.badge, '排队');
}

// ── ③ 真正在飞 ────────────────────────────────────────
{
    const c = one([target()], [], [], { inflight: new Set(['d/A-1.jpg']) });
    t('在飞：state = pending', c.state, 'pending');
    t('在飞：不挂角标（点阵就够）', c.badge ?? '', '');
}

// ── ④ 站点抓到封面（还没写盘）──────────────────────────
{
    const c = one([target()], [row({ coverUrl: 'http://x/y.jpg', hitSite: 'javbus' })]);
    t('站点命中：state = ok', c.state, 'ok');
    t('站点命中：badge = 待写入', c.badge, '待写入');
    t('站点命中：来源进 site', c.site, 'javbus');
}

// ── ⑤ 抽帧拿到帧（同样还没写盘）────────────────────────
{
    const c = one([target()], [row({ frame: true, frameFile: 'f.jpg', pct: 30 })]);
    t('帧命中：state = ok', c.state, 'ok');
    t('帧命中：badge = 待写入（不是"抽帧 30%"）', c.badge, '待写入');
    t('帧命中：来源进 site', c.site, '抽帧 30%');
}

// ── ⑥ 写盘成功 ────────────────────────────────────────
{
    const c = one([target()], [row({ coverUrl: 'http://x/y.jpg', hitSite: 'javbus' })], [{ writeRel: 'd/A-1.jpg', ok: true }]);
    t('写入成功：state = written', c.state, 'written');
    t('写入成功：badge = 已写入', c.badge, '已写入');
}

// ── ⑦ 写盘失败 ────────────────────────────────────────
{
    const c = one([target()], [], [{ writeRel: 'd/A-1.jpg', ok: false, message: '权限不足' }]);
    t('写入失败：state = writefail', c.state, 'writefail');
    t('写入失败：badge = 写入失败', c.badge, '写入失败');
    t('写入失败：原因进 note', c.note, '权限不足');
}

// ── ⑧ 成功行在前、同 writeRel 的失败行在后 ─────────────
//    applyRows 的顺序是「累积的已写入」在前、「当前 job 的行」在后。
//    后到的失败行**不许**把已写入改回去 —— 用户在写入成功后又看到"没写"
{
    const c = one([target()], [], [
        { writeRel: 'd/A-1.jpg', ok: true },
        { writeRel: 'd/A-1.jpg', ok: false, message: '重试失败' },
    ]);
    t('成功是终态：仍 written', c.state, 'written');
}

// ── ⑨ 多分卷：一个成功、一个失败 ──────────────────────
//    一部片 8 个分卷时，`find` 只看第一个会判错（2026-11-14 的根因）
{
    const a = target({ name: 'A-1', writeRel: 'd/A-1.jpg' });
    const b = target({ name: 'A-2', writeRel: 'd/A-2.jpg' });
    const c = one([a, b], [], [
        { writeRel: 'd/A-1.jpg', ok: false, message: 'x' },
        { writeRel: 'd/A-2.jpg', ok: true },
    ]);
    t('多分卷：有一个写成功就算 written', c.state, 'written');
}

// ── ⑩ 多分卷：全部失败 ────────────────────────────────
{
    const a = target({ name: 'A-1', writeRel: 'd/A-1.jpg' });
    const b = target({ name: 'A-2', writeRel: 'd/A-2.jpg' });
    const c = one([a, b], [], [
        { writeRel: 'd/A-1.jpg', ok: false, message: 'x' },
        { writeRel: 'd/A-2.jpg', ok: false, message: 'y' },
    ]);
    t('多分卷：全失败才是 writefail', c.state, 'writefail');
}

// ── ⑪ 抓取的后三种结局 ────────────────────────────────
{
    t('未找到：badge', one([target()], [row({ status: 'no-match', message: '没有这部片' })]).badge, '未找到');
    t('被拦：badge', one([target()], [row({ status: 'blocked', blockedSite: 'javbus' })]).badge, '被拦');
    t('认不出：badge', one([target()], [row({ status: 'no-id' })]).badge, '认不出番号');
}

// ── ⑫ 失败原因必须留得住（悬停详情靠它）───────────────
{
    const c = one([target()], [row({ status: 'no-match', message: '所有站点都没抽到封面' })]);
    t('未找到：原因进 note', c.note, '所有站点都没抽到封面');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
