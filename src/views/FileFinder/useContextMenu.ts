/**
 * 网格 / 空白的右键菜单 —— 状态、定位、全部菜单动作都在这里。
 *
 * 从 `index.vue` 抽出来的原因很简单：它有 6 个模板入口（复制名称/复制地址/打开文件夹/
 * 加入收藏/加入收藏夹…/从收藏夹移除）和 4 个状态字段，散在 4000 行里没人能一次看完。
 *
 * 与页面只通过 `deps` 交换数据（同 `usePreview` 的形状）：**这里不 import 页面**，
 * 页面决定怎么取名字、怎么重取当前屏。
 */
import { ref } from 'vue';
import { ipcRenderer } from 'electron';
import type { WiredFileInfo } from '../../../electron/server/index';
import type { CardSnapshot } from '../../../electron/server/playlist';
import type { OverlayKind } from '@/components/Overlay/store';
import {
    addToPlaylist, defaultPlaylist, playlistIndex, removeFromPlaylist,
} from './playlist';

export interface ContextMenuDeps {
    notify: (type: OverlayKind, title?: string, message?: string) => void;
    keyOf: (item: WiredFileInfo) => string;
    snapshotOf: (item: WiredFileInfo) => CardSnapshot;
    /** 带后缀的文件名（菜单里「复制文件名」用的是去后缀版，见 `copyNameStem`） */
    fileNameOf: (item: WiredFileInfo) => string;
    /** 完整磁盘路径（含当前盘符）；只读锚点没有真路径 */
    fullPathOf: (item: WiredFileInfo) => string;
    /** 当前屏是清单屏就给清单 id，否则空串 —— 决定菜单里出「移除」还是「加入」 */
    currentPlaylistId: () => string;
    /** 清单变更后重取当前屏（走页面唯一出口，不在这里本地摘条目） */
    reloadCurrent: () => void;
}

export function useContextMenu(deps: ContextMenuDeps) {
    /**
     * 右键上下文菜单状态。**独立一份**，不和"多文件封面弹层"那个 popover 混用 ——
     * 两者触发方式、内容、定位都不同，共用一个 ref 会在"先右击再双击"这类操作里串台。
     */
    const ctxMenu = ref<{
        visible: boolean;
        x: number;
        y: number;
        name: string;
        stem: string;
        /** card = 卡片右键（全部组）；blank = 空白右键（只有目录工具组） */
        mode: 'card' | 'blank';
        /** 右击的那张卡。「加入收藏 / 加入收藏夹…」的快照来源 */
        item: WiredFileInfo | null;
    }>({
        visible: false,
        x: 0,
        y: 0,
        name: '',
        stem: '',
        mode: 'card',
        item: null,
    });

    /** 「加入收藏夹…」选单（二级菜单，原地展开在同一坐标） */
    const plPicker = ref<{ visible: boolean; x: number; y: number; card: CardSnapshot | null; key: string }>(
        { visible: false, x: 0, y: 0, card: null, key: '' },
    );

    /** 关菜单并把焦点收回 body。⚠️ 必须主动 blur：v-show 关掉后按钮 display:none，
     *  但 activeElement 仍停在它上面 ⇒ 方向键失效且难排查。 */
    const closeCtxMenu = () => {
        ctxMenu.value.visible = false;
        (document.activeElement as HTMLElement | null)?.blur?.();
    };

    /** 卡片右键：全部组 */
    const onContextMenu = (e: MouseEvent, item: WiredFileInfo) => {
        ctxMenu.value.visible = true;
        ctxMenu.value.x = e.clientX;
        ctxMenu.value.y = e.clientY;
        ctxMenu.value.name = deps.fileNameOf(item);
        ctxMenu.value.stem = item.name;
        ctxMenu.value.mode = 'card';
        ctxMenu.value.item = item;
    };

    /** 空白右键：只有目录工具组。卡片自己的右键会冒泡上来，用 closest 判掉。 */
    const onBlankContextMenu = (e: MouseEvent) => {
        if ((e.target as HTMLElement).closest('.image-box-item')) return;
        ctxMenu.value.visible = true;
        ctxMenu.value.x = e.clientX;
        ctxMenu.value.y = e.clientY;
        ctxMenu.value.mode = 'blank';
        ctxMenu.value.item = null;
    };

    /**
     * 菜单内按键：只有 Esc 有用。`@keydown.stop` 只保证事件不到 window，
     * 但方向键/回车在这个容器里按下去什么也不该发生 —— 显式吞掉是给将来加键盘导航留的入口。
     */
    const onCtxMenuKeydown = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
            closeCtxMenu();
            e.preventDefault();
        }
    };

    /** 「复制文件名」= **去后缀**版（贴到搜索框找片用；带 `.mp4` 搜不到）。主人 2026-11-09 裁定只留这一种。 */
    const copyNameStem = async () => {
        const stem = ctxMenu.value.stem;
        closeCtxMenu();
        if (!stem) return;
        const err = await ipcRenderer.invoke('copyText', stem);
        if (err) deps.notify('error', '复制失败', String(err));
        else deps.notify('success', '已复制文件名', stem);
    };

    /** 「复制文件地址」：完整磁盘路径。只读锚点没有真路径 ⇒ 模板里禁用。 */
    const copyPath = async () => {
        const item = ctxMenu.value.item;
        closeCtxMenu();
        if (!item) return;
        const full = deps.fullPathOf(item);
        const err = await ipcRenderer.invoke('copyText', full);
        if (err) deps.notify('error', '复制失败', String(err));
        else deps.notify('success', '已复制文件地址', full);
    };

    /** 「打开所在文件夹」：`showItemInFolder` 会选中它（比开目录多一层"指哪是哪"）。 */
    const revealInFolder = async () => {
        const item = ctxMenu.value.item;
        closeCtxMenu();
        if (!item) return;
        const err = await ipcRenderer.invoke('ff-reveal-item', deps.fullPathOf(item));
        if (err) deps.notify('error', '打开失败', String(err));
    };

    /** 「加入收藏」：一键入默认清单。高频路径，不为它多弹一层。 */
    const addToFavorite = async () => {
        const item = ctxMenu.value.item;
        closeCtxMenu();
        if (!item) return;
        const pl = defaultPlaylist(playlistIndex().playlists);
        if (!pl) {
            deps.notify('warning', '默认收藏夹还没就绪', '稍等一下再试');
            return;
        }
        // 已在里面就别再发请求（服务端也去重，这里只是省一次往返 + 给准确的话）
        if (pl.keys.includes(deps.keyOf(item))) {
            deps.notify('info', `已经在「${pl.name}」里了`, item.name);
            return;
        }
        try {
            await addToPlaylist(pl.id, deps.snapshotOf(item));
            deps.notify('success', `已加入「${pl.name}」`, item.name);
        } catch (e) {
            deps.notify('error', '加入失败', String(e));
        }
    };

    /** 「加入收藏夹…」：把二级选单摊在与一级菜单同一坐标（同 submenu 手势），然后收掉一级。 */
    const openPlPicker = () => {
        const item = ctxMenu.value.item;
        if (!item) return;
        plPicker.value = {
            visible: true,
            x: ctxMenu.value.x,
            y: ctxMenu.value.y,
            card: deps.snapshotOf(item),
            key: deps.keyOf(item),
        };
        closeCtxMenu();
    };

    const onPickerAdded = (name: string) => {
        plPicker.value.visible = false;
        deps.notify('success', `已加入「${name}」`);
    };

    const onPickerFailed = (msg: string) => {
        plPicker.value.visible = false;
        deps.notify('error', '加入失败', msg);
    };

    /** 清单屏右键「从收藏夹移除」。只动清单（系统盘 JSON），不碰盘、不碰文件。 */
    const removeFromCurrentPlaylist = async () => {
        const item = ctxMenu.value.item;
        const plId = deps.currentPlaylistId();
        closeCtxMenu();
        if (!item || !plId) return;
        try {
            await removeFromPlaylist(plId, deps.keyOf(item));
            deps.reloadCurrent();
        } catch (e) {
            deps.notify('error', '移除失败', String(e));
        }
    };

    return {
        ctxMenu, plPicker,
        onContextMenu, onBlankContextMenu, onCtxMenuKeydown, closeCtxMenu,
        copyNameStem, copyPath, revealInFolder,
        addToFavorite, openPlPicker, onPickerAdded, onPickerFailed,
        removeFromCurrentPlaylist,
    };
}
