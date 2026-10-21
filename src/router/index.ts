/**
 * 一级页路由 —— 只有四个「目的地」：文件 / 清单 / 缓存 / 设置。
 *
 * ⚠️ **目录下钻不进路由**（`D:/videos/xxx` 不变成地址）。
 * 理由：文件页的「返回」有一套自己的语义 —— 返回要恢复**滚动位置 + 焦点格 + 搜索词**
 * （见 `index.vue` 的 `NavEntry`）。把它交给浏览器/路由历史，两个栈会互相抢：
 * 按 Backspace 到底退到哪一层、刷新后停在哪，都说不清。
 * 路由只管「我在哪个页」，页内的位置由页自己记。
 *
 * ⚠️ `createWebHashHistory`：打包后是 `file://` 协议，HTML5 history 模式在 file:// 下
 * 刷新会 404。hash 模式在两种环境下都一样。
 */
import { createRouter, createWebHashHistory } from 'vue-router';
import FilePage from '@/views/FileFinder/index.vue';
import PlaylistsPage from '@/views/Playlists/index.vue';
import CachePage from '@/views/Cache/index.vue';
import SettingsPage from '@/views/Settings/index.vue';

export const router = createRouter({
    history: createWebHashHistory(),
    routes: [
        { path: '/', name: 'files', component: FilePage },
        { path: '/playlists', name: 'playlists', component: PlaylistsPage },
        { path: '/cache', name: 'cache', component: CachePage },
        { path: '/settings', name: 'settings', component: SettingsPage },
        { path: '/:pathMatch(.*)*', redirect: '/' },
    ],
});
