/**
 * 头像回收 · 视图模型
 *
 * 与 coverModel 同样是"状态翻译层"：扫描结果 + 匹配结果 + 写入结果 → 行数组。
 * 匹配现在是**前端逐条推进**的（服务端只出候选），所以这一层还要管
 * "谁正在匹配"，那是底栏与点阵唯一的真相源。
 */

export type AvatarState = 'pending' | 'matching' | 'matched' | 'miss' | 'written' | 'writefail';

export interface AvatarRow {
    relDir: string;
    folderName: string;
    cleanName: string;
    matchedName: string | null;
    avatarUrl: string | null;
    source?: 'javbus' | 'gfriends';
    state: AvatarState;
    selected: boolean;
    /** 手动填的图片地址（行内「换图」用） */
    manualUrl: string;
    /** 失败原因 / 说明，空串 = 没有 */
    message: string;
}

export interface MatchState {
    /** 跑着或暂停着 */
    live: boolean;
    paused: boolean;
    /** 被用户终止过（与"跑完"分开说） */
    stopped: boolean;
    done: number;
    total: number;
}

const STATE_TEXT: Record<AvatarState, { text: string; tone: '' | 'is-ok' | 'is-warn' | 'is-err' }> = {
    pending: { text: '待匹配', tone: '' },
    matching: { text: '匹配中', tone: '' },
    matched: { text: '已匹配', tone: 'is-ok' },
    miss: { text: '未找到', tone: 'is-warn' },
    written: { text: '已写入', tone: 'is-ok' },
    writefail: { text: '写入失败', tone: 'is-err' },
};

export const stateText = (state: AvatarState) => STATE_TEXT[state].text;
export const stateTone = (state: AvatarState) => STATE_TEXT[state].tone;

/** 可写入的行：有图、且用户勾了 */
export const selectedWithImage = (rows: AvatarRow[]) =>
    rows.filter(r => r.selected && !!r.avatarUrl);

export interface AvatarCounts {
    total: number;
    matched: number;
    selected: number;
    written: number;
    failed: number;
}

export function countRows(rows: AvatarRow[]): AvatarCounts {
    return {
        total: rows.length,
        matched: rows.filter(r => r.state === 'matched' || r.state === 'written').length,
        selected: selectedWithImage(rows).length,
        written: rows.filter(r => r.state === 'written').length,
        failed: rows.filter(r => r.state === 'writefail').length,
    };
}

export type AvatarDockMode = 'idle' | 'match' | 'match-pause' | 'apply' | 'match-done' | 'apply-done';

export interface AvatarTask {
    mode: AvatarDockMode;
    phase: 'idle' | 'run' | 'pause' | 'done';
    ratio: number;
    status: string;
    detail: string;
}

/**
 * 底栏文案。三段：匹配（前端推进）/ 写入（后台 job）/ 结束。
 * 匹配和写入分开说 —— 它们的"卡在哪"完全不同（网络查询 vs 写盘）。
 */
export function buildAvatarTask(
    match: MatchState,
    apply: { status: string; processed: number; total: number } | null,
    counts: AvatarCounts,
): AvatarTask {
    if (apply?.status === 'running' || apply?.status === 'paused') {
        return {
            mode: 'apply',
            phase: 'run',
            ratio: apply.total ? apply.processed / apply.total : 0,
            status: `写入中 ${apply.processed} / ${apply.total}`,
            detail: '8 并发下载 + 转码，旧头像备份后原子替换',
        };
    }

    if (match.live) {
        return match.paused
            ? {
                mode: 'match-pause',
                phase: 'pause',
                ratio: match.total ? match.done / match.total : 0,
                status: `已暂停 ${match.done} / ${match.total}`,
                detail: '队列原地停住，点继续接着跑',
            }
            : {
                mode: 'match',
                phase: 'run',
                ratio: match.total ? match.done / match.total : 0,
                status: `正在匹配 ${match.done} / ${match.total}`,
                detail: '逐条查站点，命中一行就地变绿',
            };
    }

    if (apply?.status === 'cancelled') {
        return {
            mode: 'apply-done',
            phase: 'done',
            ratio: apply.total ? apply.processed / apply.total : 0,
            status: `写入已终止 ${counts.written} 个已写入`,
            detail: '已落盘的不会回滚，剩下的可再写一次',
        };
    }

    if (apply) {
        return {
            mode: 'apply-done',
            phase: 'done',
            ratio: 1,
            status: `写入完成 ${counts.written} 个`,
            detail: counts.failed ? `失败 ${counts.failed} 个，可重试` : '全部写入成功，缓存已同步',
        };
    }

    if (match.total && !match.live) {
        if (match.stopped) {
            return {
                mode: 'match-done',
                phase: 'done',
                ratio: match.total ? match.done / match.total : 0,
                status: `匹配已终止 ${counts.matched} 命中`,
                detail: '已匹配的结果留着，剩余的可再点一次开始匹配',
            };
        }
        return {
            mode: 'match-done',
            phase: 'done',
            ratio: 1,
            status: `匹配结束 ${counts.matched} / ${match.total} 命中`,
            detail: counts.matched ? '勾选要写入的，旧头像会自动备份' : '一个都没匹配上，可以改名字或手动填图',
        };
    }

    return {
        mode: 'idle',
        phase: 'idle',
        ratio: 0,
        status: `已选 ${counts.selected} / 已匹配 ${counts.matched}`,
        detail: '写入 avatar.jpg，旧头像自动备份',
    };
}
