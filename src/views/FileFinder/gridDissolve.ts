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

const cancelCurrent = () => {
    current?.cancel();
    current = null;
};

/** `200ms` → `200`；读到 `calc(...)` 之类解析不出的东西就用兜底值 */
const readMs = (raw: string, fallback: number): number => {
    const n = Number.parseFloat(raw);
    return Number.isFinite(n) ? n : fallback;
};

/**
 * 换屏请求发出时，让旧内容先轻柔退场（不阻塞数据请求，也不提前归零滚动）。
 *
 * 与 `dissolveGrid` 配对：新数据落地后 `dissolveGrid` 会接管并把透明度淡回 1；
 * 若请求失败且保留旧列表（未触发 `dataSource` 变更），调用方需补调 `dissolveGrid` 恢复可见。
 *
 * ⚠️ 必须纯走 WAAPI、绝不改 `el.style.opacity`：`.image-box` 上有给扫描模糊态准备的
 *    `transition: opacity 420ms ease`，写 inline opacity 会触发 CSS 过渡导致闪屏。
 */
export const fadeOutGrid = (el: HTMLElement | null): void => {
    if (!el) return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;

    cancelCurrent();
    const cs = getComputedStyle(el);
    const duration = readMs(cs.getPropertyValue('--ff-dur-exit'), 90);
    const easing = cs.getPropertyValue('--ff-ease-exit').trim() || 'ease-out';
    current = el.animate([{ opacity: 1 }, { opacity: 0 }], { duration, easing, fill: 'forwards' });
};

/**
 * 让 `el` 从全透明平滑淡到不透明。
 *
 * 用纯 WAAPI 的前段保持帧（`offset: 0 → 0.08` 约 1 帧维持 `opacity: 0`）避开 `v-for`
 * 批量挂载与首次排版的主线程尖峰，再用柔和的 ease-out 曲线淡入；不写 `el.style.opacity`，
 * 避免触发 `.image-box` 自身的 `transition: opacity 420ms ease` 造成首帧闪烁。
 *
 * @param el 网格滚动容器（`.image-box`）；还没挂载就传 `null`，这里静默跳过。
 */
export const dissolveGrid = (el: HTMLElement | null): void => {
    if (!el) return;
    cancelCurrent();
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;

    const cs = getComputedStyle(el);
    const duration = readMs(cs.getPropertyValue('--ff-dur-move'), 200);
    // 透明度淡入用柔和的 quad ease-out（--ff-ease-size），避免 --ff-ease-move 起步过冲导致"闪一下"
    const easing = cs.getPropertyValue('--ff-ease-size').trim() || 'ease-out';
    current = el.animate(
        [
            { opacity: 0, transform: 'translateY(6px)', offset: 0 },
            { opacity: 0, transform: 'translateY(6px)', offset: 0.08 },
            { opacity: 1, transform: 'translateY(0)', offset: 1 },
        ],
        { duration, easing, fill: 'backwards' },
    );
};
