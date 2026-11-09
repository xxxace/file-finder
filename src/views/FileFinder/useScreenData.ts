/**
 * 某一屏的取数（目录 / 清单）—— **三个取数入口**与请求序号。
 *
 * 为什么收在一起：取数调用点原有 6 个（进入 / 返回 / 刷新 / apply 后 / 扫描收尾 / 换盘降级），
 * 每个都要判"这屏是目录还是清单" ⇒ 6 处分支，漏一处的症状是"面包屑已切、网格还是旧内容"。
 * 收到 `loadScreen` 这一个出口之后，第 7 个入口也忘不掉。
 *
 * ⚠️ 请求序号只在这里写：过期响应不许写 dataSource、也不许关 loading，
 *    否则最新那次还在飞、转圈却停了。页面读它只走 `getFetchSeq()`。
 * ⚠️ dataSource / loading / failKind 三个 ref 由页面持有（界面到处在读它们），
 *    这里只负责写 —— 单一写入点仍然是本模块。
 */
import { useLoadingBar } from 'naive-ui';
import { API_BASE, ApiError, getAction } from '@/utils/request';
import type { OverlayKind } from '@/components/Overlay/store';
import type { OpenMode } from 'electron/server/nedb';
import type { WiredFileInfo } from '../../../electron/server/index';
import { getPlaylistItems } from './playlist';
import type { PlaylistDetail } from './playlist';

/** 与页面 `NavEntry` 同形（这里只读这三样，别把整个导航条目搬进来） */
export interface ScreenTarget {
    path: string;
    mode: OpenMode;
    pl?: { id: string };
}

export interface ScreenDataDeps {
    notify: (type: OverlayKind, title?: string, message?: string) => void;
    dataSource: { value: WiredFileInfo[] };
    loading: { value: boolean };
    failKind: { value: string };
    /** Flat 视图的两个开关：fetchFolder 会**写**它们（换到非根目录要自动复位） */
    isCurrentCacheRoot: { value: boolean };
    isFlatView: { value: boolean };
    canToggleFlat: { readonly value: boolean };
}

export function useScreenData(deps: ScreenDataDeps) {
    const loadingBar = useLoadingBar();

    /**
     * 能被横幅接住的失败分类。**新增一种失败时只改这一处** ——
     * 原来那个 `err.kind === 'offline' || err.kind === 'unreadable'` 的条件写在 fetchFolder 里，
     * 多一种分类就要在那儿再加一个 `||`（漏了就是"失败了却什么都不说"）。
     */
    const BANNER_KINDS = ['offline', 'unreadable', 'notCached', 'notFound'];
    /**
     * 请求序号：只有最新一次请求的响应能写进 dataSource。
     * ⚠️ 判断放在唯一写入点，别在各导航入口各补 loading 守卫 —— 新增入口会漏、全局锁还会冻住整个导航。
     */
    let fetchSeq = 0;

    const fetchFolder = (path: string, mode: OpenMode, noCache?: boolean, flat?: boolean) => {
        const seq = ++fetchSeq;
        deps.loading.value = true;
        deps.failKind.value = '';
        loadingBar.start();

        // 纯内存异步查询当前目录是否为缓存采集源头（顶层根目录），非根目录自动复位 Flat 状态
        getAction(`${API_BASE}/isCacheRoot?path=${encodeURIComponent(path)}`).then((res: { isRoot?: boolean }) => {
            if (seq !== fetchSeq) return;
            deps.isCurrentCacheRoot.value = !!res?.isRoot;
            if (!deps.isCurrentCacheRoot.value && deps.isFlatView.value) {
                deps.isFlatView.value = false;
            }
        }).catch(() => {
            if (seq !== fetchSeq) return;
            deps.isCurrentCacheRoot.value = false;
        });

        // path 必须编码：中文/空格/&/#/+ 会让 query 被截断或误解析
        let url = `${API_BASE}/openFolder?path=${encodeURIComponent(path)}&mode=${mode}`;
        if (noCache) url += '&noCache=true';
        const useFlat = flat ?? (deps.canToggleFlat.value && deps.isFlatView.value);
        if (useFlat) url += '&flat=true';

        // 必须 return：调用方要等数据真的落地才能做后面的事（恢复滚动位置）
        return getAction(url).then((data: WiredFileInfo[]) => {
            // 过期响应：已经不是最新那次请求了 —— 什么都不做。
            // `loadingBar` 的收尾也要跳过，否则它会替最新那次提前收尾
            if (seq !== fetchSeq) return;
            deps.dataSource.value = data;
            loadingBar.finish();
        }).catch(err => {
            if (seq !== fetchSeq) return;
            console.error('[openFolder] 请求失败:', err);
            // 只认服务端在 `BANNER_KINDS` 里明确给的那几种分类；其余（网络断、服务没起来、
            // 路径非法）统一算「其他失败」—— 不显示横幅，靠那条 toast 就够了
            deps.failKind.value = err instanceof ApiError && BANNER_KINDS.includes(err.kind)
                ? err.kind
                : 'other';
            loadingBar.error();
            if (deps.failKind.value === 'notFound') {
                deps.dataSource.value = [];
            }
            // 取数失败**必须说出来**：原来只有顶部进度条闪一下红，而 dataSource 会保留
            // 上一个目录的列表 —— 面包屑已经切到新目录、格子里却是旧内容，
            // 用户没有任何线索。这里不清空 dataSource（网络抖一下不该丢掉整个列表），
            // 所以那条提示是用户区分「这是新内容」和「这还是旧内容」的唯一依据。
            deps.notify('error', '打开失败', String(err));
        }).finally(() => {
            // 同理：过期请求不许关 loading，否则最新那次还在飞、转圈却停了
            if (seq === fetchSeq) deps.loading.value = false;
        });
    }

    /**
     * 清单屏取数（2026-10-21 收藏分类）。
     *
     * 与 `fetchFolder` **共用 `fetchSeq`**（模块级序号）⇒「目录 → 清单 → 目录」
     * 连点切换时，过期响应写不进来 —— 防的是"面包屑已切到清单、网格里还是目录"。
     * 数据来自系统盘的 playlists.json（服务端逐条判盘在不在，在线给实时路径、
     * 离线给锚点）⇒ **零读盘**。错误形状与 fetchFolder 逐字同构（failKind + 同一条 toast）。
     */
    const fetchPlaylistItems = (id: string) => {
        const seq = ++fetchSeq;
        deps.loading.value = true;
        deps.failKind.value = '';
        loadingBar.start();

        return getPlaylistItems(id).then((data: PlaylistDetail) => {
            if (seq !== fetchSeq) return;
            deps.dataSource.value = data.items ?? [];
            loadingBar.finish();
        }).catch(err => {
            if (seq !== fetchSeq) return;
            console.error('[playlistItems] 请求失败:', err);
            deps.failKind.value = 'other';
            loadingBar.error();
            deps.notify('error', '打开失败', String(err));
        }).finally(() => {
            if (seq === fetchSeq) deps.loading.value = false;
        });
    };

    /**
     * 加载某一屏的**唯一出口**：目录屏走 `fetchFolder`，清单屏走 `fetchPlaylistItems`。
     *
     * 为什么必须收成一个口：取数调用点原有 6 个（进入 / 返回 / 刷新 / apply 后 /
     * 扫描收尾 / 换盘降级），逐点加 `if (entry.pl)` 就是 6 处分支 —— 漏一处的症状是
     * "面包屑显示清单、网格里还是目录内容"，而那正是项目明令禁止的**补丁形态**。
     * 责任收在唯一出口之后，第 7 个入口也忘不掉。
     * （onRefresh 有 playlistLevel 守卫、永不到清单屏；onDisksChanged 自己已按屏型分派。）
     */
    const loadScreen = (entry: ScreenTarget, flat?: boolean) => {
        if (entry.pl) return fetchPlaylistItems(entry.pl.id);
        return fetchFolder(entry.path, entry.mode, false, flat);
    };



    return { fetchFolder, fetchPlaylistItems, loadScreen, getFetchSeq: () => fetchSeq };
}
