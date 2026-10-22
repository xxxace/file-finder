/**
 * 左轨的页定义 —— 单独放一个 `.ts`，因为 `<script setup>` **不允许**有 ES 导出
 * （`export type` 也会报错），而 Shell 与 RailNav 都要用同一个联合类型。
 *
 * 上面三个是"内容目的地"；设置放底部（B 站也是把设置压在最下面）。
 */
import { AlbumsOutline, HomeOutline, TimeOutline } from '@vicons/ionicons5';

export type RailKey = 'files' | 'playlists' | 'cache' | 'settings';

export const RAIL_ITEMS = [
    { key: 'files' as const, label: '文件', icon: HomeOutline },
    // 「缓存记录」= 按时间留下来的历史扫描清单（每行还带"什么时候扫的 / 在线还是离线"），
    // 用时钟比脚印贴切：这是"记录"，不是"足迹"。
    { key: 'cache' as const, label: '缓存记录', icon: TimeOutline },
    { key: 'playlists' as const, label: '收藏', icon: AlbumsOutline },
];

export const RAIL_PATHS: Record<RailKey, string> = {
    files: '/',
    playlists: '/playlists',
    cache: '/cache',
    settings: '/settings',
};
