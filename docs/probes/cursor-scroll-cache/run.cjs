/**
 * 无头 Electron 探针 · 滚动 + 懒加载会不会让行结构探测出错
 * ==============================================================================
 *   bash docs/probes/cursor-scroll-cache/run.sh
 *
 * 验什么：业主 2026-10-04 二次报「长按方向键，**到底部几行**就行为错乱，
 * 要么不动、要么和预期不一样；但**刚开始上半部分是正常的**」。
 *
 * ## 关键怀疑：缓存失效粒度（这是上一轮 `cursor-scale-row` 没覆盖的另一半）
 *
 * `useGridCursor.ts` 里：
 *   - `layoutCache = { rows, rowTops }`
 *   - `probeLayout()` 的早退条件是 **`layoutCache.rowTops.length`**（`:189`）
 *   - `invalidateRowTops()`（滚动时）**只把 rowTops 清空**（`:170`）
 *
 * ⇒ **滚动会让整个缓存失效并重新探测**，而重新探测那一刻
 * **焦点格正带着 `transform: scale(1.012)`** ⇒ 它又被 `groupRows` 劈成单独一行。
 *
 * ## 为什么这解释「上半部分正常、底部错乱」
 *
 * 视口高600px ≈ 1.95 行 ⇒ 头两行**在视口内**、按↓ 不需要滚动
 * ⇒ `scroll` 事件不触发 ⇒ 缓存不失效 ⇒ `rows` 保持**上一次探测时的结构**。
 * 而"上一次探测"往往发生在焦点格**还没被抬起**的时候（首次进入/刚滚动完的稳定态）
 * ⇒ 上半部分行数是对的。
 *
 * 一旦**长按到底部**，`scrollIntoView` 开始反复滚动 ⇒ 每次滚动都让缓存失效
 * ⇒ 每次重新探测都撞上"焦点格正被抬起" ⇒ `rows` 被劈开
 * ⇒ 从此 `stepPos` 拿着错位的行列 ⇒ **不动 / 乱跳**。
 *
 * 输出不含任何真实路径 / 用户名 / 盘序列号。
 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const os = require('node:os');

app.setPath('userData', path.join(os.tmpdir(), 'probe-cursor-scroll-cache'));
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.disableHardwareAcceleration();

/** 与 gridGeometry.ts 的 ROW_EPS 同值 */
const ROW_EPS = 1;

let pass = 0, fail = 0;
const check = (label, cond, detail) => {
    console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '   → ' + detail : ''}`);
    if (cond) pass++; else fail++;
};

/** 复刻 groupRows 的分行判据（同一份：|top − base| > EPS ⇒ 换行） */
const splitRows = (cells) => {
    const rows = [];
    let base = Number.NaN;
    for (const c of cells) {
        if (rows.length === 0 || Math.abs(c.top - base) > ROW_EPS) {
            rows.push([c.key]);
            base = c.top;
        } else {
            rows[rows.length - 1].push(c.key);
        }
    }
    return rows;
};

/** 复刻 stepPos（到边界停住、不环绕）—— 与 gridGeometry.ts 一致 */
const stepPos = (rows, from, dir) => {
    const delta = { up: [-1, 0], down: [1, 0], left: [0, -1], right: [0, 1] }[dir];
    const next = { r: from.r + delta[0], c: from.c + delta[1] };
    const bad = next.r < 0 || next.r >= rows.length
        || next.c < 0 || next.c >= rows[next.r].length;
    return bad ? from : next;
};

app.whenReady().then(async () => {
    const win = new BrowserWindow({
        show: false, width: 2100, height: 700,
        webPreferences: { contextIsolation: false, backgroundThrottling: false, offscreen: true },
    });
    win.webContents.on('console-message', () => {});
    await win.loadFile(path.join(__dirname, 'index.html'));
    await new Promise(r => setTimeout(r, 700));

    const run = (js) => win.webContents.executeJavaScript(js).catch(e => 'ERR: ' + String(e));
    const N = 60;                     // 60 格 = 10 行（6列），足够长到需要滚动
    await run(`__build(${N})`);
    await new Promise(r => setTimeout(r, 400));

    // ───────────────── S1 · 场景前提：底部真的存在吗 ─────────────────
    console.log('—— S1 前提：视口装不下 10 行吗 ——');
    const si = await run('__scrollInfo()');
    console.log(`  scrollHeight=${si.scrollHeight} clientHeight=${si.clientHeight} maxScroll=${si.maxScroll}px`);
    const rowsTotal = Math.ceil(N / 6);
    const rowsInView = si.clientHeight / (1.5 * 204.8);
    console.log(`  共 ${rowsTotal} 行，视口 ≈ ${rowsInView.toFixed(2)} 行`);
    check('★ 视口装不下全部行（所以长按到底必然要滚动）',
        si.maxScroll > 0 && rowsInView < rowsTotal, `maxScroll=${si.maxScroll}px`);
    check('★ 视口只装得下约 2 行（对应主人说的"上半部分正常、底部才错"）',
        rowsInView < 2.5, `${rowsInView.toFixed(2)} 行`);

    // ───────────────── S2 · 懒加载会不会改变行的 top ─────────────────
    console.log('\n—— S2 懒加载：图片到达会不会改变行结构 ——');
    await run('__setCursor(-1)');
    await new Promise(r => setTimeout(r, 400));
    const beforeLoad = await run('__measure()');
    const rowsBefore = splitRows(beforeLoad);
    await run('__loadImages(true)');
    await new Promise(r => setTimeout(r, 500));
    const afterLoad = await run('__measure()');
    const rowsAfter = splitRows(afterLoad);
    const rowH = 1.5 * 204.8;
    let maxDrift = 0;
    for (let i = 0; i < beforeLoad.length; i++) {
        maxDrift = Math.max(maxDrift, Math.abs(afterLoad[i].offsetTop - beforeLoad[i].offsetTop));
    }
    console.log(`  加载前 ${rowsBefore.length} 行，加载后 ${rowsAfter.length} 行；offsetTop 最大漂移 = ${maxDrift}px`);
    check('★ 懒加载图片到达**不改变** offsetTop（行高被 !important 钉死）',
        maxDrift < 0.5, `${maxDrift.toFixed(3)}px`);
    check('★ 懒加载图片到达**不改变**行结构', rowsAfter.length === rowsBefore.length,
        `${rowsBefore.length} → ${rowsAfter.length}`);

    // ───────────────── S3 · 核心：缓存生命周期决定了对错 ─────────────────
    // 真实运行时代码走的是**缓存**，这一点决定了对错的时机：
    // `probeLayout` 的早退条件是 `layoutCache.rowTops.length`（useGridCursor.ts:189）
    // ⇒ 只要 rowTops 非空就**整块复用**（连 rows 也不重算）。
    // 只有 `invalidateRowTops`（滚动时）把 rowTops 清空，才会重新探测。
    console.log('\n—— S3 核心：直接重新探测 vs 走缓存 ——');
    await run('__setCursor(4)');
    await new Promise(r => setTimeout(r, 500));
    const infoA = await run('__scrollInfo()');
    const measA = await run('__measure()');
    const rowsA = splitRows(measA);
    console.log(`  焦点 k4 可见、scrollTop=${infoA.scrollTop}（**未滚动**），此刻直接重新探测：`);
    console.log(`行结构 = ${rowsA.map(r => r.length).join('/')}`);
    // ⚠️ 这条是整份分析的关键：**即使完全不滚动**，只要重新探测就一定脏。
    //    ⇒ "上半部分正常"不可能靠"不滚动"解释，只能靠**缓存根本没有重新探测**。
    check('★ 只要重新探测，即使完全不滚动，行结构也已经错了',
        rowsA.length !== 10 || rowsA.some(r => r.length !== 6),
        `${rowsA.length} 行：${rowsA.map(r => r.length).join('/')}`);

    // ───────────────── S3 · 核心：缓存生命周期决定了对错 ─────────────────
    // 上面的 A/B 都是"直接重新探测"，而真实运行时代码走的是**缓存**。
    // `probeLayout` 的早退条件是 `layoutCache.rowTops.length`（useGridCursor.ts:189）
    // ⇒ 只要 rowTops 非空就**整块复用**（连 rows 也不重算）⇒ 不受"焦点格被抬起"影响。
    // 只有 `invalidateRowTops`（滚动时）把 rowTops 清空，才会重新探测 ⇒ 那时才撞上抬起。
    console.log('\n—— S3 核心：缓存生命周期决定了对错（复刻 useGridCursor 的缓存逻辑）——');

    // 复刻：probeLayout + invalidateRowTops + focusCursor（只保留与几何有关的部分）
    const makeCacheModel = () => {
        let cache = null;                 // null =还没探过
        let onScroll = () => { if (cache) cache.rowTops = []; };
        let probe = (cells) => {
            if (cache && cache.rowTops.length) return cache;   // 早退：整块复用
            const rows = splitRows(cells);
            cache = { rows, rowTops: rows.map(r => cells.find(c => c.key === r[0]).top) };
            return cache;
        };
        return { probe, onScroll, reset: () => { cache = null; } };
    };

    // 真值：正确的行结构（6 列 × 10 行）
    const truth = Array.from({ length: 10 }, (_, r) =>
        Array.from({ length: 6 }, (_, c) => `k${r * 6 + c}`));
    const isTruth = (rows) => JSON.stringify(rows) === JSON.stringify(truth);

    /** 在行结构里找 key 的坐标。找不到 null。（与 gridGeometry.posOf 同逻辑） */
    const posIn = (rows, key) => {
        for (let r = 0; r < rows.length; r++) {
            const c = rows[r].indexOf(key);
            if (c >= 0) return { r, c };
        }
        return null;
    };

    /**
     * 复刻 `useGridCursor` 的真实调用序列，模拟"长按 ↓"。
     *
     * ⚠️⚠️ **首探时机是这个探针的全部重点**：
     *真实时序是
     *   第1 次按键 → `moveCursor` → `probeLayout()` —— **此刻 cursorKey 还是空**
     *              ⇒ 屏幕上**没有任何 .cursor** ⇒ 探测干净 ⇒ 缓存住干净结构
     *   → `posOf('')` = null → `activateCursor()` → 焦点落到视口第一行
     *   第2..N 次按键 → 缓存命中（rowTops 非空）⇒ **一直用干净结构** ⇒ 走对
     *   一旦 `scrollIntoView` 真的滚动了 → `invalidateRowTops` → rowTops 清空
     *              → 下次按键**重新探测**，而**此时焦点格正带着 scale** ⇒ 探测变脏
     *
     * ⇒这才是「**上半部分正常、到底部才错乱**」的机制。
     */
    const STEPS = 26;
    const simulate = async (useOffsetTop) => {
        const m = makeCacheModel();
        await run('__setCursor(-1)');                 // 起点：cursorKey 为空
        await new Promise(r => setTimeout(r, 400));
        let cursor = null;                            // null = 未激活
        const log = [];
        for (let step = 0; step < STEPS; step++) {
            // ⚠️ 每步只做**一次**跨进程调用：本项目的 executeJavaScript 单次往返约 15ms，
            //    26 步 × 4 次 ≈ 1.5s 尚可，但加上转场等待会顶到超时 ⇒ 合并。
            const batch = await run(`(() => {
                const box = document.getElementById('box');
                const cells = Array.from(box.querySelectorAll('.image-box-item')).map(el => ({
                    key: el.dataset.key,
                    top: ${useOffsetTop ? 'el.offsetTop' : 'el.getBoundingClientRect().top'},
                }));
                return { cells, scrollTop: box.scrollTop };
            })()`);

            const { rows } = m.probe(batch.cells);
            const rowsOk = isTruth(rows);

            if (cursor === null) {
                // posOf('') = null ⇒ activateCursor ⇒ 落"视口第一行第一格"
                const first = rows[0][0];
                cursor = Number(first.slice(1));
                await run(`__setCursor(${cursor})`);
                log.push({ step, ok: true, act: 'activate→' + first, rowsOk });
                continue;
            }
            let at = null;
            for (let r = 0; r < rows.length; r++) {
                const c = rows[r].indexOf('k' + cursor);
                if (c >= 0) { at = { r, c }; break; }
            }
            if (!at) { log.push({ step, ok: false, why: '焦点丢失', rowsOk }); break; }

            const next = stepPos(rows, at, 'down');
            const nextKey = rows[next.r][next.c];
            // ⚠️⚠️ **期望值必须用真值算**，绝不能用 `rows` 自己算 ——
            //    用 rows 算期望就是**循环论证**（拿脏结构算脏结构的答案），
            //    会得出"永远 0 步走错"的假结论（这个坑我踩过一次，见版本记录）。
            //    落点按**脏结构**算（那是真实行为），期望按**真值**算（那是对的行为）。
            const trueAt = posIn(truth, 'k' + cursor);
            const trueLast = trueAt.r === truth.length - 1;
            const expected = trueLast ? 'k' + cursor : truth[trueAt.r + 1][trueAt.c];
            const ok = nextKey === expected;
            log.push({ step, ok, rowsOk, cursor, nextKey, expected, lastRow: trueLast });

            cursor = Number(nextKey.slice(1));
            await run(`__setCursor(${cursor})`);
            await new Promise(r => setTimeout(r, 30));   // 转场推进一点（真实按键间隔≈30ms）

            // 落点不在视口内 ⇒ scrollIntoView ⇒ scroll 事件 ⇒ invalidateRowTops
            const vis = await run(`(() => {
                const box = document.getElementById('box');
                const el = box.querySelector('[data-key="k${cursor}"]');
                const er = el.getBoundingClientRect(), br = box.getBoundingClientRect();
                return er.bottom > br.bottom + 0.5 || er.top < br.top - 0.5;
            })()`);
            if (vis) {
                await run(`(() => { const b=document.getElementById('box');
                    const el=b.querySelector('[data-key="k${cursor}"]');
                    el.scrollIntoView({block:'nearest'}); return true; })()`);
                await new Promise(r => setTimeout(r, 40));
                m.onScroll();
                log[log.length - 1].scrolled = true;
            }
        }
        return log;
    };

    const cachedLog = await simulate(false);
    const badStep = cachedLog.findIndex(l => !l.ok);
    const firstBad = badStep === -1 ? '（全程正确）' : `第 ${badStep + 1} 次按键`;
    const nBad = cachedLog.filter(l => !l.ok).length;
    console.log(`  ${cachedLog.length} 次按键里，${nBad} 次走错`);
    console.log(`  第一次走错 = ${firstBad}`);
    console.log(`  每次按键的对错：`);
    console.log('    ' + cachedLog.map(l => l.ok ? '对' : '✗').join(''));
    const scrollAt = cachedLog.findIndex(l => l.scrolled);
    const dirtyAt = cachedLog.findIndex(l => !l.rowsOk);
    console.log(`  第一次发生滚动 = ${scrollAt === -1 ? '（无）' : '第 ' + (scrollAt + 1) + ' 次按键'}`);
    console.log(`  第一次行结构变脏 = ${dirtyAt === -1 ? '（无）' : '第 ' + (dirtyAt + 1) + ' 次按键'}`);

    // 主线判据：滚动之前全对、滚动之后开始错
    const beforeScroll = scrollAt === -1 ? cachedLog : cachedLog.slice(0, scrollAt);
    const afterScroll = scrollAt === -1 ? [] : cachedLog.slice(scrollAt);
    check('★ 滚动发生之前全部走对（对应主人说的"上半部分正常"）',
        beforeScroll.every(l => l.ok), `${beforeScroll.filter(l => !l.ok).length}/${beforeScroll.length} 步走错`);
    check('★ 滚动之后开始出现走错（对应"到底部就错乱"）',
        afterScroll.some(l => !l.ok), `滚动后 ${afterScroll.filter(l => !l.ok).length}/${afterScroll.length} 步走错`);
    // ⚠️ 允许差一拍：`scrollIntoView` 同步改了 scrollTop，但 `scroll` 事件是
    //    **异步派发**的 ⇒ 探针在下一步才作废缓存 ⇒ 变脏比滚动晚一拍是正常的。
    check('★ 行结构变脏的时刻紧跟第一次滚动（允许差一拍：scroll 事件异步派发）',
        dirtyAt !== -1 && dirtyAt >= scrollAt && dirtyAt <= scrollAt + 2,
        `变脏@第${dirtyAt + 1}，滚动@第${scrollAt + 1}`);
    check('★ 走错的步全都是因为行结构脏了',
        cachedLog.filter(l => !l.ok).every(l => !l.rowsOk),
        `${cachedLog.filter(l => !l.ok && l.rowsOk).length} 个例外`);

    // ───────────────── S3b · 对照：治本后（offsetTop）全程正确 ─────────────────
    console.log(`\n—— S3b 对照：只把探测量换成 offsetTop，同样按 ${STEPS} 次 ——`);
    const fixedLog = await simulate(true);
    const fixedBad = fixedLog.filter(l => !l.ok).length;
    const fixedScroll = fixedLog.findIndex(l => l.scrolled);
    console.log(`  ${fixedLog.length} 次按键里，${fixedBad} 次走错`);
    console.log('    ' + fixedLog.map(l => l.ok ? '对' : '✗').join(''));
    console.log(`  第一次发生滚动 = ${fixedScroll === -1 ? '（无）' : '第 ' + (fixedScroll + 1) + ' 次按键'}`);
    check('★ 换offsetTop 后：滚动照常发生（说明不是"没滚动所以没错"）',
        fixedScroll !== -1, `第 ${fixedScroll + 1} 次按键`);
    check('★ 换 offsetTop 后：行结构从头到尾都是对的',
        fixedLog.every(l => l.rowsOk), `${fixedLog.filter(l => !l.rowsOk).length} 次脏`);
    check('★ 换 offsetTop 后：全程 0 步走错', fixedBad === 0, `${fixedBad} 步`);
    check('★ 治本后仍保留"末行停住"的正确行为',
        fixedLog.some(l => l.lastRow && l.ok), '末行停住被验到');

    // ───────────────── S4 · 现象：脏结构下四个方向键各是什么表现 ─────────────────
    // 主人在真机上看到的是"按右不一定动、按上又去到了右"——
    // 这里把脏结构下四个键的落点全打出来，与正确结构逐项对照。
    console.log('\n—— S4 现象：脏结构下四个方向键的落点（对照正确结构）——');

    // 取一段行结构被劈坏的：焦点落在第 1 行（6 列）时探测
    await run('__setCursor(4)');
    await new Promise(r => setTimeout(r, 500));      // 转场跑完
    const dirtyCells = await run('__measure()');
    const dirtyRows = splitRows(dirtyCells);
    console.log(`  脏行结构 = ${dirtyRows.map(r => r.length).join('/')}（正确应为 ${truth.map(r => r.length).join('/')}）`);

    const FOCUS = 'k4';                               // 第 1 行第 5 格
    const dat = posIn(dirtyRows, FOCUS);
    const tAt = posIn(truth, FOCUS);
    console.log(`  焦点 ${FOCUS}：正确坐标 {r:${tAt.r},c:${tAt.c}} → 脏坐标 {r:${dat.r},c:${dat.c}}`);
    console.log('  方向   正确落点   脏结构落点   是否一致');
    let mismatch = 0;
    for (const d of ['up', 'down', 'left', 'right']) {
        const t = truth[stepPos(truth, tAt, d).r][stepPos(truth, tAt, d).c];
        const s = dirtyRows[stepPos(dirtyRows, dat, d).r][stepPos(dirtyRows, dat, d).c];
        const same = t === s;
        if (!same) mismatch++;
        console.log(`  ${d.padEnd(6)} ${t.padEnd(10)} ${s.padEnd(12)} ${same ? '一致' : '★不一致'}`);
    }
    check('★ 脏结构下四个键里至少有一个落点不一致（主人看到的现象）',
        mismatch > 0, `${mismatch}/4 个键不一致`);
    check('★ 脏结构下行数变多（"到底部"时行坐标整体错位）',
        dirtyRows.length !== truth.length, `${truth.length} → ${dirtyRows.length} 行`);

    console.log(`─────────────────────────────\n${pass} PASS / ${fail} FAIL\n`);
    await new Promise(r => setTimeout(r, 300));
    app.exit(fail ? 1 : 0);
});
