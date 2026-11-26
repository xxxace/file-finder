/**
 * 管理助手 · 抓取编排
 * ===========================================================================
 * 把「待补目标 + 启用站点」跑成一张结果表，整个过程活在一个 job 里
 * （进度/结果/取消都从 job 读，见 jobs.ts）。
 *
 * 三条设计约束（都是被前面的坑逼出来的）：
 *
 *  1. **同一番号只抓一次**。大片切 3 份时会有 3 个待补目标（PRD §9），
 *     但它们查的是同一个番号、拿的是同一张封面。所以按解析出的番号做 memo：
 *     第一次真抓，后面直接复用结果 —— 既省请求（降封禁），也满足 AC-2。
 *
 *  2. **失败是结果不是异常**。`runExtract` 用 `{ok:false, err}` 表达失败，
 *     所以"重试"要看**返回值**（见 `enqueueWithRetry` 的 isRetryable）。
 *     唯一会抛的是取消（`CancelledError`）—— 那是控制流，不能被记成"这条抓失败了"。
 *
 *  3. **多站点顺序 fallback 到第一个命中为止**。规则里 `enabled:false` 的站直接跳过
 *     （Phase 1 的预置规则里只有 javbus 启用，其余等 Phase 3 校准后再开）。
 *
 *  4. **⚠️「命中」= 拿到了一张能解码成 JPEG 的图，不是抽到一个字符串**（2026-11-10）。
 *     原来 `if (f && f.cover)` 就记 `status:'ok'`，空链接 / 404 / HTML 错误页 / 0 字节
 *     一路绿灯 ⇒ 界面碎图却报"已抓到"，点了写入还把视频搬进没封面的新文件夹。
 *     现在所有来源（真抓 + 落盘命中缓存）都过 `getVerifiedCover()` 这一个判据；
 *     验不过就继续走下一个站点，绝不记命中、也绝不写进命中缓存。
 */
import { CancelledError, combineSignals, enqueueWithRetry, hostOf } from './queue';
import { runExtract, SITE_BUDGET_MS, TARGET_BUDGET_MS } from './siteFetch';
import type { FetchResult } from './siteFetch';
import { getVerifiedCover } from './coverImage';
import { runSteps } from './siteActions';
import type { StepsResult } from './siteActions';
import { buildExtractScript, buildStepScript } from './rules';
import { expandUrl } from './urlTemplate';
import type { ExtractedFields, SiteRule } from './rules';
import { parseTitle } from './match';
import { loadHits, appendHit, appendTombstone } from './hits';
import type { ScanTarget, TargetKind } from './scan';
import type { Job } from './jobs';
import { bumpProgress, finishJob, pushRow } from './jobs';

import { cardKeyOf } from './cardKey';

export type GrabStatus = 'ok' | 'no-id' | 'no-match' | 'blocked' | 'bad-cover' | 'error';

/**
 * 这张卡超出了 45 秒预算。**不是**用户取消 —— 它是"这一条判超时、继续下一条"的结果。
 *
 * 为什么单独一个类型：`CancelledError` 是控制流（worker 要把它归还队列重跑），
 * 两者混用会让"暂停"和"超时"互相伪装 —— 暂停被记成超时、超时被当成暂停重跑，
 * 都是主人真机上看得到的错。
 */
class BudgetExceeded extends Error {
    constructor() {
        super('budget exceeded');
        this.name = 'BudgetExceeded';
    }
}

export interface GrabActor {
    name: string;
    link?: string;
}

/** 一行结果 = 一个"将要写入的封面"。界面预览表直接渲染它 */
export interface GrabRow {
    /** 将写入的文件（盘内相对路径） */
    writeRel: string;
    /** 实际发出去的查询词（番号） */
    query: string;
    hitSite: string | null;
    coverUrl: string | null;
    title: string | null;
    actresses: GrabActor[];
    status: GrabStatus;
    /** 人类可读的原因（失败时必填） */
    message: string;
    /**
     * 只对 `status:'blocked'` 有意义：是**哪个站点**把人拦下的（以及实际被拦的页面 URL）。
     * 人工过验证（`kind:'challenge'`）优先打开实际被拦的 URL —— 解决“首页无盾、详情页有盾”导致验证弹窗秒退的问题。
     */
    blockedSite?: string;
    blockedUrl?: string;
    /**
     * 源视频完整相对路径（透传自 ScanTarget.srcRel，只有 `kind:'file'` 目标有）。
     * apply 的「文件夹化搬迁」按它把视频 rename 进番号文件夹。
     */
    srcRel?: string;
    /**
     * 目标形态（透传自 ScanTarget.kind）。apply 的分组靠它，**不靠文件名猜** ——
     * 封面改成与文件夹同名后，writeRel 的 basename 不再能区分两种形态。
     */
    kind?: TargetKind;
    /**
     * 目标的显示名（透传自 ScanTarget.name）。确认弹窗要拿它当卡片标题 ——
     * `writeRel` 的最后一段对 `kind:'cover'` 是**文件名**（如 `TST-xxx.jpg`），
     * 而这里是**去扩展名的显示名**，正是界面该显示的东西。
     */
    name?: string;
    /**
     * `true` = 这一行的封面来自**本地抽帧**（`frame.ts` 的 `FrameRow`），不是站点链接。
     * 写盘时据此把"取字节"从下载换成读帧缓存；抓取端从不设置它。
     */
    frame?: boolean;
    /**
     * 帧缓存文件名（只有抽帧行有）。写盘取字节时按它读本地文件，**不下载**。
     * 放在 `GrabRow` 上而不是只放 `FrameRow`：写盘分组吃的是同一个行类型，
     * 两套形状会让 `buildGroups` 到处 `as`。
     */
    frameFile?: string;
}

/** 命中结果（与具体写入位置无关，因此可以在同名影片间复用） */
interface GrabMatch {
    hitSite: string;
    coverUrl: string;
    title: string | null;
    actresses: GrabActor[];
}

/**
 * 同时在飞的抓取数 = 5（2026-11-14 主人裁决：「并发不能开到 5 吗」）。
 *
 * ⚠️ 这个数**不是**"越大越快"的旋钮。昨天 5 个并发会卡，根因不是 5，而是当时每条都要
 * 「新建窗口 → 等整个页面 load 完（含全站图片/广告）→ 销毁窗口」⇒ 5 个渲染进程同时
 * 解码图片、跑广告脚本。11-13 把它降到 2，只是把症状盖住了。
 *
 * 11-14 改的是**单窗成本**（见 `siteFetch.ts` 的 `SKIP_RESOURCE_TYPES` 与 `loadURL` 那段）：
 * 拦掉字体/媒体/beacon（**不含 image**，理由见那里的回退记录），配合 `HOST_GAP_MS` 1200
 * ⇒ 现在 5 个窗口的总开销低于当年轻飘飘的 2 个。
 * ⚠️ 试过"只等 dom-ready"与"连 image 一起拦"，两者都会让懒加载站的封面抽成占位图，已回滚。
 *
 * ⚠️ **提速到什么程度由 `HOST_GAP_MS` 封顶，不由这个数决定**：
 *     稳态吞吐 = min(N / T单条, 1 / HOST_GAP_MS)
 *   N=5、间隔 1.2s ⇒ 上限 0.83 条/秒。也就是说 **单条耗时 T > 6 秒** 时，加这个数才看得见；
 *   T ≤ 6 秒时早就被间隔封顶了，再往上加就是空转（只多占内存和渲染进程）。
 *   要真提速，先看底栏 `抓取中 x/y` 的推进节奏：每 1.2 秒跳一格 = 已在封顶，别加；
 *   每 3～4 秒才跳一格 = T 太大，加这个数有用。
 *
 * ⚠️ 改这个数**必须**同步 `queue.ts` 的 `MAX_ACTIVE_PER_HOST`（它必须 ≥ 这里）。
 */
const GRAB_PARALLEL = 5;

/** 一次站点尝试的完整结果（match 为 null 时 blocked/why 说明原因） */
interface MatchOutcome {
    match: GrabMatch | null;
    blocked: boolean;
    blockedSite?: string;
    blockedUrl?: string;
    why: string;
    /** 站点给了链接、但链接取不到真图 —— 与"站点没有这部片"是两件事 */
    badCover?: boolean;
}

export async function runGrab(
    targets: ScanTarget[],
    rules: SiteRule[],
    job: Job<GrabRow>,
    dataDir: string,
    /**
     * `force: true` = **绕开落盘命中缓存，真打站点**。
     */
    force = false,
    /**
     * `true` = 追加一批目标到**已有的** job（重抓失败项 / 过验证后重抓）。
     */
    append = false,
): Promise<void> {
    const active = rules.filter(r => r.enabled);

    // 按卡键收拢：多卷（8 个分卷）同一部片只作为 1 个抓取任务，彻底杜绝重复抓取
    const cardGroups = new Map<string, ScanTarget[]>();
    for (const t of targets) {
        const key = cardKeyOf({ kind: t.kind, writeRel: t.writeRel, query: t.query });
        const list = cardGroups.get(key);
        if (list) list.push(t);
        else cardGroups.set(key, [t]);
    }
    const cardList = [...cardGroups.values()];

    if (append) {
        // 追加重抓（单卡重抓 / 补抓失败项 / 过验证重抓）：先撤掉这些卡的旧结果并扣回旧计数，
        // 避免 total 无限膨胀、hits/total 对不上
        const retryRels = new Set(targets.map(t => t.writeRel));
        const prevRows = job.rows.filter(r => retryRels.has(r.writeRel));
        job.rows = job.rows.filter(r => !retryRels.has(r.writeRel));

        const prevCards = new Map<string, GrabRow[]>();
        for (const r of prevRows) {
            const k = cardKeyOf({ kind: r.kind ?? 'file', writeRel: r.writeRel, query: r.query });
            const arr = prevCards.get(k);
            if (arr) arr.push(r);
            else prevCards.set(k, [r]);
        }
        let dProc = 0, dHits = 0, dMiss = 0, dBlk = 0;
        for (const grp of prevCards.values()) {
            dProc += 1;
            if (grp.some(r => r.status === 'ok')) dHits += 1;
            else if (grp.some(r => r.status === 'blocked')) dBlk += 1;
            else dMiss += 1;
        }
        const netNew = Math.max(0, cardList.length - prevCards.size);
        bumpProgress(job, {
            total: job.progress.total + netNew,
            processed: Math.max(0, job.progress.processed - dProc),
            hits: Math.max(0, job.progress.hits - dHits),
            misses: Math.max(0, job.progress.misses - dMiss),
            blocked: Math.max(0, job.progress.blocked - dBlk),
        });
    } else {
        bumpProgress(job, { total: cardList.length });
    }

    if (!active.length) {
        finishJob(job, 'error', '没有启用任何站点规则：先去「站点规则」里启用一个');
        return;
    }

    // 跨任务/跨重启的命中缓存：以前抓到过的番号直接复用 URL，不再开窗打站点
    const hits = await loadHits(dataDir);

    /**
     * 番号 → 尝试结果（Promise 形态）。
     * 全链路 memoize，不管是命中缓存验证还是打站点，同一番号天然只发一次！
     */
    const outcomeMemo = new Map<string, Promise<MatchOutcome>>();

    /**
     * ⚠️ 这里**刻意没有**「某站被拦几次就整批跳过」的熔断（2026-11-23 自检后撤掉）：
     * 抓取是 5 并发，同一瞬间会有 5 张卡一起撞同一个站的墙 —— "连续两次拦截"在并发下
     * 根本不含"试过多次"的语义，而是**一眨眼就被判定成整站报废**，后面所有卡连试都不试。
     * 而 CF 经常只拦某些详情页（页级拦截），这一刀会把本来能命中的卡一起砍掉。
     *
     * 省时间的正确手段只有两条，都已经有了：挑战页 **4 秒**放弃（`WAF_GIVE_UP_MS`）
     * 和每张卡 **45 秒**总预算（`TARGET_BUDGET_MS`）。整站被拦的代价 = 4 秒/卡 ÷ 并发，
     * 这个代价换命中率是划算的。
     */

    /**
     * 真打站点：按启用站点顺序 fallback 到第一个命中为止。
     * 每个站点受单站预算（`SITE_BUDGET_MS`）限制，防止第一个站卡死饿死所有备用站点。
     */
    async function fetchOnce(id: string, deadline: number, signal: AbortSignal): Promise<MatchOutcome> {
        let blocked = false;
        let blockedSite: string | undefined;
        let blockedUrl: string | undefined;
        const siteLogs: string[] = [];
        let badCover = false;
        let match: GrabMatch | null = null;

        for (const rule of active) {
            if (signal.aborted || job.cancelled) throw new CancelledError();

            badCover = false;
            const remaining = deadline - Date.now();
            if (remaining <= 0) break;

            // 单站硬上限，避免第 1 站占满整张卡预算导致后续站点零机会
            const siteDeadline = Math.min(deadline, Date.now() + SITE_BUDGET_MS);
            const siteName = rule.name || rule.id;

            bumpProgress(job, { current: `${id} → ${rule.id}` });
            const url = expandUrl(rule.detailUrl, id, rule.queryTransform);
            const extract = buildExtractScript(rule.fields);
            const steps = rule.steps ?? [];
            const planned = steps.map((s) => ({
                act: s.act,
                script: buildStepScript(s, id, rule.queryTransform),
                waitSelector: (s.act === 'type' || s.act === 'click' || s.act === 'press') ? s.selector : undefined,
            }));

            let res: FetchResult<ExtractedFields> | StepsResult;
            try {
                res = await enqueueWithRetry<FetchResult<ExtractedFields> | StepsResult>(
                    hostOf(url),
                    () => (steps.length
                        ? runSteps(url, planned, extract, {
                            signal, deadline: siteDeadline, captureSnapshot: false,
                            isReady: (f) => !!(f && (f as ExtractedFields).cover),
                        })
                        : runExtract<ExtractedFields>(url, extract, {
                            signal, deadline: siteDeadline, captureSnapshot: false,
                            isReady: (f) => !!(f && f.cover),
                        })),
                    // 仅在剩余预算充足时对纯粹超时做一次快速重试；404/网络错/被拦绝不重试
                    r => !steps.length && !r.ok && r.err === 'timeout' && siteDeadline - Date.now() > 3_500,
                    signal,
                    siteDeadline,
                );
            } catch (e) {
                if (e instanceof CancelledError || signal.aborted) throw new CancelledError();
                siteLogs.push(`${siteName}: ${e instanceof Error ? e.message : String(e)}`);
                continue;
            }

            // 中断信号优先判定（防止暂停/终止瞬间返回了 timeout 而被误记为失败）
            if (signal.aborted || res.err === 'aborted') throw new CancelledError();

            if (!res.ok) {
                if (res.err === 'cloudflare') {
                    blocked = true;
                    blockedSite = blockedSite || rule.id;
                    blockedUrl = blockedUrl || res.finalUrl || url;
                    siteLogs.push(`${siteName}: 被验证拦截`);
                } else if (res.err === 'http') {
                    siteLogs.push(`${siteName}: HTTP ${res.httpStatus || 404}（无此作品）`);
                } else if (res.err === 'net') {
                    siteLogs.push(`${siteName}: ${res.netErr || '连接失败'}`);
                } else {
                    siteLogs.push(`${siteName}: 站点超时`);
                }
                continue;
            }

            const f = res.data as ExtractedFields | undefined;
            if (f && f.cover) {
                const check = await getVerifiedCover(f.cover, signal, undefined, res.finalUrl || url);
                if (signal.aborted) throw new CancelledError();
                if (check.ok) {
                    match = {
                        hitSite: rule.id,
                        coverUrl: f.cover,
                        title: f.title || null,
                        actresses: f.actress ? [{ name: f.actress, link: f.actressLink || undefined }] : [],
                    };
                    appendHit(dataDir, { id, at: new Date().toISOString(), ...match });
                    break;
                }
                siteLogs.push(`${siteName}: 封面不可用（${check.why}）`);
                badCover = true;
                continue;
            }
            siteLogs.push(`${siteName}: 未抽到封面（规则可能过期）`);
        }
        return {
            match,
            blocked,
            blockedSite,
            blockedUrl,
            why: siteLogs.join('；') || '所有站点都没抽到封面',
            badCover,
        };
    }

    /**
     * 取番号的尝试结果（全过程 Promise 级别 memo，防止重复请求）：
     *   ① 落盘命中缓存（以前抓到过）→ ② 真打站点。
     *
     * `deadline` / `signal` 都是**第一次**领取这张卡时的那一份（同一次领取内跨站点、
     * 跨重试共享）。暂停归还后重领会重算 —— 刻意的：用户手动暂停十分钟再继续，
     * 不该一放行就判超时。
     *
     * ⚠️ memo 的 key 只有番号 ⇒ 同番号的两张卡（不同层）会共用**第一张卡的**预算。
     * 这是可接受的取舍：多卷同卡已在 `cardGroups` 收拢，跨层同番号极少，
     * 而给 memo 加 signal 维度等于让"同一番号抓两次"，代价更大。
     */
    function outcomeOf(id: string, deadline: number, signal: AbortSignal): Promise<MatchOutcome> {
        let p = outcomeMemo.get(id);
        if (!p) {
            p = (async () => {
                const hit = force ? undefined : hits.get(id);
                if (hit) {
                    const check = await getVerifiedCover(hit.coverUrl, signal);
                    if (check.ok) {
                        return {
                            match: {
                                hitSite: hit.hitSite,
                                coverUrl: hit.coverUrl,
                                title: hit.title,
                                actresses: hit.actresses,
                            },
                            blocked: false,
                            why: '',
                        };
                    }
                    if (check.urlBad) appendTombstone(dataDir, id);
                    hits.delete(id);
                }
                return fetchOnce(id, deadline, signal);
            })();
            /**
             * ⚠️ 被打断（暂停 / 终止 / 预算到点）的 promise **不能留在 memo 里**。
             * 它是一条 rejected promise；下次重跑同一番号会原样再抛一次 ⇒ 那张卡永久失败。
             * 症状是"暂停再继续，一半的卡直接变红"（2026-11-23 顺手堵掉）。
             */
            p.catch(() => outcomeMemo.delete(id));
            outcomeMemo.set(id, p);
        }
        return p;
    }

    function recordFail(
        list: ScanTarget[],
        query: string,
        status: GrabStatus,
        message: string,
        extra?: { blockedSite?: string; blockedUrl?: string },
    ): void {
        for (const t of list) {
            pushRow(job, {
                writeRel: t.writeRel,
                query,
                hitSite: null,
                coverUrl: null,
                title: null,
                actresses: [],
                status,
                message,
                srcRel: t.srcRel,
                kind: t.kind,
                name: t.name,
                ...extra,
            });
        }
        step(job, status === 'blocked' ? 'blocked' : 'miss');
    }

    /** 处理一部片（含这一部的所有分卷，只抓一次）：解析番号 → 取结果 → 给各分卷各记一行 */
    async function grabCard(list: ScanTarget[]): Promise<void> {
        const t0 = list[0];
        const id = t0.query || parseTitle(t0.name).id;
        if (!id) {
            recordFail(list, '', 'no-id', '认不出番号，已跳过');
            return;
        }

        let outcome: MatchOutcome;
        const cardBudgetMs = Math.min(90_000, Math.max(TARGET_BUDGET_MS, active.length * SITE_BUDGET_MS));
        const budget = new AbortController();
        const deadline = Date.now() + cardBudgetMs;
        const merged = combineSignals(job.controller.signal, budget.signal);
        let budgetTimer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<never>((_, reject) => {
            budgetTimer = setTimeout(() => {
                budget.abort();
                reject(new BudgetExceeded());
            }, cardBudgetMs);
        });
        try {
            outcome = await Promise.race([outcomeOf(id, deadline, merged.signal), timeout]);
        } catch (e) {
            const overBudget =
                e instanceof BudgetExceeded ||
                (e instanceof CancelledError && !job.cancelled && budget.signal.aborted);
            if (overBudget) {
                recordFail(list, id, 'no-match', `超时：${Math.round(cardBudgetMs / 1000)} 秒内没拿到封面`);
                return;
            }
            if (e instanceof CancelledError) throw e;
            recordFail(list, id, 'error', e instanceof Error ? e.message : String(e));
            return;
        } finally {
            if (budgetTimer) clearTimeout(budgetTimer);
            merged.dispose();
        }

        if (job.cancelled && !outcome.match) return;

        if (outcome.match) {
            for (const t of list) {
                pushRow(job, {
                    writeRel: t.writeRel,
                    query: id,
                    hitSite: outcome.match.hitSite,
                    coverUrl: outcome.match.coverUrl,
                    title: outcome.match.title,
                    actresses: outcome.match.actresses,
                    status: 'ok',
                    message: '',
                    srcRel: t.srcRel,
                    kind: t.kind,
                    name: t.name,
                });
            }
            step(job, 'hit');
        } else {
            const status: GrabStatus = outcome.blocked ? 'blocked' : outcome.badCover ? 'bad-cover' : 'no-match';
            recordFail(list, id, status, outcome.why, {
                blockedSite: outcome.blockedSite,
                blockedUrl: outcome.blockedUrl,
            });
        }
    }

    /**
     * 待处理队列（**不是**索引游标）。2026-11-23 改：暂停现在会**中断在飞请求**，
     * 被打断的那张没出结果 ⇒ worker 必须能把它放回队首重跑。
     * 用 `next++` 做不到"归还"：并发下两个 worker 同时回退游标会互相踩，直接丢卡。
     */
    const queued = [...cardList];
    const worker = async () => {
        for (;;) {
            if (job.cancelled) return;
            await job.gate.wait();
            if (job.cancelled) return;
            const card = queued.shift();
            if (!card) return;
            /**
             * 在飞登记 —— 界面只给这几张卡转圈。
             * 放在 worker 里而不是 `grabCard` 里：`finally` 能兜住取消（CancelledError）、
             * 异常、以及未来的提前 return，三种出口都不会把卡永久留在 inflight 里。
             */
            const rels = card.map(t => t.writeRel);
            job.inflight.push(...rels);
            try {
                await grabCard(card);
            } catch (e) {
                /**
                 * ⚠️ **暂停**打断（非终止）⇒ 这张卡还没出结果，放回队首等「继续」。
                 * 丢了它等于让用户白等一轮；而终止（`job.cancelled`）是真丢 —— 那条
                 * 由下面的 throw 交给 `Promise.allSettled` 收尾。
                 */
                if (e instanceof CancelledError && !job.cancelled) {
                    queued.unshift(card);
                    continue;
                }
                throw e;
            } finally {
                for (const r of rels) {
                    const k = job.inflight.indexOf(r);
                    if (k !== -1) job.inflight.splice(k, 1);
                }
            }
        }
    };

    try {
        const settled = await Promise.allSettled(
            Array.from({ length: GRAB_PARALLEL }, () => worker()),
        );
        const rejected = settled.find(r => r.status === 'rejected');
        if (rejected) throw (rejected as PromiseRejectedResult).reason;

        const { processed, total, hits: hCount, misses, blocked } = job.progress;
        if (job.cancelled) {
            finishJob(job, 'cancelled',
                `已终止：处理了 ${processed}/${total}，命中 ${hCount} 张（可以写入）`);
        } else {
            finishJob(job, 'done', `完成：命中 ${hCount}，未命中 ${misses}，被拦 ${blocked}`);
        }
    } catch (e) {
        if (e instanceof CancelledError) {
            const { processed, total, hits: hCount } = job.progress;
            finishJob(job, 'cancelled',
                `已终止：处理了 ${processed}/${total}，命中 ${hCount} 张（可以写入）`);
        } else {
            finishJob(job, 'error', e instanceof Error ? e.message : String(e));
        }
    }
}

/** 记一条结果并推进计数。命中/被拦/未命中三档互斥，保证相加恒等于已处理数 */
function step(job: Job<GrabRow>, kind: 'hit' | 'miss' | 'blocked'): void {
    const p = job.progress;
    bumpProgress(job, {
        processed: p.processed + 1,
        hits: p.hits + (kind === 'hit' ? 1 : 0),
        misses: p.misses + (kind === 'miss' ? 1 : 0),
        blocked: p.blocked + (kind === 'blocked' ? 1 : 0),
        current: '',
    });
}
