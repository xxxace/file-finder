/**
 * 探针专用桩：**内存版**缓存库。
 *
 * 为什么不打包真 `./nedb`：
 *   ① `@seald-io/nedb` 是 CJS —— esbuild 打成 ESM 后，它内部的 `require('events')`
 *      会退化成动态 require，直接 `Error: Dynamic require of "events" is not supported`；
 *   ② 真库会**落盘**（`searchCache.db`）。只读探针不该写盘，更不该碰主人的真库。
 *
 * 本次改动**没有触碰 nedb 本身**（只是多调了一次 `findCache`），所以这里只要忠实复刻它的
 * **对外语义**就够：主键 `(serial, relPath, mode)`、写入是「先删后插」、读出来的必须是**全新对象**
 * （真 nedb 会反序列化，共享引用会让"意外复用同一个对象"的 bug 在探针里**看不见**）。
 */
const docs = new Map();
const keyOf = (serial, relPath, mode) => `${serial}\u0000${relPath}\u0000${mode}`;
const clone = (v) => JSON.parse(JSON.stringify(v));

export const CACHE_VERSION = 2;
export const CACHE_DB_PATH = '(probe: in-memory)';
export const BEFORE_RESTORE_PATH = '(probe: in-memory)';

export function findCache(serial, relPath, mode) {
    const hit = docs.get(keyOf(serial, relPath, mode));
    return Promise.resolve(hit ? clone(hit) : null);
}

export function insertCache(doc) {
    docs.set(keyOf(doc.serial, doc.relPath, doc.mode), clone(doc));
    return Promise.resolve();
}

export function removeCache(serial, relPath, mode) {
    return Promise.resolve(docs.delete(keyOf(serial, relPath, mode)) ? 1 : 0);
}

export function loadMeta() {
    // 保留 data 之外的字段；`count` 真库里是冗余存的
    return Promise.resolve([...docs.values()].map((d) => {
        const { data, ...meta } = d;
        return { ...meta, count: data.length };
    }));
}

export function loadSubtreeBytes() {
    return Promise.resolve(new Map());
}

export function mergeSubtreeBytes() {
    return { bytes: 0 };
}

export function beginRestore() {}
export function endRestore() {}
export function reloadFromDisk() { return Promise.resolve(); }
export async function cacheBackup() { return { ok: true }; }
export async function readExternalCache() { return []; }
export async function compact() {}
