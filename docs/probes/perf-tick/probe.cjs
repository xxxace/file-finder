/**
 * 图片链路性能探针 —— 只量数字，不改主人的任何数据。
 *
 *   node docs/probes/perf-tick/probe.cjs read    # 量「读」（USERPROFILE 指向真数据目录，只读）
 *   node docs/probes/perf-tick/probe.cjs write   # 量「写」（USERPROFILE 指向临时目录）
 *
 * 为什么分成两个进程：`getBin` 读的是 `binStore.BIN_DIR`，而那个目录由 `USERPROFILE` 决定。
 * 想量真仓的读，就必须让 USERPROFILE 指着真 home —— 于是**同一个进程里不能同时写**
 * （会往主人的仓里塞 432 个垃圾文件）。拆开就没有这种风险。
 *
 * ⚠️ 必须在 require bundle 之前设好 USERPROFILE：`electron/config` 是模块加载时读它的。
 * ⚠️ 只碰**系统盘**上的 bin 仓 ⇒ 零移动硬盘读。
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const mode = process.argv[2];                       // 'read' | 'write'
const REAL_HOME = process.env.USERPROFILE || process.env.USER;
const REAL_BIN = path.join(REAL_HOME, '.file-finder', 'bin');

if (mode === 'write') {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-perf-home-'));
    fs.mkdirSync(path.join(tmpHome, '.file-finder'), { recursive: true });
    process.env.USERPROFILE = tmpHome;
} else if (mode === 'writebreak') {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-perf-home-'));
    fs.mkdirSync(path.join(tmpHome, '.file-finder'), { recursive: true });
    process.env.USERPROFILE = tmpHome;
} else if (mode !== 'read') {
    console.error('用法：node probe.cjs read | write | writebreak');
    process.exit(1);
}

const app = require('./bundle-node.cjs');
const { getBin, putBin, initBinStore, listBinNames, BIN_DIR } = app;

const now = () => process.hrtime.bigint();
const since = a => Number(now() - a) / 1e6;

/** 分布统计：中位数才是"典型"，p95/max 才是"最坏那一帧会不会卡界面" */
function stat(xs) {
    const s = [...xs].sort((a, b) => a - b);
    const at = q => +s[Math.min(s.length - 1, Math.floor(s.length * q))].toFixed(3);
    return { n: s.length, 中位: at(0.5), p95: at(0.95), max: +s[s.length - 1].toFixed(3), 合计毫秒: +s.reduce((a, b) => a + b, 0).toFixed(1) };
}

(async () => {
    await initBinStore();

    if (mode === 'writebreak') {
        // 只读真仓里的一张 23 KB 缩略图当素材（**只读**，不写真仓）
        const real = fs.readdirSync(REAL_BIN).find(f => f.startsWith('t-'));
        const sample = fs.readFileSync(path.join(REAL_BIN, real));
        const { encryptBlob } = app;
        const N = 200;
        const tmp = path.join(BIN_DIR, 'x.enc');

        // A) 只加密，不落盘
        const onlyCrypt = [];
        for (let i = 0; i < N; i++) { const a = now(); encryptBlob(sample); onlyCrypt.push(since(a)); }

        // B) 加密 + writeFile（**不 rename**）
        const noRename = [];
        for (let i = 0; i < N; i++) {
            const a = now();
            await fs.promises.writeFile(tmp, encryptBlob(sample));
            noRename.push(since(a));
        }

        // C) 加密 + writeFile + rename（= 现在 putBin 的做法）
        const withRename = [];
        for (let i = 0; i < N; i++) {
            const a = now();
            const t2 = tmp + '.p';
            await fs.promises.writeFile(t2, encryptBlob(sample));
            await fs.promises.rename(t2, tmp);
            withRename.push(since(a));
        }

        // D) 并发 8 个（encrypt+write+rename 同时进行）
        const t3 = now();
        await Promise.all(Array.from({ length: N }, (_, i) => putBin(
            `p-${String(i).padStart(40, '0')}.enc`, sample)));
        const parTotal = since(t3);

        // E) 串行 200 次 putBin（= 现在一屏 432 次的同款）
        const t4 = now();
        for (let i = 0; i < N; i++) await putBin(`q-${String(i).padStart(40, '0')}.enc`, sample);
        const seqTotal = since(t4);

        return void console.log(JSON.stringify({
            模式: 'writebreak', 素材KB: +(sample.length / 1024).toFixed(1), 次数: N,
            'A只加密': stat(onlyCrypt),
            'B加密加write': stat(noRename),
            'C加密加write加rename': stat(withRename),
            'D并发432次_putBin_总毫秒': +parTotal.toFixed(1),
            'D并发单次均摊毫秒': +(parTotal / N).toFixed(3),
            'E串行200次_putBin_总毫秒': +seqTotal.toFixed(1),
            'E串行单次均摊毫秒': +(seqTotal / N).toFixed(3),
            '结论_并发比串行快多少倍': +(seqTotal / parTotal).toFixed(2),
        }, null, 2));
    }

    if (mode === 'write') {
        // 素材：从临时目录…没有 ⇒ 造一小段假数据。**加密成本与图片大小同阶**，
        // 所以素材必须接近真实缩略图体积（实测均值 23 KB），否则量出来的写盘偏乐观。
        const sample = Buffer.alloc(23 * 1024, 7);
        const N = 432;                                // 一屏 216 个条目 × 2 个尺寸
        const wr = [];
        for (let i = 0; i < N; i++) {
            const a = now();
            await putBin(`t-${String(i).padStart(40, '0')}.enc`, sample);
            wr.push(since(a));
        }
        const files = fs.readdirSync(BIN_DIR);
        return void console.log(JSON.stringify({
            模式: 'write', 次数: N, 单次: stat(wr),
            落盘文件数: files.length,
            残留tmp: files.filter(f => f.includes('.tmp-')).length,
        }, null, 2));
    }

    // ── read 模式：量真仓 ──────────────────────────────────────────────
    const names = listBinNames();
    if (!names.length) {
        return void console.log(JSON.stringify({ error: '真 bin 仓是空的（先让 app 跑一次扫描）' }, null, 2));
    }
    const bytes = names.reduce((n, f) => n + fs.statSync(path.join(BIN_DIR, f)).size, 0);

    // ① 同一个文件反复取 200 次 = **全命中 OS 页缓存**（模拟"重复点开同一张"）
    const hot = [];
    for (let i = 0; i < 200; i++) { const a = now(); getBin(names[0]); hot.push(since(a)); }

    // ② 一屏那么多：216 个**不同**文件各取一次（第一次摸它们各自的 inode 位置）
    const oneScreen = names.slice(0, 216);
    const cold = [];
    for (const n of oneScreen) { const a = now(); getBin(n); cold.push(since(a)); }

    // ③ 交替访问（网格滚动/来回翻的形态）：每张取两次，第二次必然命中页缓存
    const alt = [];
    for (const n of oneScreen) { getBin(n); const a = now(); getBin(n); alt.push(since(a)); }

    console.log(JSON.stringify({
        模式: 'read',
        仓内文件数: names.length,
        仓内总MB: +(bytes / 1048576).toFixed(1),
        '①同一文件×200(全热)': stat(hot),
        '②一屏216张×各一次(冷)': stat(cold),
        '③每张第二次取(页缓存命中)': stat(alt),
    }, null, 2));
})().catch(e => { console.error('PROBE FAILED:', e); process.exit(1); });

/**
 * 追加：写盘的两个分解实验（回答"3.1ms 花在哪、并发有没有用"）。
 * 用法：node probe.cjs writebreak
 */
