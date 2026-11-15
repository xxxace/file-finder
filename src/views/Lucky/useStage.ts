/**
 * 逐帧舞台 —— 一个 `requestAnimationFrame` 循环，负责把时间喂给所有动画对象。
 *
 * ## 为什么要有它（与 `spring.ts` 同一条理由）
 *
 * 一次爆开里，包装、撕条、光流、5 张卡、240 片彩带**必须共享同一个 `t` 与同一个 `dt`**。
 * 各自起 `setTimeout` / `transition` 时间轴，就会：撕条还差 3 帧、卡片已经飞了、
 * 彩带早了 40ms —— 观感上就是"不齐"，而且调不回来。
 *
 * ## 三条纪律
 *
 * ① **`dt` 必须夹到 0.05**：切到后台再回来，`dt` 会是好几秒，弹簧会一步飞出去。
 * ② **`prefers-reduced-motion` 时 `dt = 0`**：物理不跑，但循环仍在，调用方据此把元素
 *    直接摆到终态（不是"不渲染"，是"不运动"）。
 * ③ **必须能停**：外壳是 KeepAlive，切页不卸载组件 —— 不停就是后台一直跑 rAF。
 *    `onDeactivated` / `onBeforeUnmount` 已接好，调用方只管 `start()`。
 */
import { onBeforeUnmount, onDeactivated } from 'vue';

export interface StageHandle {
    /** 开始（重复调用无害） */
    start: () => void;
    /** 停止（重复调用无害） */
    stop: () => void;
    readonly running: boolean;
    /** 用户要求减少动态效果 —— 调用方应跳过物理直接把元素摆到终态 */
    readonly reduce: boolean;
}

export function useStage(onFrame: (dt: number, t: number) => void): StageHandle {
    const reduce = typeof window !== 'undefined'
        && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    let raf = 0;
    let last = 0;
    let t = 0;
    let running = false;

    const loop = (now: number) => {
        if (!running) return;
        const raw = last ? (now - last) / 1000 : 0;
        last = now;
        const dt = reduce ? 0 : Math.min(0.05, raw);
        t += dt;
        onFrame(dt, t);
        raf = requestAnimationFrame(loop);
    };

    const start = () => {
        if (running) return;
        running = true;
        last = 0;
        raf = requestAnimationFrame(loop);
    };

    const stop = () => {
        running = false;
        if (raf) cancelAnimationFrame(raf);
        raf = 0;
    };

    onDeactivated(stop);
    onBeforeUnmount(stop);

    return {
        start,
        stop,
        get running() {
            return running;
        },
        reduce,
    };
}
