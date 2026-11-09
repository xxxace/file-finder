/**
 * galaxy 轨道像素层 —— **逐格照抄** LeiBox `motion-core/galaxy-effort-slider.js` 的 `drawPixels()`
 * 与 `drawSparks()`。大脑图标由「三层同心柔光 + 放射粒子」替代（2026-11-08 主人裁决）。
 *
 * 为什么必须 Canvas，不能 CSS：参考每一格点有**各自的**相位（`hash(n)` 定 seed）、
 * 各自的颜色（6 色里按 hash 取）、还有「左疏右密」的密度梯度（`density`）。
 * CSS 的 `repeating-gradient` 只能整层一起变 ⇒ 出来是一块规整织物，不是星云
 * （2026-11-08 第一版就这么翻的车，主人原话「根本就不像」）。
 *
 * 与原版的差异只有两处，其余常数一个都没改：
 *   ① 几何按 `--ff-bar-h` 换算（原版固定 49 列 × 5 排 × 8px 格，轨道 40px 高）；
 *   ② 大脑换成 `#d9ccff → #8351ff → #7543fc` 三层径向柔光，中心偏白 ——
 *      原版那团光是大脑的 `drop-shadow`，中心被图标自己顶亮，没有图标就必须自己做出亮心，
 *      否则是一坨"死紫"（主人原话）。
 */

export type GalaxyBarOptions = {
    /** 已填充宽度（CSS px）—— 由 naive 的 `max-width` 动画决定 */
    width: number;
    /** 条高（CSS px） */
    height: number;
    /** 单调递增秒数（每次加载从 0 起 ⇒ 开头的爆发出得来） */
    time: number;
    /** 整体不透明度（naive 收尾那 0.8s 淡出） */
    alpha: number;
    /** 六色点阵（按 hash 取） */
    colors: readonly string[];
    /** 光晕：亮心 / 中圈 / 外圈 */
    glowCore: string;
    glowMid: string;
    glowSoft: string;
    /** 画布比条多出来的下沿，用来让光晕溢出到条外 */
    pad: number;
    /**
     * 底色渐变色标（`--ff-bar-base-stops`），位置 0~1。
     * ⚠️ 为什么是**多段**而不是两色标：Canvas 的线性渐变按 sRGB 插值，浅→浓之间大半段
     *    停在灰白，看着就是"太浅、不均匀"。色标由 tokens.css 在 OKLab 里等速算好，
     *    这里只负责逐个喂给 `addColorStop` —— 色值与感知曲线都不在代码里另算一份。
     */
    stops: readonly { pos: number; color: string }[];
};

/**
 * 底色：进度条自己的"实体"那一段。
 *
 * 2026-11-08 为什么搬到这层：顶部那条 `n-loading-bar` 只是被 `visibility: hidden` 藏起来了，
 * 它的 `colorLoading`（`--ff-bar-base-stops` 拼出的紫渐变）也就**跟着不可见** —— 地址槽里只剩星点，
 * 看着像"渐变被取消了"。星点是"质感"，这一层才是"进度到哪了"这个事实。
 *
 * ⚠️ 渐变的坐标系是 **0 → 当前进度宽度**（不是整个盒子）：与 naive 的做法一致
 * （给 bar 元素本身设 `background`，元素变宽 ⇒ 渐变被拉伸）⇒ 换到盒子里也不能变味。
 */
function drawBase(ctx: CanvasRenderingContext2D, o: GalaxyBarOptions): void {
    const { width, height, alpha, stops } = o;
    // 结构探针 `pattern.mjs` 不传底色（它只验图案），这里必须能安静地跳过而不是崩
    if (width <= 0 || !stops || stops.length < 2) return;
    const gradient = ctx.createLinearGradient(0, 0, width, 0);
    for (const s of stops) gradient.addColorStop(clamp(s.pos, 0, 1), s.color);
    ctx.globalAlpha = clamp(alpha, 0, 1);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);
}

/** 参考里那个确定性 hash：同一个 n 永远同值 ⇒ "随机感"是稳定的，不会每帧乱跳 */
function hash(n: number): number {
    const value = Math.sin(n * 127.1 + 311.7) * 43758.5453;
    return value - Math.floor(value);
}

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

/** 轨道像素：逐格照抄 `drawPixels()`，只把 49×5×8px 换成按高度换算的 N×M×格宽 */
function drawPixels(ctx: CanvasRenderingContext2D, o: GalaxyBarOptions): void {
    const { width, height, time, alpha, colors } = o;
    if (width <= 0 || !colors.length) return;

    // 原版：5 排 / 40px。保持「每 8px 一排」⇒ 14px 高给 2 排、格 7px
    const rows = Math.max(1, Math.round(height / 8));
    const cell = height / rows;
    const cols = Math.max(1, Math.ceil(width / cell));
    const span = Math.max(1, cols - 1);
    const unit = cell * 0.64; // 原版 5.1 / 8

    for (let row = 0; row < rows; row += 1) {
        for (let col = 0; col < cols; col += 1) {
            const n = row * cols + col;
            const seed = hash(n + 7);
            const wave = 0.5 + 0.5 * Math.sin(time * (2 + seed * 3) + n * 1.618);
            // 左疏右密：这条曲线是"像不像 galaxy"的关键，不是装饰
            const density = 0.14 + 0.78 * Math.pow(col / span, 1.6);
            if (seed > density + 0.16 * Math.sin(time * 1.8 + col * 0.2)) continue;

            const a = alpha * (0.18 + 0.72 * wave) * (0.22 + 0.78 * (col / span));
            if (a < 0.012) continue;

            const size = unit * (seed > 0.74 ? 1.12 : 1);
            ctx.globalAlpha = a > 1 ? 1 : a;
            ctx.fillStyle = colors[Math.floor(hash(n + 211) * colors.length)] ?? colors[0];
            ctx.beginPath();
            // 原版 x 偏移 +1、y +.5 是不对称的；这里改成居中，小尺寸下居中对齐才不会抖
            ctx.roundRect(
                col * cell + (cell - size) / 2,
                row * cell + (cell - size) / 2,
                size, size, cell * 0.16,
            );
            ctx.fill();
        }
    }
}

/**
 * 前缘光晕：替代大脑图标（原版是它的两层 `drop-shadow(#8351ff / #7543fc70)`）。
 *
 * ⚠️ **必须三层、且最内层要偏白**。原版那团光的中心是被大脑图标自己顶亮的，
 * 图标去掉后只画一圈 `#8351ff` 会变成一坨死紫 —— 主人 2026-11-08 指的就是这个。
 * 三层各自"中心实色 → 边缘透明"，叠加后才有由亮到淡的扩散感。
 *
 * ⚠️⚠️ **淡出端点必须是「同色透明」，不能是关键字 `transparent`**：
 *   `transparent` 等于 `rgba(0,0,0,0)`，渐变插值会把 RGB 一起拉向黑 ⇒ 前缘出现一圈
 *   灰紫暗盘（浅色实测 (151,131,180)，复算 (151,129,183)）。光只能**变淡**不能**变脏**。
 */
/**
 * 把颜色换成「同色、alpha=0」。**只改 alpha，不动 RGB** —— 这是整个光晕的根。
 * 走 CSS Color 4 的 8 位 hex（末尾 `00`），不拼 rgba 字符串、也不引入任何新色值。
 * 认不出来的格式原样返回（token 全是我们自己定义的 hex，不会走到这条）。
 */
function fadeOf(color: string): string {
    const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
    if (!hex) return color;
    let h = hex[1];
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    return `#${h}00`;
}

function drawGlow(ctx: CanvasRenderingContext2D, o: GalaxyBarOptions): void {
    const { width, height, alpha, glowCore, glowMid, glowSoft, pad } = o;
    if (!glowMid) return;
    const cx = width;
    const cy = height / 2;
    const h = height + pad;

    const pass = (radius: number, color: string, strength: number) => {
        if (!color || radius <= 0) return;
        const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
        gradient.addColorStop(0, color);
        gradient.addColorStop(1, fadeOf(color));
        ctx.globalAlpha = clamp(alpha * strength, 0, 1);
        ctx.fillStyle = gradient;
        ctx.fillRect(cx - radius, 0, radius * 2, h);
    };

    pass(height * 2.6, glowSoft, 0.34); // 外圈：扩散
    pass(height * 1.5, glowMid, 0.58); // 中圈：glowMid
    pass(height * 0.75, glowCore, 0.92); // 亮心：偏白，没有它就"死紫"
}

/**
 * 放射粒子：逐条照抄 `drawSparks()`（26 条射线 × 7 点，黄金角分布，六色轮转）。
 * 原版它从大脑射出；大脑去掉后发射源就是前缘那个光心。
 */
function drawSparks(ctx: CanvasRenderingContext2D, o: GalaxyBarOptions): void {
    const { width, height, time, alpha, colors } = o;
    if (!colors.length) return;
    const cx = width;
    const cy = height / 2;
    // 原版以 40px 高的轨道为基准，这里整体等比缩到当前条高
    const k = height / 40;
    const minR = 27 * k;
    const fadeSpan = 110 * k;
    const burst = Math.exp(-time * 6); // 每次加载开头的一次爆发，和原版进入 Galaxy 时一致

    for (let ray = 0; ray < 26; ray += 1) {
        const angle = ray * 2.399963;
        const seed = hash(ray + 94);
        const speed = 15 + seed * 24;
        for (let dot = 0; dot < 7; dot += 1) {
            const radius = minR + ((dot * 13 + time * speed + seed * 40) % 87) * k + burst * dot * 3 * k;
            const fade = Math.pow(1 - clamp((radius - minR) / fadeSpan, 0, 1), 1.6);
            const pulse = 0.45 + 0.55 * Math.pow(Math.sin(time * 4 + ray + dot), 2);
            const a = alpha * fade * pulse * (0.4 + burst * 0.35);
            if (a < 0.012) continue;
            ctx.globalAlpha = a > 1 ? 1 : a;
            ctx.fillStyle = colors[(ray + dot) % colors.length] ?? colors[0];
            const size = seed > 0.65 ? 2.5 : 2;
            ctx.fillRect(cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius, size, size);
        }
    }
}

export function drawGalaxyBar(ctx: CanvasRenderingContext2D, o: GalaxyBarOptions): void {
    drawBase(ctx, o);
    drawPixels(ctx, o);
    drawGlow(ctx, o);
    drawSparks(ctx, o);
    ctx.globalAlpha = 1;
}
