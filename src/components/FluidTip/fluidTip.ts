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

export interface TipPayload {
    text: string;
    /** 真实存在的快捷键键帽（如 'S'）；没有就不显示键帽，**不许造假角标** */
    keys?: string;
}

export const tipState = reactive({
    visible: false,
    /** 首现 / 跳远：几何直接落位，别滑 */
    snap: true,
    text: '',
    keys: '',
    anchor: null as DOMRect | null,
});

let lastAnchor: DOMRect | null = null;
let hideTimer = 0;

const ADJACENT_PX = 160;
const LEAVE_DELAY = 75;

function isAdjacent(a: DOMRect, b: DOMRect): boolean {
    const dx = (a.left + a.right) / 2 - (b.left + b.right) / 2;
    const dy = (a.top + a.bottom) / 2 - (b.top + b.bottom) / 2;
    return Math.hypot(dx, dy) <= ADJACENT_PX;
}

export function showTip(el: HTMLElement, { text, keys }: TipPayload) {
    window.clearTimeout(hideTimer);
    hideTimer = 0;
    const rect = el.getBoundingClientRect();
    tipState.text = text;
    tipState.keys = keys ?? '';
    if (tipState.visible && lastAnchor && isAdjacent(lastAnchor, rect)) {
        tipState.snap = false; // 相邻：滑过去
    } else {
        tipState.snap = true; // 首现 / 跳远：落位淡入
    }
    tipState.anchor = rect;
    lastAnchor = rect;
    tipState.visible = true;
}

export function hideTip() {
    window.clearTimeout(hideTimer);
    // 缝隙缓冲：75ms 内又进另一个入口就当没离开过
    hideTimer = window.setTimeout(() => {
        hideTimer = 0;
        tipState.visible = false;
        lastAnchor = null;
    }, LEAVE_DELAY);
}
