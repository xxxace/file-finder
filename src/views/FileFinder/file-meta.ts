/**
 * 条目元信息 → URL / 身份标识。**纯函数，不碰组件状态**。
 *
 * 抽出来的理由：这几个在模板里是**每条目每次全量渲染**都要算一遍的（换屏、逐字过滤），
 * 和页面编排混在一个文件里既看不清调用频次、也没法单独验。
 */
import { API_BASE, apiUrl } from '@/utils/request';
import { ANCHOR_PREFIX } from '@/utils';
import folderIcon from '@/assets/fileTypeIcon/folder.png';
import type { WiredFileInfo } from '../../../electron/server/index';

/** 缩略图 URL 的实现在 `@/utils/thumb`（Playlists / Tunnel 共用），这里转出保持调用点不变 */
import { thumbUrl } from '@/utils/thumb';
export { thumbUrl };

/**
 * 只读锚点（离线缓存层）的路径前缀 —— 它不是磁盘上的真实路径。
 * `#` 开头的一律不读盘，服务端只查内存 Map。
 */
export const isReadOnlyPath = (path: string) => path.startsWith(ANCHOR_PREFIX);

/**
 * 条目的真实文件名。
 *
 * `item.name` 是**显示名** —— 封面条目取的是封面图文件名（不含扩展名），目录取目录名。
 * 所以还原磁盘上的名字必须带上 ext；而 ext 可能为空（没有扩展名的文件、目录），
 * 那就不能再补那个点，否则 "README" 会变成 "README."。
 */
export const fileNameOf = (item: WiredFileInfo) => (item.ext ? `${item.name}.${item.ext}` : item.name);

/** 条目在磁盘上的完整路径。dir 是服务端补过当前盘符的完整目录 */
export const fullPathOf = (item: WiredFileInfo) => `${item.dir}/${fileNameOf(item)}`;

/**
 * 预览大图的地址。
 *
 * 服务端 `/preview` 有三种情形：本地已有 → 直接给（0 读盘）；没有但给了源路径 `p` →
 * **读一次原图、生成、落盘**；都没有 → 404。所以只在**该给 `p` 的时候**给：
 *   · 视频**永远不给** —— 它的"图"是抽帧且扫描时就生成好了；给 `p` 等于让浏览器
 *     GET 一个 5–7GB 的原片（第一目标严禁）。
 *   · 离线（只读层）不给 —— 地址是锚点，服务端读不了，给了只会白跑一次。
 */
export const previewUrlOf = (item: WiredFileInfo) => {
    if (!item.preview) return '';
    const q = `k=${encodeURIComponent(item.preview)}`;
    // ⚠️ 2026-10-21 从屏幕级 `readOnlyLevel` 改成**条目级**：清单详情屏是在线/离线**混合屏**
    //（每条目的盘在不在各自独立），屏幕级判据会把在线条目的图也当成"生成不了"。
    // 在原有两类屏幕上两者等价 ⇒ 行为不变。
    const canBuild = !item.previewReady && item.type === 'image' && !isReadOnlyPath(item.dir);
    return apiUrl(`${API_BASE}/preview?${q}${canBuild ? `&p=${encodeURIComponent(fullPathOf(item))}` : ''}`);
};

/**
 * 条目的身份。与网格那一格的 `:key`、`:data-key`、预览序列**同源** ——
 * 「定位」就是靠它把预览里的这一条对回网格里的那一格。
 * `dir` 是条目**自己所在**的目录（封面条目取的是那个子目录）
 * ⇒ (dir, name) 唯一，同一层的两个子目录各有一张同名封面也不会撞。
 */
export const keyOf = (item: WiredFileInfo) => `${item.dir}/${item.name}`;

/**
 * 预览层**立刻**显示的那张 —— 与网格里那张卡片逐条同一规则（"卡片的大图版"）：
 *   图片 / 视频 → 它自己的缩略图；目录 → 它的脸，没有脸就是文件夹图标。
 * 这些都是**本地已有**的图 ⇒ 打开是瞬时的、零读盘。
 */
export const displaySrcOf = (item: WiredFileInfo) => {
    if (item.type === 'folder') return item.avatar ? thumbUrl(item.avatar) : folderIcon;
    return thumbUrl(item.thumb);
};
