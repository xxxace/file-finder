/**
 * 管理助手 · 长任务注册表（job 化）
 * ===========================================================================
 * 对应 PRD D5：前端 `fetch` 没有超时，一个抓取批次可能跑几分钟
 * （几十条 × 每条约 3–30 秒）。**单请求挂死**是这个模块最容易出的故障形态，
 * 所以长任务一律拆成三段：
 *
 *     POST /assistant/jobs   → 立刻返回 { jobId }（起任务）
 *     POST /assistant/jobs?id=&act=pause|resume → 暂停 / 继续
 *     GET  /assistant/jobs   → 轮询进度/结果（读快照）
 *     DELETE /assistant/jobs → 终止（abort 在飞请求；**已经拿到的结果全部保留**）
 *
 * 「暂停」与「终止」的分界（2026-10-22）：暂停 = 不再取新条目、在飞的跑完，
 * 队列原地停住可继续；终止 = 立刻中断，但已产出的行照样留在 `rows` 里供写入。
 * 两者都**不能丢结果** —— 丢了就等于让用户白等一轮。
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
export type JobStatus = 'running' | 'paused' | 'done' | 'cancelled' | 'error';

export interface JobProgress {
    total: number;
    processed: number;
    hits: number;
    misses: number;
    blocked: number;
    /** 当前正在处理什么，给前端做"实时行"用；空串表示没在跑 */
    current: string;
}

/**
 * 暂停闸门。worker 每取一条之前 `await gate.wait()` —— 暂停时挂在这里，
 * `resume()` / `cancelJob()` 放行。
 *
 * ⚠️ 为什么不是「取消 + 重跑一遍」：抓取是逐条出结果的，重跑等于把已经拿到的
 * 封面全丢掉（2026-10-22 用户反馈的核心问题）。暂停必须让队列**原地停住**。
 * ⚠️ 终止也必须 `resume()`：否则卡在闸门上的 worker 永不返回，`Promise.all`
 * 不 resolve ⇒ job 永远停在 running，前端一直转圈。
 */
class Gate {
    private paused = false;
    private waiters: (() => void)[] = [];

    pause(): void {
        this.paused = true;
    }

    resume(): void {
        this.paused = false;
        const w = this.waiters;
        this.waiters = [];
        for (const fn of w) fn();
    }

    async wait(): Promise<void> {
        if (!this.paused) return;
        await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
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
    /** 软取消标记。worker 每处理一条都检查它 */
    cancelled: boolean;
    /** 给 enqueue / runExtract 用的取消信号 */
    controller: AbortController;
    /** 暂停闸门：worker 在取每一条之前等它 */
    gate: Gate;
}

/** 跑完的 job 最多留这么多条。轮询是秒级的，20 条足够覆盖任何界面停留时间 */
const MAX_KEPT = 20;

const JOBS = new Map<string, Job>();

function sweep(): void {
    if (JOBS.size < MAX_KEPT) return;
    // 只淘汰**已结束**的，按开始时间从老到新。还在跑或暂停中的一条都不能动
    // （暂停中的 job 下一秒就可能被「继续」，淘汰它等于把结果删了）。
    const finished = [...JOBS.values()]
        .filter(j => j.status !== 'running' && j.status !== 'paused')
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
        gate: new Gate(),
    };
    JOBS.set(job.id, job as Job);
    return job;
}

/**
 * 取 job。泛型只为调用方少写断言 —— Map 里存的是同一个对象，
 * 真正决定 `rows` 形状的是**创建它的那个 kind**（grab / apply）。
 */
export function getJob<Row = unknown>(id: string): Job<Row> | undefined {
    return JOBS.get(id) as Job<Row> | undefined;
}

export function listJobs(): Job[] {
    return [...JOBS.values()].sort((a, b) => b.startedAt - a.startedAt);
}

/**
 * 暂停：不再开始新条目，**在飞的请求不打断**（跑完即记入结果），队列原地停住。
 * 返回 false = 这个 job 不存在 / 已经停了 —— 前端据此提示，而不是假装暂停成功。
 */
export function pauseJob(id: string): boolean {
    const job = JOBS.get(id);
    if (!job || job.status !== 'running') return false;
    job.status = 'paused';
    job.gate.pause();
    job.progress.current = '';
    return true;
}

/** 继续：放行闸门，从暂停处接着跑（已产出的行、剩余队列都还在） */
export function resumeJob(id: string): boolean {
    const job = JOBS.get(id);
    if (!job || job.status !== 'paused') return false;
    job.status = 'running';
    job.gate.resume();
    return true;
}

/**
 * 终止。`cancelled` 让 worker 不再取新条目、`abort` 立刻销毁在飞窗口。
 *
 * ⚠️ **已经产出的 `rows` 一个字都不删**：用户点终止时最关心"抓到的那些还算不算"，
 * 所以 `finishJob` 之后前端照样能拿这些行去写入（`startApply` 只挡 running）。
 */
export function cancelJob(id: string): boolean {
    const job = JOBS.get(id);
    if (!job || (job.status !== 'running' && job.status !== 'paused')) return false;
    job.cancelled = true;
    job.gate.resume(); // 放行卡在闸门上的 worker，让它看到 cancelled 后退出
    job.controller.abort();
    return true;
}

/**
 * 重新打开一个已结束的 job，好让新一批目标**追加到同一个结果表**里。
 *
 * 为什么必须复用同一个 job（而不是起个新的）：结果是按 `job.rows` 发布的 ——
 * 起新 job 等于把原来命中/失败的行整批丢掉（「过验证后重抓被拦项」曾经就丢过一次）。
 * `controller` 必须换新的：abort 过的 signal 永远处于 aborted，复用它会让新一批
 * 一发起就判成取消。
 */
export function reopenJob<Row>(job: Job<Row>): void {
    job.status = 'running';
    job.cancelled = false;
    job.endedAt = null;
    job.gate.resume();
    job.controller = new AbortController();
}

export function bumpProgress(job: Job, patch: Partial<JobProgress>): void {
    Object.assign(job.progress, patch);
}

export function pushRow<Row>(job: Job<Row>, row: Row): void {
    job.rows.push(row);
}

export function finishJob(job: Job, status: Exclude<JobStatus, 'running' | 'paused'>, message = ''): void {
    // ⚠️ `paused` 也算"还没收尾"：从暂停态直接终止时，这里若只放行 running，
    // job 会永远停在 paused（前端一直显示"已暂停"，写入/重扫全被 busy 挡住）。
    if (job.status !== 'running' && job.status !== 'paused') return;
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
