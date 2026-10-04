/**
 * P0 探针：用**真库里的真缩略图**实测"缩略图该定多大"。
 *
 *   bash docs/probes/thumb-tier/run.sh
 *
 * 为什么必须用真库而不是合成图：JPEG 体积与画面内容强相关（渐变小、噪点大），
 * 合成图给出的体积会明显偏乐观。库里的 `thumbData` 就是**他自己那批封面**编码出的
 * 480px / q82 JPEG —— 拿它当输入，量出来的数字才有资格用来定档。
 *
 * 为什么用 Electron 的 nativeImage 而不是 ffmpeg：app 里编码缩略图用的就是
 * `nativeImage.resize().toJPEG()`（`electron/utils/thumbnail.ts`），同一个编码器量出来的
 * 体积才是 app 会得到的体积。
 *
 * 为什么零移动硬盘读：只读本地库文件（`.file-finder/searchCache.db`），
 * 媒体盘一个字节都不碰。
 */
const { app, nativeImage, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

// 与 electron/server/nedb.ts 逐字一致的加解密（固定密钥 + 固定 IV + base64）
const CACHE_KEY = crypto.createHash('sha256').update('file-finder-cache-v1-2026-09-24').digest();
const CACHE_IV = Buffer.alloc(16, 0);
function decryptLine(line) {
    if (line.startsWith('{')) return line;      // 明文行放行（库自己的兼容规则）
    const d = crypto.createDecipheriv('aes-256-cbc', CACHE_KEY, CACHE_IV);
    return Buffer.concat([d.update(Buffer.from(line, 'base64')), d.final()]).toString('utf8');
}

/** 候选档位：width = 长边上限（只缩不放），q = 与 app 同一个 toJPEG 的质量参数 */
const TIERS = [
    { name: '480/q82（现状）', width: 480, q: 82 },
    { name: '384/q78', width: 384, q: 78 },
    { name: '360/q75', width: 360, q: 75 },
    { name: '320/q72', width: 320, q: 72 },
];

const SAMPLE = 400;   // 抽样上限（够看出分布，又不至于跑几分钟）

function stats(list) {
    if (!list.length) return null;
    const s = [...list].sort((a, b) => a - b);
    const at = p => s[Math.min(s.length - 1, Math.floor(p * s.length))];
    const mean = s.reduce((a, b) => a + b, 0) / s.length;
    return { n: s.length, min: s[0], p50: at(0.5), p90: at(0.9), max: s[s.length - 1], mean: Math.round(mean) };
}

app.whenReady().then(() => {
    const dbPath = path.join(os.homedir(), '.file-finder', 'searchCache.db');
    if (!fs.existsSync(dbPath)) {
        console.log(JSON.stringify({ error: '找不到缓存库（%USERPROFILE%\\.file-finder\\searchCache.db）' }, null, 2));
        app.exit(1);
        return;
    }

    const lines = fs.readFileSync(dbPath, 'utf8').split('\n').filter(Boolean);
    let docs = 0, items = 0, bad = 0;
    /** 收集所有缩略图（含目录的脸） */
    const thumbs = [];
    /** 条目类型分布 + 各类型里"有图"的数量 —— 决定大图那部分的体积 */
    const byType = {};
    for (const line of lines) {
        let doc;
        try { doc = JSON.parse(decryptLine(line)); } catch { bad++; continue; }
        if (!doc || !Array.isArray(doc.data)) continue;
        docs++;
        for (const it of doc.data) {
            items++;
            const t = it.type || '?';
            byType[t] = byType[t] || { 条目: 0, 有缩略图: 0 };
            byType[t].条目++;
            if (it.thumbData) byType[t].有缩略图++;
            for (const key of ['thumbData', 'avatarThumbData']) {
                const uri = it[key];
                if (typeof uri === 'string' && uri.startsWith('data:image/')) {
                    thumbs.push(uri.slice(uri.indexOf(',') + 1));
                }
            }
        }
    }

    const step = Math.max(1, Math.floor(thumbs.length / SAMPLE));
    const sample = thumbs.filter((_, i) => i % step === 0).slice(0, SAMPLE);

    const perTier = {};
    for (const t of TIERS) perTier[t.name] = [];
    const srcDim = [];
    const b64Sizes = [];
    let decodeFail = 0;

    for (const b64 of sample) {
        b64Sizes.push(b64.length);
        const img = nativeImage.createFromBuffer(Buffer.from(b64, 'base64'));
        if (img.isEmpty()) { decodeFail++; continue; }
        const { width, height } = img.getSize();
        srcDim.push(`${width}x${height}`);
        for (const t of TIERS) {
            const scaled = width > t.width ? img.resize({ width: t.width, quality: 'good' }) : img;
            perTier[t.name].push(scaled.toJPEG(t.q).length);
        }
    }

    const tierReport = {};
    for (const t of TIERS) {
        const st = stats(perTier[t.name]);
        tierReport[t.name] = st && { ...st, kb: Math.round(st.mean / 1024) };
    }

    const total = items;
    const out = {
        // ⚠️ 只报**占位路径 + 字节数**，绝不报 dbPath：真实路径含用户名与真机目录名，
        //   入库即违反仓库的脱敏标准（真实案例：这里曾经直接打出 C://Users//<用户名>//…）。
        库: '%USERPROFILE%\\.file-finder\\searchCache.db',
        库字节: fs.statSync(dbPath).size,
        库文件大小MB: Math.round(fs.statSync(dbPath).size / 1024 / 1024),
        记录数: docs,
        条目数: items,
        '条目类型分布': byType,
        解不开的行: bad,
        '缩略图总数(含脸)': thumbs.length,
        抽样数: sample.length,
        抽样解码失败: decodeFail,
        '本机 dpr': screen.getPrimaryDisplay().scaleFactor,
        '本机主屏(物理)': `${screen.getPrimaryDisplay().size.width}x${screen.getPrimaryDisplay().size.height}`,
        '库里 base64 平均(KB)': Math.round(b64Sizes.reduce((a, b) => a + b, 0) / b64Sizes.length / 1024),
        '库里 base64 去掉税后(KB)': Math.round((b64Sizes.reduce((a, b) => a + b, 0) / b64Sizes.length) * 0.75 / 1024),
        各档位实测字节: tierReport,
        源缩略图尺寸示例: srcDim.slice(0, 3),
        '全库外推MB(按均值×缩略图总数)': Object.fromEntries(
            Object.entries(tierReport).map(([k, v]) => [k, v ? Math.round((v.mean * thumbs.length) / 1024 / 1024) : null]),
        ),
    };
    console.log(JSON.stringify(out, null, 2));
    app.exit(0);
});
