import { rainbow } from './rainbow';
import { Spring } from './spring';

/**
 * 彩虹光流 —— 移植自 `holo-reverse/src/app.js` 的 `sprout / fit / pour`。
 *
 * ## 它到底是什么（这是最容易做错的地方）
 *
 * 不是"一层彩虹渐变"，也不是"一圈放大的光晕"。它是：
 *   · **35 条 ribbon**（相邻两条"边"围成的封闭条带），并排无缝、七色循环；
 *   · 36 条边全部从包装**下方一点**发散，中间的条带笔直向上、外侧的斜着出去；
 *   · 每条边本身是一条**向外传播的行波**：`w = (.4+2k)·sin((d-carry)/22·2π − t·1.4 + phase)`，
 *     越远振幅越大 —— 这是"流"而不是"柱"的全部原因；
 *   · 每条带子出撕口时是**白热**的（往白里混 70%），往外褪回本色；
 *   · 带子里有 **10 个光点**沿着它漂；
 *   · 末端与亮边用一圈径向淡出收尾；
 *   · **撕到哪条带子，哪条才开始喷**；开包后整片扇形冲出屏幕。
 *
 * ## 为什么是 canvas 而不是 SVG（2026-11-15 实测换的）
 *
 * 参考站用 SVG：71 条 `<path>` 每帧重算 `d`，外面再套一层 `feGaussianBlur` 滤镜和一层
 * radial `mask`。几何一模一样，但**每帧要让浏览器重新解析上万个坐标、重建路径、
 * 再跑一遍离屏模糊与蒙版合成**。实测（`docs/probes/lucky-geometry/`）：
 * 撕开阶段 38ms/帧，其中光流占 30ms —— 关掉光流立刻回到 8ms/帧。
 *
 * 换成一张 canvas 之后：同一套几何、只做一次绘制，分辨率由我们自己定
 * （`BACKING` 上限 1.5，光带本来就是糊的，放大一点看不出来），
 * 蒙版那一步用一次 `destination-in` 合成代替。
 * ⚠️ 坐标仍然是**包宽的 1%** 为一单位（和参考站同一套公式），别改成像素。
 */

const NR = 35;          // ribbon 数（边数 = NR + 1）
const CY = 107.5;       // 发散中心（单位：包宽的 1%）
const STEP = 3.0;       // 折线采样步长（单位）
const SPAN = 1500;      // 径向淡出的半径
const TIP = 36;         // 软尾长度
const SEGMENTS_Y_MAX = 19.5;
const TEAR_Y = 10.5;
/** 光流最多探出容器顶边多少（单位）。0 会留下一条硬边，给一点才有"冲出画面"的味道 */
const OVER = 18;
/** canvas 后备像素的上限倍率：光带是糊的，1.25 已经看不出差别，再高纯烧像素 */
const BACKING = 1.25;

interface Line {
    /** 在撕口处的 x（0~100），用来判断"撕到没撕到" */
    ox: number;
    x: number;
    ux: number;
    uy: number;
    ph: number;
    r: number;
}

interface Ribbon {
    mx: number;
    gx: number;
    r: number;
    L: number;
    c: string;
    on: boolean;
    len: number;
    grad: CanvasGradient | null;
    g: { x: number; to: number; v: number; step: (h: number) => void };
}

interface Mote {
    j: number;
    u: number;
    v: number;
    sp: number;
    r: number;
}

export interface FlowState {
    t: number;
    dt: number;
    reduce: boolean;
    /** 撕裂进度 0~1 */
    tearP: number;
    tearDir: 1 | -1;
    /** 正在撕（手还按着、口子还没到底） */
    tearing: boolean;
    /** 已开包（整片要冲出去） */
    opened: boolean;
    openedAt: number;
    /** 包装此刻的倾斜：光流在包落下前跟着它一起转 */
    anchorRz: number;
}

function clamp(v: number, a: number, b: number): number {
    return Math.min(b, Math.max(a, v));
}

function rand(a: number, b: number): number {
    return a + Math.random() * (b - a);
}

/** 往白里混 70% —— 撕口处的"白热" */
function tint(hex: string, k: number): string {
    return '#' + [1, 3, 5]
        .map(i => Math.round(parseInt(hex.slice(i, i + 2), 16) * (1 - k) + 255 * k).toString(16).padStart(2, '0'))
        .join('');
}

export class RainbowFlow {
    private canvas: HTMLCanvasElement;
    private ctx: CanvasRenderingContext2D;
    private lines: Line[] = [];
    private ribbons: Ribbon[] = [];
    private motes: Mote[] = [];
    /** 光点贴图（一次画好，之后缩放着贴 —— 别每帧为 10 个光点建径向渐变） */
    private moteSprite: HTMLCanvasElement | null = null;
    /**
     * 光流自己的"出现/消失"。
     *
     * ⚠️ 必须用 `Spring(0, .5)`（阻尼 = 4π/response）—— 曾经手写成 `c = 0`，
     *    那是个**无阻尼振子**：整段撕裂期间不透明度在 0 与 2 之间来回振荡，
     *    真机表现就是"彩虹一闪一闪"。源码同一行是 `new Spring(0, .5)`。
     */
    private glow = new Spring(0, 0.5);
    private reach = 0;
    private drained = false;
    private Y0 = 62.5;
    private R0 = 45;
    private pw = 300;
    private ph = 300;
    /**
     * 从**包心**到容器四边的距离（px）。
     *
     * ⚠️ 不能用 `innerWidth / innerHeight`：抽卡页的舞台上下有 chrome，
     *    包心比窗口中心低几十像素。用窗口算，光流会提前收尾 —— 真机表现是
     *    "彩虹到不了顶、上面留一条白"。
     */
    private box = { left: 600, right: 600, top: 400, bottom: 400 };
    /** canvas 覆盖的区域（单位）：左上角与尺寸 */
    private view = { x: -150, y: -60, w: 400, h: 200 };
    private scale = 1;
    private frames = 0;

    constructor(canvas: HTMLCanvasElement) {
        this.canvas = canvas;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('canvas 2d unavailable');
        this.ctx = ctx;
    }

    /** 尺寸变了（进入、resize）就重算几何与画布盒子 */
    setSize(pw: number, ph: number, box: { left: number; right: number; top: number; bottom: number }): void {
        this.pw = pw;
        this.ph = ph;
        this.box = box;
        this.sprout();
        this.fit();
    }

    /**
     * 撕动一下的冲量。
     *
     * 参考站每帧按"这一帧撕了多少"给光带 `g.v += dp*6`：光带不是匀速长出来的，
     * 而是**手每扯一下、就往前涌一截**。少了这个，撕口和彩虹就是两件事各演各的。
     */
    kick(amount: number): void {
        for (const b of this.ribbons) if (b.on) b.g.v += amount * 6;
    }

    /** 撕口到容器顶边还有多少单位（决定光流"能长多高"） */
    private roomAbove(): number {
        const u = this.pw / 100;
        return Math.max(24, 2.5 + (this.box.top - this.ph * (0.5 - TEAR_Y / 100)) / u);
    }

    /** 扇形顶端在 canvas 坐标里的 y（含冲出容器的余量） */
    private roofAt(cosA = 1): number {
        const u = this.pw / 100;
        // 撕口恒在 y=60：`.flow` 的 top 就是按 0.6·pw 摆的
        return Math.min(52, 60 + (this.ph * (0.5 - TEAR_Y / 100) - this.box.top / cosA) / u - OVER);
    }

    /** 生成这一包专属的光流（随机起始色、每条边的相位、每条带的渐变） */
    private sprout(): void {
        const k0 = Math.floor(rand(0, 7));
        const u = this.pw / 100;
        this.Y0 = 62.5 + ((SEGMENTS_Y_MAX - TEAR_Y) / 100) * this.ph / u;
        this.R0 = CY - this.Y0;

        this.lines = Array.from({ length: NR + 1 }, (_, j) => {
            const ox = 3 + (94 * j) / NR;
            const x = 50 + ((ox - 50) * this.R0) / 45;
            const a = Math.atan2(x - 50, this.R0) + rand(-0.012, 0.012);
            return { ox, x, ux: Math.sin(a), uy: -Math.cos(a), ph: j * 0.35 + rand(-0.1, 0.1), r: Math.hypot(x - 50, this.R0) };
        });

        this.ribbons = Array.from({ length: NR }, (_, j) => {
            const r = (this.lines[j].r + this.lines[j + 1].r) / 2;
            const k = (2 * Math.PI / 0.4) ** 2;
            const c = 4 * Math.PI * (1 - 0.3) / 0.4;
            const g = {
                x: 0, to: 0, v: 0,
                step: (h: number) => {
                    g.v += (k * (g.to - g.x) - c * g.v) * h;
                    g.x += g.v * h;
                },
            };
            return {
                mx: (this.lines[j].ox + this.lines[j + 1].ox) / 2,
                gx: (this.lines[j].x + this.lines[j + 1].x) / 2,
                r,
                L: 0,
                c: rainbow()[(j + k0) % 7],
                on: false,
                len: 0,
                grad: null,
                g,
            };
        });

        // 每条带的"出撕口白热 → 本色"渐变：几何是静的，建一次就够
        const hot = 26 + this.Y0 - 62.5;
        this.ribbons.forEach((b, j) => {
            const ux = (this.lines[j].ux + this.lines[j + 1].ux) / 2;
            const uy = (this.lines[j].uy + this.lines[j + 1].uy) / 2;
            const gr = this.ctx.createLinearGradient(b.gx, this.Y0, b.gx + ux * hot, this.Y0 + uy * hot);
            gr.addColorStop(0, tint(b.c, 0.7));
            gr.addColorStop(1, b.c);
            b.grad = gr;
        });

        this.motes = Array.from({ length: 10 }, () => ({
            j: -1, u: Math.random(), v: rand(0.2, 0.8), sp: rand(0.3, 0.5), r: rand(1.6, 3),
        }));
        this.moteSprite = makeMoteSprite();
    }

    /**
     * 算 canvas 要覆盖的区域，并把它摆到 `.flow`（包框）里。
     *
     * 覆盖范围只需要"扇形真正画到的地方"：上界 = 扇形顶端，左右 = 最外侧那条边
     * 横向能到多远，下界 = 撕口下方一点。算大了每帧多清一倍像素，算小了会切边。
     */
    private fit(): void {
        const u = this.pw / 100;
        const room = this.roomAbove();
        const top = this.roofAt(0.9);
        this.reach = (45 + room) * Math.hypot(47 / 45, 1) + TIP + 20;
        for (const b of this.ribbons) b.L = this.reach - b.r;

        const halfW = Math.max(60, (45 + room) * Math.tan((46 * Math.PI) / 180) + 24);
        const x = 50 - halfW;
        const w = halfW * 2;
        const y = top - 10;
        const h = Math.max(60, 60 + 70 - y);
        this.view = { x, y, w, h };

        const dpr = Math.min(window.devicePixelRatio || 1, BACKING);
        this.scale = u * dpr;
        this.canvas.width = Math.max(2, Math.round(w * this.scale));
        this.canvas.height = Math.max(2, Math.round(h * this.scale));
        // 位置：单位原点 = `.flow` 左上角 + (0, 10.5%ph − .6pw)
        const originY = this.ph * (TEAR_Y / 100) - this.pw * 0.6;
        this.canvas.style.left = `${(x * u).toFixed(1)}px`;
        this.canvas.style.top = `${(originY + y * u).toFixed(1)}px`;
        this.canvas.style.width = `${(w * u).toFixed(1)}px`;
        this.canvas.style.height = `${(h * u).toFixed(1)}px`;
    }

    /** 每帧：推进生长、重算 36 条边、画一次 */
    tick(s: FlowState): void {
        const { t, dt, reduce, tearP, tearDir, tearing, opened, openedAt, anchorRz } = s;
        if (!this.ribbons.length) return;

        const xt = tearDir > 0 ? tearP * 100 : 100 - tearP * 100;
        const want = tearing || (opened && !reduce && !this.drained) ? 1 : 0;
        this.glow.to = want;
        const n = Math.max(1, Math.ceil(dt * 240));
        const h = dt / n;
        for (let i = 0; i < n; i += 1) {
            this.glow.step(h);
            for (const b of this.ribbons) b.g.step(h);
        }
        if (this.glow.x <= 0.004 && !want) {
            this.canvas.style.opacity = '0';
            return;
        }
        this.canvas.style.opacity = clamp(this.glow.x, 0, 1).toFixed(3);

        const ft = reduce ? 0 : t;
        const sway = Math.sin(ft * 0.9) * 1.5;
        const go = !reduce && opened;
        const since = t - openedAt;
        const u = this.pw / 100;
        const a = (anchorRz * Math.PI) / 180;
        const roof = this.roofAt(Math.cos(a));
        const full = ((this.Y0 + this.R0 - roof) * this.ribbons[0].r) / this.R0 + TIP + 20;
        const far = go ? this.reach + (full - this.reach) * (1 - (1 - Math.min(1, since / 0.5)) ** 2) : this.reach;
        const tail = this.R0 - 5 + (go ? (full + 21 - this.R0) * clamp((since - 0.35) / 0.55, 0, 1) ** 2 : 0);
        const carry = go ? (45 * since * since) / (since + 0.25) : 0;

        for (const b of this.ribbons) {
            if (tearing && (tearDir > 0 ? b.mx < xt : b.mx > xt)) b.on = true;
            b.g.to = b.on ? 1 : 0;
            b.len = b.L * Math.max(0, b.g.x) + far - this.reach;
        }

        // 沿第 j 条边距离 d 处的点：方向 + 一道向外传播、越远越大的横波
        const at = (j: number, d: number): [number, number] => {
            const e = this.lines[j];
            const k = Math.min(1, d / 90);
            const w = (0.4 + 2 * k) * Math.sin(((d - carry) / 22 - ft * 1.4) * 2 * Math.PI + e.ph) + sway * k;
            return [e.x + e.ux * d - e.uy * w, this.Y0 + e.uy * d + e.ux * w];
        };

        const side = Math.max(this.box.left, this.box.right) / u + 14;
        // 每条边算一次、被左右两条 ribbon 共用（否则接缝会裂开）
        const edges = this.lines.map((e, j) => {
            const stop = Math.min((this.Y0 - roof) / -e.uy, (side - Math.abs(e.x - 50)) / Math.abs(e.ux)) + 24;
            const len = Math.min(Math.max(this.ribbons[j - 1]?.len || 0, this.ribbons[j]?.len || 0), stop);
            const i0 = Math.max(0, Math.floor((tail - e.r) / STEP));
            const pts: number[] = [];
            if (len > i0 * STEP) {
                for (let i = i0; ; i += 1) {
                    const d = Math.min(i * STEP, len);
                    const [x, y] = at(j, d);
                    pts.push(x, y);
                    if (d >= len) break;
                }
            }
            return { i0, pts, count: pts.length / 2 };
        });

        // 画：直接在主画布上按单位坐标绘制（避免离屏 scratch 与 ctx.filter 软模糊造成的主线程掉帧）
        const ctx = this.ctx;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        ctx.setTransform(this.scale, 0, 0, this.scale, -this.view.x * this.scale, -this.view.y * this.scale);

        const upto = (e: { i0: number; count: number; pts: number[] }, len: number) =>
            Math.max(0, Math.min(e.count, Math.ceil(len / STEP) - e.i0 + 1));

        for (let j = 0; j < NR; j += 1) {
            const b = this.ribbons[j];
            if (!b.on) continue;
            const nA = upto(edges[j], b.len);
            const nB = upto(edges[j + 1], b.len);
            if (nA < 2 || nB < 2) continue;
            ctx.beginPath();
            const A = edges[j].pts;
            const B = edges[j + 1].pts;
            ctx.moveTo(A[0], A[1]);
            for (let i = 1; i < nA; i += 1) ctx.lineTo(A[i * 2], A[i * 2 + 1]);
            for (let i = nB - 1; i >= 0; i -= 1) ctx.lineTo(B[i * 2], B[i * 2 + 1]);
            ctx.closePath();
            ctx.fillStyle = b.grad ?? b.c;
            ctx.fill();
        }

        // 亮边（0.4 单位的白线）隔帧更新：纯装饰，30fps 看不出来
        this.frames += 1;
        if (this.frames % 2 === 0) {
            ctx.strokeStyle = 'rgba(255,255,255,.7)';
            ctx.lineWidth = 0.4;
            ctx.beginPath();
            for (const e of edges) {
                if (e.count < 2) continue;
                ctx.moveTo(e.pts[0], e.pts[1]);
                for (let i = 1; i < e.count; i += 1) ctx.lineTo(e.pts[i * 2], e.pts[i * 2 + 1]);
            }
            ctx.stroke();
        }

        // 光点
        const live = this.ribbons.flatMap((b, j) => (b.on ? [j] : []));
        if (this.moteSprite) {
            for (const m of this.motes) {
                if (!reduce) m.u += dt * m.sp;
                if (m.u > 1 || !this.ribbons[m.j]?.on) {
                    if (m.u > 1) m.u -= 1;
                    if (!live.length) continue;
                    m.j = live[Math.floor(rand(0, live.length))];
                }
                const len = this.ribbons[m.j].len;
                const d0 = Math.max(0, tail - this.lines[m.j].r);
                const d = d0 + m.u * (len - d0);
                const [x1, y1] = at(m.j, d);
                const [x2, y2] = at(m.j + 1, d);
                const r = m.r * (0.6 + m.u * 0.7) * 1.6;
                ctx.globalAlpha = Math.max(0, Math.sin(Math.PI * m.u) * Math.min(1, len / 20));
                ctx.drawImage(this.moteSprite, x1 + (x2 - x1) * m.v - r, y1 + (y2 - y1) * m.v - r, r * 2, r * 2);
            }
            ctx.globalAlpha = 1;
        }

        // 径向淡出（原来那层 `mask`）：近撕口透明、远端透明，一次 destination-in 合成
        const fade = ctx.createRadialGradient(50, this.Y0 + this.R0, 0, 50, this.Y0 + this.R0, SPAN);
        const stops = [tail - 16, tail, far - TIP, far];
        fade.addColorStop(0, 'rgba(0,0,0,0)');
        for (let i = 0; i < 4; i += 1) {
            fade.addColorStop(clamp(Math.min(stops[i], far) / SPAN, 0, 1), i === 3 ? 'rgba(0,0,0,0)' : 'rgba(0,0,0,1)');
        }
        ctx.globalCompositeOperation = 'destination-in';
        ctx.fillStyle = fade;
        ctx.fillRect(this.view.x, this.view.y, this.view.w, this.view.h);
        ctx.globalCompositeOperation = 'source-over';

        this.drained = go && since > 0.9;
    }
}

/** 一个中心白、边缘透明的小圆点（光点贴图，画一次反复用） */
function makeMoteSprite(): HTMLCanvasElement | null {
    const s = 32;
    const c = document.createElement('canvas');
    c.width = s;
    c.height = s;
    const g = c.getContext('2d');
    if (!g) return null;
    const grad = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    grad.addColorStop(0.2, 'rgba(255,255,255,1)');
    grad.addColorStop(0.45, 'rgba(255,255,255,.55)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, s, s);
    return c;
}
