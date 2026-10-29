/**
 * Gfriends 开源女优头像库 · 索引与名称匹配引擎
 * ===========================================================================
 * 基于 GitHub gfriends/gfriends 官方索引（Filetree.json），支持多 CDN 镜像拉取与本地缓存。
 * 提供目录名清洗、番号识别剔除、简繁日汉字归一、别名匹配与多镜像 URL 生成。
 */
import * as fsasync from 'node:fs/promises';
import path from 'node:path';
import { parseTitle } from './match';

export interface GfriendsIndex {
    version: string;
    updatedAt: number;
    /** 归一化名字 (去空格/小写) -> 仓库内相对路径 (例如 "Content/S/三上悠亜.jpg") */
    actors: Record<string, string>;
}

export const GFRIENDS_MIRRORS = [
    'https://fastly.jsdelivr.net/gh/gfriends/gfriends@master/',
    'https://cdn.jsdelivr.net/gh/gfriends/gfriends@master/',
    'https://raw.githubusercontent.com/gfriends/gfriends/master/',
];

/** 简繁日汉字常见差异映射（双向映射到常用日文/繁体写法） */
const KANJI_MAP: Record<string, string> = {
    '亚': '亜',
    '爱': '愛',
    '绘': '絵',
    '泷': '滝',
    '滨': '浜',
    '泽': '沢',
    '广': '広',
    '濑': '瀬',
    '织': '織',
    '桥': '橋',
    '铃': '鈴',
    '枫': '楓',
    '莲': '蓮',
    '优': '優',
    '结': '結',
    '岛': '島',
    '园': '園',
    '黑': '黒',
    '叶': '葉',
    '桦': '樺',
    '樱': '桜',
    '饭': '飯',
    '仓': '倉',
    '实': '実',
    '涩': '渋',
    '浅': '淺',
    '户': '戸',
    '门': '門',
    '馆': '館',
    '鸟': '鳥',
    '鸡': '鷄',
    '条': '條',
    '关': '関',
};

/** 常见艺名别名表（当前名/常见搜索名 -> Gfriends 收录标准名） */
const ALIAS_MAP: Record<string, string> = {
    '河北彩花': '河北彩花',
    '河北彩伽': '河北彩花',
    '相泽南': '相沢みなみ',
    '相沢南': '相沢みなみ',
    '桃乃木香奈': '桃乃木かな',
    '小仓由菜': '小倉由菜',
    '深田咏美': '深田えいみ',
    '深田詠美': '深田えいみ',
    '桥本有菜': '橋本ありな',
    '新有菜': '新ありな',
    '桥本ありな': '橋本ありな',
    '新ありな': '新ありな',
    '山岸逢花': '山岸逢花',
    '山岸あや花': '山岸逢花',
    '田中宁宁': '田中ねね',
    '美谷朱里': '美谷朱里',
    '安斋拉拉': '安斎らら',
    '安斋らら': '安斎らら',
    '宇都宫紫苑': '宇都宮しおん',
    'RION': '安斎らら',
};

/**
 * 清洗原始目录名，提取潜在女优姓名。
 * 若目录名本身是影片番号或纯数字，则返回空字符串（剔除）。
 */
export function cleanActressName(raw: string): string {
    if (!raw) return '';
    const trimmed = raw.trim();

    // 1. 若自身就是影片番号（如 SSNI-001, FC2-PPV-123456），排除
    const parsed = parseTitle(trimmed);
    if (parsed.id && parsed.id.toUpperCase() === trimmed.toUpperCase()) {
        return '';
    }

    // 2. 全局剔除中英文各类方括号、圆括号标签及常见画质/年份标签
    let clean = trimmed
        .replace(/(\[.*?\]|【.*?】|\(.*?\)|（.*?）)/g, ' ')
        .replace(/\b(4k|1080p|720p|hd|fhd|uhd)\b/gi, ' ')
        .replace(/\b(19|20)\d{2}\b/g, ' ')
        .replace(/[\[\]\(\)【】（）]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    // 3. 若清洗后只剩纯数字、无字符或仍匹配番号，排除
    if (!clean || /^\d+$/.test(clean) || (parseTitle(clean).id && parseTitle(clean).id === clean)) {
        return '';
    }

    return clean;
}

/** 将简体字汉字转换为对应的日文/繁体字形 */
export function normalizeChineseKana(name: string): string {
    let res = '';
    for (const char of name) {
        res += KANJI_MAP[char] ?? char;
    }
    return res;
}

/**
 * 在 Gfriends 索引中匹配女优头像。
 * 匹配优先级：
 *   1. 别名表直接映射
 *   2. 原名直接匹配
 *   3. 简繁/日汉字转换后匹配
 *   4. 大小写/去除空格后比对
 */
export function matchGfriends(
    name: string,
    index: GfriendsIndex
): { matchedName: string; avatarPath: string } | null {
    if (!name || !index?.actors) return null;
    const clean = cleanActressName(name);
    if (!clean) return null;

    // 候选名测试队列
    const candidates: string[] = [clean];

    // 别名表展开
    if (ALIAS_MAP[clean]) {
        candidates.push(ALIAS_MAP[clean]);
    }

    // 简繁转换展开
    const kanjiName = normalizeChineseKana(clean);
    if (kanjiName !== clean) {
        candidates.push(kanjiName);
        if (ALIAS_MAP[kanjiName]) {
            candidates.push(ALIAS_MAP[kanjiName]);
        }
    }

    for (const cand of candidates) {
        // 精准匹配
        if (index.actors[cand]) {
            return { matchedName: cand, avatarPath: index.actors[cand] };
        }
        // 忽略大小写及空白比对
        const lower = cand.toLowerCase().replace(/\s+/g, '');
        for (const [key, val] of Object.entries(index.actors)) {
            if (key.toLowerCase().replace(/\s+/g, '') === lower) {
                return { matchedName: key, avatarPath: val };
            }
        }
    }

    return null;
}

/**
 * 根据相对路径生成可访问的 CDN 完整 URL。
 * 对路径中的非 ASCII 文件名进行安全 URI 转义。
 */
export function getAvatarUrl(avatarPath: string, mirrorIndex = 0): string {
    const base = GFRIENDS_MIRRORS[mirrorIndex % GFRIENDS_MIRRORS.length];
    const parts = avatarPath.split('/').map(p => encodeURIComponent(p));
    return `${base}${parts.join('/')}`;
}

/** 递归将 Gfriends Filetree.json 的多层树拍平成 actors 字典 */
export function flattenFiletree(node: any, currentPath: string, result: Record<string, string>) {
    if (!node || typeof node !== 'object') return;
    for (const key of Object.keys(node)) {
        const val = node[key];
        const nextPath = currentPath ? `${currentPath}/${key}` : key;
        if (typeof val === 'string') {
            // 叶子节点：val 可能是 "AI-Fix-黒瀬萌衣.jpg?t=1607433809"
            // 去除末尾查询参数（?t=...）
            const cleanFileName = val.split('?')[0];
            const actorName = key.replace(/\.(jpg|jpeg|png|webp)$/i, '');
            // 保留目录路径（如 Content/z-ラグジュTV/AI-Fix-黒瀬萌衣.jpg）
            result[actorName] = currentPath ? `${currentPath}/${cleanFileName}` : cleanFileName;
        } else if (typeof val === 'object') {
            flattenFiletree(val, nextPath, result);
        }
    }
}

/**
 * 确保本地有最新（或可用）的 Gfriends 索引缓存。
 * 缓存文件：`${dataDir}/gfriends/filetree.json`
 */
export async function ensureGfriendsIndex(dataDir: string, forceUpdate = false): Promise<GfriendsIndex> {
    const cacheDir = path.join(dataDir, 'gfriends');
    const cacheFile = path.join(cacheDir, 'filetree.json');

    await fsasync.mkdir(cacheDir, { recursive: true });

    // 检查本地缓存是否存在且未过期（7天）
    if (!forceUpdate) {
        try {
            const stat = await fsasync.stat(cacheFile);
            const ageDays = (Date.now() - stat.mtimeMs) / (1000 * 60 * 60 * 24);
            if (ageDays < 7) {
                const text = await fsasync.readFile(cacheFile, 'utf8');
                const raw = JSON.parse(text);
                if (raw && raw.actors) {
                    return raw as GfriendsIndex;
                }
            }
        } catch {
            // 本地无缓存或解析失败，继续在线下载
        }
    }

    // 尝试从各个镜像源下载 Filetree.json
    let fetchedText: string | null = null;
    for (let i = 0; i < GFRIENDS_MIRRORS.length; i++) {
        const url = `${GFRIENDS_MIRRORS[i]}Filetree.json`;
        try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 8000);
            const res = await fetch(url, { signal: controller.signal });
            clearTimeout(timer);
            if (res.ok) {
                fetchedText = await res.text();
                break;
            }
        } catch (e) {
            console.warn(`[Gfriends] 从镜像 ${url} 拉取索引失败:`, e);
        }
    }

    if (fetchedText) {
        try {
            const rawTree = JSON.parse(fetchedText);
            const actors: Record<string, string> = {};
            flattenFiletree(rawTree, '', actors);

            const index: GfriendsIndex = {
                version: '1.0',
                updatedAt: Date.now(),
                actors,
            };
            await fsasync.writeFile(cacheFile, JSON.stringify(index), 'utf8');
            return index;
        } catch (e) {
            console.error('[Gfriends] 解析 Filetree.json 失败:', e);
        }
    }

    // 下载失败时的兜底：尝试读取过期的本地缓存
    try {
        const text = await fsasync.readFile(cacheFile, 'utf8');
        return JSON.parse(text) as GfriendsIndex;
    } catch {
        // 全盘失败返回空索引
        return {
            version: '1.0',
            updatedAt: Date.now(),
            actors: {},
        };
    }
}
