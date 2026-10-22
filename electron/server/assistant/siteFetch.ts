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

export const PARTITION = 'persist:assistant';
export const CHROME_UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export const NAV_TIMEOUT = 25_000;
export const POLL_INTERVAL = 500;
export const POLL_TIMEOUT = 20_000;
/** 人工过验证最多等多久。CF 的交互式挑战由用户自己掌控节奏，给足 5 分钟 */
const CHALLENGE_TIMEOUT = 300_000;

/**
 * 懒加载触发：把页面滚到底，下一次再滚回顶。
 *
 * **为什么必须有**：抓取窗是 1000×720 的隐藏窗，**从不滚动** ⇒ 首屏之外的图永远不进视口 ⇒
 * 懒加载脚本不执行 ⇒ `lazyloaded` 这类"加载完成"的类名一直不加、`src` 一直停在占位图、
 * 真地址还躺在 `data-src` 里。用户在 F12 里能看到，是因为他自己滚过（2026-10-22 现场）。
 *
 * **为什么分两拍**：一次跳到底再立刻跳回，IntersectionObserver 的回调还没跑就离开了。
 * 借 `runExtract` / `runSteps` 的轮询天然分成两次执行，中间隔 `POLL_INTERVAL`。
 * 只在**抽不到时**才调用 —— 正常站点第一轮就命中，一上来就滚会平白改变页面状态。
 */
export const LAZY_SCROLL_SCRIPT = `(function(){
  try {
    var st = window.__ffLazyStage || 0;
    var H = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight) || 0;
    if (st === 0) { window.__ffLazyStage = 1; window.scrollTo(0, H); return 'down'; }
    if (st === 1) { window.__ffLazyStage = 2; window.scrollTo(0, 0); return 'up'; }
    return 'idle';
  } catch (e) { return 'err'; }
})()`;

/** 第几轮开始补滚：给正常页面 3 轮（约 1.5s）先自己命中 */
const LAZY_NUDGE_AT = 3;

/**
 * 抽不到时的补救：滚到底 → 滚回顶，各一次。`tries` 从 1 开始数。
 * 失败（页面正在跳转 / 窗口已销毁）直接咽掉 —— 它只是补救，不是必经步骤。
 */
export async function lazyNudge(win: BrowserWindow, tries: number): Promise<void> {
    if (tries !== LAZY_NUDGE_AT && tries !== LAZY_NUDGE_AT + 1) return;
    try {
        await win.webContents.executeJavaScript(LAZY_SCROLL_SCRIPT);
    } catch {
        /* ignore */
    }
}

/** 页面内判断是否卡在 Cloudflare / Turnstile 挑战 */
export const CF_DETECT = `(function(){
  var t=(document.title||'').toLowerCase();
  // 只认**挑战页专有**的三个强信号。
  // ⚠️ 曾经还有一条「整页 innerHTML 里出现 turnstile / challenge-platform 就算被拦」——
  // 那是误判源：正常站点的登录/评论组件也会用 Turnstile，页面里带个 turnstile 字样就被判成
  // 挑战页，于是抽取脚本**一次都不执行**，界面永远显示"被拦 + 0 张图"，而人用浏览器看一切正常
  // （用户 2026-10-22 现场）。判据宁可漏判也不能误判 —— 漏判由"抽不到"兜底。
  var cf = /just a moment|checking your browser|verify you are (a )?human|attention required/i.test(t)
    || !!document.querySelector('#cf-challenge-running, .cf-challenge, #challenge-form, form[action*="__cf_chl"]')
    || !!window._cf_chl_opt;
  return { cf: cf, url: location.href, title: document.title };
})()`;

/**
 * 把当前页面拍下来（URL / 标题 / HTML），**只在抓不到时**用。
 * 界面上一句"被拦住了"没法判断真假，得让用户能看见页面到底是什么 ——
 * 挑战页有挑战页的样子，正常页面有正常页面的样子，一眼就能分开。
 */
export const SNAPSHOT_SCRIPT = `(function(){
  try {
    return {
      url: location.href,
      title: document.title || '',
      html: ((document.documentElement ? document.documentElement.outerHTML : '') || '').slice(0, 800000)
    };
  } catch (e) { return null; }
})()`;

export interface PageSnapshot {
    url: string;
    title: string;
    html: string;
}

/** 拍快照。窗口已销毁 / 页面正在跳转 → null（调用方按"没有证据"处理，不报错） */
export async function snapshotOf(win: BrowserWindow): Promise<PageSnapshot | null> {
    try {
        if (win.isDestroyed()) return null;
        const r = (await win.webContents.executeJavaScript(SNAPSHOT_SCRIPT)) as PageSnapshot | null;
        if (!r || typeof r.html !== 'string') return null;
        return { url: String(r.url || ''), title: String(r.title || ''), html: r.html };
    } catch {
        return null;
    }
}

/**
 * `_blank` 接管：**只**把**同源**的弹窗导航进当前窗，异源一律拦掉。
 *
 * ⚠️ 为什么不能无条件接管：站点广告/统计脚本经常自己调 `window.open` —— 无条件 `loadURL`
 * 会把当前窗导航到广告页，后续动作与抽取全落错页面。同源判断挡掉绝大多数外部弹窗，
 * 而「点搜索结果开新窗」（本来就要接管的场景）基本都是同站。
 * ⚠️ 为什么必须设：不设 handler 时 `window.open` 会创建**未登记**的新窗口 ⇒
 * `window-all-closed` 永不触发、应用退不掉。
 */
export function adoptSameOriginPopups(win: BrowserWindow): void {
    win.webContents.setWindowOpenHandler(({ url: target }) => {
        try {
            const cur = win.webContents.getURL();
            if (/^https?:/i.test(target) && cur && new URL(target).origin === new URL(cur).origin) {
                void win.loadURL(target);
            }
        } catch {
            /* ignore */
        }
        return { action: 'deny' };
    });
}

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
    /** 失败时的现场快照 —— 让用户能看见"被拦"是真是假，而不是只信一句文案 */
    snapshot?: PageSnapshot;
}

export interface RunExtractOptions {
    /** 轮询总超时（毫秒） */
    timeoutMs?: number;
    /** 取消信号；abort 会立刻销毁窗口 */
    signal?: AbortSignal;
    /**
     * 把抓取窗**显示出来**（默认隐藏）。
     * 用户反馈「看不到页面访问的过程」⇒ 试跑时可以打开它，让流程看得见；
     * 窗口仍会在结束时自动销毁（不是给用户浏览用的那个，那个是 `openVisiblePage`）。
     */
    show?: boolean;
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
        show: !!opts.show,
        width: 1_000,
        height: 720,
        autoHideMenuBar: true,
        title: opts.show ? '正在抓取（结束会自动关闭）' : undefined,
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
        // 抓取窗也不跟随弹窗（同源才导航）—— 否则站点脚本的 window.open 会漏出未登记窗口
        adoptSameOriginPopups(win);
        // loadURL 没有 timeout 选项（S1 spike 里那个 {timeout} 其实是空转），用竞速自己兜底；
        // 超时也可能只是 CF 挑战慢，继续进入轮询。
        await Promise.race([
            win.loadURL(url).catch(() => undefined),
            sleep(NAV_TIMEOUT, signal).catch(() => undefined),
        ]);

        const deadline = Date.now() + timeoutMs;
        let lastCf = false;
        let tries = 0;
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

            // ⚠️ 即使判定为挑战页也**先抽一次**：CF 判定可能误伤正常页面，而"抽得到"
            // 才是页面正常的最硬证据。抽不到，再按 cf 解释原因（它是解释，不是否决权）。
            let data: unknown;
            try {
                data = await win.webContents.executeJavaScript(script);
            } catch {
                await sleep(POLL_INTERVAL, signal);
                continue;
            }
            if (data) return { ok: true, cf: false, data: data as T };
            // 抽不到：滚一下看看是不是懒加载还没触发。挑战页滚了也没用，跳过
            if (!lastCf) await lazyNudge(win, ++tries);
            await sleep(POLL_INTERVAL, signal);
        }
        const snap = await snapshotOf(win);
        return {
            ok: false, cf: lastCf, err: lastCf ? 'cloudflare' : 'timeout',
            snapshot: snap ?? undefined,
        };
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
        // 验证窗同样要设：不设的话 window.open 会开出未登记窗口，应用关不掉
        adoptSameOriginPopups(win);
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

