/**
 * 无头 Electron 跑 dist/index.html，验「双击无行为 + 滚轮缩放」。
 *
 *   env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe docs/probes/preview-dblclick/run.cjs
 *
 * ⚠️ 三个环境坑（与 preview-bar 同源）：`env -u` 必须真删 ELECTRON_RUN_AS_NODE；
 * 独立 userData + 禁 GPU；窗口必须 offscreen（否则 rAF 不推进，Transition 的 enter-from赖着不走）。
 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const os = require('node:os');

app.setPath('userData', path.join(os.tmpdir(), 'probe-preview-dblclick'));
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.disableHardwareAcceleration();

const wait = ms => new Promise(r => setTimeout(r, ms));

app.whenReady().then(async () => {
    const win = new BrowserWindow({
        show: false, width: 1400, height: 900,
        webPreferences: { contextIsolation: false, backgroundThrottling: false, offscreen: true },
    });
    win.webContents.on('console-message', (_e, lvl, msg) => {
        if (String(lvl) === '3' || /error|Error/.test(msg)) console.log('[page]', msg);
    });

    await win.loadFile(path.join(__dirname, 'dist', 'index.html'));
    await wait(1200);

    const out = await win.webContents.executeJavaScript(`(async () => {
        const wait = ms => new Promise(r => setTimeout(r, ms));
        const o = {};
        const $ = s => document.querySelector(s);
        const img = () => $('.n-image-preview');
        const scale = () => {
            const el = img(); if (!el) return null;
            // ⚠️ naive-ui 是**整段写 style.cssText**（ImagePreview.mjs:319），不是 style.transform
            //   ⇒ 读 style.transform 永远读不到（我第一版就这么错的，3 条断言全 FAIL）。
            const t = el.style.cssText || el.getAttribute('style') || '';
            const m = /scale\\(([0-9.]+)\\)/.exec(t);
            if (m) return Math.round(parseFloat(m[1]) * 1000) / 1000;
            return t.includes('scale(') ? -1 : null;   // 有 transform 但没数字 = 还没缩放
        };
        const dbl = (x, y) => {
            for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click',
                                'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'dblclick']) {
                img().dispatchEvent(new MouseEvent(type, {
                    bubbles: true, cancelable: true, clientX: x, clientY: y, detail: 1,
                }));
            }
        };
        const wheel = (dy) => {
            document.dispatchEvent(new WheelEvent('wheel', { deltaY: dy, bubbles: true, cancelable: true }));
        };
        const reset = () => { const h = window.__hits; h.cardDblclick = 0; h.overlayClick = 0; h.wheel = 0; h.dblclickFired = 0; h.cardFound = false; h.stackLen = 0; };

        const box = img().getBoundingClientRect();
        const cx = Math.round(box.left + box.width / 2);
        const cy = Math.round(box.top + box.height / 2);

        // ①双击图：什么都不该发生
        reset();
        dbl(cx, cy);
        await wait(400);
        o.dblclick_new = { cardDblclick: window.__hits.cardDblclick, wheel: window.__hits.wheel };
        o.previewStillOpen_1 = !!img();

        // ② A/B 对照：切回旧实现，同样双击 ⇒ 卡片真的收到了
        window.__setNoop(false);
        reset();
        dbl(cx, cy);
        await wait(400);
        o.dblclick_old = { cardDblclick: window.__hits.cardDblclick, previewClosed: !img(), dblclickFired: window.__hits.dblclickFired, cardFound: window.__hits.cardFound, stackLen: window.__hits.stackLen };
        window.__setNoop(true);

        // 重新打开：A/B 对照那步把预览关了，用受控的 current 触发重开不行
        //（show 是 ref）⇒ 走工具条那颗「重开」按钮（见 main.js 里 refresh）
        if (!img()) { window.__reopen(); await wait(600); }

        // ③ 滚轮放大：transform 的 scale 真变了吗
        if (!img()) { document.querySelector('.n-image-preview-toolbar span')?.click(); await wait(500); }
        o.beforeWheel_scale = scale();
        reset();
        wheel(-120); await wait(350);
        wheel(-120); await wait(350);
        o.afterZoomIn_scale = scale();
        // 初始未缩放时 scale() 返回 null（还没写 transform）⇒ 判据用「放大后有数字且> 1」
        o.zoomIn_works = o.afterZoomIn_scale !== null && o.afterZoomIn_scale > 1;
        o.wheelHandled = window.__hits.wheel;

        // ④ 滚轮缩小
        wheel(+120); await wait(350);
        o.afterZoomOut_scale = scale();
        o.zoomOut_works = o.afterZoomOut_scale < o.afterZoomIn_scale;

        // ⑤ 关窗后必须撤掉滚轮监听（否则是"看不见的全局监听"）
        document.querySelector('.n-image-preview-toolbar span')?.click();
        await wait(500);
        o.closed = !img();
        o.listenerAfterClose = window.__wheelListenerAttached();
        reset();
        wheel(-120); await wait(300);
        o.wheelAfterClose = window.__hits.wheel;
        o.noGhostListener = o.wheelAfterClose === 0 && o.listenerAfterClose === false;

        return o;
    })()`);

    console.log(JSON.stringify(out, null, 2));

    // 判定
    const checks = [
        ['① 双击不触发卡片（原 BUG）', out.dblclick_new.cardDblclick === 0],
        ['① 双击后预览仍开着', out.previewStillOpen_1 === true],
        // ⚠️ 断言用 `>= 1` 而不是 `=== 1`：旧实现**本来就会被调两次**
        //   （naive-ui 的 mergeProps 把同名 onXxx 合成数组、两个都调）——
        //   那正是 2026-10-04 修掉的既有缺陷（见 preview-nav 探针 6a/6b/6c）。
        //   这里测的是"旧实现会穿透"这个事实，次数多少不影响结论。
        ['② A/B 对照：旧实现确实会穿透', out.dblclick_old.cardDblclick >= 1],
        ['③ 滚轮放大生效（scale 变大）', out.zoomIn_works === true],
        ['④ 滚轮缩小生效（scale 变小）', out.zoomOut_works === true],
        ['⑤ 关窗后无残留滚轮监听', out.noGhostListener === true],
    ];
    console.log('\n---- 判定 ----');
    let pass = 0;
    for (const [name, ok] of checks) { console.log((ok ? 'PASS' : 'FAIL') + '  ' + name); ok && pass++; }
    console.log('\\n' + pass + '/' + checks.length + ' PASS');

    app.quit();
}).catch(e => { console.error(e); app.quit(); });
