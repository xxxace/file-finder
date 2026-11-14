/**
 * 最小复现 v2：disabled 表单控件上的指针事件是否完整（enter + leave 成对）？
 *
 * 上一版发现了反直觉的事实：`<button disabled>` **会**派发 pointerenter。
 * 这一版加三组对照，确认探针本身有效，并专门验证 leave 是否也派发 ——
 * 若只有 enter 没有 leave，v-tip 会在禁用按钮上永久卡住，比现状更糟。
 *
 * 跑法（必须清掉 ELECTRON_RUN_AS_NODE）：
 *   PowerShell: Remove-Item Env:ELECTRON_RUN_AS_NODE; electron.exe probe.cjs
 * 输出：out.txt（英文，避免控制台编码干扰判读）
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
  button { width: 120px; height: 40px; display: block; margin: 0; box-sizing: border-box; }
  #offPN { pointer-events: none; }
  #gap { height: 40px; }
</style></head><body>
<button id="on">enabled</button>
<button id="off" disabled title="disabled reason">disabled</button>
<button id="offPN" disabled>disabled + pe:none</button>
<div id="gap"></div>
<script>
  window.log = [];
  for (const id of ['on', 'off', 'offPN']) {
    const el = document.getElementById(id);
    for (const t of ['pointerenter', 'pointerleave']) {
      el.addEventListener(t, () => window.log.push(id + ':' + t));
    }
  }
</script></body></html>`;

const move = (win, x, y) => win.webContents.sendInputEvent({ type: 'mouseMove', x, y });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 360, height: 320, show: true });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(HTML));
  await wait(400);

  const mark = (s) => { log(''); log('--- ' + s + ' ---'); };
  const dump = async (label) => {
    const ev = await win.webContents.executeJavaScript('window.log.slice()');
    log(label + ' => ' + JSON.stringify(ev));
  };

  // 逐个进入/离开：每次先移到下方空白 (80,285)，确保 leave 会触发
  mark('A. enabled button (80,20)');
  move(win, 80, 285); await wait(150);
  move(win, 80, 20); await wait(200);
  await dump('after enter');
  move(win, 80, 285); await wait(200);
  await dump('after leave');

  mark('B. disabled button (80,60)');
  move(win, 80, 60); await wait(200);
  await dump('after enter');
  move(win, 80, 285); await wait(200);
  await dump('after leave');

  mark('C. disabled + pointer-events:none (80,100)');
  move(win, 80, 100); await wait(200);
  await dump('after enter');
  move(win, 80, 285); await wait(200);
  await dump('after leave');

  const hits = await win.webContents.executeJavaScript(`(() => {
    const at = (y) => { const e = document.elementFromPoint(80, y); return e ? (e.id || e.tagName) : null; };
    return { y20: at(20), y60: at(60), y100: at(100) };
  })()`);

  log('');
  log('--- hit test ---');
  log('elementFromPoint y=20  => ' + hits.y20);
  log('elementFromPoint y=60  => ' + hits.y60);
  log('elementFromPoint y=100 => ' + hits.y100);

  log('');
  log('--- verdict rules ---');
  log('BOTH off:pointerenter and off:pointerleave present => v-tip WORKS on disabled');
  log('only enter, no leave => v-tip would stick forever (unusable)');
  log('no off:* at all => v-tip dead on disabled (must keep native title)');
  log('offPN should show NO events => proves the probe can detect pointer-events:none');

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, lines.join('\n') + '\n', 'utf8');
  app.exit(0);
});
