/**
 * 移动硬盘热插拔 —— **事件驱动，零轮询**。
 *
 * 方案与参数都来自真机实测（见 `docs/probes/hotplug/`）：
 *
 *   · `hookWindowMessage(0x0219)` 能**直接**收到 `DBT_DEVICEARRIVAL (0x8000)` 与
 *     `DBT_DEVICEREMOVECOMPLETE (0x8004)` —— 不像轮询那样需要周期性去问"有没有新盘"，
 *     也就**不会**在盘空闲时反复 stat 盘符、把休眠中的移动盘唤醒。
 *     （注：Electron 官方 issue #8190 说这两个码会被 Chromium 过滤，**实测相反**。）
 *
 *   · 一次插拔会来**一簇**消息：插入 5~8 条、移除 2~3 条，全挤在 ~100ms 内 ⇒ 必须去抖。
 *
 *   · 更要紧的一条：**消息比"盘真正挂好"来得早**。实测消息到了之后立刻复核
 *     `scanDrives()` 仍是旧的盘数，约 **1.2 秒**后才 stat 得到新盘。
 *     ⇒ 所以"没变化"不等于"没事发生"，要**再确认几次**（见 `MAX_RETRY`）。
 *
 * 本文件**唯一**的读盘：确认到设备真的变化时跑一次 `getDrives(true)` ——
 * 26 个盘符各一次 `stat`（实测 2 ms）；不存在的盘符立即 ENOENT、不产生硬件 IO。
 */
import type { BrowserWindow } from 'electron';
import { getDrives } from '../utils/driveIdentity';
import type { DriveInfo } from '../utils/driveIdentity';

const WM_DEVICECHANGE = 0x0219;

/** 去抖窗口：滤掉一簇消息，同时给系统留出"开始挂卷"的时间 */
const DEBOUNCE_MS = 400;

/** 没变化时最多再确认几次。3 次 × 400ms = 1.2s，正好覆盖实测的"挂载延迟" */
const MAX_RETRY = 2;

/** 盘列表的**身份快照**：序列号是身份，盘符只是当前挂载点 —— 两个都要，因为换了盘符也算变化 */
const snapshot = (ds: DriveInfo[]) => ds.map((d) => `${d.serial}@${d.drive}`).sort().join('|');

export function watchDiskChanges(win: BrowserWindow): void {
    // `hookWindowMessage` 只有 Windows 有；其他平台没有这个机制，不装
    if (process.platform !== 'win32') return;

    let last = '';
    let seeded = false;
    let timer: NodeJS.Timeout | null = null;

    const check = async (attempt: number): Promise<void> => {
        if (win.isDestroyed()) return;

        // `getDrives(true)` 强制重扫，**并且顺带把进程内那份盘列表缓存换成新的** ——
        // 服务端的 `/getDisks`、`findDriveByLetter` 读的都是它，所以这一步等于一次全局宣告。
        const drives = await getDrives(true).catch(() => null);
        if (!drives) return;

        const next = snapshot(drives);
        if (next !== last) {
            // 第一次拿到快照不算"变化"（那只是基线初始化），否则一启动就会白推一次
            if (seeded) {
                win.webContents.send('ff-disks-changed', drives.map((d) => ({ serial: d.serial, drive: d.drive })));
            }
            last = next;
            seeded = true;
            return;
        }

        // 没变化 —— 很可能是"消息比盘挂好来得早"，再等一轮确认
        if (attempt < MAX_RETRY) {
            timer = setTimeout(() => { timer = null; void check(attempt + 1); }, DEBOUNCE_MS);
        }
    };

    /** 收到任何设备变化消息：只重置定时器，不当场干活（一簇消息会被并成一次） */
    win.hookWindowMessage(WM_DEVICECHANGE, () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => { timer = null; void check(0); }, DEBOUNCE_MS);
    });

    // 基线快照：先拿一次当前盘列表，之后才谈得上"变了没有"
    void getDrives().then((ds) => {
        last = snapshot(ds);
        seeded = true;
    });

    win.on('closed', () => {
        if (timer) clearTimeout(timer);
    });
}
