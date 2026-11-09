/**
 * 浮层的**唯一投递口**：toast / confirm 都从这里进队列，由 `OverlayHost` 统一渲染。
 *
 * ⚠️ 为什么不用 naive 的 `useDialog` / `useNotification`：
 *   `.n-modal-mask{background:rgba(0,0,0,.4)}` 是**硬编码在 cssr 里**的，
 *   `themeOverrides` 根本没有这个键（见 `node_modules/naive-ui/es/modal/src/styles/index.cssr.mjs`）；
 *   而 Notification / Alert 连主题键都没接。⇒ 光"补样式"到不了「长相全归 tokens」。
 *   现在 naive 只管它的全屏工作区（两个 assistant modal），提示类浮层全部走这里。
 */
import { reactive } from 'vue';

export type OverlayKind = 'success' | 'info' | 'warning' | 'error';

export interface ToastItem {
    id: number;
    kind: OverlayKind;
    /** 主行。为空时正文独占一行（`notify('error', undefined, msg)` 这种旧写法要能落地）。 */
    title?: string;
    body: string;
}

export interface ConfirmOptions {
    title: string;
    content?: string;
    positiveText?: string;
    negativeText?: string;
    /** 点遮罩是否算取消。破坏性操作（删除 / 还原）必须传 false。 */
    maskClosable?: boolean;
    /** 返回 Promise 时宿主会把按钮切成 pending —— 「点完看不出反应」的按钮比没有按钮更糟。 */
    onPositiveClick?: () => void | Promise<void>;
}

export interface ConfirmItem extends ConfirmOptions {
    id: number;
}

export const overlayState = reactive({
    toasts: [] as ToastItem[],
    /** **串行**队列：宿主只渲染 `[0]`。并发弹两个确认框，第二个会盖掉第一个的 Promise。 */
    confirms: [] as ConfirmItem[],
});

let seq = 0;

export function pushToast(kind: OverlayKind, title: string | undefined, body: string): number {
    const id = ++seq;
    overlayState.toasts.push({ id, kind, title, body });
    return id;
}

export function removeToast(id: number): void {
    const i = overlayState.toasts.findIndex(t => t.id === id);
    if (i >= 0) overlayState.toasts.splice(i, 1);
}

export function pushConfirm(opts: ConfirmOptions): void {
    overlayState.confirms.push({ ...opts, id: ++seq });
}

export function popConfirm(): void {
    overlayState.confirms.shift();
}
