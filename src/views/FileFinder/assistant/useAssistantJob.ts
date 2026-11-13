import { onUnmounted, ref } from 'vue';
import { API_BASE, deletAction, getAction, postAction } from '@/utils/request';
import { isLiveJob } from './jobTypes';
import type { JobSnapshot } from './jobTypes';

/**
 * 轮询间隔。
 *
 * 2026-11-14：1200 → 800。抓取吞吐提到 ~0.8 条/秒之后，1.2 秒才看一次快照，
 * 界面会比实际落后一整拍（结果已经出了、卡上还是空的）。
 * 800 是折中：本地 HTTP，开销只有几个 KB，比"看起来卡住"便宜得多。
 */
const POLL_MS = 800;

/**
 * 盯一个后台任务：轮询快照 + 暂停 / 继续 / 终止。
 *
 * 三条来自真机的硬约束（都是踩过的）：
 *  ① **第一轮立刻拉**：`setInterval` 第一拍在 1.2s 后，那段时间界面什么都没发生，
 *    按钮还能再点一次 —— "点了没反应"就是这么来的。
 *  ② **暂停中必须继续轮**：用户随时会点「继续」，停掉就再也看不到状态变化。
 *  ③ **终止的转圈要盯到真收尾**（worker 还在退出），不能被"请求已返回"骗着收掉，
 *    所以只有看到 `!isLive` 才算动作结束。
 */
/**
 * @param onSettled 任务真正收尾（完成/终止/出错）时回调一次
 * @param onError   暂停 / 继续 / 终止**没打成**时回调。
 *                  ⚠️ 少了它，请求失败就是"点了没反应"：按钮不报错、状态不变、任务照跑，
 *                  用户只能得出"这个按钮坏了"（2026-11-08 主人原话"暂停和终止完全没用"）。
 */
export function useAssistantJob(
    onSettled?: (job: JobSnapshot) => void,
    onError?: (message: string) => void,
) {
    const job = ref<JobSnapshot | null>(null);
    const acting = ref<'' | 'pause' | 'resume' | 'stop'>('');

    let timer: ReturnType<typeof setInterval> | null = null;
    let settledFor: string | null = null;
    let resolveSettled: ((job: JobSnapshot) => void) | null = null;

    const stopPoll = () => {
        if (timer) {
            clearInterval(timer);
            timer = null;
        }
        /**
         * ⚠️ 谁在 `await trackAndWait(...)`，谁就靠这个 promise 往下走。停轮询时若只是
         * 把 resolver 丢掉，那个 `async` 会**永远悬挂** —— 人工过验证流程里
         * `challengeRunning` 会永远停在 true，面板重开按钮还写着"等待人工过验证…"。
         * 用一个"已取消"的快照收尾，让调用方照常往下走。
         */
        const pending = resolveSettled;
        resolveSettled = null;
        if (pending && job.value) pending({ ...job.value, status: 'cancelled' });
    };

    const apply = (next: JobSnapshot) => {
        job.value = next;
        if (isLiveJob(next)) {
            settledFor = null;
            return;
        }
        if (acting.value === 'stop') acting.value = '';
        if (settledFor === next.id) return;
        settledFor = next.id;
        const resolve = resolveSettled;
        resolveSettled = null;
        resolve?.(next);
        onSettled?.(next);
    };

    const fetchOnce = async (id: string) => {
        try {
            const res = await getAction(`${API_BASE}/assistant/jobs?id=${encodeURIComponent(id)}`);
            apply(res.job as JobSnapshot);
        } catch {
            // 服务忙 / 网络抖一下：下一拍再试。任务在主进程内存里，不会丢
        }
    };

    /** 挂上并等它收尾（人工过验证那种"必须等结果才能走下一步"的场景用） */
    const trackAndWait = (id: string) =>
        new Promise<JobSnapshot>((resolve) => {
            resolveSettled = resolve;
            track(id);
        });

    /** 挂上一个任务：立刻拉一次，然后按拍轮询直到收尾 */
    const track = (id: string) => {
        stopPoll();
        settledFor = null;
        void fetchOnce(id);
        timer = setInterval(() => {
            void fetchOnce(id);
            if (job.value && !isLiveJob(job.value)) stopPoll();
        }, POLL_MS);
    };

    const control = async (act: 'pause' | 'resume') => {
        if (!job.value || acting.value) return;
        acting.value = act;
        const id = job.value.id;
        try {
            const res = (await postAction(
                `${API_BASE}/assistant/jobs?id=${encodeURIComponent(id)}&act=${act}`,
                {},
            )) as { ok?: boolean; status?: string };
            // 服务端明说"没生效"（任务刚好跑完 / 没在跑）：必须说出来，否则按钮看着像坏了
            if (res && res.ok === false) {
                onError?.(`任务状态已变化（${res.status || '未知'}），这次${act === 'pause' ? '暂停' : '继续'}没生效`);
            }
            await fetchOnce(id);
        } catch (e) {
            onError?.(e instanceof Error ? e.message : String(e));
        } finally {
            acting.value = '';
        }
    };

    const stop = async () => {
        if (!job.value || acting.value) return;
        acting.value = 'stop';
        const id = job.value.id;
        try {
            await deletAction(`${API_BASE}/assistant/jobs?id=${encodeURIComponent(id)}`);
            await fetchOnce(id);
        } catch (e) {
            onError?.(e instanceof Error ? e.message : String(e));
        } finally {
            // 无论成败都放开按钮：卡在 'stop' 会让「暂停/终止」从此彻底点不动
            if (acting.value === 'stop') acting.value = '';
        }
    };

    /** 丢掉本地引用（关面板时用）。**不终止任务** —— 它活在主进程里，重开还能挂回来 */
    const detach = () => {
        stopPoll();
        job.value = null;
        acting.value = '';
        settledFor = null;
        resolveSettled = null;
    };

    onUnmounted(stopPoll);

    return {
        job, acting, track, trackAndWait,
        pause: () => control('pause'), resume: () => control('resume'), stop, detach,
    };
}
