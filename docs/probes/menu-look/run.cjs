/**
 * 无头 Electron 探针 · 「更多」菜单的外观是否真的生效
 * ==============================================================================
 *   bash docs/probes/menu-look/run.sh
 *
 * 验什么：业主 2026-10-04 五次报「多步（更多）的选择器好丑，和外面不统一」。
 *
 * ## 为什么必须真渲染
 *
 * 修法是给 `n-dropdown` 传 `menu-props`（内含 5 个 `--n-*` CSS 变量）。
 * ⚠️ 变量到底**落不落得到 DOM 上**、CSS**消不消费它**，读代码只能推断：
 * `DropdownMenu.render` 的根节点是**手写** `createElementBlock("div", {...})`，
 * 我一度担心 attrs 不透传（Vue 只在 `inheritAttrs !== false` 且单根时才自动落）。
 * ⇒ 必须开真 Chromium 看 `menu.style.getPropertyValue('--n-…')` 与
 *   `getComputedStyle(menu).borderRadius` **两个值**。
 *
 * ## 同时验「形态是竖排」（业主裁决：按内容形态，不全统一）
 *
 * 业主原话：「如果更多也要应该是上下，应该**根据实际布局来的，而不是全统一**」。
 * ⇒ 4 个文字动作**保持竖排**（Windows 资源管理器也是竖排）；
 *横排要为它另写一个浮层，与本项目"不新增界面"的立场冲突。
 * 判据 = 四个选项的 `y` 各不相同、**`x` 相同**、宽度相同。
 *
 * 输出不含任何真实路径 / 用户名 / 盘序列号。
 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const os = require('node:os');

app.setPath('userData', path.join(os.tmpdir(), 'probe-menu-look'));
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

app.whenReady().then(async () => {
    const win = new BrowserWindow({
        show: false, width: 1280, height: 800,
        webPreferences: { contextIsolation: false, backgroundThrottling: false, offscreen: true },
    });
    await win.loadFile(path.join(__dirname, 'index.html'));
    await new Promise(r => setTimeout(r, 700));

    const run = (js) => win.webContents.executeJavaScript(js).catch(e => 'ERR: ' + String(e));

    // ───────────────── 打开菜单 ─────────────────
    console.log('—— 打开菜单 ——');
    const opened = await run('__open()');
    check('点击后菜单真的弹出来了', opened === true, `__open() = ${opened}`);
    if (!opened) { console.log('⛔ 菜单没开，后续无意义。'); app.exit(1); return; }

    // ───────────────── M1 · CSS 变量真的落到 DOM 上吗 ─────────────────
    console.log('\n—— M1 CSS 变量是否落到 DOM ——');
    const m = await run('__measure()');
    console.log('  —— 实测 ——');
    console.log(`  --n-border-radius      = "${m.varRadius}"`);
    console.log(`  --n-font-size          = "${m.varFontSize}"`);
    console.log(`  --n-option-height      = "${m.varOptHeight}"`);
    console.log(`  --n-option-color-hover  = "${m.varHover}"`);
    console.log(`  --n-option-color-active = "${m.varActive}"`);
    const varCount = [m.varRadius, m.varFontSize, m.varOptHeight, m.varHover, m.varActive]
        .filter(Boolean).length;
    check('★ 5 个变量全部落到了菜单根节点上', varCount === 5, `${varCount}/5`);

    // ───────────────── M2 · CSS 真的消费了它们吗（计算值） ─────────────────
    console.log('\n—— M2 计算值：CSS 是否真的消费了变量 ——');
    console.log(`  getComputedStyle(menu).borderRadius = ${m.radius}`);
    console.log(`  选项字号 = ${m.fontSize} · 选项高度 = ${m.optHeight.toFixed(1)}px`);
    check('★ 圆角真的变成 4px（不是 naive-ui 默认的 6px）',
        m.radius === '4px', m.radius);
    check('★ 字号真的变成 14px', m.fontSize === '14px', m.fontSize);
    check('★ 选项高度真的变成 32px（默认 34px）',
        Math.abs(m.optHeight - 32) < 1.5, `${m.optHeight.toFixed(1)}px`);

    // ───────────────── M3 · 形态：竖排（业主裁决"按内容形态"） ─────────────────
    console.log('\n—— M3 形态：4 个文字动作应当竖排 ——');
    console.log('  选项矩形（x, y, w）：');
    m.firstRects.forEach(r => console.log(`    (${r.x}, ${r.y}, ${r.w})`));
    const ys = m.firstRects.map(r => r.y);
    const xs = m.firstRects.map(r => r.x);
    const ws = m.firstRects.map(r => r.w);
    const allDistinctY = new Set(ys).size === ys.length;
    const sameX = new Set(xs).size === 1;
    const sameW = new Set(ws).size === 1;
    check('★ 四个选项 y 各不相同（真的是竖排，不是横排）', allDistinctY, ys.join(','));
    check('★ 四个选项 x 相同（同一列）', sameX, xs.join(','));
    check('★ 四个选项等宽（不是四个独立按钮）', sameW, ws.join(','));
    check('★ 恰好 4 个选项', m.optionCount === 4, `${m.optionCount} 个`);

    // ───────────────── M4 · 控制组：不传 menu-props 是什么值 ─────────────────
    // 页面里已挂好一个"对照组"下拉（同位置、无 menu-props），点开量它的默认值
    console.log('\n—— M4 控制组：不传 menu-props 时的默认值 ——');
    const ctl = await run('__openControl()');
    console.log(`  默认：圆角=${ctl.radius} · 字号=${ctl.fontSize} · 选项高=${ctl.optHeight.toFixed(1)}px`);
    check('★ 对照组与改后确实不同（否则"改后"没意义）',
        ctl.radius !== m.radius || Math.abs(ctl.optHeight - m.optHeight) > 0.5,
        `默认 ${ctl.radius}/${ctl.optHeight.toFixed(1)}px vs 改后 ${m.radius}/${m.optHeight.toFixed(1)}px`);

    console.log(`─────────────────────────────\n${pass} PASS / ${fail} FAIL\n`);
    await new Promise(r => setTimeout(r, 300));
    app.exit(fail ? 1 : 0);
});
