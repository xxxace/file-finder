import Nedb from '@seald-io/nedb';
import * as fsasync from 'node:fs/promises';
import config from '../config';
import path from 'node:path';
import dayjs from 'dayjs';
import type { FileInfo } from './index';

export type OpenMode = 'cover' | 'folder';

/**
 * 缓存记录的**格式版本**。
 *
 * 任何让旧记录"读出来语义就不对"的改动都必须 +1，旧记录会在下次启动时被回收
 * （见 dropLegacyRecords）。否则会出现这种事：新代码写的是干净记录，而库里躺着
 * 一批上一版写进去的胖记录（每条多带 17 个 fs.Stats 字段，还夹着扫描当刻的卷序列号 dev），
 * 它们既不会报错也不会自己消失，只是悄悄违反"缓存里不存盘身份"这条不变量。
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
    records: (CacheMeta & { path: string | null; online: boolean })[];
}

export type BrowseHistoryWithPagination = Pagination & BrowseHistory;

const cachePath = path.join(config.userBasePath, 'searchCache.db');
const nedb = new Nedb<SearchCache>({ filename: cachePath });

/**
 * 这两个初始化调用的回调**不能省**。
 *
 * @seald-io/nedb 把「不给回调」实现成「promise 建了但没人接」
 * （datastore.js: `if (typeof callback === 'function') callbackify(() => promise)(callback)`），
 * 而旧版 nedb 是 `var callback = cb || function () {}` —— 静默吞掉。
 * 所以省掉回调就把「静默失败」升级成了 UnhandledPromiseRejection：
 * 数据文件损坏时正好走这条路（实测：抛 "100% of the data file is corrupt"）。
 * 保留回调 = 维持旧行为（进程不因加载失败而炸），顺带把静默失败变成一行可见的日志。
 */
nedb.loadDatabase((err) => {
    if (err) console.error('[nedb] 缓存库载入失败:', err);
});
// 每次 openFolder 都要按盘取缓存，这是热路径
nedb.ensureIndex({ fieldName: 'serial' }, (err) => {
    if (err) console.error('[nedb] serial 索引创建失败:', err);
});

export async function cacheBackup() {
    const input = await fsasync.readFile(cachePath);
    await fsasync.writeFile(cachePath.replace('.db', `${dayjs().format('-YYYYMMDD')}.db`), input);
}

/** 取单条缓存。命中返回整条文档（含 data），未命中返回 null */
export function findCache(serial: string, relPath: string, mode: OpenMode): Promise<SearchCache | null> {
    return new Promise((resolve) => {
        nedb.findOne({ serial, relPath, mode }, (err, doc) => {
            if (err) {
                console.error('[nedb] 查询缓存失败:', err);
                resolve(null);
            } else {
                resolve((doc as SearchCache) || null);
            }
        });
    });
}

export function insertCache(doc: SearchCache): Promise<void> {
    return new Promise((resolve, reject) => {
        nedb.insert(doc, (err) => (err ? reject(err) : resolve()));
    });
}

export function removeCache(serial: string, relPath: string, mode: OpenMode): Promise<number> {
    return new Promise((resolve, reject) => {
        nedb.remove({ serial, relPath, mode }, {}, (err, n) => (err ? reject(err) : resolve(n)));
    });
}

export function removeByIds(ids: string[]): Promise<number> {
    return new Promise((resolve, reject) => {
        nedb.remove({ _id: { $in: ids } }, { multi: true }, (err, n) => (err ? reject(err) : resolve(n)));
    });
}

/**
 * 只取元数据，跳过 data 里那坨 base64。
 * 列表和按盘统计全用它 —— 不带上缩略图，102 条记录也就几十 KB。
 */
export function loadMeta(): Promise<CacheMeta[]> {
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
 */
export function compact(): Promise<void> {
    return new Promise((resolve, reject) => {
        nedb.compactDatafile((err) => (err ? reject(err) : resolve()));
    });
}

/**
 * 一次性清理：删掉**格式过时**的缓存记录。
 *
 * 判断条件只写 `v !== CACHE_VERSION` 一个：旧记录连 v 字段都没有，而 nedb 的 `$ne`
 * 会匹配"字段不存在"的文档（已用真实 nedb 验过），所以一个条件同时覆盖了
 * "从没有过版本号的旧库"和"以后版本再变"两种情况。
 *
 * 旧记录不能用，有两个原因：
 *   1. 拿完整路径当键、没有 serial —— 盘符一拔一插就变了，它们归属不到任何一块盘
 *   2. 每条把整个 fs.Stats 序列化了进去，包含扫描那一刻的**卷序列号 dev**
 * 而且它们存的是**原图** base64，正是数据文件涨到 100 MB 的原因。
 *
 * 删之前先备份一份，后悔了还能捞回来；删完 compact 一次，把 append-only 累积的旧版本收掉。
 *
 * 返回删除条数，0 表示没有旧记录（正常情况）。
 */
export async function dropLegacyRecords(): Promise<number> {
    const legacy: number = await new Promise((resolve) => {
        nedb.count({ v: { $ne: CACHE_VERSION } }, (err, n) => resolve(err ? 0 : n));
    });

    if (!legacy) return 0;

    console.warn(`[nedb] 发现 ${legacy} 条旧格式缓存（版本不是 v${CACHE_VERSION}），先备份再清理`);
    await cacheBackup();

    const removed: number = await new Promise((resolve) => {
        nedb.remove({ v: { $ne: CACHE_VERSION } }, { multi: true }, (err, n) => resolve(err ? 0 : n));
    });

    await compact();
    console.warn(`[nedb] 已清理 ${removed} 条旧缓存，数据文件已压缩`);

    return removed;
}

export default nedb;
