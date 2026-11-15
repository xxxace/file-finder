import { rainbow } from './rainbow';

/**
 * 彩虹光流 —— 移植自 `holo-reverse/src/app.js` 的 `sprout / fit / pour` 三函数。
 *
 * ## 它到底是什么（这是最容易做错的地方）
 *
 * 不是"一层彩虹渐变"，也不是"一圈放大的光晕"。它是：
 *   · **35 条 ribbon**（相邻两条"边"围成的封闭条带），并排无缝，七色循环；
 *   · 36 条边全部从包装**下方一点**发散，所以中间的条带笔直向上、外侧的斜着出去；
 *   · 每条边本身是一条**向外传播的行波**：`w = (.4+2k)·sin((d-carry)/22·2π − t·1.4 + phase)`，
 *     越远振幅越大 —— 这是"流"而不是"柱"的全部原因；
 *   · 每条带子出撕口时是**白热**的（往白里混 70%），往外逐渐褪回本色；
 *   · 带子里有 **10 个光点**（mote）沿着它漂；
 *   · 整组外面有**高斯 bloom** + 一圈径向 mask 让远端淡出；
 *   · **撕到哪条带子，哪条才开始喷**（`b.mx < 撕口位置`）—— 所以撕的口子越长，喷得越宽；
 *   · 开包后整片扇形**在 0.5 秒内冲出屏幕**，尾部跟着撕口走。
 *
 * 少任何一条都会退化成"一坨发光的彩带"，所以我一条都没省。
 */

const NR = 35;          // ribbon 数（边数 = NR + 1）
const CY = 107.5;       // 发散中心在 svg 单位里的 y
const STEP = 2.5;       // 折线采样步长（svg 单位）
const SPAN = 1500;      // mask 半径
const TIP = 36;         // 软尾长度
const SEGMENTS_Y_MAX = 19.5;
const TEAR_Y = 10.5;

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
    g: { x: number; to: number; v: number; step: (h: number) => void };
}

interface Mote {
    el: SVGCircleElement;
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

/** 一条条带 = A 正着 + B 反着（闭合） */
function ribbonPath(a: readonly string[], b: readonly string[]): string {
    return `M${a.join('L')}L${b.slice().reverse().join('L')}Z`;
}

export class RainbowFlow {
    private svg: SVGSVGElement;
    private lines: Line[] = [];
    private ribbons: Ribbon[] = [];
    private motes: Mote[] = [];
    private bandEls: SVGPathElement[] = [];
    private edgeEls: SVGPathElement[] = [];
    private stops: SVGStopElement[] = [];
    private glow = { x: 0, to: 0, v: 0, k: 0, c: 0, step: (_h: number) => {} };
    private reach = 0;
    private drained = false;
    private Y0 = 62.5;
    private R0 = 45;
    private pw = 300;
    private ph = 300;
    private vw = 1200;
    private vh = 800;

    constructor(svg: SVGSVGElement) {
        this.svg = svg;
        // 光流自己的"出现/消失"也是一根弹簧（参考站 `glow`）
        this.glow.k = (2 * Math.PI / 0.5) ** 2;
        this.glow.c = 0;
        this.glow.step = (h: number) => {
            this.glow.v += (this.glow.k * (this.glow.to - this.glow.x) - this.glow.c * this.glow.v) * h;
            this.glow.x += this.glow.v * h;
        };
    }

    /** 尺寸变了（进入、resize）就重建整套 defs 与 path */
    setSize(pw: number, ph: number, vw: number, vh: number): void {
        this.pw = pw;
        this.ph = ph;
        this.vw = vw;
        this.vh = vh;
        this.sprout();
        this.fit();
    }

    /**
     * 撕动一下的冲量。
     *
     * 参考站每帧按"这一帧撕了多少"给光带一个 `g.v += dp*6`：光带不是匀速长出来的，
     * 而是**手每扯一下、就往前涌一截**。少了这个，撕口和彩虹就是两件事各演各的
     * （这就是"配合差点意思"）。
     */
    kick(amount: number): void {
        for (const b of this.ribbons) if (b.on) b.g.v += amount * 6;
    }

    reset(): void {
        this.glow.x = this.glow.to = this.glow.v = 0;
        this.drained = false;
        for (const b of this.ribbons) {
            b.on = false;
            b.g.x = b.g.to = b.g.v = 0;
        }
        this.svg.style.opacity = '0';
    }

    /** 生成这一包专属的光流（随机起始色、每条边的相位） */
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
                g,
            };
        });

        const gradients = this.ribbons.map((b, j) => {
            const ux = (this.lines[j].ux + this.lines[j + 1].ux) / 2;
            const uy = (this.lines[j].uy + this.lines[j + 1].uy) / 2;
            const hot = 26 + this.Y0 - 62.5;
            return `<linearGradient id="ff-b${j}" gradientUnits="userSpaceOnUse" x1="${b.gx.toFixed(2)}" y1="${this.Y0}" x2="${(b.gx + ux * hot).toFixed(2)}" y2="${(this.Y0 + uy * hot).toFixed(2)}"><stop stop-color="${tint(b.c, 0.7)}"/><stop offset="1" stop-color="${b.c}"/></linearGradient>`;
        }).join('');

        this.svg.innerHTML = `<defs>
            <radialGradient id="ff-mote"><stop offset=".2" stop-color="#fff"/><stop offset=".45" stop-color="#fff" stop-opacity=".55"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>
            ${gradients}
            <radialGradient id="ff-fade" gradientUnits="userSpaceOnUse" cx="50" cy="${this.Y0 + this.R0}" r="${SPAN}">
                <stop stop-color="#fff" stop-opacity="0"/><stop stop-color="#fff"/><stop stop-color="#fff"/><stop stop-color="#fff" stop-opacity="0"/>
            </radialGradient>
            <mask id="ff-mask" maskUnits="userSpaceOnUse"><rect fill="url(#ff-fade)"/></mask>
            <filter id="ff-bloom" filterUnits="userSpaceOnUse"><feGaussianBlur stdDeviation="2.4"/><feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge></filter>
        </defs>
        <g filter="url(#ff-bloom)"><g mask="url(#ff-mask)">
            ${this.ribbons.map((_, j) => `<path class="ff-band" fill="url(#ff-b${j})"/>`).join('')}
            <g fill="none" stroke="#fff" stroke-opacity=".7" stroke-width=".4">${'<path class="ff-edge"/>'.repeat(NR + 1)}</g>
            ${'<circle class="ff-mote" fill="url(#ff-mote)"/>'.repeat(10)}
        </g></g>`;

        this.bandEls = [...this.svg.querySelectorAll('.ff-band')] as SVGPathElement[];
        this.edgeEls = [...this.svg.querySelectorAll('.ff-edge')] as SVGPathElement[];
        this.stops = [...this.svg.querySelectorAll('#ff-fade stop')] as SVGStopElement[];
        this.motes = ([...this.svg.querySelectorAll('.ff-mote')] as SVGCircleElement[]).map(el => ({
            el, j: -1, u: Math.random(), v: rand(0.2, 0.8), sp: rand(0.3, 0.5), r: rand(1.6, 3),
        }));
    }

    /** 所有与窗口尺寸有关的部分：让最外侧那条也能冲出屏幕顶边 */
    private fit(): void {
        const u = this.pw / 100;
        const room = 2.5 + (this.vh / 2 - this.ph * (0.5 - TEAR_Y / 100)) / u;
        const w = Math.min(this.vw / 2 / u, room * 1.2 + 60) + 20;
        this.reach = (45 + room) * Math.hypot(47 / 45, 1) + TIP + 20;
        for (const b of this.ribbons) b.L = this.reach - b.r;
        const box = { x: 50 - w, y: 32.5 - room, width: 2 * w, height: room + 60 };
        for (const el of this.svg.querySelectorAll('#ff-mask,#ff-mask rect,#ff-bloom')) {
            for (const key in box) el.setAttribute(key, (box as Record<string, number>)[key].toFixed(1));
        }
    }

    /** 每帧：推进生长、重算 36 条边、写回 path */
    tick(s: FlowState): void {
        const { t, dt, reduce, tearP, tearDir, tearing, opened, openedAt, anchorRz } = s;
        if (!this.ribbons.length) return;

        const xt = tearDir > 0 ? tearP * 100 : 100 - tearP * 100;

        // 出现/消失
        const want = tearing || (opened && !reduce && !this.drained) ? 1 : 0;
        this.glow.to = want;
        const n = Math.max(1, Math.ceil(dt * 240));
        const h = dt / n;
        for (let i = 0; i < n; i += 1) {
            this.glow.step(h);
            for (const b of this.ribbons) b.g.step(h);
        }
        if (this.glow.x <= 0.004 && !want) {
            this.svg.style.opacity = '0';
            return;
        }
        this.svg.style.opacity = this.glow.x.toFixed(3);

        const ft = reduce ? 0 : t;
        const sway = Math.sin(ft * 0.9) * 1.5;
        const go = !reduce && opened;
        const since = t - openedAt;
        const u = this.pw / 100;
        const a = (anchorRz * Math.PI) / 180;
        const roof = 60 + ((-this.vh / 2) / Math.cos(a) + this.ph * (0.5 - TEAR_Y / 100)) / u;
        const full = ((this.Y0 + this.R0 - roof) * this.ribbons[0].r) / this.R0 + TIP + 20;
        const far = go ? this.reach + (full - this.reach) * (1 - (1 - Math.min(1, since / 0.5)) ** 2) : this.reach;
        const tail = this.R0 - 5 + (go ? (full + 21 - this.R0) * clamp((since - 0.35) / 0.55, 0, 1) ** 2 : 0);
        const carry = go ? (45 * since * since) / (since + 0.25) : 0;

        for (const b of this.ribbons) {
            if (tearing && (tearDir > 0 ? b.mx < xt : b.mx > xt)) b.on = true;
            // 只增不减：一旦开始喷，撕回去也不会停
            b.g.to = b.on ? 1 : 0;
            b.len = b.L * Math.max(0, b.g.x) + far - this.reach;
        }

        [tail - 16, tail, far - TIP, far].forEach((o, i) => {
            this.stops[i]?.setAttribute('offset', clamp(Math.min(o, far) / SPAN, 0, 1).toFixed(4));
        });

        // 沿第 j 条边距离 d 处的点：方向 + 一道向外传播、越远越大的横波
        const at = (j: number, d: number): [number, number] => {
            const e = this.lines[j];
            const k = Math.min(1, d / 90);
            const w = (0.4 + 2 * k) * Math.sin(((d - carry) / 22 - ft * 1.4) * 2 * Math.PI + e.ph) + sway * k;
            return [e.x + e.ux * d - e.uy * w, this.Y0 + e.uy * d + e.ux * w];
        };

        const side = this.vw / 2 / u + 14;
        const fix = (v: number) => Math.round(v * 20) / 20;
        // 每条边算一次、被左右两条 ribbon 共用（否则接缝会裂开）
        const edges = this.lines.map((e, j) => {
            const stop = Math.min((this.Y0 - roof) / -e.uy, (side - Math.abs(e.x - 50)) / Math.abs(e.ux)) + 24;
            const len = Math.min(Math.max(this.ribbons[j - 1]?.len || 0, this.ribbons[j]?.len || 0), stop);
            const i0 = Math.max(0, Math.floor((tail - e.r) / STEP));
            const pts: string[] = [];
            if (len > i0 * STEP) {
                for (let i = i0; ; i += 1) {
                    const d = Math.min(i * STEP, len);
                    const [x, y] = at(j, d);
                    pts.push(`${fix(x)} ${fix(y)}`);
                    if (d >= len) break;
                }
            }
            return { i0, pts };
        });

        const upto = (e: { i0: number; pts: string[] }, len: number) =>
            e.pts.slice(0, Math.max(0, Math.ceil(len / STEP) - e.i0 + 1));

        this.ribbons.forEach((b, j) => {
            const A = upto(edges[j], b.len);
            const B = upto(edges[j + 1], b.len);
            this.bandEls[j]?.setAttribute('d', A.length > 1 && B.length > 1 ? ribbonPath(A, B) : '');
        });
        this.edgeEls.forEach((el, j) => {
            el.setAttribute('d', edges[j].pts.length > 1 ? `M${edges[j].pts.join('L')}` : '');
        });

        this.drained = go && since > 0.9;

        const live = this.ribbons.flatMap((b, j) => (b.on ? [j] : []));
        for (const m of this.motes) {
            if (!reduce) m.u += dt * m.sp;
            if (m.u > 1 || !this.ribbons[m.j]?.on) {
                if (m.u > 1) m.u -= 1;
                if (!live.length) {
                    m.el.setAttribute('opacity', '0');
                    continue;
                }
                m.j = live[Math.floor(rand(0, live.length))];
            }
            const len = this.ribbons[m.j].len;
            const d0 = Math.max(0, tail - this.lines[m.j].r);
            const d = d0 + m.u * (len - d0);
            const [x1, y1] = at(m.j, d);
            const [x2, y2] = at(m.j + 1, d);
            m.el.setAttribute('cx', (x1 + (x2 - x1) * m.v).toFixed(2));
            m.el.setAttribute('cy', (y1 + (y2 - y1) * m.v).toFixed(2));
            m.el.setAttribute('r', (m.r * (0.6 + m.u * 0.7)).toFixed(2));
            m.el.setAttribute('opacity', (Math.sin(Math.PI * m.u) * Math.min(1, len / 20)).toFixed(2));
        }
    }
}
