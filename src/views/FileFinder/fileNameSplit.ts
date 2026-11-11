/**
 * 文件名「中间省略」切分 —— 头段可省略、尾段永不省略。
 *
 * ## 为什么需要它
 *
 * `text-overflow: ellipsis` 只从**尾部**切，而这一层几个文件名的前缀往往一模一样：
 * `TST-001A.mp4` / `TST-001B.mp4`、`…前編.mp4` / `…後編.mp4` —— 区分点**和扩展名
 * 都在尾部**。尾部省略 = 把唯一的区分点藏起来（`list.less` 里那条"必须折 3 行"的
 * 老约束就是为此写的）。
 *
 * ## 做法：零测量
 *
 * 切成 `head + tail` 两段，尾段固定为「扩展名 + 前 `TAIL_KEEP` 个字符」，
 * 由 CSS 给尾段 `flex: 0 0 auto`（永不收缩）、给头段 `text-overflow: ellipsis`。
 * **不量字符宽度、不等字体加载**：`Geist / MiSans VF` 换字体、缩放、DPR 变化都不会失准
 * （而"逐字符测量 + 预算分配"那套每次换字体都要重算，且字体没加载完时量出来是错的）。
 *
 * 宽度够时两段**首尾相接、中间没有省略号** ⇒ 视觉上就是一个完整文件名，不会平白多一个 `…`。
 *
 * ⚠️ 判据替换了老约束，不是绕过它：原来"折最多 3 行"是为了保住尾部区分点，
 *    中间省略正面解决了同一件事，并且顺带让行高稳定（不再由内容撑高）。
 */

/**
 * 尾段除扩展名外额外保留的字符数。
 * 3 够装 `A` / `B` / `CD1` / `前編` 这类分片标记，又不会吃掉头段。
 */
export const TAIL_KEEP = 3;

export interface NameParts {
    /** 可被省略号截断的前半段（可能为空串） */
    head: string;
    /** 扩展名 + 前 TAIL_KEEP 个字符，永不被截断（无扩展名时为空串） */
    tail: string;
}

/**
 * `TST-001B.mp4`      → head `TST-001`   tail `B.mp4`
 * `[TST-002]…前編.mp4` → head `[TST-002]…`  tail ` 前編.mp4`
 * `a.mp4`             → head ``          tail `a.mp4`
 * `README`            → head `README`    tail ``
 */
export function splitFileName(name: string): NameParts {
    // 用 lastIndexOf 而不是 `split('.').pop()`：`a.b.c.mp4` 的头段要保留前面那些点。
    const dot = name.lastIndexOf('.');
    // `dot <= 0`：没有扩展名，或 `.mp4` 这种隐藏文件（点在第 0 位）—— 整名当头段。
    if (dot <= 0) return { head: name, tail: '' };
    const stem = name.slice(0, dot);
    const keep = stem.slice(Math.max(0, stem.length - TAIL_KEEP));
    return { head: stem.slice(0, stem.length - keep.length), tail: keep + name.slice(dot) };
}
