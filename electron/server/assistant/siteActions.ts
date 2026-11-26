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
    adoptSameOriginPopups, CHROME_UA, CF_DETECT, lazyNudge, NAV_TIMEOUT, PARTITION, POLL_INTERVAL,
    POLL_TIMEOUT, snapshotOf, WAF_GIVE_UP_MS, WAF_STATUS, watchNavFailure,
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
    err?: 'cloudflare' | 'timeout' | 'net' | 'aborted';
    steps: StepOutcome[];
    data?: unknown;
    /** `err:'net'` 时的底层原因（Chromium 描述） */
    netErr?: string;
    /** 主框架最后一次导航的 HTTP 状态 —— 试跑面板靠它区分「番号不存在」与「选择器不对」 */
    httpStatus?: number;
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
export async function runSteps(
    url: string,
    planned: { act: string; script: string }[],
    extractScript: string,
    opts: RunExtractOptions = {},
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
        win.webContents.setUserAgent(CHROME_UA);
        // 导航也吃同一份预算（理由见 siteFetch 的同名注释）
        await Promise.race([
            win.loadURL(url).catch(() => undefined),
            sleep(Math.min(NAV_TIMEOUT, Math.max(deadline - Date.now(), 0)), signal).catch(() => undefined),
        ]);

        // ① 等脱离挑战（挑战页也会"加载成功"，但拿不到目标 DOM）。
        // ⚠️ 判定为挑战**不立刻返回**：判据可能误伤正常页面，而"动作执行完 + 抽到值"
        // 才是页面正常的硬证据。所以继续往下走，最后再按 lastCf 解释失败原因。
        // ⚠️ 但**等待**本身要有上限：原来拿整个 `timeoutMs`（20 秒）等一道过不去的挑战，
        //    正是主人看到的"卡住"。交互式挑战隐藏窗永远过不去 ⇒ 只给 4 秒（2026-11-23）。
        const wafDeadline = Math.min(deadline, Date.now() + WAF_GIVE_UP_MS);
        let lastCf = false;
        while (Date.now() < wafDeadline) {
            if (signal?.aborted || win.isDestroyed()) return aborted;
            const dead = deadOnNav();
            if (dead) return dead;
            try {
                lastCf = !!(await win.webContents.executeJavaScript(CF_DETECT)).cf;
            } catch {
                lastCf = true; // 正在跳转 → 当作"还没好"
            }
            if (!lastCf) break;
            await sleep(POLL_INTERVAL, signal);
        }

        // ② 逐步执行：每步一次。脚本抛错 = 页面被导航销毁 ⇒ 视为该步已成功
        for (let i = 0; i < planned.length; i++) {
            if (signal?.aborted || win.isDestroyed()) return aborted;
            const dead = deadOnNav();
            if (dead) return dead;
            let r: { ok?: boolean; why?: string } | undefined;
            try {
                r = (await win.webContents.executeJavaScript(planned[i].script)) as {
                    ok?: boolean;
                    why?: string;
                };
            } catch {
                r = { ok: true, why: 'navigated' };
            }
            const rec: StepOutcome = { index: i, act: planned[i].act, ok: r?.ok !== false, why: r?.why };
            steps.push(rec);
            if (!rec.ok) {
                const blockedNow = lastCf || WAF_STATUS.has(httpStatus);
                return {
                    ok: false, cf: blockedNow, err: blockedNow ? 'cloudflare' : 'timeout', steps, httpStatus,
                    snapshot: captureSnapshot ? ((await snapshotOf(win)) ?? undefined) : undefined,
                };
            }
            await sleep(STEP_SETTLE_MS, signal);
        }

        // ③ 抽取（幂等 ⇒ 允许重试）。抽不到就滚一下 —— 与 runExtract 同一套补救，
        // 否则"有动作的站"和"纯 URL 的站"在懒加载页面上行为不一致。
        let data: unknown;
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
            if (data) {
                ok = true;
                break;
            }
            await lazyNudge(win, ++tries);
            await sleep(POLL_INTERVAL, signal);
        }
        let title = '';
        try {
            title = win.webContents.getTitle();
        } catch {
            /* ignore */
        }
        // 抽到了就是好的（cf 只用来解释"为什么没抽到"）；403/429/503 也算被拦，不算超时
        const blockedNow = lastCf || WAF_STATUS.has(httpStatus);
        return {
            ok, cf: ok ? false : blockedNow, steps, data, httpStatus, pageTitle: title,
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
    win.webContents.setUserAgent(CHROME_UA);
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
