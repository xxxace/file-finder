/**
 * 纸屑 —— 移植自 `holo-reverse/src/app.js` 的 `load / burst / onStage` 与帧内那段更新。
 *
 * ## 它与"从屏幕中间喷一把彩纸"的差别（每一条都决定像不像）
 *
 * 1. **从包里出来**：每片先被赋予一个**包内坐标**（`lx/ly/lz`，百分比 + 深度），
 *    竖直向上冲；**越过撕口那条线之前根本不画**（被包装挡住）。
 * 2. **越过撕口才散开**：到线的那一刻用 `onStage()` 把包内坐标经包当前的
 *    三轴旋转投影到舞台，同时给它一个按 `lx` 左右分开的初速 —— 所以是"被吹出来"，
 *    不是"原地炸开"。
 * 3. **空气阻力是隐式解**：`f = 1/(1 + c·min(1, .06+age/.45)·v·dt)`，二次阻力用
 *    闭式解算，硬冲也不会反向弹回（显式的 `v -= k·v²·dt` 在高速时会过冲）。
 * 4. **一张纸在翻**：用 `setTransform` 的四个分量做 2D 仿射，`cq = cos((r-r0)·.7)`
 *    让"翻过去时高度被压扁"，再加上 `1400/(1400-z)` 的透视缩放。
 * 5. **三维里有侧滑**：`slip`（随自旋左右飘）+ `glide`（整体朝一侧滑），所以
 *    纸屑云在落下过程中会持续摊开，而不是一条竖直的雨。
 */

import { rainbow } from './rainbow';

export interface ConfettiPose {
    rx: number;
    ry: number;
    rz: number;
    /** 包中心在舞台里的位移 */
    px: number;
    py: number;
    pw: number;
    ph: number;
    /** 开包后包被踢下去的额外位移 */
    fallY: number;
}

export interface ConfettiOptions {
    /** 视口尺寸（用于透视与初速，与画布像素无关） */
    vw: number;
    vh: number;
    getPose: () => ConfettiPose;
    /** 撕口在包内的高度（百分比），纸屑越过它才可见 */
    tearYAt: (x: number) => number;
    count?: number;
}

interface Bit {
    kind: number;
    fill: string;
    inside: boolean;
    lx: number;
    ly: number;
    lz: number;
    up: number;
    a: number;
    sp: number;
    r: number;
    spin: number;
    c: number;
    slip: number;
    glide: number;
    sc: number;
    ph: number;
    age: number;
    x: number;
    y: number;
    z: number;
    vx: number;
    vy: number;
    vz: number;
    r0: number;
}

const GRAVITY = 2600;
const PERSPECTIVE = 1400;

/** 三种形状：圆点 / 纸条 / 星芒（和参考站同一套） */
function makePaths(): Path2D[] {
    const dot = new Path2D();
    dot.arc(0, 0, 4.5, 0, 7);
    const strip = new Path2D();
    strip.roundRect(-3.5, -6, 7, 12, 2);
    const star = new Path2D('M0-6 1.3-1.3 6 0 1.3 1.3 0 6-1.3 1.3-6 0-1.3-1.3Z');
    return [dot, strip, star];
}

const rand = (a: number, b: number) => a + Math.random() * (b - a);

export function burst(canvas: HTMLCanvasElement, opts: ConfettiOptions): () => void {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return () => {};

    const ctx = canvas.getContext('2d');
    if (!ctx) return () => {};

    const dpr = Math.min(window.devicePixelRatio || 1, 1.25);
    const cssW = canvas.clientWidth || opts.vw;
    const cssH = canvas.clientHeight || opts.vh;
    const targetW = Math.max(1, Math.round(cssW * dpr));
    const targetH = Math.max(1, Math.round(cssH * dpr));
    if (canvas.width !== targetW || canvas.height !== targetH) {
        canvas.width = targetW;
        canvas.height = targetH;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const paths = makePaths();
    const colors = rainbow().concat(['white']);
    const count = opts.count ?? 240;
    const ox = cssW / 2;
    const oy = cssH * 0.4;

    /** 包内一点 → 舞台坐标（跟着包当前的朝向一起转）。`pose` 由调用方每帧取一次传进来 */
    const onStage = (pose: ConfettiPose, lx: number, ly: number, lz: number): [number, number, number] => {
        const R = Math.PI / 180;
        const cx = Math.cos(pose.rx * R);
        const sx = Math.sin(pose.rx * R);
        const cy = Math.cos(pose.ry * R);
        const sy = Math.sin(pose.ry * R);
        const cz = Math.cos(pose.rz * R);
        const sz = Math.sin(pose.rz * R);
        const x0 = ((lx - 50) / 100) * pose.pw;
        const y0 = ((ly - 50) / 100) * pose.ph;
        const x1 = x0 * cz - y0 * sz;
        const y1 = x0 * sz + y0 * cz;
        const x2 = x1 * cy + lz * sy;
        const z2 = -x1 * sy + lz * cy;
        return [
            x2 + pose.px,
            y1 * cx - z2 * sx + pose.py + pose.fallY,
            y1 * sx + z2 * cx,
        ];
    };

    const bits: Bit[] = [];
    for (let i = 0; i < count; i += 1) {
        const lx = rand(6, 94);
        // vt = 这片纸"穿过空气能掉多快"，用它反解出阻力系数 c：重的快、轻的飘
        const vt = 260 + 400 * Math.random() ** 1.5;
        bits.push({
            kind: i % 3,
            fill: colors[i % colors.length],
            inside: true,
            lx,
            ly: opts.tearYAt(lx) + rand(1, 16),
            lz: rand(4.6, 7),
            up: rand(900, 2600),
            a: ((lx - 50) / 50 + rand(-0.5, 0.5)) * Math.min(Math.max(opts.vw / 1000, 0.5), 1),
            sp: rand(500, 2700),
            r: rand(0, 360),
            spin: rand(-700, 700),
            c: GRAVITY / vt / vt,
            slip: rand(900, 2600),
            glide: Math.sign(lx - 50) * rand(-200, 900),
            sc: rand(0.9, 1.9),
            ph: rand(0, 6.28),
            // 前 50 片立刻走，其余错开 0~0.22s —— 一口同时喷出来像"一面墙"
            age: i < 50 ? 0 : -rand(0, 0.22),
            x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, r0: 0,
        });
    }

    let raf = 0;
    let last = performance.now();
    let stopped = false;

    const frame = (now: number) => {
        if (stopped) return;
        const dt = Math.min((now - last) / 1000, 0.05);
        last = now;

        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, cssW, cssH);

        // ⚠️ 每帧只读一次包姿态：以前是**每片纸**读一次（240 次/帧），每读一次都在拼对象
        const pose = opts.getPose();
        let alive = 0;
        for (const b of bits) {
            if (b.age === undefined) continue;
            b.age += dt;
            if (b.age < 0) {
                alive += 1;
                continue;
            }

            if (b.inside) {
                // 在包里往上冲：只改"包内高度"，此时**不画**
                b.ly -= (b.up * dt) / pose.ph * 100;
                b.r += b.spin * dt;
                if (b.ly > opts.tearYAt(b.lx)) {
                    alive += 1;
                    continue;
                }
                const [x, y, z] = onStage(pose, b.lx, b.ly, b.lz);
                b.x = x;
                b.y = y;
                b.z = z;
                b.inside = false;
                b.age = 0;
                b.r0 = b.r;
                b.vx = Math.sin(b.a) * b.sp;
                b.vy = -Math.cos(b.a) * b.sp;
                b.vz = rand(0, 160);
            }

            b.z += b.vz * dt;
            b.vy += GRAVITY * dt;
            b.vx += (Math.sin(b.ph) * b.slip + b.glide) * dt;

            const v = Math.hypot(b.vx, b.vy);
            // 刚被吹出来时是一团，团里的纸挡不住风 ⇒ 阻力要等它散开才吃满
            const f = 1 / (1 + b.c * Math.min(1, 0.06 + b.age / 0.45) * v * dt);
            const turn = 0.35 + v / 800;
            b.vx *= f;
            b.vy *= f;
            b.x += b.vx * dt;
            b.y += b.vy * dt;
            b.r += b.spin * turn * dt;
            b.ph += 7 * turn * dt;

            if (b.y >= cssH / 2 + 40) continue;   // 落到底就没了

            const persp = PERSPECTIVE / (PERSPECTIVE - b.z);
            const k = persp * b.sc;
            const R = Math.PI / 180;
            const cr = Math.cos(b.r * R);
            const sr = Math.sin(b.r * R);
            // 翻过去的那一刻高度被压扁 —— 纸片翻面的错觉全靠这个
            const cq = Math.cos((b.r - b.r0) * 0.7 * R);
            ctx.setTransform(
                k * cr, k * sr,
                -k * sr * cq, k * cr * cq,
                ox + b.x * persp, oy + (cssH * 0.1 + b.y) * persp,
            );
            ctx.fillStyle = b.fill;
            ctx.fill(paths[b.kind]);
            alive += 1;
        }

        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        if (alive === 0) {
            stopped = true;
            ctx.clearRect(0, 0, cssW, cssH);
            return;
        }
        raf = requestAnimationFrame(frame);
    };

    raf = requestAnimationFrame(frame);

    return () => {
        stopped = true;
        cancelAnimationFrame(raf);
        ctx.clearRect(0, 0, cssW, cssH);
    };
}
