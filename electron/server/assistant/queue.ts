/**
 * 管理助手 · 抓取队列（有界并发 + 同主机限速 + 退避重试 + 可取消）
 * ===========================================================================
 * 对应 PRD D5（长任务 job 化）与 §12（抓取限速，不与 ffprobe 并发叠压）。
 *
 * 并发策略（2026-09-25 用户拍板："抓取好慢，一次 5 个"）：
 *   - **抓取**（页面抽取）：有界并发，`GRAB_PARALLEL`（grab.ts）个 worker 同时在飞；
 *     同主机两次**发起**之间仍强制 ≥ HOST_GAP_MS —— 请求到达节奏不变，防封底线不动。
 *   - **写盘**（apply 下载 + 落盘）：仍然走 `enqueue` 全局串行 —— 它真的在动移动硬盘，
 *     串行是硬件保护，不为快让路。
 *
 * `runPaced` 是两者的分界：只守主机间隔、不排队（给并发 worker 用）；
 * `enqueue` = runPaced + 全局串行链（给写盘用）。
 *
 * 取消：统一走 AbortSignal。`CancelledError` 是**控制流**不是错误 ——
 * 谁都不该把它当成"抓取失败"记进结果里（那会让用户看到一堆红字）。
 */
import type { BrowserWindow } from 'electron';

/**
 * 同一主机两次**发起**之间的最小间隔（毫秒）。
 *
 * 2026-11-14：1500 → 1200（主人裁决：「不考虑封禁风险，1000-1200 我认为已经足够了」）。
 * ⚠️ 这条只管"发起节奏"，和"同时在飞几个"是两个维度 —— 混着调会得出错的结论。
 */
const HOST_GAP_MS = 1_200;

/**
 * 每次重试前的等待（毫秒）。长度即"最多再试几次"。
 * 只对**超时**重试 —— 被 Cloudflare 拦是状态问题，重试再快也没用（该走人工过验证）。
 */
const RETRY_DELAYS = [1_200, 3_600];

/** 用户点了取消。是控制流信号，不是失败原因。 */
export class CancelledError extends Error {
    constructor() {
        super('cancelled');
        this.name = 'CancelledError';
    }
}

/** 从 URL 取主机名；取不到就归到同一个兜底桶（宁可多等，不可漏限速） */
export function hostOf(url: string): string {
    try {
        return new URL(url).host || '(unknown)';
    } catch {
        return '(unknown)';
    }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(new CancelledError());
            return;
        }
        const onAbort = () => {
            clearTimeout(timer);
            reject(new CancelledError());
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

/** 主进程里的"写盘线程"：任何时候只有一条链在跑 */
let chain: Promise<unknown> = Promise.resolve();
/** host → 下一次允许发起请求的时刻 */
const nextSlotAt = new Map<string, number>();
/** host → 当前正在飞的请求数（防单个主机被过多窗口同时压垮） */
const activePerHost = new Map<string, number>();
/**
 * 同一主机最多几个请求同时在飞。
 *
 * ⚠️ 必须 **≥ 抓取 worker 数**（`grab.ts` 的 `GRAB_PARALLEL` = 5），否则多出来的 worker
 * 只是换个地方排队：并发开到 5 而这里只放 3 个，第 4、5 个会卡在这条闸门上 ——
 * 形式上加了并发，实际吞吐一点没变（2026-11-14 自检抓到过一次）。
 */
const MAX_ACTIVE_PER_HOST = 5;
const hostWaiters = new Map<string, (() => void)[]>();

async function acquireHostSlot(host: string, signal?: AbortSignal): Promise<void> {
    while ((activePerHost.get(host) ?? 0) >= MAX_ACTIVE_PER_HOST) {
        if (signal?.aborted) throw new CancelledError();
        await new Promise<void>((resolve, reject) => {
            /**
             * ⚠️ 取消时**必须按排队项本身**摘除，不能按 `resolve` 摘。
             * 队列里存的是包了一层清理逻辑的 `waiter`，`indexOf(resolve)` 恒为 -1 ——
             * 被取消的那一项会留在队里，下一次 `releaseHostSlot` 把它叫醒时空转一格，
             * 后面真正在等的那个反而没被叫到（极端情况下那张卡会永远卡在闸门前，
             * job 停在 running，界面上就是"卡住了"）。
             */
            const waiter = () => {
                signal?.removeEventListener('abort', onAbort);
                resolve();
            };
            const onAbort = () => {
                const arr = hostWaiters.get(host);
                if (arr) {
                    const idx = arr.indexOf(waiter);
                    if (idx !== -1) arr.splice(idx, 1);
                }
                reject(new CancelledError());
            };
            if (signal?.aborted) {
                reject(new CancelledError());
                return;
            }
            signal?.addEventListener('abort', onAbort, { once: true });
            let list = hostWaiters.get(host);
            if (!list) {
                list = [];
                hostWaiters.set(host, list);
            }
            list.push(waiter);
        });
    }
    activePerHost.set(host, (activePerHost.get(host) ?? 0) + 1);
}

function releaseHostSlot(host: string): void {
    const cur = (activePerHost.get(host) ?? 1) - 1;
    if (cur <= 0) activePerHost.delete(host);
    else activePerHost.set(host, cur);

    const list = hostWaiters.get(host);
    if (list && list.length) {
        const next = list.shift()!;
        if (!list.length) hostWaiters.delete(host);
        next();
    }
}

/**
 * 把一次抓取排进串行链。返回的 Promise 在**这次任务真正跑完**时 settle。
 *
 * ⚠️ 注意 `chain` 上挂的是"这次任务的结果被规范化成 void 之后的 Promise"——
 * 这样前一个任务**失败也不会毒死整条链**（否则一次失败之后所有后续抓取都跟着 reject）。
 * 失败信息照常从返回的 Promise 抛给调用方。
 */
export function enqueue<T>(host: string, task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const run = chain.then(async () => {
        if (signal?.aborted) throw new CancelledError();

        // 同主机限速：等够间隔再发。等待期间被取消要立刻退出，别白等 1.5 秒。
        const now = Date.now();
        const slot = Math.max(now, nextSlotAt.get(host) ?? 0);
        nextSlotAt.set(host, slot + HOST_GAP_MS);
        const wait = slot - now;
        if (wait > 0) await sleep(wait, signal);

        if (signal?.aborted) throw new CancelledError();
        return await task();
    });

    // 链上只留"已完成"这个事实，不带结果也不带异常
    chain = run.then(
        () => undefined,
        () => undefined,
    );
    return run;
}

/**
 * 限速但不排全局串行链：等到该主机的间隔满足后就发。
 *
 * 1. 同一主机**发起时刻**严格保证 ≥ HOST_GAP_MS（预约式错峰，并发调用天然递增错开）；
 * 2. 同一主机在飞请求最多 MAX_ACTIVE_PER_HOST 个，避免多窗重叠打爆站点和本进程。
 */
export async function runPaced<T>(host: string, task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) throw new CancelledError();

    // 1. 发起节奏预约错峰（同步预占时间槽，保证并发调用时间差 >= HOST_GAP_MS）
    const now = Date.now();
    const slot = Math.max(now, nextSlotAt.get(host) ?? 0);
    nextSlotAt.set(host, slot + HOST_GAP_MS);

    const wait = slot - now;
    if (wait > 0) await sleep(wait, signal);

    if (signal?.aborted) throw new CancelledError();

    // 2. 限制同主机最大并发在飞数
    await acquireHostSlot(host, signal);
    try {
        return await task();
    } finally {
        releaseHostSlot(host);
    }
}

/**
 * 带退避重试的入队。`isRetryable` 判定上一次结果值不值得再试一次
 * （传结果值而不是异常 —— 抓取失败是**正常返回值** `{ok:false}`，不是抛错）。
 */
export async function enqueueWithRetry<T>(
    host: string,
    task: () => Promise<T>,
    isRetryable: (result: T) => boolean,
    signal?: AbortSignal,
): Promise<T> {
    let last!: T;
    for (let i = 0; i <= RETRY_DELAYS.length; i++) {
        last = await runPaced(host, task, signal);
        if (!isRetryable(last)) return last;
        if (i < RETRY_DELAYS.length) await sleep(RETRY_DELAYS[i], signal);
    }
    return last;
}

/**
 * 窗口登记处 —— 与队列同一层，因为两者共享同一个生命周期关切：
 * **不管任务怎么结束（成功 / 失败 / 取消 / 用户直接关主窗），窗口都必须被销毁。**
 * `siteFetch` 的隐藏窗和人工验证的可见窗都登记在这里。
 */
const openWindows = new Set<BrowserWindow>();

export function trackWindow(win: BrowserWindow): void {
    openWindows.add(win);
}

export function untrackWindow(win: BrowserWindow): void {
    openWindows.delete(win);
}

/**
 * 把所有助手窗口关掉。挂在主窗 `closed` 上 —— 否则**一个隐藏窗就能让
 * `window-all-closed` 永远不触发**，用户关了主界面应用却退不掉（D12 的窗口生命周期冲突）。
 */
export function destroyTrackedWindows(): void {
    for (const win of [...openWindows]) {
        try {
            if (!win.isDestroyed()) win.destroy();
        } catch {
            /* 已被销毁 */
        }
    }
    openWindows.clear();
}
