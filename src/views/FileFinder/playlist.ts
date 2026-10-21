/**
 * 清单（收藏分类）· 前端
 * ===========================================================================
 * 收录索引的**单一状态源**：货架、加入选单、网格星标三处共读同一个 reactive 对象，
 * 各存一份迟早对不上（「已收录」星标还亮着、选单里却没打 ✓ 那种）。
 *
 * 分工：本模块只做「调接口 + 持有索引」，不碰 UI；纯逻辑（key 比对、成员表）
 * 单独导出，供 `docs/probes/playlist/` 直接 bundle 测试。
 *
 * 同步策略：**每次变更后重取索引**（服务端是真相源）—— 本地乐观更新要顺带重算
 * 封面拼格与数量，容易和服務器漂移；一次 GET /playlists 只有几 KB，重取最稳。
 */
import { reactive } from 'vue';
import { getAction, postAction } from '@/utils/request';
import type { CardSnapshot } from '../../../electron/server/playlist';
import type { WiredFileInfo } from '../../../electron/server/index';

const API_BASE = 'http://127.0.0.1:3060';

/** 默认清单名。与服务端 `playlistStore.ts` 的 DEFAULT_PLAYLIST_NAME 必须同值 */
export const DEFAULT_PLAYLIST_NAME = '收藏';

export interface PlaylistSummary {
    id: string;
    name: string;
    system: boolean;
    count: number;
    /** 最多 4 个 bin 仓图片名（`t-<sig>.enc`），货架拼格封面用 */
    covers: string[];
    /** 每条目的**当前形态** key（`dir/真名`）—— 与网格 `keyOf(card)` 同形，直接比对 */
    keys: string[];
}

export interface PlaylistDetail {
    playlist: { id: string; name: string; system: boolean; count: number };
    items: WiredFileInfo[];
}

/** 模块级单一状态源（同 pinia 的思路，但这个项目没有 pinia，不引） */
const state = reactive({
    loaded: false,
    playlists: [] as PlaylistSummary[],
});

export function playlistIndex() {
    return state;
}

/** key → 收录它的清单 id 们。星标与选单 ✓ 都查它（纯函数，探针直测） */
export function buildMemberMap(summaries: PlaylistSummary[]): Map<string, string[]> {
    const map = new Map<string, string[]>();
    for (const pl of summaries) {
        for (const k of pl.keys) {
            const arr = map.get(k);
            if (arr) arr.push(pl.id); else map.set(k, [pl.id]);
        }
    }
    return map;
}

/** 默认清单（「收藏」）。没有 = 服务端还没建出来，理论上是瞬时状态 */
export function defaultPlaylist(summaries: PlaylistSummary[]): PlaylistSummary | undefined {
    return summaries.find(p => p.system);
}

// ── API ────────────────────────────────────────────────────────────────────

/** 重取收录索引。启动时、每次变更后、插拔盘时都调它 */
export async function refreshIndex(): Promise<PlaylistSummary[]> {
    const data = await getAction(`${API_BASE}/playlists`);
    state.playlists = data?.playlists ?? [];
    state.loaded = true;
    return state.playlists;
}

/** 新建清单。返回新建的清单本体（索引重取后按 id 找回）—— 调用方要立刻往里加条目 */
export async function createPlaylist(name: string): Promise<PlaylistSummary | null> {
    const data = await postAction(`${API_BASE}/playlistCreate`, { name });
    await refreshIndex();
    const created = data?.playlist as { id: string } | undefined;
    return state.playlists.find(p => p.id === created?.id) ?? null;
}

export async function renamePlaylist(id: string, name: string): Promise<void> {
    await postAction(`${API_BASE}/playlistRename`, { id, name });
    await refreshIndex();
}

export async function deletePlaylist(id: string): Promise<void> {
    await postAction(`${API_BASE}/playlistDelete`, { id });
    await refreshIndex();
}

/** 加入一个卡片快照。card 由调用方从网格条目现成拼（dir/name/ext/type/size/sig/files） */
export async function addToPlaylist(id: string, card: CardSnapshot): Promise<void> {
    await postAction(`${API_BASE}/playlistAdd`, { id, entries: [card] });
    await refreshIndex();
}

/** 从清单移除。key = 条目当前形态的 `dir/真名`（即网格 keyOf 的值） */
export async function removeFromPlaylist(id: string, key: string): Promise<void> {
    await postAction(`${API_BASE}/playlistRemove`, { id, key });
    await refreshIndex();
}

/** 详情屏取数。盘在不在由服务端逐条判（在线给实时路径、离线给锚点）—— 零读盘 */
export async function getPlaylistItems(id: string): Promise<PlaylistDetail> {
    return getAction(`${API_BASE}/playlistItems?id=${encodeURIComponent(id)}`);
}
