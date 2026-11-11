/**
 * 首页盘卡片的落点计算 —— **纯函数、零依赖**（不 import 任何东西，探针可以直接跑）。
 *
 * ## 判据（业主 2026-11-11 第五轮钉死）
 *
 * **每条缓存分支自己的最上层**——祖先缓存过的那层被上一级覆盖，其余各是各的顶层。
 * **父层不许凭空造出来**。业主原话给出的三组：
 *
 * | 缓存里有什么 | 顶层 |
 * |---|---|
 * | `media/SET-A` · `media/SET-A/A` · `media/SET-A/B` | `media/SET-A` |
 * | `media/SET-B/COLL-A`（SET-B 自己没扫过） | `media/SET-B/COLL-A` |
 * | 离线盘只有 `disk/album-x` | 那一条（唯一 ⇒ 不弹菜单） |
 *
 * ⇒ D 盘给的是 `media/SET-A` + `media/SET-B/COLL-A` 两条。
 *
 * ⚠️ **不许"同级折叠"**（我 2026-11-11 第三轮加过，第五轮被否）：
 * 那会把 `SET-B/COLL-A` 折成没缓存过的 `SET-B` —— 点进去要真读一次盘，
 * 而且用户根本没扫过那一层，等于程序替他编了一个入口。
 * ⚠️ 也不许拿"全盘最小深度"当判据（第一版）：`videos` 深 1 会把互不相干的
 * `videos2/xxx1` 一起刷掉。
 *
 * ## 两个"看着像废话、但真吃过亏"的前置
 *
 * ① **分隔符归一**：库里的 relPath **真的有反斜杠**（`videos\aaa`，2026-11-11 截图实测）；
 * ② **大小写不敏感**：Windows 同一层可能被扫成 `Videos` / `videos` 两种写法。
 * 这两条不做，父子关系一条都认不出来 ⇒ 整排子层全变成"顶层"。
 * 而拼地址时必须回到**库里原样**（老记录的缓存主键带反斜杠，归一形态查不到）。
 *
 * 为什么抽成独立文件：这段判据连错三轮（最小深度 → 折叠 → 反斜杠），
 * 光靠 typecheck 证明不了。`docs/probes/disk-tops/run.mjs` 跑真源码断言，
 * 改判据前先跑它。
 */

/** 一条缓存记录里本模块需要的两样 */
export interface TopRow {
    /** 盘内相对路径（`videos` / `videos/xxx1`）；空串 = 盘根 */
    relPath: string;
    /** 这一层缓存到的条目数 */
    count?: number;
}

/** 一个可点的落点 */
export interface DiskTop {
    relPath: string;
    /** 展示名：relPath 的最后一段；盘根给「盘根」 */
    name: string;
    /** 可直接交给前端进屏的地址（在线 = 实时路径，离线 = 只读锚点） */
    path: string;
    /** 条目数（这一层缓存到的数量，扫描快照） */
    count: number;
}

export interface DiskTopsOpts {
    /**
     * 盘内相对路径 → 可进屏的地址。**由调用方注入**：只有它知道盘符/序列号，
     * 也只有它知道这块盘此刻在不在（在线给实时路径、离线给只读锚点）。
     */
    path: (relPath: string) => string;
}

/**
 * 盘内相对路径的**父路径**；没有父段（单段 / 空串）返回空串。
 * ⚠️ 两种分隔符都认（库里的 `relPath` 既有 `/` 也有 `\`，见文件头第 ① 步）。
 */
export function parentOf(relPath: string): string {
    const cut = Math.max(relPath.lastIndexOf('/'), relPath.lastIndexOf('\\'));
    return cut > 0 ? relPath.slice(0, cut) : '';
}

/** 展示与比对用的归一形态：反斜杠一律变 `/`（不改大小写） */
export function normalizeRel(relPath: string): string {
    return relPath.replace(/\\/g, '/').replace(/\/+$/, '');
}

/**
 * 这条路径的**祖先**里有没有缓存过的（`cached` 已按小写归一）。
 *
 * ⚠️ 必须显式判"父层是盘根（空串）"这一档：`parentOf('videos')` 也是空串，
 * 而空串在缓存集合里代表"**盘根被扫过**"—— 那种情况下盘根下面的一切都不是入口。
 * 第一版写成 `while (p)`，空串一进来就退出 ⇒ 盘根扫过时子层照样全冒出来。
 * ⚠️ 调用方只对**非空** relPath 调它（盘根没有祖先）。
 */
function hasCachedAncestor(relPath: string, cached: Set<string>): boolean {
    let p = parentOf(relPath);
    for (;;) {
        // ⚠️ `cached` 里是小写 key，这里必须同步小写再查（漏了就一条都认不出来 —— 探针抓到过）
        if (cached.has(p.toLowerCase())) return true;
        if (!p) return false;
        p = parentOf(p);
    }
}

/**
 * 一块盘的所有缓存记录 → 首页卡片上的落点列表。
 *
 * **零读盘**：只吃调用方已经载入内存的元数据。
 *
 * ⚠️ 同一 `relPath` 可能有 `cover` / `folder` 两条记录（两种缓存模式）——
 * 地址相同，去重只留一条，`count` 取最大的那条（封面模式通常更全）。
 */
export function diskTops(rows: ReadonlyArray<TopRow>, opts: DiskTopsOpts): DiskTop[] {
    if (!rows.length) return [];
    /**
     * 先把每条记录整理成三样：
     *  · `disp` —— 归一后的展示形态（`\` → `/`），也是父子关系的判据形态；
     *  · `key`  —— `disp` 再转小写，只用于比较（Windows 大小写不敏感）；
     *  · `raw`  —— 库里那个**原样**的 relPath，拼地址时必须用它。
     *
     * ⚠️ `raw` 不能丢（2026-11-11）：这些带反斜杠的老记录，其缓存主键就是带反斜杠的那串；
     *    拿归一后的 `/` 形态去查缓存会**查不到**（离线盘直接变成"这一层没缓存过"）。
     *    地址用原样、判据用归一 → 两边各司其职。
     */
    const items = rows.map(r => {
        const disp = normalizeRel(r.relPath || '');
        // `raw` 保留内部反斜杠（缓存主键就是那串），但**削掉尾部的分隔符**：
        // 带尾分隔符的 key 拼出来的地址会变成 `H:/videos\`，服务端 `splitPath` 归一后
        // 与主键对不上（2026-11-11 code review 指出的边界，探针有断言）。
        const raw = (r.relPath || '').replace(/[\\/]+$/, '');
        return { raw, disp, key: disp.toLowerCase(), count: r.count || 0 };
    });

    // 缓存过的 key 全集（含盘根的空串）—— 判断"祖先缓存过没有"就靠它
    const cached = new Set(items.map(i => i.key));

    const roots = new Map<string, { raw: string; disp: string; count: number }>();
    for (const it of items) {
        // 盘根自己没有祖先；其余往上走一层层问
        if (it.disp && hasCachedAncestor(it.disp, cached)) continue;
        const hit = roots.get(it.key);
        // 同一层可能有多条（cover / folder 两种模式，或 `/` 与 `\` 两种写法）⇒ 取 count 最大的那条
        if (hit) hit.count = Math.max(hit.count, it.count);
        else roots.set(it.key, { raw: it.raw, disp: it.disp, count: it.count });
    }

    return [...roots.values()]
        .map(e => ({
            relPath: e.disp,
            name: e.disp ? e.disp.split('/').pop() || e.disp : '盘根',
            // ⚠️ 地址用**库里原样**的 relPath（`raw`），不是归一形态：
            // 带反斜杠的老记录，缓存主键就是那串，用 `/` 去查会查不到（离线直接"没缓存过"）
            path: opts.path(e.raw),
            count: e.count,
        }))
        /**
         * 排**路径序**（不是条目数）：业主 2026-11-11 —— 「`media/SET-A` 不应该在
         * `media/SET-B/COLL-A` 上面吗？」菜单是**目录清单**，不是排行榜；
         * 按条目数排会让同一支的子层插到别人家去，读起来就是乱的。
         * `'zh'`：中文按拼音 —— 与缓存记录页排序同一个口径（`nedb.ts` 的 sort 分支）。
         */
        .sort((a, b) => a.relPath.localeCompare(b.relPath, 'zh'));
}
