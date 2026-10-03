/**
 * 管理助手 · 找缺封面（**零读盘**）
 * ===========================================================================
 * 对应 PRD AC-1：「给定缓存含 M 个已知无封面影片，点'找缺封面'精确列出 M 条；
 * **移动盘读取 = 0**（拔盘可跑通）」。
 *
 * 全部判据来自缓存文档，**一次都不碰盘**。这是整个模块的第一原则（用户铁律：
 * 减少移动硬盘读写），也是它能"拔盘可用"的原因。
 *
 * ── 判据从哪来：先看清缓存里长什么样 ──────────────────────────────────────
 * 界面用 `mode='cover'` 扫描（`FileFinder:637` 的 SCAN_MODE），一层目录存成一条文档，
 * `data` 里只会出现三类条目：
 *
 *   ① `type:'video'`  —— 这一层里的**裸视频**（同层没有能收敛它的图片）
 *   ② `type:'image'`  —— **收敛出来的影片封面卡**。`name` = 封面图文件名（去扩展名）。
 *                        能收敛说明这个位置**已经有脸了** → 不是目标。
 *   ③ `type:'folder'` —— 子目录。`avatar` 有值 = 子目录里有 `cover.jpg`/`avatar.jpg`
 *                        （= 已经有脸）；`avatar` 空 = **没脸**。
 *
 * ⚠️ 关键：`handleCover`（`server/index.ts:315-415`）**只看有没有图片，不看校验文件名**，
 * 但**卡片名 = 封面图文件名去扩展名**（`:396`）。所以"写哪个文件名"不是随便选：
 *   - 影片在**文件**形态（裸视频）→ 写 `<视频同名>.jpg`（S0 实测：写 cover.jpg 不会变封面卡，
 *     只会让这个目录变成一个还得点进去的文件夹）
 *   - 影片在**目录**形态（一部片一个文件夹）→ 写该目录里的 `cover.jpg`（目录的脸）
 *
 * ── 两类目标 ──────────────────────────────────────────────────────────────
 *   ① 裸视频 → `{kind:'file', dir, name, writeRel: <dir>/<name>.jpg}`
 *   ② 没脸子目录 → `{kind:'dir', dir, name, writeRel: <dir>/<name>/cover.jpg}`
 *
 * ② 的**闸门是番号解析**：目录名认不出番号的一律跳过（"字幕"/"新建文件夹"这类
 * 天然被挡在门外），对应 PRD §9「认不出番号，已跳过」。
 *
 * ── 一个必须避开的坑：影片"文件形态" vs "目录形态"的写入位置不同 ──────────
 * S0 实测：往**影片目录**里写 `<视频同名>.jpg` **不会**让目录在上一层长出脸 ——
 * 上一层只看 `cover.jpg`/`avatar.jpg`（`makeDirCover`）。所以：
 *
 *   影片目录 `ABC-123/` 里的裸视频 → 目标必须是 `ABC-123/cover.jpg`（给目录长脸），
 *   **不是** `ABC-123/ABC-123.jpg`（那个只有点进目录才看得到，上一层依然是文件夹）。
 *
 * 判据是**这一层目录自己的名字**：名字里能解析出番号（`ABC-123`、`ABC-123 4K`）
 * 就说明它是影片目录，它的裸视频汇成这一层的 `cover.jpg`。
 * 顺带正好满足 AC-2：3 个分卷 → 汇成 1 个目标 → 只抓 1 次封面、共用一张。
 *
 * ── 深度重扫（零抽帧版，用户 2026-09-25 拍板："不要抽帧"）──────────────────
 * 缓存会过期：apply 写完失效的目录没人浏览就对扫描**不可见**；用户手动删图后缓存
 * 还停在"有脸"。`deepScanMissingCovers` 对这些目录做**纯 readdir+stat 的实时清单**
 * （不生成缩略图、不抽帧、**不写缓存**），替换掉缓存里的旧貌后跑**同一套规则**。
 *
 * 为什么可以零抽帧：规则只消费 `type / name / ext / files / avatar有无`。
 * `liveHandleCover` 复刻 handleCover 的**形态判断**（有没有子目录、有没有图片），
 * 把唯一的重活——缩略图生成——摘掉。两条真机踩出来的铁律：
 *   ① 有脸的子目录**不探自己的清单**（缓存世界的不变量：有脸的目录从不拥有自己的
 *      文档，规则从来只看得到无脸目录的内部 —— 破坏它 = 有封面的全被误报）；
 *   ② "有脸" = handleCover 收敛成功（**任何一张图片**），不是只认两个固定名 ——
 *      片子文件夹自带 `番号.jpg` 是常态，按固定名探会误报翻倍。
 */
import * as fsasync from 'node:fs/promises';
import type { FileInfo } from '../index';
import { findCache, loadMeta } from '../nedb';
import { VIDEO_EXT } from '../videoExt';
import { getDrives } from '../../utils/driveIdentity';
import { parseTitle } from './match';

/** 一次扫描最多看多少条缓存文档 —— 防止在盘根触发时把主进程按住 */
const MAX_DOCS = 3_000;

/**
 * 目标的写入形态。三者对应三种**互不相同的写盘动作**（见 apply.ts 的 buildGroups）：
 *
 *   - `file`  —— 裸视频：建番号文件夹、把分卷 rename 进去、封面写进文件夹（**会搬文件**）
 *   - `dir`   —— 没脸的影片目录：只写 `<目录>/<目录名>.jpg`（**只新增，不搬**）
 *   - `cover` —— **已经有脸**、但用户要换掉它：覆盖那张脸自己（`dir/<封面图名>.<ext>`），
 *                并**先备份原图**（**只覆盖一个文件，不搬、不建目录**）
 *
 * ⚠️ `cover` 是 2026-10-02「换封面」新增的。它与 `dir` 的关键区别是：
 * `dir` 写的是**新文件**（`<目录名>.jpg`，`handleCover` 会把旧的 `avatar.jpg`/`cover.jpg`
 * 摘掉，所以旧文件根本不用动 —— 零破坏）；而 `cover` 写的是**用户已有的那个文件**，
 * 是破坏性覆盖，因此必须备份。
 */
export type TargetKind = 'file' | 'dir' | 'cover';

export interface ScanTarget {
    kind: TargetKind;
    /** 目标所在目录（盘内相对路径，'' = 盘根） */
    dir: string;
    /** 影片文件名（不含扩展名）/ 子目录名 —— 既是查询词，也是写入名的来源 */
    name: string;
    /** 将要写入的文件（盘内相对路径） */
    writeRel: string;
    /**
     * 只对 `kind:'file'` 有意义：**源视频自己的完整相对路径**（含扩展名）。
     * apply 的「文件夹化搬迁」要靠它把视频 rename 进番号文件夹 —— 只知道 writeRel
     * 反推不出源文件（writeRel 是 `名字.jpg`，丢了真实扩展名）。
     */
    srcRel?: string;
    /**
     * 只对 `kind:'dir'` 有意义：该子目录**自己**的缓存在不在、里面有没有视频。
     * `undefined` = 这个子目录从没被扫过，我们只能靠目录名判断（界面上应提示"较不确定"）。
     */
    hasVideo?: boolean;
    /**
     * 该拿哪个词去站点搜。
     *
     * ⚠️ **目前只有 `collectFaces`（换封面）会设它**，理由见那里的 `queryOf()`：
     * 封面卡条目的 `name` 是**封面图文件名**（可能是 `cover` / `1` 这种），
     * 拿它解析番号必然失败 ⇒ 那批目标会在抓取端被静默跳过。
     * 扫描阶段就知道"该搜什么"，比让抓取端瞎猜靠谱。
     *
     * `scanMissingCovers`（补封面）**不设它** ⇒ `grab` 回落到 `parseTitle(name)`，
     * 那条既有路径的行为**一个字没变**。
     */
    query?: string;
}

export interface ScanResult {
    serial: string;
    /** 扫描范围（盘内相对路径，'' = 盘根） */
    scope: string;
    targets: ScanTarget[];
    /**
     * **认不出番号**的条目明细。
     *
     * ⚠️ 这不是"失败清单"，是**另一类问题**（用户 2026-09-25 明确指出："有些根本就不是番号，
     * 是我乱打的"）。那些自制品 / 合集 / 自拍在番号站上**本来就不存在对应作品** ——
     * 硬拿名字去搜只会搜到**别人的**片子，然后写错封面。
     * 所以正确行为是**先列出来给用户**（界面支持行内"手动填 URL"），而不是自动去猜。
     * 完整返回、不截断：界面要靠它渲染清单。
     */
    unmatched: ScanUnmatched[];
    /**
     * 因为是**分类目录**（自己里面还有子目录）而没补的数量。
     * 这是**正确行为、不是问题** —— 给分类目录塞一张封面会把"分类"画成"作品"。
     * 所以只计数、不进 `unmatched`（它不该出现在"需要你处理"的清单里）。
     */
    skippedCategory: number;
    /** 看了多少条缓存文档 */
    scannedDocs: number;
}

export interface ScanUnmatched {
    /** 条目所在目录（盘内相对路径） */
    dir: string;
    /** 视频文件名（不含扩展名）/ 子目录名 */
    name: string;
}

/** 盘内相对路径拼接。**本地实现，不从 server/index.ts 引** —— 那会形成运行时循环依赖 */
function joinRel(parent: string, name: string): string {
    return parent ? `${parent}/${name}` : name;
}

/** 取路径的最后一段（'' → ''） */
function baseName(rel: string): string {
    if (!rel) return '';
    const i = rel.lastIndexOf('/');
    return i === -1 ? rel : rel.slice(i + 1);
}

/** 取路径的父目录（顶层 → ''） */
function parentOf(rel: string): string {
    const i = rel.lastIndexOf('/');
    return i === -1 ? '' : rel.slice(0, i);
}

function inScope(relPath: string, scope: string): boolean {
    if (!scope) return true; // 盘根 = 全盘
    return relPath === scope || relPath.startsWith(`${scope}/`);
}

const EXCLUDED = ['System Volume Information', '$RECYCLE.BIN', 'Config.Msi', 'found.000', 'found.001'];
/** 视频扩展名来自单一真相源 `../videoExt`，与 server/index.ts 共用同一份名单 */
const IMAGE_EXT = ['jpg', 'jpeg', 'png', 'bmp', 'gif', 'svg', 'psd', 'webp'];
/** 目录的脸只认这两个固定名（与 DIR_COVER_FILES 同款判据） */
const DIR_COVER_FILES = ['avatar.jpg', 'cover.jpg'];

function getExt(filename: string): string {
    const i = filename.lastIndexOf('.');
    return i === -1 ? '' : filename.substring(i + 1);
}

function getBasename(filename: string): string {
    const i = filename.lastIndexOf('.');
    return i === -1 ? filename : filename.substring(0, i);
}

/**
 * 把文档集（缓存或实时清单）评估成目标/未识别/跳过分类。
 * **规则只有这一份** —— 缓存扫描和深度重扫共用，两边永不出现两套判据。
 */
function evaluateDocs(
    scope: string,
    docs: Map<string, FileInfo[]>,
): { targets: ScanTarget[]; unmatched: ScanUnmatched[]; skippedCategory: number; scannedDocs: number } {
    const targets: ScanTarget[] = [];
    const seen = new Set<string>();
    const unmatched: ScanUnmatched[] = [];
    let skippedCategory = 0;

    /** 加一条"给某个目录长脸"的目标。封面与文件夹**同名**（用户 2026-09-25 拍板）：
     *  AAA-123/AAA-123.jpg。cover.jpg/avatar.jpg 是"目录头像"保留名，助手永不写。 */
    function addFolderFace(folderRel: string, folderName: string, hasVideo: boolean | undefined) {
        const writeRel = joinRel(folderRel, `${folderName}.jpg`);
        if (seen.has(writeRel)) return;
        seen.add(writeRel);
        // dir = 这个目录的父目录（它"所在的那一层"）
        targets.push({ kind: 'dir', dir: parentOf(folderRel), name: folderName, writeRel, hasVideo });
    }

    for (const [dir, entries] of docs) {
        // 同层已经"有脸"的名字集合（收敛出来的封面卡）—— 用来判断裸视频是不是真的没脸
        const faced = new Set(entries.filter(e => e.type === 'image').map(e => e.name));
        // 这一层自己是不是"影片目录"（目录名里带番号）。是的话它里面的裸视频要汇成它的 cover.jpg。
        const selfName = baseName(dir);
        const selfIsMovieDir = !!parseTitle(selfName).id;
        // 这一层里有没有图片 = 有没有脸（handleCover 的收敛判据：任何一张图片就算）。
        // ⚠️ 影片目录折叠（rule ①）前必须过这道闸：深度重扫会**故意**看进写过的目录
        // （apply.log），里面躺着刚写的同名封面图 —— 没有这道闸，分卷名和封面名
        // 对不上（大小写/尾缀），刚写过的会被原样再报一遍（真机 2026-09-25）。
        // 缓存世界这道闸天然成立（有脸目录没有自己的文档），这里把它显式写进规则。
        const hasImage = entries.some(e => e.type === 'image');

        for (const e of entries) {
            // ① 裸视频：同层没有同名封面卡
            if (e.type === 'video') {
                if (faced.has(e.name)) continue;

                // 影片目录里的裸视频 → 目标是"这个目录的脸"，而不是同名的 jpg。
                //
                // ⚠️ **这一判断必须排在下面的"番号闸门"之前**。
                // 反例（真机实测，2026-09-25）：`videos/示例演员E/TST-088/` 里的
                // `TST-088A_FHD` / `TST-088B_FHD` —— 目录名 `TST-088` 本身就是番号，
                // 分卷名解析不出来是**正常的**（分卷本来就该折进目录）。
                // 若先过闸门，同一批文件会**既**产出 `TST-088/TST-088.jpg` 目标、
                // **又**被报成"认不出番号"—— 一个文件两种身份，用户看到的是自相矛盾的清单。
                //
                // 原理：这一层是不是"影片目录"，是**容器**的属性；
                // 容器一旦确定，里面的条目就不需要（也不该）再拿自己的名字去解析。
                if (selfIsMovieDir) {
                    if (hasImage) continue; // 已有脸：什么都不报（这张脸正是我们写的/自带的）
                    addFolderFace(dir, selfName, true);
                    continue;
                }

                if (!parseTitle(e.name).id) {
                    unmatched.push({ dir, name: e.name });
                    continue;
                }
                const writeRel = joinRel(dir, `${e.name}.jpg`);
                if (seen.has(writeRel)) continue;
                seen.add(writeRel);
                targets.push({
                    kind: 'file',
                    dir,
                    name: e.name,
                    writeRel,
                    // 源视频完整路径（含扩展名）—— 文件夹化搬迁用
                    srcRel: joinRel(dir, e.ext ? `${e.name}.${e.ext}` : e.name),
                });
                continue;
            }

            // ② 没脸的子目录
            if (e.type !== 'folder' || e.avatar) continue;

            const childRel = joinRel(dir, e.name);
            const child = docs.get(childRel);

            // 分类目录（里面还有子目录）不补：它不是一部片子，
            // 给它塞一张 cover.jpg 会把"分类"画成"作品"。用户也已说过分类自己做。
            if (child && child.some(c => c.type === 'folder')) {
                skippedCategory += 1;
                continue;
            }

            // 闸门：目录名得能认出番号，否则不知道该去搜什么
            if (!parseTitle(e.name).id) {
                unmatched.push({ dir, name: e.name });
                continue;
            }

            addFolderFace(childRel, e.name, child ? child.some(c => c.type === 'video') : undefined);
        }
    }

    return { targets, unmatched, skippedCategory, scannedDocs: docs.size };
}

/** 从缓存收集文档（零读盘） */
async function gatherCacheDocs(serial: string, scope: string): Promise<Map<string, FileInfo[]>> {
    const metas = (await loadMeta()).filter(
        m => m.serial === serial && m.mode === 'cover' && inScope(m.relPath, scope),
    );

    // 先把范围内的 data 全取出来放内存：下面判断"子目录有没有被扫过 / 是不是分类目录"
    // 要反复回查，逐次 findCache 会把同一份数据读好几遍。
    const docs = new Map<string, FileInfo[]>();
    let scannedDocs = 0;
    for (const m of metas) {
        if (scannedDocs >= MAX_DOCS) break;
        const doc = await findCache(m.serial, m.relPath, m.mode);
        if (doc) docs.set(doc.relPath, doc.data as FileInfo[]);
        scannedDocs += 1;
    }
    return docs;
}

export async function scanMissingCovers(serial: string, scope: string): Promise<ScanResult> {
    const docs = await gatherCacheDocs(serial, scope);
    return { serial, scope, ...evaluateDocs(scope, docs) };
}

/**
 * 实时清单（**纯 readdir + stat**）：不生成缩略图、不抽帧、不写缓存。
 *
 * ⚠️ "有没有脸"必须与 `handleCover`（server/index.ts:315）**逐字同判** ——
 * 那才是缓存世界里"有脸"的定义：纯文件目录里有**任何一张图片**就算（第一个图片当
 * 封面，视频挂 files），不是只认 `cover.jpg`/`avatar.jpg`。下载来的片子文件夹里
 * 大多带着自带的 `番号.jpg` 封面图 —— 按"两个固定名"去探，这几十个全会被误判成没脸
 * （真机实测 2026-09-25：误报翻倍）。所以这里复刻 handleCover 的**形态判断**
 * （`liveHandleCover`），只把缩略图生成摘掉 —— 规则消费的 type/name/ext/files 全保留。
 */
const IMAGE_RE = /\.(jpe?g|png|bmp|gif|svg|psd|webp)$/i;

/**
 * `handleCover` 的零缩略图复刻。返回：
 *   - `FileInfo[]`（单个 image 条目）= 该目录被收敛成封面卡（**有脸**）
 *   - `null` = 保持目录形态（里面有子目录 / 没有任何图片）
 * 判断顺序与 handleCover 逐字一致：先摘掉固定名封面 → 有子目录即 null →
 * 第一个图片当封面、其余挂 files。
 */
async function liveHandleCover(absDir: string): Promise<FileInfo[] | null> {
    const names = await fsasync.readdir(absDir);

    const fileNames: string[] = [];
    for (const name of names) {
        if (name.startsWith('.') || EXCLUDED.includes(name) || DIR_COVER_FILES.includes(name.toLowerCase())) continue;
        let stat: Awaited<ReturnType<typeof fsasync.stat>>;
        try {
            stat = await fsasync.stat(`${absDir}/${name}`);
        } catch {
            continue;
        }
        if (stat.isDirectory()) return null; // 分类目录 → 保持目录形态
        fileNames.push(name);
    }

    let coverIndex = -1;
    let size = 0;
    const files: NonNullable<FileInfo['files']> = [];
    for (let i = 0; i < fileNames.length; i++) {
        const file = fileNames[i];
        if (coverIndex === -1 && IMAGE_RE.test(file)) {
            coverIndex = i;
            continue;
        }
        try {
            const stat = await fsasync.stat(`${absDir}/${file}`);
            size += stat.size;
            files.push({ name: file, size: stat.size });
        } catch { /* 单个文件读不到不影响整个封面 */ }
    }
    if (coverIndex === -1) return null; // 没有图片 → 保持目录形态（没脸）

    const file = fileNames[coverIndex];
    const ext = getExt(file);
    return [{
        dir: '',
        name: getBasename(file),
        isDirectory: false,
        ext,
        files,
        size: size + (await fsasync.stat(`${absDir}/${file}`).then(s => s.size).catch(() => 0)),
        type: 'image',
    }];
}

async function liveList(drive: string, rel: string): Promise<FileInfo[]> {
    const absDir = rel ? `${drive}:/${rel}` : `${drive}:`;
    const names = await fsasync.readdir(absDir);
    const out: FileInfo[] = [];

    for (const name of names) {
        if (name.startsWith('.') || EXCLUDED.includes(name)) continue;

        let stat: Awaited<ReturnType<typeof fsasync.stat>>;
        try {
            stat = await fsasync.stat(`${absDir}/${name}`);
        } catch {
            continue; // 单项失败跳过（与 readFolder 同一姿态）
        }

        if (!stat.isDirectory()) {
            // cover 模式下目录封面图不单独成条目（与缓存扫描同一规则）
            if (DIR_COVER_FILES.includes(name.toLowerCase())) continue;
            const ext = getExt(name);
            out.push({
                dir: rel,
                name: getBasename(name),
                isDirectory: false,
                ext,
                type: VIDEO_EXT.includes(ext.toLowerCase())
                    ? 'video'
                    : IMAGE_EXT.includes(ext.toLowerCase())
                        ? 'image'
                        : 'file',
                size: stat.size,
            });
            continue;
        }

        // 子目录：走 handleCover 同款收敛判断（收敛成功 = 有脸 = image 条目；
        // 保持目录形态 = 没脸或分类，avatar 按 makeDirCover 判据补）
        const coverDir = `${absDir}/${name}`;
        const childRel = joinRel(rel, name);
        const converged = await liveHandleCover(coverDir).catch(() => null);
        if (converged) {
            out.push(...converged.map(i => ({ ...i, dir: rel })));
            continue;
        }

        const info: FileInfo = {
            dir: rel,
            name,
            isDirectory: true,
            ext: '',
            type: 'folder',
            size: 0,
        };
        // 目录自己的脸：makeDirCover 同款判据 —— 只探两个固定名（有子目录的目录
        // 收敛不了，能长脸的只剩 avatar.jpg/cover.jpg 这一个来源）
        for (const cover of DIR_COVER_FILES) {
            try {
                await fsasync.access(`${coverDir}/${cover}`);
                info.avatar = 'live';
                break;
            } catch { /* 下一个名字 */ }
        }
        out.push(info);
    }
    return out;
}

/**
 * 深度重扫：`dirs`（来自 apply.log 的"写过的层"）用实时清单替换缓存后跑同一套规则。
 * 不抽帧、不写缓存；盘不在线时 refreshed=0，结果退化为纯缓存扫描（与普通扫描一致）。
 */
export async function deepScanMissingCovers(
    serial: string,
    scope: string,
    dirs: string[],
): Promise<ScanResult & { refreshed: number }> {
    const docs = await gatherCacheDocs(serial, scope);

    let refreshed = 0;
    if (dirs.length) {
        const drive = (await getDrives()).find(d => d.serial === serial);
        if (drive) {
            for (const rel of dirs) {
                if (!inScope(rel, scope)) continue;
                try {
                    const entries = await liveList(drive.drive, rel);
                    docs.set(rel, entries);
                    refreshed += 1;
                    // ⚠️ 只探**没脸**的子目录。这不是优化，是恢复缓存世界的不变量：
                    // 有脸的目录在缓存世界里从不拥有自己的文档（批量扫描只下钻 folder 条目，
                    // 有脸的被收敛成封面卡；界面对封面卡也只是弹文件列表，不导航）——
                    // 所以"影片目录折进 cover.jpg"那条规则从不会看到有脸目录的内部。
                    // 实时清单若把有脸目录也探一遍，那条规则就会对它们误触发
                    // （真机实测 2026-09-25：有封面的全被报成"影片目录"）。
                    // 有脸 → 跳过（用户删了图的话，avatar 探测自然变空 → 下次就会探到）。
                    for (const e of entries) {
                        if (e.type !== 'folder' || e.avatar) continue;
                        const childRel = joinRel(rel, e.name);
                        // 无脸子目录一律用实时清单（哪怕缓存里有旧文档）—— 深度重扫要的就是"现在"
                        try {
                            docs.set(childRel, await liveList(drive.drive, childRel));
                        } catch { /* 子目录读不到就让它留在"没被扫过"的状态 */ }
                    }
                } catch {
                    // 单目录失败：保留缓存里的旧貌（那里有数据就用数据）
                }
            }
        }
    }

    return { serial, scope, refreshed, ...evaluateDocs(scope, docs) };
}

// ---------------------------------------------------------------------------
// 「换封面」：收集**已经有脸**的条目（零读盘）
// ---------------------------------------------------------------------------

/**
 * 主界面传过来的一个"选中位置"，与 `FileFinder` 网格的条目一一对应：
 *
 *   - `kind:'dir'`  —— 选中的是**目录格子** ⇒ 展开它（含子树）下面**所有**有脸条目。
 *                      这就是"按演员 / 按文件夹"批量：目录名通常就是演员名。
 *   - `kind:'item'` —— 选中的是**某一个格子** ⇒ 只处理这一个。
 *
 * `name` 是**去扩展名**的显示名（与 `FileInfo.name` 同口径），所以带点的目录名
 * 要用 `ext` 拼回真名 —— 与 `server/index.ts` 的 `diskNameOf` 同一条规则。
 */
export interface FacePick {
    dir: string;
    name: string;
    ext?: string;
    kind: 'dir' | 'item';
}

/** 拼出条目在盘上的真名（`name` 去过扩展名，目录名带点时靠 ext 拼回） */
function diskNameOf(name: string, ext?: string): string {
    return ext ? `${name}.${ext}` : name;
}

/**
 * 决定"该拿什么词去站点搜"。
 *
 * ⚠️ **为什么必须有它**（用户真机实测：点了「换封面…」，弹窗里什么都没发生）：
 * 封面卡条目的 `name` 来自 `handleCover` 的 `info.name = getFilename(file)` ——
 * 是**封面图文件名**，可能是 `cover` / `1` / `poster` 这类；拿它去 `parseTitle`
 * 必然认不出番号，于是抓取端一律记成 `no-id` 静默跳过。
 *
 * 兜底顺序（都失败就返回 undefined，让抓取端照旧报 `no-id`）：
 *   ① 条目名自己 —— 有脸的目录名通常就是番号
 *   ② 它**所在层**的名字 —— 影片目录里的条目常常"层名才是番号"
 */
function queryOf(name: string, dir: string): string | undefined {
    const bySelf = parseTitle(name).id;
    if (bySelf) return bySelf;
    const base = baseName(dir);
    if (base) {
        const byDir = parseTitle(base).id;
        if (byDir) return byDir;
    }
    return undefined;
}

/**
 * 把主界面发来的 `dir` 归一成缓存里的**盘内相对路径**。
 *
 * ⚠️ **必须有这一步**：主界面下发的 `item.dir` 是**完整路径** ——
 * `server/index.ts` 的 `toWire()` 最后一句就是 `dir: toFullPath(drive, item.dir)`
 * （存储态才是相对路径）。直接拿它去和缓存里的 `relPath` 比，一条都匹配不上。
 *
 * 三种形态都要认：
 *   · 在线：`H:/影片/演员A`            → `影片/演员A`
 *   · 离线（只读锚点）：`#<serial>/影片/演员A` → `影片/演员A`
 *   · **已经是相对路径**（探针 / 内部调用）→ 原样返回（这个函数是幂等的）
 *
 * 分隔符统一成 `/` —— 存储态的 `relPath` 实测就是 `/`（见 `ANALYSIS-folder-size` §九）。
 */
function relOfPath(dir: string): string {
    let s = dir;
    if (s.startsWith('#')) {
        // 只读锚点 `#<serial>/<relPath>`：`#` 在 Windows 路径里永远不合法，撞不上真路径
        const rest = s.slice(1);
        const cut = rest.indexOf('/');
        s = cut === -1 ? '' : rest.slice(cut + 1);
    } else {
        s = s.replace(/^[A-Za-z]:[\\/]?/, '');   // 盘符（`H:` / `H:\` / `H:/`）
    }
    return s.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
}

/**
 * 从缓存收集"换封面"的目标（**零读盘**，与找缺封面同一姿态）。
 *
 * 只收两类**已经有脸**的条目：
 *   ① `type:'image'`         → `kind:'cover'`：覆盖 `dir/<封面图名>.<ext>`
 *   ② `type:'folder'`+avatar → `kind:'dir'`  ：**新建** `<目录名>/<目录名>.jpg`
 *      （`handleCover` 会摘掉旧的 `avatar.jpg`/`cover.jpg`，新图自动成为脸，旧文件一个不动）
 *
 * ⚠️ **裸视频（`type:'video'`）不收** —— 它没有"当前这张脸"可换，归「补封面」管。
 * 两者互补、不重叠：`scanMissingCovers` 找"没有的"，这里找"有但不想要的"。
 */
export async function collectFaces(serial: string, picks: FacePick[]): Promise<ScanTarget[]> {
    if (!picks.length) return [];

    const docs = await gatherCacheDocs(serial, '');

    /** 要整体展开的目录（盘内相对路径；`relOfPath` 负责把主界面的完整路径归一） */
    const scopes = picks
        .filter(p => p.kind === 'dir')
        .map(p => joinRel(relOfPath(p.dir), diskNameOf(p.name, p.ext)));
    /** 只要这一个（盘内相对路径 = 该条目代表的位置） */
    const singles = new Set(
        picks.filter(p => p.kind === 'item').map(p => joinRel(relOfPath(p.dir), diskNameOf(p.name, p.ext))),
    );

    const out: ScanTarget[] = [];
    const seen = new Set<string>();

    for (const [docDir, entries] of docs) {
        for (const e of entries) {
            // ⚠️⚠️ 基准必须是**条目自己的 `dir`**，不是文档的 key（`docDir`）——
            // 这两者在"收敛出来的封面卡"上**不是一回事**：
            //
            //   ⚠️ 这里**只写函数名、不写行号** —— 行号会随改动漂：本条原先写 `server/index.ts:251`，
            //   增量对账（2026-10-03）改完后它已经漂到 `:300`。写函数名永不失效。
            //   `server/index.ts` 的 `readFolder` 里调
            //   `handleCover(filepath, serial, joinRel(storeDir, file), prevAt)`，
            //   也就是卡片拿到的是**它代表的那个子目录**（`…/演员名/番号`）；
            //   而它落库时挂在**父层文档**（`…/演员名`）的 `data` 里。
            //
            // 用 `docDir` 拼就会**永远差一层** ⇒ 一条都匹配不上。真机实测就是这个：
            // 选了 5 个位置、6 块盘的缓存都查了，全部落空、界面显示"找不到"。
            const atDir = e.dir || docDir;
            const selfRel = joinRel(atDir, diskNameOf(e.name, e.ext));

            // 命中：① 明确点选的这一个 ② 落在被选中的目录（含子树）里
            // ⚠️ 最后那条 `atDir === s` 不能少，而且理由和 `atDir` 一样：
            // 收敛卡片声明的 `dir` **就是它代表的那个子目录**，所以"选中那个目录格子"
            // 时，卡片自己是"属于这个目录"的 —— 靠这条才对得上。
            // （`docDir === s` 那条覆盖不了它：有脸目录没有自己的文档。）
            const hit = singles.has(selfRel)
                || scopes.some(s => docDir === s || docDir.startsWith(`${s}/`) || selfRel === s || atDir === s);
            if (!hit) continue;

            if (e.type === 'image') {
                // 封面卡：脸 = 它自己那个图片文件 → 覆盖它（apply 会先备份）
                if (seen.has(selfRel)) continue;
                seen.add(selfRel);
                out.push({
                    kind: 'cover', dir: atDir, name: e.name, writeRel: selfRel,
                    // ⚠️ 兜底用 **`atDir`**（卡片代表的那个影片目录），不是 `docDir`（父层）：
                    // 封面图文件名认不出番号时，能救场的是"影片目录名"，而父层通常是**演员名**。
                    // 这一处是"层错位"那个 bug 的同型残留 —— 当时 `selfRel`/`dir` 都换成 `atDir` 了，
                    // 偏偏 `query` 漏了；而探针恰好在真库挑到一条"名字本身就是番号"的卡片，
                    // 兜底分支从来没被执行过 ⇒ 测不出来。
                    query: queryOf(e.name, atDir),
                });
                continue;
            }

            if (e.type === 'folder' && e.avatar) {
                // ⚠️ **分类目录**（里面还有子目录，典型就是"演员名目录"）不处理：
                // 给它写 `<目录名>.jpg` **永远不会生效** —— `handleCover` 第一关
                // "有子目录 → return null" 就挡住了（`server/index.ts:341`），
                // 结果只多一个垃圾文件、界面还报"写入成功"。与 `evaluateDocs` 的
                // `skippedCategory` 是**同一道闸**，两边的判据必须一致。
                const child = docs.get(selfRel);
                if (child && child.some(c => c.type === 'folder')) continue;

                // 有脸目录（单片）：新建 <目录>/<目录名>.jpg（与找缺封面**同一规则**，零破坏）
                const writeRel = joinRel(selfRel, `${e.name}.jpg`);
                if (seen.has(writeRel)) continue;
                seen.add(writeRel);
                out.push({
                    kind: 'dir', dir: atDir, name: e.name, writeRel,
                    query: queryOf(e.name, atDir),
                });
            }
        }
    }

    return out;
}
