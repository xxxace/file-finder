/**
 * 「写盘与解码重叠」这个改动的 A/B 探针 —— 只量自己，不改主人的任何数据。
 *
 *   env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe \
 *       docs/probes/perf-tick/pipeline.cjs
 *
 * 验两件事（缺一不可）：
 *   ① **产出完全一致**：A（串行等写完）与 B（登记不等待、最后统一等）跑同一批素材，
 *      产出的**文件名集合 + 每个文件内容的 sha1 集合**必须逐项相同 ——
 *      时序改了而结果没变，这才叫"没改坏"。
 *   ② **B 确实更快**：B 的墙钟应明显低于 A。
 *
 * 为什么需要 Electron：被测的 `imageRenditions` 用 `nativeImage` 解码/缩放。
 * 素材取自**本机 bin 仓**（系统盘，只读）—— 用 app 自己存出来的缩略图当"源图"，
 * 格式与体积都与真实封面同阶。**不读移动硬盘。**
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { app } = require('electron');

const REAL_HOME = process.env.USERPROFILE || process.env.USER;
const REAL_BIN = path.join(REAL_HOME, '.file-finder', 'bin');
const KEY = crypto.createHash('sha256').update('file-finder-cache-v1-2026-09-24').digest();
const dec = b => { const d = crypto.createDecipheriv('aes-256-cbc', KEY, b.subarray(0, 16)); return Buffer.concat([d.update(b.subarray(16)), d.final()]); };

app.whenReady().then(async () => {
    // ① 取素材并写成临时 .jpg（imageRenditions 收的是**路径**）
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-pipe-home-'));
    const srcDir = path.join(tmpHome, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
    const tFiles = fs.readdirSync(REAL_BIN).filter(f => f.startsWith('t-')).slice(0, 40);
    if (!tFiles.length) { console.log(JSON.stringify({ error: '真 bin 仓里没有 t- 素材' })); setTimeout(() => app.exit(0), 200); return; }
    const srcs = tFiles.map((f, i) => {
        const p = path.join(srcDir, `s${String(i).padStart(3, '0')}.jpg`);
        fs.writeFileSync(p, dec(fs.readFileSync(path.join(REAL_BIN, f))));
        return p;
    });

    // ② 之后才设 USERPROFILE 并 import：binStore 会把图片写进这个临时 home
    //    （binStore 的目录在**模块加载时**由 config 读 USERPROFILE 决定，所以顺序不能换）
    process.env.USERPROFILE = tmpHome;
    const { imageRenditions } = require('./bundle-electron.cjs');
    const { putBin, initBinStore, BIN_DIR } = require('./bundle-electron.cjs');
    await initBinStore();

    const now = () => process.hrtime.bigint();
    const since = a => Number(now() - a) / 1e6;
    const sha1 = b => crypto.createHash('sha1').update(b).digest('hex');

    /** 把一个源跑成两张图（照抄 makeRenditions 的规则：sig 锚缩略图，两个尺寸共用） */
    async function renditionsOf(p) {
        const r = await imageRenditions(p);
        const anchor = r.thumb ?? r.preview;
        if (!anchor) return '';
        return { sig: sha1(anchor), thumb: r.thumb, preview: r.preview };
    }

    /** A：现在的老写法（每条都等写完） */
    async function serial() {
        const t0 = now();
        for (const p of srcs) {
            const r = await renditionsOf(p);
            if (!r) continue;
            if (r.thumb) await putBin(`t-${r.sig}.enc`, r.thumb);
            if (r.preview) await putBin(`p-${r.sig}.enc`, r.preview);
            await new Promise(r2 => setImmediate(r2));
        }
        return since(t0);
    }

    /** B：现在的写法（登记不等待 + 末尾统一等） */
    async function pipelined() {
        const t0 = now();
        const pending = [];
        for (const p of srcs) {
            const r = await renditionsOf(p);
            if (!r) continue;
            if (r.thumb) pending.push(putBin(`t-${r.sig}.enc`, r.thumb));
            if (r.preview) pending.push(putBin(`p-${r.sig}.enc`, r.preview));
            await new Promise(r2 => setImmediate(r2));
        }
        await Promise.all(pending);
        return since(t0);
    }

    /**
     * 当前 bin 目录的"内容真相"：文件名 → **明文**的 sha1。
     *
     * ⚠️ 判据必须在**明文**上，不能直接哈希文件字节：`putBin` 每次写都用**随机 IV** 加密
     * （那是刻意的安全设计），所以同一份明文两次写出的密文必然不同 ——
     * 直接比文件字节会得出"两次产出不同"的假结论（第一版就踩了这个，跟那次
     * "拿 base64 字符长度当图片大小"是同一类错：**判据落在了错误的层**）。
     */
    const snapshot = () => {
        const out = {};
        for (const f of fs.readdirSync(BIN_DIR).filter(f => f.endsWith('.enc'))) {
            out[f] = sha1(dec(fs.readFileSync(path.join(BIN_DIR, f))));
        }
        return out;
    };

    // ⚠️ **必须多轮**：第一版只跑一次，串行那次量到 683ms、第二次 363ms（差 2 倍）——
    //   Windows 文件系统 + Defender 的抖动让单次测量毫无意义。交替跑，取分布。
    const ROUNDS = 7;
    const As = [], Bs = [];
    let snapA = {}, snapB = {};
    for (let i = 0; i < ROUNDS; i++) {
        As.push(await serial());
        snapA = snapshot();
        Bs.push(await pipelined());
        snapB = snapshot();
    }
    const dist = xs => {
        const s2 = [...xs].sort((a, b) => a - b);
        return { 中位: +s2[Math.floor(s2.length / 2)].toFixed(0), 最小: +s2[0].toFixed(0), 最大: +s2[s2.length - 1].toFixed(0), 全部: xs.map(Math.round) };
    };
    const medA = [...As].sort((a, b) => a - b)[Math.floor(ROUNDS / 2)];
    const medB = [...Bs].sort((a, b) => a - b)[Math.floor(ROUNDS / 2)];

    const sameNames = JSON.stringify(Object.keys(snapA).sort()) === JSON.stringify(Object.keys(snapB).sort());
    const sameBytes = sameNames && Object.keys(snapA).every(k => snapA[k] === snapB[k]);

    const text = JSON.stringify({
        素材张数: srcs.length,
        轮数: ROUNDS,
        每张产出: 't- 与 p- 两个文件',
        'A串行等写完': dist(As),
        'B登记不等待': dist(Bs),
        '中位数之比_B比A快多少倍': +(medA / medB).toFixed(2),
        '产出文件名一致': sameNames,
        '产出明文逐字节一致': sameBytes,
        产出文件数: Object.keys(snapB).length,
        // ⚠️ 不打 tmpHome（含用户名/真机路径）—— 见 bin-migrate/probe.cjs 同样的理由。
    }, null, 2);
    // ⚠️ **写文件而不是只 console.log**：`app.exit()` 是立即退出，Electron 主进程里
    //   stdout 常常还没 flush 就被砍掉 ⇒ 探针"跑完了但什么都没打印"（踩过一次）。
    fs.writeFileSync(path.join(__dirname, 'out-pipeline.txt'), text, 'utf8');
    console.log(text);
    setTimeout(() => app.exit(0), 200);
}).catch(e => {
    const msg = 'PROBE FAILED: ' + (e && e.stack || e);
    try { fs.writeFileSync(path.join(__dirname, 'out-pipeline.txt'), msg, 'utf8'); } catch { }
    console.error(msg);
    setTimeout(() => app.exit(1), 200);
});
