/**
 * 无头 Electron 跑 index.html，用**真实 Chromium 布局**量「头部有几行」。
 *
 *   env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe docs/probes/header-width/run.cjs
 * 或跑 run.sh（会把输出写进 out.txt）。
 *
 * 为什么要真 Chromium：这个问题是**布局计算**（换行、flex 收缩、文本截断），
 * happy-dom 不做真实布局（getBoundingClientRect 全是 0）。页面里加载的是真的
 * naive-ui UMD + vue.global，所以量到的是真组件 + 真 CSS。
 *
 * 三个环境坑照抄 docs/probes/table-scroll/run.cjs（那里踩过、注释写全了）：
 *   1. 本机 shell 注入了 ELECTRON_RUN_AS_NODE=1 —— 必须 `env -u` 真删掉，设空串没用。
 *   2. 换独立 userData + 禁 GPU —— dev 实例占着默认 userData 的 GPUPersistentCache。
 *   3. show:false 的窗口在 Windows 上不参与合成、rAF 不推进 ⇒ offscreen + 关后台节流。
 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

app.setPath('userData', path.join(os.tmpdir(), 'probe-header-width'));
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.disableHardwareAcceleration();

app.whenReady().then(async () => {
    const win = new BrowserWindow({
        show: false,
        width: 2000,
        height: 900,
        webPreferences: { contextIsolation: false, backgroundThrottling: false, offscreen: true },
    });
    win.webContents.on('console-message', (_e, _lvl, msg) => console.log('[page]', msg));

    await win.loadFile(path.join(__dirname, 'index.html'));
    await new Promise(r => setTimeout(r, 1500));

    const out = await win.webContents.executeJavaScript('__probeAll()');
    console.table(out);

    // ── 工具条预算明细（把"元凶"变成数字）────────────────────────────────
    const budget = await win.webContents.executeJavaScript('__measureToolbar()');
    console.log('\n── 工具条预算（复刻件上量的，组件与 props 与真实模板一致）──');
    console.log(`总宽 ${budget.工具条总宽}px = 子元素合计 ${budget.子元素合计} + gap ${budget.gap合计}（${budget.gap单值}px × ${budget.子元素数 - 1}）`);
    console.table(budget.明细);

    // ── 四种工具条形态的对比：缩文案 / 挪角标 / 收下拉，各能还给导航区多少 ──
    const plans = await win.webContents.executeJavaScript('__measureToolbarPlans()');
    console.log('\n── 工具条形态对比（同为 new 变体，只换工具条内容）──');
    console.table(plans);
    for (const w of [640, 800, 1280]) {
        const row = plans.filter(p => p.窗口宽 === w)
            .map(p => `${p.方案}→${p.工具条宽}/${p.导航区宽}`).join('  ');
        console.log(`窗口 ${w}px（工具条宽/导航区宽）：${row}`);
    }

    // ── 根 chip 三形态（在"已批准"的工具条形态下）────────────────────────
    const chipForms = await win.webContents.executeJavaScript('__measureChipForms()');
    console.log('\n── 根 chip 三形态（工具条＝更多收纳后）──');
    console.table(chipForms);
    for (const w of [640, 800, 1280]) {
        const row = chipForms.filter(r => r.窗口宽 === w)
            .map(r => `${r.chip形态}→芯片${r.芯片宽}/导航区${r.导航区宽}`).join('  ');
        console.log(`窗口 ${w}px：${row}`);
    }

    // ── 视觉证据：截图 ────────────────────────────────────────────────────
    // 观感本来"只能目视"—— 那就把眼睛接进来：把头部区域截成 PNG，人可以（AI 也可以）
    // 直接看渲染结果。纯几何数字看不出的东西（分隔符压到边框、字重不合适）只有这一步能抓。
    // ── 逐个量导航区子元素（判断"塌成碎片"时谁的责任）────────────────────
    console.log('\n── 导航区子元素实际宽度 / 计算出的 flex ──');
    for (const w of [820, 1280]) {
        const m = await win.webContents.executeJavaScript(`__measureCrumbs(${w})`);
        console.log(`窗口 ${m.窗口宽}px · 导航区 ${m.导航区宽}px`);
        // 根 chip 的文本有没有溢出自己的盒子（溢出就会画到邻居身上，整条头部上看不出来）
        console.log(`  芯片文本 min-width=${m.芯片文本.已应用} · 文本宽 ${m.芯片文本.文本宽} / 盒子宽 ${m.芯片文本.盒子宽} · 溢出中=${m.芯片文本.溢出中}`);
        console.log(`  芯片外框宽 ${m.芯片外框宽} · 外框溢出=${m.芯片外框溢出}`);
        console.table(m.子元素);
    }

    for (const [name, which, chipForm, winW] of [
        ['shot-header.png', 'long', 'path', 1280],   // 长链 + 路径 chip：看折叠 / 截断 / 分隔符
        ['shot-crumbs.png', 'short', 'icon', 820],   // **复刻用户截图**：窄窗 + H: › 新建文件夹 + 图标 chip
    ]) {
        const rect = await win.webContents.executeJavaScript(`(async () => {
            window.__setVariant('new');
            window.__setToolbar('more2');
            window.__setSegs('${which}');
            window.__setChipForm('${chipForm}');
            document.getElementById('stage').style.width = '${winW}px';
            await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
            await new Promise(r => setTimeout(r, 150));
            const b = document.querySelector('.header-bar').getBoundingClientRect();
            return { x: Math.max(0, Math.floor(b.left) - 8), y: Math.max(0, Math.floor(b.top) - 8),
                     width: Math.ceil(b.width) + 16, height: Math.ceil(b.height) + 16 };
        })()`);
        const png = await win.webContents.capturePage(rect);
        fs.writeFileSync(path.join(__dirname, name), png.toPNG());
        console.log(`── 截图：${name}（窗口 ${winW}px · ${rect.width}×${rect.height}）`);
    }
    await win.webContents.executeJavaScript(`window.__setSegs('long'); window.__setChipForm('path');`);

    // 只截左边"chip + 面包屑"那一块：整条头部缩到 1256px 宽时，5px 级的间距差别看不出来，
    // 而"分隔符离边框多远"恰恰是 5px 级的问题。
    await win.webContents.executeJavaScript(`(async () => {
        window.__setVariant('new'); window.__setToolbar('more2');
        window.__setSegs('long'); window.__setChipForm('path');
        document.getElementById('stage').style.width = '1280px';
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        await new Promise(r => setTimeout(r, 150));
    })()`);
    const zoomRect = await win.webContents.executeJavaScript(`(() => {
        const nav = document.querySelector('.nav-zone').getBoundingClientRect();
        return { x: Math.floor(nav.left), y: Math.floor(nav.top) - 6, width: Math.min(470, Math.ceil(nav.width)), height: Math.ceil(nav.height) + 12 };
    })()`);
    fs.writeFileSync(path.join(__dirname, 'shot-left.png'),
        (await win.webContents.capturePage(zoomRect)).toPNG());
    console.log(`── 截图：shot-left.png（左区局部 ${zoomRect.width}×${zoomRect.height}）`);

    /**
     * 判据（全部对应"头部高度取决于内容"这个原始问题）：
     *   ① **头部高是常量** —— 它在四档窗口宽度下必须完全一致（这一条是核心）
     *   ② 当前段可见 —— 折叠后"我在哪"不能被挤出屏幕
     *   ③ 工具条不溢出
     *   ④ **角标不得"新增"裁剪** —— 2026-10-02 加。角标挂在当前段 tag 的最右侧，
     *      而 `.nav-zone` 是 `overflow: hidden`，伪元素又拿不到 rect ⇒ 只能靠
     *      `scrollWidth > clientWidth` 抓"有内容被裁"。
     *      ⚠️ 但口径必须是**相对**的：640/800 下这个东西**本来就裁**（面包屑 + 根 chip +
     *      返回三样本来就挤在一起，见 README「已知局限」）。要判的是
     *      "**无角标不裁、有角标才裁**" —— 拿"所有档都不裁"当判据，
     *      等于让本次改动去背历史债，那种 ❌ 是假的。
     *   ⑤ 角标**真的画出来了** —— 直接问 `::after` 的 content（"none" = 那条 scoped 规则没命中）
     * `old` 变体只作对照打印，不参与判定；`new-无角标` 只作④的对照。
     */
    const news = out.filter(r => r.变体 === 'new');
    const ctrl = out.filter(r => r.变体 === 'new-无角标');
    const heights = [...new Set(news.map(r => r.头部高))];
    const bad = news.filter(r => r.当前段可见 !== true || !r.工具条未溢出);
    const noCount = news.filter(r => !String(r['::after内容']).includes('35'));
    const regressed = news.filter(r => {
        const c = ctrl.find(x => x.窗口宽 === r.窗口宽);
        return r.导航区溢出 === true && !!c && c.导航区溢出 !== true;
    });
    const ok = heights.length === 1 && bad.length === 0
        && noCount.length === 0 && regressed.length === 0;

    console.log(`\nnew 变体头部高（各宽度）：${news.map(r => r.窗口宽 + '→' + r.头部高 + 'px').join('  ')}`);
    console.log(`old 变体头部高（各宽度）：${out.filter(r => r.变体 === 'old').map(r => r.窗口宽 + '→' + r.头部高 + 'px').join('  ')}`);
    console.log(`new 头部截断段数：${news.map(r => r.有截断的段数).join('/')}`);
    // 这一行是"真实 scoped CSS 生效"的硬证据：`::before` 的 content 只有在那条
    // scoped 规则命中时才不会是 none
    console.log(`new 分隔符 ::before content：${JSON.stringify(news.map(r => r['::before内容']))}`);
    // 同上，2026-10-02 这批：角标的 `::after` content
    console.log(`new 角标   ::after  content：${JSON.stringify(news.map(r => r['::after内容']))}`);
    console.log(`new 导航区宽（各宽度）：${news.map(r => r.窗口宽 + '→' + r.导航区宽 + 'px').join('  ')}`);
    console.log(`new 导航区是否裁掉内容：${news.map(r => r.窗口宽 + '→' + (r.导航区溢出 ? '⚠️裁了' : '没裁')).join('  ')}`);
    // 对照：同一形态但**关掉角标**。两行一比就知道"裁内容"是既有的还是本次引入的。
    console.log(`对照·无角标 导航区宽：${ctrl.map(r => r.窗口宽 + '→' + r.导航区宽 + 'px').join('  ')}`);
    console.log(`对照·无角标 导航区是否裁内容：${ctrl.map(r => r.窗口宽 + '→' + (r.导航区溢出 ? '⚠️裁了' : '没裁')).join('  ')}`);
    console.log(regressed.length === 0
        ? '⇒ 角标**没有新增**任何一档裁剪（640/800 的裁剪在无角标时同样出现 ⇒ 既有局限，与本次改动无关）'
        : `⇒ ⚠️ 角标新增了裁剪：${regressed.map(r => r.窗口宽 + 'px').join('、')}（无角标不裁、有角标才裁）`);
    console.log(ok
        ? `\n✅ new：头部高在 ${news.length} 档宽度下**完全一致**（常量）；当前段可见、工具条不溢出、角标已画出且未新增裁剪`
        : `\n❌ new：头部高各档=${heights.join(',')}（要求完全一致）；${bad.length} 条布局不满足，${noCount.length} 档没画出角标，${regressed.length} 档因角标新增裁剪`);
    app.quit();
}).catch(e => {
    console.error('PROBE FAILED:', e && e.message ? e.message : e);
    app.exit(1);
});
