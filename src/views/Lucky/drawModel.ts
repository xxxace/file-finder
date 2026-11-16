/**
 * 抽卡纯逻辑 —— **零 IO、零 DOM、零 Vue**。
 *
 * 为什么单独一个文件：这些判据（去重维度、离线过滤、抽不满时怎么办）是唯一值得被
 * 反复验证的部分，必须能被探针直接 bundle 断言（`docs/probes/lucky-draw/probe.cjs`）。
 * 埋在 SFC 或和 `fetch` 混在一起，探针就只能手抄一份 —— 手抄的那份永远不会红。
 *
 * IO 在 `usePool.ts`：它 import `@/utils/request`（顶层就要 electron 的 ipcRenderer），
 * 探针里 import 不了。两者的接线在页面里完成。
 */
import type { TunnelCoverItem } from '../../../electron/server/nedb';

/** 卡片等级 —— 三个视觉档，四个标签（参考站就是这套：Common / Rare / Holo rare / Ultra rare） */
export type CardTier = 'common' | 'rare' | 'ultra';

export interface Rarity {
    tier: CardTier;
    /** 等级标记：● ◆ ◆◆ ★ */
    mark: string;
    /** 等级名：Common / Rare / Holo rare / Ultra rare */
    label: string;
}

/**
 * 一包的等级构成 —— **照抄参考站**。
 *
 * 参考站的五张卡是固定的四档：`● Common` ×2、`◆ Rare` ×1、`◆◆ Holo rare` ×1、
 * `★ Ultra rare` ×1（它的包装背面就印着 "One holo in every pack"）。
 * 每包**重新洗牌顺序**，所以位置随机、构成固定 —— 这就是它的"概率"。
 *
 * 我上一版拿"容量档"当等级（<1G/<3G/<8G），那是错的：真实收藏里 1~3G 占绝大多数，
 * 结果一包五张里四张都是 Rare —— 概率完全不是抽卡的样子。
 */
const PACK_MIX: readonly Rarity[] = [
    { tier: 'common', mark: '●', label: 'Common' },
    { tier: 'common', mark: '●', label: 'Common' },
    { tier: 'rare', mark: '◆', label: 'Rare' },
    { tier: 'rare', mark: '◆◆', label: 'Holo rare' },
    { tier: 'ultra', mark: '★', label: 'Ultra rare' },
];

/** 洗一包等级（5 张就是上面那套构成；池子不满 5 张时取前 n 个） */
export function rollRarities(n: number): Rarity[] {
    const a = PACK_MIX.slice(0, Math.max(0, Math.min(n, PACK_MIX.length)));
    for (let i = a.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    // 池子比 5 多出来的（理论上不会，`drawPack` 最多给 5）按 Common 补
    while (a.length < n) a.push(PACK_MIX[0]);
    return a;
}

/** 一张抽出来的卡。字段是渲染与打开所需的**全部**信息，页面不用再回头查池子。 */
export interface DrawCard {
    /** `${dir}/${name}` —— 与网格 `keyOf` 同形，方便将来"定位到这一格" */
    key: string;
    /** 作品名（封面条目的 name，不含扩展名） */
    title: string;
    /** 封面指纹，`thumbUrl` 用 */
    sig: string;
    serial: string;
    /** 在线盘符（`C`）；离线为空串 */
    letter: string;
    online: boolean;
    /** `2.4 GB`；服务端没给 size 时为空串 */
    sizeText: string;
    tier: CardTier;
    /** 等级标记：● ◆ ◆◆ ★ */
    mark: string;
    /** 等级名：Common / Rare / Holo rare / Ultra rare */
    label: string;
    /** 原始条目 —— 打开时要 `files` / `ext` */
    src: TunnelCoverItem;
}

/** 服务端 `/getDisks` 的磁盘项（只取本文件用到的字段） */
export interface DiskLike {
    serial: string;
    drive?: string;
    online?: boolean;
}

/**
 * 字节数 → 短标签。
 *
 * B/KB 取整、MB 以上保留一位：`2.4 GB` 是一眼能读的，`2.412 GB` 只是噪声。
 * 无值/非正数给空串 —— 界面按"没有这个信息"处理，不显示 `0 B`。
 */
export function formatBytes(n?: number): string {
    if (!n || !Number.isFinite(n) || n <= 0) return '';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let v = n;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) {
        v /= 1024;
        i += 1;
    }
    return `${i >= 2 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

/**
 * serial → 盘符（`C`）。
 *
 * ⚠️ 只收 `online !== false` 的盘：离线项服务端给的 `drive` 是空串，但**不能依赖它为空**
 * —— 拔盘那一刻缓存里的旧盘符可能还在，把别人的盘符贴到离线卡上比留空更误导。
 */
export function letterMapOf(disks: readonly DiskLike[]): Map<string, string> {
    const map = new Map<string, string>();
    for (const d of disks) {
        if (d.online === false) continue;
        const letter = (d.drive || '').replace(/:.*$/, '').trim().toUpperCase();
        if (d.serial && letter) map.set(d.serial, letter);
    }
    return map;
}

/** 一张卡的身份 = 封面指纹。同一部作品换了备份路径仍是同一张卡。 */
const sigOf = (it: TunnelCoverItem) => it.sig;

/**
 * 候选池：筛掉不该出现的，并**按 sig 去重**。
 *
 * 去重为什么放在这里而不是信任服务端：`findAllCachedCovers` 已经按 sig / 作品名 / 路径
 * 去重过，但那是"全库去重"；抽卡只在乎"这一包里别出现两张一样的脸"。
 * 收在同一处的好处是 `drawPack` 不必再关心这个维度。
 */
export function candidatesOf(
    sources: readonly TunnelCoverItem[],
    onlineSerials: ReadonlySet<string>,
    opts: { includeOffline: boolean; exclude?: ReadonlySet<string> },
): TunnelCoverItem[] {
    const seen = new Set<string>();
    const out: TunnelCoverItem[] = [];
    for (const it of sources) {
        const sig = sigOf(it);
        if (!sig || seen.has(sig)) continue;
        if (!opts.includeOffline && !onlineSerials.has(it.serial)) continue;
        if (opts.exclude?.has(sig)) continue;
        seen.add(sig);
        out.push(it);
    }
    return out;
}

/** Fisher–Yates；复制后洗，绝不改入参（池子是页面持有的快照，被洗乱会串到下一包） */
function shuffled<T>(list: readonly T[]): T[] {
    const a = list.slice();
    for (let i = a.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

/**
 * 抽一包。
 *
 * 三条判据（都有探针）：
 *  ① 长度 = `min(count, 可用数)` —— 池子不够就少给，**不补齐、不重复**；
 *  ② 同一包内 sig 不重复；
 *  ③ `exclude` **优先**排除（最近抽过的），但若因此抽不满，用被排除的补位 ——
 *     "记得太多导致抽不出 5 张"是绝不能有的。
 */
export function drawPack(
    sources: readonly TunnelCoverItem[],
    onlineSerials: ReadonlySet<string>,
    opts: { includeOffline: boolean; count?: number; exclude?: ReadonlySet<string> },
): TunnelCoverItem[] {
    const count = opts.count ?? 5;
    if (count <= 0) return [];

    const fresh = candidatesOf(sources, onlineSerials, {
        includeOffline: opts.includeOffline,
        exclude: opts.exclude,
    });
    const picked = shuffled(fresh).slice(0, count);
    if (picked.length >= count) return picked;

    // 补位：把被 exclude 挡掉的重新拿来，且**不再重复已经选中的**
    const taken = new Set(picked.map(sigOf));
    const relaxed = candidatesOf(sources, onlineSerials, { includeOffline: opts.includeOffline });
    const fill = shuffled(relaxed.filter(it => !taken.has(sigOf(it))));
    return picked.concat(fill.slice(0, count - picked.length));
}

/** 条目 → 卡片。渲染层只认 `DrawCard`，不直接碰 `TunnelCoverItem`。 */
export function cardOf(
    src: TunnelCoverItem,
    onlineSerials: ReadonlySet<string>,
    letters: ReadonlyMap<string, string>,
    rarity: Rarity,
): DrawCard {
    const online = onlineSerials.has(src.serial);
    return {
        key: `${src.dir}/${src.name}`,
        title: src.name,
        sig: src.sig,
        serial: src.serial,
        letter: online ? (letters.get(src.serial) ?? '') : '',
        online,
        sizeText: formatBytes(src.size),
        ...rarity,
        src,
    };
}

/**
 * 「最近抽过」的记账本 —— 最多记 3 包（15 个 sig）。
 *
 * 为什么不是无限记：池子小的用户会被自己的历史抽空（几千部不会，但 20 部的收藏夹会）。
 * 3 包足够避免"连按两次一模一样"，又不可能把池子吃穷。
 */
export const RECENT_PACKS = 3;

export function rememberRecent(recent: readonly string[], pack: readonly DrawCard[]): string[] {
    return pack.map(c => c.sig).concat(recent).slice(0, RECENT_PACKS * 5);
}
