import Nedb from '@seald-io/nedb';
import * as fsasync from 'node:fs/promises';
import crypto from 'node:crypto';
import os from 'node:os';
import config from '../config';
import path from 'node:path';
import dayjs from 'dayjs';
import type { FileInfo } from './index';

export type OpenMode = 'cover' | 'folder';

/**
 * 缓存记录的**格式版本**。
 *
 * 任何让旧记录"读出来语义就不对"的改动都必须 +1。
 *
 * **但版本对不上的记录不会被删**，只在读取时当作未命中（见 `findCache`）——
 * 下次浏览那个目录时 `scanAndCache` 会把它覆盖掉，自然回收。
 * 原来这里靠"启动时删一遍"，而判据是 `{ v: { $ne: 2 } }`，而 nedb 的 `$ne` 连
 * **字段不存在**也匹配 → 实际判据是"没有 v 就删"，等于把"格式完全正确、只是没打
 * 版本号"的记录一起干掉了（实测：备份里就有这么一条，字段集与 v2 逐字相同）。
 * 规则：**任何"格式变化 → 删数据"的逻辑都是错的。**
 *
 * 也别把"不删"当成够用：光有版本判断只能挡住 `findCache` 这一条路，
 * 条目本身还必须按白名单重建（见 `server/index.ts` 的 `pickFileInfo`）。
 *
 * v1：拿完整路径当键、没有 serial，每条内嵌整个 fs.Stats + 原图 base64
 * v2：键改成 (serial, relPath, mode)，条目只留渲染层会用到的字段，缩略图 480px
 */
export const CACHE_VERSION = 2;

/**
 * 一条目录的扫描缓存。
 *
 * 主键是 (serial, relPath, mode)，**不是完整路径**。
 * 盘符只是"当前挂载点"——同一块移动硬盘今天挂 H:、明天插到另一个 USB 口可能就是 K:，
 * 拿完整路径当键，换个口就全查不到了。卷序列号是格式化时写进卷里的，跟着盘走，
 * 所以它是唯一能在"拔了再插"之后还把缓存认回来的东西。
 */
export interface SearchCache {
    _id?: string;
    /** 格式版本。见 CACHE_VERSION */
    v: number;
    /** 卷序列号，8 位大写十六进制 */
    serial: string;
    /** 盘内相对路径，'' 表示盘根 */
    relPath: string;
    mode: OpenMode;
    /** 条目数。冗余存一份，列表查询就能用 { data: 0 } 跳过那坨 base64 */
    count: number;
    data: FileInfo[];
    create_at: string;
}

/** 不含 data 的轻量视图。列表和按盘统计只用得到这些 */
export type CacheMeta = Omit<SearchCache, 'data'>;

export interface Pagination {
    total: number;
    current: number;
    size: number;
}

export interface BrowseHistory {
    /**
     * `path` 是**打开这一行用的地址**，两种形态：
     * 盘在线 → 完整路径（`H:/x`）；盘不在 → 只读锚点（`#序列号/x`，读缓存、不碰盘）。
     * 以前盘不在时这里是 `null`（前端据此置灰），现在两种盘都有地址 —— `online`
     * 仍然说明"盘在不在"（面板上显示「盘未插入」），但**不再决定能不能点**。
     */
    records: (CacheMeta & { path: string; online: boolean })[];
}

export type BrowseHistoryWithPagination = Pagination & BrowseHistory;

const cachePath = path.join(config.userBasePath, 'searchCache.db');

/**
 * 主库的绝对路径。`export` 出来是给「备份到文件 / 从文件还原」用的 ——
 * 那两个动作必须复制**这一个文件**，路径只应该在**这一个地方**定义。
 * 外部（server/index.ts、主进程）想碰这个文件，一律走这个常量，不要再拼一次路径。
 */
export const CACHE_DB_PATH = cachePath;

/**
 * 「还原」之前自动留下的快照。
 *
 * ⚠️ **必须用独立槽位，绝不能借用 `cacheBackup()` 的 `searchCache-YYYYMMDD.db`**：
 * 那个名字是**按天同名覆盖**的（同一天里备份几次就只留最后一次）。
 * 拿它当"还原前的救命稻草"，会出现"还原搞砸了想回退，却发现快照已经被后来的
 * 日常备份盖掉"—— 恰好是最需要它的时候没有。
 */
export const BEFORE_RESTORE_PATH = path.join(config.userBasePath, 'searchCache-before-restore.db');

/**
 * 缓存库的加密密钥。
 *
 * ⚠️ **这个常量一旦改动，所有已存在的缓存库都读不出来**（密文对不上 → 整库被判损坏）。
 * 所以它**写死在这里，不是配置项**。别做成可配的，也别"顺手换个 key" ——
 * 那正是"改口令 = 旧文件全废"那个契约；这里用「密钥永不更改」把它简化掉。
 *
 * 强度（**诚实版**）：**固定密钥 = 混淆级别**。
 * 它防的是"随手用记事本打开看一眼"，**不防有心人** —— 解包之后挖源码能拿到这个字符串。
 * 需求就是这个（用户原话「防打开记事本或者编辑器一眼就能看到内容」），**匹配**；
 * 但**不要对外宣称这是安全存储**，也不要把强度当成"改密钥"的理由。
 */
const CACHE_KEY = crypto.createHash('sha256').update('file-finder-cache-v1-2026-09-24').digest();

/**
 * 固定 IV。
 *
 * **必须确定性加密** —— 同一个 `relPath` 每次出来的密文必须一模一样，
 * 否则 nedb 的 `serial` 索引和 `findCache({ serial, relPath, mode })` 会全部失效：
 * 同一份数据每次加密结果不同，等于键在变，查不回来。
 * 固定 IV 会泄露"相同明文 → 相同密文"这一点，在"防随手打开"这个目标下无所谓。
 */
const CACHE_IV = Buffer.alloc(16, 0);

/**
 * 写盘前：一行明文 JSON → 一行 base64 密文。
 *
 * ⚠️ 输出**绝不能含 `\n`**（nedb 文档明说：含换行会导致数据丢失）。
 * 这也是选 base64 而不是裸二进制的原因 —— base64 字符集是 `A-Za-z0-9+/=`，天然没有换行。
 */
function encryptLine(line: string): string {
    const cipher = crypto.createCipheriv('aes-256-cbc', CACHE_KEY, CACHE_IV);
    return Buffer.concat([cipher.update(line, 'utf8'), cipher.final()]).toString('base64');
}

/**
 * 读盘后：一行密文 → 一行明文 JSON。
 *
 * **兼容明文行 —— 这是旧库"零迁移代码"的关键。**
 * 明文行以 `{` 开头，而 base64 字符集里**没有 `{`**，所以这个判据不会误伤密文。
 * 只要这里放行明文，nedb 启动时那次整库重写（`persistence.js:339`，注释写明
 * "all data is persisted right away, which has the effect of compacting the database file"）
 * 就会把整库自动变成密文 —— 不需要写任何迁移代码、不需要手工转换。
 *
 * 解不开的密文**要抛错、不要吞**：nedb 会把该行算作 corrupt，超过阈值（默认 10%）
 * 就拒绝启动 —— 那正是我们要的"响亮失败"。吞掉它反而会让"密钥不对"
 * 变成一份**悄悄少了很多行的库**（那才是真正的静默丢数据）。
 */
function decryptLine(line: string): string {
    if (line.startsWith('{')) return line;
    const decipher = crypto.createDecipheriv('aes-256-cbc', CACHE_KEY, CACHE_IV);
    return Buffer.concat([decipher.update(Buffer.from(line, 'base64')), decipher.final()]).toString('utf8');
}

const nedb = new Nedb<SearchCache>({
    filename: cachePath,
    afterSerialization: encryptLine,
    beforeDeserialization: decryptLine,
});

/**
 * 加载失败的原因。null = 正常。
 *
 * 为什么要把它记下来：**nedb 加载失败之后，它的 executor 永远不会 ready**，
 * 于是 `count/insert/find/remove` 的回调**永久不会被调用** —— Promise 永不落地，
 * 请求永久挂起。实测形态是**界面卡死**（不是报错、也不是空库），
 * 而且比"报错"难查得多。所以加载失败必须**响亮地失败**。
 */
let loadError: Error | null = null;

/**
 * 正在「从文件还原」—— 这期间**所有读写都必须被挡住**。
 *
 * 为什么还原需要这么一道闸：还原是"整份覆盖主库文件"，而后台批量扫描
 * （「补全这一片」）随时可能正在写同一个文件。`insert/remove` 走的是
 * **追加**（`persistence.js` 的 `persistNewStateAsync` → `appendFileAsync`），
 * 两个句柄同时动一个文件，结果可能是"覆盖写到一半被追加插进来"的残file ——
 * 下一次启动就是整库损坏。这不是理论风险：批量扫描正是**为用户加的**功能。
 *
 * 放在这里而不是"让主进程记得先停扫描"：判断长在**唯一的数据库模块内部**，
 * 将来新增任何写入口都自动受约束；交给调用方就迟早会漏一处。
 */
let restoring = false;

/**
 * 每个读写操作的第一道闸：库不可用（加载失败 / 正在还原）就**立刻抛错**，
 * 绝不进入 nedb 的队列。
 *
 * 这是"修复"而不是"补丁"，理由在**责任放哪**：
 * 判断放在**唯一的数据库模块内部**，下面 6 个导出函数都从这一处过 ——
 * 将来新增第 7 个操作函数，只要它是这个模块的导出、并且过这一道闸，
 * 同样的"永久挂起"就不会复活。反之如果把这个判断交给每个调用方
 * （在 `server/index.ts` 里到处写 `if (loadError)`），新增一个入口忘了写，缺陷立刻复发。
 *
 * 抛出去之后由 `route()` 那个咽喉点接住 → 变成 HTTP 500 + `kind` →
 * 前端已经有现成的失败通道（横幅 + 不清空列表），**前端零改动**。
 */
function assertUsable(): void {
    if (restoring) {
        throw new Error('缓存库正在还原，请稍后再试');
    }
    if (loadError) {
        throw new Error(`缓存库不可用：${loadError.message}`);
    }
}

/**
 * 加载回调：成功清空、失败记下。
 *
 * 成功时必须**清空 `loadError`** —— 否则"还原失败 → 回滚 → 回滚其实成功了"
 * 之后，这个库还是被判为不可用，回滚就白做了。
 * （实测：坏文件 loadDatabase 报错后，把好文件放回去再 load 一次能完全恢复。）
 */
function onLoaded(err: Error | null): void {
    loadError = err;
    if (err) console.error('[nedb] 缓存库载入失败:', err);
}

/**
 * 这两个初始化调用的回调**不能省**。
 *
 * @seald-io/nedb 把「不给回调」实现成「promise 建了但没人接」
 * （datastore.js: `if (typeof callback === 'function') callbackify(() => promise)(callback)`），
 * 而旧版 nedb 是 `var callback = cb || function () {}` —— 静默吞掉。
 * 所以省掉回调就把「静默失败」升级成了 UnhandledPromiseRejection：
 * 数据文件损坏时正好走这条路（实测：抛 "100% of the data file is corrupt"）。
 * 保留回调 = 维持旧行为（进程不因加载失败而炸），顺带把静默失败变成一行可见的日志。
 *
 * 从 2026-09-24 起，回调里除了记日志还**设置 `loadError`** ——
 * 因为库里加了加密，而密钥/文件对不上时恰好就是"加载失败 + 之后永久挂起"这个形态。
 */
nedb.loadDatabase(onLoaded);
// 每次 openFolder 都要按盘取缓存，这是热路径
nedb.ensureIndex({ fieldName: 'serial' }, (err) => {
    if (err) console.error('[nedb] serial 索引创建失败:', err);
});

/**
 * 把主库文件**重新读一遍**（还原之后用）。
 *
 * ⚠️ **能重复调用，这是实测过的**（探针 `%TEMP%/ff-enc-probe/reload.cjs`，6/6 PASS）：
 *   - 二次 `loadDatabase` 之后内存内容 = 新文件内容；
 *   - executor 仍是活的，之后照样能写能读；
 *   - 坏文件会报错且**不改写**坏文件；把好文件放回去再 load 一次能完全恢复。
 *
 * 所以「从文件还原」**不需要重启应用** —— `app.relaunch()` 在 dev 下本来就不可靠
 * （进程是 vite-plugin-electron 起的），重启方案会在开发时"点一下就没了"。
 *
 * 内部会顺带整库重写一次（nedb 自己的行为，见 `persistence.js:339`），这是无害的：
 * 内容一样、只是把文件压缩回"活记录"。
 */
export function reloadFromDisk(): Promise<void> {
    return new Promise((resolve, reject) => {
        nedb.loadDatabase((err) => {
            onLoaded(err);
            err ? reject(err) : resolve();
        });
    });
}

/** 见 `restoring`。由「从文件还原」的入口开启/关闭，成功失败都要关。 */
export function beginRestore(): void {
    restoring = true;
}

export function endRestore(): void {
    restoring = false;
}

export async function cacheBackup() {
    const input = await fsasync.readFile(cachePath);
    await fsasync.writeFile(cachePath.replace('.db', `${dayjs().format('-YYYYMMDD')}.db`), input);
}

/**
 * 读一份**外部**缓存库（用户选中的备份文件），给「合并」用。
 *
 * 三件事必须是这个样子：
 *
 * 1. **用同一套钩子**。备份文件是密文，钩子不同就解不开 —— 会被 nedb 直接判成
 *    "100% of the data file is corrupt"。钩子跟着密钥走，所以只能在这里构造。
 *
 * 2. **先复制到临时文件再读**。`loadDatabase()` 末尾会**无条件整库重写**
 *    （`persistence.js:339`）—— 直接在用户选中的文件上 load，等于**改了用户的备份文件**；
 *    更糟的是如果那个文件在只读介质上（U 盘写保护、光盘、只读共享），
 *    重写失败 → load 报错 → 我们会把一份**完好的备份**报成"这个文件不可用"。
 *    复制一份再读，只读介质也能用，用户的文件一个字节都不会动。
 *
 * 3. **临时文件一定要删**。放系统临时目录（不是数据目录）：那里本来就是"随时可清"的语义，
 *    万一进程被杀留下残file也不会污染 `~/.file-finder`。
 */
export async function readExternalCache(file: string): Promise<SearchCache[]> {
    const dir = await fsasync.mkdtemp(path.join(os.tmpdir(), 'ff-merge-'));
    const copy = path.join(dir, 'source.db');
    try {
        await fsasync.copyFile(file, copy);
        const external = new Nedb<SearchCache>({
            filename: copy,
            afterSerialization: encryptLine,
            beforeDeserialization: decryptLine,
        });
        const docs = await new Promise<SearchCache[]>((resolve, reject) => {
            external.loadDatabase((err) => {
                if (err) return reject(new Error(`这个文件读不出来或不是一份可用的缓存库（${err.message}）`));
                // 和 loadMeta 同一个理由用 Cursor 形式：`find(query, callback)` 那个重载
                // 在 index.d.ts 里会把回调参数标成 any（两个参数就被它吃掉了）。
                // 这里**不加 projection** —— 合并要用完整的 data，不是元数据。
                external.find({}).exec((err2, found) => {
                    err2 ? reject(err2) : resolve(found as SearchCache[]);
                });
            });
        });
        return docs;
    } finally {
        await fsasync.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
}

/**
 * 取单条缓存。命中返回整条文档（含 data），未命中返回 null。
 *
 * **版本对不上的一律当未命中**，而不是删掉它：
 *   - 删要碰盘，而且删掉的是别人将来可能想读的东西（比如一份还没写的迁移工具）
 *   - 不认它就已经够了 —— 下次浏览那个目录时 `scanAndCache` 自己会 `removeCache + insertCache`
 *     把同一主键整条换掉，旧的（不管什么版本）被 remove 一并带走
 *
 * 判断只需要 `v`：主键 `(serial, relPath, mode)` 是记录自己的身份，
 * 版本只决定"这份主键上的内容还算不算数"。
 */
export function findCache(serial: string, relPath: string, mode: OpenMode): Promise<SearchCache | null> {
    assertUsable();
    return new Promise((resolve) => {
        nedb.findOne({ serial, relPath, mode }, (err, doc) => {
            if (err) {
                console.error('[nedb] 查询缓存失败:', err);
                resolve(null);
            } else {
                const found = (doc as SearchCache) || null;
                resolve(found && found.v === CACHE_VERSION ? found : null);
            }
        });
    });
}

export function insertCache(doc: SearchCache): Promise<void> {
    assertUsable();
    return new Promise((resolve, reject) => {
        nedb.insert(doc, (err) => (err ? reject(err) : resolve()));
    });
}

export function removeCache(serial: string, relPath: string, mode: OpenMode): Promise<number> {
    assertUsable();
    return new Promise((resolve, reject) => {
        nedb.remove({ serial, relPath, mode }, {}, (err, n) => (err ? reject(err) : resolve(n)));
    });
}

export function removeByIds(ids: string[]): Promise<number> {
    assertUsable();
    return new Promise((resolve, reject) => {
        nedb.remove({ _id: { $in: ids } }, { multi: true }, (err, n) => (err ? reject(err) : resolve(n)));
    });
}

/**
 * 只取元数据，跳过 data 里那坨 base64。
 * 列表和按盘统计全用它 —— 不带上缩略图，102 条记录也就几十 KB。
 */
export function loadMeta(): Promise<CacheMeta[]> {
    assertUsable();
    return new Promise((resolve, reject) => {
        // 投影走 Cursor 而不是 find(query, projection)：
        // @seald-io/nedb 的 index.d.ts 里 find 的第一个重载是 `(query, projection, callback?) => void`，
        // 两个参数的形式会被它吃掉，于是 `.sort()` 在类型上不存在（运行时没问题，只是类型报错）。
        // `find({})` 只有一个参数 → 命中返回 Cursor 的重载，projection/sort/exec 都带类型。
        // 行为不变：实测 22 条文档无一带 data，整个列表 3213 B。
        nedb.find({}).projection({ data: 0 }).sort({ create_at: -1 }).exec((err, docs) => {
            if (err) {
                reject(err);
            } else {
                resolve(docs as unknown as CacheMeta[]);
            }
        });
    });
}

/**
 * 重写数据文件，回收 append-only 累积的旧版本。
 *
 * nedb 每次 insert/update/remove 都是往文件**尾部追加**（persistence 的
 * persistNewState 走 storage.appendFile），文件只会长不会缩。我们的扫描缓存会反复
 * 覆盖同一个目录，不压缩的话同一个目录的历史版本会一直堆在文件里。
 *
 * 原来这里是手动往 executor 里推任务（因为旧版 compactDatafile() 不收回调）。
 * @seald-io/nedb 4 把内部队列整个异步化了 —— `executor.push` 改名 `pushAsync`、
 * `persistCachedDatabase` 改名 `persistCachedDatabaseAsync` —— 那套私 API 写法已经失效
 * （实测：两个字段都取不到）。而它的公开 compactDatafile() 现在**收回调**，内部走的
 * 就是同一条队列（`executor.pushAsync(persistCachedDatabaseAsync)`），所以直接用公开 API，
 * 不再引用任何私有字段。
 *
 * ⚠️ 现在**没有调用方**：原来唯一的调用者是 `dropLegacyRecords()`（已删 —— 任何
 * "格式变化就删数据"的逻辑都不该存在）。保留它是为了它上面这段换库取证，
 * 以及将来做维护入口（"/compact" 之类）时不必重新踩一遍。
 */
export function compact(): Promise<void> {
    assertUsable();
    return new Promise((resolve, reject) => {
        nedb.compactDatafile((err) => (err ? reject(err) : resolve()));
    });
}

export default nedb;
