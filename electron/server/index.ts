import url from 'node:url';
import http from 'node:http';
import path from 'node:path';
import events from 'node:events';
import * as fs from 'node:fs';
import * as fsasync from 'node:fs/promises';
import dayjs from 'dayjs';
import crypto from 'node:crypto';
import { imageRenditions, videoRenditions } from '../utils/thumbnail';
import {
    BIN_DIR, hasBin, getBin, putBin, putBinEncrypted, listBinNames, binStoreFailed, whenBinReady, binStats,
} from '../utils/binStore';
import { writeZip, listZip, readZipEntry } from '../utils/zip';
import {
    findDriveByLetter, findDuplicatedSerials, getDrives, offlineSerials,
    readRegistry, serialOfDrive, splitPath, syncRegistry, toFullPath,
} from '../utils/driveIdentity';
import type { DriveInfo } from '../utils/driveIdentity';
import {
    BEFORE_RESTORE_PATH, CACHE_DB_PATH, CACHE_VERSION, beginRestore, cacheBackup, endRestore,
    findCache, insertCache, loadMeta, loadSubtreeBytes, migrateLegacyThumbs, readExternalCache,
    reloadFromDisk, removeCache,
} from './nedb';
import type { CacheMeta, OpenMode, SearchCache } from './nedb';
import { LOCAL_TOKEN } from './token';
import config from '../config';
import { createAssistantRoutes } from './assistant';
import { isVideo, VIDEO_MIME } from './videoExt';

const IMAGE_EXT = ['jpg', 'jpeg', 'png', 'bmp', 'gif', 'svg', 'psd', 'webp'];
const excludedFiles = ['System Volume Information', '$RECYCLE.BIN', 'Config.Msi', 'found.000', 'found.001'];

/**
 * "目录自己的脸"的固定文件名 —— 一个目录要拿哪张图当图标，由这张图的名字声明。
 *
 * `avatar.jpg` 是这套机制原来的名字，`cover.jpg` 是实际盘上在用的。两个都得认，
 * 否则"机制在、图也在、就是不生效"。
 *
 * 为什么只认这两个固定名字，不取"目录里第一张图"：目录里第一张图通常是**影片封面**
 * （`ABC-123/ABC-123.jpg`），那是要被收敛成封面条目的东西，拿它当目录图标等于
 * 把一个影片目录画成了自己。这两个名字是唯一明确表达"我是这个目录的脸"的写法。
 * 名字固定还有个好处：探测不需要列目录，直接按名字试就行。
 */
const DIR_COVER_FILES = ['avatar.jpg', 'cover.jpg'];

/**
 * /preview 现场生成大图时的**源文件上限**（8 MB）。
 * 超过就不另存（那种是异常大图，压一压不划算），但仍然当场给它一份能看的，
 * 只是**不带长缓存**（见 previewController 的注释）。
 */
const PREVIEW_SOURCE_MAX = 8 * 1024 * 1024;
const event = new events.EventEmitter();

/** /raw 返回原图时要带的 Content-Type。只列会出现在这个程序里的类型 */
const MIME: Record<string, string> = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', bmp: 'image/bmp',
    gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
    ...VIDEO_MIME,
};

/**
 * 封面文件夹里的一个文件。
 * 只留渲染层真的会用的字段 —— 把整个 fs.Stats 序列化进去是几十个字段的噪音，
 * 而它在每条缓存里都要重复存一遍。
 */
export type FileInfoFiles = {
    name: string;
    size: number;
};

export type FileKind = 'folder' | 'image' | 'video' | 'file';

/**
 * 一个条目。
 *
 * **不要写成 `fs.Stats & {...}`**：那等于把 dev / ino / mode / nlink / uid / gid / rdev /
 * blksize / blocks / atime* / mtime* / ctime* / birthtime* 这 17 个渲染层一个字都不看的
 * 字段，逐条写进 nedb、再逐条发给渲染层（实测下发 JSON 里全都在）。
 *
 * 尤其 `dev` 是**扫描那一刻的卷序列号**。这套设计的前提是「盘符不是身份、序列号才是」，
 * 把 dev 冻进数据等于又抄了一份身份进去 —— 将来谁读 `item.dev` 当当下判断，
 * 拿到的就是上一块盘的身份。
 *
 * 另外 `[key: string]: any` 这个索引签名会让整个类型失去多余属性检查：`item.thmb`
 * 这种拼错编译器一句都不说。字段表写死之后它也没有存在的必要了。
 */
export interface FileInfo {
    /**
     * 条目所在目录。
     * 存储态里是**盘内相对路径**（如 `影片/ABC-123`），下发时才会补上当前盘符 ——
     * 盘符是运行时才确定的东西，写进缓存就等于把它绑死在某一台电脑的某一个 USB 口上。
     */
    dir: string;
    /** 显示名。封面条目取的是**封面图文件名**（不含扩展名），目录取目录名 */
    name: string;
    isDirectory: boolean;
    ext?: string;
    /** 封面文件夹里的其它文件（含视频）。只有 cover 收敛出来的条目才有 */
    files?: FileInfoFiles[];
    type: FileKind;
    /** 字节数。封面条目是目录内所有文件之和 */
    size: number;
    /**
     * **这张源图的标识**（十六进制 sha1，取自**缩略图**字节；⚠️ 不是大图的指纹 ——
     * 一条记录只有这一个字段却要命名两个尺寸，理由与实测证据见 makeRenditions）。
     *
     * 2026-10-04 用这一个字段取代了原来的 `thumb` / `avatar` / `avatarThumbData` / `avatarSrc`
     * （图片已经搬出库、落进 `bin/`，见 docs/DESIGN-PREVIEW-CACHE-2026-10-04.md）。它一次回答三件事：
     *   ① **有没有图** —— 有 sig 就说明这一条出过图；
     *   ② **图在哪** —— `t-<sig>.enc`（网格缩略图）/ `p-<sig>.enc`（预览大图）；
     *   ③ **内容变没变** —— 指纹取自**缩略图本身**：换了同名的封面 ⇒ 缩略图变 ⇒ sig 变 ⇒
     *      **两个 URL 都变** ⇒ 浏览器的 `immutable` 缓存不会拿旧图挡着（主人明确要求的那一条）。
     * 顺带：内容完全相同的两张图共用一个文件（天然去重）。
     */
    sig?: string;
    /**
     * 这张图的**来源文件**自己的字节数。
     *
     * 为什么不能用 `size` 代替：收敛条目的 `size` 是"整组之和"，不是封面图的大小。
     * 复用闸门要判"源变没变"，拿整组之和去比永远不等 ⇒ 每次扫描都白重抽一遍。
     * 迁移来的旧记录**没有这个字段** ⇒ 判为"不知道"，闸门退回只看 mtime（今天的判据）。
     */
    srcBytes?: number;
    /**
     * 这张缩略图的**来源文件**的修改时间（`stat.mtimeMs`）。
     *
     * 只存不发（`pickFileInfo` 是白名单、不含它）。
     *
     * 为什么不能只比 `size`：**同名替换只要内容变了 mtime 一定变，而 size 可能碰巧相同**
     * （等长替换、空文件都是 0）。实测见 `docs/probes/reconcile/` 的 R6 ——
     * 只比 size 时，"改了内容"会被判成"没变"，于是**复用旧图、永久定格**
     * （改动前 F5 会重抽、能更新；改动后如果判据不完整，就再也更新不了）。
     *
     * 三条路径的"来源"不同，但语义统一：
     *   · 普通文件   → 它自己
     *   · 目录的脸   → `avatar.jpg` / `cover.jpg` 那张图
     *   · 收敛封面   → 那张封面图
     * 旧记录没有这个字段 ⇒ 判为"不确定" ⇒ 重抽一次并写入（**不需要升 `CACHE_VERSION`**）。
     */
    srcMtime?: number;
}

type Req<T = any> = http.IncomingMessage & { params?: URLSearchParams; body?: T };

function isImage(ext: string) {
    return ext ? IMAGE_EXT.includes(ext.toLowerCase()) : false;
}

/** 这个文件名是不是"目录封面"。大小写不敏感 —— NTFS 本来就不区分大小写 */
function isDirCover(name: string) {
    return DIR_COVER_FILES.includes(name.toLowerCase());
}

function getExt(filename: string): string {
    const i = filename.lastIndexOf('.');
    return i === -1 ? '' : filename.substring(i + 1);
}

function getFilename(filename: string): string {
    const i = filename.lastIndexOf('.');
    return i === -1 ? filename : filename.substring(0, i);
}

/**
 * 只有**非目录**的条目才会走到这里 —— 是不是目录由调用方用 `stat.isDirectory()` 决定。
 *
 * 原来这里写的是「没有扩展名 → folder」，等于用"文件名里有没有点"猜目录。两个方向都会错：
 * `README`/`LICENSE`/`Makefile` 被猜成目录（点进去是空的），
 * `TST-001.2023`/`v1.2` 这种带点的目录名被猜成文件（点了没反应）。
 * 而渲染层**只认 `type`**（`folder` 显示文件夹图标并可进入、`image`/`video` 出缩略图），
 * 猜错就直接是"点不动"。真相 `stat.isDirectory()` 本来就在手上，零额外开销。
 */
function getFileType(ext = ''): FileKind {
    if (isVideo(ext)) return 'video';
    if (isImage(ext)) return 'image';
    return 'file';
}

/**
 * 盘内路径拼接。父路径为空（盘根）时不能拼出前导斜杠 ——
 * `'' + '/' + 'sub'` 得到 `/sub`，那个空盘根会被写成"绝对路径"的样子。
 */
function joinRel(parent: string, name: string): string {
    return parent ? `${parent}/${name}` : name;
}

/**
 * 图片在 bin 里的文件名。**唯一构造点** —— 写的时候和下发的时候必须拼出同一个名字，
 * 所以前缀与后缀只写在这里一处。
 * `t-` = 网格缩略图、`p-` = 预览大图；两者恒为 JPEG（详见 thumbnail.ts）。
 */
const thumbNameOf = (sig?: string) => (sig ? `t-${sig}.enc` : undefined);
const previewNameOf = (sig?: string) => (sig ? `p-${sig}.enc` : undefined);

/**
 * 统一封面出口：图片和视频都在这里变成**两张**图 —— 网格要的缩略图、点开要的预览大图。
 *
 * 为什么一次出两张：这两张图来自**同一次解码**（视频则是同一帧）。
 * 分开做等于把同一个源解码两遍、视频还要多抽一次帧 —— 那是白读一遍移动硬盘。
 *
 * 为什么图片落成文件而不是留在库里的 base64（2026-10-04 改）：
 *   ① base64 白交 +33%（实测 39 KB 的 JPEG 存成 base64 就是 52 KB；gzip 只能把这一层捞回来，
 *      对 JPEG 本身 0 收益）—— 搬出 JSON 比 gzip 更彻底；
 *   ② 库是**整库载入内存 + 每次启动整库重写**，图片留在库里等于每次启动搬运几十 MB；
 *   ③ 落成**本地**文件不等于"每次浏览都去移动硬盘读"（老注释担心的那件事）——
 *      图片文件在系统盘的数据目录里，与移动硬盘无关。
 *
 * nativeImage 解码是**同步**的，会按住主进程事件循环十几毫秒，
 * 所以每张之间让出一次，保证窗口不"假死"。
 *
 * 返回 `sig` = 这张源图的标识（取自**缩略图**字节的 sha1，两个尺寸共用 —— 见上面那段注释）。
 * **没有它就说明这一条没有图**（解不开 / 抽帧失败），
 * 下发时不会给前端任何 key，界面画成空白卡片 —— 与今天的行为一致。
 */
/**
 * 扫盘时**把写盘从"等它写完"改成"把 promise 交出去"**，让写盘与下一个条目的解码重叠。
 *
 * 实测依据（`docs/probes/perf-tick/`，72 张真素材外推到一屏 216 个条目）：
 *   · 解码 + 缩放 + 两次 JPEG 编码（CPU）：**1.49 秒**
 *   · 写 bin（216 条目 × 2 个文件 = 432 次 write+rename）：**1.39 秒**
 *   两者**量级相当** ⇒ 写盘不是"可以忽略的小开销"，它占整层扫盘 CPU 成本的一半。
 * 而写盘是纯 IO 等待（libuv 线程池），**解码是 CPU** ⇒ 两者天然可以重叠。
 *
 * ⚠️ 不变式仍要成立：**"返回 sig 时这两个文件已经写完"**（`FileInfo.sig` 的注释依赖它）——
 *   所以这里只是"不自己等"，而是把 promise 交给调用方，调用方在**扫描循环结束后统一
 *   `await`**。不放松这个保证。
 *
 * @param pending 调用方准备的收集袋（通常就是本次扫描的 in-flight 写盘列表）
 * @returns 这一条的内容标识（`''` = 没出图）
 */
async function makeRenditions(filepath: string, ext: string, pending: Promise<unknown>[]): Promise<string> {
    let r: { thumb: Buffer | null; preview: Buffer | null } = { thumb: null, preview: null };

    if (isVideo(ext)) {
        // 抽帧写的是系统临时目录，不是移动硬盘
        r = await videoRenditions(filepath);
    } else if (isImage(ext)) {
        // 全程内存：不落盘、不写临时文件。nativeImage 解不了的格式（webp 等）
        // 这里会自己走 ffmpeg 兜底，详见 thumbnail.ts 的 imageRenditions
        r = await imageRenditions(filepath);
    }

    // 指纹 = **这一张源图的标识**，取自**缩略图字节**的 sha1。
    //
    // ⚠️ 这里为什么不用"大图的指纹"（曾一度用它，是错的，实测证据见下）：
    //   一条记录只有**一个** sig 字段，而它要同时命名**两个**尺寸的文件
    //   （`t-<sig>` 缩略图 / `p-<sig>` 大图）⇒ sig 必须锚在**两个都存在的那一个**上。
    //   锚在大图上时，缩略图存成了 `t-<大图指纹>` —— **名字里不含它自己的内容**
    //   （实测：1277 个 t 文件里有 72 个名字与内容不符；p 全部相符）。
    //   后果不是"取错图"（取图只认名字），而是两条真代价：
    //     ① **同一条命名规律有两套**（出库迁移那批锚缩略图、之后新扫的锚大图）
    //        ⇒ 同一张图在两条路径下得到两个不同文件名的 t，天然去重失效、磁盘多一份；
    //     ② 任何"按名字校验内容"的逻辑（将来的完整性检查、跨机比对）都会误判。
    //   锚回缩略图则与 2026-10-04 的出库迁移**完全一致** ⇒ 那 1205 个文件继续有效、零重出。
    //
    // 这样定义之后，`t-` 与 `p-` 是**同一源的两个尺寸**（对称、可解释）：
    // 换了同名封面 ⇒ 缩略图内容变 ⇒ sig 变 ⇒ **两个 URL 都变** ⇒ 浏览器不会拿旧图挡着
    // （主人明确要求的那一条，靠的就是这个因果链）。
    const anchor = r.thumb ?? r.preview;
    if (!anchor) return '';

    const sig = crypto.createHash('sha1').update(anchor).digest('hex');
    // 只登记、不等待（理由见函数头）。`putBin` 内部自己 try/catch 只记日志，
    // 所以这些 promise 永远不会 reject ⇒ 交给调用方统一 await 是安全的。
    if (r.thumb) pending.push(putBin(thumbNameOf(sig)!, r.thumb));
    // 大图是**同一个源标识的另一个尺寸**（不是另一个内容）⇒ 与 t 共用 sig。
    // 迁移来的记录没有大图 ⇒ 这行不会执行 ⇒ 下次扫到时闸门会补（闸门问的是"大图在不在"）。
    if (r.preview) pending.push(putBin(previewNameOf(sig)!, r.preview));

    // 每张之间让出一次事件循环：nativeImage 的解码是**同步**的，不让出的话主进程会连续
    // 卡住十几毫秒 × 条目数（实测 2.44ms 中位、p95 6.5ms）⇒ 窗口会明显发僵。
    // 让出同时也让 libuv 线程池有机会把上面登记的写盘真正跑起来（重叠就是这么来的）。
    await new Promise(r => setImmediate(r));

    return sig;
}

/**
 * 目录自己的脸的缩略图（`avatar.jpg` / `cover.jpg`，见 `DIR_COVER_FILES`）。
 *
 * 逐个名字试，命中一个立刻返回，所以常态是 1 次（命中第一个）或 2 次（都没有）。
 *
 * **为什么用 `access` 探存在性、而不是靠"解码失败"顺带判断**：
 * 原来是直接 `makeThumb`，靠 `nativeImage` 对不存在的文件同样返回空图来当探测。
 * 现在 `imageThumb` 多了一层 ffmpeg 兜底 —— 那个兜底**必须先知道"文件不存在"还是
 * "解码失败"**，因为前者绝不能去起子进程。而 nativeImage 并不区分这两者，
 * 所以这里先把存在性问清楚（1 次 stat），顺带也就保住了"没有目录封面时不多花 IO"这个性质：
 * 库里绝大多数目录只有 `cover.jpg`，于是 `avatar.jpg` 那一趟只花 1 次失败的 stat。
 *
 * 为什么不先 `readdir` 一下子目录再查名单：那是 1 次**目录读取**（要遍历整张目录表），
 * 比 1 次 stat 贵得多 —— 这条结论没变。
 */
async function makeDirCover(
    dirPath: string,
    serial: string,
    /** 这个目录的**盘内相对路径**。它同时是增量对账里"这张脸取自哪个源"的查找键 */
    dirRel: string,
    prev: Map<string, FileInfo> | undefined,
    /** 见 makeRenditions 的 @param pending：只登记不等待，由调用方在扫描结束后统一 await */
    pending: Promise<unknown>[],
): Promise<{ sig: string; mtime: number; bytes: number } | null> {
    for (const name of DIR_COVER_FILES) {
        const filepath = `${dirPath}/${name}`;
        let stat: fs.Stats;
        try {
            // `stat` 而不是 `access` —— 原先只为探存在性，现在顺带取 mtime 与字节数。
            // 它们在系统调用层是同一件事（读同一个 inode / MFT 记录）⇒ **不多读一次盘**。
            stat = await fsasync.stat(filepath);
        } catch {
            continue;
        }
        // ★ 复用闸门：上次这张脸**取自同一个源、且那个源此后没被改过** ⇒ 不重抽。
        //   ⚠️ 判据里必须有 mtime **和** 字节数：只比 mtime 会漏掉"等长替换 + mtime 被保留"
        //   （同步工具会干这事）。命中就沿用旧指纹 —— 图没重出，指纹当然也不该变。
        const hit = prev?.get(dirRel);
        if (hit?.sig && hit.srcMtime === stat.mtimeMs && hit.srcBytes === stat.size
            && hasBin(previewNameOf(hit.sig))) {
            return { sig: hit.sig, mtime: stat.mtimeMs, bytes: stat.size };
        }
        const sig = await makeRenditions(filepath, 'jpg', pending);
        if (sig) return { sig, mtime: stat.mtimeMs, bytes: stat.size };
    }
    return null;
}

/**
 * 扫一层目录。
 * mode === 'cover' 时，子目录会被收敛成"一张封面 + 文件清单"。
 *
 * `storeDir` 是**写进 `item.dir` 的那个值**，由调用方声明：写缓存时给盘内相对路径，
 * 不缓存的降级路径给完整路径。原来是在函数内部拿 `relOf()` 从 diskDir 反推 ——
 * 那等于让一个字符串操作隐式决定数据的存储形态，调用方想说什么都插不上手。
 */
async function readFolder(
    diskDir: string,
    mode: string,
    serial: string,
    storeDir: string,
    /** 上一次这一层的条目。给了就**对账**（没变的缩略图不重抽），不给就是全量 */
    prev?: FileInfo[],
): Promise<FileInfo[]> {
    /**
     * 本次扫描过程中"已登记但还没等完"的写盘（见 makeRenditions 的 @param pending）。
     * 收敛封面（handleCover）共用这一个袋子 ⇒ 一屏之内所有条目的写盘都能与解码重叠。
     * 唯一出口是函数末尾的 `flushRenditions` —— 它在**返回之前**等完，
     * 所以"调用方拿到 sig 时那两个文件一定已经在盘上"这条不变式没有被放松。
     */
    const pending: Promise<unknown>[] = [];

    let files: string[];
    try {
        files = await fsasync.readdir(diskDir);
    } catch (e) {

        console.error('[readFolder] 读取目录失败:', diskDir, e);
        // ⚠️ **「读不到」不等于「空目录」—— 必须抛出去，绝不能 `return []`。**
        // 返回 [] 会一路走到 scanAndCache，被当成"这一层就是空的"写进缓存，
        // 把那条真实记录覆盖成 count:0；而"为什么读不到"（I/O 错误 / 权限 /
        // 盘没就绪 / UNC 瞬时断）就此永久消失。用户看到空网格 + 零提示，只会以为数据丢了。
        // 实测复现（ACL 拒绝读目录 = EPERM）见 docs/UX-DESIGN-INPUT-2026-09-24.md §2.3。
        // 只有 readdir **成功且返回 0 项** 才是"真的空目录" —— 那种情况才该走下面的空数组。
        const code = (e as NodeJS.ErrnoException)?.code ?? 'UNKNOWN';
        // `kind` 是给前端用的**机器可读**分类，由 `route()` 原样透传、
        // 由 `request.ts` 的 ApiError 接住。前端据此决定横幅文案与"要不要让他重试"，
        // **不是**去 match 这里的文案 —— 那样文案改一个字，判别就静默失效。
        const err = new Error(`读不到这个文件夹（${code}）`) as Error & { kind?: string };
        err.kind = 'unreadable';
        throw err;
    }

    const folder: FileInfo[] = [];

    // ★★ 增量对账的基线索引 —— **这个函数里唯一的一处**，三条抽帧路径共用它。
    //    键 = `joinRel(item.dir, diskNameOf(item))`：三种条目天然落在同一个键空间里，
    //      · 普通文件   dir=本层    name=文件名       → `本层/文件.jpg`   = 那个文件本身
    //      · 收敛封面   dir=子目录   name=封面文件名    → `子目录/封面.jpg` = 那个文件本身
    //      · 目录的脸   dir=本层    name=目录名       → `本层/目录名`     = 那个目录本身
    //    ⇒ 一个 Map 就回答了"这一项取自哪个源文件"，三种情形都不用特判。
    //
    //    为什么**不**做"整条记录复用"：父层的条目会被子目录的收敛形态改写
    //    （dir 指向子目录、name 变成封面名），按名字对账根本对不上；按"源路径"才对得上。
    //
    //    ⚠️ 它只决定"缩略图要不要重抽"，**不决定条目本身** —— 条目一律重新 readdir + stat
    //    （认出增删靠的正是那个新的 readdir 结果）。
    const prevAt = new Map<string, FileInfo>();
    if (prev) {
        for (const it of prev) prevAt.set(joinRel(it.dir, diskNameOf(it)), it);
    }

    for (const file of files) {
        if (file.startsWith('.') || excludedFiles.includes(file)) continue;
        const filepath = `${diskDir}/${file}`;

        // 逐项 try/catch：任何一项失败（坏符号链接、权限受限的目录）只跳过它自己。
        // 原来整个循环被一个 try 包住，一项 stat 失败会让整个文件夹返回空
        try {
            const stat = await fsasync.stat(filepath);

            if (mode === 'cover' && stat.isDirectory()) {
                // null = 这个子目录既没封面图也没视频，不该收敛 → 落到下面当普通目录
                const converged = await handleCover(filepath, serial, joinRel(storeDir, file), prevAt, pending);
                if (converged) {
                    folder.push(...converged);
                    continue;
                }
            }

            // cover 模式下目录封面图（avatar.jpg / cover.jpg）不单独列成一个条目 ——
            // 它已经用在这个目录的图标上了，再列一遍就是"点开来赫然一张 avatar.jpg"。
            if (mode === 'cover' && isDirCover(file)) continue;

            const ext = getExt(file);
            const info: FileInfo = {
                dir: storeDir,
                name: getFilename(file),
                isDirectory: stat.isDirectory(),
                ext,
                // 是不是目录只认 stat，不靠扩展名猜
                type: stat.isDirectory() ? 'folder' : getFileType(ext),
                // ⚠️ 目录的 `stat.size` 在 Windows 上**恒为 0**（NTFS 目录项不记字节数），
                // 所以这里存进去的就是 0 —— 别试图在这一层补"子树总量"：
                // 这个返回值会被 `scanAndCache` **写进缓存**，而缓存面板的
                // `bytes` = `data.reduce(Σ size)`，补进去就会**双算**（子树被累加两次）。
                // ⇒ 补 size 只在**下发态**做，唯一出口是 `wire()`（那里构造新对象、不碰库）。
                // 详见 docs/CHANGES-2026-10-02.md §六。
                size: stat.size,
            };

            if (info.type === 'folder') {
                // 目录自己的脸（avatar.jpg / cover.jpg）→ 这个目录条目带一张缩略图。
                // `dirRel` 传的是**这一层里这个目录的盘内路径**，与 `prevAt` 的键同构
                const avatar = await makeDirCover(filepath, serial, joinRel(storeDir, file), prevAt, pending);
                if (avatar) {
                    info.sig = avatar.sig;
                    info.srcMtime = avatar.mtime;
                    info.srcBytes = avatar.bytes;
                }
            } else if (info.type === 'image' || info.type === 'video') {
                // ★ 复用闸门（第 2 条抽帧路径）：同名**且同大小**才算"这个文件没变"
                //   ⇒ 上次那张图仍然有效，不重抽。
                //   `makeThumb` 是这一层唯一贵的操作（视频要起 ffmpeg 子进程抽帧、
                //   图片要解码整图）—— "增量收录"省下来的就是它。
                const hit = prevAt.get(joinRel(storeDir, file));
                // ★ 判据是"**来源文件没变**"：大小 **和** mtime 都要对得上。
                //   只比 size 会漏掉"等长替换"（探针 R6 用空文件把这条路径暴露得最清楚：
                //   改了内容、size 还是 0 ⇒ 光比 size 判成"没变" ⇒ 旧图永久定格）。
                // ★ 判据与目录的脸同一套：**源路径 + mtime + 字节数**。
                //   （`hit.size` 对收敛条目是"整组之和"，不是源文件的大小 ⇒ 一律用 `srcBytes`）
                // ★ 复用闸门多问一句：**大图还在不在**。
                //   2026-10-04 出库迁移只搬得走缩略图（库里只有那个），
                //   于是迁移来的记录"缩略图在、大图不在" —— 只比源签名会把它判成"没变"而
                //   直接复用，于是**这一层永远补不上大图**（离线看还是糊的）。
                //   把"大图在不在"算进闸门，任何一次真扫都会顺手把它补齐；补过之后就再也不重出。
                const reused =
                    hit?.sig && hit.size === stat.size && hit.srcMtime === stat.mtimeMs
                        && hasBin(previewNameOf(hit.sig))
                        ? hit
                        : null;
                if (reused) {
                    info.sig = reused.sig;
                } else {
                    const sig = await makeRenditions(filepath, ext, pending);
                    if (sig) info.sig = sig;
                }
                // 两个分支都要记来源 —— 少了它，下一次就判不出"变没变"
                info.srcMtime = stat.mtimeMs;
                info.srcBytes = stat.size;
            }

            folder.push(info);
        } catch (e) {
            console.log('[readFolder] 跳过无法读取的项:', filepath, e);
        }
    }

    // ⚠️ 必须在 return 之前等完：整个函数**只有这一个出口**（上面循环里的 continue/try-catch
    //   都不提前返回）⇒ 不存在"带着没写完的 sig 返回"的路径。
    await flushRenditions(pending);

    return folder;
}

/**
 * 把一个子目录收敛成"一个封面条目"。
 *
 * 判断顺序 —— **先看有没有子目录，再看有没有图片**：
 *
 *   1. 里面还有子目录 → 返回 `null`，**保持目录形态**。
 *      这类是"分类目录"（演员名目录：`cover.jpg` + `TST-237/` + `TST-394/`），
 *      它本身不是一个作品；收敛成一张封面会把里面**所有作品的入口都吃掉**，
 *      而且封面图往往是 `cover.jpg` 这种通用名，卡片上只剩一个认不出的 `cover`。
 *   2. 纯文件目录里没有图片 → 有视频就摊开列出来（「没有封面图就直接当视频文件」），
 *      连视频也没有（空目录）同样保持目录形态。
 *   3. 纯文件目录里有图片 → 收敛：第一个图片当封面，其余文件挂 `item.files`，
 *      双击封面时从 files 里找视频打开。
 */
async function handleCover(
    diskDir: string,
    serial: string,
    storeDir: string,
    prev: Map<string, FileInfo> | undefined,
    /** 与调用方（readFolder）**共用同一个**收集袋：收敛封面也是这一屏的一个条目，
     *  用同一个袋才能让它的写盘跟别的条目的解码重叠（见 makeRenditions 的 @param pending） */
    pending: Promise<unknown>[],
): Promise<FileInfo[] | null> {
    let filenames: string[];
    try {
        filenames = await fsasync.readdir(diskDir);
    } catch (e) {
        console.error('[handleCover] 读取目录失败:', diskDir, e);
        // ⚠️ 返回 `null`（="我没法收敛它，按普通目录列出"），**不要返回 `[]`**。
        // 调用方写的是 `if (converged) { ...; continue; }` —— **空数组是 truthy**，
        // 于是这个子目录会被 `continue` 静默跳过：既没收敛、也没当成目录，
        // **连名字都不出现在列表里**。用户会以为那个文件夹不存在。
        // 返回 null 才会落到下面按普通目录列出 —— 降级成"没有封面"，而不是"不存在"。
        return null;
    }

    // 第一关：里面还有子目录吗？
    // readdir 只给名字，是不是目录必须逐个 stat 确认；顺便把"确定是文件"的那些挑出来。
    const fileNames: string[] = [];
    for (const name of filenames) {
        // 目录封面图（avatar.jpg / cover.jpg）是"这个目录的脸"，不是这个目录里某部片子的封面。
        // 必须在选封面之前就摘掉，否则它会被当成封面候选去收敛 —— 那会把目录里
        // 所有片子都塞进 files 清单，第一层只剩一张脸，片子全消失。
        if (name.startsWith('.') || excludedFiles.includes(name) || isDirCover(name)) continue;

        try {
            if ((await fsasync.stat(`${diskDir}/${name}`)).isDirectory()) {
                return null;      // 分类目录 → 保持目录形态
            }
        } catch {
            continue;             // 连 stat 都失败的项直接忽略
        }

        fileNames.push(name);
    }

    // 第二关：纯文件目录里有封面图吗？
    let coverIndex = -1;
    let size = 0;
    const files: FileInfoFiles[] = [];

    for (let i = 0; i < fileNames.length; i++) {
        const file = fileNames[i];

        if (coverIndex === -1 && /\.(jpe?g|png|bmp|gif|svg|psd|webp)$/i.test(file)) {
            coverIndex = i;
            continue;
        }

        try {
            const stat = await fsasync.stat(`${diskDir}/${file}`);
            size += stat.size;
            files.push({ name: file, size: stat.size });
        } catch {
            // 单个文件读不到不影响整个封面
        }
    }

    if (coverIndex === -1) {
        // 没有封面图 → 保持目录形态。
        //
        // 这里原来会「摊开」（里面有视频就把视频直接列到父层），但那会把**多部片子**的目录
        // 打平到上一层：`示例演员A/` 里直接放着 TST-205、TST-206 两部片子，摊开后第一层就
        // 冒出两个裸视频，和「番号目录收敛成封面」混在一起，粒度完全乱了。
        // 而它和 `示例演员E/`（11 个视频 + 2 个子目录）本来就是同一类东西 —— 演员目录，只是
        // 里面装的片子数不同。真正的分界线是「里面是一部片子还是多部片子」，不是有没有子目录。
        //
        // 所以：第一层只出现「目录」和「封面条目」两种格子，不再出现裸视频。
        return null;
    }

    const file = fileNames[coverIndex];
    const filepath = `${diskDir}/${file}`;

    let stat: fs.Stats;
    try {
        stat = await fsasync.stat(filepath);
    } catch {
        // 列目录之后封面图被删/改名了，这个条目直接消失
        return [];
    }

    const ext = getExt(file);
    const info: FileInfo = {
        dir: storeDir,
        name: getFilename(file),
        isDirectory: false,
        ext,
        files,
        size: size + stat.size,
        type: getFileType(ext),
    };

    // 原代码这里还有一层 if (!isVideo(ext))，但 coverIndex 只会落在上面那条图片正则上，
    // 它一定是图片，那层判断是死分支
    // ★ 复用闸门：`storeDir` 是**这个子目录**的盘内路径、`file` 是封面图名
    //   ⇒ `storeDir/file` 正好是那张封面图的源路径，与 `prevAt` 的键同构。
    //   ⚠️ 这里**不能比 size** —— `info.size` 是整组之和（下面那个 `size + stat.size`），
    //   不等于封面图的大小，拿它比会永远不等、白白重抽。所以只认"源路径 + mtime"。
    const hit = prev?.get(joinRel(storeDir, file));
    // ⚠️ 这里**不能比 `info.size`** —— 它是整组之和，比它永远不等、白重抽。
    //   源文件自己的大小记在 `srcBytes` 里，比的也是它。
    // 同样要把"大图在不在"算进去（理由见 readFolder 里那处闸门的注释）
    const reused = hit?.sig && hit.srcMtime === stat.mtimeMs && hit.srcBytes === stat.size
        && hasBin(previewNameOf(hit.sig)) ? hit : null;
    if (reused) {
        info.sig = reused.sig;
    } else {
        const sig = await makeRenditions(filepath, ext, pending);
        if (sig) info.sig = sig;
    }
    // 同样两个分支都要记 —— 否则下次判不出这张封面变没变
    info.srcMtime = stat.mtimeMs;
    info.srcBytes = stat.size;

    return [info];
}

/**
 * 递归导出整棵目录树。
 *
 * 原版是 `readdirSync` + `statSync` 同步递归 —— 扫一整块移动硬盘（几万个文件）会把
 * 主进程事件循环按住几十秒，窗口直接假死。这里改成异步逐层让出。
 *
 * 这是 `list.txt`（628 KB 的整盘目录树）的产出方：渲染层拿到这棵树之后用 `printTree`
 * 画成 `├──` 文本，再 URL 编码导出。
 */
async function collectCodeList(root: string, level = 0): Promise<Record<string, any>[]> {
    let names: string[];
    try {
        names = await fsasync.readdir(root);
    } catch (e) {
        console.error('[collectCodeList] 读取目录失败:', root, e);
        return [];
    }

    const result: Record<string, any>[] = [];

    for (const name of names) {
        const sub: Record<string, any> = { name, level };

        try {
            if ((await fsasync.stat(`${root}/${name}`)).isDirectory()) {
                sub.children = await collectCodeList(`${root}/${name}`, level + 1);
            }
        } catch {
            // 单项读不到不影响整棵树
        }

        result.push(sub);
    }

    return result;
}

async function getFileTree(req: Req, res: http.ServerResponse) {
    const p = req.params?.get('path');
    if (!p) return sendJson(res, []);
    sendJson(res, await collectCodeList(p));
}

/**
 * 下发态的条目：比存储态少了两个"只存不发"的字段。
 *
 * 类型上必须真的把它们减掉，不能写成 `FileInfo` —— 那等于让类型撒谎
 * （调用方会以为那两坨 base64 还在）。原来的 `stripThumbData` 就是用
 * `Omit<...>` 表达这件事的，白名单重建把这层含义接管了过来。
 */
/**
 * 下发态 = 存储态 + 图片的**名字**（`thumb` / `avatar` / `preview`）。
 *
 * 存储态里只有内容指纹 `sig`（+ 来源签名），前端要的是能直接请求的名字，
 * 所以在唯一出口 `wire()` 里现拼（顺便做一次"这个文件在不在"的内存判断）。
 */
export type WiredFileInfo = WiredBase & {
    /** 网格图片名（`t-<sig>.enc`）。为空 = 这一条没有图，界面画空白卡片 */
    thumb?: string;
    /** 目录的脸：与 thumb 同一个文件，只是渲染层用不同尺寸显示（70%） */
    avatar?: string;
    /** 预览大图名（`p-<sig>.enc`）。**可能还没有** —— 老条目会在第一次看时才补 */
    preview?: string;
    /** 预览大图**此刻**是否已存在于本地（缺了就得靠 `p` 参数现场生成，见 /preview） */
    previewReady?: boolean;
};

type WiredBase = Omit<FileInfo, 'sig' | 'srcMtime' | 'srcBytes' | 'thumb' | 'avatar' | 'preview' | 'previewReady'>;

/**
 * 存储态 → 下发态：**只保留渲染层真正用得到的字段**（白名单）。
 *
 * 为什么是白名单：条目可能来自上一版写进库里的记录，黑名单对"我不认识的多余字段"一律放行
 * （实测：旧记录会把 17 个 `fs.Stats` 字段、含扫描当刻的卷序列号 `dev`，原样发给渲染层）。
 *
 * ⚠️ `sig` / `srcMtime` / `srcBytes` 都**不下发**：它们只在服务端用来拼文件名与判"变没变"，
 * 前端一个都不需要（多给一个字段 = 多一处会被误用的状态）。
 */
export function pickFileInfo(raw: FileInfo): WiredBase {
    return {
        dir: raw.dir,
        name: raw.name,
        isDirectory: raw.isDirectory,
        ext: raw.ext,
        files: raw.files?.map(f => ({ name: f.name, size: f.size })),
        type: raw.type,
        size: raw.size,
    };
}

/**
 * 下发的唯一出口：按白名单重建条目 + 拼出图片名（`thumb` / `avatar` / `preview`）。
 *
 * **所有**下发路径都必须过这里，且只留这一处。上一版只有"缓存命中"那条路走 `toWire`，
 * 非盘符路径（UNC、网络位置）直接 `sendJson(readFolder(...))` 就出去了 ——
 * 图片名压根没拼，前端请求 /thumb 全是 404，整个网格是白框。
 * fresh 扫出来的条目过一遍也是幂等的。
 */
/**
 * 条目在**磁盘上的真名**。
 *
 * `name` 存的是"去掉最后一个扩展名"的主体（那是给文件条目拆 name/ext 用的），真名要拼回去。
 * **目录也要拼** —— 目录名带点（`v1.2` / `TST-001.2023`）时 `ext` 非空。
 *
 * 为什么需要它：下面查子树表用的键，来自库里 `relPath` 的段名 = `readdir` 给的**原样名字**，
 * 而 `item.name` 是削过的 ⇒ 直接拿 `item.name` 查，带点目录名会**静默查不到**。
 * 与渲染层的 `fileNameOf` **同构**（那边也是 `ext ? name.ext : name`），别改岔了。
 */
const diskNameOf = (item: FileInfo) => (item.ext ? `${item.name}.${item.ext}` : item.name);

/**
 * `loadSubtreeBytes` 的**降级包装**：缓存库不可用时返回空表。
 *
 * 它跑在 `wire()` 里 —— 那是**每一条下发数据的必经之路**。一旦让异常冒出去，
 * 缓存库损坏 / 正在还原就会从"某个目录没有大小"直接退化成"**整个目录都列不出来**"，
 * 拿小缺陷换大故障。空表 ⇒ 下游跳过补 size ⇒ 保持原值（前端渲染成 `—`），列表照常出。
 */
async function safeSubtreeBytes(serial: string, relPath: string): Promise<Map<string, number>> {
    if (!serial) return new Map();          // 非盘符路径（UNC / 网络位置）不缓存，无表可查
    try {
        return await loadSubtreeBytes(serial, relPath);
    } catch (e) {
        console.log('[wire] 目录大小聚合跳过（缓存库不可用，size 保持原值）:', e);
        return new Map();
    }
}

/**
 * @param live 这一屏是不是**真在盘上**（`toWire`）—— 只读锚点那条路传 false。
 *   它只影响一件事：**要不要下发 `preview` 这个名字**（见下面）。
 */
/** 把某次扫描过程中登记的所有写盘等完（见 makeRenditions 的 @param pending）。 */
async function flushRenditions(pending: Promise<unknown>[]): Promise<void> {
    if (!pending.length) return;
    // 一次性 take 走：万一将来有别处也 await 同一个袋，不必重复等。
    const all = pending.splice(0, pending.length);
    await Promise.all(all);
}

async function wire(items: FileInfo[], serial = '', relPath = '', live = true): Promise<WiredFileInfo[]> {
    // ── 目录条目的 size 在这里补（**唯一下发出口**，见上面那段注释）──────────────
    // Windows 上目录的 `stat.size` 恒为 0，而"目录多大"没有任何系统调用能直接给出；
    // 又不能在上游的 `readFolder` 补 —— 那个返回值会被 `scanAndCache` 写进缓存，
    // 而缓存面板的 `bytes` = `data.reduce(Σ size)`，补了就是**双算**。
    //
    // ⇒ 只能在下发态补，而且**必须**补在这里：浏览一个**已缓存**的目录走的是
    //    `findCache` 短路，压根不经过 `readFolder` —— 第一版补在 `readFolder` 里，
    //    结果"点刷新（noCache，真扫一遍）"能看到大小、"平时从缓存读"永远看不到。
    //    这里是所有下发路径的唯一出口，放这才"想漏都漏不掉"。
    //
    // ⚠️ 必须**构造新对象**（`{ ...it, size }`），绝不原地改 `items[i].size` ——
    //    `items` 就是 nedb 内存里那个文档的 `data`，原地改会把 size 写进库里、污染 `bytes`。
    const subBytes = await safeSubtreeBytes(serial, relPath);
    const sized = subBytes.size
        ? items.map(it => (it.type === 'folder'
            ? { ...it, size: subBytes.get(diskNameOf(it)) ?? it.size }
            : it))
        : items;

    return sized.map(item => {
        const base = pickFileInfo(item);
        // 图片名在这里**现拼**（唯一出口）。两种角色共用同一个文件：
        // 图片/视频条目 → thumb；目录条目 → avatar（渲染层按 item.avatar 决定画多大）。
        const name = thumbNameOf(item.sig);
        // 「在不在」只看内存集合。不在就不下发 —— 免得网格里一排 404 白框
        // （bin 仓整个没就绪时 `hasBin` 恒假，正好等于"这一版没有图"，界面不会炸）。
        const exists = hasBin(name);
        const isFolder = item.type === 'folder';
        const previewName = previewNameOf(item.sig);
        return {
            ...base,
            thumb: exists && !isFolder ? name : undefined,
            avatar: exists && isFolder ? name : undefined,
            // 预览名**只在这两种情况下发**：
            //   ① 本地已经有这张大图；
            //   ② 这一屏是真盘、而且这一条是**图片** —— 那才可能现场生成（读一次源、存下来）。
            // 离线层、或视频条目，都**不发**：那种请求注定 404（离线没有源可读；视频的图
            // 在扫描抽帧那一刻就有了，缺了就是抽帧失败，再问一次也不会有）。
            // ⇒ 界面上不会再出现"一个必然失败的请求"，缩略图就是当前的最终答案。
            preview: (hasBin(previewName) || (live && item.type === 'image')) ? previewName : undefined,
            previewReady: hasBin(previewName),
        };
    });
}

/**
 * 存储态 → 下发态：把 dir 从盘内相对路径补回**当前**盘符的完整路径。
 *
 * 这一步是整套设计的关键：缓存里不存盘符，所以同一块盘今天挂 H:、明天挂 K: 都不用改数据。
 */
async function toWire(items: FileInfo[], drive: string, serial: string, relPath: string): Promise<WiredFileInfo[]> {
    return (await wire(items, serial, relPath)).map(item => ({ ...item, dir: toFullPath(drive, item.dir) }));
}

/**
 * 只读锚点 —— 用「序列号 + 盘内相对路径」直接寻址一份缓存，**完全不碰盘**。
 *
 * 为什么需要它：拔盘之后缓存其实好端端躺在库里，但按路径寻址（`H:/x`）走不通 ——
 * `findDriveByLetter('H')` 给 null，而且没有任何办法从一个盘符反推"它当初属于哪块盘"。
 * 而**盘符不是身份、序列号才是**（见 driveIdentity.ts 开头那段），
 * 所以一块不在的盘，它唯一正确的地址本来就不是路径，是 `(serial, relPath)`。
 *
 * 为什么写成字符串 `#<serial>/<relPath>`、而不是给接口加一组参数：
 * 渲染层的导航栈、面包屑、双击下钻全都只认一个字符串（`item.dir + '/' + name`）。
 * 让锚点长得像路径，**导航那一整块代码一行都不用改** —— 也不会出现"路径寻址"和
 * "序列号寻址"两套并行的导航。`#` 在 Windows 路径里永远不合法，撞不上真路径。
 *
 * ⚠️ 锚点**只能读缓存**：不扫盘、不写缓存、忽略 `noCache`。这不是省事，是"只读"的定义 ——
 * 盘都没插，界面里就不该有任何一路再去碰盘。缓存里没有的那一层 → `kind:'notCached'`。
 * ⚠️ `/raw` 天然拒绝锚点（`splitPath` 拆不开 `#` 开头的串）→ 锚点**没有任何**
 * 能读到磁盘文件的通道。离线看大图走缩略图（前端 `previewUrl` 已按只读层降级）。
 */
/**
 * 实时路径 → 只读锚点。**盘已经拔掉时**把这一屏降级用。
 *
 * 为什么不能靠 `findDriveByLetter`：盘不在了，它当场返回 null，"这个盘符是谁"就没有答案。
 * 所以问 `serialOfDrive`（盘符 → **最后一次见到**的序列号）。
 * 它可能指向一块已经不在的盘 —— **那正是这里要的**：那块盘的缓存仍然可用，
 * 而锚点 `#serial/relPath` 本来就是缓存里唯一的地址。
 *
 * **零读盘**：只查一个内存 Map，不碰盘。
 */
function anchorOfController(req: Req, res: http.ServerResponse) {
    const raw = req.params?.get('path') || '';
    const parts = splitPath(raw);
    if (!parts) return sendJson(res, { anchor: '' });
    const serial = serialOfDrive(parts.drive);
    if (!serial) return sendJson(res, { anchor: '' });
    sendJson(res, { anchor: toAnchorPath(serial, parts.relPath) });
}

const ANCHOR_PREFIX = '#';

function parseAnchor(raw: string): { serial: string; relPath: string } | null {
    if (!raw.startsWith(ANCHOR_PREFIX)) return null;
    const rest = raw.slice(ANCHOR_PREFIX.length);
    const cut = rest.indexOf('/');
    if (cut === -1) return { serial: rest, relPath: '' };
    return { serial: rest.slice(0, cut), relPath: rest.slice(cut + 1) };
}

/** 和 `toFullPath` 同构：relPath 为空表示那块盘的根，此时不留尾斜杠 */
function toAnchorPath(serial: string, relPath: string): string {
    return relPath ? `${ANCHOR_PREFIX}${serial}/${relPath}` : `${ANCHOR_PREFIX}${serial}`;
}

/**
 * 存储态 → 只读下发态。和 `toWire` 逐字同构，只是把盘符换成锚点。
 *
 * 前缀补的是**条目自己的 `dir`**（不是请求里那一层），和 `toWire` 用 `item.dir` 同一个理由：
 * 条目所在目录才是它的地址。这样下钻拼出的 `#serial/a/b` 和当初写进缓存时的 `relPath`
 * 逐字符一致（大小写也一样）—— `findCache` 是精确匹配，差一个字母就是未命中。
 */
async function toAnchor(items: FileInfo[], serial: string, relPath: string): Promise<WiredFileInfo[]> {
    // 只读锚点：这一屏**没有源可读** ⇒ 不下发"待生成"的预览名（见 wire 的 live 参数）
    return (await wire(items, serial, relPath, false))
        .map(item => ({ ...item, dir: toAnchorPath(serial, item.dir) }));
}

/**
 * 同主键写入链 —— 「删旧 + 插新」必须当成**一个整体**。
 *
 * 为什么需要：`removeCache + insertCache` 是两步非原子的。后台批量扫描（P1）期间
 * 用户随时可能点进同一个目录，两次调用会交错成
 *   扫描A.remove → 用户B.remove → 扫描A.insert → 用户B.insert
 * 于是同一主键**留下两条记录**（insert 不查重），留下一条属于旧时刻的，或者出现
 * "缓存被删了但还没插回来"的空窗（并发读者会当未命中，再触发一次扫描）。
 * 以前只是偶发（要用户恰好点进正在扫的那个目录），加了批量扫描就变成必然。
 *
 * 为什么做成队列，而不是给每个调用方各加一道锁：`scanAndCache` 是这套缓存**唯一**的
 * 写入入口，把两步收进它内部，约束就长在写入这件事自己身上；加锁则是"每个调用方都得
 * 记得锁"—— 以后新增一个写缓存的入口（比如 F5 那条）立刻复发。这和 `wire()` 是唯一
 * 下发出口、`apiUrl()` 是唯一 URL 出口、口令校验挂在唯一请求入口是同一个思路。
 *
 * 键是 `(serial, relPath, mode)`：不同目录之间**不**互相同步 —— 否则扫一整块盘会退化
 * 成"全库串行"。同一个键上一条链，前一个任务失败也照样接着跑（`then(task, task)`），
 * 一条链被一次失败卡死的话，那个目录之后就再也写不进缓存了。
 */
const writeChains = new Map<string, Promise<void>>();

function queueCacheWrite<T>(serial: string, relPath: string, mode: OpenMode, task: () => Promise<T>): Promise<T> {
    // 分隔符用 \u0000：Windows 文件名里不可能出现，不会有 A|B 和 A|B 撞键的歧义
    const key = `${serial}\u0000${relPath}\u0000${mode}`;
    const prev = writeChains.get(key) ?? Promise.resolve();
    const run = prev.then(task, task);

    // 链上挂的必须是**不会 reject** 的尾巴：否则一次失败会让后面每个 then(task, task) 都走 onRejected
    const tail = run.then(() => undefined, () => undefined);
    writeChains.set(key, tail);
    // 链跑空就把槽位收掉，不然这个 Map 会随浏览过的目录数一直长
    void tail.then(() => {
        if (writeChains.get(key) === tail) writeChains.delete(key);
    });

    return run;
}

/**
 * 扫目录并把结果写进缓存。
 * 存储态里 dir 是盘内相对路径，不含盘符。
 */
async function scanAndCache(serial: string, drive: string, relPath: string, mode: OpenMode): Promise<SearchCache> {
    // ★ 取这一层的**旧条目作对账基线**：源文件没变的那些缩略图直接复用，不再重抽。
    //   为什么在这儿查、而不是让调用方传进来：`scanAndCache` 是**唯一**的写缓存口，
    //   它自己保证"读旧 → 读盘 → 写新"是一件事，比要求每个调用方记得传 prev 更漏不掉。
    //   代价只是一次 `findCache` —— **纯内存查询、零读盘**（nedb 启动时整库已载入内存）。
    const prevDoc = await findCache(serial, relPath, mode);
    const data = await readFolder(toFullPath(drive, relPath), mode, serial, relPath, prevDoc?.data);

    const doc: SearchCache = {
        v: CACHE_VERSION,
        serial,
        relPath,
        mode,
        count: data.length,
        data,
        create_at: dayjs().format('YYYY-MM-DD HH:mm:ss'),
    };

    // 「先删后插」两步收进同主键的串行队列 —— 见 queueCacheWrite。
    // 读盘（readFolder）留在队列外面：它慢，而且两个并发扫描各读各的没有危害，
    // 真正会互相破坏的只有"写"这一段。后写的整条覆盖先写的，这正是想要的语义
    await queueCacheWrite(serial, relPath, mode, async () => {
        // 先删后插：nedb 是 append-only，直接 insert 会在文件里留下两份，
        // 而且 findCache 会取到旧的那份
        await removeCache(serial, relPath, mode);
        await insertCache(doc);
    });

    return doc;
}

function sendJson(res: http.ServerResponse, body: unknown, status = 200) {
    const text = JSON.stringify(body);
    res.writeHead(status, {
        'Content-Type': 'application/json;charset=utf-8',
        'Content-Length': Buffer.byteLength(text),
    });
    res.end(text);
}

async function openFolderController(req: Req, res: http.ServerResponse) {
    const raw = req.params?.get('path');
    const mode = (req.params?.get('mode') || 'folder') as OpenMode;
    const noCache = req.params?.get('noCache') === 'true';

    if (!raw) return sendJson(res, []);

    // ⓪ 只读锚点（`#序列号/盘内路径`）—— 拔盘之后看缓存走这条。
    //    必须放在最前面：锚点不是路径，`splitPath` 拆不开它，
    //    更不能让它流到下面任何一支去（那支会拿它当 UNC 去真读盘）。
    const anchor = parseAnchor(raw);
    if (anchor) {
        // `noCache` 在这里没有意义：只读视图的"源"就是缓存，没有第二种读法。
        // 忽略它（而不是报错），前端的「刷新」在只读层上因此是个安全的空动作。
        const cached = await findCache(anchor.serial, anchor.relPath, mode);
        // 抛而不是 return：`route()` 那个咽喉点会把它变成 `500 + kind`，
        // 和 `readFolder` 抛错走同一条路（这也是当初做咽喉点的原因）。
        if (!cached) {
            const err = new Error('这一层没缓存过，只读视图读不到它') as Error & { kind?: string };
            err.kind = 'notCached';
            throw err;
        }
        return sendJson(res, await toAnchor(cached.data, anchor.serial, anchor.relPath));
    }

    // 路径 → 盘身份。拿不到序列号（UNC、网络位置、虚拟盘）就退化成"每次真读、不缓存"：
    // 这类路径不存在"拔了再插盘符会变"的问题，也就没有归属问题
    const parts = splitPath(raw);
    const disk = parts ? await findDriveByLetter(parts.drive) : null;

    // ① 路径压根不是盘符开头（UNC / 网络位置 / 虚拟盘）→ **合法路径**，只是没法缓存。
    //    这类路径不存在"拔了再插盘符会变"的问题，也就没有归属问题。
    //    不缓存，但**必须过 wire()** —— 缩略图是在这一步才登记进内存索引的，漏了它
    //    前端拿到的 key 请求 /thumb 全是 404。dir 原样保留完整路径。
    if (!parts) {
        console.warn('[openFolder] 路径不是盘符开头，本次跳过缓存:', raw);
        return sendJson(res, await wire(await readFolder(raw, mode, '', raw)));
    }

    // ② 是盘符，但**这个盘现在不在**（拔了 / 光驱空仓 / 还没就绪）。
    //    必须**报错**，不能读一把、返回一个空数组 ——
    //    空数组到了前端就是"这个目录是空的"：用户对着空网格拿不到任何解释，
    //    只会以为资料丢了；而缓存其实好端端躺在库里（按路径取不到 serial，
    //    但**从「缓存记录」进来看仍然能看到它** —— 那条入口给的是锚点，见 ⓪）。
    //    `findDriveByLetter` 是**实时 stat** 盘符，所以"盘在不在"这个判断是准的。
    if (!disk) {
        return sendJson(res, { code: 500, error: `盘 ${parts.drive}: 现在不在`, kind: 'offline' }, 500);
    }

    const { serial, drive } = disk;
    const relPath = parts.relPath;

    // 这里原来还有一句 `if (noCache) await removeCache(...)` —— 已删。
    // 它是多余的：noCache 时 cached 必为 null，下面必然走 scanAndCache，
    // 而 scanAndCache 自己就会 removeCache + insertCache。留着它等于在队列之外
    // 又开一个写同一主键的口，那两步就不再是一个整体了（见 queueCacheWrite）。
    // 顺带修掉一个更隐蔽的形态：原来那句会在**真读盘之前**就把旧缓存删掉，
    // 读盘期间并发进来的读者会看到"这个目录没缓存"。
    const cached = noCache ? null : await findCache(serial, relPath, mode);
    const doc = cached ?? (await scanAndCache(serial, drive, relPath, mode));

    sendJson(res, await toWire(doc.data, drive, serial, relPath));
}

/**
 * 缩略图出口。前端只拿到 key，真正的 base64 一直待在主进程内存里，
 * 这样 /openFolder 的响应体可以小到几十 KB。
 */
async function thumbController(req: Req, res: http.ServerResponse) {
    const name = req.params?.get('k') || '';
    // ⚠️ 名字必须**按形状校验**：它是拼进文件路径的，`../` 之类绝不能过
    if (!/^t-[0-9a-f]{40}\.enc$/.test(name)) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        return res.end('bad key');
    }
    const buf = getBin(name);
    if (!buf) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        return res.end('thumb not found');
    }

    res.writeHead(200, {
        'Content-Type': 'image/jpeg',
        'Content-Length': buf.length,
        // 名字里带**内容指纹** ⇒ 同名必同内容 ⇒ 可以永久缓存。
        // 图换了就有新指纹、新 URL，**不会**出现"改了文件还显示旧图"。
        'Cache-Control': 'private, max-age=31536000, immutable',
    });
    res.end(buf);
}

/**
 * 预览大图出口 —— 点开看的那一张。
 *
 * 三种情形（这是它能同时做到"少读盘"和"离线也清晰"的原因）：
 *   ① 本地已有 → 直接给（**0 读盘**，且带 immutable ⇒ 重复打开连请求都不发）；
 *   ② 本地没有、但给了 `p`（源文件的完整路径，只有在线时前端才给）→ **读一次原图、
 *      生成大图、落盘**，然后给。**只此一次**，之后走 ①。老缓存就是这样一条条自我升级的；
 *   ③ 都没有 → 404。前端收到 404 就继续显示缩略图（静默降级，不报错）。
 *
 * ⚠️ **视频永远不会走 ②**：前端对视频不给 `p`（那些片子 5–7GB，绝不能因为"想看大图"
 * 就去读它）；视频的大图在扫描抽帧那一刻就已经生成好了。
 */
async function previewController(req: Req, res: http.ServerResponse) {
    const name = req.params?.get('k') || '';
    if (!/^p-[0-9a-f]{40}\.enc$/.test(name)) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        return res.end('bad key');
    }

    const cached = getBin(name);
    if (cached) {
        res.writeHead(200, {
            'Content-Type': 'image/jpeg',
            'Content-Length': cached.length,
            'Cache-Control': 'private, max-age=31536000, immutable',
        });
        return res.end(cached);
    }

    const filepath = req.params?.get('p') || '';
    // 与 /raw 同一道闸：只服务"盘符:盘内路径"、且挡住 `..`
    if (!filepath || !splitPath(filepath) || filepath.includes('..')) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        return res.end('preview not ready');
    }

    let stat: fs.Stats;
    try {
        stat = await fsasync.stat(filepath);
    } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        return res.end('source missing');
    }
    if (!stat.isFile() || !isImage(getExt(filepath))) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        return res.end('not a cached image');
    }
    // 异常大的图不另存（那种是异常文件）；但仍然给它一份能看的（不留 404）
    const tooBig = stat.size > PREVIEW_SOURCE_MAX;

    const buf = (await imageRenditions(filepath)).preview;
    if (!buf) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        return res.end('cannot build preview');
    }

    // 按**请求的那个名字**存下来 —— 不要在这里改写成"内容指纹"的名字。
    //
    // 为什么（这里曾出过两个错，都是我自己写的）：
    //   ① 早期版本要求"内容指纹 == 请求名字"才落盘 ⇒ 对不上就只给一次、不存
    //      ⇒ **每次点开都重读一遍源**（2026-10-04 主人实测撞上：离线看完还是糊）。
    //   ② 改成"另存成内容指纹的名字 + 302 重定向" ⇒ 记录里那个名字**永远不会被填上**
    //      ⇒ 前端下一屏还是请求它、还是 404、还是再读一遍源。**302 解决不了这个问题**，
    //      因为发起请求的名字来自库、不会因为一次重定向而改变。
    //
    // 现在的语义是「**缓存槽位**」：`p-<sig>` = "记录 sig 所指那张源图的大图版本"。
    // 与 t 一样，`sig` 取自**缩略图内容**，所以这两个名字是**同一源的两个尺寸**、
    // 完全对称（见 makeRenditions 的注释）。由此：
    //   · **懒生成是幂等的** —— 存完之后 `hasBin` 命中 ⇒ 这一张此后 0 读盘；
    //   · 源文件在扫描之后被换掉时，存进去的是新内容、名字仍是旧标识 ——
    //     这与"缩略图也还是旧的"是一致的（**没重扫就没发现变化**，本该如此）；
    //     等哪次真扫到这一层，闸门按 mtime/字节数判出"变了" ⇒ 重出 ⇒ 新 sig ⇒ 新 URL。
    //   · 已知的边界（可接受、极罕见）：两张不同的封面若缩略图字节**恰好完全相同**，
    //     会共用同一个 `p-` 文件 ⇒ 看到同一张大图。384px JPEG 撞到全等的概率极低，
    //     而用"两个字段分别锚两个尺寸"去彻底消除它，要为一个几乎不会发生的情况
    //     多付一个持久化字段 + 一处迁移 —— 不划算（这一条是知情取舍，不是没看见）。
    if (!tooBig) await putBin(name, buf);

    res.writeHead(200, {
        'Content-Type': 'image/jpeg',
        'Content-Length': buf.length,
        // 落了盘才敢长缓存；没落盘（源变了/图太大）就只用这一次，别让浏览器把它钉住
        'Cache-Control': tooBig ? 'no-store' : 'private, max-age=31536000, immutable',
    });
    res.end(buf);
}

async function rawController(req: Req, res: http.ServerResponse) {
    const filepath = req.params?.get('p') || '';

    // 只服务"盘符:盘内路径"这一种形态。用户本来就能浏览整块盘，所以不做白名单，
    // 但要挡住带 .. 的穿越写法
    if (!splitPath(filepath) || filepath.includes('..')) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        return res.end('bad path');
    }

    let stat: fs.Stats;
    try {
        stat = await fsasync.stat(filepath);
    } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        return res.end('not found');
    }

    if (!stat.isFile()) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        return res.end('not a file');
    }

    res.writeHead(200, {
        'Content-Type': MIME[getExt(filepath).toLowerCase()] || 'application/octet-stream',
        'Content-Length': stat.size,
    });

    // 流式读，不把整张图的 Buffer 攒在内存里
    const stream = fs.createReadStream(filepath);
    stream.on('error', () => res.end());
    stream.pipe(res);
}

/**
 * 列出所有盘 + 各自的缓存概况。
 * 缓存界面的第一屏就是它：先选盘，再看那块盘缓存过哪些目录。
 */
async function listDisksController(req: Req, res: http.ServerResponse) {
    /**
     * ⚠️ **默认不再强制重扫盘符**（`?refresh=true` 才扫）。
     *
     * 原来这里写死 `getDrives(true)`，而它挂在**每次打开面板**这条高频路径上：
     * `scanDrives()` 会对 C–Z 每一个盘符做一次 `stat('X:/')`，并顺带无条件写一次 `disks.json`。
     * 用户的第一优先级是"减少对移动硬盘的读写"，而每次都去 stat 一遍盘根，
     * **会不会唤醒一块插着但已休眠的移动硬盘，我没有实测过** —— 不确定的事就不该每天做几十遍。
     *
     * 现在：打开面板走 `getDrives()`（**进程内缓存，一次盘都不扫**）；
     * 只有用户点「刷新」（前端传 `?refresh=true`）才真正重探一次。
     * 代价说清楚：**启动之后新插的盘不会自动出现在列表里**，要按一下「刷新」——
     * 这个取舍用户已经接受（他原话："插上盘不能更新就算了"）。
     */
    const refresh = req.params?.get('refresh') === 'true';
    const drives = await getDrives(refresh);
    // 只有**真探测过**才登记。用缓存列表重复登记，只是把同一份数据再写一遍 `disks.json`
    // —— 那是本地小文件、不是"读盘"问题，但**没有新信息的写就不该做**。
    // 顺带一个语义更正：拿陈旧列表 sync 会把 lastSeenAt 刷成"刚刚见过"，
    // 而那块盘可能早就拔了（这个字段目前只写不读，但错的数据不该主动制造）。
    const registry = refresh
        ? await syncRegistry(drives, dayjs().format('YYYY-MM-DD HH:mm:ss'))
        : await readRegistry();
    // withBytes：顺带算出全库字节合计。纯内存求和（实测 0.07 ms），**不读盘**。
    const metas = await loadMeta({ withBytes: true });

    const stats = new Map<string, { folders: number; covers: number; lastScanAt: string }>();
    for (const m of metas) {
        const s = stats.get(m.serial) || { folders: 0, covers: 0, lastScanAt: '' };
        s.folders += 1;
        s.covers += m.count || 0;
        if (m.create_at > s.lastScanAt) s.lastScanAt = m.create_at;
        stats.set(m.serial, s);
    }

    const empty = { folders: 0, covers: 0, lastScanAt: '' };

    /**
     * ⚠️ 已知盘全集 = 注册表 ∪ **缓存库里出现过的 serial**。
     *
     * 只取注册表的键会漏盘：注册表仅在 `?refresh=true`（用户点「刷新」）时才登记
     * （见上面那个 `syncRegistry` 调用点），于是"插过 / 扫过 / 但从没点过刷新"的盘
     * 不在里面 —— 它的缓存记录还在库里，下拉框里却**没有任何选项**能过滤它。
     *
     * 实测（2026-10-03 真库）：命中 1 块盘 / 3 条记录；同一个原因让顶部「总览」的
     * 目录数（216）与下拉框「全部盘」的目录数（213）对不上，差额正好是这部分。
     * 全集改与缓存库同源后，**只要库里有记录就一定有选项**，结构上不可能再漏。
     */
    const known = new Set([...Object.keys(registry), ...metas.map(m => m.serial)]);
    const offline = offlineSerials(known, drives);

    // 库文件大小：读的是**本地数据文件**的 metadata（`~/.file-finder/searchCache.db`），
    // **不碰任何移动硬盘**。拿不到就不显示（前端按 undefined 处理），不因此报错。
    let dbBytes: number | undefined;
    try {
        dbBytes = (await fsasync.stat(CACHE_DB_PATH)).size;
    } catch {
        dbBytes = undefined;
    }

    const bin = await binStats();

    sendJson(res, {
        disks: [
            ...drives.map(d => ({ ...d, online: true, ...(stats.get(d.serial) || empty) })),
            ...offline.map(serial => ({
                serial,
                drive: '',
                root: '',
                // ⚠️ 必须是 `registry[serial]?.label`：`offline` 现在可能含**只在缓存库里、
                // 从没进过注册表**的盘（这正是上面 `known` 要修的形态）。少了可选链，
                // 一处 `undefined.label` 就让整个 `/getDisks` 变成 500 —— 下拉框直接空掉，
                // 比原来的"少一个选项"严重得多。
                label: registry[serial]?.label || '',
                online: false,
                ...(stats.get(serial) || empty),
            })),
        ],
        // 卷序列号是格式化时写进卷里的，用 Ghost 之类整盘克隆会把两块盘做成同一个身份。
        // 这时盘符是唯一能区分它们的东西，必须提示用户 —— 否则两块盘的缓存会互相串
        duplicated: findDuplicatedSerials(drives),
        /**
         * 面板顶部的「总览」用的只读汇总。
         *
         * 全是**内存里算出来的**（`loadMeta` 已经在内存）+ 一次本地文件的 `stat`，
         * 没有一项会去碰移动硬盘 —— 这是用户定的硬约束（只汇总已有缓存，不读盘）。
         *
         * `bytes` 的语义要写准：它是"**缓存里记录到的字节之和**"，
         * 不是"硬盘上有多少"。措辞在界面上写成「已读到 X」，不能写"当前"/"硬盘上"。
         * 实测当前真库：213 个目录 / 1247 个条目 / 3.35 TB / 库 81.7 MB。
         * ⚠️ 这里**不写盘数示例** —— `disks` 的含义在下方改了，写死一个数只会误导下一轮的人。
         */
        stats: {
            /**
             * 「盘数」= **有缓存的盘**（缓存库里出现过 serial 的个数），**不是"插着几块盘"**。
             *
             * 原来写的是 `drives.length + offline.length` —— 那是"所有挂载卷 + 有离线记录的盘"，
             * 它会把 C: 这种**从没收录过**的系统盘也算进去（`scanDrives` 扫的正是 C–Z）。
             * 而这一整句（盘数 / 目录 / 条目 / 已读到）其余每一项讲的都是"缓存里有什么"，
             * 混进没缓存的盘，既让"盘数"和后面的目录数对不上，
             * 也和盘条"只显示有缓存的盘"自相矛盾（用户 2026-10-04 问的正是这个）。
             */
            disks: new Set(metas.map(m => m.serial)).size,
            folders: metas.length,
            entries: metas.reduce((n, m) => n + (m.count || 0), 0),
            bytes: metas.reduce((n, m) => n + (m.bytes || 0), 0),
            dbBytes,
            /**
             * 图片（`bin/`）的张数与占用。
             *
             * 为什么必须单独报、不能只报 `dbBytes`：2026-10-04 之后**库瘦了 200 倍**
             * （85 MB → 428 KB）而图片搬进了 `bin/`（几十 MB）—— 只报库的大小会让人
             * 以为"缓存只有几百 KB"，那是**严重低估**（实测真库：库 428 KB / 图片 55 MB）。
             *
             * 代价：`binStats` 对每个图片文件做一次 `stat`。只在本接口里算一次
             * （打开面板 / 点刷新），实测千级条目十几毫秒，且**只 stat 系统盘上的本地文件**，
             * 不碰移动硬盘 —— 与"只汇总已有缓存、不读盘"那条硬约束一致。
             */
            binCount: bin.count,
            binBytes: bin.bytes,
            lastScanAt: metas.reduce((a, m) => (m.create_at > a ? m.create_at : a), ''),
        },
    });
}

interface HistoryRow extends CacheMeta {
    /**
     * 这条记录**这一层的内容字节总量**（= `data[].size` 求和）。
     *
     * 语义要说准（面板上也要这么写）：它是"**上次扫到的那一刻**，这一层里所有文件加起来多大"，
     * 不是"硬盘上此刻有多少"。之后删/移文件不会更新它 —— 缓存本来就是一快照。
     * 实测（真库）：213 条里 210 条 > 0；单层最大 492.55 GB；全库合计 3.35 TB。
     * 算法在 nedb 的 `loadMeta({ withBytes: true })` 里，**唯一聚合点**，纯内存、零读盘。
     */
    bytes?: number;
    /**
     * 打开这一行用的地址。
     *
     * 盘在线 → 完整路径（`H:/x`，实时视图）；盘不在 → **只读锚点**（`#序列号/x`）。
     * 以前这里盘不在时给 `null`，前端据此置灰（"不给一个点不开的路径"）——
     * 现在锚点是点得开的（读缓存、不碰盘），所以两种盘都有地址，前端不再需要按
     * `online` 决定能不能点。**注意它已经不等于"磁盘上的路径"了**，
     * 展示上别拿它当盘符用（面板里那枚盘符标签用的是 `online ? path.slice(0,2) : '离线'`）。
     */
    path: string;
    online: boolean;
}

async function getHistory(req: Req, res: http.ServerResponse) {
    const serial = req.params?.get('serial') || '';
    const keyword = (req.params?.get('path') || '').trim().toLowerCase();
    const pageNo = Number(req.params?.get('pageNo')) || 1;
    const pageSize = Number(req.params?.get('pageSize')) || 10;
    // 排序。不传 = 老行为（create_at 倒序），这样老调用方语义不变。
    // 面板默认传 sort=path：那是"黄页"该有的顺序 —— 同盘相邻，
    // 而且老盘的记录**不会因为扫得早就被时间冲到底部**（那会直接伤"盘不在也能看有哪些"）。
    const sortBy = (req.params?.get('sort') || 'create_at') as 'path' | 'count' | 'bytes' | 'create_at';
    const dir: 1 | -1 = req.params?.get('dir') === 'asc' ? 1 : -1;

    try {
        const drives = await getDrives();
        const letterOf = new Map<string, string>(drives.map(d => [d.serial, d.drive]));

        // withBytes：每行多一个 bytes（这一层的字节和）。纯内存，**不读盘**。
        let metas = await loadMeta({ withBytes: true, sortBy, dir });
        if (serial) metas = metas.filter(m => m.serial === serial);
        // 关键词过滤。除了路径，**也允许直接按盘符搜**：`f` / `f:` = "那块盘上的全部记录"。
        // 但要求**整词相等**、不做子串匹配 —— 否则搜一个含字母的词会把某块盘的记录整片捞进来，
        // 用户看到一堆"路径里明明没有那个字母"的行，只会以为程序坏了。
        // （只认盘符不认卷标：卷标至今全空，见 driveIdentity.ts 的 probe()。）
        if (keyword) {
            const diskHit = new Set(
                [...letterOf.entries()]
                    .filter(([, letter]) => {
                        const l = letter.toLowerCase();
                        return l === keyword || `${l}:` === keyword;
                    })
                    .map(([s]) => s),
            );
            metas = metas.filter(m => m.relPath.toLowerCase().includes(keyword) || diskHit.has(m.serial));
        }

        const records: HistoryRow[] = metas
            .slice((pageNo - 1) * pageSize, pageNo * pageSize)
            .map(m => {
                const drive = letterOf.get(m.serial);
                return {
                    ...m,
                    // 盘在线 → 实时路径；盘不在 → 只读锚点（`#serial/relPath`）。
                    // 托盘符没有意义：`H:` 现在可能是另一块盘，拿它当地址等于在编造身份。
                    // 锚点是 `(serial, relPath)`，正是这条缓存记录的主键 —— 唯一准确的地址。
                    path: drive ? toFullPath(drive, m.relPath) : toAnchorPath(m.serial, m.relPath),
                    online: !!drive,
                };
            });

        sendJson(res, { records, total: metas.length, current: pageNo, size: pageSize });
    } catch (e) {
        console.error('[getHistory] 查询失败:', e);
        sendJson(res, { code: 500, error: String(e) });
    }
}

async function removeHistoryBatch(req: Req, res: http.ServerResponse) {
    // POST + body（原来是 DELETE + 查询串：拿 DELETE 去"带参数查询"是语义错位，
    // 而且 ids 一多查询串会越来越长）。查询串里给了也认 —— 老调用方不至于一下子断掉。
    const raw = (req.body as { ids?: unknown } | undefined)?.ids ?? req.params?.get('ids');
    const idList = (Array.isArray(raw) ? raw.map(String) : String(raw ?? '').split(','))
        .map(s => s.trim())
        .filter(Boolean);
    if (!idList.length) {
        return sendJson(res, { code: 500, error: '参数 ids 不能为空' });
    }

    try {
        // 用户手里拿到的是 `_id`（表格行键），但**删除必须按主键 (serial, relPath, mode) 进各自的串行链**：
        // `_id` 只是"这一份库内部的身份"，不是数据的身份；而链的键就是主键。
        // 所以先只读地查一次元数据，把 _id 翻译成主键。
        const metas = await loadMeta();
        const byId = new Map(metas.map(m => [m._id ?? '', m]));

        let numRemoved = 0;
        for (const id of idList) {
            const m = byId.get(id);
            if (!m) continue;   // 已经被别处删掉了（比如上一次删除、或还原/合并）—— 跳过，不算失败
            await queueCacheWrite(m.serial, m.relPath, m.mode, async () => {
                numRemoved += await removeCache(m.serial, m.relPath, m.mode);
            });
        }

        sendJson(res, { code: 200, message: `${numRemoved} 条数据已删除` });
    } catch (e) {
        sendJson(res, { code: 500, error: String(e) });
    }
}

async function backup(_req: Req, res: http.ServerResponse) {
    try {
        await cacheBackup();
        sendJson(res, { code: 200, message: 'backup success' });
    } catch (e) {
        sendJson(res, { code: 500, error: String(e) });
    }
}

/** POST body 里取一个非空路径。取不到就抛 —— 由 route() 兜住变成 500 */
function bodyPath(req: Req): string {
    const p = (req.body as { path?: unknown } | undefined)?.path;
    if (typeof p !== 'string' || !p) {
        throw new Error('参数 path 不能为空');
    }
    return p;
}

/**
 * 「备份到文件…」—— 把**整份数据**打成一个 zip 交到用户挑的位置。
 *
 * 2026-10-04 改：数据不再只是 `searchCache.db` 一个文件（图片搬到 `bin/` 了），
 * 所以"拷走那一个文件"不再等于"拷走这份数据"。主人要求"导出尽可能只有一个文件、
 * 用户才没有心理负担" ⇒ 打进一个 `.zip`：**Windows 资源管理器双击就能打开**，
 * 里面有什么一目了然，而不是一个只有本程序认识的容器。
 *
 * 为什么 store-only（不压缩）：里面的东西已经压不动了 —— 库是逐行 AES 密文、
 * 图片是加密后的 JPEG（实测 `gzip(JPEG)` ≈ 原大小）。压缩只会白烧 CPU。
 *
 * 包里的结构就是数据目录本身的样子：`searchCache.db` + `bin/<名字>.enc`。
 */
async function backupToFile(req: Req, res: http.ServerResponse) {
    const target = bodyPath(req);
    // ⚠️ 图片仓没就绪时**必须拒绝打包**：否则 `listBinNames()` 是空的，
    //   打出来的 zip 只有库、没有一张图，而接口还会回"ok" ——
    //   用户以为备份完整，真到需要时才发现封面全没了（静默丢数据，最坏的一种）。
    if (binStoreFailed()) {
        throw new Error('图片仓（bin 目录）读不出来，拒绝打包：否则会导出一个不含任何图片的备份。先重启应用再试。');
    }
    const entries = [
        { name: 'searchCache.db', file: CACHE_DB_PATH },
        ...listBinNames().map(n => ({ name: `bin/${n}`, file: path.join(BIN_DIR, n) })),
    ];
    const bytes = await writeZip(target, entries);
    sendJson(res, { code: 200, message: 'ok', entries: entries.length, bytes });
}

/** 包里的图片条目（`bin/xxx.enc`）。名字要按形状校验：它会变成磁盘上的文件名 */
function binEntriesOf(entries: { name: string }[]): string[] {
    return entries
        .map(e => e.name)
        .filter(n => /^bin\/[tp]-[0-9a-f]{40}\.enc$/.test(n))
        .map(n => n.slice(4));
}

/** 把包里的图片**只增不删**地并进本机 bin 仓（已有的跳过，绝不覆盖） */
async function importBins(zipPath: string, names: string[]): Promise<number> {
    if (!names.length) return 0;
    const entries = await listZip(zipPath);
    const byName = new Map(entries.map(e => [e.name, e]));
    let added = 0;
    for (const name of names) {
        if (hasBin(name)) continue;                       // 已有就不动它：本地那份可能更新
        const e = byName.get(`bin/${name}`);
        if (!e) continue;
        await putBinEncrypted(name, await readZipEntry(zipPath, e));
        added++;
    }
    return added;
}

/**
 * 「从文件还原…」—— 整份顶掉主库，然后**就地重新加载**。
 *
 * 三步，缺一不可：
 *
 * 1. **先快照**（独立槽位 `BEFORE_RESTORE_PATH`）—— 还原是不可逆的整体覆盖，
 *    而 `cacheBackup()` 那个名字是按天同名覆盖的，关键时刻靠不住（见 nedb.ts 注释）。
 * 2. **覆盖主库**。
 * 3. **重新加载**（`reloadFromDisk`）—— 这一步是**必须**的：
 *    nedb 启动时把整库读进内存，**运行时内存才是真相源**；而且实测运行中的主库文件
 *    **没有独占锁**（`r+` 能打开），所以光覆盖文件**不会报任何错**，会被内存态静默冲掉。
 *    实测二次 `loadDatabase` 能完整换成新内容、且 executor 不会变僵尸
 *    （探针 `%TEMP%/ff-enc-probe/reload.cjs`，6/6 PASS）→ 因此**不需要重启应用**。
 *
 * 失败就**尽力回滚**：把快照复制回去、再加载一次。回滚也失败时不再挣扎 ——
 * 那时 `loadError` 已经挂着，闸门（`assertUsable`）会让所有请求响亮地报错，
 * 而不是继续拿一份半坏的内存态对外服务。
 */
async function restoreFromFile(req: Req, res: http.ServerResponse) {
    const source = bodyPath(req);

    // 先从包里把库抽出来（包里那份是**密文原样**，不需要解密——
    // 库的每一行本来就是加密的，这里只做搬运）
    let dbTmp: string;
    let binNames: string[] = [];
    try {
        const entries = await listZip(source);
        const dbEntry = entries.find(e => e.name === 'searchCache.db');
        if (!dbEntry) throw new Error('包里没有 searchCache.db');
        binNames = binEntriesOf(entries);
        dbTmp = `${CACHE_DB_PATH}.restoring-${process.pid}-${Date.now().toString(36)}`;
        await fsasync.writeFile(dbTmp, await readZipEntry(source, dbEntry));
    } catch (e) {
        throw new Error(`不是一份可用的备份包：${e}`);
    }

    beginRestore();
    // 覆盖是否已经开始过 —— 只有它才决定"要不要回滚"。
    // 快照那一步失败时主库还没被动过，回滚反而是拿一份旧快照去盖好的库。
    let overwritten = false;

    try {
        await fsasync.copyFile(CACHE_DB_PATH, BEFORE_RESTORE_PATH);
        overwritten = true;
        await fsasync.copyFile(dbTmp, CACHE_DB_PATH);
        await reloadFromDisk();
    } catch (e) {
        if (!overwritten) throw new Error(`还原失败：${e}`);

        let note: string;
        try {
            await fsasync.copyFile(BEFORE_RESTORE_PATH, CACHE_DB_PATH);
            await reloadFromDisk();
            note = '已回滚到还原前的状态。';
        } catch (e2) {
            note = `回滚也失败了（${e2}）。请手动把 ${BEFORE_RESTORE_PATH} 复制成 ${CACHE_DB_PATH}`;
        }
        throw new Error(`还原失败，选中的文件不是一份可用的缓存库。${note}`);
    } finally {
        endRestore();
        fsasync.unlink(dbTmp).catch(() => { });
    }

    // 库换完了再搬图片（**只增不删**：本地多出来的那份，可能正是包里缺的那几张）
    const added = await importBins(source, binNames);
    // 旧版备份（v2 库）里图片还是 base64：这里跑一次就地迁移，免得"还原完格子全白"
    await migrateLegacyThumbs();

    sendJson(res, { code: 200, message: 'ok', images: added });
}

/**
 * 「合并缓存…」—— 把用户选中的另一份库**并进来**（不是顶掉）。
 *
 * 与「还原」的分界：还原 = 整份替换（本机独有的记录会消失）；
 * 合并 = 两边都留（适合"两台机器各扫了一半的盘"）。
 *
 * 冲突规则：同一个主键 `(serial, relPath, mode)` 上，**取 `create_at` 新的那份**。
 * 比 `>=` 而不是 `>`：本地与外部时间戳完全相等时没必要白删白插一遍。
 *
 * 只并 `v === CACHE_VERSION` 的记录：版本不同的记录形状就不对（v1 里
 * `files[]` 带整包 fs.Stats、条目用完整路径当键），并进来是污染而不是补充。
 * **不删外部文件**，也不改动它（`readExternalCache` 读的是副本）。
 *
 * 每一步都走 `queueCacheWrite` —— 和 `scanAndCache` **同一条写入链**。
 * 这是必须的：合并可能和后台批量扫描撞在同一个主键上，绕过那条链就等于
 * 在"唯一写入点"之外又开一个口（见 queueCacheWrite 的注释）。
 */
async function mergeCache(req: Req, res: http.ServerResponse) {
    const source = bodyPath(req);

    // 2026-10-04：来源从"一个 .db 文件"变成"一个备份包（zip）" ——
    // 里面那份库要抽成临时文件才能交给 `readExternalCache`（它按普通文件读、逐行解密）。
    let dbTmp: string;
    let binNames: string[] = [];
    try {
        const entries = await listZip(source);
        const dbEntry = entries.find(e => e.name === 'searchCache.db');
        if (!dbEntry) throw new Error('包里没有 searchCache.db');
        binNames = binEntriesOf(entries);
        dbTmp = `${CACHE_DB_PATH}.merging-${process.pid}-${Date.now().toString(36)}`;
        await fsasync.writeFile(dbTmp, await readZipEntry(source, dbEntry));
    } catch (e) {
        throw new Error(`不是一份可用的备份包：${e}`);
    }

    let incoming: SearchCache[];
    try {
        incoming = await readExternalCache(dbTmp);
    } finally {
        fsasync.unlink(dbTmp).catch(() => { });
    }

    let added = 0, replaced = 0, skipped = 0;

    for (const doc of incoming) {
        if (doc.v !== CACHE_VERSION) {
            skipped += 1;
            continue;
        }

        const current = await findCache(doc.serial, doc.relPath, doc.mode);
        if (current && current.create_at >= doc.create_at) {
            skipped += 1;
            continue;
        }

        // 丢掉外来的 _id，让本库自己发一个新的。
        // 理由：`_id` 是**这一份库**内部的身份，不是数据的一部分；
        // 带着它插进来，万一和本地某条别的记录撞上（_id 是随机串，理论上会撞），
        // `insert` 会因 `_id` 唯一索引直接抛错，整个合并就断在半路。
        // 主键是 `(serial, relPath, mode)`，丢掉 `_id` 不损失任何语义。
        const payload: SearchCache = { ...doc };
        delete payload._id;

        await queueCacheWrite(doc.serial, doc.relPath, doc.mode, async () => {
            await removeCache(doc.serial, doc.relPath, doc.mode);
            await insertCache(payload);
        });

        current ? (replaced += 1) : (added += 1);
    }

    // 并进来的可能是旧版（v2）记录 —— 跑一次就地迁移，把它们的 base64 图片搬进 bin
    await migrateLegacyThumbs();
    // 记录并完了再搬图片（只增不删；跨机器迁移时那些清晰的封面就是从这里过来的）
    const images = await importBins(source, binNames);

    sendJson(res, { code: 200, added, replaced, skipped, total: incoming.length, images });
}

/**
 * 把「只读锚点」解析成**此刻**可用的完整路径。
 *
 * 这是对一个设计缺陷的正面修复（不是打补丁）：
 *
 * 渲染层原来判"能不能打开原文件"用的是 `target.startsWith('#')` —— 也就是**地址长什么样**。
 * 而地址形态是"当初扫描那一刻盘在不在"的**历史快照**：盘插回来，地址不会变，
 * 于是那一层被**永久**判成只读，双击资源永远打不开（用户实测反馈）。
 *
 * **正确的问题不是"这个地址是不是锚点"，而是"这块盘此刻在不在"。**
 * 而 `serial → 盘符` 这个映射只有服务端知道（渲染层刻意不解析锚点内容，
 * 见 `src/views/FileFinder/index.vue` 的 `isReadOnlyPath`），
 * 所以解析放在这里 —— 和 `toAnchorPath` / `parseAnchor` 同一个模块：
 * **锚点的"造"和"解"只有这一处懂**，将来谁要碰锚点都得经过它。
 *
 * 关于"少读盘"的代价（用户的第一优先级），如实说明：
 *   先 `getDrives()` —— 那是**进程内缓存，一次盘都不扫**；
 *   只有查不到才 `getDrives(true)` 重试一次（26 个盘符各一次 stat，代码注释里量过 ≈2ms）。
 *   触发点只有"用户主动要打开一个文件、而这块盘当时不在已知列表里"——
 *   而他要打开的那个文件**马上就要读这块盘**，所以这次探测被后面的动作完全盖住，
 *   不是净新增的读盘。
 */
async function resolveAnchorController(req: Req, res: http.ServerResponse) {
    const anchor = req.params?.get('path') || '';
    const parsed = parseAnchor(anchor);
    if (!parsed) {
        return sendJson(res, { code: 400, error: '不是一条可解析的只读地址' });
    }

    // 先查进程内缓存（不扫盘）；查不到再强制扫一次 —— 覆盖"启动之后才把盘插上"这个场景
    let drive = (await getDrives()).find(d => d.serial === parsed.serial)?.drive;
    if (!drive) {
        drive = (await getDrives(true)).find(d => d.serial === parsed.serial)?.drive;
    }
    if (!drive) {
        // 盘确实不在。`kind` 让前端能把它和"这个文件本身有问题"分开（不要靠 match 文案）
        return sendJson(res, { code: 404, kind: 'offline', error: '这块盘现在不在（没插或还没就绪）' }, 404);
    }

    sendJson(res, { code: 200, path: toFullPath(drive, parsed.relPath) });
}

/**
 * 路由注册的**唯一入口** —— 顺带把所有 async handler 的抛错兜住。
 *
 * 为什么必须有它：`event.emit(route, req, res)` 是**同步**调用，而下面这些 handler
 * 全是 `async` —— 它们返回的 Promise 一旦 reject，**没有任何人接**：
 * 不会变成 500、也不会关连接，而是变成 unhandledRejection，**请求永久不响应**
 * （前端 `fetch` 一直挂着、`loading` 永远 true，界面卡死）。
 *
 * 以前每个 handler 各写各的 try/catch —— `getHistory` / `removeHistoryBatch` / `backup`
 * 写了，而 `openFolderController` / `getFileTree` / `rawController` / `listDisksController`
 * **没写**，它们抛错就是一个个"请求黑洞"。收成一个咽喉点之后，以后新增 handler
 * **不可能再漏**。和 `wire()` 是唯一下发出口、`apiUrl()` 是唯一 URL 出口、
 * 口令校验挂在唯一请求入口，是同一个思路。
 *
 * 顺带解决了"前端怎么知道失败了"：`sendJson` 带出的 `error` 字段会被
 * `src/utils/request.ts` 的 `assertOk` 直接 `throw` 出去，
 * `fetchFolder` 的 catch 里本来就有 `notify('error', …, String(err))`。
 *
 * `kind` 是**机器可读的失败分类**（handler 在 Error 上挂的，见 `readFolder`）。
 * 前端要分成「盘不在 → 插上再来」和「读不到 → 稍后再试」两种提示，
 * 靠文案匹配会随文案失效，所以让分类跟着错误对象一路走到前端。
 * 没挂的分类一律是 `unknown`，前端按"其他失败"处理。
 */
function route(path: string, handler: (req: Req, res: http.ServerResponse) => unknown) {
    event.on(path, (req: Req, res: http.ServerResponse) => {
        Promise.resolve(handler(req, res)).catch((e: unknown) => {
            console.error(`[route] ${path} 处理失败:`, e);
            if (res.headersSent) {
                res.end();
                return;
            }
            sendJson(res, {
                code: 500,
                error: e instanceof Error ? e.message : String(e),
                kind: (e as { kind?: string })?.kind ?? 'unknown',
            }, 500);
        });
    });
}

route('/getHistory', getHistory);
route('/openFolder', openFolderController);
route('/thumb', thumbController);
route('/preview', previewController);
route('/raw', rawController);
route('/getDisks', listDisksController);
route('/getFileTree', getFileTree);
route('/removeHistoryBatch', removeHistoryBatch);
route('/backup', backup);
route('/backupToFile', backupToFile);
route('/restoreFromFile', restoreFromFile);
route('/mergeCache', mergeCache);
// 把只读锚点解析成"此刻"的完整路径 —— 只读层双击打开原文件时走它。
// 见 resolveAnchorController 的注释：修的是"用地址形态当判据"这个设计缺陷。
route('/resolveAnchor', resolveAnchorController);
// 反方向：实时路径 → 只读锚点。拔盘时把当前屏降级成只读用（见 anchorOfController）。
route('/anchorOf', anchorOfController);

// 管理助手（Phase 1：规则 CRUD + 单站试跑，暂无写盘）。经同一 route() 咽喉点注册，
// 自动受 token 校验与统一错误兜底；sendJson/dataDir 以依赖注入传入，避免循环引用。
// 深度重扫走 assistant 自己的实时清单（纯 readdir+stat，零抽帧、不写缓存），
// 不需要从这儿注入 scanAndCache —— 缓存的写入入口保持唯一。
for (const [assistantPath, assistantHandler] of createAssistantRoutes({ sendJson, dataDir: config.userBasePath })) {
    route(assistantPath, assistantHandler);
}

route('/', function (_req, res) {
    res.end('hi! i`m ace.');
});

/**
 * 只放行本机来源。
 *
 * 原来是 `Access-Control-Allow-Origin: *` 配 `Allow-Credentials: true` —— 浏览器本来就
 * 拒绝这个组合，等于白写；而 `*` 意味着用户随便打开一个网页，那个网页里的脚本就能
 * fetch 127.0.0.1:3060，把他硬盘上的目录结构整个读走。
 */
function cors(req: Req, res: http.ServerResponse) {
    const origin = req.headers.origin;
    // 开发时是 Vite 的 http://localhost:5173；
    // 打包后 Electron 加载 file://，Origin 头是字面量 'null'
    const allowed = !origin || origin === 'null' || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);

    if (allowed) {
        res.setHeader('Access-Control-Allow-Origin', origin || '*');
        res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'OPTIONS, GET, POST, PUT, DELETE');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, token');
}

const app = http.createServer((req: Req, res) => {
    const u = url.parse(req.url!);
    const method = req.method?.toUpperCase();
    const route = u.pathname || '/';
    req.params = new URLSearchParams(u.search || '');

    cors(req, res);

    if (method === 'OPTIONS') {
        res.writeHead(204);
        return res.end();
    }

    /**
     * 口令校验 —— 放在这里是因为这个回调是**所有请求的唯一入口**。
     *
     * 为什么需要：这是个裸 HTTP 服务，**任何网页**都能朝 127.0.0.1:3060 发请求。
     * 浏览器确实会拦掉"跨域读响应"，但**请求本身照样会打进来并被执行** ——
     * 光 `/getFileTree` 一条就能让主进程递归 stat 整块盘（界面卡住、硬盘狂响）。
     *
     * 为什么不能用 `Origin` 名单代替：打包后应用自己就跑在 `file://`，
     * 它的 Origin 是字面量 `'null'` —— 和任意一个恶意 `file://` / `data:` 页面
     * **完全无法区分**。拿一个自己都伪造得出的东西当凭证，等于没校验。
     *
     * 为什么口令放在 URL 里（`?t=`）而不是请求头：缩略图是靠 `<img src>` 取的，
     * **浏览器不会给 `<img>` 加自定义请求头**。放 URL 里才能让所有出口用同一个机制。
     * 代价是口令会出现在 URL 上 —— 本地服务、没有任何对外跳转，这个暴露面是零。
     */
    if (req.params.get('t') !== LOCAL_TOKEN) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        return res.end('forbidden\n');
    }

    const next = () => {
        if (events.getEventListeners(event, route).length) {
            event.emit(route, req, res);
        } else {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('404 Not Found\n');
        }
    };

    if (method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            // 空 body 的 POST 原来会让 JSON.parse 抛出去，直接把主进程带崩
            try {
                req.body = body ? JSON.parse(body) : {};
            } catch {
                req.body = {};
            }
            next();
        });
        return;
    }

    if (method === 'GET' || method === 'DELETE') return next();

    res.writeHead(405, { 'Content-Type': 'text/plain' });
    res.end('405 Method Not Allowed\n');
});

/**
 * 必须显式绑 127.0.0.1。
 * `app.listen(3060)` 不写 host 会绑到所有网卡上 —— 同一个 Wi-Fi 下别人直接就能
 * 访问这个服务，而它能读你任何路径的目录列表。
 *
 * ⚠️ 还要等**图片仓就绪**再 listen（2026-10-04 补）：`initBinStore()` 是模块加载时
 * 发起的异步动作（mkdir + readdir），而本文件是 **import 即 listen**（渲染层 bundle
 * 一加载就起服务）。原先直接 listen 的后果：端口可能先就绪、`names` 还是空集 ⇒
 * 那零点几秒内进来的请求，`wire()` 会判定"这一层没有图" ⇒ **首屏一排白格子**（刷新才恢复）。
 * 窗口很窄（readdir 千级条目几毫秒），但它是**启动必现的竞态**，而修法只有一行 await。
 */
app.on('error', function (err: NodeJS.ErrnoException) {
    // 没有 error 监听时，端口被占会让整个 Electron 主进程直接崩掉
    if (err.code === 'EADDRINUSE') {
        console.error('[server] 端口 3060 已被占用。请先结束残留的 file-finder 进程再启动。');
    } else {
        console.error('[server] 本地服务启动失败:', err);
    }
});
whenBinReady().then(() => app.listen(3060, '127.0.0.1', function () {
    console.log('Local Server: http://127.0.0.1:3060/');
}));

// 这里原来有一句「启动时清理旧格式缓存」（dropLegacyRecords）—— 已删除。
// 它的判据是 `{ v: { $ne: 2 } }`，而 nedb 的 `$ne` 连"字段不存在"也匹配，
// 于是一次误删掉了"格式正确、只是没打版本号"的记录；而删除本身就意味着要碰盘。
// 现在版本不符的记录**不会被删**，只在 findCache 里被当作未命中，
// 下次浏览那个目录时被新记录自然覆盖（见 electron/server/nedb.ts）。
