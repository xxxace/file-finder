/**
 * JavBus 官方女优大头照解析与检索引擎
 * ===========================================================================
 * 功能：
 * 1. 汉字归一化（简繁日汉字自动对齐，如 三上悠亚 -> 三上悠亜）；
 * 2. 爬取并解析 JavBus 演员搜索结果页面中的官方大头照（.avatar-box）；
 * 3. 本地与内存持久化缓存（0ms 极速命中）；
 * 4. 原生 Chromium net.request 请求穿透并自动携带 Referer 防盗链头。
 */
import * as fsasync from 'node:fs/promises';
import path from 'node:path';
import { net, session } from 'electron';
import { cleanActressName } from './gfriends';

const CHROME_UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export interface JavBusActressResult {
    matchedName: string;
    avatarUrl: string;
    starId: string;
}

export interface JavBusCacheRecord {
    matchedName: string;
    avatarUrl: string;
    starId: string;
    updatedAt: number;
}

/** 常用汉字双向映射表（日文写真站普遍使用繁体/日文新字体） */
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
    '宝': '寶',
    '咲': '咲',
    '步': '歩',
    '圣': '聖',
    '樱': '桜',
    '梦': '夢',
    '实': '実',
    '纱': '紗',
    '华': '華',
    '阳': '陽',
    '树': '樹',
    '遥': '遙',
};

/**
 * 将简体中文名字转换为日文汉字形式，提高 JavBus 命中率
 */
export function toKanjiQuery(name: string): string {
    let res = '';
    for (const ch of name) {
        res += KANJI_MAP[ch] || ch;
    }
    return res;
}

/**
 * 解析 JavBus 搜索结果页面，提取演员官方大头照
 */
export function parseJavBusSearchHtml(
    html: string,
    targetName: string,
    baseUrl = 'https://www.javbus.com'
): JavBusActressResult | null {
    if (!html) return null;

    // 匹配 <a ... class="...avatar-box..." href="...">...</a>
    const boxRegex = /<a[^>]*class=["'][^"']*avatar-box[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let match: RegExpExecArray | null;

    const items: JavBusActressResult[] = [];

    while ((match = boxRegex.exec(html)) !== null) {
        const href = match[1];
        const inner = match[2];

        // 提取 starId: /star/ok8
        const starIdMatch = /\/star\/([a-zA-Z0-9]+)/i.exec(href);
        const starId = starIdMatch ? starIdMatch[1] : '';

        // 提取 img src:
        const imgMatch = /<img[^>]*src=["']([^"']+)["'][^>]*>/i.exec(inner);
        if (!imgMatch) continue;
        let imgSrc = imgMatch[1];
        if (imgSrc.startsWith('/')) {
            imgSrc = `${baseUrl.replace(/\/+$/, '')}${imgSrc}`;
        }

        // 提取 title / span 文本作为演员名字
        let name = '';
        const titleMatch = /title=["']([^"']+)["']/i.exec(imgMatch[0]);
        if (titleMatch && titleMatch[1]) {
            name = titleMatch[1].trim();
        } else {
            const spanMatch = /<span[^>]*>([^<]+)<\/span>/i.exec(inner);
            if (spanMatch && spanMatch[1]) {
                name = spanMatch[1].trim();
            }
        }

        if (name && imgSrc) {
            items.push({
                matchedName: name,
                avatarUrl: imgSrc,
                starId,
            });
        }
    }

    if (!items.length) return null;

    const cleanTarget = targetName.trim();
    const kanjiTarget = toKanjiQuery(cleanTarget);

    // 1. 完全精准匹配
    const exact = items.find(
        it => it.matchedName === cleanTarget || it.matchedName === kanjiTarget
    );
    if (exact) return exact;

    // 2. 包含匹配
    const partial = items.find(
        it => it.matchedName.includes(cleanTarget) ||
              cleanTarget.includes(it.matchedName) ||
              it.matchedName.includes(kanjiTarget) ||
              kanjiTarget.includes(it.matchedName)
    );
    if (partial) return partial;

    return null;
}

const CACHE_FILE = 'javbus-actresses.json';

/**
 * 读取本地 JavBus 演员缓存
 */
export async function readJavBusCache(dataDir: string): Promise<Record<string, JavBusCacheRecord>> {
    const file = path.join(dataDir, CACHE_FILE);
    try {
        const content = await fsasync.readFile(file, 'utf8');
        return JSON.parse(content);
    } catch {
        return {};
    }
}

/**
 * 写入本地 JavBus 演员缓存
 */
export async function writeJavBusCache(
    dataDir: string,
    cache: Record<string, JavBusCacheRecord>
): Promise<void> {
    const file = path.join(dataDir, CACHE_FILE);
    try {
        await fsasync.mkdir(dataDir, { recursive: true });
        await fsasync.writeFile(file, JSON.stringify(cache, null, 2), 'utf8');
    } catch (e) {
        console.warn('[javbus] 写入缓存失败:', e);
    }
}

/**
 * 通过 Chromium net.request 稳健获取 HTML 页面
 */
async function fetchJavBusHtml(url: string, timeoutMs = 8000): Promise<string | null> {
    return new Promise((resolve) => {
        let finished = false;
        const done = (val: string | null) => {
            if (finished) return;
            finished = true;
            resolve(val);
        };

        const timer = setTimeout(() => {
            try { req?.abort(); } catch {}
            done(null);
        }, timeoutMs);

        let req: any;
        try {
            req = net.request({
                url,
                session: session.fromPartition('persist:assistant'),
                useSessionCookies: true,
            });
            req.setHeader('User-Agent', CHROME_UA);
            req.setHeader('Referer', 'https://www.javbus.com/');
            req.setHeader('Accept', 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8');

            req.on('response', (res: any) => {
                if (res.statusCode !== 200) {
                    clearTimeout(timer);
                    done(null);
                    return;
                }
                const chunks: Buffer[] = [];
                res.on('data', (c: Buffer) => chunks.push(c));
                res.on('end', () => {
                    clearTimeout(timer);
                    done(Buffer.concat(chunks).toString('utf8'));
                });
                res.on('error', () => {
                    clearTimeout(timer);
                    done(null);
                });
            });

            req.on('error', () => {
                clearTimeout(timer);
                done(null);
            });

            req.end();
        } catch {
            clearTimeout(timer);
            done(null);
        }
    });
}

let memCache: Record<string, JavBusCacheRecord> | null = null;

/**
 * 检索单个女优的 JavBus 官方头像（带内存与本地磁盘缓存）
 */
export async function searchJavBusActress(
    rawName: string,
    dataDir: string,
    timeoutMs = 8000
): Promise<JavBusActressResult | null> {
    const clean = cleanActressName(rawName);
    if (!clean) return null;

    if (!memCache) {
        memCache = await readJavBusCache(dataDir);
    }

    // 1. 查缓存（支持原名与日文汉字键）
    const kanji = toKanjiQuery(clean);
    if (memCache[clean]) return memCache[clean];
    if (memCache[kanji]) return memCache[kanji];

    // 2. 出网查询，优先使用 searchstar，备用使用 search/star
    const searchTerms = [kanji, clean];
    const uniqueTerms = [...new Set(searchTerms)];

    for (const term of uniqueTerms) {
        const primaryUrl = `https://www.javbus.com/searchstar/${encodeURIComponent(term)}`;
        let html = await fetchJavBusHtml(primaryUrl, timeoutMs);

        if (!html) {
            const fallbackUrl = `https://www.javbus.com/search/star/${encodeURIComponent(term)}`;
            html = await fetchJavBusHtml(fallbackUrl, timeoutMs);
        }

        if (html) {
            const result = parseJavBusSearchHtml(html, term);
            if (result) {
                const record: JavBusCacheRecord = {
                    ...result,
                    updatedAt: Date.now(),
                };
                memCache[clean] = record;
                memCache[kanji] = record;
                writeJavBusCache(dataDir, memCache).catch(() => {});
                return result;
            }
        }
    }

    return null;
}
