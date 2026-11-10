/**
 * 光标标记 —— 把"哪一格是光标"从**模板状态**改成**命令式 DOM 标记**（2026-11-10）。
 *
 * ## 为什么改
 *
 * 环本身不贵：`outline` 不参与布局与命中测试，`transform: scale` 走合成。
 * 贵的是**位置从哪来** —— 原来模板里写着 `cursor: cursorKey === keyOf(item)`，
 * 于是**每按一次方向键**，整个 `v-for` 作用域都要重建一遍 vnode、逐条求值 `v-memo`
 * 的依赖数组（N 条 × 3 次 `keyOf` + 2 次集合查询）；平铺几千格时那是每键 1–3ms 的
 * 纯开销，而屏幕上其实只动了**两张**卡。
 * ⇒ 标记移到 DOM 后，模板不再读 `cursorKey`，方向键**不再触发整屏重渲染**。
 *
 * ## 为什么是 `data-*` 而不是 `classList`
 *
 * `class` 是 Vue 自己管的属性：卡片下次 patch 时，Vue 会用模板算出的 class **整个覆盖**，
 * 手工加的 `cursor` 类会**静默消失**（这就是很多"环偶尔不见"的来历）。
 * `data-*` 不在 Vue 的 patch 范围里，patch 完仍在。
 * ⚠️ 但元素被**重建**时标记当然也随元素一起没了 ⇒ 由 `refresh()` 在"列表换了"的时机补打。
 *
 * ## 只做一件事
 *
 * 只负责"谁是光标"的**呈现**：打标 / 摘标。不滚屏、不闪烁、不读 `fileList` ——
 * 那些归 `useGridCursor`。所以这里没有第二个状态，也不会和 `cursorKey` 打架。
 */

/** 标记属性。CSS 侧一律写 `[data-cursor]`，别再写 `.cursor` */
const ATTR = 'data-cursor';
/** 卡片上的身份属性（与模板的 `:data-key="keyOf(item)"` 同源） */
const KEY_ATTR = 'data-key';

export interface CursorMark {
    /** 把标记移到 `key` 那一格。幂等：目标没变就什么都不做 */
    apply(key: string): void;
    /** 元素可能被整批重建过 ⇒ 丢掉"上一格"的记忆、重打一次 */
    refresh(key: string): void;
    /** 卸载时摘掉（`KeepAlive` 会把 DOM 留着，不摘就会带进下一次渲染） */
    dispose(): void;
}

/**
 * @param root 网格滚动容器（`.image-box`）。传**函数**而不是元素：容器要到挂载后才有。
 */
export function useCursorMark(root: () => HTMLElement | null): CursorMark {
    /** 上一次打标的那一格。缓存它，就不用每次 `querySelector('[data-cursor]')` 全表扫 */
    let last: HTMLElement | null = null;

    const find = (key: string): HTMLElement | null => {
        if (!key) return null;
        const box = root();
        if (!box) return null;
        // ⚠️ `CSS.escape` 必须：key 是"目录/名字"，含空格、中文、引号、反斜杠都可能
        return box.querySelector<HTMLElement>(`[${KEY_ATTR}="${CSS.escape(key)}"]`);
    };

    const apply = (key: string) => {
        const next = find(key);
        if (next === last) return;          // 没换格子 ⇒ 一次 DOM 写都不做
        last?.removeAttribute(ATTR);
        next?.setAttribute(ATTR, '');
        last = next;
    };

    return {
        apply,
        refresh: (key: string) => { last = null; apply(key); },
        dispose: () => { last?.removeAttribute(ATTR); last = null; },
    };
}
