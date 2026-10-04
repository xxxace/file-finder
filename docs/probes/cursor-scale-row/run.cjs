/**
 * 无头 Electron 探针 · 焦点格的 `scale` 是否污染了行结构
 * ==============================================================================
 *   bash docs/probes/cursor-scale-row/run.sh
 *
 * 验什么：业主 2026-10-04 真机报「方向键按右不一定动，按上却去了右」。
 *
 * ## 怀疑的机制（两条硬事实的交集）
 *
 *   ① `index.vue:2214` 给焦点格加了 `transform: scale(1.012)`（"极轻抬升"）
 *   ② `useGridCursor.probeLayout` 用 `getBoundingClientRect().top` 分行，
 *      `gridGeometry.groupRows` 的容差 `ROW_EPS = 1`（px）
 *
 *   `getBoundingClientRect()` 返回的是**变换后**的矩形 ⇒ 焦点格的 `top`
 *   会比同排兄弟高 `(1.5rem × 1.012 − 1.5rem)/2 = 1.5rem × 0.006`。
 *   主屏 1rem = 204.8px ⇒ 偏移 ≈ **1.84px > 1px 容差** ⇒ 那一格被
 *   `groupRows` 判成**单独一行** ⇒ 之后所有方向键的行列都错位。
 *
 * ## 为什么必须真渲染
 *
 * 偏移量是 `transform` × 高度 的乘积，**高度是 `1.5rem`、而 `rem` 由
 * `flexible.ts` 按窗口宽度算出来** ⇒ 不开真窗口、不拿到真 rect，
 * 算出来的数只是"我以为的数"。而且转场有 .18s，真实运行时
 * `probeLayout` 常常是在**转场还没跑完**时读的。
 *
 * 输出不含任何真实路径 / 用户名 / 盘序列号。
 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

app.setPath('userData', path.join(os.tmpdir(), 'probe-cursor-scale-row'));
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.disableHardwareAcceleration();

/** 与 gridGeometry.ts 的 ROW_EPS 同值 —— 复制错探针就白测 */
const ROW_EPS = 1;

let pass = 0, fail = 0;
const check = (label, cond, detail) => {
    console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '   → ' + detail : ''}`);
    if (cond) pass++; else fail++;
};

/**
 * 复刻 `groupRows` 的分行判据（同一份逻辑：|top − base| > EPS ⇒ 换行）。
 * 这里**不复刻完整实现**—— 只用它回答一个问题：
 * "焦点格被抬起来之后，groupRows 会把它判成几行？"
 */
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

app.whenReady().then(async () => {
    const win = new BrowserWindow({
        show: false, width: 2100, height: 950,
        webPreferences: { contextIsolation: false, backgroundThrottling: false, offscreen: true },
    });
    win.webContents.on('console-message', (_e, _lvl, msg) => console.log('[page]', msg));
    await win.loadFile(path.join(__dirname, 'index.html'));
    await new Promise(r => setTimeout(r, 800));

    const run = (js) => win.webContents.executeJavaScript(js).catch(e => 'ERR: ' + String(e));

    // ───────────────── D1 · 基线：没有焦点格时，几行几列 ─────────────────
    console.log('—— D1 基线（无 .cursor）：6 列 × 2 行 ——');
    await run('__build(12, -1)');
    await new Promise(r => setTimeout(r, 400));
    const plain = await run('__measure()');
    const plainRows = splitRows(plain);
    console.log(`  实测：${plainRows.length} 行，每行 ${plainRows.map(r => r.length).join('/')} 格`);
    console.log(`  同排 top 极差 = ${(() => {
        const byRow = plainRows.map(rk => rk.map(k => plain.find(c => c.key === k).top));
        return Math.max(...byRow.map(ts => Math.max(...ts) - Math.min(...ts)));
    })().toFixed(4)}px`);
    check('无焦点格时正好 2 行', plainRows.length === 2, `${plainRows.length} 行`);
    check('无焦点格时每行 6 格', plainRows.every(r => r.length === 6), plainRows.map(r => r.length).join('/'));
    check('无焦点格时格高 ≈ 1.5rem = 307.2px', Math.abs(plain[0].h - 307.2) < 0.5, `${plain[0].h.toFixed(2)}px`);

    // ───────────────── D2 · 焦点格稳态（转场跑完）─────────────────
    console.log('\n—— D2 焦点格在第 6 格（k5）· 转场已跑完 ——');
    await run('__build(12, 5)');
    await new Promise(r => setTimeout(r, 600));   // > .18s 转场时长
    const steady = await run('__measure()');
    const steadyRows = splitRows(steady);
    console.log(`  实测：${steadyRows.length} 行，每行 ${steadyRows.map(r => r.length).join('/')} 格`);

    const row0 = steadyRows[0];
    const tops = row0.map(k => steady.find(c => c.key === k).top);
    const cursorTop = steady.find(c => c.key === 'k5').top;
    const sibTop = steady.find(c => c.key === 'k4').top;
    const delta = sibTop - cursorTop;
    console.log(`  焦点格 k5.top = ${cursorTop.toFixed(3)}`);
    console.log(`  同排兄弟 k4.top = ${sibTop.toFixed(3)}`);
    console.log(`  ★ 抬升造成的偏移 = ${delta.toFixed(3)}px`);
    console.log(`  实测行结构 = ${JSON.stringify(steadyRows)}`);

    check('★ 焦点格的抬升偏移 > ROW_EPS（这就是缺陷本身）', delta > ROW_EPS,
        `${delta.toFixed(3)}px > ${ROW_EPS}px`);
    check('★ 后果：行结构被破坏（不再是 2 行 × 6 格）',
        steadyRows.length !== 2 || !steadyRows.every(r => r.length === 6),
        `${steadyRows.length} 行：${steadyRows.map(r => r.length).join('/')}`);
    check('★ 焦点格被单独判成一行', steadyRows.some(r => r.length === 1 && r[0] === 'k5'),
        JSON.stringify(steadyRows.map(r => r.length)));

    // ───────────────── D3 · 焦点格在行中间（k2）─────────────────
    console.log('\n—— D3 焦点格在行中间（k2）——');
    await run('__build(12, 2)');
    await new Promise(r => setTimeout(r, 600));
    const mid = await run('__measure()');
    const midRows = splitRows(mid);
    console.log(`  实测行结构 = ${JSON.stringify(midRows)}`);
    console.log(`  每行格数 = ${midRows.map(r => r.length).join('/')}`);
    check('★ 行中间的焦点格同样把行劈开', midRows.length > 2 || midRows.some(r => r.length === 1),
        `${midRows.length} 行：${midRows.map(r => r.length).join('/')}`);

    // ───────────────── D4 · 转场进行中（真实运行时的常态）─────────────────
    console.log('\n—— D4 转场进行中就探测（真实运行时的常态）——');
    await run('__build(12, -1)');
    await new Promise(r => setTimeout(r, 400));
    const during = await run('__measureImmediateAfterCursor(3)');
    const duringRows = splitRows(during);
    console.log(`  转场刚开头的行结构 = ${JSON.stringify(duringRows)}`);
    // ⚠️ 转场**刚开始**那一帧 scale 还接近 1 ⇒ 偏移接近 0 ⇒ 不劈开。
    //    危险窗口在转场**中后段**（偏移爬过 1px 之后、跑完之前）—— 见 D4b。
    check('转场刚开头那一帧还不会劈开（说明劈开取决于"转场进行到多少"）',
        duringRows.length === 2, `${duringRows.length} 行：${duringRows.map(r => r.length).join('/')}`);

    // ───────────────── D4b · 转场中段（偏移已爬过1px、尚未跑完）─────────────────
    console.log('\n—— D4b 转场中段（.18s 的一半 ≈ 90ms）——');
    await run(`(() => {
        const box = document.getElementById('box');
        Array.from(box.querySelectorAll('.image-box-item')).forEach((el, i) => {
            el.classList.toggle('cursor', i === 3);
        });
        return true;
    })()`);
    await new Promise(r => setTimeout(r, 90));
    const midT = await run('__measure()');
    const midRowsT = splitRows(midT);
    const midDelta = midT.find(c => c.key === 'k2').top - midT.find(c => c.key === 'k3').top;
    console.log(`  中段偏移 = ${midDelta.toFixed(3)}px，行结构 = ${JSON.stringify(midRowsT)}`);
    check('★ 转场中段会把行劈开（真实运行时确实会读到这一帧）',
        midRowsT.length > 2 || midRowsT.some(r => r.length === 1),
        `${midRowsT.length} 行：${midRowsT.map(r => r.length).join('/')}`);

    // ───────────────── D5 · 若把 scale 去掉，还会不会劈 ─────────────────
    console.log('\n—— D5 对照：把 scale 拿掉，偏移应回到 0 ——');
    await run(`(() => {
        const st = document.createElement('style');
        st.id = 'noscale';
        st.textContent = '.image-box-item.cursor { transform: none !important; }';
        document.head.appendChild(st);
        return true;
    })()`);
    await run('__build(12, 5)');
    await new Promise(r => setTimeout(r, 500));
    const noScale = await run('__measure()');
    const noScaleRows = splitRows(noScale);
    const nd = noScale.find(c => c.key === 'k4').top - noScale.find(c => c.key === 'k5').top;
    console.log(`  去scale 后偏移 = ${nd.toFixed(4)}px，行结构 = ${noScaleRows.map(r => r.length).join('/')}`);
    check('去 scale 后偏移 = 0', Math.abs(nd) < 0.001, `${nd.toFixed(4)}px`);
    check('去 scale 后行结构恢复正常（2×6）',
        noScaleRows.length === 2 && noScaleRows.every(r => r.length === 6),
        `${noScaleRows.length} 行：${noScaleRows.map(r => r.length).join('/')}`);
    await run(`document.getElementById('noscale').remove()`);

    // ───────────────── D6 · 治本方案：换测量量 ─────────────────
    // 判据：offsetTop 是**布局**坐标，不含 transform ⇒ 焦点格抬升对它是 0。
    // 若 D6 成立 ⇒ 修法是「改测量量」（治本），而不是「调大容差」（打补丁）。
    console.log('\n—— D6 治本验证：offsetTop 不受 transform 影响 ——');
    await run('__build(12, 5)');
    await new Promise(r => setTimeout(r, 600));
    const off = await run('__measureOffset()');
    const offRows = splitRows(off);
    const offDelta = Math.abs(off.find(c => c.key === 'k4').top - off.find(c => c.key === 'k5').top);
    console.log(`  offsetTop 偏移 = ${offDelta.toFixed(4)}px，行结构 = ${offRows.map(r => r.length).join('/')}`);
    check('★ offsetTop 对焦点格的偏移 = 0（治本量可用）', offDelta < 0.001, `${offDelta.toFixed(4)}px`);
    check('★ 用 offsetTop 分行：行结构正确（2×6）',
        offRows.length === 2 && offRows.every(r => r.length === 6),
        `${offRows.length} 行：${offRows.map(r => r.length).join('/')}`);

    // 焦点格在行中间也要成立
    await run('__build(12, 2)');
    await new Promise(r => setTimeout(r, 600));
    const off2 = await run('__measureOffset()');
    const off2Rows = splitRows(off2);
    check('★ 焦点格在行中间时 offsetTop 分行同样正确',
        off2Rows.length === 2 && off2Rows.every(r => r.length === 6),
        `${off2Rows.length} 行：${off2Rows.map(r => r.length).join('/')}`);

    // 视口坐标仍必须用 rect（要判断"在不在视口内"）—— 证明两种量各有分工，不是二选一
    console.log('\n—— D7 两种量各有分工（不能只用一个）——');
    const both = await run(`(() => {
        const box = document.getElementById('box');
        box.scrollTop = 400;                       // ⚠️ 必须先滚动：没滚动时两者恒等，证明不了分工
        const el = box.querySelector('.image-box-item');
        return {
            rectVsOffset: el.getBoundingClientRect().top - el.offsetTop,
            scrollTop: box.scrollTop,
            hasTransform: getComputedStyle(el).transform,
        };
    })()`);
    console.log(`  滚动 ${both.scrollTop}px 后 rect.top − offsetTop = ${both.rectVsOffset.toFixed(2)}px`);
    check('滚动后 rect.top 与 offsetTop 确实不同（视口坐标 vs 布局坐标，各有分工）',
        Math.abs(both.rectVsOffset) > 100, `${both.rectVsOffset.toFixed(2)}px`);
    check('未选中格无 transform（污染源只在 .cursor 一处）',
        both.hasTransform === 'none' || both.hasTransform === 'matrix(1, 0, 0, 1, 0, 0)',
        both.hasTransform);

    // ───────────────── D8 · offsetParent 是谁（修法要用offsetTop，必须先验）─────────────────
    console.log('\n—— D8 offsetParent 是谁（修法的可行性前提）——');
    const op = await run(`(() => {
        const box = document.getElementById('box');
        const el = box.querySelector('.image-box-item');
        const p = el.offsetParent;
        return {
            isBox: p === box,
            isBody: p === document.body,
            tag: p ? (p.id || p.className || p.tagName) : 'null',
            offsetTop: el.offsetTop,
            distinct: Array.from(box.querySelectorAll('.image-box-item'))
                .map(x => x.offsetTop).filter((v, i, a) => a.indexOf(v) === i).length,
        };
    })()`);
    console.log(`  offsetParent = ${op.tag}（是 .image-box？ ${op.isBox}；是 BODY？ ${op.isBody}）`);
    console.log(`  第一格 offsetTop = ${op.offsetTop}，不同取值个数 = ${op.distinct}（2 行 ⇒ 应为 2）`);
    check('offsetTop 可读且行间有差异（能用来分行）', op.distinct === 2, `${op.distinct} 个不同取值`);
    // ⚠️ 这一条是**打脸现有注释**的实测：gridGeometry.ts:177 写「`.image-box-item` 自带
    //    position:relative ⇒ offsetParent 是自己 ⇒ offsetTop 恒为 0」。
    //    实测 offsetParent 走的是 **BODY**（.image-box 自己没有 position）⇒ 那个前提不成立。
    check('★ 实测推翻 gridGeometry.ts:177 的前提：offsetParent 是 BODY，不是"自己"',
        op.isBody, `${op.tag}（注释说会是"自己"、offsetTop 恒 0）`);

    console.log(`─────────────────────────────\n${pass} PASS / ${fail} FAIL\n`);
    await new Promise(r => setTimeout(r, 300));
    app.exit(fail ? 1 : 0);
});
