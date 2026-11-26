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
import { BrowserWindow, session, type Session } from 'electron';
import { sleep, trackWindow, untrackWindow } from './queue';

export const PARTITION = 'persist:assistant';
const CHROME_VER = process.versions.chrome || '144.0.0.0';
export const CHROME_UA =
    `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ` +
    `(KHTML, like Gecko) Chrome/${CHROME_VER} Safari/537.36`;

/**
 * 注入轻量反检测补丁：擦除 navigator.webdriver，并补全合理的语言/插件特征，
 * 与 Chromium 真实内核版本保持一致（避免 UA 与 TLS/userAgentData 指纹撕裂）。
 */
const STEALTH_SCRIPT = `(function(){
  try {
    if (navigator.webdriver !== undefined) {
      Object.defineProperty(navigator, 'webdriver', { get: function(){ return undefined; }, configurable: true });
    }
    if (!navigator.languages || !navigator.languages.length) {
      Object.defineProperty(navigator, 'languages', { get: function(){ return ['zh-CN', 'zh', 'en-US', 'en']; }, configurable: true });
    }
  } catch(e) {}
})()`;

export function attachStealth(win: BrowserWindow): void {
    win.webContents.setUserAgent(CHROME_UA);
    win.webContents.on('dom-ready', () => {
        if (!win.isDestroyed()) {
            void win.webContents.executeJavaScript(STEALTH_SCRIPT).catch(() => undefined);
        }
    });
}

/** 清理指定域名在 persist:assistant 下的站点缓存（Cookie / Storage），用于解决脏 Cookie 死循环 */
export async function clearSiteSession(targetUrl: string): Promise<boolean> {
    try {
        const origin = new URL(targetUrl).origin;
        const ses = session.fromPartition(PARTITION);
        await ses.clearStorageData({ origin });
        return true;
    } catch {
        return false;
    }
}

export const NAV_TIMEOUT = 25_000;
export const POLL_INTERVAL = 500;
export const POLL_TIMEOUT = 20_000;
/** 人工过验证最多等多久。CF 的交互式挑战由用户自己掌控节奏，给足 5 分钟 */
const CHALLENGE_TIMEOUT = 300_000;

/**
 * **一个抓取目标（一张卡）的总预算**，2026-11-23 主人定：「一个任务长时间没反馈要超时，默认 45s」。
 *
 * 为什么必须是"总预算"而不是"导航 25s + 轮询 20s"：两者相加只是**一次**尝试的上限，
 * 而一张卡还要跨 2 次超时重试、跨 6 个站点 fallback、跨图片验证 ⇒ 实测能拖到几分钟，
 * 界面上就是"这五张卡一直不动"。预算从**领取这张卡**那一刻开始算，谁花都一样。
 *
 * ⚠️ 它不是"网络多快"的旋钮，是**放弃阈值**。调大只会让卡顿更久，除非确认某站
 * 正常加载真的超过 45 秒（先看底栏 `抓取中 x/y` 的推进节奏再动）。
 */
export const TARGET_BUDGET_MS = 45_000;
/** 单站抓取上限（防止第一个站点卡死而饿死后续备用站点） */
export const SITE_BUDGET_MS = 16_000;

/**
 * 连续判定"卡在挑战页"多久就直接放弃这个站。
 *
 * 为什么敢放弃：通过 Turnstile 这类**交互式**挑战需要真人点击，隐藏窗永远过不去；
 * 而纯 JS 的自动挑战通常 1~2 秒内自己就跳走了。所以「连续 4 秒还在挑战页」的期望收益
 * 是"再等 16 秒也大概率过不去"，成本是"白占一个渲染进程 + 这张卡的超时预算"
 * —— 主人 2026-11-23 的原话：「无法通过也可以直接放弃，没必要强行等待」。
 *
 * 放弃后仍返回 `err:'cloudflare'`：留给「人工过验证」再重抓，不是把这条路堵死。
 */
/**
 * 连续判定"卡在挑战页"多久就直接放弃这个站。
 * - 自动 JS 盾通常 3~6 秒内跳走，给足 6.5 秒；
 * - 明确检测到交互式 Turnstile / Captcha 时 3 秒快速放弃，留给人工过验证。
 */
export const WAF_GIVE_UP_MS = 6_500;
export const WAF_INTERACTIVE_GIVE_UP_MS = 3_000;

/** 这些状态码本身就是"被挡在门外"，不靠 DOM 特征也能判（有些 WAF 直接回 403 空页） */
export const WAF_STATUS = new Set([403, 429, 503]);

/**
 * 主框架"注定打不开"的错误码：**立刻收工**，不要接着轮询。
 *
 * 主人 2026-11-23 贴的日志就是这一类：`SSL handshake failed … net_error -100`
 * （ERR_CONNECTION_CLOSED）—— 站点/中间设备直接掐断 TLS，重连一百次也一样。
 * 原来这里完全不看 `did-fail-load`，于是一个连不上的页面还要被轮询到预算耗尽，
 * 日志刷满屏、进度一动不动。
 */
export const FATAL_NAV_ERRORS = new Set([
    -100, // ERR_CONNECTION_CLOSED
    -101, // ERR_CONNECTION_RESET
    -102, // ERR_CONNECTION_REFUSED
    -105, // ERR_NAME_NOT_RESOLVED
    -107, // ERR_SSL_PROTOCOL_ERROR
    -113, // ERR_SSL_VERSION_OR_CIPHER_MISMATCH
    -118, // ERR_CONNECTION_TIMED_OUT
    -200, // ERR_CERT_COMMON_NAME_INVALID
    -202, // ERR_CERT_AUTHORITY_INVALID
]);

/**
 * 盯主框架加载失败。返回一个 getter：非 null ⇒ 这一页注定打不开。
 * 只在**主框架**上判定（子 iframe / 广告域失败是常态，判它会误伤正常页面）。
 */
export function watchNavFailure(win: BrowserWindow): () => { code: number; desc: string } | null {
    let failed: { code: number; desc: string } | null = null;
    win.webContents.on('did-fail-load', (_e, code, desc, _url, isMainFrame) => {
        if (isMainFrame && FATAL_NAV_ERRORS.has(code)) failed = { code, desc };
    });
    return () => failed;
}

/**
 * 抓取窗里**不需要**的资源类型。
 *
 * ⚠️ **不许拦 `image`**（2026-11-14 凌晨踩到的回退）：封面站的图片基本都走懒加载
 * （`<img src="占位.jpg" data-src="真图.jpg">`），而 `rawSrc` 的取值顺序是
 * `src || data-src || …` —— 图片一旦被拦、懒加载脚本不替换，`src` 就永远停在占位图，
 * 抽出来的是占位地址 ⇒ `getVerifiedCover` 验不过 ⇒ 换下一站 ⇒ 每条卡满 20 秒才超时。
 * 表现就是"前 5 个任务一直不动"。拦图片省下的带宽不值得用这个换。
 *
 * 留下的这几类都是**与 DOM 属性无关**的：字体不下、媒体不播、beacon 不发，
 * 抽出来的字段一个都不会少，`load` 也能早一点触发。
 */
const SKIP_RESOURCE_TYPES = new Set(['font', 'media', 'ping', 'cspReport']);

/**
 * 正在抓取的窗口（`webContents.id`）。
 *
 * ⚠️ `session.webRequest.onBeforeRequest` **整个 session 只有一个**监听器（后装的覆盖先装的），
 * 而所有抓取窗共用 `persist:assistant` ⇒ 不能"每个窗口装一个"，只能装一次 + 按 id 白名单生效。
 * 白名单同时保证主界面、人工验证窗一张图都不会被误拦。
 */
const fetchWindowIds = new Set<number>();
let requestBlockerInstalled = false;

function ensureRequestBlocker(ses: Session): void {
    if (requestBlockerInstalled) return;
    requestBlockerInstalled = true;
    ses.webRequest.onBeforeRequest((details, callback) => {
        // `webContentsId` 在少数请求（如 worker 内部发起的）上是 undefined ⇒ 一律放过
        const wid = details.webContentsId;
        if (wid === undefined || !fetchWindowIds.has(wid)) {
            callback({ cancel: false });
            return;
        }
        callback({ cancel: SKIP_RESOURCE_TYPES.has(details.resourceType) });
    });
}

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

/**
 * 页面内判断是否卡在 **Web 防火墙挑战页**（Cloudflare / DDoS-Guard / Imperva / PerimeterX …）。
 *
 * 为什么从"只认 Cloudflare"扩到"认这一类"（2026-11-23 主人问「是否能识别 cf 这类 web 防火墙」）：
 * 封面站里被拦的不止 CF 一家，而**任何**挑战页的表现都一样 —— 页面打得开、目标 DOM 不存在、
 * 抽取脚本永远返回空。只认 CF 的三个信号，其余 WAF 会被当成"规则过期"并**白等到超时**。
 *
 * ⚠️ 判据仍然**宁可漏判也不能误判**：误判的代价是抽取脚本一次都不执行（正常页面被判成挑战，
 * 界面永远"被拦 + 0 张图"），而漏判只是退回"抽不到" —— 由超时兜底。
 * 所以这里只认**挑战页专有**的标题 / 专用容器 / 专用端点，绝不拿 "captcha"/"turnstile"
 * 这种正常站点登录组件也爱用的字样当判据（2026-10-22 踩过）。
 */
export const WAF_DETECT = `(function(){
  try {
    var t = (document.title || '').toLowerCase();
    var u = (location.href || '').toLowerCase();
    var titleHit = /just a moment|checking your browser|verify you are (a )?human|attention required|one more step|ddos-guard|pardon our interruption|checking if the site connection is secure|请稍候|正在验证|人机验证|安全验证/.test(t);
    var interactiveDom = !!document.querySelector('iframe[src*="challenges.cloudflare.com"], #px-captcha, #sec-if-cpt-container');
    var domHit = interactiveDom || !!document.querySelector('#cf-challenge-running, .cf-challenge, #challenge-form, form[action*="__cf_chl"], #ddos-guard, #challenge-body-text');
    var cfOpt = !!window._cf_chl_opt;
    var urlHit = /\\/cdn-cgi\\/challenge-platform|\\/__cf_chl/.test(u);
    return { cf: titleHit || domHit || cfOpt || urlHit, interactive: interactiveDom, url: location.href, title: document.title };
  } catch (e) { return { cf: false, interactive: false, url: '', title: '' }; }
})()`;

/** 旧名保留给"只关心 CF"的调用点（人工过验证）。判据是同一份，不要再抄第二份 */
export const CF_DETECT = WAF_DETECT;

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
     * 'http'       = 主框架返回 404/410/5xx 等明确错误状态（快失败，不重试）
     * 'timeout'    = 超时/取不到
     * 'net'        = 主框架根本连不上（DNS / 连接被掐断 / SSL 握手失败）⇒ **不值得重试**
     * 'aborted'    = 用户取消了（**控制流**，不是失败原因）
     */
    err?: 'cloudflare' | 'http' | 'timeout' | 'net' | 'aborted';
    httpStatus?: number;
    finalUrl?: string;
    /** `err:'net'` 时的底层原因（Chromium 的描述），直接给用户看 */
    netErr?: string;
    /** 失败时的现场快照 —— 让用户能看见"被拦"是真是假，而不是只信一句文案 */
    snapshot?: PageSnapshot;
}

export interface RunExtractOptions<T = unknown> {
    /** 轮询总超时（毫秒）。只在**没给 `deadline`** 时生效 */
    timeoutMs?: number;
    /**
     * **绝对**截止时刻（`Date.now()` 口径）。给了就以它为准，导航、挑战等待、轮询全吃这一份预算
     * —— 调用方（grab）按"一张卡"算预算，这样跨站点 fallback 与重试加在一起也不会超。
     */
    deadline?: number;
    /** 取消信号；abort 会立刻销毁窗口 */
    signal?: AbortSignal;
    /** 判定抽取结果是否“已命中可退出轮询”（默认仅判 truthy；传它可避免空诊断对象提前退出） */
    isReady?: (data: T) => boolean;
    /**
     * 拍不拍失败现场快照（URL/标题/整页 HTML，最长 800KB）。
     *
     * 默认拍（试跑面板要靠它看"到底是挑战页还是选择器不对"）。
     * ⚠️ **批量抓取必须传 false**：`grab` 从不读 `snapshot`，而每次失败都序列化一份
     * 800KB HTML 是纯烧主进程 CPU —— 5 个并发窗口同时干这件事，界面就跟着卡
     * （2026-11-23 主人报"会卡顿"，这是一条实打实的来源）。
     */
    captureSnapshot?: boolean;
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
    opts: RunExtractOptions<T> = {},
): Promise<FetchResult<T>> {
    const { timeoutMs = POLL_TIMEOUT, signal, captureSnapshot = true } = opts;
    /**
     * 整次尝试的硬截止。给了 `deadline` 就认它（导航也吃这份预算）。
     *
     * ⚠️ 没给的时候是 `NAV_TIMEOUT + timeoutMs`，**不是** `timeoutMs`：原来导航与轮询
     * 是两段独立计时（25s + 20s）。只写 `now + timeoutMs` 会让导航一口吃掉全部预算，
     * 试跑面板（不传 deadline）直接变成"一点开就超时"。
     */
    const deadline = opts.deadline ?? Date.now() + NAV_TIMEOUT + timeoutMs;

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
    // 这个窗口进来的图片/字体/媒体一律不发（见 SKIP_RESOURCE_TYPES）。
    // 人工过验证窗**不登记**：那是给用户看的，页面得完整。
    const wid = win.webContents.id;
    fetchWindowIds.add(wid);
    ensureRequestBlocker(win.webContents.session);

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

        // 真实 Chrome UA + 反检测补丁：与内核版本对齐（D12）
        attachStealth(win);
        // 抓取窗也不跟随弹窗（同源才导航）—— 否则站点脚本的 window.open 会漏出未登记窗口
        adoptSameOriginPopups(win);
        /**
         * 等 **`load`**，不等 `dom-ready`。
         *
         * ⚠️ 2026-11-14 凌晨试过只等 `dom-ready`，当场回滚：封面站的图几乎都是懒加载
         * （`src` 先是占位图，脚本加载完才换成 `data-src` 里的真地址），而 `dom-ready` 太早 ——
         * 抽取脚本按 `src || data-src` 取值，于是抽到的是**占位地址** ⇒ 验证不过 ⇒ 换下一站 ⇒
         * 每条卡满 20 秒超时。症状就是"前面 5 个任务一直不动"。
         * 省下的那 2 秒，不值得用"抽不到 / 抽错图"去换。提速只能靠并发与限速（见 grab.ts）。
         *
         * ⚠️ 导航这一等也吃**同一份**预算（`deadline`）：原来它是独立计时 25 秒，于是
         * "导航 25s + 轮询 20s"叠出来 45 秒，再乘上重试与站点 fallback 就成了几分钟。
         */
        // 主框架真实 HTTP 状态：有些 WAF 直接回 403/429/503 空页，DOM 里连挑战特征都没有
        let httpStatus = 0;
        win.webContents.on('did-navigate', (_e, _u, code: number) => {
            if (code) httpStatus = code;
        });
        // 连不上（DNS / 掐连接 / SSL 握手失败）⇒ 注定打不开，别轮询到预算耗尽
        const navFailed = watchNavFailure(win);

        // 初始导航最多等 6 秒：避免被广告/统计脚本拖住 load 事件而吃掉整个站点预算，
        // 若主文档已就绪但外部资源卡住，6 秒后即进入轮询抽取（仍会等待真实图片或懒加载完成）。
        const initialNavWait = Math.min(6_000, NAV_TIMEOUT, Math.max(deadline - Date.now(), 0));
        await Promise.race([
            win.loadURL(url).catch(() => undefined),
            sleep(initialNavWait, signal).catch(() => undefined),
        ]);

        let lastCf = false;
        let lastInteractive = false;
        /** 连续被判定为挑战页的起点（0 = 当前不是挑战页）。见 `WAF_GIVE_UP_MS` */
        let wafSince = 0;
        let tries = 0;
        let lastData: T | undefined;
        while (Date.now() < deadline) {
            if (signal?.aborted || win.isDestroyed()) return aborted;

            /**
             * ⚠️ 主框架已经告诉我们"连不上"了，就别再抽。这是"报错了还在等"的唯一解：
             * 不做这一步，一个 SSL 握手被掐断的站点会被轮询到 45 秒预算耗尽，
             * 日志刷满屏、进度一动不动（2026-11-23 主人贴的就是这个）。
             */
            const failed = navFailed();
            if (failed) {
                try { win.webContents.stop(); } catch { /* 已停 */ }
                return {
                    ok: false, cf: WAF_STATUS.has(httpStatus),
                    err: WAF_STATUS.has(httpStatus) ? 'cloudflare' : 'net',
                    netErr: `${failed.desc}（${failed.code}）`,
                };
            }

            let cfInfo: { cf?: boolean; interactive?: boolean } | undefined;
            try {
                cfInfo = (await win.webContents.executeJavaScript(WAF_DETECT)) as { cf?: boolean; interactive?: boolean };
            } catch {
                await sleep(POLL_INTERVAL, signal);
                continue;
            }
            lastCf = !!cfInfo?.cf;
            lastInteractive = !!cfInfo?.interactive;
            wafSince = lastCf ? (wafSince || Date.now()) : 0;

            // ⚠️ 即使判定为挑战页也**先抽一次**：CF 判定可能误伤正常页面，而"抽得到"
            // 才是页面正常的最硬证据。抽不到，再按 cf 解释原因（它是解释，不是否决权）。
            let data: unknown;
            try {
                data = await win.webContents.executeJavaScript(script);
            } catch {
                await sleep(POLL_INTERVAL, signal);
                continue;
            }
            if (data !== undefined && data !== null) lastData = data as T;
            const ready = opts.isReady ? (data !== undefined && data !== null && opts.isReady(data as T)) : !!data;
            let curUrl = url;
            try { if (!win.isDestroyed()) curUrl = win.webContents.getURL() || url; } catch { /* ignore */ }
            if (ready) return { ok: true, cf: false, data: data as T, finalUrl: curUrl };

            // 主框架明确返回 HTTP 错误：
            // - 非 WAF 状态（如 404/410/500）：给 2 轮宽限（~1s，防止 SPA 假 404）后立刻快失败，不重试、不空等 45s
            // - WAF 状态（403/429/503）且 DOM 无自动挑战特征：2 轮后立刻判 blocked，不空等
            if (httpStatus >= 400 && !WAF_STATUS.has(httpStatus) && !lastCf && tries >= 1) {
                return {
                    ok: false, cf: false, err: 'http', httpStatus, finalUrl: curUrl, data: lastData,
                    snapshot: captureSnapshot ? ((await snapshotOf(win)) ?? undefined) : undefined,
                };
            }
            if (WAF_STATUS.has(httpStatus) && !lastCf && tries >= 1) {
                return {
                    ok: false, cf: true, err: 'cloudflare', httpStatus, finalUrl: curUrl, data: lastData,
                    snapshot: captureSnapshot ? ((await snapshotOf(win)) ?? undefined) : undefined,
                };
            }

            /**
             * 连续挑战页超时直接放弃：交互式 Turnstile 给 3 秒快速放弃，自动 JS 盾给 6.5 秒。
             */
            const wafBudget = lastInteractive ? WAF_INTERACTIVE_GIVE_UP_MS : WAF_GIVE_UP_MS;
            if (wafSince && Date.now() - wafSince >= wafBudget) break;
            // 抽不到：滚一下看看是不是懒加载还没触发。挑战页滚了也没用，跳过
            if (!lastCf) await lazyNudge(win, ++tries);
            else tries++;
            await sleep(POLL_INTERVAL, signal);
        }
        if (signal?.aborted || win.isDestroyed()) return aborted;
        let endUrl = url;
        try { if (!win.isDestroyed()) endUrl = win.webContents.getURL() || url; } catch { /* ignore */ }
        const blockedNow = lastCf || WAF_STATUS.has(httpStatus);
        const isHttpErr = !blockedNow && httpStatus >= 400;
        return {
            ok: false,
            cf: blockedNow,
            err: blockedNow ? 'cloudflare' : isHttpErr ? 'http' : 'timeout',
            httpStatus: httpStatus || undefined,
            finalUrl: endUrl,
            data: lastData,
            snapshot: captureSnapshot ? ((await snapshotOf(win)) ?? undefined) : undefined,
        };
    } catch {
        // 窗口被销毁 / sleep 被 abort 都落这里
        return signal?.aborted ? aborted : { ok: false, cf: false, err: 'timeout' };
    } finally {
        signal?.removeEventListener('abort', onAbort);
        untrackWindow(win);
        fetchWindowIds.delete(wid);
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
        attachStealth(win);
        // 验证窗同样要设：不设的话 window.open 会开出未登记窗口，应用关不掉
        adoptSameOriginPopups(win);
        // ⚠️ 这一等也要能被取消：不带 `signal` 时，用户点「终止」还要白等到 25 秒导航超时
        await Promise.race([
            win.loadURL(url).catch(() => undefined),
            sleep(NAV_TIMEOUT, signal).catch(() => undefined),
        ]);

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

            await sleep(POLL_INTERVAL, signal);
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

