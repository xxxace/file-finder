import url from 'node:url';
import http from 'node:http';
import events from 'node:events';
import * as fs from 'node:fs';
import * as fsasync from 'node:fs/promises';
import dayjs from 'dayjs';
import { imageThumb, videoThumb } from '../utils/thumbnail';
import { newThumbKey, putThumb, getThumb, stripThumbData } from '../utils/thumbStore';
import {
    findDriveByLetter, findDuplicatedSerials, getDrives, offlineSerials,
    splitPath, syncRegistry, toFullPath,
} from '../utils/driveIdentity';
import type { DriveInfo } from '../utils/driveIdentity';
import {
    CACHE_VERSION, cacheBackup, dropLegacyRecords, findCache, insertCache, loadMeta,
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
    /** 缩略图的 data URI。只存不发，下发前被 stripThumbData 剥掉 */
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
        return [];
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
        return [];
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
 * 登记缩略图 + 剥掉只存不发的内部字段。
 *
 * **所有**下发路径都必须过这里，且只留这一处。上一版只有"缓存命中"那条路走 `toWire`，
 * 非盘符路径（UNC、网络位置）直接 `sendJson(readFolder(...))` 就出去了 ——
 * 缩略图压根没登记，前端拿到的 key 请求 /thumb 全是 404，整个网格是白框。
 */
function wire(items: FileInfo[]): FileInfo[] {
    return items.map(item => {
        registerThumb(item.thumb, item.thumbData);
        registerThumb(item.avatar, item.avatarThumbData);
        return stripThumbData(item);
    });
}

/**
 * 存储态 → 下发态：把 dir 从盘内相对路径补回**当前**盘符的完整路径。
 *
 * 这一步是整套设计的关键：缓存里不存盘符，所以同一块盘今天挂 H:、明天挂 K: 都不用改数据。
 */
function toWire(items: FileInfo[], drive: string): FileInfo[] {
    return wire(items).map(item => ({ ...item, dir: toFullPath(drive, item.dir) }));
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

    // 先删后插：nedb 是 append-only，直接 insert 会在文件里留下两份，
    // 而且 findCache 会取到旧的那份
    await removeCache(serial, relPath, mode);
    await insertCache(doc);

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

    // 路径 → 盘身份。拿不到序列号（UNC、网络位置、虚拟盘）就退化成"每次真读、不缓存"：
    // 这类路径不存在"拔了再插盘符会变"的问题，也就没有归属问题
    const parts = splitPath(raw);
    const disk = parts ? await findDriveByLetter(parts.drive) : null;

    if (!parts || !disk) {
        if (!parts) console.warn('[openFolder] 路径不是盘符开头，本次跳过缓存:', raw);
        // 不缓存，但**必须过 wire()** —— 缩略图是在这一步才登记进内存索引的，漏了它
        // 前端拿到的 key 请求 /thumb 全是 404。dir 原样保留完整路径：
        // 这类路径不存在"拔了再插盘符会变"的问题，也就不需要拆出盘内相对路径
        return sendJson(res, wire(await readFolder(raw, mode, '', raw)));
    }

    const { serial, drive } = disk;
    const relPath = parts.relPath;

    if (noCache) await removeCache(serial, relPath, mode);

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
    /** 当前完整路径。盘没插时为 null */
    path: string | null;
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
                    // 盘不在线时给 null —— 前端据此置灰，而不是给一个点不开的路径
                    path: drive ? toFullPath(drive, m.relPath) : null,
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

event.on('/getHistory', getHistory);
event.on('/openFolder', openFolderController);
event.on('/thumb', thumbController);
event.on('/raw', rawController);
event.on('/getDisks', listDisksController);
event.on('/getFileTree', getFileTree);
event.on('/removeHistoryBatch', removeHistoryBatch);
event.on('/backup', backup);
event.on('/', function (_req, res) {
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

// 旧格式缓存（没有盘序列号的那批）没法归属到任何一块盘，而且存的是原图 base64。
// 清理前会先备份一份。放在 listen 之后，不拖慢启动
dropLegacyRecords().catch(e => console.error('[server] 清理旧缓存失败:', e));
