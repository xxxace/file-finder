/**
 * 管理助手 · 长任务注册表（job 化）
 * ===========================================================================
 * 对应 PRD D5：前端 `fetch` 没有超时，一个抓取批次可能跑几分钟
 * （几十条 × 每条约 3–30 秒）。**单请求挂死**是这个模块最容易出的故障形态，
 * 所以长任务一律拆成三段：
 *
 *     POST /assistant/jobs   → 立刻返回 { jobId }（起任务）
 *     GET  /assistant/jobs   → 轮询进度/结果（读快照）
 *     DELETE /assistant/jobs → 取消（软取消：不打断已经发出去的请求，
 *                              但后面的条目不再开始 —— 和扫描入口的取消语义一致）
 *
 * 三件事必须是这样：
 *   1. **纯内存**。job 是"这一次会话的进度"，不是数据 —— 落盘反而要处理
 *      "上次没跑完的 job 怎么办"，那是另一套状态机，MVP 不需要。
 *   2. **快照与内部对象分离**。内部 Job 带 `controller`（AbortController），
 *      JSON.stringify 会把它序列化成一坨没用的东西；必须只下发白名单字段。
 *   3. **有上限**。跑完的 job 留在 Map 里供轮询，但不能无限涨 —— 超过上限就淘汰最老的。
 */
import { randomUUID } from 'node:crypto';

export type JobKind = 'grab' | 'challenge' | 'apply';
export type JobStatus = 'running' | 'done' | 'cancelled' | 'error';

export interface JobProgress {
    total: number;
    processed: number;
    hits: number;
    misses: number;
    blocked: number;
    /** 当前正在处理什么，给前端做"实时行"用；空串表示没在跑 */
    current: string;
}

export interface Job<Row = unknown> {
    id: string;
    kind: JobKind;
    status: JobStatus;
    progress: JobProgress;
    rows: Row[];
    /** 一句话结果 / 失败原因（面向用户，前端直接显示） */
    message: string;
    startedAt: number;
    endedAt: number | null;
    /** 软取消标记。grab 循环每处理一条都检查它 */
    cancelled: boolean;
    /** 给 enqueue / runExtract 用的取消信号 */
    controller: AbortController;
}

/** 跑完的 job 最多留这么多条。轮询是秒级的，20 条足够覆盖任何界面停留时间 */
const MAX_KEPT = 20;

const JOBS = new Map<string, Job>();

function sweep(): void {
    if (JOBS.size < MAX_KEPT) return;
    // 只淘汰**已结束**的，按开始时间从老到新。还在跑的一条都不能动。
    const finished = [...JOBS.values()]
        .filter(j => j.status !== 'running')
        .sort((a, b) => a.startedAt - b.startedAt);
    while (JOBS.size >= MAX_KEPT && finished.length) {
        const victim = finished.shift()!;
        JOBS.delete(victim.id);
    }
}

export function createJob<Row = unknown>(kind: JobKind, total = 0): Job<Row> {
    sweep();
    const job: Job<Row> = {
        id: randomUUID(),
        kind,
        status: 'running',
        progress: { total, processed: 0, hits: 0, misses: 0, blocked: 0, current: '' },
        rows: [],
        message: '',
        startedAt: Date.now(),
        endedAt: null,
        cancelled: false,
        controller: new AbortController(),
    };
    JOBS.set(job.id, job as Job);
    return job;
}

export function getJob(id: string): Job | undefined {
    return JOBS.get(id);
}

export function listJobs(): Job[] {
    return [...JOBS.values()].sort((a, b) => b.startedAt - a.startedAt);
}

/**
 * 软取消。返回 false 表示"这个 job 不存在或已经结束了"——
 * 前端据此提示"任务已经结束"，而不是假装取消成功。
 *
 * 顺带立刻 abort：`runExtract` 会在信号上挂监听销毁隐藏窗，
 * 所以取消是**立即**的，不用等当前那条跑完（PRD §6："当前这条处理完就停"是
 * 前端文案的保守说法；能做到立即停就不该让用户白等）。
 */
export function cancelJob(id: string): boolean {
    const job = JOBS.get(id);
    if (!job || job.status !== 'running') return false;
    job.cancelled = true;
    job.controller.abort();
    return true;
}

export function bumpProgress(job: Job, patch: Partial<JobProgress>): void {
    Object.assign(job.progress, patch);
}

export function pushRow<Row>(job: Job<Row>, row: Row): void {
    job.rows.push(row);
}

export function finishJob(job: Job, status: Exclude<JobStatus, 'running'>, message = ''): void {
    if (job.status !== 'running') return;
    job.status = status;
    job.message = message;
    job.progress.current = '';
    job.endedAt = Date.now();
}

/** 下发用白名单视图 —— **绝不**把内部对象直接 sendJson 出去 */
export function snapshotJob(job: Job): Record<string, unknown> {
    return {
        id: job.id,
        kind: job.kind,
        status: job.status,
        progress: { ...job.progress },
        rows: job.rows,
        message: job.message,
        startedAt: job.startedAt,
        endedAt: job.endedAt,
    };
}
