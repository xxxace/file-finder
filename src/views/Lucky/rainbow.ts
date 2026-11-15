/**
 * 彩虹七色 —— 从 `tokens.css` 读出来。
 *
 * 为什么不直接写在这里：渲染层的 TS 里不许出现色值字面量（护栏探针会抓）。
 * 这七个颜色是"光"（棱镜色散），属于物料而不是界面配色，所以归宿是
 * `tokens.css` 的 L2 物料段；TS 只负责读。
 *
 * 缓存一次：`getComputedStyle` 会强制样式解析，而光流与纸屑每帧都可能要它。
 */
let cache: string[] | null = null;

export function rainbow(): string[] {
    if (cache) return cache;
    const cs = getComputedStyle(document.documentElement);
    cache = Array.from({ length: 7 }, (_, i) => cs.getPropertyValue(`--ff-rainbow-${i + 1}`).trim())
        .filter(Boolean);
    if (!cache.length) cache = ['currentColor'];
    return cache;
}
