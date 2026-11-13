/**
 * 任务视图的公共形状。
 *
 * 后端的 job 快照在这里只留**前端真会读的字段** —— 不直接引 `electron/server` 的
 * 类型：那样服务端改一个字段名，界面的类型检查会跟着红，而这两件事本来不该耦合。
 * 行类型用结构化最小集（`GrabRowLike` / `ApplyRowLike`），服务端多给字段一律忽略。
 */

export type JobStatus = 'running' | 'paused' | 'done' | 'cancelled' | 'error';

export interface JobProgress {
    total: number;
    processed: number;
    hits: number;
    misses: number;
    blocked: number;
    /** 当前正在处理什么（相对路径）；空串 = 没在跑 */
    current: string;
}

export interface JobSnapshot<Row = unknown> {
    id: string;
    kind: string;
    status: JobStatus;
    progress: JobProgress;
    rows: Row[];
    /**
     * 此刻**真正在飞**的目标（`writeRel`）。界面靠它决定"哪几张卡转圈"。
     *
     * ⚠️ 别用 `progress.current` 代替：那是单个字符串，并发时表达不了"这三张同时在请求"。
     * ⚠️ 也别用"选中且还没结果"来推断：那会把几十张排队中的卡一起点亮，
     * 既是假象、又要几十个 Canvas 同时跑 rAF（2026-11-14 两件事一起修）。
     */
    inflight?: string[];
    message: string;
}

/** 跑着或暂停着 —— 轮询在这两种状态都不停（暂停中用户随时会点「继续」） */
export const isLiveJob = (job: JobSnapshot | null | undefined): boolean =>
    job?.status === 'running' || job?.status === 'paused';
