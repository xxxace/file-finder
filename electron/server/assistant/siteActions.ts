/**
 * 管理助手 · 窗口「动作」层
 * ===========================================================================
 * 与 `siteFetch.ts` 的分工（**别混**）：
 *   - `siteFetch.ts`：**幂等**的窗口操作 —— 抽取（可反复轮询）、人工过验证（等用户点）。
 *   - 本文件：**有副作用**的窗口操作 —— 动作序列（每步只执行一次）、
 *     以及一个**不自动关闭**的浏览窗（给用户自己研究目标站点）。
 * 两者共用同一套窗口常量与 `persist:assistant` ⇒ cookie / 过验证状态互通。
 */
import { BrowserWindow } from 'electron';
import { sleep, trackWindow, untrackWindow } from './queue';
import {
    adoptSameOriginPopups, attachStealth, CF_DETECT, lazyNudge, NAV_TIMEOUT, PARTITION, POLL_INTERVAL,
    POLL_TIMEOUT, snapshotOf, WAF_GIVE_UP_MS, WAF_INTERACTIVE_GIVE_UP_MS, WAF_STATUS, watchNavFailure,
    type PageSnapshot, type RunExtractOptions,
} from './siteFetch';

export interface StepOutcome {
    index: number;
    act: string;
    ok: boolean;
    /** 失败原因：'not-found' | 'timeout' | 'navigated'（导航打断=成功）| 'error:...' */
    why?: string;
}

export interface StepsResult {
    ok: boolean;
    cf: boolean;
    err?: 'cloudflare' | 'http' | 'timeout' | 'net' | 'aborted';
    steps: StepOutcome[];
    data?: unknown;
    /** `err:'net'` 时的底层原因（Chromium 描述） */
    netErr?: string;
    /** 主框架最后一次导航的 HTTP 状态 —— 试跑面板靠它区分「番号不存在」与「选择器不对」 */
    httpStatus?: number;
    finalUrl?: string;
    pageTitle?: string;
    /** 失败时的现场快照（挑战页 / 正常页一眼可分） */
    snapshot?: PageSnapshot;
}

/** 每步之间给导航留的稳定时间（点击常触发整页跳转） */
const STEP_SETTLE_MS = 600;

/**
 * 执行「动作序列 → 抽取」。
 *
 * ⚠️ 与 `runExtract` 的分工（**本模块最容易写错的地方**）：
 *   - `runExtract` = 幂等抽取 ⇒ 可以**反复轮询**直到抽到；
 *   - 本函数 = 动作**每步只执行一次**，跑完再执行一次（可重试的）抽取。
 *   把 click 丢进 `runExtract` 的 while 循环 ⇒ click 返回 undefined ⇒ 循环不退出 ⇒ **反复点击**。
 *
 * ⚠️ `_blank` 必须接管：站点常把搜索结果用新窗口打开。不接管会
 *   ① 开出一个**未登记**的窗口（`window-all-closed` 永不触发、应用关不掉）；
 *   ② 当前窗停在列表页 ⇒ 抽到的是列表页而不是详情页。
 */
export interface PlannedStep {
    act: string;
    script: string;
    /** 若有，执行前自动等待该选择器出现（Auto-Wait），避免异步渲染直接报 not-found */
    waitSelector?: string;
}

export async function runSteps<T = unknown>(
    url: string,
    planned: PlannedStep[],
    extractScript: string,
    opts: RunExtractOptions<T> = {},
): Promise<StepsResult> {
    const { timeoutMs = POLL_TIMEOUT, signal, captureSnapshot = true } = opts;
    /**
     * 整次尝试（导航 + 等挑战 + 走动作 + 抽取）共享的硬截止，口径同 `runExtract`。
     * 没给 `deadline` 时按"导航 + 轮询"两段加起来算 —— 写成 `now + timeoutMs` 会让
     * 导航一口吃掉全部预算（试跑面板就是这么用的，会变成一点开就超时）。
     */
    const deadline = opts.deadline ?? Date.now() + NAV_TIMEOUT + timeoutMs;

    const win = new BrowserWindow({
        show: !!opts.show,
        width: 1_000,
        height: 720,
        autoHideMenuBar: true,
        title: opts.show ? '正在试跑（结束会自动关闭）' : undefined,
        webPreferences: {
            partition: PARTITION,
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
        },
    });
    trackWindow(win);

    let httpStatus = 0;
    win.webContents.on('did-navigate', (_e, _u, code) => {
        if (code) httpStatus = code;
    });
    /** 连不上（DNS / 掐连接 / SSL 失败）⇒ 立刻收工，别等预算耗完（理由见 siteFetch 同名逻辑） */
    const navFailed = watchNavFailure(win);
    adoptSameOriginPopups(win);

    const onAbort = () => {
        try {
            if (!win.isDestroyed()) win.destroy();
        } catch {
            /* ignore */
        }
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    const steps: StepOutcome[] = [];
    const aborted: StepsResult = { ok: false, cf: false, err: 'aborted', steps };
    /** 主框架注定打不开 ⇒ 收工（三处循环共用，避免各写一份） */
    const deadOnNav = (): StepsResult | null => {
        const f = navFailed();
        if (!f) return null;
        try { win.webContents.stop(); } catch { /* 已停 */ }
        return { ok: false, cf: false, err: 'net', steps, httpStatus, netErr: `${f.desc}（${f.code}）` };
    };

    try {
        if (signal?.aborted) return aborted;
        attachStealth(win);
        // 初始导航最多等 8 秒，避免慢广告拖住 load 事件导致后续动作步骤没有时间执行
        const initialNavWait = Math.min(8_000, NAV_TIMEOUT, Math.max(deadline - Date.now(), 0));
        await Promise.race([
            win.loadURL(url).catch(() => undefined),
            sleep(initialNavWait, signal).catch(() => undefined),
        ]);

        // ① 等脱离挑战
        const wafDeadline = Math.min(deadline, Date.now() + WAF_GIVE_UP_MS);
        let lastCf = false;
        let lastInteractive = false;
        let wafSince = 0;
        while (Date.now() < wafDeadline) {
            if (signal?.aborted || win.isDestroyed()) return aborted;
            const dead = deadOnNav();
            if (dead) return dead;
            try {
                const cfInfo = (await win.webContents.executeJavaScript(CF_DETECT)) as { cf?: boolean; interactive?: boolean };
                lastCf = !!cfInfo?.cf;
                lastInteractive = !!cfInfo?.interactive;
            } catch {
                lastCf = true; // 正在跳转 → 当作"还没好"
            }
            if (!lastCf) break;
            wafSince = wafSince || Date.now();
            if (lastInteractive && Date.now() - wafSince >= WAF_INTERACTIVE_GIVE_UP_MS) break;
            await sleep(POLL_INTERVAL, signal);
        }

        // ② 逐步执行（支持 Auto-Wait、goto、press、导航稳定等待）
        for (let i = 0; i < planned.length; i++) {
            if (signal?.aborted || win.isDestroyed()) return aborted;
            const dead = deadOnNav();
            if (dead) return dead;

            const step = planned[i];
            if (step.act === 'goto') {
                let targetUrl = '';
                try { targetUrl = JSON.parse(step.script) as string; } catch { targetUrl = step.script; }
                await Promise.race([
                    win.loadURL(targetUrl).catch(() => undefined),
                    sleep(Math.min(NAV_TIMEOUT, Math.max(deadline - Date.now(), 0)), signal).catch(() => undefined),
                ]);
                steps.push({ index: i, act: 'goto', ok: true });
                await sleep(STEP_SETTLE_MS, signal);
                continue;
            }

            // Auto-Wait：执行前等待目标元素出现（最多等 8s 或剩余预算）
            if (step.waitSelector) {
                const waitEnd = Math.min(deadline, Date.now() + 8_000);
                const selJson = JSON.stringify(step.waitSelector);
                while (Date.now() < waitEnd) {
                    if (signal?.aborted || win.isDestroyed()) return aborted;
                    try {
                        const found = await win.webContents.executeJavaScript(`!!document.querySelector(${selJson})`);
                        if (found) break;
                    } catch {
                        /* 正在导航，继续等 */
                    }
                    await sleep(250, signal);
                }
            }

            let r: { ok?: boolean; why?: string } | undefined;
            try {
                r = (await win.webContents.executeJavaScript(step.script)) as {
                    ok?: boolean;
                    why?: string;
                };
            } catch {
                r = { ok: true, why: 'navigated' };
            }
            const rec: StepOutcome = { index: i, act: step.act, ok: r?.ok !== false, why: r?.why };
            steps.push(rec);
            if (!rec.ok) {
                const blockedNow = lastCf || WAF_STATUS.has(httpStatus);
                return {
                    ok: false, cf: blockedNow, err: blockedNow ? 'cloudflare' : 'timeout', steps, httpStatus,
                    snapshot: captureSnapshot ? ((await snapshotOf(win)) ?? undefined) : undefined,
                };
            }
            await sleep(STEP_SETTLE_MS, signal);
            // 若点击/回车触发了主框架加载，等待加载稳定再走下一步
            if (win.webContents.isLoading()) {
                const loadWaitEnd = Math.min(deadline, Date.now() + 10_000);
                while (win.webContents.isLoading() && Date.now() < loadWaitEnd) {
                    if (signal?.aborted || win.isDestroyed()) return aborted;
                    await sleep(250, signal);
                }
            }
        }

        // ③ 抽取（幂等 ⇒ 允许重试 + 懒加载补滚 + isReady 判据）
        let data: unknown;
        let lastData: unknown;
        let ok = false;
        let tries = 0;
        while (Date.now() < deadline) {
            if (signal?.aborted || win.isDestroyed()) return aborted;
            const dead = deadOnNav();
            if (dead) return dead;
            try {
                data = await win.webContents.executeJavaScript(extractScript);
            } catch {
                data = undefined;
            }
            if (data !== undefined && data !== null) lastData = data;
            const ready = opts.isReady ? (data !== undefined && data !== null && opts.isReady(data as T)) : !!data;
            if (ready) {
                ok = true;
                break;
            }
            if (httpStatus >= 400 && !WAF_STATUS.has(httpStatus) && !lastCf && tries >= 1) {
                break;
            }
            await lazyNudge(win, ++tries);
            await sleep(POLL_INTERVAL, signal);
        }
        if (signal?.aborted || win.isDestroyed()) return aborted;
        let title = '';
        let finalUrl = url;
        try {
            title = win.webContents.getTitle();
            finalUrl = win.webContents.getURL() || url;
        } catch {
            /* ignore */
        }
        const blockedNow = lastCf || WAF_STATUS.has(httpStatus);
        const isHttpErr = !ok && !blockedNow && httpStatus >= 400;
        return {
            ok, cf: ok ? false : blockedNow,
            err: ok ? undefined : (blockedNow ? 'cloudflare' : isHttpErr ? 'http' : 'timeout'),
            steps, data: ok ? data : lastData, httpStatus, finalUrl, pageTitle: title,
            snapshot: ok || !captureSnapshot ? undefined : ((await snapshotOf(win)) ?? undefined),
        };
    } catch {
        return signal?.aborted ? aborted : { ok: false, cf: false, err: 'timeout', steps };
    } finally {
        signal?.removeEventListener('abort', onAbort);
        try {
            if (!win.isDestroyed()) win.destroy();
        } catch {
            /* ignore */
        }
        untrackWindow(win);
    }
}

/**
 * 打开一个**可见窗**让用户自己浏览目标站点（研究页面结构用）。
 *
 * 存在的理由：用户反馈「必须打开自己的浏览器去研究站点」—— 那件事应该由我们代劳，
 * 因为它还顺带解决两件事：① 同一个 `persist:assistant` ⇒ 在这里过掉的验证后续抓取直接复用；
 * ② 用户看到的就是我们抓到的（同一条 Chromium 网络栈），不会出现"我浏览器能看、它抓不到"。
 *
 * 与 `passChallenge` 的区别：不等任何条件、**不自动关闭** —— 用户看完自己关。
 * ⚠️ 窗口登记在 `openWindows` 里：主窗关闭时会一起销毁，否则 `window-all-closed` 永不触发。
 */
/** 用户浏览窗：id → 窗口。用于「用它做模板」时读它当前停在哪一页 */
const PAGES = new Map<string, BrowserWindow>();
let pageSeq = 0;

export async function openVisiblePage(url: string): Promise<{ ok: boolean; id?: string; err?: string }> {
    if (!/^https?:/i.test(url)) return { ok: false, err: 'bad-url' };

    const win = new BrowserWindow({
        width: 1_000,
        height: 760,
        show: true,
        title: '目标站点（看完请关闭本窗口）',
        autoHideMenuBar: true,
        webPreferences: {
            partition: PARTITION,
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
        },
    });
    trackWindow(win);
    const id = `p${++pageSeq}`;
    PAGES.set(id, win);
    win.on('closed', () => {
        PAGES.delete(id);
        untrackWindow(win);
    });
    attachStealth(win);
    adoptSameOriginPopups(win);

    try {
        // ⚠️ 必须与 NAV_TIMEOUT 竞速：目标站一直加载不完时，`POST /assistant/openPage`
        // 会永久挂住（前端按钮一直转圈，且没有任何超时兜底）。
        await Promise.race([
            win.loadURL(url).catch(() => undefined),
            sleep(NAV_TIMEOUT).catch(() => undefined),
        ]);
        // 打不开（DNS/网络/超时）：窗口留着就是个空白窗，还会给 PAGES 留一个孤儿条目 ⇒ 收掉
        let landed = '';
        try {
            landed = win.webContents.getURL();
        } catch {
            /* ignore */
        }
        if (!landed || landed === 'about:blank') {
            try {
                win.destroy();
            } catch {
                /* ignore */
            }
            return { ok: false, err: 'load-failed' };
        }
        return { ok: true, id };
    } catch (e) {
        try {
            if (!win.isDestroyed()) win.destroy();
        } catch {
            /* ignore */
        }
        return { ok: false, err: String(e) };
    }
}

/** 读某个浏览窗**当前停在哪一页**（窗口已关 ⇒ null）。反推入口模板就靠它。 */
export function visiblePageUrl(id: string): string | null {
    const win = PAGES.get(id);
    if (!win || win.isDestroyed()) return null;
    try {
        return win.webContents.getURL();
    } catch {
        return null;
    }
}
