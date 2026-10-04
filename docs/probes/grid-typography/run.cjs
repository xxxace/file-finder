/**
 * 无头 Electron 探针 · 网格排版：改前 vs 改后
 * ==============================================================================
 *   bash docs/probes/grid-typography/run.sh
 *
 * 验什么：业主 2026-10-05 七次报「整体很不协调」「反 slop」。
 *
 * ##⚠️ 一条被实测纠正的认知（这条我原先判断错了）
 *
 * 我以为"每格都铺淡蓝灰底"是 slop 来源 ⇒ 动手前先查了产品 CSS：
 * **静止态根本没有底色规则** —— 底色只出现在 `.cursor` / `:hover` / `:active` / `.picked`。
 * ⇒ 主人图上那层淡蓝灰是**焦点格 + 悬停格**，不是"每格都有"。
 * ⇒ 这一条写进探针注释与文档，**防止将来又有人按错误的认知去"修"**。
 *
 * ## 真正改掉的三样（都有依据，依据的效力逐条标注在 index.html 里）
 *
 * | 项 | 改前 | 改后 |
 * |---|---|---|
 * | 文件名字号 | `1em`(16px) | **13px** |
 * | 文件名字重 | `bold` | **400 常规** |
 * | 文件名颜色 | `#000` | **次级灰 `#4b5563`** |
 * | 焦点底色 | `.16` | **`.10`（更淡）** |
 * | 单侧发光 | `box-shadow: 1px 0 10px` | **去掉** |
 *
 * 输出不含任何真实路径 / 用户名 / 盘序列号。
 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const os = require('node:os');

app.setPath('userData', path.join(os.tmpdir(), 'probe-grid-typography'));
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
        show: false, width: 900, height: 520,
        webPreferences: { contextIsolation: false, backgroundThrottling: false, offscreen: true },
    });
    await win.loadFile(path.join(__dirname, 'index.html'));
    await new Promise(r => setTimeout(r, 500));
    const run = (js) => win.webContents.executeJavaScript(js).catch(e => 'ERR: ' + String(e));

    // ───────────────── T1 · 静止态确实没有底色（纠正我自己的认知） ─────────────────
    console.log('—— T1 静止态底色（改前那一档也要看）——');
    const m = await run('__measure()');
    console.log(`  改前 静止底色 = ${m.variant.idleBg}（不透明=${m.variant.idleBgOpaque}）`);
    console.log(`  改后 静止底色 = ${m.clean.idleBg}（不透明=${m.clean.idleBgOpaque}）`);
    check('★ 静止态**本来就没有**底色（我原先"每格铺底"的判断是错的）',
        !m.variant.idleBgOpaque && !m.clean.idleBgOpaque,
        `改前 ${m.variant.idleBg} / 改后 ${m.clean.idleBg}`);

    // ───────────────── T2 · 排版三件套真的改了 ─────────────────
    console.log('\n—— T2 文件名排版 ——');
    console.log(`  改前 ${m.variant.fontSize} / ${m.variant.fontWeight}`);
    console.log(`  改后 ${m.clean.fontSize} / ${m.clean.fontWeight}`);
    check('★ 字号 16px → 13px（不是标题级）',
        m.variant.fontSize === '16px' && m.clean.fontSize === '13px',
        `${m.variant.fontSize} → ${m.clean.fontSize}`);
    check('★ 字重 bold → 常规 400',
        m.variant.fontWeight === '700' && m.clean.fontWeight === '400',
        `${m.variant.fontWeight} → ${m.clean.fontWeight}`);

    // ───────────────── T3 · 单侧发光已去掉 ─────────────────
    console.log('\n—— T3 焦点态：单侧发光 ——');
    const sh = await run(`(() => {
        const g = (id) => {
            const on = document.querySelector('#' + id + ' .cell.on');
            return { shadow: getComputedStyle(on).boxShadow, bg: getComputedStyle(on).backgroundColor };
        };
        return { before: g('a'), after: g('b') };
    })()`);
    console.log(`  改前 box-shadow = ${sh.before.shadow}`);
    console.log(`  改后 box-shadow = ${sh.after.shadow}`);
    console.log(`  改前 底色= ${sh.before.bg}`);
    console.log(`  改后 底色= ${sh.after.bg}`);
    check('★ 改后焦点没有 box-shadow（单侧发光已去掉）',
        sh.after.shadow === 'none', sh.after.shadow);
    check('★ 改前那条是**单侧**的（x 偏移 1px、y 0 ⇒ 只向右发光）',
        /1px 0px/.test(sh.before.shadow), sh.before.shadow);

    // ⚠️ **不截图**：`capturePage()` 在本机无头环境会挂住（实测 SIGTERM）。
    //    需要看图时用 `show:true` 手动开一次窗口；判据全部走 `getComputedStyle`，不依赖像素。

    console.log(`─────────────────────────────\n${pass} PASS / ${fail} FAIL\n`);
    await new Promise(r => setTimeout(r, 300));
    app.exit(fail ? 1 : 0);
});

