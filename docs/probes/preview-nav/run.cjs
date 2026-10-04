/**
 * 无头 Electron 跑 dist/index.html，验「预览层 上一条/下一条 + 定位」的七条机制。
 *
 *   env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe docs/probes/preview-nav/run.cjs
 *
 * ⚠️ 两个环境坑（与 preview-fill 同源，都踩过）：
 *   1. 本机 shell 注入了 `ELECTRON_RUN_AS_NODE=1`，直接跑 electron 会被当成 node，
 *      `require('electron')` 返回的不是 app ⇒ 必须 `env -u` 真删掉（设空字符串没用）。
 *   2. 换独立 userData + 禁 GPU：项目的 dev 实例占着默认 userData 的 GPUPersistentCache，
 *      共用会让 GPU 进程反复崩、渲染进程加载失败（ERR_FAILED）。
 *   3. 窗口必须 offscreen：show:false 时 Windows 上不参与合成 → rAF 不推进 →
 *      Vue `<Transition>` 的 enter-from（scale .9）赖着不走 ⇒ 量出来的盒子小 10%。
 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const os = require('node:os');

app.setPath('userData', path.join(os.tmpdir(), 'probe-preview-nav'));
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.disableHardwareAcceleration();

const wait = (ms) => new Promise(r => setTimeout(r, ms));

app.whenReady().then(async () => {
    const win = new BrowserWindow({
        show: false,
        width: 1400,
        height: 900,
        webPreferences: { contextIsolation: false, backgroundThrottling: false, offscreen: true },
    });
    win.webContents.on('console-message', (_e, lvl, msg) => {
        if (String(lvl) === '3' || /error|Error/.test(msg)) console.log('[page]', msg);
    });

    await win.loadFile(path.join(__dirname, 'dist', 'index.html'));
    await wait(1200);

    const out = await win.webContents.executeJavaScript(`(async () => {
        const wait = ms => new Promise(r => setTimeout(r, ms));
        const ctl = window.__ctl;
        const out = {};
        const $ = sel => document.querySelector(sel);
        const img = () => $('.n-image-preview');
        const overlay = () => $('.n-image-preview-overlay');
        const readImg = () => {
            const el = img();
            if (!el) return { open: false };
            const r = el.getBoundingClientRect();
            const cs = getComputedStyle(el);
            const want = ctl.srcList.value[ctl.current.value];
            return {
                open: true,
                natural: [el.naturalWidth, el.naturalHeight],
                box: [Math.round(r.width), Math.round(r.height)],
                inlineStyle: el.getAttribute('style') || '',
                objectFit: cs.objectFit,
                // 与"当前索引该显示的那张"逐字节比：这才是"上一条/下一条真的换了图"的判据
                srcMatched: (el.getAttribute('src') || '') === want,
            };
        };
        const key = k => { document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })); };
        const toolbarIcons = () => Array.from(document.querySelectorAll('.n-image-preview-toolbar .n-base-icon'));

        // ── ① 空节点的 group 能不能显示预览 + ⑤ 铺满样式有没有喂到 img
        ctl.photoEntry(0);
        await wait(500);
        out['1_打开与铺满'] = { ...readImg(), imgCount: document.querySelectorAll('.n-image-preview').length };

        // ── ②③ ← → 键：naive-ui 自己监听的 keydown
        key('ArrowRight');
        await wait(400);
        out['2_右下一条'] = { index: ctl.current.value, ...readImg() };
        key('ArrowLeft');
        await wait(400);
        out['3_左上一条'] = { index: ctl.current.value, ...readImg() };
        // 环绕：从 0 再往左
        key('ArrowLeft');
        await wait(400);
        out['3b_首条再往左_应环绕'] = { index: ctl.current.value, total: ctl.srcList.value.length };

        // ── ④ 工具条里的 prev / next 点得动吗（我们把它排进了自己拼的数组）
        ctl.photoEntry(0);
        await wait(400);
        const icons = toolbarIcons();
        out['4_工具条' ] = {
            icons: icons.length,
            text: ($('.n-image-preview-toolbar') || {}).textContent || '',
        };
        // next 在数组里排第 2（第 1 颗是 prev —— 与 index.vue 的顺序一致）
        if (icons[1]) icons[1].dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await wait(400);
        out['4b_点next'] = {
            index: ctl.current.value,
            ...readImg(),
            // 名称/计数必须跟着当前索引走（它们是 name / count 两个节点）
            toolbarText: ($('.n-image-preview-toolbar') || {}).textContent || '',
        };

        // ── ⑩ 关闭之后 ← → 不该还有残留监听（naive-ui 只在 show 时挂 keydown）
        ctl.close();
        await wait(400);
        const closedIndex = ctl.current.value;
        key('ArrowRight');
        await wait(300);
        out['10_关闭后按右键'] = { indexBefore: closedIndex, indexAfter: ctl.current.value, stillClosed: !img() };
        ctl.photoEntry(0);
        await wait(400);

        // ── ⑥ 双击穿透 A/B：不加守卫 / 加守卫（同一个 MouseEvent 只处理一次）
        ctl.photoEntry(0);
        await wait(400);
        ctl.guarded.value = false;
        ctl.dblclickHits.value = 0;
        img().dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: 700, clientY: 450 }));
        await wait(200);
        out['6a_双击_不加守卫'] = { hits: ctl.dblclickHits.value };
        ctl.guarded.value = true;
        ctl.dblclickHits.value = 0;
        img().dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: 700, clientY: 450 }));
        await wait(200);
        out['6b_双击_加守卫'] = { hits: ctl.dblclickHits.value };
        // 再来一次不同的事件对象：守卫不该把"下一次双击"也吞掉
        ctl.dblclickHits.value = 0;
        img().dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: 701, clientY: 451 }));
        await wait(200);
        out['6c_下一次双击_应仍然生效'] = { hits: ctl.dblclickHits.value };

        // ── ⑦ srcList 里同位置换成原图：索引不漂移、src 就地换
        ctl.photoEntry(1);
        await wait(500);
        const beforeUpgrade = readImg();
        ctl.upgrade();
        await wait(500);
        out['7_缩略图换原图'] = {
            index: ctl.current.value,
            beforeNatural: beforeUpgrade.natural,
            afterNatural: readImg().natural,
            srcMatched: readImg().srcMatched,
            naturalGrew: readImg().natural[0] > beforeUpgrade.natural[0],
        };

        // ── ⑧ 图标条目：width:auto / height:128px 那一档
        ctl.close();
        await wait(400);
        ctl.iconEntry();
        await wait(500);
        out['8_图标条目'] = readImg();

        // ── ⑨ 打开/关闭的开关是否跟着受控值走
        ctl.close();
        await wait(500);
        out['9_关闭后'] = { img: !!img(), overlay: !!overlay() };
        ctl.photoEntry(0);
        await wait(500);
        out['9b_再打开'] = { img: !!img(), ...readImg() };

        return out;
    })()`);

    console.log(JSON.stringify(out, null, 2));
    app.quit();
}).catch(e => {
    console.error('PROBE FAILED:', e && e.message ? e.message : e);
    app.exit(1);
});
