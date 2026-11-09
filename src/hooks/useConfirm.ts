/**
 * 确认框的命令式出口。
 *
 * ⚠️ 形状刻意对齐 naive 的 `useDialog()`：三个调用点只换 import 来源，
 *   变量仍叫 `dialog`、`dialog.warning({...})` 一个字都不用改。
 *   真正干活的只有 `OverlayHost` 一处 —— 多个入口各自实现一份是补丁，
 *   宿主收口才是"以后新增同类场景不会复发"。
 */
import { pushConfirm } from '@/components/Overlay/store';
import type { ConfirmOptions } from '@/components/Overlay/store';

export default function useConfirm() {
    return {
        warning: (opts: ConfirmOptions): void => pushConfirm(opts),
    };
}
