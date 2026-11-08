/**
 * 面包屑位移探针 —— 真 Chromium 里跑真 Vue TransitionGroup + 真 naive-ui + 真编译 CSS。
 *
 *   bash docs/probes/crumb-motion/run.sh
 *
 * 为什么要它：连续三轮我都在"看代码猜哪里跳"，每轮都被主人驳回一次。
 * 这个探针把"跳"翻译成数字：**每个元素在 5 个时刻的 left**。
 * 判据只有一条 —— `t0.left`（post-flush，FLIP 已写完 transform）是否等于 `before.left`。
 *   相等 ⇒ 它真的被 FLIP 拉住了，会滑过去；
 *   不等 ⇒ 它一跳就到最终位置，**没有任何过渡接住它**。
 *
 * 三个环境坑照抄 header-width/run.cjs（那里注释写全了）：
 *   1. shell 注入了 ELECTRON_RUN_AS_NODE ⇒ 必须 `env -u`；
 *   2. 独立 userData + 禁 GPU；
 *   3. show:false 在 Windows 上不推进 rAF ⇒ offscreen + 关后台节流。
 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

app.setPath('userData', path.join(os.tmpdir(), 'probe-crumb-motion'));
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.disableHardwareAcceleration();

const CASES = [
    { from: ['F:'], to: ['F:', 'videos'], hFrom: 1, hTo: 2, title: '① 根 → 一层（主人报的「F 到 videos」）' },
    { from: ['F:', 'videos'], to: ['F:', 'videos', 'a'], hFrom: 2, hTo: 3, title: '② 一层 → 两层（"只是多了 a"）' },
    { from: ['F:', 'videos', 'a'], to: ['F:', 'videos'], hFrom: 3, hTo: 2, title: '③ 两层 → 一层（"只是少了 a"）' },
    { from: ['F:', 'videos'], to: ['F:'], hFrom: 2, hTo: 1, title: '④ 一层 → 根（videos 消失 + F: 变当前）' },
];

const round = (n) => (n == null ? null : Math.round(n * 100) / 100);

function merge(snaps) {
    const ids = [];
    Object.entries(snaps)
        .filter(([k]) => k !== 'case')
        .forEach(([, arr]) => arr.forEach((e) => { if (!ids.includes(e.id)) ids.push(e.id); }));
    return ids.map((id) => {
        const pick = (arr) => arr.find((e) => e.id === id) ?? null;
        const b = pick(snaps.before), t0 = pick(snaps.t0), t80 = pick(snaps.t80), t400 = pick(snaps.t400);
        const left = (e) => (e && e.shown !== false ? e.left : null);
        const dxInstant = b && t0 && left(b) != null && left(t0) != null ? round(left(t0) - left(b)) : null;
        const dxTotal = b && t400 && left(b) != null && left(t400) != null ? round(left(t400) - left(b)) : null;
        return {
            元素: id,
            文字: (t0 || b || {}).文字 ?? '',
            'b.left': left(b),
            't0.left': left(t0),
            'b.top': b ? b.top : null,
            't0.top': t0 ? t0.top : null,
            'Δtop': b && t0 ? Math.round((t0.top - b.top) * 100) / 100 : null,
            '文字dy b→t0': b && t0 && b.textDy != null ? `${b.textDy}→${t0.textDy}` : '',
            'b.w': b ? b.width : null,
            't0.w': t0 && t0.shown !== false ? t0.width : null,
            'op t0→t80': `${t0 ? t0.op : ''}→${t80 ? t80.op : ''}`,
            瞬跳: dxInstant,
            总位移: dxTotal,
            move类: t0 ? (/fx-move/.test(t0.cls) ? 'YES' : '—') : '走了',
            'padR b→t0': b && t0 ? `${b.padR}→${t0.padR}` : '',
        };
    });
}

app.whenReady().then(async () => {
    const win = new BrowserWindow({
        show: false,
        width: 1400,
        height: 400,
        webPreferences: { contextIsolation: false, backgroundThrottling: false, offscreen: true },
    });
    win.webContents.on('console-message', (_e, _lvl, msg) => console.log('[page]', msg));

    await win.loadFile(path.join(__dirname, 'index.html'));
    // ⚠️ 必须复位：Electron 的 zoomFactor **按 origin 持久化**在 userData 里，
    // 上一次跑留下的 ×2 会让下一次所有几何量都腰斩（踩过：导航区 749 → 352.54）。
    win.webContents.setZoomFactor(1);
    await new Promise((r) => setTimeout(r, 1200));

    for (const c of CASES) {
        // 复位到 from
        await win.webContents.executeJavaScript(
            `(async () => {
                __state.names.value = ${JSON.stringify(c.from)};
                __state.historyLen.value = ${c.hFrom};
                await Vue.nextTick();
            })()`);
        await new Promise((r) => setTimeout(r, 500));

        const snaps = await win.webContents.executeJavaScript(
            `__nav(${JSON.stringify(c.to)}, ${c.hTo})`);

        console.log(`\n══════ ${c.title} ══════`);
        console.table(merge(snaps));

        // 一句话结论：谁在瞬跳
        const rows = merge(snaps).filter((r) => r.瞬跳 != null && Math.abs(r.瞬跳) > 0.5);
        if (!rows.length) {
            console.log('  瞬跳（t0 已到新位置、无过渡接住）：**无** —— 每一个位移都被 FLIP 接住了');
        } else {
            console.log('  瞬跳（t0 已到新位置、无过渡接住）：' +
                rows.map((r) => `${r.元素} ${r.瞬跳 > 0 ? '+' : ''}${r.瞬跳}px(${r.move类})`).join(' · '));
        }

        // 判据二：**已有的段宽度是否被改动**（"只多了 a"要求前段 width 恒定）
        const shrunk = merge(snaps).filter((r) => r['b.w'] != null && r['t0.w'] != null
            && Math.abs(r['t0.w'] - r['b.w']) > 0.5);
        console.log(shrunk.length
            ? '  恒存段宽度变化：' + shrunk.map((r) => `${r.元素} ${r['b.w']}→${r['t0.w']}`).join(' · ')
            : '  恒存段宽度变化：**无** —— 前段连宽度都没变，不可能推着谁动');

        const hit = await win.webContents.executeJavaScript('__badgeHit()');
        console.log('  角标：' + JSON.stringify(hit));

        // 判据三：**按钮还是不是原来那个节点**（本轮第二处返工）
        const bBtn = snaps.before.filter((e) => e.id.startsWith('btn:') && e.shown !== false);
        const tBtn = snaps.t0.filter((e) => e.id.startsWith('btn:') && e.shown !== false);
        const same = bBtn.length === 1 && tBtn.length === 1 && bBtn[0].id === tBtn[0].id;
        console.log(`  按钮节点：before=${bBtn.map((e) => e.id + '(' + e.文字 + ')').join(',') || '无'}` +
            ` → t0=${tBtn.map((e) => e.id + '(' + e.文字 + ')').join(',') || '无'}` +
            ` ⇒ ${same ? '**同一个节点，只换文案**' : (bBtn.length === 0 && tBtn.length === 0 ? '（整颗不渲染，正常）' : '节点被替换')}`);
    }

    // ── ⑤ 带 loading 的 3→2：量"当前段里的那个转圈"改了什么 ────────────────
    // 真实模板：`<n-spin v-if="loading && i === last" :size="12" style="margin-left:8px">`
    // ⇒ 转圈是当前段的**子元素**，一出现就把这一格撑宽；`loading` 结束后又缩回去。
    await win.webContents.executeJavaScript(`(async () => {
        __state.names.value = ['F:','videos','a'];
        __state.historyLen.value = 3;
        __state.loading.value = false;
        await Vue.nextTick();
    })()`);
    await new Promise((r) => setTimeout(r, 500));
    const withLoad = await win.webContents.executeJavaScript(
        `__navWithLoading(${JSON.stringify(['F:', 'videos'])}, 2, 300)`);
    console.log('\n══════ ⑤ 3→2 期间 loading=true（当前段里插了转圈） ══════');
    const find = (arr, txt) => arr.find((e) => e.文字 === txt && e.shown !== false) || null;
    for (const [阶段, arr] of [['加载中 (t0)', withLoad.t0], ['加载完', withLoad.loaded]]) {
        const b = find(withLoad.before, 'videos');
        const v = find(arr, 'videos');
        const a = find(arr, 'a');
        console.log(`  ${阶段.padEnd(12)} videos.left=${v ? v.left : '-'}  videos.width=${v ? v.width : '-'}` +
            `  w=${b ? b.width : '-'}→${v ? v.width : '-'}  h=${b ? b.height : '-'}→${v ? v.height : '-'}` +
            `  文字dy=${b ? b.textDy : '-'}→${v ? v.textDy : '-'}` +
            `  子转圈=${v ? v.子转圈 : '-'}  a=${a ? '仍在幽灵态' : '已移除'}`);
    }
    const b0 = find(withLoad.before, 'videos');
    const t0v = find(withLoad.t0, 'videos');
    console.log(`  ⇒ 转圈让 videos 这一格宽 **${b0.width} → ${t0v.width}**（${(t0v.width - b0.width).toFixed(2)}px），加载完再缩回`);

    // ── ⑥ 字重 400→500 到底改不改字宽（真字体 + canvas 量） ────────────────
    const ww = await win.webContents.executeJavaScript('__weightWidth()');
    console.log('\n══════ ⑥ 「当前段」字重 400→500 的字宽变化（Geist 可变字体，14px） ══════');
    console.table(ww);

    // ── 视觉证据：退场**进行中**（t≈90ms）截一张 ───────────────────────────
    // 几何数字证不了"看起来是不是幽灵在原地淡出"，那就把眼睛接进来。
    await win.webContents.executeJavaScript(`(async () => {
        __state.names.value = ['F:','videos','a'];
        __state.historyLen.value = 3;
        await Vue.nextTick();
    })()`);
    await new Promise((r) => setTimeout(r, 600));
    const pending = win.webContents.executeJavaScript(`__nav(${JSON.stringify(['F:', 'videos'])}, 2)`);
    await new Promise((r) => setTimeout(r, 90));
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(__dirname, 'shot-leave-90ms.png'), img.toPNG());
    console.log('\n📷 shot-leave-90ms.png（③ 退场进行到 90ms）已写出');
    await pending;

    // 1x 截图里"淡出 60% 的字"几乎看不见 ⇒ 放大 2 倍再抓一张，让幽灵可辨认。
    // ⚠️ 只用于观感取证，必须在所有几何测量**之后**做（zoom 会改 CSS px 尺寸）。
    win.webContents.setZoomFactor(2);
    await new Promise((r) => setTimeout(r, 300));
    await win.webContents.executeJavaScript(`(async () => {
        __state.names.value = ['F:','videos','a'];
        __state.historyLen.value = 3;
        await Vue.nextTick();
    })()`);
    await new Promise((r) => setTimeout(r, 600));
    const pending2 = win.webContents.executeJavaScript(`__nav(${JSON.stringify(['F:', 'videos'])}, 2)`);
    await new Promise((r) => setTimeout(r, 90));
    const img2 = await win.webContents.capturePage({ x: 0, y: 0, width: 700, height: 100 });
    fs.writeFileSync(path.join(__dirname, 'shot-leave-zoom.png'), img2.toPNG());
    console.log('📷 shot-leave-zoom.png（同上，窗口 zoom ×2）已写出');
    await pending2;

    app.quit();
});
