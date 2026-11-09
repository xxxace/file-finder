/**
 * 提示胶囊的统一出口（6 个页面在用）。
 *
 * ⚠️ 前台签名仍是 `(type, 主行, 次行)`：换实现不该让调用方跟着改。
 *   原来的 `duration: 2500` / `keepAliveOnHover` 已收进 `OverlayHost` ——
 *   这里再写一遍就是两个真相源。
 * ⚠️ 第 4 个参数 `opts.silent` 是**给"这件事自己已经有声音"的场合**用的
 *   （插拔盘：Plug/Unplug 已经响过，toast 再叠一条 Nudge 就是一次动作两个音）。
 */
import { pushToast } from '@/components/Overlay/store';
import type { OverlayKind } from '@/components/Overlay/store';
import { playSfx } from '@/utils/sfx';

export default function useNotify() {
    return function (type: OverlayKind, title?: string, message?: string, opts?: { silent?: boolean }): void {
        // toast 的唯一出口 ⇒ 音效也只在这里挂一次，6 个页面自动全覆盖。
        // ⚠️ 三档音色按**官方语义**分开（不是同一条音压不同音量）：
        //    success = Bloom（成功完成）、warning = Nudge（注意一下）、error = Shrug（没成）。
        //    warning 与 error 原本共用 Nudge，但官方 Nudge 是"引起注意"，"失败"该用 Shrug。
        if (!opts?.silent) {
            if (type === 'success') playSfx('success');
            else if (type === 'warning') playSfx('warn');
            else if (type === 'error') playSfx('fail');
        }
        pushToast(type, title, message ?? '');
    };
}
