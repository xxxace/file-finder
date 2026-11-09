import { computed, ref } from 'vue';
import { API_BASE, postAction } from '@/utils/request';
import type { AvatarRow } from './avatarModel';

/** 站点点名有频率限制，4 并发是稳妥值（原来在服务端也是这个量级） */
const CONCURRENCY = 4;

interface MatchResponse {
    code: number;
    matched: boolean;
    matchedName?: string;
    avatarUrl?: string;
    source?: 'javbus' | 'gfriends';
}

/**
 * 逐条匹配器（前端驱动）。
 *
 * 为什么不在服务端一次跑完：一条要查一次站点，48 个目录就是 1~2 分钟，
 * 而那段黑箱**没有进度、不能暂停、一条失败全等**。放到前端逐条推进后，
 * 进度是真的、暂停是真的（闸门在原地）、单条失败也只影响一行。
 */
export function useAvatarMatcher() {
    const phase = ref<'idle' | 'run' | 'pause'>('idle');
    const total = ref(0);
    const done = ref(0);
    const hits = ref(0);
    /** 被用户终止过（与"跑完"区分，底栏文案不一样） */
    const stopped = ref(false);

    let cursor = 0;
    let cancelled = false;
    let waiters: (() => void)[] = [];
    /**
     * **终止**要真的掐断在飞的 HTTP（否则点了终止还要等 4 条请求跑完才安静）。
     * ⚠️ **暂停不掐**：已经在飞的那几条属于"已经发生了"，让它们跑完并如实记入结果，
     * 暂停只负责"不再发新的"（2026-11-08 主人确认就是这个语义）。
     */
    let inflight: AbortController | null = null;

    const release = () => {
        const list = waiters;
        waiters = [];
        for (const fn of list) fn();
    };

    const wait = () => new Promise<void>(resolve => waiters.push(resolve));

    const live = computed(() => phase.value !== 'idle');
    const paused = computed(() => phase.value === 'pause');

    /** `count=false`：单条重查不参与整批进度（否则底栏数字会莫名往前跳） */
    async function matchOne(
        row: AvatarRow,
        source: 'javbus' | 'gfriends',
        count = true,
        signal?: AbortSignal,
    ): Promise<void> {
        /**
         * ⚠️ 必须先落 `matching` 再发请求。
         * 之前漏了这一行，`state` 从 `pending` 直接跳到 `matched`/`miss` ——
         * 行上的点阵加载（`AvatarRow` 里只在 `matching` 时挂 DotField）**一次都没渲染过**，
         * 整批匹配看起来就是"什么都没发生，然后突然全变绿/变灰"（2026-11-08 主人："匹配时也没动画"）。
         */
        row.state = 'matching';
        row.message = '';
        try {
            const res = (await postAction(
                `${API_BASE}/assistant/avatar/match`,
                { name: row.cleanName, source },
                signal ? { signal } : undefined,
            )) as MatchResponse;

            if (res.code === 200 && res.matched && res.avatarUrl) {
                row.state = 'matched';
                row.matchedName = res.matchedName || row.cleanName;
                row.avatarUrl = res.avatarUrl;
                row.source = res.source;
                row.message = '';
                row.selected = true;
                hits.value += 1;
            } else {
                row.state = 'miss';
                row.matchedName = null;
                row.avatarUrl = null;
                row.source = undefined;
                row.selected = false;
                row.message = '站点没找到这个人';
            }
        } catch (e) {
            if (signal?.aborted) {
                // 被「终止」掐断 ≠ 没找到：退回待匹配，也不计入进度
                row.state = 'pending';
                row.message = '';
                return;
            }
            // 单条失败不拖垮整批：标成未找到，用户可改名字或手动填图再试
            row.state = 'miss';
            row.selected = false;
            row.message = e instanceof Error ? e.message : '匹配请求失败';
        }
        if (count) done.value += 1;
    }

    /** 从第一行开始跑（已匹配的行会被重跑，改名字后想重查就用它） */
    async function run(rows: AvatarRow[], source: 'javbus' | 'gfriends'): Promise<void> {
        if (live.value || !rows.length) return;

        cursor = 0;
        cancelled = false;
        stopped.value = false;
        total.value = rows.length;
        done.value = 0;
        hits.value = 0;
        phase.value = 'run';
        inflight = new AbortController();
        const signal = inflight.signal;

        const worker = async (): Promise<void> => {
            for (;;) {
                if (cancelled) return;
                /**
                 * ⚠️ **先看队列空不空，再等闸门**。反过来写就是死锁：
                 * 最后一条已经取走（或已经跑完）时点「暂停」，worker 会挂在这个 wait 上
                 * 永远不返回 ⇒ `Promise.all` 不 resolve ⇒ 底栏永远停在「已暂停 n/n」，
                 * 明明已经没事可做了（2026-11-08 主人截图：已暂停 1 / 1）。
                 * 同一个坑在 `electron/server/assistant/grab.ts` 里已经写过一遍注释，
                 * 这里是它的第二、三处（还有 `avatarApply.ts`）。
                 */
                if (cursor >= rows.length) return;
                // 暂停闸门：停在取下一行**之前**，继续时从原位置接着跑
                if (phase.value === 'pause') await wait();
                if (cancelled) return;

                const index = cursor++;
                if (index >= rows.length) return;
                await matchOne(rows[index], source, true, signal);
            }
        };

        await Promise.all(Array.from({ length: Math.min(CONCURRENCY, rows.length) }, worker));
        if (!cancelled) phase.value = 'idle';
    }

    /** 单条重查（改了名字 / 手动想再试一次）—— 不动整批进度，返回结果给调用方提示 */
    const rematch = async (row: AvatarRow, source: 'javbus' | 'gfriends'): Promise<AvatarRow['state']> => {
        await matchOne(row, source, false);
        return row.state;
    };

    /**
     * 暂停 = **不再发新的**，在飞的那几条让它跑完并如实记入结果。
     * 刻意不 abort：那几条请求已经打出去了，掐断既浪费也丢结果（2026-11-08 主人确认）。
     */
    function pause(): void {
        if (phase.value === 'run') phase.value = 'pause';
    }

    function resume(): void {
        if (phase.value !== 'pause') return;
        phase.value = 'run';
        release();
    }

    function stop(): void {
        if (!live.value) return;
        cancelled = true;
        stopped.value = true;
        phase.value = 'idle';
        // 掐断在飞的站点请求：不掐的话那几条要跑到底，行上的点阵也一直转
        inflight?.abort();
        inflight = null;
        release();
    }

    /** 换数据源 / 重扫前清空，避免上一批的进度残留在底栏 */
    function reset(): void {
        stop();
        total.value = 0;
        done.value = 0;
        hits.value = 0;
        stopped.value = false;
    }

    return { phase, live, paused, total, done, hits, stopped, run, rematch, pause, resume, stop, reset };
}
