/**
 * 真数据探针：验三件事（全程只在临时目录里动**合成/副本**，不碰真库、不碰移动硬盘）。
 *
 *   bash docs/probes/bin-migrate/run.sh
 *
 * ① 迁移：把旧格式（图片以 base64 存在记录里的 v2 记录）搬进 bin 仓 ——
 *    **字节级核对**：迁移前把每条 base64 解出来、迁移后把每个 bin 文件解出来，
 *    按内容去重后**张数与总字节必须完全相等**。
 * ② bin 仓：加解密往返、随机 IV（同一份内容两次写入的密文必须不同）、原子写（不残留 .tmp）。
 * ③ zip：写 → 列 → 取，**字节级往返一致**；外部校验（系统 Expand-Archive）见 run.sh 说明。
 *
 * ⚠️ 素材取自本机 bin 仓里那几张真图（只读），但**被测的是一份合成出来的旧格式库** ——
 *    因为真库会被"就地迁移"（见 entry.ts 的警告），拿它当输入等于这个探针只能跑一次。
 * ⚠️ **必须在 require bundle 之前**把 USERPROFILE 指到临时家目录：bundle 一导入就会
 *    加载并迁移 USERPROFILE 指向的那个库。
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

(async () => {
    const REAL_HOME = process.env.USERPROFILE || process.env.USER;
    const REAL_BIN = path.join(REAL_HOME, '.file-finder', 'bin');

    const out = {};
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-migrate-home-'));
    const dataDir = path.join(tmpHome, '.file-finder');
    fs.mkdirSync(dataDir, { recursive: true });
    const dbPath = path.join(dataDir, 'searchCache.db');

    // ── 取素材：从真 bin 里解出**明文**图（只读本地文件）──
    //    这里就地解一次只为不依赖 bundle 的导入顺序；**核对**那一段用的全是 app 自己的 decryptBlob。
    //    密钥与格式见 electron/utils/cacheCrypto.ts（写死的常量）。
    const KEY = crypto.createHash('sha256').update('file-finder-cache-v1-2026-09-24').digest();
    const plainOf = (f) => {
        const b = fs.readFileSync(path.join(REAL_BIN, f));
        const d = crypto.createDecipheriv('aes-256-cbc', KEY, b.subarray(0, 16));
        return Buffer.concat([d.update(b.subarray(16)), d.final()]);
    };
    const srcFiles = fs.existsSync(REAL_BIN)
        ? fs.readdirSync(REAL_BIN).filter(f => f.startsWith('t-')).slice(0, 20)
        : [];
    const samples = srcFiles.map(plainOf);
    if (!samples.length) {
        console.log(JSON.stringify({ error: '本机 bin 仓里没有素材（先让新构建跑一次扫描）' }, null, 2));
        return;
    }

    // ── 合成一份**旧格式（v2）**的库：图片是记录里的 base64 字段，没有 sig ──
    const v2Docs = samples.map((buf, i) => ({
        _id: 'probe' + i,
        v: 2,
        serial: 'PROBE000',
        relPath: 'probe/' + i,
        mode: 'cover',
        create_at: Date.now(),
        count: 1,
        bytes: buf.length,
        data: [{
            dir: 'probe/' + i,
            name: 'item' + i,
            isDirectory: false,
            ext: 'jpg',
            type: 'image',
            size: buf.length,
            thumb: 'legacy' + i,
            thumbData: 'data:image/jpeg;base64,' + buf.toString('base64'),
            srcMtime: Date.now(),
        }],
    }));
    fs.writeFileSync(dbPath, v2Docs.map(d => JSON.stringify(d)).join('\n') + '\n');
    out['合成旧格式记录数'] = v2Docs.length;
    out['合成旧格式图片字节'] = samples.reduce((a, b) => a + b.length, 0);
    out['合成库大小KB(迁移前)'] = Math.round(fs.statSync(dbPath).size / 1024);

    // ── 现在把"家目录"指到临时目录，再导入 app 自己的模块（导入即触发加载 + 迁移）──
    process.env.USERPROFILE = tmpHome;
    const app = require('./bundle.cjs');
    const { getBin, listBinNames, writeZip, listZip, readZipEntry, putBin, BIN_DIR, readExternalCache } = app;

    // —— 基准：素材按内容去重（bin 是按内容指纹命名的，同内容只留一份，这是设计的一部分）——
    const baselineUniq = new Map();
    for (const b of samples) {
        baselineUniq.set(crypto.createHash('sha1').update(b).digest('hex'), b.length);
    }
    const beforeSum = [...baselineUniq.values()].reduce((a, b) => a + b, 0);
    out['去重前的图数'] = samples.length;
    out['去重后的图数'] = baselineUniq.size;

    // —— 等迁移跑完 ——
    // ⚠️ 别去明文搜库文件：库是**逐行加密**的，搜 'thumbData' 永远搜不到
    //    （第一版就这么错了，结果"1 秒就迁完"——其实是它压根没等）。
    // 改用"数到不再增长且稳定下来"：迁移在写图片，写完才轮到重载。
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const t0 = Date.now();
    let last = -1, stableFor = 0;
    while (Date.now() - t0 < 120000) {
        await sleep(600);
        const n = listBinNames().length;
        stableFor = n === last && n > 0 ? stableFor + 1 : 0;
        last = n;
        if (stableFor >= 4) break;    // 连续不再增加 = 迁移与重载都结束了
    }
    out['迁移耗时秒'] = Math.round((Date.now() - t0) / 1000);

    // —— ① 字节级核对 ——
    let afterBytes = 0, afterCount = 0, decryptFail = 0;
    for (const n of listBinNames()) {
        if (!n.startsWith('t-')) continue;
        const buf = getBin(n);
        if (!buf) { decryptFail++; continue; }
        afterBytes += buf.length;
        afterCount++;
    }
    out['迁移后 缩略图张数'] = afterCount;
    out['迁移后 图片总字节'] = afterBytes;
    out['①张数一致(按内容去重)'] = afterCount === baselineUniq.size;
    out['①总字节一致(按内容去重)'] = afterBytes === beforeSum;
    out['①解密失败'] = decryptFail;
    out['库文件大小MB(迁移后)'] = Math.round(fs.statSync(dbPath).size / 1024 / 1024);

    // —— ①b 用 app 自己的读取器把迁移后的库读回来：不该再有任何 base64 字段、都该有 sig ——
    const docs = await readExternalCache(dbPath);
    let stillBase64 = 0, withSig = 0, withSrcMtime = 0;
    for (const doc of docs) {
        for (const it of doc.data || []) {
            if (it.thumbData || it.avatarThumbData) stillBase64++;
            if (it.sig) withSig++;
            if (it.srcMtime) withSrcMtime++;
        }
    }
    out['①b库里残留的 base64 字段'] = stillBase64;
    out['①b带 sig 的条目数'] = withSig;
    out['①b带 srcMtime 的条目数'] = withSrcMtime;
    out['①b迁移后版本号'] = [...new Set(docs.map(d => d.v))];

    // —— ② bin 仓：随机 IV + 原子写 + 往返 ——
    const probeName = 't-' + 'a'.repeat(40) + '.enc';
    await putBin(probeName, Buffer.from('hello-图片'));
    const one = fs.readFileSync(path.join(BIN_DIR, probeName));
    await putBin(probeName, Buffer.from('hello-图片'));
    const two = fs.readFileSync(path.join(BIN_DIR, probeName));
    out['②往返一致'] = getBin(probeName).toString() === 'hello-图片';
    out['②两次密文不同(随机IV)'] = !one.equals(two);
    out['②无 .tmp 残留'] = fs.readdirSync(BIN_DIR).filter(f => f.includes('.tmp-')).length === 0;

    // —— ③ zip：写 → 列 → 取 ——
    const zipPath = path.join(tmpHome, 'backup.zip');
    const names = listBinNames();
    const entries = [
        { name: 'searchCache.db', file: dbPath },
        ...names.slice(0, 5).map(n => ({ name: 'bin/' + n, file: path.join(BIN_DIR, n) })),
    ];
    const total = await writeZip(zipPath, entries);
    const listed = await listZip(zipPath);
    out['③zip 条目数'] = listed.length;
    out['③zip 体积MB'] = Math.round(fs.statSync(zipPath).size / 1024 / 1024);
    const first = listed.find(e => e.name.startsWith('bin/'));
    out['③取出内容与磁盘一致'] = first
        ? (await readZipEntry(zipPath, first)).equals(fs.readFileSync(path.join(BIN_DIR, first.name.slice(4))))
        : null;
    out['③写出总字节'] = total;
    // ⚠️ **不要把 tmpHome 写进输出**：它是系统临时目录（路径里带当前用户名），
    //   属于「真机目录名 + 用户名」，入库即违反仓库的脱敏标准（真实案例）。
    //   需要那个 zip 的话它已经写在临时目录的 `ff-migrate-zip-path.txt` 里了。

    // run.sh 的第 3 步要用它（只写路径，不要去 grep JSON）
    // 路径写到**系统临时目录**而不是探针目录：它是每次跑都会变的**中转产物**，
// 落进仓库只会被误当成"结论"提交（.gitignore 兜底不如根本别落在这儿）。
fs.writeFileSync(path.join(os.tmpdir(), 'ff-migrate-zip-path.txt'), zipPath, 'utf8');
    console.log(JSON.stringify(out, null, 2));
})().catch(e => { console.error('PROBE FAILED:', e); process.exit(1); });
