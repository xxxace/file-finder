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
 */
import { CancelledError, enqueueWithRetry, hostOf } from './queue';
import { runExtract } from './siteFetch';
import type { FetchResult } from './siteFetch';
import { runSteps } from './siteActions';
import type { StepsResult } from './siteActions';
import { buildExtractScript, buildStepScript } from './rules';
import { expandUrl } from './urlTemplate';
import type { ExtractedFields, SiteRule } from './rules';
import { parseTitle } from './match';
import { loadHits, appendHit } from './hits';
import type { ScanTarget, TargetKind } from './scan';
import type { Job } from './jobs';
import { bumpProgress, finishJob, pushRow } from './jobs';

export type GrabStatus = 'ok' | 'no-id' | 'no-match' | 'blocked' | 'error';

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
     * 只对 `status:'blocked'` 有意义：是**哪个站点**把人拦下的。
     * 人工过验证（`kind:'challenge'`）要按站点开窗 —— 拿不到站点就只能瞎猜。
     */
    blockedSite?: string;
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
}

/** 命中结果（与具体写入位置无关，因此可以在同名影片间复用） */
interface GrabMatch {
    hitSite: string;
    coverUrl: string;
    title: string | null;
    actresses: GrabActor[];
}

/**
 * 同时在飞的抓取数（2026-09-25 用户拍板"一次 5 个"）。
 * 每个 worker 一次抓一个番号 = 一个隐藏 BrowserWindow；同主机的**发起节奏**
 * 仍被 queue.ts 的 runPaced 钉在 1.5s 一个，所以加大这个数只会让慢页面重叠加载，
 * 不会让对站点的请求变密 —— 觉得猛了调小，觉得慢了调大，是唯一的旋钮。
 */
const GRAB_PARALLEL = 5;

/** 一次站点尝试的完整结果（match 为 null 时 blocked/why 说明原因） */
interface MatchOutcome {
    match: GrabMatch | null;
    blocked: boolean;
    blockedSite?: string;
    why: string;
}

export async function runGrab(
    targets: ScanTarget[],
    rules: SiteRule[],
    job: Job<GrabRow>,
    dataDir: string,
    /**
     * `force: true` = **绕开落盘命中缓存，真打站点**。
     *
     * 为什么必须有它（2026-10-02「换封面」）：下面 `outcomeOf` 的第一级就是查
     * `hits.jsonl`，凡助手**以前抓到过**的番号会秒回旧 URL ⇒ 下载到**逐字节相同**的图。
     * 对"补封面"这是优点（省请求）；但对"换封面"就是**空转** —— 用户明确表示这张不好、
     * 要换一张，结果拿回同一张，"已替换"就成了假话。
     *
     * ⚠️ 刻意**不写墓碑**（`appendTombstone`）来实现：墓碑的语义是"这个 URL 永久坏了"，
     * 而"我想换一张"跟 URL 好坏无关 —— 不该污染那张表。
     */
    force = false,
    /**
     * `true` = 追加一批目标到**已有的** job（重抓失败项 / 过验证后重抓）。
     * 区别只在进度总数要累加，不能把 `total` 重置成这一批的数量。
     */
    append = false,
): Promise<void> {
    const active = rules.filter(r => r.enabled);
    bumpProgress(job, {
        total: append ? job.progress.total + targets.length : targets.length,
    });

    if (!active.length) {
        finishJob(job, 'error', '没有启用任何站点规则：先去「站点规则」里启用一个');
        return;
    }

    // 跨任务/跨重启的命中缓存：以前抓到过的番号直接复用 URL，不再开窗打站点
    // （中断、重启后重抓，成功的部分是秒回的 —— 用户 2026-09-25 反馈的"从 0 开始"就断在这）
    const hits = await loadHits(dataDir);

    /**
     * 番号 → 尝试结果（Promise 形态）。null 表示"抓过了，没命中"（同样要记住，
     * 免得对同一番号反复打站点）。存 Promise 而不是值：并发下两个分卷（同一番号）
     * 可能同时到 —— 后到的直接 await 同一个 Promise，天然只发一次请求。
     */
    const memo = new Map<string, Promise<MatchOutcome>>();

    /** 真打站点：按启用站点顺序 fallback 到第一个命中为止 */
    async function fetchOnce(id: string): Promise<MatchOutcome> {
        let blocked = false;
        let blockedSite: string | undefined;
        let why = '所有站点都没抽到封面';
        let match: GrabMatch | null = null;

        for (const rule of active) {
            if (job.cancelled) return { match, blocked, blockedSite, why };

            bumpProgress(job, { current: `${id} → ${rule.id}` });
            // ⚠️ 与试跑走**同一个**模板引擎 —— 两边拼法必须永远一致（否则"试跑通了、抓取反而错"）
            const url = expandUrl(rule.detailUrl, id, rule.queryTransform);
            const extract = buildExtractScript(rule.fields);
            const steps = rule.steps ?? [];
            const planned = steps.map((s) => ({ act: s.act, script: buildStepScript(s, id) }));

            let res: FetchResult<ExtractedFields> | StepsResult;
            try {
                res = await enqueueWithRetry<FetchResult<ExtractedFields> | StepsResult>(
                    hostOf(url),
                    () => (steps.length
                        ? runSteps(url, planned, extract, { signal: job.controller.signal })
                        : runExtract<ExtractedFields>(url, extract, { signal: job.controller.signal })),
                    // ⚠️ 有动作的规则**一律不重试**：动作有副作用，重试 = 重复输入 / 重复点击。
                    // "只有超时值得再试"那条判据只对幂等的纯抽取成立。
                    r => !steps.length && !r.ok && r.err === 'timeout',
                    job.controller.signal,
                );
            } catch (e) {
                if (e instanceof CancelledError) throw e;
                why = e instanceof Error ? e.message : String(e);
                continue;
            }

            if (res.err === 'aborted') throw new CancelledError();

            if (!res.ok) {
                if (res.err === 'cloudflare') {
                    blocked = true;
                    blockedSite = rule.id;
                    why = '被站点拦截（需要人工过验证）';
                } else {
                    why = '打不开页面（超时）';
                }
                continue;
            }

            const f = res.data as ExtractedFields | undefined;
            if (f && f.cover) {
                match = {
                    hitSite: rule.id,
                    coverUrl: f.cover,
                    title: f.title || null,
                    // javbus 这类站的选择器只取第一个演员节点 —— 先给一个，
                    // 多演员拆解是 Phase 4「演员聚合」的事
                    actresses: f.actress ? [{ name: f.actress, link: f.actressLink || undefined }] : [],
                };
                // 立刻进命中缓存（追加一行，fire-and-forget）：中断/重启后这里直接复用
                appendHit(dataDir, { id, at: new Date().toISOString(), ...match });
                break;
            }
            why = '页面打开了，但没抽到封面（规则可能过期）';
        }
        return { match, blocked, blockedSite, why };
    }

    /**
     * 取番号的尝试结果，三级递进：
     *   ① 落盘命中缓存（以前抓到过的，秒回、零网络）→
     *   ② 本次任务的 memo（并发撞同一番号复用同一个 Promise）→
     *   ③ 真打站点。
     */
    function outcomeOf(id: string): Promise<MatchOutcome> {
        // `force` 时跳过命中缓存（理由见 `runGrab` 的形参注释）；`force` 下抓到的**新 URL
        // 仍然照常 `appendHit`**（在 `fetchOnce` 里），所以缓存不会因此失效。
        const hit = force ? undefined : hits.get(id);
        if (hit) {
            return Promise.resolve({
                match: {
                    hitSite: hit.hitSite,
                    coverUrl: hit.coverUrl,
                    title: hit.title,
                    actresses: hit.actresses,
                },
                blocked: false,
                why: '',
            });
        }
        let p = memo.get(id);
        if (!p) {
            p = fetchOnce(id).catch(e => {
                // memo 里不能留 rejected：同番号的后续行要能拿到"失败原因"而不是抛异常
                memo.delete(id);
                throw e;
            });
            memo.set(id, p);
        }
        return p;
    }

    /** 处理一个目标：解析番号 → 取结果 → 记一行。单条失败记成一行，不炸整批 */
    async function grabOne(t: ScanTarget): Promise<void> {
        // ⚠️ 优先用目标自带的查询词。封面卡条目的 `name` 是**封面图文件名**
        // （`handleCover` 里 `info.name = getFilename(file)`，可能是 `cover`/`1` 这类），
        // 拿它解析番号必然失败 ⇒ 那批目标会被静默记成 `no-id` 跳过
        // （用户真机实测："点了换封面，弹窗里什么都没发生"）。
        // `scanMissingCovers`（补封面）的目标**没有** `query` 字段，所以回落到原来的
        // `parseTitle(t.name)` —— 那条既有路径的行为一个字都没变。
        const id = t.query || parseTitle(t.name).id;
        if (!id) {
            pushRow(job, {
                writeRel: t.writeRel,
                query: '',
                hitSite: null,
                coverUrl: null,
                title: null,
                actresses: [],
                status: 'no-id',
                // 原文案写的是"可手动填写" —— 界面上**从来没有**这个入口，是句空承诺。
                // 这里只说事实：跳过了，不会去搜、也不会写任何东西。
                message: '认不出番号，已跳过',
            });
            step(job, 'miss');
            return;
        }

        let outcome: MatchOutcome;
        try {
            outcome = await outcomeOf(id);
        } catch (e) {
            if (e instanceof CancelledError) throw e;
            pushRow(job, {
                writeRel: t.writeRel, query: id, hitSite: null, coverUrl: null, title: null,
                actresses: [], status: 'error',
                message: e instanceof Error ? e.message : String(e),
            });
            step(job, 'miss');
            return;
        }

        // ⚠️ 终止时**已经拿到的结果照样要记**：用户点「终止」最关心的是
        // "抓到的那几张还算不算"。原来这里无条件 return，把这一条的命中整条丢掉
        // ⇒ hits 恒为 0、写入按钮根本不出现（用户 2026-10-22 反馈）。
        if (job.cancelled && !outcome.match) return;

        if (outcome.match) {
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
            step(job, 'hit');
        } else {
            pushRow(job, {
                writeRel: t.writeRel,
                query: id,
                hitSite: null,
                coverUrl: null,
                title: null,
                actresses: [],
                status: outcome.blocked ? 'blocked' : 'no-match',
                message: outcome.why,
                blockedSite: outcome.blockedSite,
            });
            step(job, outcome.blocked ? 'blocked' : 'miss');
        }
    }

    // 有界并发：GRAB_PARALLEL 个 worker 共享一个下标，谁空谁取下一条。
    // 同番号去重靠 memo 的 Promise 形态；取消时 worker 各自退出，Promise.all 收拢。
    //
    // ⚠️ 闸门必须在**取下一条之前**等：暂停时在飞的条目跑完即记入结果，
    // 停住的是队列 —— 这样"暂停 → 写入已抓到的 → 继续"能串起来（用户 2026-10-22）。
    // ⚠️ 先看 `next` 再等闸门：否则队列已经跑空时暂停，worker 会挂在闸门上，
    // job 永远停在 paused（明明已经没事可做了）。
    let next = 0;
    const worker = async () => {
        while (!job.cancelled) {
            if (next >= targets.length) return;
            await job.gate.wait();
            if (job.cancelled) return;
            const i = next++;
            if (i >= targets.length) return;
            await grabOne(targets[i]);
        }
    };

    try {
        // ⚠️ allSettled 而不是 all：某个 worker 被 abort 抛 CancelledError 时，
        // `all` 会立刻 reject，而其他 worker 还在往里 pushRow —— 收尾与写结果赛跑，
        // 最后几条会被"已经结束"的快照吞掉。等全部收拢再 `finishJob`。
        const settled = await Promise.allSettled(
            Array.from({ length: GRAB_PARALLEL }, () => worker()),
        );
        const rejected = settled.find(r => r.status === 'rejected');
        if (rejected) throw (rejected as PromiseRejectedResult).reason;

        const { processed, total, hits, misses, blocked } = job.progress;
        if (job.cancelled) {
            finishJob(job, 'cancelled',
                `已终止：处理了 ${processed}/${total}，命中 ${hits} 张（可以写入）`);
        } else {
            finishJob(job, 'done', `完成：命中 ${hits}，未命中 ${misses}，被拦 ${blocked}`);
        }
    } catch (e) {
        if (e instanceof CancelledError) {
            const { processed, total, hits } = job.progress;
            finishJob(job, 'cancelled',
                `已终止：处理了 ${processed}/${total}，命中 ${hits} 张（可以写入）`);
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
