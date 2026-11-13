/**
 * 补封面 · 视图模型
 *
 * 这个模块只做一件事：把「扫描目标 + 抓取行 + 写入行」翻译成**卡片数组**。
 * 所有判定（一张卡代表几部片、这张卡现在什么状态、底栏该说什么话）都收在这里，
 * 组件里只负责画 —— 判据散到模板里就再也测不动了。
 */
import type { JobSnapshot } from './jobTypes';

export interface ScanTargetLike {
    kind: 'file' | 'dir' | 'cover';
    dir: string;
    name: string;
    writeRel: string;
    /** 番号（`kind:'file'` 才有）。用来把分卷收拢成一张卡 */
    query?: string;
}

/** 抓取行的最小集（服务端字段更多，这里只认用得上的） */
export interface GrabRowLike {
    writeRel: string;
    status: 'ok' | 'no-id' | 'no-match' | 'blocked' | 'bad-cover' | 'error';
    coverUrl: string | null;
    hitSite?: string | null;
    /** 被哪个站点拦的（「人工过验证」要按站点开窗） */
    blockedSite?: string;
    /** 失败原因（人类可读）。卡片面上只放短标签，这句进悬停详情 */
    message?: string;
    /** 抽帧失败的机器可读原因（服务端 `FrameRow.why`：`no-video` / `no-frame`）。卡面只对 `no-video` 换个词 */
    why?: string;
    /** `true` = 封面来自本地抽帧（服务端 `FrameRow`），此时 `coverUrl` 为 null */
    frame?: boolean;
    /** 帧缓存文件名。预览地址由父层用 `/assistant/frame` 拼 */
    frameFile?: string;
    pct?: number;
    attempt?: number;
    skipped?: number;
}

export interface ApplyRowLike {
    writeRel: string;
    ok: boolean;
    /** 服务端原话（成功/失败都有）。失败时这是**唯一的**原因来源，悬停详情要显示它 */
    message?: string;
}

export type CoverState =
    | 'idle'      // 还没抓
    | 'pending'   // 正在被抓（任务跑着、这张还没结果）
    | 'ok'        // 抓到封面
    | 'written'   // 已写进盘
    | 'blocked'   // 站点拦截
    | 'miss'      // 站点没有
    | 'noid'      // 认不出番号
    | 'error'     // 抓取失败
    | 'writefail'; // 写入失败

export interface CoverItem {
    key: string;
    kind: 'file' | 'dir' | 'cover';
    title: string;
    path: string;
    kindText: string;
    writeRels: string[];
    state: CoverState;
    badge: string;
    coverUrl: string | null;
    /** 这张脸是本地抽帧来的（有它才有「换一帧」） */
    frame?: { file: string; pct: number; attempt: number; skipped: number };
    /**
     * 失败/被拦的**完整原因**（服务端 `message`）。
     *
     * 卡片面上只放得下两个字（"未找到" / "被拦"），真正有用的那句
     * "打不开页面（超时）/ 抽到的封面不可用：…"必须留给悬停详情。
     */
    note?: string;
    /** 封面来源站点（成功时）/ 拦下我们的站点（失败时） */
    site?: string;
}

/**
 * 卡片分组键。**必须与服务端 apply 的 `buildGroups` 同口径**：
 *   - 文件形态：同层 + 同番号 = 一部片（8 个分卷是 8 个 writeRel、一张卡）
 *   - 目录形态：一个目标一张卡（`kind|writeRel` —— 只用 writeRel 会把同层的第二个吞掉）
 */
function cardKeyOf(t: ScanTargetLike): string {
    return t.kind === 'file'
        ? `file|${t.dir}|${t.query ?? t.name}`
        : `${t.kind}|${t.writeRel}`;
}

function kindTextOf(kind: CoverItem['kind'], volumes: number): string {
    if (kind === 'file') return volumes > 1 ? `${volumes} 个分卷` : '裸文件';
    return kind === 'cover' ? '覆盖' : '新建';
}

export function buildCoverItems(
    targets: ScanTargetLike[],
    grabRows: GrabRowLike[],
    applyRows: ApplyRowLike[],
    /**
     * @param opts.inflight 此刻**真正在飞**的 `writeRel`（后端 job 直接给）。
     *   只认它，不推断 —— 见下面 `isInflight` 的注释。
     * @param opts.frameBusy 单卡抽帧的在途标记（「换一帧」只有一两秒，靠它立即出点阵）
     *
     * ⚠️ 刻意**不收** `selected`：选中态是父层渲染时算的（`isSelected(item)`），
     *    状态机不该再拿它推"在飞" —— 那就是 2026-11-14 修掉的那个假象。
     */
    opts: {
        frameBusy?: ReadonlySet<string>;
        inflight?: ReadonlySet<string>;
        /**
         * 任务是否在跑。**只用来给"还没轮到"的卡打一个「排队」标记** ——
         * 绝不用它推断"这张在飞"（那是 `inflight` 的职责，见下）。
         */
        live?: boolean;
        /**
         * 勾选集合。**只用来回答"这张会不会被处理"**（没选中的不该说"排队"）。
         * ⚠️ 不要拿它推 `pending`：那就是 2026-11-14 修掉的那个假象。
         */
        selected?: ReadonlySet<string>;
    },
): CoverItem[] {
    /**
     * 区分**站点抓取行**与**本地抽帧行**：
     *   - 站点命中（status === 'ok' 且有 coverUrl）：优先级最高（官方封面优于截帧）
     *   - 本地抽帧（frame === true 且有 frameFile）：作为兜底与有效封面
     *   - 即使站点重搜失败（no-match / blocked / error），**绝不能覆盖和冲掉已有的本地帧**！
     *     冲掉就会让卡片倒退回 miss，诱导用户重复抽帧（多抽的根因）。
     */
    const siteOf = new Map<string, GrabRowLike>();
    const frameOf = new Map<string, GrabRowLike>();
    for (const r of grabRows) {
        if (r.frame) frameOf.set(r.writeRel, r);
        else siteOf.set(r.writeRel, r);
    }
    const applyOf = new Map<string, ApplyRowLike>();
    for (const r of applyRows) {
        /**
         * ⚠️ **成功是终态**：同一个 writeRel 后来即使又出现一行失败，也不许把"已写入"改回去。
         *
         * `applyRows` 的顺序是「本地累积的已写入（ok:true）」在前、「当前 job 的行」在后，
         * 直接 `set` 会让后到的失败行覆盖掉先前的事实 —— 用户看到的就是
         * "明明写成功了，卡上又变回未写入"。
         */
        if (applyOf.get(r.writeRel)?.ok) continue;
        applyOf.set(r.writeRel, r);
    }
    const inflight = opts.inflight;

    const cards = new Map<string, CoverItem>();
    for (const t of targets) {
        const key = cardKeyOf(t);
        const existing = cards.get(key);
        if (existing) {
            if (!existing.writeRels.includes(t.writeRel)) existing.writeRels.push(t.writeRel);
            continue;
        }
        cards.set(key, {
            key,
            kind: t.kind,
            title: t.kind === 'file' ? (t.query ?? t.name)
                : t.kind === 'cover' ? (t.query || t.name) : t.name,
            path: t.dir,
            kindText: kindTextOf(t.kind, 1),
            writeRels: [t.writeRel],
            state: 'idle',
            badge: '',
            coverUrl: null,
        });
    }

    for (const card of cards.values()) {
        const rels = card.writeRels;
        /**
         * 这张卡的写入结果。
         *
         * ⚠️ 不能写成 `rels.map(...).find(Boolean)` —— 那**只看第一个**分卷：
         * 一部片 8 个分卷里第 1 个失败、其余 7 个成功，就会被判成"写入失败"，
         * 反过来第 1 个成功、后面全失败却显示"已写入"。两个方向都是错的。
         * 正确口径：任一分卷写成功 = 这张卡有封面了（一张脸写进哪个分卷目录都算写入）；
         * 全部失败才算失败。
         */
        const applyRowsOfCard = rels
            .map(r => applyOf.get(r))
            .filter((r): r is ApplyRowLike => !!r);
        const applied = applyRowsOfCard.length
            ? (applyRowsOfCard.some(r => r.ok) ? applyRowsOfCard.find(r => r.ok)! : applyRowsOfCard[0])
            : undefined;

        const siteHits = rels.map(r => siteOf.get(r)).filter(Boolean) as GrabRowLike[];
        const frameHits = rels.map(r => frameOf.get(r)).filter(Boolean) as GrabRowLike[];

        const bestSiteHit = siteHits.find(g => g.status === 'ok' && !!g.coverUrl);
        const bestFrameHit = frameHits.find(g => g.status === 'ok' && g.frame === true && !!g.frameFile);
        const latestSiteRow = siteHits[siteHits.length - 1];
        const latestFrameRow = frameHits[frameHits.length - 1];

        /**
         * **只认后端报的"在飞"，不推断**。
         *
         * 旧实现是 `live && selected && 没有结果行` ⇒ 所有选中又还没出结果的卡一起点亮。
         * 两件坏事叠在一起：① 几十张卡同时转圈，"到底在抓谁"看不出来（主人 2026-11-14 报的）；
         * ② `DotField` 虽然共享同一个 rAF，但每帧要遍历所有在场重绘 —— 40 个场 vs 3 个场，
         *    每帧绘制量差十几倍，在弱机上就是可感的掉帧。
         */
        const isInflight = !!inflight && rels.some(r => inflight.has(r));

        /** 把一张帧行挂到卡上（三处都用它，不三写） */
        const holdFrame = (row: GrabRowLike) => {
            card.frame = {
                file: row.frameFile!,
                pct: row.pct ?? 1,
                attempt: row.attempt ?? 0,
                skipped: row.skipped ?? 0,
            };
        };

        if (applied) {
            card.state = applied.ok ? 'written' : 'writefail';
            card.badge = applied.ok ? '已写入' : '写入失败';
            if (!applied.ok) card.note = applied.message;
            if (bestSiteHit?.coverUrl) card.coverUrl = bestSiteHit.coverUrl;
            card.site = bestSiteHit?.hitSite ?? undefined;
            if (bestFrameHit?.frameFile) holdFrame(bestFrameHit);
        } else if (isInflight) {            /**
             * 正在请求 —— **优先于所有"已有结果"**。
             *
             * 这张卡手上可能还压着上一次的帧或站点图（换封面、重抓、补抓都会）。
             * 不盖住的话，用户点了「开始抓取」却看不到它有任何反应 —— 那正是
             * 「有抽帧缓存的卡片不显示 loading」这条 BUG 的成因。
             * 图**保留**（点阵叠在上面转），抓完自然换成新图。
             */
            card.state = 'pending';
            card.badge = '';
            if (bestSiteHit?.coverUrl) card.coverUrl = bestSiteHit.coverUrl;
            if (bestFrameHit?.frameFile) holdFrame(bestFrameHit);
        } else if (bestSiteHit?.coverUrl) {
            // ① 站点封面命中（优先级最高）
            card.coverUrl = bestSiteHit.coverUrl;
            card.state = 'ok';
            /**
             * badge 只说**状态**：这张有图了、可以写，但**还没进盘**。
             * 以前这里写站点名（javbus），读起来像"已经完成了" —— 它其实只是来源。
             * 一个位置只承载一个维度：来源/档位全部进悬停详情（见 `site`）。
             */
            card.badge = '待写入';
            card.site = bestSiteHit.hitSite ?? undefined;
        } else if (bestFrameHit && bestFrameHit.frameFile) {
            // ② 本地抽帧封面（即使后续抓取为 no-match/error，也安全保留抽帧成果）
            holdFrame(bestFrameHit);
            card.state = 'ok';
            /**
             * 抽帧的帧是**系统盘缓存**，不等于已进盘 ⇒ 和站点封面一样报「待写入」。
             *
             * ⚠️ 这条正是主人反复提醒的冲突点：帧缓存会留着（下次打开还能看到同一张图），
             * 所以卡上看起来"已经有封面了"；但盘上其实什么都没有。写「待写入」才说得清，
             * 写「抽帧 · 30%」只说明图的出处，读者会自动理解成"搞定了"。
             * 档位和跳过次数都是"这张图怎么来的"，进悬停。
             */
            card.badge = '待写入';
            // 右下角那颗常驻小胶囊只放得下短词；"跳过几张纯色"这种细节留给悬停
            card.site = `抽帧 ${bestFrameHit.pct ?? 1}%`;
        } else if (latestFrameRow && latestFrameRow.status !== 'ok') {
            // ③ 最近一次抽帧尝试失败
            card.state = 'error';
            card.badge = latestFrameRow.why === 'no-video' ? '无视频' : '抽帧失败';
            card.note = latestFrameRow.message;
        } else if (latestSiteRow) {
            // ④ 最近一次站点抓取失败或被拦
            card.note = latestSiteRow.message;
            card.site = latestSiteRow.blockedSite ?? latestSiteRow.hitSite ?? undefined;
            if (latestSiteRow.status === 'blocked') {
                card.state = 'blocked';
                card.badge = '被拦';
            } else if (latestSiteRow.status === 'bad-cover') {
                card.state = 'error';
                card.badge = '封面取不到';
            } else if (latestSiteRow.status === 'no-id') {
                card.state = 'noid';
                card.badge = '认不出番号';
            } else if (latestSiteRow.status === 'no-match') {
                card.state = 'miss';
                card.badge = '未找到';
            } else {
                card.state = 'error';
                card.badge = '抓取失败';
            }
        } else {
            /**
             * ⑤ 还没轮到。
             *
             * 状态仍是 `idle`（**不转圈** —— 转了就是骗人），但用 badge 明说「排队」。
             * 之前试过右下角一个小灰点：太弱，"读完还是看不出有什么区别"（主人 2026-11-14）。
             * 现在一个位置只放一个词，四种状态（排队 / 待写入 / 已写入 / 失败）互斥且齐全。
             */
            card.state = 'idle';
            if (opts.live && rels.some(r => opts.selected?.has(r))) card.badge = '排队';
        }

        card.kindText = kindTextOf(card.kind, rels.length);
    }

    return [...cards.values()];
}

export interface CoverCounts {
    total: number;
    selected: number;
    /** 抓到但还没写进盘的部数（写入按钮按它显示） */
    ready: number;
    written: number;
    blocked: number;
    missed: number;
    failed: number;
}

export function summarize(items: CoverItem[], selected: Set<string>): CoverCounts {
    const has = (s: CoverState) => items.filter(i => i.state === s).length;
    return {
        total: items.length,
        selected: items.filter(i => i.writeRels.some(r => selected.has(r))).length,
        ready: items.filter(i => i.state === 'ok' && i.writeRels.some(r => selected.has(r))).length,
        written: has('written'),
        blocked: has('blocked'),
        missed: has('miss') + has('noid'),
        failed: has('error') + has('writefail'),
    };
}

/** 卡片右上角那个动作位现在该做什么 —— **模板不许自己判**，判据只在这里 */
export type CoverAction = 'frame' | 'reframe' | 'none';

/** 阶梯末档（与 `frameMath.ts` 的 PCT_LADDER 末位同值）。到这儿就不再往后了 */
export const FRAME_STOP_PCT = 50;

/**
 * 一张卡右上角能做什么。
 *
 * · 已经有脸（站点或帧）⇒ 只有帧能「换一帧」；站点封面不给抽帧入口（否则等于把好封面顶掉）
 * · 没有脸（未找到 / 认不出 / 抓取失败 / 被拦）⇒ 给「抽帧」
 * · 已写入、正在抽 ⇒ 什么都不给（点了没效果的事，不如不出现）
 *
 * ⚠️ 到阶梯末档**仍然返回 `reframe`**，由卡片渲染成"禁用 + 已到中段" ——
 *    直接返回 `none` 会让按钮凭空消失，用户分不清是到顶了还是坏了。
 */
export function actionOf(item: CoverItem, busy: ReadonlySet<string> = new Set()): CoverAction {
    if (item.writeRels.some(r => busy.has(r))) return 'none';
    if (item.state === 'written' || item.state === 'writefail') return 'none';
    if (item.frame) return 'reframe';
    return item.state === 'miss' || item.state === 'noid' || item.state === 'error' || item.state === 'blocked'
        ? 'frame'
        : 'none';
}

export type CoverDockMode =
    | 'idle' | 'grab' | 'grab-pause' | 'apply' | 'grab-done' | 'apply-done'
    | 'frame' | 'frame-pause' | 'frame-done';
export interface CoverTask {
    mode: CoverDockMode;
    phase: 'idle' | 'run' | 'pause' | 'done';
    ratio: number;
    status: string;
    detail: string;
}

const ratioOf = (job: JobSnapshot) =>
    job.progress.total ? job.progress.processed / job.progress.total : 0;

/**
 * 底栏三个阶段的文案与进度。
 * `stopped` 由调用方给（job.status === 'cancelled'）—— 终止和跑完是两句话，
 * 说错会让用户以为跑成功了。
 */
export function buildCoverTask(
    grab: JobSnapshot | null,
    frame: JobSnapshot | null,
    apply: JobSnapshot | null,
    counts: CoverCounts,
    /** 排队中（还没轮到）的部数。只喂运行态那句详情，别的地方不读它 */
    queued = 0,
): CoverTask {
    const applying = apply?.status === 'running' || apply?.status === 'paused';
    const grabbing = grab?.status === 'running' || grab?.status === 'paused';
    const framing = frame?.status === 'running' || frame?.status === 'paused';

    if (applying && apply) {
        return {
            mode: 'apply',
            phase: 'run',
            ratio: ratioOf(apply),
            status: `写入中 ${apply.progress.processed} / ${apply.progress.total}`,
            detail: '覆盖前先把原图备份到数据目录',
        };
    }

    // 抽帧优先于抓取展示：抽帧是用户刚点的、且每次只有一两部，进度条不该被别的盖上
    if (framing && frame) {
        // 自动跳过纯色的次数从行里汇总 —— 用户要知道"为什么这一张比上次靠后"
        const skipped = (frame.rows as { skipped?: number }[]).reduce((n, r) => n + (r.skipped ?? 0), 0);
        if (frame.status === 'paused') {
            return {
                mode: 'frame-pause',
                phase: 'pause',
                ratio: ratioOf(frame),
                status: `已暂停 ${frame.progress.processed} / ${frame.progress.total}`,
                detail: '当前这一部抽完即停',
            };
        }
        return {
            mode: 'frame',
            phase: 'run',
            ratio: ratioOf(frame),
            status: `抽帧中 ${frame.progress.processed} / ${frame.progress.total}`,
            detail: skipped ? `已自动跳过 ${skipped} 张纯色帧` : '从片头 1% 处取帧',
        };
    }

    if (grabbing && grab) {
        const { processed, total, hits, blocked, misses } = grab.progress;
        if (grab.status === 'paused') {
            return {
                mode: 'grab-pause',
                phase: 'pause',
                ratio: ratioOf(grab),
                status: `已暂停 ${processed} / ${total}`,
                detail: '在飞的几条跑完即停，结果都留着',
            };
        }
        return {
            mode: 'grab',
            phase: 'run',
            ratio: ratioOf(grab),
            status: `抓取中 ${processed} / ${total}`,
            // 「排队」放在最后：它是唯一一个**还没发生**的计数，读的时候该落在末尾
            detail: `命中 ${hits} · 被拦 ${blocked} · 未找到 ${misses}${queued ? ` · 排队 ${queued}` : ''}`,
        };
    }

    if (apply?.status === 'cancelled') {
        return {
            mode: 'apply-done',
            phase: 'done',
            ratio: ratioOf(apply),
            status: `写入已终止 ${counts.written} 部已写入`,
            detail: '已落盘的不会回滚，剩下的可再写一次',
        };
    }

    if (apply) {
        return {
            mode: 'apply-done',
            phase: 'done',
            ratio: 1,
            status: `写入完成 ${counts.written} 部`,
            detail: counts.failed ? `失败 ${counts.failed} 部，其余已写入` : '全部写入成功',
        };
    }

    if (grab?.status === 'cancelled') {
        return {
            mode: 'grab-done',
            phase: 'done',
            ratio: ratioOf(grab),
            status: `已终止 ${grab.progress.hits} / ${grab.progress.total} 命中`,
            detail: '停在你按下的那一刻，已抓到的封面都留着',
        };
    }

    if (grab) {
        return {
            mode: 'grab-done',
            phase: 'done',
            ratio: 1,
            status: `抓取结束 ${grab.progress.hits} / ${grab.progress.total} 命中`,
            detail: counts.blocked + counts.missed + counts.failed
                ? `没抓到 ${counts.blocked + counts.missed + counts.failed} 部（被拦的可以人工过验证）`
                : '全部命中',
        };
    }

    // 抽帧的终点排在站点抓取之后：同一批里两者都结束时，"补抓 / 过验证"那两个按钮
    // 比"抽帧结束"更需要出现在底栏（抽帧结果本来就已经长在卡上了）。
    if (frame?.status === 'cancelled') {
        return {
            mode: 'frame-done',
            phase: 'done',
            ratio: ratioOf(frame),
            status: `抽帧已终止 ${frame.progress.hits} / ${frame.progress.total} 有封面`,
            detail: '已抽到的帧都留在卡上，写入后才会进盘',
        };
    }

    if (frame?.status === 'error') {
        return {
            mode: 'frame-done',
            phase: 'done',
            ratio: ratioOf(frame),
            status: `抽帧中断 ${frame.progress.processed} / ${frame.progress.total}`,
            detail: frame.message || '抽帧没跑完，已经抽到的都留在卡上',
        };
    }

    if (frame) {
        const bad = frame.progress.total - frame.progress.hits;
        return {
            mode: 'frame-done',
            phase: 'done',
            ratio: 1,
            status: `抽帧结束 ${frame.progress.hits} / ${frame.progress.total} 有封面`,
            detail: bad ? `${bad} 部抽不出（没有视频 / 取不到画面）` : '全部抽到了，可以写入',
        };
    }

    return {
        mode: 'idle',
        phase: 'idle',
        ratio: 0,
        status: `已选 ${counts.selected} / ${counts.total} 部`,
        detail: '抓到后封面直接落在这张卡上，再点写入才进盘',
    };
}
