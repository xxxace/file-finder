/**
 * 五张卡的出场编排 —— 移植自 `holo-reverse/src/app.js` 的 `spawn / unwind / orbit / 帧内卡片段`。
 *
 * 状态机：`in` →（每张晚 22ms）`shot` →（全部飞出包口）`orbit` →（螺旋 1.25s）`spread`
 *
 * | 阶段 | 谁驱动 | 一句话 |
|---|---|---|
 * | `in` | 弹簧 | 还在包里，跟着包的姿态 |
 * | `shot` | 纯阻尼（`k=0, c=1.2`） | 竖直向上射出，速度自己衰减 |
 * | `orbit` | 时间函数 | 绕屏幕中心螺旋转 2.5 圈，位置由 `orbitAt` 直接算 |
 * | `spread` | 弹簧 | 落成一排，各自按相位缓慢摇摆 |
 *
 * 为什么 `shot` 要把刚度设 0：弹簧会把它"拉回"起点，而这里要的是**打出去就自由飞**。
 */
import { Spring, pose } from './spring';
import type { Springs } from './spring';
import { ORBIT, clamp, fanSpot, orbitAt, planOrbit } from './cardStage';
import type { FanSpot, OrbitPlan } from './cardStage';

export interface PackPose {
    rx: number;
    ry: number;
    rz: number;
    px: number;
    py: number;
    pw: number;
    ph: number;
    fallY: number;
    /** 包口高度（包内像素，相对包中心） */
    mouth: number;
    mouthY?: number;
}

type Phase = 'in' | 'shot' | 'orbit' | 'spread';

interface CardRt {
    p: Springs<{ x: number; y: number; z: number; rx: number; ry: number; rz: number; s: number }>;
    phase: Phase;
    i: number;
    slot: number;
    from: number;
    x0: number;
    y0: number;
    vy: number;
    rz0: number;
    even: number;
    end: number;
    plan: OrbitPlan | null;
    f: FanSpot;
    blinkAt: number;
    hover: boolean;
    hx: number;
    hy: number;
    active: boolean;
    /** 落位完成的时刻：卡面反光要在这之后 0.2s 才淡入，飞行中是"不反光"的 */
    landAt: number;
    /** 被抬起来还没沉回去（决定它压在邻居上面） */
    up: boolean;
    /** 按 z 排的名次（螺旋/竖屏时用它当 z-index） */
    rank: number;
    /** 落点是否算过（算过才需要响应 resize） */
    hasFan: boolean;
    /** 上一帧写进卡面的三个变量（值没变就不写：一写就是一次全卡重绘） */
    px: string;
    py: string;
    hyp: string;
    /** 静置期按 ~12fps 分桶更新箔面（见 `tick` 里的注释） */
    foilTick: number;
}

const rand = (a: number, b: number) => a + Math.random() * (b - a);

export class CardShow {
    private els: (HTMLElement | null)[] = [];
    private rt: CardRt[] = [];
    private spreadAt = 0;
    private startedAt = -1;
    private count = 0;
    private cw = 180;
    private ch = 252;
    /** 舞台中心（卡片就是从这个点算位移的）与透视原点的高度 */
    private ox = window.innerWidth / 2;
    private oy = window.innerHeight / 2;
    private p0y = window.innerHeight * 0.4;
    /** 舞台尺寸：扇形落点与螺旋半径都按**容器**算，不按窗口 */
    private vw = window.innerWidth;
    private vh = window.innerHeight;
    /** 卡面元素缓存（每帧要写三个 CSS 变量，别每帧 querySelector） */
    private faces = new WeakMap<HTMLElement, HTMLElement | null>();

    /** 螺旋开始 / 每张卡落位 —— 页面拿去配音。⚠️ 由本类**在正确的时刻**调用，别在页面里猜时间 */
    onUnwind: (() => void) | null = null;
    onLand: ((slot: number) => void) | null = null;

    setSlot(index: number, el: HTMLElement | null): void {
        this.els[index] = el;
    }

    /**
     * 舞台尺寸变了 ⇒ 重算落点（参考站 `resize` 里就是这一句：`if (c.f) c.f = fan(c)`）。
     *
     * 没有它，"缩小窗口再放大"之后卡片会停在旧落点上 —— 看起来就是"没有自适应"。
     * 正在螺旋的卡连 `plan.f` 一起换（plan 里存的是对象引用，不换就是旧值）。
     */
    refan(): void {
        for (const c of this.rt) {
            if (!c.hasFan) continue;
            c.f = fanSpot(c.slot, this.count, this.cw, this.vw, this.vh);
            if (c.plan) c.plan.f = c.f;
        }
    }

    /**
     * 指认舞台（页面在挂载 / resize 时给）。
     *
     * 五样都是**容器**而不是窗口：尺寸决定扇形怎么排、中心决定落点与命中测试的原点，
     * `p0y` 是透视原点（50% 40%）。
     *
     * ⚠️ `cw/ch` 也在这里给，**不要**只在 `reset()` 里给一次：
     *    CSS 的 `--cw` 是 `min(400px,52vh)*.69*.84`，窗口一变它就变；
     *    几何里留旧值 ⇒ 缩窗后卡片按旧尺寸排，五张要么叠在一起要么散得过开。
     */
    setBox(box: { w: number; h: number; ox: number; oy: number; p0y: number; cw: number; ch: number }): void {
        this.vw = box.w;
        this.vh = box.h;
        this.ox = box.ox;
        this.oy = box.oy;
        this.p0y = box.p0y;
        this.cw = box.cw;
        this.ch = box.ch;
    }

    /** 重抽一包时重建（卡的顺序被打乱，`slot` 决定它在整排里的位置）。几何归 `setBox` 管 */
    reset(count: number): void {
        this.count = count;
        this.spreadAt = 0;
        this.startedAt = -1;
        this.rt = Array.from({ length: count }, (_, i) => ({
            p: pose({ x: 0, y: 0, z: 3.5 - i * 1.75, rx: 0, ry: 0, rz: 0, s: 0.94 }, 0.55, 0.22),
            phase: 'in' as Phase,
            i,
            slot: count - 1 - i,
            from: 0,
            x0: 0,
            y0: 0,
            vy: 0,
            rz0: 0,
            even: 0,
            end: 0,
            plan: null,
            f: { x: 0, y: 0, z: 0, rz: 0, s: 1 },
            blinkAt: rand(0.6, 3.2),
            hover: false,
            hx: 0.5,
            hy: 0.5,
            active: false,
            landAt: 0,
            up: false,
            rank: 0,
            hasFan: false,
            px: '', py: '', hyp: '',
            foilTick: -1,
        }));
    }

    /**
     * 开包（`opened` 事件）时调用；`t` 是舞台时间。
     *
     * `reduce` 时整个物理被冻住（`useStage` 把 dt 归零），所以必须**直接落位** ——
     * 参考站同一分支：`cards.forEach(c => c.phase = 'spread', ...)`。漏了它，
     * 开了"减少动态效果"的人会看到五张卡一动不动地叠在包心里。
     */
    start(t: number, reduce = false, pack?: PackPose): void {
        this.startedAt = t;
        for (const c of this.rt) {
            c.phase = 'in';
            if (pack) {
                const mouthY = pack.mouthY ?? 14;
                c.p.x.x = c.p.x.to = pack.px;
                c.p.y.x = c.p.y.to = pack.py + pack.ph * ((mouthY + 0.8 + 38.2) / 100 - 0.5);
                c.p.rx.x = c.p.rx.to = 0;
                c.p.ry.x = c.p.ry.to = 0;
                c.p.rz.x = c.p.rz.to = pack.rz;
                c.p.s.x = c.p.s.to = 0.94;
            }
        }
        if (!reduce) return;
        for (const c of this.rt) {
            c.f = fanSpot(c.slot, this.count, this.cw, this.vw, this.vh);
            c.hasFan = true;
            c.phase = 'spread';
            c.landAt = 0;
            for (const k of Object.keys(c.f) as (keyof FanSpot)[]) {
                c.p[k].x = c.p[k].to = c.f[k];
            }
        }
        this.spreadAt = 1;
    }

    /** 已经落成一排？页面据此显示"再来一包" */
    get spread(): boolean {
        return this.spreadAt > 0;
    }

    get landed(): number {
        return this.spreadAt;
    }

    /**
     * 每帧。
     *
     * @param reduce `prefers-reduced-motion`
     */
    tick(t: number, dt: number, pack: PackPose, reduce = false): void {
        if (!this.rt.length || this.startedAt < 0) return;

        // 每张卡自己的弹簧一起子步进（`Spring.x` 由这一帧的目标驱动）
        const all: Spring[] = [];
        for (const c of this.rt) all.push(...(Object.values(c.p) as Spring[]));

        for (const c of this.rt) {
            const p = c.p;

            // ── in → shot：每张晚 22ms，像一叠牌被顶出来 ────────────
            if (c.phase === 'in' && this.startedAt >= 0 && t - this.startedAt > c.i * 0.022) {
                c.phase = 'shot';
                p.s.to = 1;
                // 刚度清零 = 打出去就不回头，只靠阻尼滑行
                p.y.k = 0;
                p.y.c = 1.2;
                p.y.v = -rand(1250, 1450) * pack.ph / 420;
            }

            if (c.phase === 'spread') {
                const f = c.f;
                const w = t * 0.8 + c.i * 1.9;
                const on = c.hover || c.active;
                // 静置时的呼吸：三轴各自不同相位 —— 五张卡不能同频，同频就读作"整排在晃"
                const motion = reduce ? 0 : 1;
                p.x.to = f.x;
                p.s.to = f.s;
                p.y.to = f.y + (on ? -16 : Math.sin(w * 1.2) * 5 * motion);
                p.z.to = f.z + (on ? 110 : 0);
                p.rz.to = on ? f.rz * 0.3 : f.rz;
                p.rx.to = on ? (0.5 - c.hy) * 36 : Math.cos(w * 0.9) * 4 * motion;
                p.ry.to = on ? (c.hx - 0.5) * 40 : Math.sin(w) * 8 * motion;
            }
        }

        // 子步进
        const n = Math.max(1, Math.ceil(dt * 240));
        const h = dt / n;
        for (let k = 0; k < n; k += 1) for (const s of all) s.step(h);

        // ── 全部飞出包口 ⇒ 开始螺旋 ──────────────────────────────
        if (this.startedAt >= 0 && !this.spreadAt && this.rt.every(c => c.phase === 'shot')) {
            const mouth = pack.py + pack.fallY + pack.ph * (((pack.mouthY ?? 14)) / 100 - 0.5);
            const clear = this.rt.every(c => c.p.y.x + this.ch * 0.36 < mouth);
            if (clear) this.unwind(t, pack);
        }
        for (const c of this.rt) {
            if (c.phase === 'orbit' && c.plan) {
                const fr = orbitAt(c.plan, t, this.vw, this.vh);
                c.p.x.x = fr.x;
                c.p.y.x = fr.y;
                c.p.z.x = fr.z;
                c.p.rx.x = fr.rx;
                c.p.ry.x = fr.ry;
                c.p.rz.x = fr.rz;
                if (t - c.plan.from >= ORBIT) {
                    c.phase = 'spread';
                    c.landAt = t;
                    const vals = Object.values(c.p) as Spring[];
                    for (const s of vals) s.set(0.5, 0.22);
                    if (!this.spreadAt || t > this.spreadAt) this.spreadAt = t + 0.3;
                    this.onLand?.(c.slot);
                }
            }
        }

        // 离你最近的画在上面（螺旋时 z 一直在变，所以每帧重排一次名次）
        [...this.rt].sort((a, b) => a.p.z.x - b.p.z.x).forEach((c, i) => { c.rank = i + 1; });
        const tall = this.vh > this.vw * 1.15;

        // ── 写回 DOM ────────────────────────────────────────────
        for (const c of this.rt) {
            const el = this.els[c.i];
            if (!el) continue;
            const p = c.p;
            const loose = c.phase === 'spread' || c.phase === 'orbit';
            // 还在包里时卡片跟着包一起歪；出来后由运动决定倾斜（纸片在空气里会向后仰）
            const rx = loose ? p.rx.x - clamp(p.y.v * 0.006, -8, 8) : pack.rx;
            const ry = loose ? p.ry.x + clamp(p.x.v * 0.008, -12, 12) : pack.ry;
            el.style.transform =
                `translate3d(${p.x.x.toFixed(2)}px,${p.y.x.toFixed(2)}px,${p.z.x.toFixed(2)}px) `
                + `rotateZ(${p.rz.x.toFixed(2)}deg) rotateX(${rx.toFixed(2)}deg) rotateY(${ry.toFixed(2)}deg) `
                + `scale(${p.s.x.toFixed(3)})`;
            // 抬起来的那张压在邻居上面，而且**沉回去之前一直在上面**（否则会在中途钻到别人背后）
            c.up = c.hover || c.active || (c.up && p.z.x > c.f.z + 30);
            const z = c.up ? '9' : (c.phase === 'orbit' || tall ? String(c.rank) : String(this.count - c.i));
            if (el.style.zIndex !== z) el.style.zIndex = z;

            /**
             * 卡面的箔/眩光由**这张卡自己的倾角**驱动，不是由鼠标位置驱动。
             *
             * ⚠️ 这就是"鼠标在卡上会抖"的根：以前在卡片内部用 `pointermove` +
             *    `getBoundingClientRect()` 算倾角 —— 卡片一转，它的包围盒就变，
             *    于是同一个鼠标位置算出的角度又变了，形成正反馈；再叠上外层的弹簧倾角，
             *    两个 transform 打架，看起来就是抽搐。
             * 源码的写法是：反光每帧从 `ry / rx` 反推（`nx = ry/24`），光线永远跟着卡面走。
             */
            // 卡面反光与全息光层重绘极其昂贵：飞行（shot / orbit）期间必须保持静止（纯 GPU 3D 变换），
            // 只有落位（spread）0.2s 后才平滑淡入（完全对齐源项目 app.js 第 409 行设计纪律）
            if (c.phase === 'spread') {
                const a = reduce ? 1 : clamp((t - c.landAt - 0.2) / 0.5, 0, 1);
                if (a) {
                    const nx = clamp(ry / 24, -1, 1) * a;
                    const ny = clamp(rx / 24, -1, 1) * a;
                    const st = this.faceStyle(el);
                    if (st) {
                        const px = (50 + nx * 50).toFixed(1);
                        const py = (50 - ny * 50).toFixed(1);
                        const hyp = Math.min(1, Math.hypot(nx, ny)).toFixed(3);
                        if (px !== c.px) { c.px = px; st.setProperty('--px', px); }
                        if (py !== c.py) { c.py = py; st.setProperty('--py', py); }
                        if (hyp !== c.hyp) { c.hyp = hyp; st.setProperty('--hyp', hyp); }
                    }
                }
            }
        }
    }

    private faceStyle(el: HTMLElement): CSSStyleDeclaration | null {
        let face = this.faces.get(el);
        if (face === undefined) {
            face = el.querySelector('.face') as HTMLElement | null;
            this.faces.set(el, face);
        }
        return face ? face.style : null;
    }

    private unwind(t: number, pack: PackPose): void {
        this.spreadAt = 1;   // 占位，避免重复触发
        this.onUnwind?.();
        for (const c of this.rt) {
            const f = fanSpot(c.slot, this.count, this.cw, this.vw, this.vh);
            c.f = f;
            c.hasFan = true;
            c.phase = 'orbit';
            c.from = t + c.i * 0.03;
            c.x0 = c.p.x.x;
            c.y0 = c.p.y.x;
            c.vy = c.p.y.v;
            c.rz0 = c.p.rz.x;
            c.plan = planOrbit(
                c.slot, c.i, this.count, t,
                { x: c.x0, y: c.y0, vy: c.vy, rz: c.rz0 },
                f,
            );
            c.p.s.to = f.s;
        }
        // 螺旋期间位置完全由时间函数决定
        for (const c of this.rt) {
            const vals = Object.entries(c.p) as [string, Spring][];
            for (const [key, s] of vals) {
                if (key === 's') continue;
                s.k = 0;
                s.c = 0;
                s.v = 0;
            }
        }
        void pack;
    }

    /**
     * 指针落在哪张卡上（用落位的几何算，不用它当前飞到的位置）。
     *
     * ⚠️ 纵向用的是"透视原点(40%) + 卡片中心按 near 外推"，不是简单的 `oy + f.y`：
     * 这与源码同一式子。卡片 z>0 时（抬起 110）它投影的位置会往下偏一点，
     * 不算这一步，卡片的可命中区会跟它画出来的位置差十几像素。
     */
    hitTest(px: number, py: number): number {
        let best = -1;
        let bestZ = -Infinity;
        for (const c of this.rt) {
            if (c.phase !== 'spread') continue;
            const f = c.f;
            const near = 1400 / (1400 - f.z);
            const a = (f.rz * Math.PI) / 180;
            const cos = Math.cos(a);
            const sin = Math.sin(a);
            const w = this.cw * f.s * near;
            const h = w * 1.4;
            const dx = px - (this.ox + f.x * near);
            const dy = py - (this.p0y + (this.oy - this.p0y + f.y) * near);
            const hx = (dx * cos + dy * sin) / w + 0.5;
            const hy = (dy * cos - dx * sin) / h + 0.5;
            if (hx >= 0 && hx <= 1 && hy >= 0 && hy <= 1 && f.z >= bestZ) {
                best = c.i;
                bestZ = f.z;
                c.hx = hx;
                c.hy = hy;
            }
        }
        return best;
    }

    setHover(index: number): void {
        for (const c of this.rt) c.hover = c.i === index;
    }

    setActive(index: number): void {
        for (const c of this.rt) c.active = c.i === index;
    }
}
