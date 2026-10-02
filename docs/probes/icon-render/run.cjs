/**
 * 把 build/icon.svg 光栅化成多尺寸 PNG，再打包成 Windows .ico。
 *
 *   bash docs/probes/icon-render/run.sh
 *   （等价于 `env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe docs/probes/icon-render/run.cjs`）
 *
 * 为什么用无头 Electron 而不是装 sharp / resvg：
 *   仓库里已经有同一条先例（docs/probes/header-width/run.cjs 用真 Chromium 截图），
 *   而这个环境里**没有任何 SVG 光栅化器**（sharp / resvg / cairosvg / Pillow / ImageMagick 全无）。
 *   与其为一次性的图标引入一个原生依赖，不如复用已经装好的 Chromium。
 *   本机 Electron 的 Chromium 渲染 = 我在预览里给你看的那套 AA，所见即所得。
 *
 * 三个环境坑照抄 docs/probes/header-width/run.cjs（那里注释写全了）：
 *   1. 本机 shell 注入了 ELECTRON_RUN_AS_NODE=1 —— 必须 `env -u` 真删掉，设空串没用。
 *   2. 换独立 userData + 禁 GPU —— dev 实例占着默认 userData 的 GPUPersistentCache。
 *   3. show:false 的窗口在 Windows 上不参与合成 ⇒ offscreen + 关后台节流。
 *
 * 额外的两条（图标特有，不是截图特有的）：
 *   4. **`force-device-scale-factor=1`**。本机主屏是 1.25 缩放（见 docs/probes/win-size/），
 *      不锁 1 的话 capturePage 收回来的是 1.25 倍的图 —— 「32px 图标」会变成 40px。
 *   5. **4 倍超采样再缩回来**。直接在 16px 上渲染，放大镜环的描边只有 1.2px，
 *      Chromium 给的小尺寸 AA 比较糊；在 64px 上渲染再 Lanczos 缩到 16px 明显更干净。
 *
 * 产出：
 *   build/icon.png            1024×1024（Linux / mac 兜底，也是 electron-builder 的转换源）
 *   build/icon.ico            16/24/32/48/64/128/256 七档内嵌 PNG 的 Windows 图标
 *   public/favicon.ico        同 icon.ico —— 窗口左上角那个小图标用它
 *                              （electron/main/index.ts:57 与 index.html:5 都指向它）
 *   docs/probes/icon-render/png/icon-<size>.png      每档单独存一份，便于目视/复算
 *   docs/probes/icon-render/preview.png              深浅两种底色下的真实尺寸对照（视觉证据）
 *
 * ⚠️ 透明底是**硬要求**：圆角方块的四角必须是 alpha=0。
 *    所以下面会从 `toBitmap()` 直接读 BGRA 的 alpha 字节来验，不信"看起来像"。
 */
const { app, BrowserWindow, nativeImage } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '../../..');
const SVG = path.join(ROOT, 'build/icon.svg');
// .ico 里放哪些档。Windows 自己按 DPI 挑：任务栏 16/24/32、资源管理器 48/64、大图标 128/256。
const SIZES = [16, 24, 32, 48, 64, 128, 256];
const SUPERSAMPLE = 4;
const CANVAS = 1024; // 超采样后的最大边长（256 × 4）

app.setPath('userData', path.join(os.tmpdir(), 'probe-icon-render'));
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.disableHardwareAcceleration();

/** 把 PNG 条目拼成 ICO 容器（Vista+ 支持内嵌 PNG，比 BMP 条目省事且不损失画质）。 */
function buildIco(entries) {
    const n = entries.length;
    const header = Buffer.alloc(6);
    header.writeUInt16LE(0, 0); // reserved，必须 0
    header.writeUInt16LE(1, 2); // type，1 = icon
    header.writeUInt16LE(n, 4);

    const dir = Buffer.alloc(16 * n);
    let offset = 6 + 16 * n;
    entries.forEach((e, i) => {
        const o = i * 16;
        // 256 在这里要写成 0（字段只有 1 字节，0 是 256 的约定写法）
        const wh = e.size >= 256 ? 0 : e.size;
        dir.writeUInt8(wh, o + 0);
        dir.writeUInt8(wh, o + 1);
        dir.writeUInt8(0, o + 2); // 调色板数，真彩填 0
        dir.writeUInt8(0, o + 3); // reserved
        dir.writeUInt16LE(1, o + 4); // 色彩平面
        dir.writeUInt16LE(32, o + 6); // 位深
        dir.writeUInt32LE(e.png.length, o + 8);
        dir.writeUInt32LE(offset, o + 12);
        offset += e.png.length;
    });
    return Buffer.concat([header, dir, ...entries.map((e) => e.png)]);
}

/** 读 BGRA 里的 alpha：四角（应为 0）+ 中心（应为 255）。 */
function alphaProbe(img) {
    const size = img.getSize();
    const bmp = img.toBitmap(); // BGRA
    const at = (x, y) => bmp[(y * size.width + x) * 4 + 3];
    const half = Math.floor(size.width / 2);
    return {
        左上: at(0, 0),
        右上: at(size.width - 1, 0),
        左下: at(0, size.height - 1),
        右下: at(size.width - 1, size.height - 1),
        中心: at(half, half),
    };
}

app.whenReady().then(async () => {
    const svg = fs.readFileSync(SVG, 'utf8');
    const outDir = path.join(__dirname, 'png');
    fs.mkdirSync(outDir, { recursive: true });

    const win = new BrowserWindow({
        show: false,
        width: CANVAS,
        height: CANVAS,
        useContentSize: true,
        frame: false,
        transparent: true,
        webPreferences: { offscreen: true, backgroundThrottling: false, contextIsolation: false },
    });
    win.webContents.on('console-message', (_e, _lvl, msg) => console.log('[page]', msg));

    // 画布固定 CANVAS×CANVAS，靠 __setSize 改内层尺寸 —— 只开一个窗口，七档共用。
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>
        html,body{margin:0;padding:0;background:transparent;overflow:hidden;}
        #box{position:absolute;left:0;top:0;}
        #box svg{display:block;width:100%;height:100%;}
    </style></head><body><div id="box">${svg}</div>
    <script>
      window.__setSize = (n) => { const b = document.getElementById('box');
        b.style.width = n + 'px'; b.style.height = n + 'px'; };
      window.__setSize(${CANVAS});
    </script></body></html>`;

    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    await new Promise((r) => setTimeout(r, 400));

    const entries = [];
    const rows = [];
    let masterPng = null; // 256 那档的超采样帧就是原生 1024×1024，直接当母版，不必再渲染一遍
    for (const size of SIZES) {
        const px = size * SUPERSAMPLE;
        await win.webContents.executeJavaScript(`window.__setSize(${px})`);
        await new Promise((r) => setTimeout(r, 120));

        const shot = await win.webContents.capturePage({ x: 0, y: 0, width: px, height: px });
        const a = alphaProbe(shot);
        // 超采样收回来再按目标尺寸缩（'best' = Lanczos）
        const final = shot.getSize().width === size
            ? shot
            : shot.resize({ width: size, height: size, quality: 'best' });
        const png = final.toPNG();
        if (px === CANVAS) masterPng = shot.toPNG();
        fs.writeFileSync(path.join(outDir, `icon-${size}.png`), png);
        entries.push({ size, png });
        rows.push({
            尺寸: size, 超采样: `${px}×${px}`, 截图: `${shot.getSize().width}×${shot.getSize().height}`,
            产出: `${final.getSize().width}×${final.getSize().height}`, 字节: png.length,
            角alpha: a.左上, 中心alpha: a.中心,
        });
    }
    console.log('\n── 各档渲染结果（超采样 4× 后缩回）──');
    console.table(rows);
    // ⚠️ 这里**不能** win.destroy()：本脚本没注册 window-all-closed，
    // 关掉唯一的窗口会让 Electron 直接开始退出流程，后面 loadFile 预览页就报 ERR_FAILED。
    // （2026-10-02 亲历：第一版就是在这行 destroy 之后挂掉的。）

    // ── 校验：尺寸必须精确、四角必须透明 ────────────────────────────────
    const badSize = rows.filter((r) => r.产出 !== `${r.尺寸}×${r.尺寸}`);
    const badAlpha = rows.filter((r) => r.角alpha !== 0 || r.中心alpha !== 255);
    console.log(`尺寸精确：${badSize.length === 0 ? '✅ 七档全部命中目标边长' : `❌ ${badSize.map((r) => r.尺寸).join('/')} 尺寸不对`}`);
    console.log(`透明底：${badAlpha.length === 0 ? '✅ 四角 alpha=0、中心 alpha=255（真透明，不是被拍成黑/白底）'
        : `❌ 有 ${badAlpha.length} 档 alpha 不对 —— 说明 capturePage 把透明底拍平了，需换方案`}`);

    // ── 落盘 ────────────────────────────────────────────────────────────
    const ico = buildIco(entries);
    fs.writeFileSync(path.join(ROOT, 'build/icon.ico'), ico);
    fs.writeFileSync(path.join(ROOT, 'build/icon.png'), masterPng);
    fs.writeFileSync(path.join(ROOT, 'public/favicon.ico'), ico);

    console.log(`\nbuild/icon.ico      ${ico.length} 字节 · ${SIZES.join('/')} 七档`);
    console.log(`build/icon.png      ${masterPng.length} 字节 · 1024×1024（取自 256 档的 4× 超采样帧）`);
    console.log(`public/favicon.ico  ${ico.length} 字节（窗口左上角图标）`);

    // ── 视觉证据：深浅两种底下的真实尺寸对照 ────────────────────────────
    // 数字对不代表"16px 还认得出来" —— 那只能看。index.html 是按 1:1 像素排的，
    // 直接 loadFile 再截，得到的就是资源管理器/任务栏里的实际观感。
    // ⚠️ 必须 loadFile，不能 loadURL(data:) —— 预览页里的 <img> 用的是相对路径。
    await win.loadFile(path.join(__dirname, 'index.html'));
    await new Promise((r) => setTimeout(r, 500));
    const prev = (await win.webContents.capturePage({ x: 0, y: 0, width: 760, height: 656 })).toPNG();
    fs.writeFileSync(path.join(__dirname, 'preview.png'), prev);
    console.log(`docs/probes/icon-render/preview.png  ${prev.length} 字节 · 深浅两底 · 真实尺寸 256→16`);

    console.log(badAlpha.length === 0 && badSize.length === 0 ? '\n✅ 图标生成完成' : '\n❌ 有校验未通过，见上');
    win.destroy();
    app.quit();
}).catch((e) => {
    console.error('ICON RENDER FAILED:', e && e.message ? e.message : e);
    app.exit(1);
});
