/**
 * 把 ScanGlow 的绘制公式离线渲染成一张 8 格帧图（`frames.png`），用来看清"光/遮罩往哪走"。
 *
 * 用途：动效方向这种事**不能靠读代码判断**（相位、坐标都在公式里，很容易读反）。
 * 这里把 `baseAt / rise / sweep / veilRise` 按 `ScanGlow.vue` 的原样抄一遍，
 * 逐帧画出来直接看图。改了公式就要同步这里，否则这份帧图会撒谎。
 *
 * 跑法：`env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe docs/probes/scan-glow/render.cjs`
 */

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
app.disableHardwareAcceleration();

const W = 360;
const H = 240;
/** 覆盖三个关键时刻：光从下面冒出来 / 停在底部 / 收尾扫走直至消失 */
const PANELS = [0.05, 0.14, 0.2, 0.5, 0.76, 0.84, 0.9, 0.96];

const html = `<!DOCTYPE html><html><body style="margin:0;background:#0b0b0b">
<canvas id="c" width="${W * 4}" height="${H * 2}"></canvas>
<script>
const W = ${W}, H = ${H}, PANELS = ${JSON.stringify(PANELS)};
const clamp = (n, a = 0, b = 1) => Math.max(a, Math.min(b, n));
const smooth = (a, b, v) => { const x = clamp((v - a) / (b - a)); return x * x * (3 - 2 * x); };
const hash = (n) => { const q = Math.sin(n * 127.1 + 311.7) * 43758.5453; return q - Math.floor(q); };
const PALETTE = ['#34d399', '#3b82f6', '#a855f7'];
const MOTES = Array.from({ length: 140 }, (_, i) => ({
  x: hash(i + 2), phase: hash(i + 20), speed: 0.16 + hash(i + 600) * 0.13,
  size: 0.25 + Math.pow(hash(i + 100), 3) * 1.5, light: 0.35 + hash(i + 80) * 0.6,
  twinkle: 2 + hash(i + 700) * 4,
}));

/** ⚠️ 必须与 ScanGlow.vue 的 baseAt 逐字一致，否则这份帧图会撒谎 */
function baseAt(p) {
  const rise = smooth(0.085, 0.2, p);
  const sweep = smooth(0.79, 0.92, p);
  return 1.19 - 0.2 * rise - 1.29 * sweep;
}

/** t = 摆动时钟（秒），与位置参数 p 解耦 —— 组件里也是分开传的 */
function drawLight(ctx, w, h, p, t) {
  const base = baseAt(p);
  const breath = 1 + 0.2 * Math.sin(t * 2.2 - 0.6);

  const wash = (x, y, rx, ry, color, alpha) => {
    ctx.save();
    ctx.translate(x * w, y * h);
    ctx.scale(rx * w, ry * h * breath);
    ctx.globalAlpha = alpha;
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 1.6);
    g.addColorStop(0, color); g.addColorStop(0.45, color); g.addColorStop(1, 'transparent');
    ctx.fillStyle = g;
    ctx.fillRect(-1.6, -1.6, 3.2, 3.2);
    ctx.restore();
  };

  const [g1, g2, g3] = PALETTE;
  wash(0.42 + 0.04 * Math.sin(t * 0.8), base + 0.025, 0.72, 0.16, g1, 0.34);
  wash(0.34 + 0.06 * Math.sin(t * 1.1), base - 0.035, 0.39, 0.21, g2, 0.26);
  wash(0.13 + 0.035 * Math.cos(t * 1.5), base + 0.07, 0.29, 0.14, g3, 0.3);
  wash(0.84 + 0.035 * Math.sin(t * 1.1), base - 0.1, 0.38, 0.23, g3, 0.22);
  wash(0.88 + 0.035 * Math.sin(t * 1.2), base + 0.025, 0.2, 0.075, g2, 0.34);
  wash(0.51 + 0.055 * Math.sin(t * 0.95), base + 0.09, 0.35, 0.16, g1, 0.3);

  for (let i = 0; i < 12; i++) {
    const life = (t * (0.17 + hash(i + 70) * 0.1) + hash(i + 30)) % 1;
    const x = hash(i + 12) + Math.sin(life * 4 + i) * 0.07;
    const y = base + 0.16 - life * 0.36;
    wash(x, y, 0.1 + hash(i + 22) * 0.11, 0.065 + hash(i + 52) * 0.07, PALETTE[i % 3], Math.sin(life * Math.PI) * 0.16);
  }

  const dust = smooth(0.12, 0.3, p) * (1 - smooth(0.9, 0.96, p));
  ctx.fillStyle = 'white';
  for (const m of MOTES) {
    const life = (t * m.speed + m.phase) % 1;
    const x = (m.x + Math.sin(t * 0.9 + m.phase * 40) * 0.012) * w;
    const y = (base + 0.22 - life * 0.34) * h;
    const alpha = Math.sin(life * Math.PI) * m.light * (0.72 + 0.28 * Math.sin(t * m.twinkle)) * dust;
    if (alpha <= 0.004) continue;
    ctx.globalAlpha = alpha;
    ctx.beginPath(); ctx.arc(x, y, (m.size * Math.min(w, h)) / 530, 0, Math.PI * 2); ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function panel(ctx, ox, oy, p, t) {
  ctx.save();
  ctx.beginPath(); ctx.rect(ox, oy, W, H); ctx.clip();

  // 假内容：几行"封面"方块，用来看清遮罩与光相对内容的位置
  ctx.fillStyle = '#1f1f1f'; ctx.fillRect(ox, oy, W, H);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) {
    ctx.fillStyle = '#3a3f47';
    ctx.fillRect(ox + 8 + c * 88, oy + 8 + r * 76, 78, 48);
  }

  // 遮罩：**纯透明度、无 transform**（与 ScanGlow.vue 一致）。
  // 组件里它由"进场/退场包络"驱动、不看 p，所以这里固定取进场满值 0.62。
  const veilOpacity = 0.62;
  ctx.save();
  ctx.beginPath(); ctx.rect(ox, oy, W, H); ctx.clip();
  ctx.globalAlpha = veilOpacity;
  ctx.fillStyle = '#0e0e0e';
  ctx.fillRect(ox, oy, W, H);
  ctx.restore();

  // 光
  ctx.save();
  ctx.translate(ox, oy);
  drawLight(ctx, W, H, p, t);
  ctx.restore();

  ctx.globalAlpha = 1;
  ctx.fillStyle = '#000'; ctx.fillRect(ox, oy, W, 18);
  ctx.fillStyle = '#8f8f8f'; ctx.font = '12px sans-serif';
  ctx.fillText('p=' + p.toFixed(2) + '  base=' + baseAt(p).toFixed(2), ox + 6, oy + 13);
  ctx.restore();
}

const c = document.getElementById('c').getContext('2d');
// t 取不同值：证明摆动时钟与 p 无关
PANELS.forEach((p, i) => panel(c, (i % 4) * W, Math.floor(i / 4) * H, p, 1.2 + i * 0.55));
window.__png = document.getElementById('c').toDataURL('image/png');
</script></body></html>`;

app.whenReady().then(async () => {
    const win = new BrowserWindow({ width: 1440, height: 480, show: false, webPreferences: { offscreen: true } });
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    await new Promise((r) => setTimeout(r, 600));
    const dataUrl = await win.webContents.executeJavaScript('window.__png', true);
    const out = path.join(process.cwd(), 'docs', 'probes', 'scan-glow', 'frames.png');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, Buffer.from(String(dataUrl).split(',')[1], 'base64'));
    console.log('saved', out);
    app.exit(0);
});
