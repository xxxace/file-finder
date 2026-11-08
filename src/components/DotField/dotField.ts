/**
 * 加载场 —— 「斜向光晕扫过 + 细像素点闪烁」。
 *
 * 2026-11-08 第二次重做。第一版是照抄 LeiBox `ai-generating` 的点阵：
 * 节距按 `min(w,h)/6.5` 算，在 179×119 的封面位里就是 **26px 节距 / 5.5px 直径**，
 * 整张卡只有 7×5 个大灰点 —— 主人原话"看起来很难受"。放在 48px 头像位里还行，
 * 铺到卡片上就变成十年前那种 loading 占位块。
 *
 * 这一版把"颗粒"做细、把"亮度"交给一道扫过去的光：
 *   ① **像素点**：节距 `min(w,h)/9`（封顶 16），方点、直径 `节距×0.16` —— 细到像屏幕像素；
 *   ② **渐变光晕**：一条斜向（-20°）线性渐变带，2.6s 扫一轮，宽 = 投影跨度的 34%；
 *   ③ **近光点发光**：点离光带越近越亮越大（`(1-d/半宽)²`），每个点还有自己的闪烁相位，
 *      所以"亮起来的是随机的一小片"，不是一条硬边。
 *
 * 三条纪律照旧（比公式重要）：
 *   · 模块级**一个** rAF 驱动所有场；场停立刻出队 ⇒ 空闲零帧；
 *   · 颜色只取 `white` / `black` 由 `isDark()` 决定，**不引入第二个彩色**；
 *   · `prefers-reduced-motion` ⇒ 只画一帧静态图，不起 rAF。
 */

interface Dot {
    x: number;
    y: number;
    /** 在光带扫过方向上的归一化坐标（0~1），布局时算好，每帧只用减法 */
    u: number;
    /** 每点自己的闪烁相位 / 速度 —— 让"亮"是散开的，不是一条硬边 */
    seed: number;
    speed: number;
}

interface Field {
    canvas: HTMLCanvasElement;
    ctx: CanvasRenderingContext2D;
    dots: Dot[];
    w: number;
    h: number;
    /** 方点边长 */
    px: number;
    /** 光带方向上的投影跨度（= 用来把 u 归一化到 0~1） */
    span: number;
    /** 每场随机相位：多张卡同时跑时不同步，才像"很多事在并行" */
    phase: number;
}

/** 光带角度：略斜，横向扫过。0 会像进度条，90 会像雨刷 */
const ANGLE = -0.5;
/** 扫过一轮的时长 */
const CYCLE_MS = 2600;
/** 光带半宽（占投影跨度的比例） */
const BAND = 0.22;

const LIVE = new Set<Field>();
let pumping = 0;

const prefersReduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const isDark = () => document.documentElement.dataset.theme !== 'light';
/** 确定性伪随机：同一帧重绘不抖，不同点又各不相同 */
const hash = (n: number) => {
    const q = Math.sin(n * 127.1 + 311.7) * 43758.5453;
    return q - Math.floor(q);
};

function layout(f: Field): void {
    const dpr = window.devicePixelRatio || 1;
    const w = f.canvas.clientWidth;
    const h = f.canvas.clientHeight;
    if (!w || !h) return;

    f.canvas.width = Math.round(w * dpr);
    f.canvas.height = Math.round(h * dpr);
    f.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    f.w = w;
    f.h = h;

    // 节距按短边算并封顶：太大的卡不放大颗粒（那正是第一版"难受"的原因）
    const pitch = Math.min(16, Math.max(6, Math.min(w, h) / 9));
    /**
     * 点径有两个下界，缺一不可：
     *   · `pitch × 0.18` —— 大画布上保持"像素点"的纤细感；
     *   · `min(2.2, 短边 × 0.045)` —— 48px 头像位里按第一条算只有 1.08px，
     *     1x 屏上根本不成形（实测截图里那块圆几乎全黑，等于没有动效）。
     * 取两者的**大者**：小画布被第二条托住，大画布被第一条主导。
     */
    f.px = Math.max(pitch * 0.18, Math.min(2.2, Math.min(w, h) * 0.045));

    const nx = Math.cos(ANGLE);
    const ny = Math.sin(ANGLE);
    f.span = Math.abs(w * nx) + Math.abs(h * ny);

    const cols = Math.max(2, Math.floor(w / pitch));
    const rows = Math.max(2, Math.floor(h / pitch));
    const ox = (w - (cols - 1) * pitch) / 2;
    const oy = (h - (rows - 1) * pitch) / 2;

    f.dots = [];
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            const x = ox + c * pitch;
            const y = oy + r * pitch;
            const i = r * cols + c;
            f.dots.push({
                x,
                y,
                u: ((x - w / 2) * nx + (y - h / 2) * ny) / f.span + 0.5,
                seed: hash(i + 1) * Math.PI * 2,
                speed: 1.4 + hash(i + 40) * 2.2,
            });
        }
    }
}

function paint(f: Field, now: number): void {
    if (!f.w || !f.h) return;
    const { ctx, w, h, dots, span } = f;
    const dark = isDark();
    const tone = dark ? 'white' : 'black';
    const t = (now + f.phase) * 0.001;

    ctx.clearRect(0, 0, w, h);

    // 光带中心：-0.12 → 1.12。空档只留 12% —— 再长就会出现"整块卡没人管"的一段时间，看着像卡死
    const bc = -0.12 + (((now + f.phase) % CYCLE_MS) / CYCLE_MS) * 1.24;

    // ① 光晕：与点阵共用同一条法线方向的线性渐变
    ctx.save();
    ctx.translate(w / 2, h / 2);
    ctx.rotate(ANGLE);
    const half = span * BAND;
    const center = (bc - 0.5) * span;
    const glow = ctx.createLinearGradient(center - half, 0, center + half, 0);
    glow.addColorStop(0, 'transparent');
    glow.addColorStop(0.5, tone);
    glow.addColorStop(1, 'transparent');
    ctx.globalAlpha = dark ? 0.15 : 0.08;
    ctx.fillStyle = glow;
    ctx.fillRect(-span, -span, span * 2, span * 2);
    ctx.restore();

    // ② 像素点：亮度 = 基础微光 + 光带命中 × 自己的闪烁
    ctx.fillStyle = tone;
    for (const d of dots) {
        const dist = Math.abs(d.u - bc);
        const hit = dist < BAND ? (1 - dist / BAND) ** 1.6 : 0;
        const tw = 0.62 + 0.38 * Math.sin(t * d.speed + d.seed);
        // 远处的点也在轻轻闪（0.13 的底），光带压过来时再亮一大截
        const a = (0.13 + 0.8 * hit) * tw;
        if (a < 0.02) continue;
        const s = f.px * (0.85 + 0.6 * hit);
        ctx.globalAlpha = a;
        ctx.fillRect(d.x - s / 2, d.y - s / 2, s, s);
    }
    ctx.globalAlpha = 1;
}

function frame(now: number): void {
    pumping = 0;
    for (const f of LIVE) paint(f, now);
    if (LIVE.size) pumping = requestAnimationFrame(frame);
}

export interface DotFieldHandle {
    start(): void;
    stop(): void;
    destroy(): void;
}

export function createDotField(canvas: HTMLCanvasElement): DotFieldHandle {
    const field: Field = {
        canvas,
        ctx: canvas.getContext('2d')!,
        dots: [],
        w: 0,
        h: 0,
        px: 1,
        span: 1,
        phase: Math.random() * CYCLE_MS,
    };
    const observer = new ResizeObserver(() => {
        if (!LIVE.has(field)) return;
        layout(field);
    });
    observer.observe(canvas);

    return {
        start() {
            if (LIVE.has(field)) return;
            layout(field);
            if (prefersReduced()) {
                paint(field, 0);
                return;
            }
            LIVE.add(field);
            if (!pumping) pumping = requestAnimationFrame(frame);
        },
        // 停止绘制但**不清画布** —— 让外层的 opacity 过渡把最后一帧淡出去
        stop() {
            LIVE.delete(field);
        },
        destroy() {
            LIVE.delete(field);
            observer.disconnect();
        },
    };
}
