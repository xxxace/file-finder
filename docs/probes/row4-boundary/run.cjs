/**
 * 无头 Electron 探针 · "前三行正常、第四行开始错"的界限在哪
 * ==============================================================================
 *   bash docs/probes/row4-boundary/run.sh
 *
 * 验什么：业主 2026-10-04 三次报「**前三行怎么玩都行，到第四行就开始有问题**；
 * 第四行之后只能靠上下键，左右键灵、但上下键走的不是那一列」。
 *
 * ## 这条线索为什么值钱
 *
 * 前两轮已定位根因（焦点格的 `scale` 污染 rect.top ⇒ 行结构被劈开），
 * 但那解释不了"**为什么偏偏是第四行**"—— 若只是"重新探测就脏"，
 * 应该是**第一次按方向键就错**。
 *
 * ⇒ 存在一条**只在第 N 行之后才被跨过的边界**。
 * 候选只有两个：
 *   ① **视口边界**：第 4 行是第一个**完整可见需要滚动**的行
 *      ⇒ 过这条线才触发 `scrollIntoView` ⇒ 才作废缓存 ⇒ 才重新探测
 *   ② **虚拟滚动 / 懒加载**：第 4 行开始才进DOM
 *
 * 本探针的判据就是**把这两个候选分开**。
 *
 * 输出不含任何真实路径 / 用户名 / 盘序列号。
 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const os = require('node:os');

app.setPath('userData', path.join(os.tmpdir(), 'probe-row4-boundary'));
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.disableHardwareAcceleration();

let pass = 0, fail = 0;
const check = (label, cond, detail) => {
    console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '   → ' + detail : ''}`);
    if (cond) pass++; else fail++;
};

const ROW_EPS = 1;
const splitRows = (cells) => {
    const rows = [];
    let base = Number.NaN;
    for (const c of cells) {
        if (rows.length === 0 || Math.abs(c.top - base) > ROW_EPS) {
            rows.push([c.key]); base = c.top;
        } else rows[rows.length - 1].push(c.key);
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
    // ★ 主屏真实逻辑尺寸（docs/probes/win-size/ 记录为 2048×1280）
    const win = new BrowserWindow({
        show: false, width: 2048, height: 1280,
        webPreferences: { contextIsolation: false, backgroundThrottling: false, offscreen: true },
    });
    await win.loadFile(path.join(__dirname, 'index.html'));
    await new Promise(r => setTimeout(r, 800));

    const run = (js) => win.webContents.executeJavaScript(js).catch(e => 'ERR: ' + String(e));
    const N = 72;                                   // 12 行
    await run(`__build(${N})`);
    await new Promise(r => setTimeout(r, 500));

    // ───────────────── R1 · 视口装几行、第四行是不是分界线 ─────────────────
    console.log('—— R1 主屏 2048×1280 下，网格区的行可见性 ——');
    await run('__setCursor(-1)');
    await new Promise(r => setTimeout(r, 400));
    const rep = await run('__rowReport()');
    console.log(`  可视区高度 = ${rep.viewH.toFixed(1)}px，行高 = ${rep.rowH.toFixed(1)}px ⇒ 装 ${(rep.viewH / rep.rowH).toFixed(2)} 行`);
    console.log(`  内容总高= ${rep.scrollHeight}px，可滚动 ${rep.maxScroll.toFixed(0)}px`);
    console.log('  行号该行格数  顶部视口坐标  完整可见  可见比例');
    rep.rows.forEach(r => {
        console.log(`  第${r.r + 1}行   ${r.n}格${' '.repeat(4)} ${r.top.toFixed(0).padStart(6)}      ${r.fullyVisible ? '是' : '否'}     ${r.visiblePct.toFixed(0)}%`);
    });

    const fully = rep.rows.filter(r => r.fullyVisible).length;
    const partially = rep.rows.filter(r => !r.fullyVisible && r.visiblePct > 0).length;
    console.log(`  ⇒ 完整可见 ${fully} 行 + 部分可见 ${partially} 行`);

    check('★ 视口装 3 整行 + 一部分（第 4 行被切掉 40%）',
        rep.viewH / rep.rowH >= 3 && rep.viewH / rep.rowH < 4,
        `${(rep.viewH / rep.rowH).toFixed(2)} 行`);
    check('★ 第 1..3 行完整可见',
        rep.rows.slice(0, 3).every(r => r.fullyVisible),
        rep.rows.slice(0, 3).map(r => r.fullyVisible ? 'Y' : 'N').join(''));
    check('★ 第 4 行不是完整可见（这就是主人说的"第四行开始有问题"的那条线）',
        !rep.rows[3].fullyVisible,
        `可见 ${rep.rows[3].visiblePct.toFixed(0)}%`);
    check('★ 第 4 行开始需要滚动才能看全',
        rep.maxScroll > 0 && rep.rows[3].top > rep.viewTop + rep.viewH - rep.rowH,
        `第4行 top=${rep.rows[3].top.toFixed(0)}，视口底=${rep.viewTop + rep.viewH}`);

    // ───────────────── R2 · 候选②：虚拟滚动 / 懒加载？ ─────────────────
    console.log('\n—— R2 候选② 是不是虚拟滚动 ——');
    const domCount = rep.rows.reduce((a, r) => a + r.n, 0);
    check('★ DOM 里格子数 == 数据量（**没有虚拟滚动**）',
        domCount === N, `DOM ${domCount} 格 / 数据 ${N} 条`);
    const zeroVisible = rep.rows.filter(r => r.visiblePct === 0).length;
    check('★ 视口外的行**已在 DOM 里**（懒加载只管 img，不管格子）',
        zeroVisible > 0 && domCount === N,
        `视口外 ${zeroVisible} 行都已渲染`);

    // ───────────────── R3 · 候选①：第 4 行是"首次触发滚动"的那一行 ─────────────────
    console.log('\n—— R3 候选① 第 4 行是不是第一个"焦点需要滚动"的行 ——');
    console.log('  ⚠️ 必须同时量 **window.scrollY**：`scrollIntoView` 会滚动**所有**可滚祖先，');
    console.log('     不只`.image-box`。只看容器的 scrollTop 会漏掉真正的滚动。');
    const trace = [];
    for (let r = 0; r < 7; r++) {
        const at = await run(`(() => {
            const box = document.getElementById('box');
            const els = Array.from(box.querySelectorAll('.image-box-item'));
            const offs = Array.from(new Set(els.map(e => e.offsetTop))).sort((a,b)=>a-b);
            const el = els.find(e => e.offsetTop === offs[${r}]);
            const er = el.getBoundingClientRect(), br = box.getBoundingClientRect();
            return {
                key: el.dataset.key,
                needScroll: er.bottom > br.bottom + 0.5 || er.top < br.top - 0.5,
                before: box.scrollTop, winBefore: window.scrollY,
                bodyOverflow: getComputedStyle(document.body).overflow,
                docScrollable: document.scrollingElement.scrollHeight > window.innerHeight,
            };
        })()`);
        // ★ 必须调 __focusCursor（设焦点 + scrollIntoView），与产品 focusCursor 同构
        await run(`__focusCursor(${Number(at.key.slice(1))})`);
        await new Promise(res => setTimeout(res, 250));
        const after = await run(`({
            box: document.getElementById('box').scrollTop,
            win: window.scrollY,
        })`);
        trace.push({
            r: r + 1, key: at.key, needScroll: at.needScroll,
            before: at.before, after: after.box,
            winBefore: at.winBefore, winAfter: after.win,
            docScrollable: at.docScrollable,
        });
        console.log(`  第 ${r + 1} 行（${at.key}）：需要滚动=${at.needScroll}` +
            ` · box ${at.before}→${after.box}` +
            ` · window ${at.winBefore}→${after.win}` +
            `${(after.box > at.before || after.win > at.winBefore) ? '  ★发生滚动' : ''}`);
    }
    check('（观察）页面本身是否可滚动',
        trace[0].docScrollable === false || trace[0].winAfter > 0,
        `document 可滚动 = ${trace[0].docScrollable}`);
    const firstScroll = trace.find(t => t.after > t.before || t.winAfter > t.winBefore);
    check('★ 前 3 行完全没有任何滚动（缓存不作废 ⇒ 探测不重算 ⇒ 正常）',
        trace.slice(0, 3).every(t => t.after === t.before && t.winAfter === t.winBefore),
        trace.slice(0, 3).map(t => `${t.after}/${t.winAfter}`).join(' '));
    check('★ 到第 4 行才第一次发生滚动（= 缓存作废的第一击）',
        firstScroll !== undefined && firstScroll.r === 4,
        firstScroll ? `第 ${firstScroll.r} 行（box ${firstScroll.before}→${firstScroll.after}, win ${firstScroll.winBefore}→${firstScroll.winAfter}）` : '（全程没滚过）');

    // ───────────────── R4 · 交叉验证：滚动后行结构确实变脏 ─────────────────
    console.log('\n—— R4 过第 4 行线后，行结构真的变脏了吗 ——');
    await run(`(() => { const b=document.getElementById('box'); b.scrollTop = 0; return true; })()`);
    await new Promise(res => setTimeout(res, 300));
    await run('__setCursor(4)');                       // 第 1 行的某格
    await new Promise(res => setTimeout(res, 500));
    const clean = splitRows(await run(`(() => {
        const box=document.getElementById('box');
        return Array.from(box.querySelectorAll('.image-box-item')).map(el=>({
            key: el.dataset.key, top: el.getBoundingClientRect().top }));
    })()`));
    console.log(`  滚动前（焦点 k4）行结构 = ${clean.map(r => r.length).join('/')}`);

    await run('__setCursor(20)');                      // 第 4 行
    await new Promise(res => setTimeout(res, 500));
    const dirty = splitRows(await run(`(() => {
        const box=document.getElementById('box');
        return Array.from(box.querySelectorAll('.image-box-item')).map(el=>({
            key: el.dataset.key, top: el.getBoundingClientRect().top }));
    })()`));
    console.log(`  焦点在第 4 行时行结构 = ${dirty.map(r => r.length).join('/')}`);
    check('★ 只要焦点一落上、重新探测就一定被劈开',
        dirty.length !== 12 || dirty.some(r => r.length !== 6),
        `${dirty.length} 行：${dirty.map(r => r.length).join('/')}`);
    check('★ 对照：焦点在第 1 行（未滚动、缓存命中）时探测同样会脏 ⇒ 证明"脏"与第几行无关，只与"是否重新探测"有关',
        clean.length !== 12 || clean.some(r => r.length !== 6),
        `${clean.length} 行：${clean.map(r => r.length).join('/')}`);


    // ───────────────── R5 · 为什么"左右灵、上下不灵" ─────────────────
    // 主人原话：「到第四行后...左右键灵，但是上下键走的不是那一列」。
    // ⛔ 这**不是**"左右键没坏"——按 R4，脏结构下四个键全错。
    //    真正的原因是**错法的可见性不同**：错位结构把行劈成"1 格 / 3 格"这种，
    //    上下键的落点差**一整行**（肉眼立刻看得出），
    //    而左右键的错常常只差**一格甚至原地不动**（肉眼看不出/像卡住）。
    // 这里用数据把"错得有多明显"量出来。
    console.log('\n—— R5 为什么"左右灵、上下不灵"：两种错法的可见性 ——');
    const posIn = (rows, key) => {
        for (let r = 0; r < rows.length; r++) {
            const c = rows[r].indexOf(key);
            if (c >= 0) return { r, c };
        }
        return null;
    };
    const truthRows = Array.from({ length: 12 }, (_, r) =>
        Array.from({ length: 6 }, (_, c) => `k${r * 6 + c}`));

    // 扫所有焦点位置 × 四个方向，统计"落点差多少格（曼哈顿距离）"
    const stat = { up: [], down: [], left: [], right: [] };
    for (let r = 0; r < 12; r++) {
        for (let c = 0; c < 6; c++) {
            const key = `k${r * 6 + c}`;
            await run(`__setCursor(${r * 6 + c})`);
            //等转场跑完，量真实的脏结构
            await new Promise(res => setTimeout(res, 230));
            const dirty = splitRows(await run(`(() => {
                const box=document.getElementById('box');
                return Array.from(box.querySelectorAll('.image-box-item')).map(el=>({
                    key: el.dataset.key, top: el.getBoundingClientRect().top }));
            })()`));
            const da = posIn(dirty, key);
            const ta = posIn(truthRows, key);
            if (!da || !ta) continue;
            for (const d of ['up', 'down', 'left', 'right']) {
                const dn = stepPos(dirty, da, d);
                const tn = stepPos(truthRows, ta, d);
                const dk = dirty[dn.r][dn.c], tk = truthRows[tn.r][tn.c];
                const di = Number(dk.slice(1)), ti = Number(tk.slice(1));
                const dist = Math.abs(Math.floor(di / 6) - Math.floor(ti / 6))
                           + Math.abs(di % 6 - ti % 6);
                stat[d].push({ key, dk, tk, dist, stuck: dk === key });
            }
        }
    }
    console.log('  方向   走错数/总数  平均偏差格数  最大偏差  原地不动次数  偏差≥2行(肉眼明显)');
    for (const d of ['up', 'down', 'left', 'right']) {
        const arr = stat[d];
        const wrong = arr.filter(x => x.dk !== x.tk);
        const avg = wrong.length ? (wrong.reduce((s, x) => s + x.dist, 0) / wrong.length) : 0;
        const max = wrong.length ? Math.max(...wrong.map(x => x.dist)) : 0;
        const stuck = arr.filter(x => x.stuck).length;
        const big = wrong.filter(x => Math.abs(Math.floor(Number(x.dk.slice(1))/6) - Math.floor(Number(x.tk.slice(1))/6)) >= 1).length;
        console.log(`  ${d.padEnd(6)} ${String(wrong.length).padStart(3)}/${arr.length}`.padEnd(20)
            + ` ${avg.toFixed(2).padStart(6)}${' '.repeat(8)}${String(max).padStart(4)}`
            + `  ${String(stuck).padStart(6)}${' '.repeat(12)}${big}`);
    }
    const lrWrong = stat.left.filter(x => x.dk !== x.tk).length + stat.right.filter(x => x.dk !== x.tk).length;
    const udBig = [...stat.up, ...stat.down].filter(x =>
        x.dk !== x.tk && Math.abs(Math.floor(Number(x.dk.slice(1))/6) - Math.floor(Number(x.tk.slice(1))/6)) >= 1).length;
    check('★ 左右键的错"不明显"（偏差多在 1 格内 ⇒ 看着像卡住/没反应）',
        lrWrong > 0, `左右共错 ${lrWrong} 次`);
    check('★ 上下键的错"很明显"（落点差了整行 ⇒ 一眼看出跳错行）',
        udBig > 0, `上下共 ${udBig} 次偏差≥1 行`);

    console.log(`─────────────────────────────\n${pass} PASS / ${fail} FAIL\n`);
    await new Promise(r => setTimeout(r, 300));
    app.exit(fail ? 1 : 0);
});
