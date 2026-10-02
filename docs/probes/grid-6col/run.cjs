/**
 * 网格左右贴边 —— 真 Chromium 布局测量。
 *
 *   bash docs/probes/grid-6col/run.sh        # 输出写 out.txt
 *
 * 要回答的三件事：
 *   ① 一行到底几个（按**渲染结果**数，不是按公式推：数首行有几个格子顶边相同）；
 *   ② 首格的左边 = 头部的左边？末格右边 = 头部的右边？（改动前应差 5px，改动后应 ≈0）
 *   ③ 改完之后一行**还是不是 6 个**（负 margin 让容器变宽了，必须复核列数没变）。
 *
 * 对照：`probe-nofix` 变体 = 把负 margin 关掉 = **改动之前**的形态。
 * 两行一比就知道"5px 内缩"是不是真的被消掉了。
 *
 * 环境坑照抄 ../header-width/run.cjs（那里写全了）：`env -u ELECTRON_RUN_AS_NODE` 不能省、
 * 独立 userData、offscreen + 关后台节流。
 *
 * ⚠️ **本探针测不到那几个响应式断点**（≤600px 变 5 列、≤400px 3 列…）：它们是
 * `@media (max-width:...)`，看的是 **viewport**，而这里改的是 `#stage` 的宽度。
 * 桌面窗口又有 `minWidth: 1024` ⇒ 用户根本触不到那几档。故不测，也不改。
 *
 * 零读盘：不碰 searchCache.db、不 stat 任何盘。
 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const os = require('node:os');

app.setPath('userData', path.join(os.tmpdir(), 'probe-grid-6col'));
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.disableHardwareAcceleration();

const WIDTHS = [1920, 1280, 1024];

app.whenReady().then(async () => {
    const win = new BrowserWindow({
        show: false,
        width: 2000,
        height: 900,
        webPreferences: { contextIsolation: false, backgroundThrottling: false, offscreen: true },
    });
    win.webContents.on('console-message', (_e, _lvl, msg) => console.log('[page]', msg));

    await win.loadFile(path.join(__dirname, 'index.html'));
    await new Promise(r => setTimeout(r, 800));

    const out = [];
    for (const [variant, fix] of [['改动前(无负margin)', false], ['改动后(负margin)', true]]) {
        await win.webContents.executeJavaScript(`window.__setVariant(${fix})`);
        await new Promise(r => setTimeout(r, 120));
        for (const w of WIDTHS) {
            out.push(await win.webContents.executeJavaScript(`window.__measure(${JSON.stringify(variant)}, ${w})`));
        }
    }

    console.log('\n── 逐档测量 ──');
    console.table(out);

    console.log('\n── 位置（每档：头部左…头部右 ｜ 网格容器左…右 ｜ 首格左 · 首行末格右）──');
    for (const r of out) {
        console.log(`  ${r.变体} @${r.窗口宽}  `
            + `头部 ${r.头部左}…${r.头部右} ｜ 网格 ${r.网格容器左}…${r.网格容器右} ｜ `
            + `首格左 ${r.首格左} · 末格右 ${r.首行末格右}`);
    }

    const before = out.filter(r => r.变体.startsWith('改动前'));
    const after = out.filter(r => r.变体.startsWith('改动后'));

    console.log('\n── 判据 ──');
    const checks = [];
    for (const r of before) {
        checks.push([`[对照] 改动前 @${r.窗口宽}：确实**内缩 5px**（首格右移 5、末格左移 5）`,
            r.首格相对头部 === 5 && r.末格相对头部 === 5]);
    }
    for (const r of after) {
        checks.push([`改动后 @${r.窗口宽}：首格贴边（首格相对头部 = 0）`, r.首格相对头部 === 0]);
        checks.push([`改动后 @${r.窗口宽}：末格贴边（末格相对头部 = 0）`, r.末格相对头部 === 0]);
        // 负 margin 把容器撑宽了 10px ⇒ 必须复核列数没被这个变化带跑
        checks.push([`改动后 @${r.窗口宽}：一行**仍是 6 个**（实测 ${r.首行格数}）`, r.首行格数 === 6]);
    }
    // 对照组也必须仍是 6 个，否则说明"格子变宽了"这件事本身把列数改了
    for (const r of before) {
        checks.push([`[对照] 改动前 @${r.窗口宽}：一行也是 6 个（实测 ${r.首行格数}）`, r.首行格数 === 6]);
    }

    let allOk = true;
    for (const [label, pass] of checks) {
        if (!pass) allOk = false;
        console.log(`  ${pass ? '✅' : '❌'} ${label}`);
    }
    console.log(allOk
        ? '\n✅ 改动前左右各内缩 5px（对照成立）→ 改动后首末格与头部对齐，且一行仍是 6 个'
        : '\n❌ 有不满足的项，见上');

    // ── 视觉证据：头部 + 前两行网格 ────────────────────────────────────────
    // "对齐"是个**相对关系**，数字能证明它，但"看起来齐不齐"只有图能说。
    // 截同一档（1280px）的前后两张，并排一看就知道。
    const fs = require('node:fs');
    for (const [name, fix] of [['shot-before.png', false], ['shot-after.png', true]]) {
        await win.webContents.executeJavaScript(`(async () => {
            window.__setVariant(${fix});
            document.getElementById('stage').style.width = '1280px';
            await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
            await new Promise(r => setTimeout(r, 150));
        })()`);
        const rect = await win.webContents.executeJavaScript(`(() => {
            const hb = document.querySelector('.header-bar').getBoundingClientRect();
            const items = [...document.querySelectorAll('.image-box-item')];
            // 第二行第一个格子的下边缘 = 两行网格底
            const row2 = items[7].getBoundingClientRect();
            return {
                x: 0, y: Math.max(0, Math.floor(hb.top) - 6),
                width: Math.ceil(hb.right) + 10,
                height: Math.ceil(Math.max(row2.bottom, hb.bottom) - hb.top) + 14,
            };
        })()`);
        fs.writeFileSync(path.join(__dirname, name), (await win.webContents.capturePage(rect)).toPNG());
        console.log(`── 截图：${name}（${rect.width}×${rect.height}）`);
    }

    app.quit();
}).catch(e => {
    console.error('PROBE FAILED:', e && e.message ? e.message : e);
    app.exit(1);
});
