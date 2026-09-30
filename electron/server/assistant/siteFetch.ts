/**
 * 管理助手 · 隐藏窗口抓取层
 * ===========================================================================
 * 对应 PRD D1 / D12，以及 S1 spike 实测结论：
 *   - 抓取全程留在 **Chromium 网络栈**（隐藏 BrowserWindow）。cf_clearance 与
 *     IP+UA+TLS 三绑定，不能取出来交给 Node fetch（会失效）。
 *   - webPreferences 严格按 D12：nodeIntegration:false / contextIsolation:true /
 *     sandbox:true ＋ 真实 Chrome UA（不暴露 Electron 指纹）。
 *   - partition:'persist:assistant'：CF 过的 session 落盘，跨请求/跨重启复用。
 *   - 不能只等 did-finish-load（CF 挑战页会先完成）→ 轮询「非挑战页 + 目标内容」。
 *   - Phase 1 采用**一次一窗、用完即毁**：天然规避 D12 的窗口生命周期冲突
 *     （session 靠 partition 持久化，不依赖窗口常驻）。Phase 2 若要复用单例窗，
 *     必须同时在主窗关闭时 destroy 之。
 *
 * Phase 2 增补：
 *   - `signal` 取消：监听 abort 直接 destroy 窗口 —— **立刻**停，不用等超时。
 *   - `passChallenge`：人工过验证。CF 的交互式挑战（Turnstile）机器过不去，
 *     只能给用户开一个**可见窗**让他自己点。过完 cookie 落在同一个 partition，
 *     后续隐藏窗自动复用 —— 这就是 S1 里 javdock "靠 1 次人工过即通过" 的机制化。
 *   - 窗口登记进 `queue.ts` 的登记处：主窗关闭时一起销毁，否则 `window-all-closed`
 *     永远不触发（应用退不掉）。
 */
import { BrowserWindow } from 'electron';
import { sleep, trackWindow, untrackWindow } from './queue';

const PARTITION = 'persist:assistant';
const CHROME_UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const NAV_TIMEOUT = 25_000;
const POLL_INTERVAL = 500;
const POLL_TIMEOUT = 20_000;
/** 人工过验证最多等多久。CF 的交互式挑战由用户自己掌控节奏，给足 5 分钟 */
const CHALLENGE_TIMEOUT = 300_000;

/** 页面内判断是否卡在 Cloudflare / Turnstile 挑战 */
const CF_DETECT = `(function(){
  var t=(document.title||'').toLowerCase();
  var cf = /just a moment|checking your browser|verify you are (a )?human|attention required/i.test(t)
    || !!document.querySelector('#cf-challenge-running, .cf-challenge, #challenge-form, form[action*="__cf_chl"]')
    || !!window._cf_chl_opt
    || /cf-chl-|challenge-platform|turnstile/i.test(document.body ? document.body.innerHTML : '');
  return { cf: cf, url: location.href, title: document.title };
})()`;

export interface FetchResult<T> {
    ok: boolean;
    cf: boolean;
    data?: T;
    /**
     * 'cloudflare' = 被挑战拦下（该走 `passChallenge` 人工过）
     * 'timeout'    = 超时/取不到
     * 'aborted'    = 用户取消了（**控制流**，不是失败原因）
     */
    err?: 'cloudflare' | 'timeout' | 'aborted';
}

export interface RunExtractOptions {
    /** 轮询总超时（毫秒） */
    timeoutMs?: number;
    /** 取消信号；abort 会立刻销毁窗口 */
    signal?: AbortSignal;
}

/**
 * 加载 url，轮询直到页面脱离 CF 挑战并成功执行 `script`（返回真值），或超时。
 * 窗口必被销毁，不会泄漏、也不会把应用钉在运行中。
 */
export async function runExtract<T>(
    url: string,
    script: string,
    opts: RunExtractOptions = {},
): Promise<FetchResult<T>> {
    const { timeoutMs = POLL_TIMEOUT, signal } = opts;

    const win = new BrowserWindow({
        show: false,
        webPreferences: {
            partition: PARTITION,
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
        },
    });
    trackWindow(win);

    // 取消 = 立刻销毁窗口。之后所有 webContents 调用都会抛，统一归到 'aborted'。
    const onAbort = () => {
        try {
            if (!win.isDestroyed()) win.destroy();
        } catch {
            /* ignore */
        }
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    const aborted: FetchResult<T> = { ok: false, cf: false, err: 'aborted' };

    try {
        if (signal?.aborted) return aborted;

        // 真实 Chrome UA：抹掉 Electron 指纹（D12）。用 webContents.setUserAgent 而非
        // webPreferences.userAgent —— 后者不在 Electron 44 的 WebPreferences 类型里；
        // setUserAgent 还能跨后续导航保持。
        win.webContents.setUserAgent(CHROME_UA);
        // loadURL 没有 timeout 选项（S1 spike 里那个 {timeout} 其实是空转），用竞速自己兜底；
        // 超时也可能只是 CF 挑战慢，继续进入轮询。
        await Promise.race([
            win.loadURL(url).catch(() => undefined),
            sleep(NAV_TIMEOUT, signal).catch(() => undefined),
        ]);

        const deadline = Date.now() + timeoutMs;
        let lastCf = false;
        while (Date.now() < deadline) {
            if (signal?.aborted || win.isDestroyed()) return aborted;

            let cfInfo: { cf?: boolean } | undefined;
            try {
                cfInfo = (await win.webContents.executeJavaScript(CF_DETECT)) as { cf?: boolean };
            } catch {
                await sleep(POLL_INTERVAL, signal);
                continue;
            }
            lastCf = !!cfInfo?.cf;
            if (lastCf) {
                await sleep(POLL_INTERVAL, signal);
                continue;
            }

            let data: unknown;
            try {
                data = await win.webContents.executeJavaScript(script);
            } catch {
                await sleep(POLL_INTERVAL, signal);
                continue;
            }
            if (data) return { ok: true, cf: false, data: data as T };
            await sleep(POLL_INTERVAL, signal);
        }
        return { ok: false, cf: lastCf, err: lastCf ? 'cloudflare' : 'timeout' };
    } catch {
        // 窗口被销毁 / sleep 被 abort 都落这里
        return signal?.aborted ? aborted : { ok: false, cf: false, err: 'timeout' };
    } finally {
        signal?.removeEventListener('abort', onAbort);
        untrackWindow(win);
        try {
            if (!win.isDestroyed()) win.destroy();
        } catch {
            /* ignore */
        }
    }
}

export interface ChallengeResult {
    /** 挑战已通过（页面脱离 CF） */
    ok: boolean;
    /** 等太久仍未通过 */
    timeout: boolean;
    /** 用户自己把窗口关了（= 放弃，不算超时） */
    abandoned: boolean;
}

/**
 * 人工过验证：开一个**可见窗**让用户自己点 CF 的交互式挑战。
 *
 * 为什么必须人工：Turnstile 这类挑战就是设计来区分人和自动化的，
 * 隐藏窗过不去。我们能做的只有"把窗口摆到用户面前 + 过完自动收工 + 复用 session"。
 *
 * 为什么过完就销毁窗口：cookie 已经落到 `persist:assistant`，
 * 窗口留着只会多一个进程 —— 复用靠 partition，不靠窗口常驻（Phase 1 的结论）。
 */
export async function passChallenge(url: string, signal?: AbortSignal): Promise<ChallengeResult> {
    const win = new BrowserWindow({
        width: 1_000,
        height: 720,
        show: true,
        title: '请完成站点验证（完成后窗口会自动关闭）',
        autoHideMenuBar: true,
        webPreferences: {
            partition: PARTITION,
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
        },
    });
    trackWindow(win);

    let abandoned = false;
    win.on('closed', () => {
        abandoned = true;
    });

    // 取消 = 关掉那个验证窗。用户点了"取消任务"还留着一个窗口杵在那儿会很怪。
    const onAbort = () => {
        try {
            if (!win.isDestroyed()) win.destroy();
        } catch {
            /* ignore */
        }
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
        win.webContents.setUserAgent(CHROME_UA);
        await Promise.race([win.loadURL(url).catch(() => undefined), sleep(NAV_TIMEOUT)]);

        const deadline = Date.now() + CHALLENGE_TIMEOUT;
        while (Date.now() < deadline) {
            if (abandoned || win.isDestroyed()) return { ok: false, timeout: false, abandoned: true };

            let stuck = true;
            try {
                stuck = !!(await win.webContents.executeJavaScript(CF_DETECT)).cf;
            } catch {
                // 页面正在跳转（挑战通过后常有整页跳转）→ 当作"还没好"，继续轮询
                stuck = true;
            }
            if (!stuck) return { ok: true, timeout: false, abandoned: false };

            await sleep(POLL_INTERVAL);
        }
        return { ok: false, timeout: true, abandoned: false };
    } catch {
        return { ok: false, timeout: false, abandoned: true };
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
