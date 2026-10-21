/**
 * 清单（收藏分类）· 路由工厂
 * ===========================================================================
 * 用依赖注入（sendJson / dataDir）而不是从 server/index.ts import，避免循环引用
 * （同 assistant/index.ts 的模式）：server/index.ts import 本模块拿路由、
 * 本模块 import server/index.ts 拿 sendJson 会形成环，所以把 sendJson 当参数传进来。
 *
 * 路由经 server/index.ts 的 `route()` 咽喉点注册 → 自动受 token 校验与统一兜底。
 * ⚠️ `route()` 是**精确匹配 pathname**，不支持 `/:id` —— 所以 id 一律走 query/body。
 *
 *   GET    /playlists          收录索引（货架 + 星标/✓ 状态用）
 *   GET    /playlistItems?id=  详情：装配成网格条目（WiredFileInfo 形状）
 *   POST   /playlistCreate     { name }
 *   POST   /playlistRename     { id, name }
 *   POST   /playlistDelete     { id }
 *   POST   /playlistAdd        { id, entries[] }   entries = 网格卡片快照
 *   POST   /playlistRemove     { id, key }         key = 条目当前形态的 dir/name
 *
 * **读盘边界**：本文件所有路由零读盘 —— 盘在线与否只查 `getDrives()`（进程内缓存），
 * 图片只查 `hasBin()`（内存集合），数据只读写系统盘上的 playlists.json。
 * 唯一会碰移动硬盘的时刻是用户**双击打开**那一刻（走现有 openFile 链，不在这里）。
 */
import type http from 'node:http';
import {
    addItems, createPlaylist, deletePlaylist, loadPlaylists, removeItemById, renamePlaylist,
} from './playlistStore';
import type { Playlist, PlaylistItem } from './playlistStore';
import { hasBin, previewNameOf, sigOfThumbName, thumbNameOf } from '../utils/binStore';
import { getDrives, serialOfDrive, splitPath, toFullPath } from '../utils/driveIdentity';
import type { WiredFileInfo } from './index';

/**
 * 只读锚点前缀。与 `server/index.ts` 的 ANCHOR_PREFIX、`src/utils` 的那一份
 * **必须同值**（三处各写一份是这个项目的既定约定：渲染层与主进程 bundle 不共享代码）。
 * 渲染层刻意不解析锚点内容，只认前缀；序列号 → 盘符的映射只有服务端知道。
 */
const ANCHOR_PREFIX = '#';

type ReqLike = http.IncomingMessage & { params?: URLSearchParams; body?: any };
type SendJson = (res: http.ServerResponse, body: unknown, status?: number) => void;

export interface PlaylistDeps {
    sendJson: SendJson;
    /** 数据目录（config.userBasePath，即 ~/.file-finder） */
    dataDir: string;
}

export type PlaylistRoute = [string, (req: ReqLike, res: http.ServerResponse) => unknown];

/** 前端送来的卡片快照（加入清单用）—— 就是网格卡片上现成的那几个字段 */
export interface CardSnapshot {
    dir: string;
    name: string;
    ext?: string;
    type: PlaylistItem['type'];
    size: number;
    /**
     * 卡片的图片名（`t-<sig>.enc`，条目的 thumb 或 avatar）。**不是 sig** ——
     * 前端只有图片名（sig 不在下发白名单里），逆运算在服务端做（见 sigOfThumbName）。
     */
    thumb?: string;
    files?: { name: string; size: number }[];
}

// ── 纯装配函数（模块级导出：路由与 docs/probes/playlist/ 共用同一份） ──────────

/**
 * 条目 → 当前形态的目录：盘在线给实时路径（`H:/x`），不在线给只读锚点（`#序列号/x`）。
 * 与只读层同一套地址语义 ⇒ 双击打开、面包屑、预览降级全部走既有机制。
 */
export function dirOfItem(item: PlaylistItem, drive: string): string {
    return drive ? toFullPath(drive, item.relPath) : `${ANCHOR_PREFIX}${item.serial}/${item.relPath}`;
}

/**
 * 条目 → 当前形态的 key（`dir/显示名`）。
 *
 * ⚠️ **必须与渲染层 `keyOf(card)` 逐字同形**（`src/views/FileFinder/index.vue`：
 * `${item.dir}/${item.name}`）。这份字符串是**身份比对用的**，不是磁盘路径：
 *   · `/playlists` 的 `keys[]` → 前端 `plMember` → 网格星标 + 选单 ✓
 *   · `/playlistRemove` 的 `key` ← 前端 `keyOf(item)`
 * 曾经这里拼的是 `name.ext`（"磁盘真名"），而卡片上的 `name` 对封面条目本来就不含后缀
 * ⇒ 两边永不相等 ⇒ 星标不亮、✓ 不出现、「从清单移除」永远回"条目已不在清单里"
 * （2026-10-21 业主真机报）。**不要**在这里补扩展名：显示名是什么就拼什么。
 */
export function keyOfItem(item: PlaylistItem, drive: string): string {
    return `${dirOfItem(item, drive)}/${item.name}`;
}

/**
 * 条目 → 下发态（WiredFileInfo 形状）。规则与 `wire()` 逐字同构：
 * thumb/avatar 共用 `t-<sig>`（在线才发），preview 只在"本地已有"或
 * "盘在线且是图片"时发。bin 仓里没有的名字一律不下发（免得网格里一排 404）。
 */
export function wireItem(item: PlaylistItem, drive: string): WiredFileInfo {
    const tName = thumbNameOf(item.sig);
    const pName = previewNameOf(item.sig);
    const hasT = hasBin(tName);
    const hasP = hasBin(pName);
    const isFolder = item.type === 'folder';
    return {
        dir: dirOfItem(item, drive),
        name: item.name,
        isDirectory: isFolder,
        ext: item.ext,
        files: item.files,
        type: item.type,
        size: item.size,
        thumb: hasT && !isFolder ? tName : undefined,
        avatar: hasT && isFolder ? tName : undefined,
        preview: (hasP || (!!drive && item.type === 'image')) ? pName : undefined,
        previewReady: hasP,
    };
}

/**
 * 货架拼格封面：按加入次序取前 `max` 个**有图**的条目图名。
 *
 * hasBin 过滤是必须的：bin 仓没就绪（或图被清过）时名字还在条目上，
 * 不下过滤就会给货架一排 404 破图。去重：同一张图被多个条目共用只算一格。
 */
export function pickCovers(items: PlaylistItem[], max = 4): string[] {
    const covers: string[] = [];
    for (const it of items) {
        if (covers.length >= max) break;
        const t = thumbNameOf(it.sig);
        if (t && hasBin(t) && !covers.includes(t)) covers.push(t);
    }
    return covers;
}

/**
 * 卡片快照 → 条目身份。两种 dir 形态都认：
 *   · 只读锚点 `#<serial>/…` —— 自带序列号，直接取；
 *   · 完整路径 `H:/…`       —— 取盘符，经 `serialOfDrive`（纯内存）换序列号。
 * 推不出身份返回 null（调用方转 400）—— 那意味着这块盘从没被扫到过，
 * 它的内容不该进清单（进了也永远解析不回实时路径）。
 */
export function deriveIdentity(dir: string): { serial: string; relPath: string } | null {
    const raw = dir || '';
    if (raw.startsWith(ANCHOR_PREFIX)) {
        const rest = raw.slice(ANCHOR_PREFIX.length);
        const cut = rest.indexOf('/');
        const serial = cut === -1 ? rest : rest.slice(0, cut);
        const relPath = cut === -1 ? '' : rest.slice(cut + 1);
        return serial ? { serial, relPath } : null;
    }
    const sp = splitPath(raw);
    if (!sp) return null;
    const serial = serialOfDrive(sp.drive);
    return serial ? { serial, relPath: sp.relPath } : null;
}

export function createPlaylistRoutes(deps: PlaylistDeps): PlaylistRoute[] {
    const { sendJson, dataDir } = deps;

    // ── 装配辅助 ────────────────────────────────────────────────────────────
    // 纯函数都在模块级（dirOfItem / keyOfItem / wireItem / deriveIdentity，
    // 见上面导出区）—— 路由与探针共用同一份。这里只留需要 I/O 的那一个。

    // ── 路由 ────────────────────────────────────────────────────────────────

    /** 收录索引：货架要的（封面/数量）+ 网格星标与选单 ✓ 要的（keys） */
    async function listPlaylists(_req: ReqLike, res: http.ServerResponse) {
        const list = await loadPlaylists(dataDir);
        const drives = await getDrives();
        const bySerial = new Map(drives.map(d => [d.serial, d.drive]));
        const playlists = list.map(pl => ({
            id: pl.id,
            name: pl.name,
            system: !!pl.system,
            count: pl.items.length,
            covers: pickCovers(pl.items),
            keys: pl.items.map(it => keyOfItem(it, bySerial.get(it.serial) ?? '')),
        }));
        sendJson(res, { code: 200, playlists });
    }

    /** 详情：逐条装配成网格条目。盘在不在决定 dir 的形态，不进清单的过滤 */
    async function listItems(req: ReqLike, res: http.ServerResponse) {
        const id = req.params?.get('id') || '';
        const pl = (await loadPlaylists(dataDir)).find(p => p.id === id);
        if (!pl) {
            sendJson(res, { code: 404, error: '清单不存在（可能已被删除）' }, 404);
            return;
        }
        const drives = await getDrives();
        const bySerial = new Map(drives.map(d => [d.serial, d.drive]));
        sendJson(res, {
            code: 200,
            playlist: { id: pl.id, name: pl.name, system: !!pl.system, count: pl.items.length },
            items: pl.items.map(it => wireItem(it, bySerial.get(it.serial) ?? '')),
        });
    }

    async function create(req: ReqLike, res: http.ServerResponse) {
        const name = String((req.body || {}).name || '').trim();
        if (!name) {
            sendJson(res, { code: 400, error: '清单名称不能为空' });
            return;
        }
        const pl = await createPlaylist(dataDir, name);
        sendJson(res, { code: 200, playlist: pl });
    }

    async function rename(req: ReqLike, res: http.ServerResponse) {
        const body = (req.body || {}) as { id?: string; name?: string };
        if (!body.id || !String(body.name || '').trim()) {
            sendJson(res, { code: 400, error: '缺少 id / name' });
            return;
        }
        const ok = await renamePlaylist(dataDir, body.id, String(body.name));
        if (!ok) {
            sendJson(res, { code: 400, error: '默认清单「收藏」不能改名' });
            return;
        }
        sendJson(res, { code: 200, ok: true });
    }

    async function remove(req: ReqLike, res: http.ServerResponse) {
        const body = (req.body || {}) as { id?: string };
        if (!body.id) {
            sendJson(res, { code: 400, error: '缺少 id' });
            return;
        }
        const ok = await deletePlaylist(dataDir, body.id);
        if (!ok) {
            sendJson(res, { code: 400, error: '默认清单「收藏」不能删除' });
            return;
        }
        sendJson(res, { code: 200, ok: true });
    }

    /** 加入。entries 是卡片快照数组（v1 前端一次只送一张，留数组是为 P2 批量） */
    async function add(req: ReqLike, res: http.ServerResponse) {
        const body = (req.body || {}) as { id?: string; entries?: CardSnapshot[] };
        if (!body.id) {
            sendJson(res, { code: 400, error: '缺少 id' });
            return;
        }
        const entries = body.entries ?? [];
        if (!entries.length) {
            sendJson(res, { code: 400, error: '没有要加入的条目' });
            return;
        }
        const items: PlaylistItem[] = [];
        for (const e of entries) {
            const id = deriveIdentity(e.dir);
            if (!id) {
                sendJson(res, { code: 400, error: `认不出这块盘的身份：${e.dir || '(空)'}` });
                return;
            }
            items.push({
                id: `it_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
                serial: id.serial,
                relPath: id.relPath,
                name: e.name,
                ext: e.ext,
                type: e.type,
                size: e.size ?? 0,
                sig: sigOfThumbName(e.thumb),
                files: e.files,
                addedAt: Date.now(),
            });
        }
        const pl = await addItems(dataDir, body.id, items);
        if (!pl) {
            sendJson(res, { code: 404, error: '清单不存在（可能已被删除）' }, 404);
            return;
        }
        sendJson(res, { code: 200, ok: true, count: pl.items.length });
    }

    /**
     * 移除。前端给的是**当前形态的 key**（`dir/真名`）—— 它不知道条目 id，
     * 而盘符/序列号的映射只有服务端知道 ⇒ 这里把 key 翻成条目 id 再删。
     * 重复加入的同 key 条目只移除第一个（加入次序即列表次序，符合直觉）。
     */
    async function removeItem(req: ReqLike, res: http.ServerResponse) {
        const body = (req.body || {}) as { id?: string; key?: string };
        if (!body.id || !body.key) {
            sendJson(res, { code: 400, error: '缺少 id / key' });
            return;
        }
        const pl: Playlist | undefined = (await loadPlaylists(dataDir)).find(p => p.id === body.id);
        if (!pl) {
            sendJson(res, { code: 404, error: '清单不存在（可能已被删除）' }, 404);
            return;
        }
        const drives = await getDrives();
        const bySerial = new Map(drives.map(d => [d.serial, d.drive]));
        const hit = pl.items.find(it => keyOfItem(it, bySerial.get(it.serial) ?? '') === body.key);
        if (!hit) {
            sendJson(res, { code: 200, ok: false, message: '这个条目已不在清单里' });
            return;
        }
        await removeItemById(dataDir, body.id, hit.id);
        sendJson(res, { code: 200, ok: true });
    }

    return [
        ['/playlists', (req, res) => {
            if (req.method?.toUpperCase() === 'GET') return listPlaylists(req, res);
            return sendJson(res, { code: 405, error: 'method not allowed' }, 405);
        }],
        ['/playlistItems', (req, res) => {
            if (req.method?.toUpperCase() === 'GET') return listItems(req, res);
            return sendJson(res, { code: 405, error: 'method not allowed' }, 405);
        }],
        ['/playlistCreate', (req, res) => {
            if (req.method?.toUpperCase() === 'POST') return create(req, res);
            return sendJson(res, { code: 405, error: 'method not allowed' }, 405);
        }],
        ['/playlistRename', (req, res) => {
            if (req.method?.toUpperCase() === 'POST') return rename(req, res);
            return sendJson(res, { code: 405, error: 'method not allowed' }, 405);
        }],
        ['/playlistDelete', (req, res) => {
            if (req.method?.toUpperCase() === 'POST') return remove(req, res);
            return sendJson(res, { code: 405, error: 'method not allowed' }, 405);
        }],
        ['/playlistAdd', (req, res) => {
            if (req.method?.toUpperCase() === 'POST') return add(req, res);
            return sendJson(res, { code: 405, error: 'method not allowed' }, 405);
        }],
        ['/playlistRemove', (req, res) => {
            if (req.method?.toUpperCase() === 'POST') return removeItem(req, res);
            return sendJson(res, { code: 405, error: 'method not allowed' }, 405);
        }],
    ];
}
