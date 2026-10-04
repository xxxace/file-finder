/**
 * 无头 Electron 跑 dist/index.html，验「底部通栏工具条」的几何。
 *
 *   env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe docs/probes/preview-bar/run.cjs
 *
 * ⚠️ 三个环境坑（与 preview-nav 同源，都踩过）：
 *   1. 本机 shell 注入了 ELECTRON_RUN_AS_NODE=1，直接跑 electron 会被当成 node ⇒ 必须 `env -u`。
 *   2. 独立 userData + 禁 GPU：dev 实例占着默认 userData 的 GPUPersistentCache。
 *   3. 窗口必须 offscreen：show:false 时 Windows 上不参与合成 → rAF 不推进 →
 *      Vue <Transition> 的 enter-from（scale .9）赖着不走 ⇒ 量出来的盒子小 10%。
 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const os = require('node:os');

app.setPath('userData', path.join(os.tmpdir(), 'probe-preview-bar'));
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.disableHardwareAcceleration();

const wait = ms => new Promise(r => setTimeout(r, ms));

/** 视口：从 1400×900（小窗）到 2048×1280（主人主屏逻辑分辨率） */
const SIZES = [[1400, 900], [2048, 1280]];

app.whenReady().then(async () => {
    const win = new BrowserWindow({
        show: false,
        width: 2048,
        height: 1280,
        webPreferences: { contextIsolation: false, backgroundThrottling: false, offscreen: true },
    });
    win.webContents.on('console-message', (_e, lvl, msg) => {
        if (String(lvl) === '3' || /error|Error/.test(msg)) console.log('[page]', msg);
    });

    await win.loadFile(path.join(__dirname, 'dist', 'index.html'));
    await wait(1200);

    for (const [W, H] of SIZES) {
        win.setSize(W, H, false);
        await wait(500);
        const out = await win.webContents.executeJavaScript(`(async () => {
            const wait = ms => new Promise(r => setTimeout(r, ms));
            const $ = sel => document.querySelector(sel);
            const box = el => { if (!el) return null; const r = el.getBoundingClientRect();
                return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
                         right: Math.round(r.right), bottom: Math.round(r.bottom) }; };
            const cs = el => { if (!el) return null; const s = getComputedStyle(el);
                return { transform: s.transform, borderRadius: s.borderRadius, background: s.backgroundColor,
                         position: s.position, padding: s.padding }; };

            const o = {};
            o.viewport = { w: innerWidth, h: innerHeight };
            const tb = $('.n-image-preview-toolbar');
            const wrap = $('.n-image-preview-wrapper');
            const img = $('.n-image-preview');
            o.toolbarBox = box(tb);
            o.wrapperBox = box(wrap);
            o.imgBox = box(img);
            o.toolbarStyle = cs(tb);
            o.wrapperStyle = cs(wrap);

            // ① 工具条真贴底通栏？
            o.tbFlushBottom = o.toolbarBox.bottom === o.viewport.h;
            o.tbFullWidth = o.toolbarBox.w === o.viewport.w;
            o.tbLeft0 = o.toolbarBox.x === 0;
            // transform 必须真去掉 —— 残留 translateX 会让整条左移半屏
            o.tbNoLeftoverShift = ['none', 'matrix(1, 0, 0, 1, 0, 0)'].includes(o.toolbarStyle.transform);

            // ② 图有没有被工具条压住？（核心断言）
            o.imgOverlapsToolbar = o.imgBox.bottom > o.toolbarBox.y;
            o.imgGapToToolbar = o.toolbarBox.y - o.imgBox.bottom;

            // ③ 图的外边距：上/左/右应各16px（与改之前一致）
            o.gaps = { top: o.imgBox.y, left: o.imgBox.x,
                       right: o.viewport.w - o.imgBox.right,
                       bottom: o.viewport.h - o.imgBox.bottom };

            // ④ 通栏宽度利用：内容实际占多宽（原来居中胶囊 ~844，两侧各空 600+）
            const nameEl = tb?.querySelector('span span');
            o.nameText = nameEl?.textContent ?? '';
            o.nameBox = box(nameEl);
            o.countText = tb?.querySelectorAll('span span span')[1]?.textContent
                       ?? [...(tb?.querySelectorAll('span') ?? [])].map(e => e.textContent).join('|');
            o.iconCount = tb ? tb.querySelectorAll('.n-base-icon').length : 0;
            // 左右分组：最后一个按钮的右缘应贴着工具条右内边距
            const icons = tb ? [...tb.querySelectorAll('.n-base-icon')] : [];
            o.lastIcon = box(icons[icons.length - 1]);
            o.firstNameBox = box(tb?.querySelector('span'));

            // ⑤ 图外可点区（wrapper padding 那圈归overlay ⇒ 点它能关）
            const overlay = $('.n-image-preview-overlay');
            o.overlayBox = box(overlay);
            const probe = (x, y) => { const el = document.elementFromPoint(x, y); return el ? (el.className || el.tagName) : null; };
            o.hitTopGap = probe(Math.round(o.viewport.w / 2), Math.round(o.wrapperBox.y + 4));
            o.hitLeftGap = probe(Math.round(o.imgBox.x / 2), Math.round(o.viewport.h / 2));

            // ⑥ A/B：点图外会不会真的关
            window.__wasOpen = !!$('.n-image-preview');
            const leftMid = { x: Math.round(o.imgBox.x / 2), y: Math.round(o.viewport.h / 2) };
            const el = document.elementFromPoint(leftMid.x, leftMid.y);
            o.leftGapTarget = el ? (el.className || el.tagName) : null;
            if (el) el.click();
            await wait(400);
            o.closedAfterLeftGapClick = !document.querySelector('.n-image-preview');
            // 重新打开，继续测宽银幕
            window.__probe.open(); await wait(500);

            // ⑦ 换一张**竖图**（宽度受限 ⇒ 高度方向应留满）
            window.__probe.setCurrent(1); await wait(500);
            o.tallImgBox = box($('.n-image-preview'));
            o.tallOverlapsToolbar = o.tallImgBox.bottom > o.toolbarBox.y;
            o.tallGapToToolbar = o.toolbarBox.y - o.tallImgBox.bottom;

            // ⑧ 长名称：不许把计数/按钮挤走（ellipsis 生效 + 右边组仍贴右）
            window.__probe.setName('非常非常长的作品标题'.repeat(12));
            await wait(400);
            o.longNameBox = box($('.n-image-preview-toolbar span span'));
            o.longNameClipped = (() => { const el = $('.n-image-preview-toolbar span span');
                return el ? el.scrollWidth > el.clientWidth : null; })();
            o.longNameRightEdge = o.longNameBox ? Math.round(o.longNameBox.right) : null;
            o.lastIconAfterLong = box([...document.querySelectorAll('.n-image-preview-toolbar .n-base-icon')].pop());

            return o;
        })()`);
        console.log(`\n===== 视口 ${W}×${H} =====`);
        console.log(JSON.stringify(out, null, 2));
    }

    app.quit();
}).catch(e => { console.error(e); app.quit(); });
