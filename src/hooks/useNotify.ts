/**
 * 提示胶囊的统一出口（6 个页面在用）。
 *
 * ⚠️ 签名保持 `(type, 主行, 次行)` 不变：换实现不该让调用方跟着改。
 *   原来的 `duration: 2500` / `keepAliveOnHover` 已收进 `OverlayHost` ——
 *   这里再写一遍就是两个真相源。
 */
import { pushToast } from '@/components/Overlay/store';
import type { OverlayKind } from '@/components/Overlay/store';
import { playSfx } from '@/utils/sfx';

export default function useNotify() {
    return function (type: OverlayKind, title?: string, message?: string): void {
        // toast 的唯一出口 ⇒ 音效也只在这里挂一次，6 个页面自动全覆盖
        //（error 暂不配声：扫描里的偶发失败 toast 较多，等真机确认频率再定）
        if (type === 'success') playSfx('success');
        pushToast(type, title, message ?? '');
    };
}
