/**
 * 弹簧 —— SwiftUI 的 `(response, bounce)` 映射。
 *
 * ## 为什么必须自己算，不能用 CSS 缓动
 *
 * `transition` / `cubic-bezier` 描述的是「从 A 插值到 B」，它**没有速度这个状态**。
 * 于是三件事做不到：
 *   ① 过冲回弹（`bounce`）—— 物体被拉到位后会弹过头再回来；
 *   ② 中途被打断后带着**残余速度**继续走（鼠标一扫、手一松就换方向）；
 *   ③ 由一个物体的运动**撞出**另一个物体的运动（撕一下就让整包抖）。
 *
 * 这三件事正是抽卡页观感的全部来源（参考站 `app.js` 的 `Spring` 类就是这个用途）。
 *
 * ## 参数怎么读
 *
 * `response` = 大致多久稳定下来（秒，越小越硬）；`bounce` = 0~1 的回弹幅度。
 * 参考站的实际取值可以照着用：包装跟随鼠标 `.7/.28`、卡片的坐标 `.55/.22`、
 * 撕条展开 `.28/.35`、光流生长 `.4/.3`。
 */
export class Spring {
    x: number;
    to: number;
    v = 0;
    /** 刚度（构造时由 `set()` 写入；给初值只是为了让 TS 的严格空检查满意） */
    k = 0;
    /** 阻尼 */
    c = 0;

    constructor(x = 0, response = 0.5, bounce = 0) {
        this.x = x;
        this.to = x;
        this.set(response, bounce);
    }

    /** 换手感（同一个弹簧可以中途改软硬，参考站在"抓起来"时会调） */
    set(response: number, bounce = 0): this {
        this.k = (2 * Math.PI / response) ** 2;
        this.c = (4 * Math.PI * (1 - bounce)) / response;
        return this;
    }

    step(h: number): void {
        this.v += (this.k * (this.to - this.x) - this.c * this.v) * h;
        this.x += this.v * h;
    }

    /** 直接落到目标并清零速度（重置用，别拿它代替动画） */
    snap(to = this.to): void {
        this.to = to;
        this.x = to;
        this.v = 0;
    }
}

/** 一组同手感的弹簧（`pose({ x: 0, y: 0 }, .7, .28)`） */
export type Springs<T extends Record<string, number>> = { [K in keyof T]: Spring };

export function pose<T extends Record<string, number>>(from: T, response: number, bounce = 0): Springs<T> {
    const out = {} as Springs<T>;
    for (const key in from) out[key] = new Spring(from[key], response, bounce);
    return out;
}

export function values<T extends Record<string, number>>(springs: Springs<T>): Spring[] {
    return Object.values(springs) as Spring[];
}

/**
 * 子步进。
 *
 * ⚠️ 不是可选项：刚度大的弹簧（`response` 0.1~0.3 那些）在 60fps 下单步会**发散**
 * —— 数值直接飞出去，表现为元素瞬间消失。按 240Hz 切成小步，低帧率下也稳。
 * 参考站同一行：`n = Math.ceil(dt * 240)`。
 */
export function stepAll(springs: readonly Spring[], dt: number, hz = 240): void {
    if (dt <= 0) return;
    const n = Math.ceil(dt * hz);
    const h = dt / n;
    for (let i = 0; i < n; i += 1) {
        for (let j = 0; j < springs.length; j += 1) springs[j].step(h);
    }
}

/** 好用的预置手感（不要在各处硬编码数字） */
export const FEEL = {
    /** 跟随鼠标的倾斜：软，稍微回弹 */
    pointer: [0.7, 0.28] as const,
    /** 卡片坐标：比鼠标硬一点，回弹小 */
    card: [0.55, 0.22] as const,
    /** 撕条展开：很快 */
    tear: [0.28, 0.35] as const,
    /** 光流生长 */
    glow: [0.4, 0.3] as const,
} as const;
