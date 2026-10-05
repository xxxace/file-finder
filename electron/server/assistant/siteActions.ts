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
    adoptSameOriginPopups, CHROME_UA, CF_DETECT, NAV_TIMEOUT, PARTITION, POLL_INTERVAL, POLL_TIMEOUT,
    type RunExtractOptions,
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
    err?: 'cloudflare' | 'timeout' | 'aborted';
    steps: StepOutcome[];
    data?: unknown;
    /** 主框架最后一次导航的 HTTP 状态 —— 试跑面板靠它区分「番号不存在」与「选择器不对」 */
    httpStatus?: number;
    pageTitle?: string;
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
    const { timeoutMs = POLL_TIMEOUT, signal } = opts;

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

    try {
        if (signal?.aborted) return aborted;
        win.webContents.setUserAgent(CHROME_UA);
        await Promise.race([
            win.loadURL(url).catch(() => undefined),
            sleep(NAV_TIMEOUT, signal).catch(() => undefined),
        ]);

        // ① 先等脱离 CF 挑战（挑战页也会"加载成功"，但拿不到目标 DOM）
        const cfDeadline = Date.now() + timeoutMs;
        let lastCf = false;
        while (Date.now() < cfDeadline) {
            if (signal?.aborted || win.isDestroyed()) return aborted;
            try {
                lastCf = !!(await win.webContents.executeJavaScript(CF_DETECT)).cf;
            } catch {
                lastCf = true; // 正在跳转 → 当作"还没好"
            }
            if (!lastCf) break;
            await sleep(POLL_INTERVAL, signal);
        }
        if (lastCf) return { ok: false, cf: true, err: 'cloudflare', steps };

        // ② 逐步执行：每步一次。脚本抛错 = 页面被导航销毁 ⇒ 视为该步已成功
        for (let i = 0; i < planned.length; i++) {
            if (signal?.aborted || win.isDestroyed()) return aborted;
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
            if (!rec.ok) return { ok: false, cf: false, err: 'timeout', steps, httpStatus };
            await sleep(STEP_SETTLE_MS, signal);
        }

        // ③ 抽取（幂等 ⇒ 允许重试）
        let data: unknown;
        let ok = false;
        const exDeadline = Date.now() + timeoutMs;
        while (Date.now() < exDeadline) {
            if (signal?.aborted || win.isDestroyed()) return aborted;
            try {
                data = await win.webContents.executeJavaScript(extractScript);
            } catch {
                data = undefined;
            }
            if (data) {
                ok = true;
                break;
            }
            await sleep(POLL_INTERVAL, signal);
        }
        let title = '';
        try {
            title = win.webContents.getTitle();
        } catch {
            /* ignore */
        }
        return { ok, cf: false, steps, data, httpStatus, pageTitle: title };
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
