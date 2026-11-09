/**
 * Fluid Tip 的状态单例 —— 功能页 tooltip 的唯一真相源。
 *
 * 与左轨 RailTip 的分工（主人 2026-11-09 裁决）：RailTip 是左轨专属特色，**不动**；
 * 这里服务功能页（顶栏工具簇、表单、网格等 ~58 处原 n-tooltip）。
 *
 * 交互规则：
 *  - **同簇相邻**（上一个锚点还可见、两个锚点中心距 ≤ 160px）⇒ 胶囊从旧位置**滑**过去，
 *    同一颗节点形变（机制 1），文案在拍内交叉淡替；
 *  - **孤立触发** ⇒ snap：几何一步落位，只做淡入（RailTip 同款首现纪律）；
 *  - 离开 75ms 才收：指针扫过按钮间缝隙不闪（RailTip 同值）；
 *  - 触屏不显示（没有 hover 语义），交给按钮自己的 aria-label。
 */
import { reactive } from 'vue';
import type { VNodeChild } from 'vue';

export interface TipPayload {
    text: string;
    /** 真实存在的快捷键键帽（如 'S'）；没有就不显示键帽，**不许造假角标** */
    keys?: string;
    /**
     * 富内容（多行表格之类）：给了就整块替换正文，`text` 退化成无障碍/占位文案。
     *
     * ⚠️ 收的是**渲染函数**不是 HTML 字符串 —— 字符串要 `v-html`，等于给提示开一个注入口子。
     * ⚠️ 由调用方 `import { h }` 自己造节点：提示宿主只负责定位与材质，不认识业务结构。
     */
    body?: () => VNodeChild;
}

export const tipState = reactive({
    visible: false,
    /** 首现 / 跳远：几何直接落位，别滑 */
    snap: true,
    text: '',
    keys: '',
    body: null as (() => VNodeChild) | null,
    anchor: null as DOMRect | null,
    /** 锚点元素本体 —— 宿主每帧校验它的活性（isConnected / rect 漂移），见 FluidTipHost */
    anchorEl: null as HTMLElement | null,
});

let lastAnchor: DOMRect | null = null;
let hideTimer = 0;
/** 首现延迟：对齐 WarmTooltip 的"warm-up"思路（400ms 太温，取 150ms）。
 *  已可见时**不走延迟** —— 簇内滑动必须跟手，这正是 fluid 的意义。 */
let showTimer = 0;
let pending: { el: HTMLElement; payload: TipPayload } | null = null;

const ADJACENT_PX = 160;
const LEAVE_DELAY = 75;
const SHOW_DELAY = 150;

function isAdjacent(a: DOMRect, b: DOMRect): boolean {
    const dx = (a.left + a.right) / 2 - (b.left + b.right) / 2;
    const dy = (a.top + a.bottom) / 2 - (b.top + b.bottom) / 2;
    return Math.hypot(dx, dy) <= ADJACENT_PX;
}

function apply(el: HTMLElement, payload: TipPayload, adjacent: boolean) {
    const rect = el.getBoundingClientRect();
    tipState.text = payload.text;
    tipState.keys = payload.keys ?? '';
    tipState.body = payload.body ?? null;
    tipState.snap = !adjacent;
    tipState.anchor = rect;
    tipState.anchorEl = el;
    lastAnchor = rect;
    tipState.visible = true;
}

export function showTip(el: HTMLElement, payload: TipPayload) {
    window.clearTimeout(hideTimer);
    hideTimer = 0;
    if (tipState.visible && lastAnchor) {
        window.clearTimeout(showTimer);
        showTimer = 0;
        apply(el, payload, isAdjacent(lastAnchor, el.getBoundingClientRect()));
        return;
    }
    // 首现：等一拍再出现（leave 会取消它），扫过一大片内容时不会噼里啪啦闪
    pending = { el, payload };
    window.clearTimeout(showTimer);
    showTimer = window.setTimeout(() => {
        showTimer = 0;
        if (!pending) return;
        apply(pending.el, pending.payload, false);
        pending = null;
    }, SHOW_DELAY);
}

export function hideTip() {
    window.clearTimeout(hideTimer);
    window.clearTimeout(showTimer);
    showTimer = 0;
    pending = null;
    // 缝隙缓冲：75ms 内又进另一个入口就当没离开过
    hideTimer = window.setTimeout(() => {
        hideTimer = 0;
        tipState.visible = false;
        tipState.anchorEl = null;
        // 收掉时一并解开富内容的闭包：它闭着业务数据（盘列表之类），留着没有意义
        tipState.body = null;
        lastAnchor = null;
    }, LEAVE_DELAY);
}
