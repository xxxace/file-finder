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
        // toast 的唯一出口 ⇒ 音效也只在这里挂一次，6 个页面自动全覆盖。
        // ⚠️ warning/error 也响（主人 2026-11-09 确认：用户动作的失败必须有反馈）——
        //    这类 toast 全是离散低频的用户动作失败（文件失效/盘不在/表单校验），
        //    与扫描的批量 result toast（走 success 分支）不冲突。
        if (type === 'success') playSfx('success');
        else if (type === 'warning' || type === 'error') playSfx('warn');
        pushToast(type, title, message ?? '');
    };
}
