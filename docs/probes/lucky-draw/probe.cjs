/**
 * 抽卡数据层 · 纯逻辑探针（只读）
 * ---------------------------------------------------------------------------
 * 只测 `src/views/Lucky/drawModel.ts`：去重维度、离线过滤、抽不满时怎么办、
 * 最近抽过的优先排除、字节格式化、卡身份。
 *
 * 不 import `usePool.ts` —— 它顶层经 `@/utils/request` 碰 `ipcRenderer`，node 里起不来。
 * 那两个接口的正确性由"真机抽一包"覆盖（见同目录 README 的「没验的」）。
 *
 * 跑法：`node docs/probes/lucky-draw/probe.cjs`（产物同目录 `out.txt`，证据必须是 .txt）
 * ⚠️ 打包的是**真源码**（同 playlist / rule-builder 的纪律）：断言的东西和线上是同一份代码。
 */
const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFileSync } = require('child_process');

const PROBE = __dirname;
const ROOT = path.resolve(PROBE, '../../..');
const OUT = path.join(PROBE, 'out.txt');
const ESBUILD = path.join(ROOT, 'node_modules', 'esbuild', 'bin', 'esbuild');

function bundle(rel) {
    const out = path.join(os.tmpdir(), `ff-${path.basename(rel, '.ts')}-${process.pid}.cjs`);
    execFileSync(process.execPath, [
        ESBUILD, path.join(ROOT, rel),
        '--bundle', '--platform=node', '--format=cjs',
        `--outfile=${out}`, '--external:electron', '--log-level=error',
    ], { stdio: 'inherit' });
    return out;
}

const M = require(bundle('src/views/Lucky/drawModel.ts'));

const lines = [];
let pass = 0;
let fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; lines.push(`PASS  ${name}`); }
    else { fail++; lines.push(`FAIL  ${name}${detail ? '  —— ' + detail : ''}`); }
}
function eq(name, actual, expected) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    check(name, a === e, `实际 ${a}，期望 ${e}`);
}

/** 造一个封面条目（只带判据用到的字段） */
function cover(i, over = {}) {
    return {
        id: `S1:/d${i}/n${i}`,
        name: `作品${i}`,
        dir: `/d${i}`,
        relPath: '',
        key: `/d${i}/作品${i}`,
        serial: 'S1',
        sig: `sig${i}`,
        type: 'image',
        ext: 'jpg',
        size: 1024 * 1024 * i,
        ...over,
    };
}

const pool = (n, over = () => ({})) => Array.from({ length: n }, (_, i) => cover(i + 1, over(i + 1)));
const all = (n) => new Set(Array.from({ length: n }, (_, i) => `S${i + 1}`));
const sigsOf = (list) => list.map(it => it.sig);

// ── ① formatBytes ───────────────────────────────────────────────────────────
eq('① 无值 → 空串', M.formatBytes(undefined), '');
eq('① 0 → 空串', M.formatBytes(0), '');
eq('① 负数 → 空串', M.formatBytes(-5), '');
eq('① NaN → 空串', M.formatBytes(NaN), '');
check('① 2.4GB 含 GB', /GB$/.test(M.formatBytes(2.4 * 1024 ** 3)));
eq('① MB 一位小数', M.formatBytes(1.5 * 1024 ** 2), '1.5 MB');
eq('① B 取整', M.formatBytes(900), '900 B');

// ── ② 抽一包：数量与互不重复 ────────────────────────────────────────────────
{
    const src = pool(50);
    let bad = '';
    for (let round = 0; round < 200; round++) {
        const pack = M.drawPack(src, all(3), { includeOffline: true });
        if (pack.length !== 5) { bad = `长度 ${pack.length}`; break; }
        if (new Set(sigsOf(pack)).size !== 5) { bad = 'sig 重复'; break; }
        // 不许改入参顺序：池子是页面持有的快照
        if (src[0].sig !== 'sig1') { bad = '入参被洗乱'; break; }
    }
    check('② 200 轮：每轮 5 张且 sig 互不相同', bad === '', bad);
}

// ── ③ 池子不足：不补齐、不重复 ──────────────────────────────────────────────
{
    const pack = M.drawPack(pool(3), all(1), { includeOffline: true });
    eq('③ 池 3 → 长度 3', pack.length, 3);
    eq('③ 池 3 → 不重复', new Set(sigsOf(pack)).size, 3);
    eq('③ 池 0 → 长度 0', M.drawPack([], all(1), { includeOffline: true }).length, 0);
    eq('③ count 0 → 长度 0', M.drawPack(pool(5), all(1), { includeOffline: true, count: 0 }).length, 0);
    eq('③ count 2 → 长度 2', M.drawPack(pool(9), all(1), { includeOffline: true, count: 2 }).length, 2);
}

// ── ④ 离线过滤 ──────────────────────────────────────────────────────────────
{
    // 5 条里 2 条在离线盘（S9），只有 S1/S2/S3 在线
    const src = [
        cover(1, { serial: 'S1' }), cover(2, { serial: 'S2' }), cover(3, { serial: 'S3' }),
        cover(4, { serial: 'S9' }), cover(5, { serial: 'S9' }),
    ];
    const online = new Set(['S1', 'S2', 'S3']);
    let leaked = '';
    for (let round = 0; round < 100; round++) {
        const pack = M.drawPack(src, online, { includeOffline: false });
        if (pack.length !== 3) { leaked = `长度 ${pack.length}`; break; }
        const hit = pack.find(it => it.serial === 'S9');
        if (hit) { leaked = `${hit.sig} 来自离线盘`; break; }
    }
    check('④ 不含离线盘：100 轮不出现离线 serial', leaked === '', leaked);
    eq('④ 含离线盘：池满 5', M.drawPack(src, online, { includeOffline: true }).length, 5);
}

// ── ⑤ 最近抽过的优先排除 ────────────────────────────────────────────────────
{
    const src = pool(12);
    const exclude = new Set(sigsOf(pool(10)));      // 12 条里排除前 10 条
    const pack = M.drawPack(src, all(1), { includeOffline: true, exclude });
    eq('⑤ 排除后仍抽满 5 张', pack.length, 5);
    check('⑤ 优先不含被排除的（应全是 sig11/sig12 里的 2 张 + 补位）',
        pack.filter(it => !exclude.has(it.sig)).length >= 2,
        `无排除命中 ${pack.filter(it => !exclude.has(it.sig)).length}`);
    check('⑤ 同一包内不重复', new Set(sigsOf(pack)).size === pack.length);

    // 极端：池子 3 条全被排除 ⇒ 必须放开补位，不能返回空包
    const tiny = pool(3);
    const allExcluded = new Set(sigsOf(tiny));
    eq('⑤ 池 3 全被排除 → 放开补位给 3 张',
        M.drawPack(tiny, all(1), { includeOffline: true, exclude: allExcluded }).length, 3);
}

// ── ⑥ candidatesOf 去重维度 = sig ───────────────────────────────────────────
{
    const dup = [cover(1), cover(1, { dir: '/other', name: '副本' }), cover(2)];
    const got = M.candidatesOf(dup, all(1), { includeOffline: true });
    eq('⑥ 同 sig 只留一条', got.length, 2);
    eq('⑥ 留的是第一条', got[0].dir, '/d1');
    eq('⑥ 无 sig 的条目被丢', M.candidatesOf([cover(1, { sig: '' })], all(1), { includeOffline: true }).length, 0);
}

// ── ⑦ cardOf / letterMapOf ─────────────────────────────────────────────────
{
    const letters = M.letterMapOf([
        { serial: 'S1', drive: 'C:', online: true },
        { serial: 'S2', drive: 'D:', online: false },   // 离线：盘符可能是别人的，不许用
        { serial: 'S3', drive: '', online: true },
    ]);
    eq('⑦ 在线盘符', letters.get('S1'), 'C');
    eq('⑦ 离线盘不给盘符', letters.get('S2'), undefined);
    eq('⑦ 空盘符不入表', letters.get('S3'), undefined);

    const onlineCard = M.cardOf(cover(7, { size: 2.4 * 1024 ** 3 }), new Set(['S1']), letters);
    eq('⑦ 在线卡 online', onlineCard.online, true);
    eq('⑦ 在线卡 letter', onlineCard.letter, 'C');
    eq('⑦ 卡 key = dir/name', onlineCard.key, '/d7/作品7');
    eq('⑦ 卡 sizeText', onlineCard.sizeText, '2.4 GB');

    const offCard = M.cardOf(cover(8, { serial: 'S9' }), new Set(['S1']), letters);
    eq('⑦ 离线卡 online', offCard.online, false);
    eq('⑦ 离线卡 letter 必须为空', offCard.letter, '');
}

// ── ⑧ 最近记账本上限 ────────────────────────────────────────────────────────
{
    let recent = [];
    for (let i = 0; i < 10; i++) {
        const pack = M.drawPack(pool(50), all(1), { includeOffline: true }).map(c => ({ sig: c.sig }));
        recent = M.rememberRecent(recent, pack);
    }
    eq('⑧ 最多记 3 包（15 个 sig）', recent.length, M.RECENT_PACKS * 5);
}

lines.push('─────────────────────────────');
lines.push(`${pass} PASS / ${fail} FAIL`);
const text = lines.join('\n') + '\n';
fs.writeFileSync(OUT, text, 'utf8');
console.log(text);
process.exit(fail ? 1 : 0);
