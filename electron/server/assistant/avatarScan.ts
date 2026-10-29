/**
 * 女优目录扫描与 Gfriends 匹配器（零读盘）
 * ===========================================================================
 * 只读当前浏览路径所在层级的缓存文档（findCache），严格筛选当前目录下的直属子文件夹。
 * 自动排除已有头像的文件夹及能够被识别为影片番号的文件夹，并执行 Gfriends 快速匹配。
 */
import type { FileInfo } from '../index';
import { findCache } from '../nedb';
import { parseTitle } from './match';
import { cleanActressName, matchGfriends, getAvatarUrl, ensureGfriendsIndex } from './gfriends';
import type { GfriendsIndex } from './gfriends';

export interface AvatarCandidate {
    /** 目标子目录在盘内的相对路径（如 "JAV/三上悠亚"） */
    relDir: string;
    /** 原始文件夹名称（如 "[S1] 三上悠亚"） */
    folderName: string;
    /** 清洗后提取出的女优名字（如 "三上悠亚"） */
    cleanName: string;
    /** 匹配到的官方归一化名字（如 "三上悠亜"） */
    matchedName: string | null;
    /** 头像下载 URL（CDN 地址） */
    avatarUrl: string | null;
    /** 匹配状态 */
    status: 'matched' | 'unmatched';
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

/** 拼接相对路径 */
function joinRel(a: string, b: string): string {
    return a ? `${a}/${b}` : b;
}

/**
 * 纯函数：根据当前层级条目列表与 Gfriends 索引，过滤出候选女优目录并进行匹配。
 */
export function filterAndMatchCandidates(
    parentRel: string,
    entries: FileInfo[],
    index: GfriendsIndex
): AvatarCandidate[] {
    const candidates: AvatarCandidate[] = [];

    for (const item of entries) {
        // 1. 只看目录
        if (item.type !== 'folder') continue;

        // 2. 已有头像（sig 有值）的直接跳过
        if (item.sig) continue;

        const folderName = diskNameOf(item.name, item.ext);

        // 3. 若目录名自身能解析为影片番号（如 SSNI-001, IPX-123），必须排除
        const parsed = parseTitle(folderName);
        if (parsed.id) {
            continue;
        }

        // 4. 清洗提取女优名；若清洗后为空或纯数字，排除
        const cleanName = cleanActressName(folderName);
        if (!cleanName) continue;

        // 5. 进行 Gfriends 索引匹配
        const match = matchGfriends(cleanName, index);
        const relDir = joinRel(parentRel, folderName);

        if (match) {
            candidates.push({
                relDir,
                folderName,
                cleanName,
                matchedName: match.matchedName,
                avatarUrl: getAvatarUrl(match.avatarPath),
                status: 'matched',
            });
        } else {
            candidates.push({
                relDir,
                folderName,
                cleanName,
                matchedName: null,
                avatarUrl: null,
                status: 'unmatched',
            });
        }
    }

    return candidates;
}

/**
 * 零读盘扫描：读取当前浏览路径的直属子目录并完成 Gfriends 匹配。
 */
export async function scanActressFolders(
    serial: string,
    relPath: string,
    dataDir: string
): Promise<AvatarCandidate[]> {
    const index = await ensureGfriendsIndex(dataDir);
    const normRel = relOfPath(relPath);

    // 模式固定为 'cover'
    const doc = await findCache(serial, normRel, 'cover');
    if (!doc || !Array.isArray(doc.data)) {
        return [];
    }

    return filterAndMatchCandidates(normRel, doc.data, index);
}
