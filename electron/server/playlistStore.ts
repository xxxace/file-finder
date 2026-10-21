/**
 * 清单（收藏分类）· 存储
 * ===========================================================================
 * 用户自建的文件清单（类歌单 / playlist）。**只存索引，不碰移动硬盘**：
 * 每条目是一份快照 + 身份（盘序列号 + 盘内相对路径），文件本体在哪块盘上、
 * 此刻插没插，是路由层（playlist.ts）打开那一刻才问的事。
 *
 * 存储形态照 `assistant/rules.ts` 的先例，不发明第二套：
 *   · 明文 JSON（`~/.file-finder/playlists.json`）—— 清单是**用户配置**，
 *     与扫描缓存（nedb 加密库）不同族；人可读、可手改、可整体拷贝；
 *   · 内存态 + 串行写队列（WRITE_CHAINS）—— 连点两次「加入」不会交叉写；
 *   · 原子写（tmp → rename）—— 中途断电最多留一个 .tmp，不会写坏正文件；
 *   · JSON 损坏不崩：回落空清单（与 rules.ts 同哲学，配置丢了不该让 app 起不来）。
 */
import fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

/** 清单里的一个条目 = 一份快照 + 身份。快照字段与网格卡片一一对应（加入时从卡片原样带来） */
export interface PlaylistItem {
    id: string;
    /** 盘序列号 = 身份（本项目铁律：盘符不是身份，序列号才是） */
    serial: string;
    /** 盘内相对路径（条目所在目录，同 `FileInfo.dir` 语义） */
    relPath: string;
    name: string;
    ext?: string;
    type: 'folder' | 'image' | 'video' | 'file';
    size: number;
    /** 缩略图指纹 ⇒ 货架/详情网格直接取 bin 仓的图，零读盘 */
    sig?: string;
    /** 目录代言卡快照：丢了它，双击会把"一部片一个目录"错判成图片弹预览（见 openDecision） */
    files?: { name: string; size: number }[];
    addedAt: number;
}

export interface Playlist {
    id: string;
    name: string;
    /** true = 系统默认清单「收藏」：不可删、不可改名 */
    system?: boolean;
    createdAt: number;
    items: PlaylistItem[];
}

/** 默认清单名。与前端 `playlist.ts` 的 DEFAULT_NAME 必须同值（改一处忘另一处 = 建出两个默认清单） */
export const DEFAULT_PLAYLIST_NAME = '收藏';

const FILE_STORE = new Map<string, Playlist[]>();
const WRITE_CHAINS = new Map<string, Promise<unknown>>();

const newId = (prefix: string) => `${prefix}_${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;

function playlistsPath(dataDir: string): string {
    return path.join(dataDir, 'playlists.json');
}

/** 串行写：同一文件的写操作排队执行，后来的等前一个落盘才动（rules.ts 同款） */
function queueWrite(file: string, task: () => Promise<void>): Promise<void> {
    const prev = WRITE_CHAINS.get(file) ?? Promise.resolve();
    const next = prev.then(task, task);
    WRITE_CHAINS.set(file, next.catch(() => undefined));
    return next;
}

async function atomicWrite(file: string, text: string): Promise<void> {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    await fsp.writeFile(tmp, text, 'utf8');
    await fsp.rename(tmp, file);
}

function persist(dataDir: string, list: Playlist[]): Promise<void> {
    FILE_STORE.set(dataDir, list);
    const file = playlistsPath(dataDir);
    return queueWrite(file, () => atomicWrite(file, JSON.stringify(list, null, 2)));
}

/**
 * 读清单（启动时 / 每次请求都走这里，命中内存态就直接返回）。
 * 没有「收藏」就补一个 —— 默认清单是功能的另一半：高频场景零成本，
 * 不强制用户先建单（YouTube 的 Watch Later 同款定位）。
 */
export async function loadPlaylists(dataDir: string): Promise<Playlist[]> {
    const cached = FILE_STORE.get(dataDir);
    if (cached) return cached;

    const file = playlistsPath(dataDir);
    let list: Playlist[] = [];
    let existed = true;
    if (fs.existsSync(file)) {
        try {
            const parsed: unknown = JSON.parse(await fsp.readFile(file, 'utf8'));
            if (Array.isArray(parsed)) list = parsed as Playlist[];
        } catch {
            list = [];   // 损坏：回落空清单（同 rules.ts）
        }
    } else {
        existed = false;
    }
    if (!list.some(p => p.system)) {
        list.unshift({ id: newId('pl'), name: DEFAULT_PLAYLIST_NAME, system: true, createdAt: Date.now(), items: [] });
    }
    FILE_STORE.set(dataDir, list);
    if (!existed) await persist(dataDir, list);
    return list;
}

export async function createPlaylist(dataDir: string, name: string): Promise<Playlist> {
    const list = await loadPlaylists(dataDir);
    const pl: Playlist = { id: newId('pl'), name: name.trim() || DEFAULT_PLAYLIST_NAME, createdAt: Date.now(), items: [] };
    list.push(pl);
    await persist(dataDir, list);
    return pl;
}

/** 重命名。system 清单拒服（调用方负责转 400） */
export async function renamePlaylist(dataDir: string, id: string, name: string): Promise<boolean> {
    const list = await loadPlaylists(dataDir);
    const pl = list.find(p => p.id === id);
    if (!pl || pl.system) return false;
    pl.name = name.trim() || pl.name;
    await persist(dataDir, list);
    return true;
}

/** 删除。system 清单拒服 */
export async function deletePlaylist(dataDir: string, id: string): Promise<boolean> {
    const list = await loadPlaylists(dataDir);
    const pl = list.find(p => p.id === id);
    if (!pl || pl.system) return false;
    await persist(dataDir, list.filter(p => p.id !== id));
    return true;
}

/**
 * 条目的身份字符串。
 *
 * 身份 = **盘序列号 + 盘内目录 + 显示名 + 扩展名**（盘符不是身份，序列号才是）。
 * 同一个文件被加两次，这四个字段完全一样 —— 那就是"重复"，不该再收一份。
 */
function itemKeyOf(it: PlaylistItem): string {
    return `${it.serial}|${it.relPath}|${it.name}|${it.ext ?? ''}`;
}

/**
 * 加入条目（可多条，为 P2 批量预留）。返回该清单。
 *
 * ⚠️ **同一清单内按身份去重**（2026-10-21 主人报"同一个文件能重复加入同一个收藏夹"）。
 * 去重在存储层做，不在调用方做 —— 现在有三条加入路径（右键「加入收藏」/ 选单 /
 * 新建并加入），守卫写在调用方就会漏，写在唯一写入点才不会。
 * 全是重复时不写盘：一次原子写也不该为"什么都没变"发生。
 */
export async function addItems(dataDir: string, id: string, items: PlaylistItem[]): Promise<Playlist | null> {
    const list = await loadPlaylists(dataDir);
    const pl = list.find(p => p.id === id);
    if (!pl || !items.length) return pl ?? null;

    const seen = new Set(pl.items.map(itemKeyOf));
    const fresh = items.filter(it => {
        const k = itemKeyOf(it);
        if (seen.has(k)) return false;   // 已经在这一夹里
        seen.add(k);                      // 同一批里也去重
        return true;
    });
    if (!fresh.length) return pl;

    pl.items.push(...fresh);
    await persist(dataDir, list);
    return pl;
}

/**
 * 把一份 `playlists.json`（来自备份包）**并入**本地 —— 只增不删。
 *
 * 为什么是"并入"而不是"整份替换"：备份多半比当前旧，替换会把备份之后新建的收藏夹
 * 一起抹掉。语义对齐「合并缓存…」：两边都留。
 *
 * 合并规则：
 * - **默认收藏夹按角色匹配**（`system`），不按 id —— 两台机器的默认夹 id 是各自随机生成的，
 *   按 id 匹配会并出两个「收藏」。包里的默认夹条目并入本地那个。
 * - 其余按 **id** 匹配：id 已存在 ⇒ 只补它缺的条目；不存在 ⇒ 整夹追加。
 * - 条目按身份（serial|relPath|name|ext）去重，与 `addItems` 同一个判据。
 *
 * @returns 实际新增的数量（给"还原完成"的文案用）
 */
export async function mergePlaylists(dataDir: string, incoming: Playlist[]): Promise<{ playlists: number; items: number }> {
    const list = await loadPlaylists(dataDir);
    const byId = new Map(list.map(p => [p.id, p]));
    const system = list.find(p => p.system);
    let addedPlaylists = 0;
    let addedItems = 0;

    for (const raw of incoming) {
        if (!raw || !Array.isArray(raw.items)) continue;
        const target = raw.system ? system : byId.get(raw.id);
        let pl: Playlist;

        if (target) {
            pl = target;
        } else {
            const id = typeof raw.id === 'string' && raw.id && !byId.has(raw.id) ? raw.id : newId('pl');
            pl = {
                id,
                name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : '未命名收藏夹',
                createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : Date.now(),
                items: [],
            };
            list.push(pl);
            byId.set(id, pl);
            addedPlaylists += 1;
        }

        const seen = new Set(pl.items.map(itemKeyOf));
        for (const it of raw.items) {
            if (!it || !it.serial || !it.relPath || !it.name) continue;
            const k = itemKeyOf(it);
            if (seen.has(k)) continue;
            seen.add(k);
            pl.items.push({ ...it, id: typeof it.id === 'string' && it.id ? it.id : newId('it') });
            addedItems += 1;
        }
    }

    if (addedPlaylists || addedItems) await persist(dataDir, list);
    return { playlists: addedPlaylists, items: addedItems };
}

/** 按条目 id 移除（路由层负责把"当前形态的 key"翻成 id —— 那需要盘表知识，不属于存储） */
export async function removeItemById(dataDir: string, id: string, itemId: string): Promise<boolean> {
    const list = await loadPlaylists(dataDir);
    const pl = list.find(p => p.id === id);
    if (!pl) return false;
    const before = pl.items.length;
    pl.items = pl.items.filter(it => it.id !== itemId);
    if (pl.items.length === before) return false;
    await persist(dataDir, list);
    return true;
}
