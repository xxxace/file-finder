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
    opts: { live: boolean; selected: Set<string>; frameBusy?: ReadonlySet<string> },
): CoverItem[] {
    /**
     * ⚠️ 同一个 writeRel 出现多行时**最后一条说了算**。
     * 「换一帧」就是把同一张卡的新一帧追加进同一个 job —— 取 `find(ok)` 会一直显示第一帧，
     * 用户点十次都觉得没生效。抓取端补抓（被拦 → 过验证 → 重抓）同理：后一条更准。
     */
    const grabOf = new Map<string, GrabRowLike>();
    for (const r of grabRows) grabOf.set(r.writeRel, r);
    const applyOf = new Map<string, ApplyRowLike>();
    for (const r of applyRows) applyOf.set(r.writeRel, r);

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
            // ⚠️ 标题就是名字本身：原来给 dir/file 拼了尾部 `/` 当"这是文件夹"的标记，
            //    形态本来就由 kindText（新建 / 裸文件 / 覆盖）在说，这个 `/` 冗余且会把
            //    番号渲染成 `FC2-PPV-1001424/`，像路径片段、像解析错了。它只是显示串：
            //    query / writeRel 从来不带斜杠（番号来自 t.query 或 parseTitle(t.name)）。
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
        const applied = rels.map(r => applyOf.get(r)).find(Boolean);
        const grabs = rels.map(r => grabOf.get(r)).filter(Boolean) as GrabRowLike[];
        /** 这张卡最新一条"真正拿到了封面"的行：站点链接或本地帧，二选一 */
        const grabbed = grabs.find(g => g.status === 'ok' && (!!g.coverUrl || (g.frame === true && !!g.frameFile)));

        if (grabbed?.coverUrl) card.coverUrl = grabbed.coverUrl;
        if (grabbed?.frame && grabbed.frameFile) {
            card.frame = {
                file: grabbed.frameFile,
                pct: grabbed.pct ?? 1,
                attempt: grabbed.attempt ?? 0,
                skipped: grabbed.skipped ?? 0,
            };
        }

        if (applied) {
            card.state = applied.ok ? 'written' : 'writefail';
            card.badge = applied.ok ? '已写入' : '写入失败';
        } else if (!grabs.length) {
            const waiting = opts.live && rels.some(r => opts.selected.has(r));
            card.state = waiting ? 'pending' : 'idle';
        // 帧行的 `coverUrl` 恒为 null，所以"有没有封面"不能只看 URL ——
        // 只认 URL 会让抽帧结果全掉进 `error`，而 `startApply` 只收 `ok` 的卡（真写不进去）。
        } else if (grabbed && (card.coverUrl || card.frame)) {
            card.state = 'ok';
            card.badge = card.frame
                ? `抽帧 · ${card.frame.pct}%${card.frame.skipped ? ` · 跳过 ${card.frame.skipped}` : ''}`
                : (grabbed.hitSite || '已抓到');
        } else if (grabs.some(g => g.status === 'blocked')) {
            card.state = 'blocked';
            card.badge = '被拦';
        } else if (grabs.some(g => g.status === 'bad-cover')) {
            card.state = 'error';
            card.badge = '封面取不到';
        } else if (grabs.some(g => g.status === 'no-id')) {
            card.state = 'noid';
            card.badge = '认不出番号';
        } else if (grabs.some(g => g.status === 'no-match')) {
            card.state = 'miss';
            card.badge = '未找到';
        } else {
            card.state = 'error';
            card.badge = '抓取失败';
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
            detail: `命中 ${hits} · 被拦 ${blocked} · 未找到 ${misses}`,
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
