/**
 * 主进程图片出口（`/thumb`、`/preview`）的统一地址。**唯一真相源**。
 *
 * ⚠️ 带缓存：这些 URL 在模板里是**每条目每次全量渲染**都要算一遍（换屏、逐字过滤），
 *    而 `encodeURIComponent` 逐字符扫描 ⇒ 平铺 5000 条就是 5000 次。
 *    键是 `sig` 派生的短串，同一屏反复渲染命中率 100%。有界：满了整表丢，不做淘汰算法。
 * ⚠️ 缓存整条 URL 是安全的：`API_BASE` 是常量、`TOKEN` 模块加载时一次取定（都不会运行中变）
 *    ⇒ 不会出现"缓存了旧端口/旧口令"导致裂图。
 */
import { API_BASE, apiUrl } from './request';

const cache = new Map<string, string>();

export function assetUrl(route: 'thumb' | 'preview', key?: string): string {
    if (!key) return '';
    const id = `${route}:${key}`;
    const hit = cache.get(id);
    if (hit) return hit;
    const url = apiUrl(`${API_BASE}/${route}?k=${encodeURIComponent(key)}`);
    if (cache.size > 4096) cache.clear();
    cache.set(id, url);
    return url;
}

export const thumbUrl = (key?: string) => assetUrl('thumb', key);
