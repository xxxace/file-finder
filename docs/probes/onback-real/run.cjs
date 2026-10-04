/**
 * 无头 Electron 探针 · `onBack` 的**真函数体**（从 index.vue 抽源代码，不手抄）
 * ==============================================================================
 *   bash docs/probes/onback-real/run.sh
 *
 * 验什么：业主 2026-10-05 八次报「**滚动后返回，scroll 高度没恢复**」。
 *
 * ## 为什么是这一招（而不是继续推理 / 继续写局部探针）
 *
 * scroll 这件事我已经**错了三次**，每次都是「读代码 → 推理 → 改恢复端 → 局部探针」。
 * ⚠️ 三次都没碰过**完整链路**（history + dataSource + 真 DOM + 真时序）。
 *
 * ⇒ 这次换手法：**把 `onBack` 与 `waitForGridOf` 的函数体从 `index.vue` 里
 *   programmatically 抽出来**，用 `new Function` 在真 Vue + 真 DOM 里执行。
 *
 * - **被测逻辑是真的**：源码原样编译，不是我手抄的复刻件（复刻件会分叉）
 * - **环境是假的**：`fetchFolder` 我造假（可控延迟），因为真的那个要连 :3060
 *   ⇒ ⚠️ 这一条是**本探针的已知边界**，结论里必须标出来
 *
 * ## 关键判据
 *
 * | 组 | 验什么 |
 * |---|---|
 * | R1 | 冒烟：抽出的源码能编译、能跑 |
 * | R2 | A（内容长、滚到 800）→ 进 B → **B 里滚动** → 返回 A ⇒ A 必须回到 800 |
 * | R3 | **对照**：A（内容短、没滚动）→ 进 B → 返回 A ⇒ 那条"看起来正常"的路 |
 * | R4 | ⚠️ 快速返回（B 还没加载完就返回）⇒ A 仍要正确 |
 *
 * 输出不含任何真实路径 / 用户名 / 盘序列号。
 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

app.setPath('userData', path.join(os.tmpdir(), 'probe-onback-real'));
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

/**
 * 从 index.vue 里抽出某个顶层函数的**完整源文本**。
 *
 * ⚠️ **用括号配平，不用"找行首 `}`"** —— 我第一版用 `indexOf('\n}\n')`，
 * 它会匹配到**函数体内**的某个行首 `}`（模板字符串 / 嵌套块），抽出来的是半截函数。
 * 配平对这段源码是成立的（`onBack` 体内的 `${...}` 插值括号本身配对）。
 */
const extractFn = (src, header) => {
    const i = src.indexOf(header);
    if (i < 0) throw new Error('找不到 ' + header);
    let depth = 0, started = false;
    for (let k = i; k < src.length; k++) {
        const c = src[k];
        if (c === '{') { depth++; started = true; }
        else if (c === '}') {
            depth--;
            if (started && depth === 0) {
                return { body: src.slice(i + header.length, k), full: src.slice(i, k + 1), end: k };
            }
        }
    }
    throw new Error(header + ' 的括号不配平');
};

app.whenReady().then(async () => {
    const repo = path.resolve(__dirname, '../../..');
    const vueSrc = fs.readFileSync(path.resolve(repo, 'src/views/FileFinder/index.vue'), 'utf8');

    // ───────────────── 抽取真源码 ─────────────────
    console.log('—— R0 从 index.vue 抽真源码 ——');
    let onBack, waitFn;
    try {
        onBack = extractFn(vueSrc, 'const onBack = async () => {');
        waitFn = extractFn(vueSrc, 'const waitForGridOf = async (path: string, maxFrames = 20) => {');
    } catch (e) {
        console.log('  FAIL  抽取失败：' + e.message);
        app.exit(1);
        return;
    }
    console.log(`  onBack         抽取 ${onBack.body.length} 字符`);
    console.log(`  waitForGridOf  抽取 ${waitFn.body.length} 字符`);
    check('两个函数都抽到了（没被改名/重构）',
        onBack.body.length > 500 && waitFn.body.length > 200,
        `${onBack.body.length} / ${waitFn.body.length}`);

    // ───────────────── 起真窗口 ─────────────────
    const win = new BrowserWindow({
        show: false, width: 2100, height: 700,
        webPreferences: { contextIsolation: false, backgroundThrottling: false, offscreen: true },
    });
    win.webContents.on('console-message', (_e, _l, m) => { if (m) console.log('[page]', m); });
    await win.loadFile(path.join(__dirname, 'index.html'));
    await new Promise(r => setTimeout(r, 600));
    const run = (js) => win.webContents.executeJavaScript(js).catch(e => 'ERR: ' + String(e));

    // 注入真源码。
    // ⚠️⚠️ 两个坑（我各踩了一次）：
    //   ① **不能把 `const f = ...` 整段赋给 `window.x`** ⇒ `window.x = const ...` 是语法错
    //      （报 `Unexpected token 'const'`，看起来像"源码有问题"，其实是拼装方式错）
    //   ② **`new Function` 不接受 TS 类型注解** ⇒ `async (path: string, ...)` 会炸
    //      ⇒ 用**无类型的**形参表重新拼（形参名必须在 body 里对得上）
    const waitArrow = 'async (path, maxFrames = 20) => {' + waitFn.body + '}';
    const inject = await run(`(() => {
        window.waitForGridOf = new Function('return (' + ${JSON.stringify(waitArrow)} + ')')();
        return window.__install(${JSON.stringify(onBack.body)});
    })()`);
    check('★ 抽出的源码能编译（R1 冒烟）', inject === true, String(inject));


    // ───────────────── R0b · 单独测 waitForGridOf（它是"未就位"的嫌疑人）─────────────────
    console.log('\n—— R0b 直接调用 waitForGridOf 看它到底为什么不成立 ——');
    const r0b = await run(`(async () => {
        window.__mountBox();
        await window.__enter('D:/sample/A', 30, 0);
        const box = document.getElementById('box');
        const first = (typeof fileList !== 'undefined' ? fileList.value[0] : null);
        const el = box.querySelector('.image-box-item');
        const probe = {
            fileList0: first ? { dir: first.dir, name: first.name } : null,
            elKey: el ? el.dataset.key : '(no el)',
            keyOfFirst: first ? keyOf(first) : null,
            domCount: box.querySelectorAll('.image-box-item').length,
            typeofWait: typeof window.waitForGridOf,
        };
        let ret, err = null;
        try { ret = await window.waitForGridOf('D:/sample/A'); }
        catch (e) { err = String(e); }
        probe.returned = ret;
        probe.err = err;
        return probe;
    })()`);
    console.log('  ' + JSON.stringify(r0b));
    check('★ waitForGridOf 在"DOM 已就位"时应当返回 true',
        r0b && r0b.returned === true,
        r0b ? `returned=${r0b.returned} err=${r0b.err}` : 'undefined');

    // ───────────────── R2 · 主力场景：滚动后返回 ─────────────────
    console.log('\n—— R2 ★ A（滚到 800）→ 进 B → B 里滚动 → 返回 A ——');
    const r2 = await run(`(async () => {
        window.__mountBox();
        const box = document.getElementById('box');
        // 1) 造 A 屏（30 条 = 5 行）并滚到 800
        const a = await window.__enter('D:/sample/A', 30, 800);
        // 2) 模拟从 A 进入 B：先记住 A 的 scrollY（与 enterScreen 的第一句同款）
        const aEntry = { path: 'D:/sample/A', mode: 'cover', searchText: '', scrollY: box.scrollTop, cursorKey: '' };
        window.__setHistory([aEntry]);
        // 3) enterScreen(B) 的关键几步（抄自源码语义，非复刻判定逻辑）
        window.__setHistory([
            { ...aEntry, scrollY: box.scrollTop },
            { path: 'D:/sample/B', mode: 'cover', searchText: '', scrollY: 0, cursorKey: '' },
        ]);
        box.scrollTo(0, 0);
        await window.waitForGridOf('D:/sample/B');
        await new Promise(r => setTimeout(r, 60));
        // 4) 在 B 里滚动（B 内容更长：60 条）
        box.scrollTo(0, 1500);
        const inB = box.scrollTop;
        // 5) 返回 A —— 跑**真的** onBack
        await window.__onBack();
        await new Promise(r => setTimeout(r, 120));
        return {
            aScrollWhenLeft: aEntry.scrollY,
            inB,
            afterBack: box.scrollTop,
            maxAfter: box.scrollHeight - box.clientHeight,
            contentAfter: box.scrollHeight,
            history: window.__peek().history,
            notes: window.__peek().notes,
        };
    })()`);
    console.log(`  A 离开时 scrollTop = ${r2.aScrollWhenLeft}`);
    console.log(`  在 B 里滚到        = ${r2.inB}`);
    console.log(`  返回 A 之后        = ${r2.afterBack}（内容高 ${r2.contentAfter}，可滚 ${r2.maxAfter}）`);
    console.log(`  history            = ${JSON.stringify(r2.history)}`);
    console.log(`  诊断消息           = ${JSON.stringify(r2.notes)}`);
    check('★ **返回 A 后必须回到 800**（这就是主人报的场景）',
        Math.abs(r2.afterBack - r2.aScrollWhenLeft) < 3,
        `实际 ${r2.afterBack}，期望 ${r2.aScrollWhenLeft}`);

    // ───────────────── R3 · 对照：没滚动的屏 ─────────────────
    console.log('\n—— R3 对照：A 没滚动（scrollY=0）⇒ 那条"看起来正常"的路 ——');
    const r3 = await run(`(async () => {
        const box = document.getElementById('box');
        await window.__enter('D:/sample/A2', 30, 0);
        const aEntry = { path: 'D:/sample/A2', mode: 'cover', searchText: '', scrollY: box.scrollTop, cursorKey: '' };
        window.__setHistory([aEntry,
            { path: 'D:/sample/B2', mode: 'cover', searchText: '', scrollY: 0, cursorKey: '' }]);
        box.scrollTo(0, 0);
        await window.waitForGridOf('D:/sample/B2');
        await new Promise(r => setTimeout(r, 60));
        box.scrollTo(0, 900);
        await window.__onBack();
        await new Promise(r => setTimeout(r, 120));
        return { after: box.scrollTop };
    })()`);
    console.log(`  返回后 scrollTop = ${r3.after}`);
    check('★ 没滚动过 ⇒ 返回后应当停在 0（且**不是靠"跳过分支"实现的**）',
        r3.after === 0, `${r3.after}`);

    // ───────────────── R4 · 快速返回（B 还没加载完） ─────────────────
    console.log('\n—— R4 快速返回：进 B 后**不等加载完**就返回 ——');
    const r4 = await run(`(async () => {
        const box = document.getElementById('box');
        await window.__enter('D:/sample/A3', 30, 700);
        const aEntry = { path: 'D:/sample/A3', mode: 'cover', searchText: '', scrollY: box.scrollTop, cursorKey: '' };
        window.__setHistory([aEntry,
            { path: 'D:/sample/B3', mode: 'cover', searchText: '', scrollY: 0, cursorKey: '' }]);
        box.scrollTo(0, 0);
        // ⚠️ **不等** B 加载完，直接返回
        await window.__onBack();
        await new Promise(r => setTimeout(r, 200));
        return { after: box.scrollTop, content: box.scrollHeight };
    })()`);
    console.log(`  返回后 scrollTop = ${r4.after}（内容高 ${r4.content}）`);
    check('★ 快速返回也要回到 700', r4.after === 700, `${r4.after}`);

    console.log(`─────────────────────────────\n${pass} PASS / ${fail} FAIL\n`);
    console.log('⚠️ 本探针的已知边界：`fetchFolder` 是**假的**（可控延迟 + 假数据）。');
    console.log('   真应用里它走 HTTP(:3060)，时序可能不同 ⇒ 结论要标注这一点。');
    await new Promise(r => setTimeout(r, 300));
    app.exit(fail ? 1 : 0);
});
