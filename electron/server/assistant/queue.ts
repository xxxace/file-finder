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

/** 同一主机两次请求之间的最小间隔（毫秒） */
const HOST_GAP_MS = 1_500;

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

/** 主进程里的"抓取线程"：任何时候只有一条链在跑 */
let chain: Promise<unknown> = Promise.resolve();
/** host → 上次发起请求的时刻 */
const lastHitAt = new Map<string, number>();

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
        const last = lastHitAt.get(host) ?? 0;
        const wait = last + HOST_GAP_MS - Date.now();
        if (wait > 0) await sleep(wait, signal);

        if (signal?.aborted) throw new CancelledError();
        try {
            return await task();
        } finally {
            lastHitAt.set(host, Date.now());
        }
    });

    // 链上只留"已完成"这个事实，不带结果也不带异常
    chain = run.then(
        () => undefined,
        () => undefined,
    );
    return run;
}

/**
 * 限速但不排队：等到该主机的间隔满足后就发，**不进全局串行链**。
 *
 * 和 `enqueue` 的区别：enqueue 是"任意时刻全库只有一个请求在飞"（串行链）；
 * runPaced 只守"同主机两次发起之间 ≥ HOST_GAP_MS"（时间戳判定），
 * 允许多个请求**重叠在飞** —— 这是抓取并发的地基（Phase 5 起，用户要求并发）。
 *
 * 对站点的表现：请求**发起时刻**仍然每隔 1.5s 一个，到达节奏和串行时一样；
 * 变的只是"上一张页面还在慢慢加载时，下一张已经出发"。封禁看的是请求节奏，
 * 不是同时挂着的连接数 —— 所以底线还在。
 */
export async function runPaced<T>(host: string, task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) throw new CancelledError();

    const last = lastHitAt.get(host) ?? 0;
    const wait = last + HOST_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait, signal);

    if (signal?.aborted) throw new CancelledError();
    try {
        return await task();
    } finally {
        lastHitAt.set(host, Date.now());
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
