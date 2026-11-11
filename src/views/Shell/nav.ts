/**
 * 左轨的页定义 —— 单独放一个 `.ts`，因为 `<script setup>` **不允许**有 ES 导出
 * （`export type` 也会报错），而 Shell 与 RailNav 都要用同一个联合类型。
 *
 * 上面三个是"内容目的地"；设置放底部（B 站也是把设置压在最下面）。
 */
import { BookmarkOutline, HomeOutline, TimeOutline } from '@vicons/ionicons5';

export type RailKey = 'files' | 'playlists' | 'cache' | 'settings';

export const RAIL_ITEMS = [
    { key: 'files' as const, label: '文件', icon: HomeOutline },
    // 「缓存记录」= 按时间留下来的历史扫描清单（每行还带"什么时候扫的 / 在线还是离线"），
    // 用时钟比脚印贴切：这是"记录"，不是"足迹"。
    { key: 'cache' as const, label: '缓存记录', icon: TimeOutline },
    /**
     * 「收藏」2026-11-11 从 `AlbumsOutline`（相册）换成 `BookmarkOutline`。
     *
     * 为什么：相册那颗是一个"扁矩形 + 顶部两条细线"（384×256 的框画在 512 画布中间偏下），
     * 20px 下墨迹散成上下两处、视觉重量远小于旁边 Home / Time（它们都填得满），
     * 白底上读起来像没画完 —— 业主原话「不好看，且容易与背景融合」。
     * 书签是一个**纵向长条**（288×464），填满画布高度、轮廓独一无二，
     * 小尺寸下不会糊成一团；而且它与 Playlists 页空态用的是同一个符号。
     */
    { key: 'playlists' as const, label: '收藏', icon: BookmarkOutline },
];

export const RAIL_PATHS: Record<RailKey, string> = {
    files: '/',
    playlists: '/playlists',
    cache: '/cache',
    settings: '/settings',
};
