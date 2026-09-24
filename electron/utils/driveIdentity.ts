import * as fsasync from 'node:fs/promises';
import config from '../config';

/**
 * 卷序列号 —— 硬盘的稳定身份。
 *
 * Windows 上 fs.Stats.dev 就是卷序列号：
 *   libuv src/win/fs.c → fs__stat_assign_statbuf()
 *   statbuf->st_dev = stat_info.VolumeSerialNumber.LowPart;
 * 序列号取自 NtQueryVolumeInformationFile(FileFsVolumeInformation)，**与盘符无关**。
 *
 * 所以同一块移动硬盘：
 *   今天挂成 H: → serial FE91E472
 *   明天挂成 K: → serial FE91E472   ← 不变，这正是定位磁盘的依据
 *
 * 对比盘符：`H:` 今天可能是移动硬盘，明天可能是光驱或另一个分区。**盘符不是身份，只是当前挂载点。**
 */
export type Serial = string;

export interface DriveInfo {
    /** 8 位大写十六进制，卷序列号 */
    serial: Serial;
    /** 当前挂载盘符，'H' */
    drive: string;
    /** 'H:/' */
    root: string;
    /** 用户起的名字，来自注册表；没有则为空串 */
    label: string;
}

export interface DiskRecord {
    label: string;
    firstSeenAt: string;
    lastSeenAt: string;
}

/** serial → 盘的信息。放在 ~/.file-finder/，和 searchCache.db 同目录 */
export type DiskRegistry = Record<Serial, DiskRecord>;

/**
 * 只扫 C..Z。**跳过 A: 和 B:** —— 这两个盘符在 Windows 上保留给软驱，
 * 访问它们可能触发硬件层的"请插入磁盘"阻塞。
 */
const LETTERS = 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

/** 每批并发探测的盘符数。node 的线程池默认 4，8 足够把 stat 请求填满又不至于排队太久 */
const BATCH = 8;

export function toSerial(dev: number): Serial {
    return dev.toString(16).toUpperCase().padStart(8, '0');
}

/**
 * 探测单个盘符。只做一次 stat —— 不存在的盘符会立刻 ENOENT，不做多余的 existsSync。
 * 用异步 API 而不是 statSync：这批探测在启动路径上，不能阻塞主进程。
 */
async function probe(letter: string): Promise<DriveInfo | null> {
    const root = `${letter}:/`;
    try {
        const stat = await fsasync.stat(root);
        // dev 为 0 表示拿不到卷信息（部分虚拟盘/网络盘会这样），不做身份使用
        if (!stat.dev) return null;
        return { serial: toSerial(stat.dev), drive: letter, root, label: '' };
    } catch {
        return null;
    }
}

/**
 * 枚举当前所有已挂载的盘。
 * 多块移动硬盘同时插入时天然都在这份列表里；拔掉的盘不出现在结果中。
 */
export async function scanDrives(): Promise<DriveInfo[]> {
    const found: DriveInfo[] = [];
    for (let i = 0; i < LETTERS.length; i += BATCH) {
        const batch = LETTERS.slice(i, i + BATCH);
        const part = await Promise.all(batch.map(probe));
        for (const info of part) {
            if (info) found.push(info);
        }
    }
    return found;
}

/**
 * 同一序列号出现在多个挂载点 —— 只有克隆盘/镜像盘会这样（卷序列号是格式化时写进卷里的，
 * 用 Ghost 之类的工具整盘复制会把这个值一起复制）。
 * 这时盘符无法区分两块盘，需要提示用户。
 */
export function findDuplicatedSerials(drives: DriveInfo[]): Serial[] {
    const counter = new Map<Serial, number>();
    for (const d of drives) {
        counter.set(d.serial, (counter.get(d.serial) ?? 0) + 1);
    }
    return [...counter.entries()].filter(([, n]) => n > 1).map(([serial]) => serial);
}

/**
 * 进程内的盘列表缓存。
 * 一次扫描只要 2 ms，但也没必要每次 openFolder 都扫 26 个盘符 —— 启动时扫一次即可。
 * 找不到目标盘时再强制刷新一次（用于"刚好新插了一块盘"的场景）。
 */
let cached: DriveInfo[] | null = null;

export async function getDrives(refresh = false): Promise<DriveInfo[]> {
    if (refresh || !cached) cached = await scanDrives();
    return cached;
}

/**
 * 按当前盘符找盘。
 * 服务端拿到的是用户给的路径（`H:/xxx`），要反查它落在哪块盘上才能拿到序列号。
 *
 * 这里**不能**直接信内存里那份盘列表。盘符是会被复用的：移动硬盘 A 原来挂 H:，
 * 拔掉后把 B 插到同一个 H:，缓存里的 "H → A的序列号" 就过期了。若照着它查缓存，
 * 用户看到的是 A 的封面清单 —— 这正是"两块盘数据冲突"的形态。
 *
 * 所以先用一次 stat 复核这个盘符现在到底是谁（单个盘符一次 stat，约 0.1ms）。
 * 主人换了就整表作废重扫。
 */
export async function findDriveByLetter(letter: string): Promise<DriveInfo | null> {
    const up = letter.toUpperCase();
    const cachedHit = (await getDrives()).find(d => d.drive === up);
    const fresh = await probe(up);

    // 盘符现在 stat 不到（拔了、光驱空仓）→ 缓存里那条也已经失效
    if (!fresh) {
        if (!cachedHit) return null;
        return (await getDrives(true)).find(d => d.drive === up) ?? null;
    }

    // 快路径：盘符的主人没变，直接用缓存对象（带上 label）
    if (cachedHit && cachedHit.serial === fresh.serial) return cachedHit;

    const refreshed = await getDrives(true);
    return refreshed.find(d => d.drive === up) ?? null;
}

/**
 * 把完整路径拆成「盘符 + 盘内相对路径」。
 *   'H:\新建文件夹/x'  →  { drive: 'H', relPath: '新建文件夹/x' }
 *   'H:/'              →  { drive: 'H', relPath: '' }
 * 拆不出来（UNC 路径 / 非盘符开头）返回 null。
 */
export function splitPath(fullPath: string): { drive: string; relPath: string } | null {
    const m = /^([A-Za-z]):[\\/]?(.*)$/.exec(fullPath);
    if (!m) return null;
    return { drive: m[1].toUpperCase(), relPath: (m[2] || '').replace(/\\/g, '/') };
}

/**
 * 相对路径 → 完整路径。relPath 为空表示盘根目录，此时返回 'H:'（不带斜杠），
 * 这样调用方拼 `${dir}/文件名` 不会出现双斜杠。
 */
export function toFullPath(drive: string, relPath: string): string {
    return relPath ? `${drive}:/${relPath}` : `${drive}:`;
}


const registryPath = () => `${config.userBasePath}/disks.json`;

export async function readRegistry(): Promise<DiskRegistry> {
    try {
        const raw = await fsasync.readFile(registryPath(), 'utf8');
        const parsed = JSON.parse(raw);
        return (parsed && typeof parsed === 'object') ? parsed as DiskRegistry : {};
    } catch {
        // 首次运行没有这个文件，属正常情况
        return {};
    }
}

export async function writeRegistry(registry: DiskRegistry): Promise<boolean> {
    try {
        await fsasync.mkdir(config.userBasePath, { recursive: true });
        await fsasync.writeFile(registryPath(), JSON.stringify(registry, null, 2), 'utf8');
        return true;
    } catch (e) {
        console.error('[driveIdentity] 写入盘注册表失败:', e);
        return false;
    }
}

/**
 * 把本次扫描到的盘并入注册表：已有盘只更新 lastSeenAt，新盘首次登记。
 * 返回并入后的注册表，顺带把 label 回填到 drives 上。
 */
export async function syncRegistry(drives: DriveInfo[], now: string): Promise<DiskRegistry> {
    const registry = await readRegistry();

    for (const d of drives) {
        const existed = registry[d.serial];
        if (existed) {
            existed.lastSeenAt = now;
        } else {
            registry[d.serial] = { label: '', firstSeenAt: now, lastSeenAt: now };
        }
        d.label = registry[d.serial].label;
    }

    await writeRegistry(registry);
    return registry;
}

/** 注册表里有、但当前没插的盘 —— 用来在缓存界面上把"离线盘"也列出来 */
export function offlineSerials(registry: DiskRegistry, drives: DriveInfo[]): Serial[] {
    const online = new Set(drives.map(d => d.serial));
    return Object.keys(registry).filter(serial => !online.has(serial));
}
