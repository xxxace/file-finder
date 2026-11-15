/**
 * 撕口几何 —— 移植自 `holo-reverse/src/app.js` 的 `path / place / steer / yAt / clips`。
 *
 * ## 为什么值得这么细
 *
 * 一条直线撕口读起来是"剪刀剪的"，锯齿是"手撕的"。而"手撕"的真实感来自四层叠加，
 * 缺一层就退化：
 *   ① 撕口**本身**是一条 96 段的曲线：整体斜率 + 弓形 + 正弦摆动 + 随机游走 + 偶发跳变；
 *   ② 未撕的部分**跟着手弯**（往下拉就下潜，往上提就爬升），已撕的部分保持原样；
 *   ③ 每个点露出的**金属边宽度**不同（铝箔撕开处那道银边，忽宽忽窄）；
 *   ④ 撕条被切成 12 片，越靠末端弯曲越大 —— 松散的那头会朝你卷过来。
 *
 * 全部是纯函数（零 DOM），所以 `docs/probes/lucky-draw/` 能直接断言。
 */

/** 撕口中心线在包装高度的百分比位置 */
export const TEAR_Y = 10.5;
/** 撕口由 96 段组成 */
export const SEGMENTS = 96;
/** 撕条切 12 片（触屏 8 片就够） */
export const PLIES = 12;
/** 未撕部分被手拖动时，撕口高度的上下限（%）—— 再高会把封边撕穿 */
export const Y_MIN = 8;
export const Y_MAX = 19.5;

/**
 * 撕口上的一个点。
 *
 * `base` 是它"本来"的高度；`y` 是**加上手的弯曲之后**的实际高度。
 * 分开存是因为 `steer()` 每次都要从 `base` 重算，否则连续的拖动会累加漂移。
 */
export interface JagPoint {
    /** 0~100（包装宽度百分比） */
    x: number;
    /** 这条撕口自己的高度（不含弯曲、不含锯齿） */
    base: number;
    /** 实际高度 = clamp(base + bend) + tooth */
    y: number;
    /** 细锯齿（±0.42，偶尔 ±1.2 的崩口） */
    tooth: number;
    /** 这一点露出的金属边宽度（0.35~1.1，偶尔 1.2~2.1 的亮点） */
    metal: number;
    /** 手的弯曲量（%），由 `steer` 写入 */
    bend: number;
}

export type Pt = [number, number];

/**
 * 生成一条**这次专属**的撕口。
 *
 * 参考站每次撕都会重新生成（`path()`），所以每包撕出来都不一样 —— 这是"再看一遍"
 * 也不腻的原因之一。
 */
export function createJag(rnd: () => number = Math.random): JagPoint[] {
    const rand = (a: number, b: number) => a + rnd() * (b - a);
    const slope = rand(-7.5, 7.5);
    const bow = rand(-3, 3);
    const freq = rand(1.5, 3.5);
    const phase = rand(0, 6.28);
    const wobble = rand(0.3, 1.1);
    const y0 = rand(10.5, 14);
    let walk = 0;

    return Array.from({ length: SEGMENTS + 1 }, (_, i) => {
        const x = (i / SEGMENTS) * 100;
        const s = x / 50 - 1;
        // 游走并在 5% 的概率上"卡住然后跳一下"（真实的膜会突然崩一下）
        walk = clamp(walk + rand(-0.25, 0.25) + (rnd() < 0.05 ? rand(-1.5, 1.5) : 0), -2.2, 2.2);
        const jx = i > 0 && i < SEGMENTS ? x + rand(-0.3, 0.3) : x;
        const p: JagPoint = {
            x: jx,
            base: y0 + slope * s + bow * (1 - s * s) + wobble * Math.sin(s * freq * Math.PI + phase) + walk,
            y: 0,
            tooth: rand(-0.42, 0.42) + (rnd() < 0.14 ? rand(-1.2, 1.2) : 0),
            metal: rnd() < 0.12 ? rand(1.2, 2.1) : rand(0.35, 1.1),
            bend: 0,
        };
        applyBend(p, 0);
        return p;
    });
}

/** 把"基准高度 + 弯曲"钳到合法区间，再加细锯齿 */
export function applyBend(p: JagPoint, bend: number): void {
    p.bend = bend;
    p.y = clamp(p.base + bend, Y_MIN, Y_MAX) + p.tooth;
}

/**
 * 未撕的那一段跟着手弯。
 *
 * @param fromX 手所在的位置（包装宽度百分比）；从它往 `dir` 方向逐点加弯曲
 * @param dir   撕裂方向：`1` = 从左往右撕
 * @param k     弯曲量（正 = 往下潜，负 = 往上爬）
 */
export function steer(jag: JagPoint[], fromX: number, dir: 1 | -1, k: number): void {
    const n = jag.length - 1;
    const i0 = clamp(Math.round((dir > 0 ? fromX : 100 - fromX) / 100 * n), 0, n);
    const bend0 = jag[i0].bend;
    for (let i = i0 + dir; i >= 0 && i <= n; i += dir) {
        // 离手越远弯得越多：像把一层膜整片压下去，而不是只压住手指那一点
        applyBend(jag[i], bend0 + (k * Math.abs(i - i0) * 100) / n);
    }
}

/** 在 x 处的撕口高度（线性插值） */
export function yAt(jag: readonly JagPoint[], x: number): number {
    const n = jag.length - 1;
    const f = (clamp(x, 0, 100) / 100) * n;
    const i = Math.min(n - 1, Math.floor(f));
    return jag[i].y + (jag[i + 1].y - jag[i].y) * (f - i);
}

function clamp(v: number, a: number, b: number): number {
    return Math.min(b, Math.max(a, v));
}

export function toPolygon(points: readonly Pt[]): string {
    return `polygon(${points.map(([x, y]) => `${x.toFixed(2)}% ${y.toFixed(2)}%`).join(',')})`;
}

/** 背面被翻转 180°，x 要镜像回去 */
export function mirror(points: readonly Pt[]): Pt[] {
    return points.map(([x, y]) => [100 - x, y]);
}

/**
 * 沿撕口的一条**细带**（金属边）。
 *
 * `sign` 决定往哪一侧偏：正值往 +y，负值往 -y。宽度取每个点自己的 `metal`。
 */
export function bandOf(points: readonly Pt[], sign: number, metal: readonly number[]): Pt[] {
    const back = points.map(([x, y], i) => [x, y + sign * (metal[i] ?? 0.8)] as Pt).reverse();
    return [...points, ...back];
}

/**
 * 撕开 `p`（0~1）之后，剩下这半块包装的轮廓。
 *
 * @returns 按顺时针闭合的多边形点（可以直接喂 `toPolygon`）
 */
export function restOutline(jag: readonly JagPoint[], p: number, dir: 1 | -1): Pt[] {
    const xt = dir > 0 ? p * 100 : 100 - p * 100;
    const yt = yAt(jag, xt);
    const torn: Pt[] = jag.filter(q => (dir > 0 ? q.x < xt : q.x > xt)).map(q => [q.x, q.y]);
    return dir > 0
        ? [[xt, 0], [100, 0], [100, 100], [0, 100], ...torn, [xt, yt]]
        : [[0, 0], [xt, 0], [xt, yt], ...torn, [100, 100], [0, 100]];
}

/**
 * 撕条上第 k 片的轮廓（`[lo, hi]` 是它在 x 上的区间）。
 *
 * 上边是包装顶边，下边是撕口（含中间那些锯齿点），这样每一片都与相邻片严丝合缝。
 */
export function plyOutline(jag: readonly JagPoint[], lo: number, hi: number): Pt[] {
    const span: Pt[] = [
        [lo, yAt(jag, lo)],
        ...jag.filter(q => q.x > lo && q.x < hi).map(q => [q.x, q.y] as Pt),
        [hi, yAt(jag, hi)],
    ];
    return [[lo, 0], [hi, 0], ...span.slice().reverse()];
}

/** 撕条上第 k 片的撕口边（用来画银边） */
export function plyEdge(jag: readonly JagPoint[], lo: number, hi: number): Pt[] {
    return [
        [lo, yAt(jag, lo)],
        ...jag.filter(q => q.x > lo && q.x < hi).map(q => [q.x, q.y] as Pt),
        [hi, yAt(jag, hi)],
    ];
}
