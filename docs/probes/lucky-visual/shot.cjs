/**
 * 抽卡页 · 真实截图 + 布局诊断（只读，不改任何数据）
 * ---------------------------------------------------------------------------
 * 为什么需要它：这一页有两轮"上线了但看不见"的经历 —— 静态类型全对、HMR 也更新了，
 * 就是看不到包装盒。原因是 `.stage` 的 grid 把盒子和扇形排成了两行（纯布局问题，
 * typecheck 抓不到，也不该每次让业主替我肉眼验收）。
 *
 * 做法：**复用项目真实主进程**（`dist/electron/main/index.js`）—— 它起本地服务、
 * 注册 `ff-token`、建窗口；本脚本只负责把路由打到 `/lucky`、点按钮、截图、读尺寸。
 * 所以拿到的是真数据（真 token 换来真封面池），不是假数据摆拍。
 *
 * 跑法（两步，缺一不可）：
 *   ① VSCODE_DEBUG=1 npx vite                     # 只起 dev server（该开关会阻止插件自动拉 electron）
 *   ② env -u ELECTRON_RUN_AS_NODE \
 *        VITE_DEV_SERVER_URL=http://localhost:3344 \
 *        ./node_modules/electron/dist/electron.exe docs/probes/lucky-visual/shot.cjs
 *
 * ⚠️ `ELECTRON_RUN_AS_NODE` 必须去掉，否则 electron 退化成纯 node（`app` 是 undefined）。
 * ⚠️ 同一时刻只能有一个实例：先确认没有别的 dev 在跑，否则服务端口 3060 被占、
 *    单实例锁也会让本脚本直接退出。
 */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const OUT = __dirname;
const DEV_URL = process.env.VITE_DEV_SERVER_URL || 'http://localhost:3344';
const wait = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log('[shot]', ...a);

/** 复用真实主进程：服务、token、窗口全由它负责 */
require(path.join(__dirname, '../../../dist/electron/main/index.js'));

/**
 * 等到盒子**落位**再截图。
 *
 * ⚠️ 不能用固定延时：dev 首次冷编译要几秒，进场飞入又是 0.7s 的弹簧 ——
 *    固定 3 秒时常拍到"盒子还在屏幕外"的那一帧，看起来像页面坏了（假故障）。
 */
async function waitSettled(win, timeout = 12000) {
    const expr = `(() => {
        const c = document.querySelector('.pack');
        const s = document.querySelector('.pack-stage');
        if (!c || !s) return false;
        const a = c.getBoundingClientRect(), b = s.getBoundingClientRect();
        return Math.abs((a.left + a.width / 2) - (b.left + b.width / 2)) < 24
            && Math.abs((a.top + a.height / 2) - (b.top + b.height / 2)) < 24;
    })()`;
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
        if (await win.webContents.executeJavaScript(expr)) {
            log('settled in', Date.now() - t0, 'ms');
            return true;
        }
        await wait(150);
    }
    log('NOT settled within', timeout, 'ms');
    return false;
}

async function snap(win, name) {
    const img = await win.capturePage();
    fs.writeFileSync(path.join(OUT, name), img.toPNG());
    log('saved', name);
}

const DIAG = `(() => {
  const r = el => {
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return [Math.round(b.width), Math.round(b.height), Math.round(b.top), Math.round(b.left)];
  };
  const get = sel => document.querySelector(sel);
  return JSON.stringify({
    hash: location.hash,
    phase: get('.scene') ? get('.scene').dataset.phase : null,
    slots: document.querySelectorAll('.slot').length,
    articles: document.querySelectorAll('article.card').length,
    caseStage: r(get('.pack-stage')),
    caseTransform: get('.pack') ? get('.pack').style.transform : 'NO_CASE',
    flowOpacity: get('.flow') ? get('.flow').style.opacity : 'NO_FLOW',
    flowBands: document.querySelectorAll('.ff-band').length,
    filmClip: get('.film') ? (get('.film').style.clipPath || 'none').slice(0, 60) : 'NO_FILM',
    slotBox: r(get('.slot')),
    slotWidth: get('.slot') ? getComputedStyle(get('.slot')).width : 'NO_SLOT',
    cwVar: (() => { const el = document.querySelector('.lucky'); return el ? getComputedStyle(el).getPropertyValue('--cw') : 'NO_LUCKY'; })(),
    cardBox: r(get('article.card')),
    caseBox: r(get('.pack')),
    frontBox: r(get('.skin--front')),
    frontBg: get('.skin--front') ? getComputedStyle(get('.skin--front')).backgroundColor : null,
    discBox: r(get('.disc')),
    flowBox: r(get('.flow')),
    caseOpacity: get('.pack') ? getComputedStyle(get('.pack')).opacity : null,
    fan: r(get('.scene')),
    stage: r(document.querySelector('.stage')),
    buttons: [...document.querySelectorAll('button')].map(b => b.textContent.trim()).filter(Boolean),
  }, null, 1);
})()`;

app.whenReady().then(async () => {
    await wait(1500);
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) {
        log('NO_WINDOW —— 主进程没建窗口，检查 require 的产物是否存在');
        app.exit(2);
        return;
    }

    // 抓渲染进程的 console —— 页面报错时 Electron 不会主动告诉外面，
    // 表现就是"节点都找到了、位置却一直不对"，很难猜。
    win.webContents.on('console-message', (...args) => {
        const msg = args.find(a => typeof a === 'string' && a.length > 1);
        if (msg) log('[renderer]', msg);
    });
    win.setContentSize(1280, 800);
    await win.loadURL(`${DEV_URL}/#/lucky`);
    // 先等到页面把盒子渲染出来，再等它落位
    for (let i = 0; i < 60 && !(await win.webContents.executeJavaScript(`!!document.querySelector('.pack')`)); i++) {
        await wait(200);
    }
    await waitSettled(win);

    /**
     * 接口直查 —— 这一步是为了把"池子为空"分成三种完全不同的病：
     *   ① 服务没起 / 端口错      → fetch 直接抛
     *   ② 口令不一致             → 403
     *   ③ 服务正常但库没就绪     → 500 + error 文案
     * 没有这一段，界面上三种都长成同一张"还没有可以抽的封面"。
     */
    const api = await win.webContents.executeJavaScript(`(async () => {
      const out = {};
      let token = null;
      try {
        token = require('electron').ipcRenderer.sendSync('ff-token');
        out.tokenLen = token ? token.length : 0;
      } catch (e) { out.tokenErr = String(e); }
      for (const route of ['/getDisks', '/getAllCovers']) {
        try {
          const r = await fetch('http://127.0.0.1:3060' + route + '?t=' + (token || ''));
          const txt = await r.text();
          out[route] = { status: r.status, head: txt.slice(0, 240) };
        } catch (e) { out[route] = { error: String(e) }; }
      }
      return JSON.stringify(out, null, 1);
    })()`);
    log('api:\n' + api);

    log('diag(sealed):\n' + await win.webContents.executeJavaScript(DIAG));
    await snap(win, '01-sealed.png');

    const clicked = await win.webContents.executeJavaScript(`(() => {
      const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes('拆开'));
      if (!b) return 'NO_TEAR_BUTTON';
      b.click();
      return 'clicked';
    })()`);
    log('tear:', clicked);

    // 撕口 96 段、光流 35 条 —— 撕的中间那一帧比"落定"更有信息量
    await wait(300);
    await snap(win, '02-tearing.png');
    // 射出（卡片竖直冲出来）
    await wait(520);
    await snap(win, '02b-shot.png');
    // 螺旋中途（绕屏幕中心转圈）
    await wait(520);
    await snap(win, '02c-orbit.png');
    await wait(1400);
    log('diag(open):\n' + await win.webContents.executeJavaScript(DIAG));
    await snap(win, '03-open.png');

    // 深色主题再来一遍（他第一张截图就是深色，灰暗问题出在这里）
    await win.webContents.executeJavaScript(`
      document.documentElement.dataset.theme = 'dark';
      localStorage.setItem('ff-theme', 'dark');
    `);
    await wait(600);
    await snap(win, '04-open-dark.png');

    app.exit(0);
}).catch(e => {
    log('FAILED', e && e.stack || e);
    app.exit(1);
});
