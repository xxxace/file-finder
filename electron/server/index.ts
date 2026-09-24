import url from 'node:url';
import http from 'node:http';
import events from 'node:events';
import * as fs from 'node:fs';
import * as fsasync from 'node:fs/promises';
import dayjs from 'dayjs';
import { imageThumb, videoThumb } from '../utils/thumbnail';
import { newThumbKey, putThumb, getThumb } from '../utils/thumbStore';
import {
    findDriveByLetter, findDuplicatedSerials, getDrives, offlineSerials,
    splitPath, syncRegistry, toFullPath,
} from '../utils/driveIdentity';
import type { DriveInfo } from '../utils/driveIdentity';
import {
    BEFORE_RESTORE_PATH, CACHE_DB_PATH, CACHE_VERSION, beginRestore, cacheBackup, endRestore,
    findCache, insertCache, loadMeta, readExternalCache, reloadFromDisk,
    removeByIds, removeCache,
} from './nedb';
import type { CacheMeta, OpenMode, SearchCache } from './nedb';
import { LOCAL_TOKEN } from './token';

const VIDEO_EXT = ['mp4', 'mkv', 'avi', 'wmv', 'flv', 'mpeg'];
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
const event = new events.EventEmitter();

/** /raw 返回原图时要带的 Content-Type。只列会出现在这个程序里的类型 */
const MIME: Record<string, string> = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', bmp: 'image/bmp',
    gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
    mp4: 'video/mp4', mkv: 'video/x-matroska', avi: 'video/x-msvideo',
    wmv: 'video/x-ms-wmv', flv: 'video/x-flv', mpeg: 'video/mpeg',
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
    /** 缩略图 key。渲染层拿它请求 /thumb?k= */
    thumb?: string;
    /** 缩略图的 data URI。只存不发，下发前被 `wire()` 的白名单重建丢掉 */
    thumbData?: string;
    /** 目录封面（目录下的 avatar.jpg）的缩略图 key */
    avatar?: string;
    /** 目录封面缩略图的 data URI。只存不发 */
    avatarThumbData?: string;
}

type Req<T = any> = http.IncomingMessage & { params?: URLSearchParams; body?: T };

function isImage(ext: string) {
    return ext ? IMAGE_EXT.includes(ext.toLowerCase()) : false;
}
function isVideo(ext: string) {
    return ext ? VIDEO_EXT.includes(ext.toLowerCase()) : false;
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

function registerThumb(key?: string, data?: string) {
    if (key && data) putThumb(key, data);
}

/**
 * 统一封面出口：图片和视频都在这里变成一张 480px 的 JPEG。
 *
 * 为什么不直接存原图：网格里一格只有约 180×144 px，而库里存下来的封面中位是
 * 800×538、base64 均值 161 KB。缩到 480px 后约 20 KB —— 体积小 8 倍，
 * 浏览器要解码进内存的位图也从 1.7 MB/张 降到 0.6 MB/张。
 *
 * 为什么缩略图还是存 base64 而不是落成文件：落成文件意味着**每次浏览都要去
 * 移动硬盘上读一遍**，而这个项目的第一目标就是少碰移动硬盘。存进 DB 之后
 * 首次生成完就再也不用碰它了。
 *
 * nativeImage 解码是**同步**的，会按住主进程事件循环十几毫秒，
 * 所以每张之间让出一次，保证窗口不"假死"。
 */
async function makeThumb(filepath: string, ext: string): Promise<string> {
    let buf: Buffer | null = null;

    if (isVideo(ext)) {
        // 抽帧写的是系统临时目录，不是移动硬盘
        buf = await videoThumb(filepath);
    } else if (isImage(ext)) {
        // 全程内存：不落盘、不写临时文件。nativeImage 解不了的格式（webp 等）
        // 这里会自己走 ffmpeg 兜底，详见 thumbnail.ts 的 imageThumb
        buf = await imageThumb(filepath);
    }

    await new Promise(r => setImmediate(r));

    return buf ? `data:image/jpeg;base64,${buf.toString('base64')}` : '';
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
async function makeDirCover(dirPath: string, serial: string): Promise<{ key: string; data: string } | null> {
    for (const name of DIR_COVER_FILES) {
        const filepath = `${dirPath}/${name}`;
        try {
            await fsasync.access(filepath);
        } catch {
            continue;
        }
        const data = await makeThumb(filepath, 'jpg');
        if (data) return { key: newThumbKey(serial), data };
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
async function readFolder(diskDir: string, mode: string, serial: string, storeDir: string): Promise<FileInfo[]> {
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

    for (const file of files) {
        if (file.startsWith('.') || excludedFiles.includes(file)) continue;
        const filepath = `${diskDir}/${file}`;

        // 逐项 try/catch：任何一项失败（坏符号链接、权限受限的目录）只跳过它自己。
        // 原来整个循环被一个 try 包住，一项 stat 失败会让整个文件夹返回空
        try {
            const stat = await fsasync.stat(filepath);

            if (mode === 'cover' && stat.isDirectory()) {
                // null = 这个子目录既没封面图也没视频，不该收敛 → 落到下面当普通目录
                const converged = await handleCover(filepath, serial, joinRel(storeDir, file));
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
                size: stat.size,
            };

            if (info.type === 'folder') {
                // 目录自己的脸（avatar.jpg / cover.jpg）→ 这个目录条目带一张缩略图
                const avatar = await makeDirCover(filepath, serial);
                if (avatar) {
                    info.avatar = avatar.key;
                    info.avatarThumbData = avatar.data;
                }
            } else if (info.type === 'image' || info.type === 'video') {
                const thumb = await makeThumb(filepath, ext);
                if (thumb) {
                    info.thumb = newThumbKey(serial);
                    info.thumbData = thumb;
                }
            }

            folder.push(info);
        } catch (e) {
            console.log('[readFolder] 跳过无法读取的项:', filepath, e);
        }
    }

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
async function handleCover(diskDir: string, serial: string, storeDir: string): Promise<FileInfo[] | null> {
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
    const thumb = await makeThumb(filepath, ext);
    if (thumb) {
        info.thumb = newThumbKey(serial);
        info.thumbData = thumb;
    }

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
export type WiredFileInfo = Omit<FileInfo, 'thumbData' | 'avatarThumbData'>;

/**
 * 条目 → 下发态：**按白名单重建**，只放行 `FileInfo` 里"会下发"的那 9 个字段。
 *
 * 为什么必须是白名单，而不是"把已知的内部字段解构掉"（原来这里是 `stripThumbData`）：
 * 黑名单是"我知道哪些要剥掉" —— 将来 `FileInfo` 少一个字段、或者库里的旧记录多一个字段，
 * 剥离表就漏，而漏的方式是**静默下发**。白名单是"我只认识这些"，之后字段怎么变都漏不出去。
 *
 * 这不是假想的问题。旧记录里每条都把整个 `fs.Stats` 序列化进去过，实测能漏出 17 个
 * 渲染层一个字都不看的字段（`dev` / `ino` / `nlink` / `atime*` / `mtime*` / …），
 * 其中 **`dev` 是扫描那一刻的卷序列号** —— 正是"盘符不是身份、序列号才是"这条设计
 * 明令不许进数据的东西。
 *
 * `files[]` 也必须重建：v1 里 `FileInfoFiles = fs.Stats & { name }`，
 * 每一项同样带着整包 stat。只清顶层等于只修一半。
 *
 * ⚠️ **别把 `thumbData` / `avatarThumbData` 也放进来** —— 它们是 `FileInfo` 的字段，
 * 但属于"只存不发"：base64 由 `wire()` 登记进内存索引、渲染层只拿 `thumb` 这个 key
 * 去 `/thumb` 取。放进来就等于把这个机制撤销了，payload 又回到几百 KB
 * （第一版白名单就踩了这个：实测下发 JSON 里真的出现了 base64）。
 */
export function pickFileInfo(raw: FileInfo): WiredFileInfo {
    return {
        dir: raw.dir,
        name: raw.name,
        isDirectory: raw.isDirectory,
        ext: raw.ext,
        files: raw.files?.map(f => ({ name: f.name, size: f.size })),
        type: raw.type,
        size: raw.size,
        thumb: raw.thumb,
        avatar: raw.avatar,
    };
}

/**
 * 登记缩略图 + 按白名单重建条目。
 *
 * **所有**下发路径都必须过这里，且只留这一处。上一版只有"缓存命中"那条路走 `toWire`，
 * 非盘符路径（UNC、网络位置）直接 `sendJson(readFolder(...))` 就出去了 ——
 * 缩略图压根没登记，前端拿到的 key 请求 /thumb 全是 404，整个网格是白框。
 *
 * 所以白名单也放在这里、而不是只放在"取缓存"那一支：**出口只有一个**，
 * 谁都不需要记得自己清一遍。fresh 扫出来的条目本来就是干净的，过一遍只是幂等。
 */
function wire(items: FileInfo[]): WiredFileInfo[] {
    return items.map(item => {
        registerThumb(item.thumb, item.thumbData);
        registerThumb(item.avatar, item.avatarThumbData);
        return pickFileInfo(item);
    });
}

/**
 * 存储态 → 下发态：把 dir 从盘内相对路径补回**当前**盘符的完整路径。
 *
 * 这一步是整套设计的关键：缓存里不存盘符，所以同一块盘今天挂 H:、明天挂 K: 都不用改数据。
 */
function toWire(items: FileInfo[], drive: string): WiredFileInfo[] {
    return wire(items).map(item => ({ ...item, dir: toFullPath(drive, item.dir) }));
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
function toAnchor(items: FileInfo[], serial: string): WiredFileInfo[] {
    return wire(items).map(item => ({ ...item, dir: toAnchorPath(serial, item.dir) }));
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
    const data = await readFolder(toFullPath(drive, relPath), mode, serial, relPath);

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
        return sendJson(res, toAnchor(cached.data, anchor.serial));
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
        return sendJson(res, wire(await readFolder(raw, mode, '', raw)));
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

    sendJson(res, toWire(doc.data, drive));
}

/**
 * 缩略图出口。前端只拿到 key，真正的 base64 一直待在主进程内存里，
 * 这样 /openFolder 的响应体可以小到几十 KB。
 */
function thumbController(req: Req, res: http.ServerResponse) {
    const dataUri = getThumb(req.params?.get('k') || '');
    if (!dataUri) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        return res.end('thumb not found');
    }

    const comma = dataUri.indexOf(',');
    const buf = Buffer.from(comma === -1 ? dataUri : dataUri.slice(comma + 1), 'base64');

    res.writeHead(200, {
        'Content-Type': 'image/jpeg',
        'Content-Length': buf.length,
        // key 是一次性的，内容永不变 —— 让 Chromium 长期缓存住，
        // 来回切目录不会重复请求同一张图
        'Cache-Control': 'private, max-age=31536000, immutable',
    });
    res.end(buf);
}

/**
 * 原图出口 —— 只服务"点开放大"这一种场景。
 *
 * 网格里必须用缩略图（那是这次重构的核心：103 MB → 12 MB），但放大预览时 480px
 * 会明显糊。所以预览单开一条路读原图：一次只读用户点开的那一张，不是整个目录，
 * 而且流式返回，对移动硬盘的额外负担可以忽略。
 */
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
async function listDisksController(_req: Req, res: http.ServerResponse) {
    // 用户点这个就是想看"现在插着什么"，强制重扫一次
    const drives = await getDrives(true);
    const now = dayjs().format('YYYY-MM-DD HH:mm:ss');
    const registry = await syncRegistry(drives, now);
    const metas = await loadMeta();

    const stats = new Map<string, { folders: number; covers: number; lastScanAt: string }>();
    for (const m of metas) {
        const s = stats.get(m.serial) || { folders: 0, covers: 0, lastScanAt: '' };
        s.folders += 1;
        s.covers += m.count || 0;
        if (m.create_at > s.lastScanAt) s.lastScanAt = m.create_at;
        stats.set(m.serial, s);
    }

    const empty = { folders: 0, covers: 0, lastScanAt: '' };

    sendJson(res, {
        disks: [
            ...drives.map(d => ({ ...d, online: true, ...(stats.get(d.serial) || empty) })),
            ...offlineSerials(registry, drives).map(serial => ({
                serial,
                drive: '',
                root: '',
                label: registry[serial].label || '',
                online: false,
                ...(stats.get(serial) || empty),
            })),
        ],
        // 卷序列号是格式化时写进卷里的，用 Ghost 之类整盘克隆会把两块盘做成同一个身份。
        // 这时盘符是唯一能区分它们的东西，必须提示用户 —— 否则两块盘的缓存会互相串
        duplicated: findDuplicatedSerials(drives),
    });
}

interface HistoryRow extends CacheMeta {
    /**
     * 打开这一行用的地址。
     *
     * 盘在线 → 完整路径（`H:/x`，实时视图）；盘不在 → **只读锚点**（`#序列号/x`）。
     * 以前这里盘不在时给 `null`，前端据此置灰（"不给一个点不开的路径"）——
     * 现在锚点是点得开的（读缓存、不碰盘），所以两种盘都有地址，前端不再需要按
     * `online` 决定能不能点。**注意它已经不等于"磁盘上的路径"了**，
     * 展示上别拿它当盘符用（面板里那枚盘符标签用的是 `online ? path.slice(0,2) : '??'`）。
     */
    path: string;
    online: boolean;
}

async function getHistory(req: Req, res: http.ServerResponse) {
    const serial = req.params?.get('serial') || '';
    const keyword = (req.params?.get('path') || '').trim().toLowerCase();
    const pageNo = Number(req.params?.get('pageNo')) || 1;
    const pageSize = Number(req.params?.get('pageSize')) || 10;

    try {
        const drives = await getDrives();
        const letterOf = new Map<string, string>(drives.map(d => [d.serial, d.drive]));

        let metas = await loadMeta();
        if (serial) metas = metas.filter(m => m.serial === serial);
        if (keyword) metas = metas.filter(m => m.relPath.toLowerCase().includes(keyword));

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
    const ids = req.params?.get('ids');
    if (!ids) {
        return sendJson(res, { code: 500, error: '参数 ids 不能为空' });
    }

    try {
        const numRemoved = await removeByIds(ids.split(','));
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
 * 「备份到文件…」—— 把主库整个复制到用户挑的位置。
 *
 * 为什么不是"生成一份导出格式"：**主库文件本身就是这份数据的完整、自描述形态**
 * （键是 `(serial, relPath, mode)`，盘符不落数据 —— 见 nedb.ts 的 `SearchCache`）。
 * 再包一层导出格式只会多一种"格式不对就废掉"的文件，而没有一个字节的新信息。
 *
 * 所以这里就是 `copyFile`，一个操作、没有中间态、失败也不留半个文件。
 */
async function backupToFile(req: Req, res: http.ServerResponse) {
    const target = bodyPath(req);
    await fsasync.copyFile(CACHE_DB_PATH, target);
    sendJson(res, { code: 200, message: 'ok' });
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

    beginRestore();
    // 覆盖是否已经开始过 —— 只有它才决定"要不要回滚"。
    // 快照那一步失败时主库还没被动过，回滚反而是拿一份旧快照去盖好的库。
    let overwritten = false;

    try {
        await fsasync.copyFile(CACHE_DB_PATH, BEFORE_RESTORE_PATH);
        overwritten = true;
        await fsasync.copyFile(source, CACHE_DB_PATH);
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
    }

    sendJson(res, { code: 200, message: 'ok' });
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
    const incoming = await readExternalCache(source);

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

    sendJson(res, { code: 200, added, replaced, skipped, total: incoming.length });
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
route('/raw', rawController);
route('/getDisks', listDisksController);
route('/getFileTree', getFileTree);
route('/removeHistoryBatch', removeHistoryBatch);
route('/backup', backup);
route('/backupToFile', backupToFile);
route('/restoreFromFile', restoreFromFile);
route('/mergeCache', mergeCache);
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
 */
app.listen(3060, '127.0.0.1', function () {
    console.log('Local Server: http://127.0.0.1:3060/');
}).on('error', function (err: NodeJS.ErrnoException) {
    // 没有 error 监听时，端口被占会让整个 Electron 主进程直接崩掉
    if (err.code === 'EADDRINUSE') {
        console.error('[server] 端口 3060 已被占用。请先结束残留的 file-finder 进程再启动。');
    } else {
        console.error('[server] 本地服务启动失败:', err);
    }
});

// 这里原来有一句「启动时清理旧格式缓存」（dropLegacyRecords）—— 已删除。
// 它的判据是 `{ v: { $ne: 2 } }`，而 nedb 的 `$ne` 连"字段不存在"也匹配，
// 于是一次误删掉了"格式正确、只是没打版本号"的记录；而删除本身就意味着要碰盘。
// 现在版本不符的记录**不会被删**，只在 findCache 里被当作未命中，
// 下次浏览那个目录时被新记录自然覆盖（见 electron/server/nedb.ts）。
