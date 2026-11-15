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
    px: number;
    py: number;
    pw: number;
    ph: number;
    fallY: number;
    /** 包口高度（包内像素，相对包中心） */
    mouth: number;
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

    setSlot(index: number, el: HTMLElement | null): void {
        this.els[index] = el;
    }

    /** 重抽一包时重建（卡的顺序被打乱，`slot` 决定它在整排里的位置） */
    reset(count: number, cw: number, ch: number): void {
        this.count = count;
        this.cw = cw;
        this.ch = ch;
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
        }));
    }

    /** 开包（`opened` 事件）时调用；`t` 是舞台时间 */
    start(t: number): void {
        this.startedAt = t;
        for (const c of this.rt) c.phase = 'in';
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
     * @param pointerSel 当前鼠标悬停/键盘选中的卡片下标（-1 = 没有）
     */
    tick(t: number, dt: number, pack: PackPose, pointerSel: number): void {
        if (!this.rt.length) return;

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
                p.x.to = f.x;
                p.s.to = f.s;
                p.y.to = f.y + (on ? -16 : Math.sin(w * 1.2) * 5);
                p.z.to = f.z + (on ? 110 : 0);
                p.rz.to = on ? f.rz * 0.3 : f.rz;
                p.rx.to = on ? (0.5 - c.hy) * 36 : Math.cos(w * 0.9) * 4;
                p.ry.to = on ? (c.hx - 0.5) * 40 : Math.sin(w) * 8;
            }
        }

        // 子步进
        const n = Math.max(1, Math.ceil(dt * 240));
        const h = dt / n;
        for (let k = 0; k < n; k += 1) for (const s of all) s.step(h);

        // ── 全部飞出包口 ⇒ 开始螺旋 ──────────────────────────────
        if (this.startedAt >= 0 && !this.spreadAt && this.rt.every(c => c.phase === 'shot')) {
            const clear = this.rt.every(c => c.p.y.x + this.ch * 0.36 < pack.mouth);
            if (clear) this.unwind(t, pack);
        }
        for (const c of this.rt) {
            if (c.phase === 'orbit' && c.plan) {
                const fr = orbitAt(c.plan, t, window.innerWidth, window.innerHeight);
                c.p.x.x = fr.x;
                c.p.y.x = fr.y;
                c.p.z.x = fr.z;
                c.p.rx.x = fr.rx;
                c.p.ry.x = fr.ry;
                c.p.rz.x = fr.rz;
                if (t - c.plan.from >= ORBIT) {
                    c.phase = 'spread';
                    const vals = Object.values(c.p) as Spring[];
                    for (const s of vals) s.set(0.5, 0.22);
                    if (!this.spreadAt || t > this.spreadAt) this.spreadAt = t + 0.3;
                }
            }
        }

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
            el.style.zIndex = c.hover || c.active ? '9' : String(this.count - c.i);
        }
    }

    private unwind(t: number, pack: PackPose): void {
        this.spreadAt = 1;   // 占位，避免重复触发
        for (const c of this.rt) {
            const f = fanSpot(c.slot, this.count, this.cw, window.innerWidth, window.innerHeight);
            c.f = f;
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

    /** 指针落在哪张卡上（用落位的几何算，不用它当前飞到的位置） */
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
            const dx = px - (window.innerWidth / 2 + f.x * near);
            const dy = py - (window.innerHeight * 0.4 + (window.innerHeight * 0.1 + f.y) * near);
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
