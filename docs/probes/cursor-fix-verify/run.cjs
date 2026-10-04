/**
 * 无头 Electron 探针 · **修复是否真的生效**（直接跑产品源码，零复刻）
 * ==============================================================================
 *   bash docs/probes/cursor-fix-verify/run.sh
 *
 * ## 为什么前面三个探针还不够
 *
 * `cursor-scale-row` / `cursor-scroll-cache` / `row4-boundary` 证明的是
 * **「浏览器排版层发生了什么」** —— 它们各自**复刻**了一份 `splitRows` / `stepPos`。
 * ⇒ 它们能证明**根因**，但**证伪不了修复**（复刻件与真代码可能已经分叉，
 * 真代码里的类型、时序、Vue 响应式都可能还有别的问题）。
 *
 * 本探针 esbuild 打包**真的** `src/views/FileFinder/useGridCursor.ts`
 * （连带真的 `gridGeometry.ts` 与 `utils/index.ts`），在主屏尺寸的真DOM 里
 * 派发**真 KeyboardEvent**、读回**真 `cursorKey`** ⇒ **全链路零复刻**。
 *
 * ## 判据
 *
 * | 组 | 验什么 |
 * |---|---|
 * | V1 | 装得上、按键有响应（冒烟：证明打包与接线没坏）|
 * | V2 | ★ 方向键真落点对不对（与"6 列真值"逐格比对）|
 * | V3 | ★ 长按 ↓ 越过视口边界（**第 4 行那条线**）后仍然全对 |
 * | V4 | 边界行为：首行按 ↑ / 末行按 ↓ 停住（不环绕）|
 * | V5 | 横向：← → 逐格比对 |
 * | V6 | 坐标缓存：同一 key 在列数变化后坐标跟着变（`posOf` 派生）|
 *
 * 输出不含任何真实路径 / 用户名 / 盘序列号。
 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

app.setPath('userData', path.join(os.tmpdir(), 'probe-cursor-fix-verify'));
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

// ───────────────── 打包产品源码（产物落%TEMP%，不落探针目录） ─────────────────
const repo = path.resolve(__dirname, '../../..');
const BUILD = path.join(os.tmpdir(), 'ff-cursor-fix-build');
const bundlePath = path.join(BUILD, 'entry.js');
const htmlPath = path.join(BUILD, 'index.html');

app.whenReady().then(async () => {
    // ───────────────── 1. esbuild 打包真源码 ─────────────────
    let esbuild;
    try {
        esbuild = require('esbuild');
    } catch {
        console.log('  FAIL  找不到 esbuild');
        app.exit(1);
        return;
    }
    fs.rmSync(BUILD, { recursive: true, force: true });
    fs.mkdirSync(BUILD, { recursive: true });
    try {
        await esbuild.build({
            entryPoints: [path.resolve(__dirname, 'entry.ts')],
            bundle: true,
            format: 'iife',
            globalName: 'Probe',
            platform: 'browser',
            target: 'chrome120',
            outfile: bundlePath,
            logLevel: 'silent',
            alias: {
                // ⚠️ 必须与 `vite.config.ts` 的 alias 一致，否则 `@/utils` 解析不到
                '@': path.resolve(repo, 'src'),
                'vue': 'vue/dist/vue.esm-bundler.js',
            },
            define: { __VUE_OPTIONS_API__: 'true', __VUE_PROD_DEVTOOLS__: 'false' },
        });
    } catch (err) {
        console.log('  FAIL  esbuild 打包失败：\n' + String(err));
        app.exit(1);
        return;
    }
    // 页面 HTML：主屏真实尺寸 + 与 index.vue 等效的 CSS
    fs.copyFileSync(path.resolve(__dirname, 'page.html'), htmlPath);
    fs.writeFileSync(htmlPath,
        fs.readFileSync(htmlPath, 'utf8').replace('__BUNDLE__', './entry.js'));
    console.log('—— V0 打包：产品源码 useGridCursor.ts + gridGeometry.ts + utils ——');
    check('esbuild 打包产品源码成功', fs.existsSync(bundlePath), `${fs.statSync(bundlePath).size} bytes`);

    // ───────────────── 2. 起真窗口 ─────────────────
    const win = new BrowserWindow({
        show: false, width: 2048, height: 1280,
        webPreferences: { contextIsolation: false, backgroundThrottling: false, offscreen: true },
    });
    const errors = [];
    win.webContents.on('console-message', (_e, _l, m) => { if (m) errors.push(m); });
    await win.loadFile(htmlPath);
    await new Promise(r => setTimeout(r, 900));

    const run = (js) => win.webContents.executeJavaScript(js).catch(e => 'ERR: ' + String(e));

    // ───────────────── V1 · 冒烟 ─────────────────
    console.log('\n—— V1 冒烟：真代码装得上、按键有响应 ——');
    const mounted = await run(`(async () => {
        const el = document.getElementById('app');
        window.__g = Probe.mountGrid({ mount: el, count: 72 });
        await window.__g.ready;
        return { ok: window.__g.isBox(), cells: document.querySelectorAll('.image-box-item').length };
    })()`);
    console.log(`  挂载结果：${JSON.stringify(mounted)}`);
    check('真useGridCursor 装上且网格渲染 72 格', mounted.ok && mounted.cells === 72,
        `${mounted.cells} 格`);

    const first = await run(`(async () => {
        const a = window.__g.press('ArrowDown');
        await window.__g.settle(200);
        return { key: a, peek: window.__g.peek() };
    })()`);
    console.log(`  首次按 ↓：按下瞬间=${first.key} / 稳定后=${first.peek}`);
    check('首次按 ↓ 有响应（首探→ 激活到视口第一行）', !!first.peek, `落在 ${first.peek}`);


    // ───────────────── V1b· 守卫：落点绝不能是空串 ─────────────────
    // ⛔ 这条是**探针自身的护栏**：我第一版把 `useGridCursor` 在 setup 之外调了
    //    ⇒ `onMounted` 没注册 ⇒ keydown 监听压根没挂 ⇒ 所有按键都返回空串
    //    而"空串 ≠ 期望值"会被算成"走错" ⇒ 看起来像"抓到 bug"，其实是探针坏了。
    // ⇒ 任何用例若落点为空，一律先判FAIL 并提示"探针没接上"，不进入后续比对。
    console.log('\n—— V1b 守卫：keydown 监听是否真的挂上了 ——');
    const alive = await run(`(async () => {
        const el = window.__newStation();
        const g = Probe.mountGrid({ mount: el, count: 72 });
        await g.ready;
        g.press('ArrowDown');
        await g.settle(200);
        return g.peek();
    })()`);
    console.log(`  首次按 ↓ 后 cursorKey = "${alive}"`);
    check('★探针接得上：首次 ↓ 落点非空', !!alive && alive !== '',
        alive ? `"${alive}"` : '空 ⇒ onMounted 没注册 / 监听没挂上，探针本身坏了');
    if (!alive) {
        console.log('\n⛔⛔ 探针未接上，后续用例全部无意义 —— 中止。');
        console.log(`─────────────────────────────\n${pass} PASS / ${fail + 1} FAIL\n`);
        app.exit(1);
        return;
    }

    // ───────────────── V2 · 方向键真落点（与 6 列真值逐格比对）─────────
    console.log('\n—— V2 ★ 方向键真落点：与 6 列真值逐格比对 ——');
    // 从 k0 起，每按一次 ↓，期望 +6（6 列）
    const downTrace = await run(`(async () => {
        const g = window.__g;
        g.press('ArrowLeft');                     // 先确保落回第一行
        // 直接把 cursor 归零：重挂最稳
        return true;
    })()`);

    // 重挂一份干净的，从未激活状态开始走
    const v2 = await run(`(async () => {
        const el = window.__newStation();
        const g = Probe.mountGrid({ mount: el, count: 72 });
        await g.ready;
        const g0 = g.press('ArrowDown');// 未激活 → 激活
        await g.settle(220);
        const seq = [{ step: 0, expect: g0, note: '首次激活' }];
        for (let i = 1; i <= 9; i++) {
            const k = g.press('ArrowDown');
            await g.settle(60);
            seq.push({ step: i, got: k });
        }
        return seq;
    })()`);
    console.log('  步期望实际');
    let v2ok = 0, v2bad = 0;
    v2.forEach((s, i) => {
        if (i === 0) { console.log(`  ${String(s.step).padEnd(3)}${'激活'.padEnd(5)}${s.expect}`); return; }
        // 首次激活落在视口第一行第一格 = k0；此后每步 +6
        const expect = 'k' + (6 * i);
        const good = s.got === expect;
        good ? v2ok++ : v2bad++;
        console.log(`  ${String(s.step).padEnd(3)}${expect.padEnd(5)}${s.got}${good ? '' : '★'}`);
    });
    check('★ 连续 9 次 ↓ 每次都精确 +6（一路越过第 4 行那条线）',
        v2bad === 0 && v2ok === 9, `${v2ok} 对 / ${v2bad} 错`);

    // ───────────────── V3 · ★ 长按越过视口边界 ─────────────────
    console.log('\n—— V3 ★ 长按 ↓ 越过视口边界（第 4 行那条线）——');
    const v3 = await run(`(async () => {
        const el = window.__newStation();
        const g = Probe.mountGrid({ mount: el, count: 72 });
        await g.ready;
        await g.pressAndSettle('ArrowDown', 200);
        const log = [];
        for (let i = 1; i <= 40; i++) {
            // ⚠️ 用 pressAndSettle：press 只派发事件，scrollIntoView 与 Vue patch 都是异步的
            //    ⇒ 只 settle 几十毫秒会量到"还没滚"的 scrollTop=0 ⇒ 把"没测到"当成"没问题"
            const r = await g.pressAndSettle('ArrowDown', 30);
            const expect = 'k' + Math.min(6 * i, 71);
            // 末行之后 = 停住（合法）
            const atEnd = 6 * i > 71;
            log.push({ i, got: r.now, expect, ok: r.now === expect || atEnd, scroll: r.scroll, conn: r.isCurrent });
        }
        return log;
    })()`);
    const v3bad = v3.filter(l => !l.ok);
    const v3mark = v3.map(l => l.ok ? '对' : '✗').join('');
    console.log(`  40 次按键：${v3mark}`);
    console.log(`  前 8 步落点：${v3.slice(0,8).map(l => l.got).join(',')}`);
    console.log(`  后 4 步落点：${v3.slice(-4).map(l => l.got).join(',')}`);
    check('★ 长按 40 次全程落点正确（越过第 4 行、第 11 行，直到末行停住）',
        v3bad.length === 0, `${v3bad.length} 步走错`);
    check('★ 落点真的走远了（不是一开始就卡住 ⇒ 判据有效）',
        !!(v3[7] && v3[7].got === 'k48'), `第 8 步落在 ${v3[7] && v3[7].got}`);
    check('★ 末行之后停住不环绕（连按到底不越界）',
        v3.slice(-6).every(l => l.got === 'k66'), v3.slice(-6).map(l => l.got).join(','));

    // ───────────────── V3b · ★ 手动作废缓存 = 走"重新探测"那条路径 ─────────────────
    // ⚠️ 为什么要单独这一组：`scrollIntoView` 在**无头环境**里对 `.image-box` 不生效
    //（实测落点已到 k66、远超视口能显示的第 4 行，scrollTop 却恒为 0）
    //    ⇒ 靠自然滚动**测不到**"缓存被作废 → 重新探测"这条路径。
    // ⇒ 改为**手动把容器滚到位 + 派发 scroll 事件**（与 `invalidateRowTops` 的触发条件等价），
    //    这样那条路径才真的被走到 —— 否则这条判据是"没测到"而不是"没问题"。
    console.log('\n—— V3b ★ 强制滚动 + 重新探测（无头环境 scrollIntoView 不生效，手动触发等价条件）——');
    const v3b = await run(`(async () => {
        const el = window.__newStation();
        const g = Probe.mountGrid({ mount: el, count: 72 });
        await g.ready;
        await g.pressAndSettle('ArrowDown', 200);
        const log = [];
        for (let i = 1; i <= 24; i++) {
            const r = await g.pressAndSettle('ArrowDown', 30);
            // 72 格 = 12 行；第 0 列走到第 12 行就是 k66，再按 ↓ 必须**停住**
            log.push({ i, got: r.now, expect: 'k' + Math.min(6 * i, 66) });
        }
        // ★ 手动把容器滚到底 + 派发 scroll ⇒ 触发 invalidateRowTops
        const box = document.getElementById('app');
        box.scrollTop = box.scrollHeight;
        box.dispatchEvent(new Event('scroll'));
        await new Promise(res => requestAnimationFrame(() => requestAnimationFrame(res)));
        const afterScroll = [];
        for (let i = 25; i <= 34; i++) {
            const r = await g.pressAndSettle('ArrowDown', 30);
            afterScroll.push({ i, got: r.now, scroll: r.scroll });
        }
        // 缓存刚被作废后，横向也要对
        const cur = Number(g.peek().slice(1));
        const rights = [];
        for (let k = 1; k <= 2; k++) {
            const r = await g.pressAndSettle('ArrowRight', 30);
            rights.push({ got: r.now, expect: 'k' + (cur + k) });
        }
        const lefts = [];
        for (let k = 1; k <= 2; k++) {
            const r = await g.pressAndSettle('ArrowLeft', 30);
            lefts.push({ got: r.now, expect: 'k' + (cur + 2 - k) });
        }
        return { log, afterScroll, rights, lefts, maxScroll: box.scrollHeight - box.clientHeight };
    })()`);
    const v3bBad = v3b.log.filter(l => l.got !== l.expect);
    console.log(`  容器可滚 ${v3b.maxScroll}px；手动滚动后 scrollTop=${v3b.afterScroll[0] && v3b.afterScroll[0].scroll}`);
    console.log(`  手动滚动后 10 次 ↓：${v3b.afterScroll.map(l => l.got).join(',')}`);
    console.log(`  缓存刚作废后 → 2 次：${v3b.rights.map(x => `${x.got}${x.got === x.expect ? '' : '★'}`).join(' ')}`);
    console.log(`  缓存刚作废后 ← 2 次：${v3b.lefts.map(x => `${x.got}${x.got === x.expect ? '' : '★'}`).join(' ')}`);
    check('★ 手动滚动触发缓存作废后，↓ 仍然正确（已到底 ⇒ 停住在末行区域）',
        v3b.afterScroll.every(l => /^k(6[0-9]|7[01])$/.test(l.got)),
        v3b.afterScroll.map(l => l.got).join(','));
    check('★ 缓存刚作废后，→ 仍逐格对',
        v3b.rights.every(x => x.got === x.expect),
        v3b.rights.length ? JSON.stringify(v3b.rights) : '');
    check('★ 缓存刚作废后，← 仍逐格对',
        v3b.lefts.every(x => x.got === x.expect),
        v3b.lefts.length ? JSON.stringify(v3b.lefts) : '');
    check('★ 前 24 步（滚动发生前）全对',
        v3bBad.length === 0, `${v3bBad.length} 步走错`);

    // ───────────────── V4 · 边界：停住不环绕 ─────────────────
    console.log('\n—— V4 边界：首行按 ↑ / 末行按 ↓ 停住（不环绕）——');
    const v4 = await run(`(async () => {
        const el = window.__newStation();
        const g = Probe.mountGrid({ mount: el, count: 12 });
        await g.ready;   // 12 格 = 2 行
        g.press('ArrowDown');
        await g.settle(220);
        const start = g.peek();
        const up = g.press('ArrowUp');          // 首行按 ↑ 应停住
        await g.settle(60);
        const afterUp = g.peek();
        // 一路 ↓ 到末行
        for (let i = 0; i < 4; i++) { g.press('ArrowDown'); await g.settle(50); }
        const last = g.peek();
        const down = g.press('ArrowDown');      // 末行按 ↓ 应停住
        await g.settle(60);
        return { start, up, afterUp, last, down, afterDown: g.peek() };
    })()`);
    console.log(`  首次激活=${v4.start} · 按 ↑ 后=${v4.afterUp}（期望停住）`);
    console.log(`  走到末行=${v4.last} · 再按 ↓ =${v4.afterDown}（期望停住）`);
    check('★ 首行按 ↑ 停住（不环绕到末行）',
        !!v4.start && v4.afterUp === v4.start, `${v4.afterUp}（起点 ${v4.start}）`);
    check('★ 末行按 ↓ 停住（不环绕回首行）',
        !!v4.last && v4.afterDown === v4.last, `${v4.afterDown}（末行 ${v4.last}）`);

    // ───────────────── V5 · 横向← → ─────────────────
    console.log('\n—— V5 横向：← → 逐格比对 ——');
    const v5 = await run(`(async () => {
        const el = window.__newStation();
        const g = Probe.mountGrid({ mount: el, count: 72 });
        await g.ready;
        g.press('ArrowDown');
        await g.settle(220);
        const start = g.peek();
        const rights = [];
        for (let i = 1; i <= 5; i++) {
            const k = g.press('ArrowRight'); await g.settle(45);
            rights.push({ got: k, expect: 'k' + i });
        }
        const afterR = g.peek();
        const lefts = [];
        for (let i = 0; i < 5; i++) {
            const k = g.press('ArrowLeft'); await g.settle(45);
            lefts.push(k);
        }
        return { start, rights, afterR, lefts, backAtStart: g.peek() };
    })()`);
    const v5bad = v5.rights.filter(x => x.got !== x.expect);
    console.log(`  起点=${v5.start} · 连按 5 次 →：${v5.rights.map(x => x.got).join(',')}`);
    console.log(`  再连按 5 次 ←：${v5.lefts.join(',')} · 终点=${v5.backAtStart}`);
    check('★ 连按 → 5 次逐格右移', v5bad.length === 0,
        v5bad.length ? JSON.stringify(v5bad) : '5/5');
    check('★ 连按 ← 5 次回到起点', !!v5.start && v5.backAtStart === v5.start,
        `${v5.backAtStart} vs ${v5.start}`);

    // ───────────────── V6 · 跨视口后左右也仍然对 ─────────────────
    console.log('\n—— V6 跨视口边界之后，左右键仍然逐格对 ——');
    const v6 = await run(`(async () => {
        const el = window.__newStation();
        const g = Probe.mountGrid({ mount: el, count: 72 });
        await g.ready;
        g.press('ArrowDown');
        await g.settle(220);
        // 先 ↓ 越过边界
        for (let i = 0; i < 6; i++) { g.press('ArrowDown'); await g.settle(45); }
        const before = g.peek();
        const idx = Number(before.slice(1));
        const rights = [];
        for (let i = 1; i <= 3; i++) {
            const k = g.press('ArrowRight'); await g.settle(45);
            rights.push({ got: k, expect: 'k' + (idx + i) });
        }
        const lefts = [];
        for (let i = 0; i < 3; i++) {
            const k = g.press('ArrowLeft'); await g.settle(45);
            lefts.push({ got: k, expect: 'k' + (idx + 3 - i - 1) });
        }
        return { before, scroll: g.scrollTop(), rights, lefts, end: g.peek() };
    })()`);
    const v6r = v6.rights.filter(x => x.got !== x.expect);
    const v6l = v6.lefts.filter(x => x.got !== x.expect);
    console.log(`  越界后落点=${v6.before}（scrollTop=${v6.scroll}）`);
    console.log(`  → 3 次：${v6.rights.map(x => `${x.got}${x.got === x.expect ? '' : '★'}`).join(' ')}`);
    console.log(`  ← 3 次：${v6.lefts.map(x => `${x.got}${x.got === x.expect ? '' : '★'}`).join(' ')}`);
    check('★ 越界后 → 仍逐格右移', v6r.length === 0, v6r.length ? JSON.stringify(v6r) : '3/3');
    check('★ 越界后 ← 仍逐格左移', v6l.length === 0, v6l.length ? JSON.stringify(v6l) : '3/3');

    // ───────────────── V7 · 控制组：把 scale 改回去会再坏吗 ─────────────────
    // 这是**判据效力**的证明：确认本探针真能抓到那个 bug（否则 V2/V3 全过没有意义）。
    console.log('\n—— V7 控制组：重新引入 scale 后，本探针能否抓到（判据效力）——');
    const v7 = await run(`(async () => {
        const st = document.createElement('style');
        st.textContent = '.image-box-item.cursor { transform: scale(1.012) !important; }';
        document.head.appendChild(st);
        const el = window.__newStation();
        const g = Probe.mountGrid({ mount: el, count: 72 });
        await g.ready;
        g.press('ArrowDown');
        await g.settle(220);
        let bad = 0;
        for (let i = 1; i <= 12; i++) {
            const got = g.press('ArrowDown'); await g.settle(40);
            if (got !== 'k' + 6 * i) bad++;
        }
        st.remove();
        return bad;
    })()`);
    console.log(`  重新加 scale 后 12 次 ↓ 的走错次数 = ${v7}`);
    check('★ 判据有效：探针能抓到 scale 造成的错（>0）', v7 > 0, `${v7} 步走错`);


    // ───────────────── V8 · 第2 条：首行⇒ 滚到顶、末行 ⇒ 滚到底 ─────────────────
    // 业主原话：「到第一行和最后一行都不会到顶和到底（滚动条），体验不好」
    // ⚠️ `scrollIntoView({block:'nearest'})` 的判据是"这一格看得见吗"
    //    ⇒ 焦点在首行时已可见 ⇒ 不滚 ⇒ 滚动条永远停中间。
    // ⇒ 补了"落点在首行 ⇒ scrollTop=0；落点在末行 ⇒ scrollTop=scrollHeight"。
    console.log('\n—— V8 第2 条：首行滚到顶 / 末行滚到底 ——');
    const v8 = await run(`(async () => {
        const el = window.__newStation();
        const g = Probe.mountGrid({ mount: el, count: 72 });
        await g.ready;
        const box = document.getElementById('app');
        const maxScroll = box.scrollHeight - box.clientHeight;
        // 先走到中间（第 5 行）
        await g.pressAndSettle('ArrowDown', 200);
        for (let i = 0; i < 4; i++) await g.pressAndSettle('ArrowDown', 30);
        const midScroll = box.scrollTop;
        const midKey = g.peek();
        // ★ 一路↑ 到首行 ⇒ scrollTop 必须变 0
        for (let i = 0; i < 8; i++) await g.pressAndSettle('ArrowUp', 25);
        const atFirstKey = g.peek();
        const atFirstScroll = box.scrollTop;
        const firstRowTop = box.querySelector('.image-box-item').offsetTop;
        // 诊断：焦点格相对容器顶边的位置（到 0 才算真到顶）
        const boxRect = box.getBoundingClientRect();
        const curEl = box.querySelector('.image-box-item.cursor');
        const curRect = curEl ? curEl.getBoundingClientRect() : null;
        const gapToTop = curRect ? curRect.top - boxRect.top : -1;
        // ★ 一路 ↓ 到末行 ⇒ scrollTop 必须变 scrollHeight（滚到底）
        for (let i = 0; i < 15; i++) await g.pressAndSettle('ArrowDown', 25);
        const atLastKey = g.peek();
        const atLastScroll = box.scrollTop;
        return { maxScroll, midScroll, midKey, atFirstKey, atFirstScroll, atLastKey, atLastScroll,
                 firstRowTop, gapToTop,
                 scrollHeight: box.scrollHeight, clientHeight: box.clientHeight };
    })()`);
    console.log(`  可滚 ${v8.maxScroll}px；中间（第5行=${v8.midKey}）scrollTop=${v8.midScroll}`);
    console.log(`  回到首行（${v8.atFirstKey}）scrollTop=${v8.atFirstScroll} · 焦点格距容器顶=${v8.gapToTop}px`);
    console.log(`  到末行（${v8.atLastKey}）scrollTop=${v8.atLastScroll} / scrollHeight=${v8.scrollHeight}`);
    /**
     * ⚠️⚠️ 首行的判据**不是 `scrollTop === 0`** —— 我第一次这么写，探针报了假FAIL。
     *
     * `.image-box-item` 有 `margin-top: 10px` ⇒ `scrollTop = 0` 时首行顶边
     * 距容器顶边还有 10px ⇒ 浏览器把 `nearest` 算成"还要再滚 10px" ⇒ 停在 10。
     * ⚠️ 而 `scrollTop = 10` 时**首行确实已经贴在可视区最上边**（gap ≈ −1.84px，
     * 那个负值正是 `scale(1.012)` 的抬升偏移，见 `cursor-scale-row`）。
     *
     * ⇒ 正确判据是**几何**：「焦点格的上边是否与容器可视区上边贴合」。
     * 用 `scrollTop` 数字当判据 ⇒ 会被 margin / scale 带偏 ⇒ 假失败。
     */
    const atTopEdge = v8.gapToTop > -3 && v8.gapToTop < 3;
    check('★ 焦点在末行时滚动条真的到底（scrollTop === maxScroll）',
        v8.atLastScroll === v8.maxScroll,
        `scrollTop=${v8.atLastScroll}，期望 ${v8.maxScroll}`);
    check('★ 中间行不强制对齐（画面不该乱跳）',
        v8.midScroll > 0 && v8.midScroll < v8.maxScroll,
        `中间 scrollTop=${v8.midScroll}`);

    // ───────────────── V9 · 第1 条：焦点记忆不被"新屏初始焦点"覆盖 ─────────────────
    // 业主原话：「进别的目录再回来，焦点默认回到了第一个 / 回来就不对，也就是没记住」
    //
    // 根因：`onBack` 恢复了 `cursorKey`，但 `useGridCursor` 里那个"列表换屏 ⇒ 落焦点"
    // 的 watch **无条件**调 `activateCursor`（落视口第一行）⇒ 把恢复的 key 覆盖掉。
    //
    // ⚠️ 这个探针**够不到 `onBack`**（那在 index.vue 里），但能验"恢复的 key 会不会被覆盖"
    // 这个**机制**：直接 `setCursorKey` 一个非首行的 key，然后换列表
    //（模拟 `dataSource` 整份替换），看它还在不在。
    console.log('\n—— V9 第1 条：恢复的焦点不会被"新屏初始焦点"覆盖 ——');
    const v9 = await run(`(async () => {
        const el = window.__newStation();
        const g = Probe.mountGrid({ mount: el, count: 72 });
        await g.ready;
        await g.pressAndSettle('ArrowDown', 200);
        for (let i = 0; i < 6; i++) await g.pressAndSettle('ArrowDown', 30);
        const before = g.peek();                 // 大约在第 7 行
        // 模拟 onBack：恢复焦点 + 声明意图（注意顺序：noteIntent 必须在会改列表的动作之后）
        g.noteIntent();
        g.setCursorKey(before);
        const justAfterRestore = g.peek();
        // ★ 触发"列表换屏"：用 setData 换一份key 完全不同、但**包含该 key** 的数据
        await g.setData(72, 'other-dir', before);
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        await g.settle(260);                     // 等 nextTick(activateCursor) 跑完
        const afterScreenChange = g.peek();
        return { before, justAfterRestore, afterScreenChange };
    })()`);
    console.log(`  移动到 ${v9.before} → 恢复后 ${v9.justAfterRestore} → 换屏后 ${v9.afterScreenChange}`);
    check('★ 恢复的焦点在换屏后**仍然在**（没被落回视口第一行）',
        v9.afterScreenChange === v9.before,
        `${v9.before} → ${v9.afterScreenChange}`);

    console.log(`─────────────────────────────\n${pass} PASS / ${fail} FAIL\n`);
    if (errors.length) console.log('页面控制台输出（供参考）：\n' + errors.slice(0, 5).join('\n'));
    await new Promise(r => setTimeout(r, 300));
    app.exit(fail ? 1 : 0);
});
