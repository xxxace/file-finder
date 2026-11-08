/**
 * 女优目录扫描（零读盘）
 * ===========================================================================
 * **只出候选、不做匹配**。匹配是另一个动作，走 `/assistant/avatar/match` 逐条查。
 *
 * 为什么拆开（2026-11-08）：原来这里塞了一段 5 并发 JavBus 查询，整批塞在一个
 * 同步 POST 里 —— 48 个目录能跑 1~2 分钟，界面只有一句"正在检索"，没法暂停、
 * 没法看进度、一条失败就整批等完。拆开之后：
 *   扫描 = 读一层缓存、筛目录       → 毫秒级，不需要进度
 *   匹配 = 查一个人              → 逐条推进，有进度、可暂停、可单条重试
 */
import type { FileInfo } from '../index';
import { findCache } from '../nedb';
import { parseTitle } from './match';
import { cleanActressName } from './gfriends';

export interface AvatarFolder {
    /** 目标子目录在盘内的相对路径（如 "人物/样本甲"） */
    relDir: string;
    /** 原始文件夹名称（如 "[STUDIO] 样本甲"） */
    folderName: string;
    /** 清洗后提取出的名字，匹配时拿它去查 */
    cleanName: string;
}

/** 归一化盘内相对路径 */
export function relOfPath(dir: string): string {
    let s = dir;
    if (s.startsWith('#')) {
        const rest = s.slice(1);
        const cut = rest.indexOf('/');
        s = cut === -1 ? '' : rest.slice(cut + 1);
    } else {
        s = s.replace(/^[A-Za-z]:[\\/]?/, '');
    }
    return s.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
}

/** 拼出条目在盘上的真实显示名 */
function diskNameOf(name: string, ext?: string): string {
    return ext ? `${name}.${ext}` : name;
}

function joinRel(a: string, b: string): string {
    return a ? `${a}/${b}` : b;
}

/**
 * 从一层缓存条目里筛出「缺头像的人物目录」。
 *
 * 三条排除判据（都来自用户已定的口径）：
 *   ① 已经有脸的目录（`sig` 有值）—— 不需要再补；
 *   ② 目录名本身是影片番号的 —— 那是作品不是人（补头像会张冠李戴）；
 *   ③ 清洗后拿不到名字的 —— 匹配必失败，列出来只会制造噪音。
 */
export function pickActorFolders(parentRel: string, entries: FileInfo[]): AvatarFolder[] {
    const out: AvatarFolder[] = [];
    for (const item of entries) {
        if (item.type !== 'folder') continue;
        if (item.sig) continue;

        const folderName = diskNameOf(item.name, item.ext);
        if (parseTitle(folderName).id) continue;

        const cleanName = cleanActressName(folderName);
        if (!cleanName) continue;

        out.push({ relDir: joinRel(parentRel, folderName), folderName, cleanName });
    }
    return out;
}

/** 零读盘扫描：只读当前浏览路径的直属子目录缓存 */
export async function scanActorFolders(serial: string, relPath: string): Promise<AvatarFolder[]> {
    const normRel = relOfPath(relPath);
    const doc = await findCache(serial, normRel, 'cover');
    if (!doc || !Array.isArray(doc.data)) return [];
    return pickActorFolders(normRel, doc.data);
}
