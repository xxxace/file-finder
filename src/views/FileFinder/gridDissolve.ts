/**
 * 整块内容被换掉时，让网格**淡进来**（做不到淡出去，见下）。
 *
 * 用在哪（2026-11-08）：换层铺卡片、切视图密度 —— 这两件事都是**一帧之内把整块内容换掉**，
 * 观感是硬切。淡出去没有意义：旧内容在同一帧就没了，没有可淡的东西；
 * 只能让新内容从 0 淡进来 —— 跳跃发生在"还看不见"的那一帧，读起来就是一次溶解。
 *
 * ## 为什么是 WAAPI，不是 CSS 类 / `<Transition>`
 *
 * - `.image-box` 是**滚动容器**，它的 DOM 节点身份不能换（换层要恢复 `scrollTop`，
 *   `useGridCursor` 也按这个节点量几何）⇒ 不能用 `:key` 重挂来触发入场动画。
 * - 用 CSS 类重放动画要"摘类 → 强制回流 → 加类"，那次强制回流正好落在换层最忙的一帧。
 * - 逐张卡片做（`<TransitionGroup>` 或每张一个 `animation`）是**明确否掉的**：
 *   一次换层是几百张同时进出，等于几百次 FLIP 测量 + 几百个合成层，
 *   而且筛选是**每个按键**都换一次内容 —— 那条路一定会卡。
 *
 * ## 边界（谁改了这里要注意）
 *
 * ⚠️ **只碰 `opacity`**，绝不碰 `transform` / `width` / `height`：
 * 这个容器上任何几何属性都会污染 `getBoundingClientRect`，而 `probeLayout` 分行、
 * 定位、滚动恢复全都要读它。
 * ⚠️ `prefers-reduced-motion` 直接不跑（不是跑到一半停）。
 *
 * 时长与曲线从 `tokens.css` 读，不在这里写字面量 —— 网格的入场必须和面包屑、状态条同一拍。
 */

/** 上一段动画：同一个元素上新的必须掐掉旧的，否则换层连点会叠成几次半透明叠加 */
let current: Animation | null = null;

/** `200ms` → `200`；读到 `calc(...)` 之类解析不出的东西就用兜底值 */
const readMs = (raw: string, fallback: number): number => {
    const n = Number.parseFloat(raw);
    return Number.isFinite(n) ? n : fallback;
};

/**
 * 让 `el` 从全透明淡到不透明。
 *
 * @param el 网格滚动容器（`.image-box`）；还没挂载就传 `null`，这里静默跳过。
 */
export const dissolveGrid = (el: HTMLElement | null): void => {
    if (!el) return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;

    const cs = getComputedStyle(el);
    const duration = readMs(cs.getPropertyValue('--ff-dur-move'), 200);
    // 自定义属性读不出值时给 'ease'：宁可曲线不对，也不要让整条动画失效
    const easing = cs.getPropertyValue('--ff-ease-move').trim() || 'ease';

    current?.cancel();
    // 实测（`docs/probes/grid-dissolve/`）：`flush: 'post'` 的回调跑完、任何帧被画出之前，
    // 这个元素的透明度已经是 0（动画一创建就进入 current，不是 pending）。
    // `fill: 'backwards'` 因此**当前不是必需项** —— 留着是为了把"未开始期间显示什么"钉死成
    // 首帧（0）而不是自然值（1）；哪天改成带 delay 或用 `requestIdleCallback` 起跑，它就变成必需。
    current = el.animate([{ opacity: 0 }, { opacity: 1 }], { duration, easing, fill: 'backwards' });
};
