/**
 * 缩略图的内存索引。
 *
 * 为什么需要它：缩略图以 base64 存在 nedb 里（保证"之后浏览不再碰移动硬盘"），
 * 但渲染层不能拿到这坨 base64（否则 payload 又回到几百 KB）。
 * 所以给每个缩略图一个短 key，渲染层只拿 key，图片走 `/thumb?k=<key>` 按需取。
 * 请求 /thumb 时才 Buffer.from(base64) 解一次（几十 KB 级，可忽略）。
 *
 * ⚠️ **这里的内存不是零开销，这个 Map 本身就是这些字符串活着的唯一原因。**
 * 原先这里写的是「内存开销为零：Map 里存的是 nedb 文档里那个字符串的的引用，不是副本」——
 * "引用不是副本"那半句对，但结论是错的：正因为它**强引用**住了那个字符串，
 * 那个字符串才不能被回收（请求返回后 doc 本可被 GC，是 Map 把它留住了）。
 *
 * 量级（实测）：单张 480px 缩略图的 base64 平均约 **47 KB**。
 * - 缓存命中时 key 不变 → `Map.set` 同键不增长 ✓
 * - 但**重扫（F5 / noCache）会产生全新 key**（`newThumbKey` 用 `Date.now()` + 随机数），
 *   旧 key 永久留在 Map 里 —— `removeCache` 只删磁盘上的 nedb 记录，**不碰这个 Map**。
 * - 本文件**没有任何 `delete` / `clear` / 上限**，所以这个 Map 只增不减。
 *
 * 目前不加上限是**有意的取舍**（三条修法各有真代价，见 docs/AUDIT-2026-09-24.md 第七节）：
 * 改成稳定 key 会让"换了同名封面图之后界面不刷新"；换 LRU 会让 `<n-image :lazy>`
 * 尚未取过图的 key 在滚动时 404 变白图；改成按 key 反查 nedb 则要给嵌在数组里的 key 建索引。
 * 现在的库只有几 MB、缩略图不到 100 张（≈5 MB），离危险很远 —— 等它真的成为问题再动。
 */

/** key → 'data:image/jpeg;base64,...' */
const store = new Map<string, string>();

/**
 * 生成缩略图 key。
 *
 * **必须把序列号算进去**：移动硬盘 A 和 B 可能先后挂在同一个盘符上，
 * 如果 key 只由路径决定，A 的 H:/x/a.jpg 和 B 的 H:/x/a.jpg 会撞成同一个 key，
 * 结果是插上 B 却看到 A 的封面 —— 也就是你说的"双方数据冲突"。
 * 带上序列号后 A 和 B 的 key 天然不同。
 */
export function newThumbKey(serial: string): string {
    return `${serial.slice(0, 4)}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function putThumb(key: string, dataUri: string): void {
    if (key && dataUri) store.set(key, dataUri);
}

export function getThumb(key: string): string | undefined {
    return store.get(key);
}

/**
 * 渲染层拿到的条目里，缩略图只保留 `thumb`（key），
 * `thumbData` / `avatarThumbData` 这两个内部字段必须剥掉。
 *
 * 返回类型写成 `Omit<...>` 而不是 `T`：剥完之后它本来就不是同一个东西了，
 * 写成 `T` 是让类型撒谎（调用方会以为那两坨 base64 还在）。
 * 顺带也就不需要 `Record<string, any>` 那个约束了 —— interface 没有隐式索引签名，
 * 硬套 `Record<string, any>` 反而会把结构化类型卡住。
 */
export function stripThumbData<T extends { thumbData?: string; avatarThumbData?: string }>(
    item: T
): Omit<T, 'thumbData' | 'avatarThumbData'> {
    const { thumbData, avatarThumbData, ...rest } = item;
    return rest;
}
