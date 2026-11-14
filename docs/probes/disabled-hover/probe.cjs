/**
 * 最小复现：disabled 的表单控件上，浏览器到底派发不派发指针事件？
 *
 * 这个结论决定了一件事：`v-tip`（依赖 pointerenter）能不能用在禁用按钮上。
 * 若不能，那「禁用态用原生 title」就不是疏忽，而是唯一可行的手段。
 *
 * 同时测 `elementFromPoint` —— 它代表浏览器的命中测试结果。
 * UA 的原生 title 气泡依赖命中测试（不依赖 JS 事件），所以这两条合起来才是完整判据。
 *
 * 跑法：npx electron docs/probes/disabled-hover/probe.cjs
 * 输出：docs/probes/disabled-hover/out.txt
 */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const OUT = path.join(__dirname, 'out.txt');
const lines = [];
const log = (s) => { lines.push(s); console.log(s); };

const HTML = `<!doctype html><html><head><meta charset="utf-8">
<style>
  body { margin: 0; font: 14px sans-serif; }
  #wrap { position: absolute; left: 20px; top: 20px; width: 160px; }
  button { width: 120px; height: 40px; display: block; margin: 0; box-sizing: border-box; }
  #plain { position: absolute; left: 20px; top: 120px; width: 120px; height: 40px; }
</style></head><body>
<div id="wrap">
  <button id="on">可用</button>
  <button id="off" disabled title="禁用原因">禁用</button>
</div>
<div id="plain">普通 div</div>
<script>
  window.log = [];
  for (const id of ['on', 'off', 'plain']) {
    const el = document.getElementById(id);
    for (const t of ['pointerenter', 'pointerover', 'mouseenter', 'mouseover', 'pointermove']) {
      el.addEventListener(t, () => {
        // pointermove 会刷屏，每类只记第一次
        const key = id + ':' + t;
        if (!window.log.includes(key)) window.log.push(key);
      });
    }
  }
</script></body></html>`;

const move = (win, x, y) => win.webContents.sendInputEvent({ type: 'mouseMove', x, y });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 360, height: 260,
    show: true,
    webPreferences: { offscreen: false },
  });

  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(HTML));
  await wait(400);

  log('=== 场景 1：指针移到「可用」按钮中心 (80,40) ===');
  move(win, 80, 40);
  await wait(300);

  log('=== 场景 2：指针移到「禁用」按钮中心 (80,80) ===');
  move(win, 80, 80);
  await wait(300);

  log('=== 场景 3：指针移到普通 div 中心 (80,140) ===');
  move(win, 80, 140);
  await wait(300);

  const result = await win.webContents.executeJavaScript(`(() => ({
    events: window.log.slice(),
    hitOff: (() => { const e = document.elementFromPoint(80, 80); return e ? (e.id || e.tagName) : null; })(),
    hitOn: (() => { const e = document.elementFromPoint(80, 40); return e ? (e.id || e.tagName) : null; })(),
    cursorOff: getComputedStyle(document.getElementById('off')).cursor,
  }))()`);

  log('');
  log('--- 结果 ---');
  log('捕获到的指针事件: ' + JSON.stringify(result.events));
  log('elementFromPoint(禁用按钮) = ' + result.hitOff);
  log('elementFromPoint(可用按钮) = ' + result.hitOn);
  log('禁用按钮 computed cursor = ' + result.cursorOff);
  log('');
  log('判读：');
  log('  · 若 events 里只有 on:* 与 plain:*、没有 off:* ⇒ disabled 不派发 JS 指针事件 ⇒ v-tip 在禁用态失效');
  log('  · 若 hitOff === "off" ⇒ 命中测试看得到它 ⇒ UA 的 title 气泡仍可能显示');
  log('  · 两者同时成立 = 「禁用态只能用原生 title」这个结论成立');

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, lines.join('\n') + '\n', 'utf8');
  app.exit(0);
});
