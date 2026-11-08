import { getAction } from '@/utils/request';

const API_BASE = 'http://127.0.0.1:3060';

export interface DriveContext {
    serial: string;
    relPath: string;
    online: boolean;
}

interface DiskEntry {
    serial: string;
    drive: string;
    online?: boolean;
}

/**
 * 把主界面传进来的路径解析成「盘序列号 + 盘内相对路径 + 是否在线」。
 *
 * 三种输入形态都得认（历史原因，都还在用）：
 *   - 直接给了 `serial`（调用方已经知道）→ 原样用
 *   - `#SERIAL/rel/path`（离线只读锚点）→ 拆开，**一律判为离线**
 *   - `H:/xxx`（在线盘符）→ 反查盘表；内存里没有就带 `refresh=true` 重新探测一次
 *
 * ⚠️ 判据必须落在"这块盘的当前状态"，不能落在"传进来的字符串长什么样"：
 * 曾经因为只看 `path.startsWith('#')` 就判定离线，盘插回来也打不开。
 */
export async function resolveDriveContext(opts: {
    serial?: string;
    relPath?: string;
    isOnline?: boolean;
    currentPath?: string;
}): Promise<DriveContext> {
    if (opts.serial) {
        return { serial: opts.serial, relPath: opts.relPath ?? '', online: opts.isOnline ?? true };
    }

    const pathStr = opts.currentPath ?? '';
    if (!pathStr) return { serial: '', relPath: '', online: false };

    const disks = async (refresh: boolean): Promise<DiskEntry[]> =>
        ((await getAction(`${API_BASE}/getDisks${refresh ? '?refresh=true' : ''}`))?.disks ?? []) as DiskEntry[];

    /**
     * `#SERIAL/rel` 只说明"进面板那一刻它是离线只读锚点"，
     * **不代表这块盘现在还没插回来** —— 盘插回来之后还判离线就打不开、也扫不了。
     * 所以这里同样去盘表里查当前状态：先读内存表（零读盘），查不到才带 refresh 探一次。
     */
    if (pathStr.startsWith('#')) {
        const rest = pathStr.slice(1);
        const cut = rest.indexOf('/');
        const serial = cut === -1 ? rest : rest.slice(0, cut);
        const relPath = cut === -1 ? '' : rest.slice(cut + 1);
        try {
            const bySerial = (all: DiskEntry[]) => all.find(d => d.serial === serial) ?? null;
            const disk = bySerial(await disks(false)) ?? bySerial(await disks(true));
            return { serial, relPath, online: disk ? disk.online !== false : false };
        } catch {
            return { serial, relPath, online: false };
        }
    }

    const letter = pathStr.match(/^([A-Za-z]):[\\/]?/)?.[1]?.toUpperCase();
    if (!letter) return { serial: '', relPath: '', online: false };

    const relPath = pathStr
        .replace(/^[A-Za-z]:[\\/]?/, '')
        .replace(/\\/g, '/')
        .replace(/^\/+/, '')
        .replace(/\/+$/, '');

    const find = (list: DiskEntry[]) => list.find(d => d.drive?.toUpperCase() === letter) ?? null;
    try {
        let disk = find(await disks(false));
        if (!disk?.serial) disk = find(await disks(true));
        return disk?.serial
            ? { serial: disk.serial, relPath, online: disk.online !== false }
            : { serial: '', relPath, online: false };
    } catch {
        return { serial: '', relPath, online: false };
    }
}
