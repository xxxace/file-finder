import fs from 'node:fs';
import * as fsasync from 'node:fs/promises';
import path from 'node:path';
import config from '../config';
import { encryptBlob, decryptBlob } from './cacheCrypto';

/**
 * 图片仓（bin）—— 缩略图与预览大图的**统一落盘点**，内容加密、按内容指纹命名。
 *
 * 为什么图片不再放库（`thumbData` 那种 base64 字段）：
 *   ① **base64 白交 +33%**（实测：39 KB 的 JPEG 存成 base64 是 52 KB；
 *      `gzip(base64)` 只能把这 33% 捞回来、对 JPEG 本身 0 收益 ⇒ 搬出来比 gzip 更彻底）；
 *   ② 库是**整库载入内存 + 每次启动整库重写**（`nedb.ts` 注释）⇒ 图片留在库里等于
 *      每次启动都搬运几十 MB，内存里也常驻着几十 MB 字符串；
 *   ③ 图片本来就不需要"每行一行 JSON"这种形态，它是二进制。
 *
 * 命名：`<kind>-<sig>.enc`
 *   kind = `t`（缩略图，网格用）/ `p`（预览大图）。两者**恒为 JPEG**，所以没有扩展名，
 *          下发时的 `Content-Type` 也恒为 `image/jpeg`（不做内容嗅探 —— 见 thumbnail.ts）。
 *   sig  = **这一张源图的标识**，取自**缩略图字节**的 sha1（⚠️ 不是大图的指纹，
 *          理由与实测证据见 server/index.ts 的 makeRenditions）。
 *          换封面 ⇒ 缩略图变 ⇒ sig 变 ⇒ **两个 URL 都变** ⇒ 浏览器缓存不会拿旧图挡着。
 * `t-<sig>` 与 `p-<sig>` 是**同一源的两个尺寸**（对称）：`p-` 可能暂时不存在
 * （老记录只有缩略图），扫到那一层时会补齐。内容相同的两张图共用一个文件（天然去重）。
 *
 * ⚠️ **永不自动删**（缓存层铁律）：换图/改名会留下孤儿文件；要清只能靠一条**显式**命令。
 */
export const BIN_DIR = path.join(config.userBasePath, 'bin');

/** 已存在的图片名集合。启动时 `readdir` 一次（≈千级条目、几十字节/条），之后 O(1) 判断 */
const names = new Set<string>();
let loadError: unknown = null;

/**
 * 启动时调一次，**只调一次**（重复 readdir 只是白费）。
 * **失败不抛**：bin 读不到只该表现成"图片没有"，不该让整个 app 起不来。
 *
 * 返回的 Promise 就是"图片仓就绪"的信号 —— 服务端要 **await 它再 listen**，
 * 否则启动那零点几秒里 `names` 还是空集，首屏会是一排白格子（见 server/index.ts 的 listen）。
 */
export function initBinStore(): Promise<void> {
    return ready;
}

const ready = (async () => {
    try {
        await fsasync.mkdir(BIN_DIR, { recursive: true });
        for (const name of await fsasync.readdir(BIN_DIR)) {
            if (name.endsWith('.enc')) names.add(name);
        }
    } catch (e) {
        loadError = e;
        console.error('[bin] 图片仓初始化失败（图片将不可用，其余功能不受影响）:', e);
    }
})();

/** 等图片仓就绪（已就绪则立即 resolve）。**服务端的 listen 必须挂在它后面** */
export function whenBinReady(): Promise<void> {
    return ready;
}

/** 图片仓是不是没就绪（只用在下发态：没就绪就不给前端 key，免得满屏 404 白框） */
export function binStoreFailed(): boolean {
    return loadError !== null;
}

export function hasBin(name?: string): boolean {
    return !!name && names.has(name);
}

export function getBin(name: string): Buffer | null {
    if (!names.has(name)) return null;
    try {
        return decryptBlob(fs.readFileSync(path.join(BIN_DIR, name)));
    } catch (e) {
        // 单个文件坏掉不该拖垮这一屏；删掉它的登记，下次扫描会重建
        console.error('[bin] 读取/解密失败:', name, e);
        names.delete(name);
        return null;
    }
}

/**
 * 写一张图。**原子写**（先写 `.tmp-*` 再 rename）+ 失败只记日志（扫描不能被它拖死）。
 *
 * rename 在同一卷上是原子的 ⇒ 浏览侧永远看不到半个文件（那种"半截 JPEG"会让
 * 浏览器拿到一张画到一半的图，且会被 `immutable` 缓存钉住一年）。
 */
export async function putBin(name: string, plain: Buffer): Promise<void> {
    if (loadError || !name) return;
    const target = path.join(BIN_DIR, name);
    const tmp = `${target}.tmp-${process.pid}-${Date.now().toString(36)}`;
    try {
        await fsasync.writeFile(tmp, encryptBlob(plain));
        await fsasync.rename(tmp, target);
        names.add(name);
    } catch (e) {
        console.error('[bin] 写入失败:', name, e);
        fsasync.unlink(tmp).catch(() => { });
    }
}

/** 全部图片名（备份打包时用） */
export function listBinNames(): string[] {
    return [...names];
}

/**
 * 直接落一份**已经加密**的字节（迁移/还原/合并时从别的包里搬过来用）。
 * 不重复加密 —— 包里那份本来就是密文，再套一层会解不开。
 */
export async function putBinEncrypted(name: string, encrypted: Buffer): Promise<void> {
    if (loadError || !name) return;
    const target = path.join(BIN_DIR, name);
    const tmp = `${target}.tmp-${process.pid}-${Date.now().toString(36)}`;
    try {
        await fsasync.writeFile(tmp, encrypted);
        await fsasync.rename(tmp, target);
        names.add(name);
    } catch (e) {
        console.error('[bin] 落盘失败（来自包）:', name, e);
        fsasync.unlink(tmp).catch(() => { });
    }
}

/** 仓库概况（面板/探针用）：条数与总字节。**只 stat，不读内容** */
export async function binStats(): Promise<{ count: number; bytes: number }> {
    let bytes = 0;
    try {
        for (const name of names) {
            try { bytes += (await fsasync.stat(path.join(BIN_DIR, name))).size; } catch { }
        }
    } catch { /* 忽略 */ }
    return { count: names.size, bytes };
}
