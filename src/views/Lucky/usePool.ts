/**
 * 池子的 IO 层 —— 只做两件事：拉两个接口、把结果整理成 `PoolSnapshot`。
 *
 * 单独成文件的原因在 `drawModel.ts` 头部：那个文件必须能被探针 bundle，
 * 而这个文件顶层就经 `@/utils/request` 碰 `ipcRenderer`，探针里 import 不了。
 *
 * **零读盘**：`/getAllCovers` 是纯内存查库（`nedb.ts` 的 `findAllCachedCovers`），
 * `/getDisks` 走进程内缓存的盘符列表 —— 两个都不碰移动硬盘。
 * ⚠️ 不许给 `/getDisks` 加 `?refresh=true`：那会对每个盘符 `stat` 一次。
 */
import { API_BASE, getAction } from '@/utils/request';
import type { TunnelCoverItem } from '../../../electron/server/nedb';
import { letterMapOf } from './drawModel';
import type { DiskLike } from './drawModel';

export interface PoolSnapshot {
    /** 全库已缓存封面（服务端已按 sig / 作品名去重） */
    sources: TunnelCoverItem[];
    /** 此刻在线的盘（serial）。`onlineKnown === false` 时是空集，**别拿它当判据** */
    onlineSerials: Set<string>;
    /** serial → 盘符 */
    letters: Map<string, string>;
    /**
     * `/getDisks` 是否拿到了。
     *
     * ⚠️ 这个字段是必需的，不是保险：`/getDisks` 一旦失败而 `onlineSerials` 是空集，
     * "不含离线盘"这个筛选会把**所有**卡都滤掉 ⇒ 池子看起来是空的，用户只会以为"没数据了"。
     * 页面必须据此把 `includeOffline` 强制为真（见 `views/Lucky/index.vue` 的 effective 计算），
     * 而不是相信空集。
     */
    onlineKnown: boolean;
}

/**
 * 拉一次池子。**故意不缓存**。
 *
 * ⚠️ 封面池会变：助手补封面、浏览时生成缩略图都会加条目。以前这里有一层 `poolCache`
 *    + `force` 参数 + `clearPoolCache()`，但刷新入口一个都没接上 —— 结果是"新补的封面
 *    永远抽不到，只能重启"。两个端点都是纯内存（`findAllCachedCovers` 是 nedb 内存查询、
 *    `hasBin` 是 Set 查表、`/getDisks` 走进程内缓存），重拉一次只有几毫秒，没有必要缓存。
 */
export async function fetchPool(): Promise<PoolSnapshot> {
    const [covers, disks] = await Promise.all([
        getAction(`${API_BASE}/getAllCovers`),
        // 盘列表只用来"标在线/离线"，是辅助信息 ⇒ 失败降级，不拖垮整页
        getAction(`${API_BASE}/getDisks`).catch(() => null),
    ]);

    /**
     * ⚠️ 两个端点的响应形状**不一样**，这是服务端现状（2026-11-15 实测）：
     *   `/getAllCovers` → `{ code, data: { items, total } }`  （controller 显式包了 code/data）
     *   `/getDisks`     → `{ disks, duplicated, … }`          （直接平铺，**没有** code/data）
     * 因为 `sendJson` 只是 `JSON.stringify(body)`，包不包由每个 controller 自己决定。
     * 假设两者一致 ⇒ `disks.data.disks` 恒 undefined ⇒ 全部卡被判离线（首版真机就是这个症状）。
     * 别改成"兼容两种形状"：那会让下一个人永远不知道哪个才是对的。
     */
    const sources: TunnelCoverItem[] = Array.isArray(covers?.data?.items) ? covers.data.items : [];
    const diskList: DiskLike[] = Array.isArray(disks?.disks) ? disks.disks : [];

    const onlineSerials = new Set<string>();
    for (const d of diskList) {
        if (d?.serial && d.online !== false) onlineSerials.add(d.serial);
    }

    return {
        sources,
        onlineSerials,
        letters: letterMapOf(diskList),
        onlineKnown: Array.isArray(disks?.disks),
    };
}

/**
 * 响应主进程 diskWatch（`ff-disks-changed` 事件）：零读盘、零请求，就地更新在线集合与盘符。
 *
 * 只改传进来的这一份快照 —— 页面持有它、卡片也认它，池子本身（`sources`）不动。
 */
export function applyDisksUpdate(
    snapshot: PoolSnapshot | null,
    disks: readonly { serial: string; drive?: string }[],
): void {
    if (!snapshot) return;
    const onlineSerials = new Set<string>();
    const letters = new Map<string, string>();
    for (const d of disks) {
        if (d?.serial) {
            onlineSerials.add(d.serial);
            const letter = (d.drive || '').replace(/:.*$/, '').trim().toUpperCase();
            if (letter) letters.set(d.serial, letter);
        }
    }
    snapshot.onlineSerials = onlineSerials;
    snapshot.letters = letters;
    snapshot.onlineKnown = true;
}
