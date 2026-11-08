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
    status: 'ok' | 'no-id' | 'no-match' | 'blocked' | 'error';
    coverUrl: string | null;
    hitSite?: string | null;
    /** 被哪个站点拦的（「人工过验证」要按站点开窗） */
    blockedSite?: string;
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
    opts: { live: boolean; selected: Set<string> },
): CoverItem[] {
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
            title: t.kind === 'file' ? `${t.query ?? t.name}/`
                : t.kind === 'cover' ? (t.query || t.name) : `${t.name}/`,
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
        const grabbed = grabs.find(g => g.status === 'ok');

        if (grabbed?.coverUrl) card.coverUrl = grabbed.coverUrl;

        if (applied) {
            card.state = applied.ok ? 'written' : 'writefail';
            card.badge = applied.ok ? '已写入' : '写入失败';
        } else if (!grabs.length) {
            const waiting = opts.live && rels.some(r => opts.selected.has(r));
            card.state = waiting ? 'pending' : 'idle';
        } else if (grabbed) {
            card.state = 'ok';
            card.badge = grabbed.hitSite || '已抓到';
        } else if (grabs.some(g => g.status === 'blocked')) {
            card.state = 'blocked';
            card.badge = '被拦';
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

export type CoverDockMode = 'idle' | 'grab' | 'grab-pause' | 'apply' | 'grab-done' | 'apply-done';

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
    apply: JobSnapshot | null,
    counts: CoverCounts,
): CoverTask {
    const applying = apply?.status === 'running' || apply?.status === 'paused';
    const grabbing = grab?.status === 'running' || grab?.status === 'paused';

    if (applying && apply) {
        return {
            mode: 'apply',
            phase: 'run',
            ratio: ratioOf(apply),
            status: `写入中 ${apply.progress.processed} / ${apply.progress.total}`,
            detail: '覆盖前先把原图备份到数据目录',
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

    return {
        mode: 'idle',
        phase: 'idle',
        ratio: 0,
        status: `已选 ${counts.selected} / ${counts.total} 部`,
        detail: '抓到后封面直接落在这张卡上，再点写入才进盘',
    };
}
