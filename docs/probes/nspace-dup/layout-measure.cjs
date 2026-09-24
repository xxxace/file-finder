/**
 * 用真 Chrome 量工具条布局。
 *   NODE_PATH=<装了 playwright 的 node_modules> node layout-measure.cjs
 * 走 channel:'chrome' 驱动**本机已装的 Chrome**，不下载 playwright 的浏览器。
 */
const path = require('path');
const { chromium } = require('playwright');

const HTML = 'file:///' + path.join(__dirname, 'layout.html').replace(/\\/g, '/');

(async () => {
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    const label = { a: 'a  n-space 原样（基线）', b: 'b  中间态 .hstack（用户截图）', c: 'c  修后 .toolbar + 200px' };
    const errors = [];
    let allOk = true;

    // 三个窗口宽度都量一遍：修后必须在**任何**宽度下都只有一行
    for (const width of [1805, 1280, 900]) {
        const page = await browser.newPage({ viewport: { width, height: 420 } });
        page.on('pageerror', e => errors.push(String(e)));
        page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

        await page.goto(HTML);
        await page.waitForFunction(() => typeof window.__measure === 'function', { timeout: 15000 });
        await page.waitForTimeout(300);

        const r = await page.evaluate(() => window.__measure());
        await page.close();

        console.log(`===== 视口宽度 ${width} =====`);
        for (const k of ['a', 'b', 'c']) {
            const m = r[k];
            console.log(`${label[k]}`);
            console.log(`   头部 ${String(m.headerHeight).padStart(3)}px  视觉行数 ${m.rows}  flex-wrap=${m.groupFlexWrap}  搜索框 ${String(m.searchWidth).padStart(4)}px  右侧组 ${m.groupWidth}px`);
        }
        const c1 = r.b.headerHeight > r.a.headerHeight + 20;
        const c2 = r.c.headerHeight <= r.a.headerHeight + 2;
        const c3 = r.c.rows === r.a.rows;
        const ok = width === 1805 ? (c1 && c2 && c3) : (c2 && c3);
        console.log(
            `   判据① 中间态确实坏掉 : ${c1 ? 'PASS' : 'FAIL'} (${r.b.headerHeight} vs ${r.a.headerHeight})\n` +
            `   判据② 修后≈基线高度  : ${c2 ? 'PASS' : 'FAIL'} (${r.c.headerHeight} vs ${r.a.headerHeight})\n` +
            `   判据③ 修后≈基线的行数: ${c3 ? 'PASS' : 'FAIL'} (${r.c.rows} vs ${r.a.rows})\n` +
            `   → ${ok ? 'PASS' : 'FAIL'}\n`
        );
        allOk = allOk && ok;
    }

    await browser.close();
    if (errors.length) { console.log('页面错误：'); errors.slice(0, 10).forEach(e => console.log('  ' + e)); }
    process.exit(allOk ? 0 : 1);
})();
