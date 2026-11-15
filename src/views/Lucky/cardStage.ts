/**
 * 卡片编排 —— 移植自 `holo-reverse/src/app.js` 的 `fan / unwind / orbit / spawn`。
 *
 * ## 它到底演了什么（这是"转一圈"的全部）
 *
 * 1. **射出**（`shot`）：五张卡从包里**竖直向上**弹出去，初速 `-1250~-1450 × ph/420`，
 *    受包壁引导。每张比前一张晚 22ms —— 所以能看见"一叠牌被顶出来"而不是五张同时飞。
 * 2. **螺旋**（`orbit`，1.25 秒）：绕屏幕中心转 **2.5 圈**（`(1-turn)·(even − end + 2.5π)`），
 *    半径 `min(vw·.33, 430)`；同时三轴旋转、`z` 有 ±300 的进出。`turn = 1−(1−u)²`
 *    让转速前快后慢，`ring = sin(…)·(1−out)` 让螺旋半径先张开再收——收了才落得下去。
 * 3. **落位**（`fan`）：宽屏一字排开（每档旋转 2°、位移走抛物线）；
 *    窄屏叠成手牌（重叠、每张露出名字）；竖屏 2-1-2 散落。
 * 4. **静置**：每张按自己的相位缓慢摇摆（`cos(w·.9)·4` / `sin(w)·8`），不是死摆着。
 *
 * 全部是纯函数，`docs/probes/lucky-draw/` 可以直接断言。
 */

export const ORBIT = 1.25;

export function clamp(v: number, a: number, b: number): number {
    return Math.min(b, Math.max(a, v));
}

/** 平滑阶跃（smoothstep） */
export function ease(a: number, b: number, x: number): number {
    const k = clamp((x - a) / (b - a), 0, 1);
    return k * k * (3 - 2 * k);
}

export interface FanSpot {
    x: number;
    y: number;
    z: number;
    rz: number;
    /** 缩放：卡片被缩到能排下的尺寸 */
    s: number;
}

/**
 * 落位点。
 *
 * @param slot 0~n-1（**不是**洗牌后的 i —— slot 决定它在整排里的位置）
 */
export function fanSpot(slot: number, n: number, cw: number, vw: number, vh: number): FanSpot {
    const m = slot - (n - 1) / 2;

    // 竖屏：高度有余、宽度不够 ⇒ 2-1-2 像撒在桌上
    if (vh > vw * 1.15) {
        const w = Math.min((vw - 34) / 2, (vh - 150) / 2.72 / 1.4, cw);
        const [X, Y, rz] = [
            [-1, -1, -4], [1, -1, 4], [0, 0, 0], [-1, 1, 3], [1, 1, -3],
        ][slot] ?? [0, 0, 0];
        return { x: X * (w / 2 + 5), y: -15 + Y * w * 1.4 * 0.86, z: X || Y ? 0 : 40, rz, s: w / cw };
    }

    // 宽屏：能分开就分开，分不开就叠成手牌
    const s = clamp((vw - 48) / (cw * (1 + (n - 1) * 1.08)), 0.6, 1);
    const w = cw * s;
    const side = Math.min(w * 1.08, (vw - 40 - w) / (n - 1));
    const tight = side < w;
    const ends = (n - 1) / 2;
    const lean = (ends * 7 * Math.PI) / 180;
    // 边卡是斜着且离你更近的，它的角比宽度伸得更远 ⇒ 扇形要往里收，否则出屏
    const near = 1400 / (1400 - ends * 40);
    const gap = tight
        ? Math.max(6, Math.min(side, (vw / 2 - 8 - (w / 2 * Math.cos(lean) + w * 0.7 * Math.sin(lean)) * near) / (ends * near)))
        : side;

    return {
        x: m * gap,
        y: -vh * 0.03 + m * m * (tight ? 9 : 5) * s,
        z: tight ? m * 40 : 0,
        rz: m * (tight ? 7 : 2),
        s,
    };
}

/** 螺旋阶段的起点（每张卡各一份） */
export interface OrbitPlan {
    from: number;
    x0: number;
    y0: number;
    vy: number;
    rz0: number;
    even: number;
    end: number;
    s: number;
    f: FanSpot;
}

export function planOrbit(
    slot: number, i: number, n: number, t: number,
    from: { x: number; y: number; vy: number; rz: number },
    f: FanSpot,
): OrbitPlan {
    return {
        from: t + i * 0.03,
        x0: from.x,
        y0: from.y,
        vy: from.vy,
        rz0: from.rz,
        even: (-slot * 2 * Math.PI) / n,
        end: Math.PI / 2 - (slot - (n - 1) / 2) * 0.55,
        s: f.s,
        f,
    };
}

export interface OrbitFrame {
    x: number;
    y: number;
    z: number;
    rx: number;
    ry: number;
    rz: number;
}

/**
 * 螺旋中的一帧。
 *
 * 三处参数是效果的命门，动之前先想清楚：
 *   · `2.5π` = 转的圈数（少一圈就变成"绕过去"，不是"转一圈"）；
 *   · `turn = 1−(1−u)²` = 先快后慢（线性转看起来像机械臂）；
 *   · `ring` 里乘 `(1−out)` = 半径在最后 48% 里收掉，否则卡落不回排上。
 */
export function orbitAt(p: OrbitPlan, t: number, vw: number, vh: number): OrbitFrame {
    const u = clamp((t - p.from) / ORBIT, 0, 1);
    const turn = 1 - (1 - u) ** 2;
    const out = ease(0.52, 1, u);
    const ring = Math.sin(Math.min(1, u / 0.42) * Math.PI / 2) * (1 - out);
    const a = p.end + (1 - turn) * (p.even - p.end + Math.PI * 2.5);
    const W = Math.min(vw * 0.33, 430);
    const mid = p.y0 + (p.vy / 9) * (1 - Math.exp(-9 * Math.max(0, t - p.from)));
    const cy = mid + (-vh * 0.03 - mid) * ease(0, 0.42, u);
    const cos = Math.cos(a);
    const sin = Math.sin(a);

    return {
        x: p.x0 * (1 - out) + p.f.x * out + cos * W * ring,
        y: cy * (1 - out) + p.f.y * out + sin * W * 0.2 * ring,
        z: p.f.z * out + sin * 300 * ring,
        rz: p.rz0 * (1 - out) + p.f.rz * out - cos * 8 * ring,
        ry: -cos * 26 * ring,
        rx: 7 * ring,
    };
}
