/**
 * 管理助手 · 用户交互式采集（点选图片 / 录制动作）
 * ===========================================================================
 * 流程：开**可见窗** → 等脱离 CF → 清残留 → 注入脚本 → **轮询** `sessionStorage` 直到用户完成。
 *
 * 为什么轮询而不是等 Promise：用户点一下可能触发整页跳转，脚本上下文销毁后 Promise 永不 resolve。
 * 每次轮询都**重注入**一次脚本（幂等，页面内用 `window.__ffXxx` 守卫）—— 顺便把跳转后丢掉的脚本补回来。
 */
import { BrowserWindow } from 'electron';
import { sleep, trackWindow, untrackWindow } from './queue';
import { adoptSameOriginPopups, CF_DETECT, CHROME_UA, NAV_TIMEOUT, PARTITION, POLL_INTERVAL } from './siteFetch';
import {
    buildClearScript, buildPickerScript, buildReadScript, buildRecorderScript, PICK_KEY, REC_KEY,
} from './pageScripts';
import { replaceQueryInValue } from './urlTemplate';

const POLL_MS = 400;
/** 用户自己操作的窗口，给足 10 分钟 */
const MAX_WAIT_MS = 10 * 60 * 1000;
/** 等用户自己过验证的上限（同 passChallenge 的尺度） */
const CHALLENGE_WAIT_MS = 5 * 60 * 1000;

export interface RecStep { act: 'type' | 'click'; selector: string; value?: string }
export interface PickResult { ok: boolean; selector?: string; src?: string; weak?: boolean; cancelled?: boolean; err?: string }
export interface RecordResult { ok: boolean; steps: RecStep[]; cancelled?: boolean; err?: string }

async function runInteractive(
    url: string,
    mode: 'pick' | 'record',
    signal?: AbortSignal,
): Promise<{ ok: boolean; value: unknown; err?: string; cancelled?: boolean }> {
    const win = new BrowserWindow({
        width: 1_100,
        height: 800,
        show: true,
        title: mode === 'pick' ? '点选你要抓的那张图' : '录制：像平时那样操作一遍',
        autoHideMenuBar: true,
        webPreferences: {
            partition: PARTITION,
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
        },
    });
    trackWindow(win);
    let closed = false;
    win.on('closed', () => { closed = true; });

    const onAbort = () => {
        try {
            if (!win.isDestroyed()) win.destroy();
        } catch {
            /* ignore */
        }
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    const key = mode === 'pick' ? PICK_KEY : REC_KEY;
    const inject = mode === 'pick' ? buildPickerScript() : buildRecorderScript();
    const read = buildReadScript(key);
    const gone = () => closed || !!signal?.aborted || win.isDestroyed();

    try {
        win.webContents.setUserAgent(CHROME_UA);
        adoptSameOriginPopups(win);
        await Promise.race([
            win.loadURL(url).catch(() => undefined),
            sleep(NAV_TIMEOUT, signal).catch(() => undefined),
        ]);

        // 等脱离 CF —— 用户也可以在这个可见窗里自己过一次验证
        const cfDeadline = Date.now() + CHALLENGE_WAIT_MS;
        while (Date.now() < cfDeadline) {
            if (gone()) return { ok: false, value: null, cancelled: true };
            let cf = true;
            try {
                cf = !!(await win.webContents.executeJavaScript(CF_DETECT)).cf;
            } catch {
                cf = true;
            }
            if (!cf) break;
            await sleep(POLL_INTERVAL, signal);
        }

        // 清掉上一次的残留（同源 sessionStorage 会跨次保留）
        try {
            await win.webContents.executeJavaScript(buildClearScript());
        } catch {
            /* ignore */
        }

        const deadline = Date.now() + MAX_WAIT_MS;
        while (Date.now() < deadline) {
            if (gone()) return { ok: false, value: null, cancelled: true };
            try {
                await win.webContents.executeJavaScript(inject);
            } catch {
                /* 正在导航，下一轮再补 */
            }
            let r: { done?: boolean; value?: unknown } | null = null;
            try {
                r = (await win.webContents.executeJavaScript(read)) as { done?: boolean; value?: unknown };
            } catch {
                r = null;
            }
            if (r && r.done) return { ok: true, value: r.value };
            await sleep(POLL_MS, signal);
        }
        return { ok: false, value: null, err: 'timeout' };
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

export async function pickImageOnPage(url: string, signal?: AbortSignal): Promise<PickResult> {
    const r = await runInteractive(url, 'pick', signal);
    if (!r.ok) return { ok: false, err: r.err, cancelled: r.cancelled };
    const v = (r.value || {}) as { selector?: string; src?: string; weak?: boolean; cancel?: boolean };
    if (v.cancel) return { ok: false, cancelled: true };
    if (!v.selector) return { ok: false, err: 'no-selector' };
    return { ok: true, selector: v.selector, src: v.src, weak: v.weak };
}

export async function recordOnPage(
    url: string,
    query: string,
    signal?: AbortSignal,
): Promise<RecordResult> {
    const r = await runInteractive(url, 'record', signal);
    if (!r.ok) return { ok: false, steps: [], err: r.err, cancelled: r.cancelled };
    const raw = Array.isArray(r.value) ? (r.value as RecStep[]) : [];
    const steps = raw
        .filter((s) => s && s.act && s.selector)
        .map((s) => (s.act === 'type' ? { ...s, value: replaceQueryInValue(s.value || '', query) } : s));
    return { ok: steps.length > 0, steps, err: steps.length ? undefined : 'empty' };
}
