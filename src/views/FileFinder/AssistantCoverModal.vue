<template>
    <n-modal
        :show="visible"
        preset="card"
        :closable="false"
        style="width: 100vw; height: 100vh"
        content-style="padding: 0; height: 100%"
        @update:show="onModalShowChange"
    >
        <AssistantShell title="补封面" @close="setShowModal(false)">
            <template #meta>
                <template v-if="faceMode">
                    待换 <b>{{ items.length }}</b> 部
                </template>
                <template v-else>
                    待补 <b>{{ items.length }}</b>
                    <i />
                    认不出番号 {{ scan?.unmatched.length ?? 0 }}
                    <i />
                    分类目录跳过 {{ scan?.skippedCategory ?? 0 }}
                </template>
            </template>

            <template #tools>
                <n-select
                    v-if="diskSelectOptions.length"
                    class="ffw-select"
                    :value="selectedSerial"
                    :options="diskSelectOptions"
                    :theme-overrides="TOOLBAR_SELECT"
                    size="small"
                    :disabled="busy || faceMode"
                    style="width: 216px"
                    @update:value="onDiskChange"
                />
                <button type="button" class="ffw-btn ffw-btn--ghost" :disabled="busy || !selectedSerial" @click="runScan">
                    <n-icon :component="RefreshOutline" :size="13" />
                    扫描
                </button>
                <button type="button" class="ffw-btn ffw-btn--ghost" :disabled="busy || !selectedSerial || faceMode" @click="confirmDeepRescan">
                    深度重扫
                </button>
            </template>

            <SkeletonList v-if="scanLoading" variant="card" :count="8" />

            <div v-else-if="!items.length" class="ffw-empty">
                <div>
                    <b>{{ faceMode ? '缓存里找不到你刚选的那些位置' : '缓存里没有发现缺封面的视频' }}</b>
                    <template v-if="faceMode">
                        收到 {{ scan?.received ?? 0 }} 个选中位置 · 查了 {{ scan?.probed ?? 1 }} 块盘的缓存
                    </template>
                    <template v-else>刚在盘上手动删过图的话，点上面的「深度重扫」用实时清单复核</template>
                </div>
            </div>

            <template v-else>
                <div class="ffw-grid">
                    <CoverCard
                        v-for="(item, i) in items"
                        :key="item.key"
                        :item="item"
                        :index="i"
                        :selected="isSelected(item)"
                        :locked="selLocked"
                        :cover-src="item.coverUrl ? previewSrc(item.coverUrl) : ''"
                        @toggle="toggleCard(item)"
                    />
                </div>

                <details v-if="unmatched.length" class="ffw-details">
                    <summary>认不出番号 {{ unmatched.length }} 条（已跳过，不会去搜，也不会写任何东西）</summary>
                    <div v-for="u in unmatched" :key="u.dir + '/' + u.name" class="ffw-details__row">
                        {{ u.dir ? u.dir + ' / ' : '' }}{{ u.name }}
                    </div>
                </details>
            </template>

            <template #dock>
                <TaskDock
                    :phase="task.phase"
                    :ratio="task.ratio"
                    :status="task.status"
                    :detail="task.detail"
                    :celebrate="celebrate"
                >
                    <template #actions>
                        <template v-if="task.mode === 'idle'">
                            <button
                                type="button"
                                class="ffw-btn ffw-btn--primary"
                                :disabled="!counts.selected || scanLoading"
                                @click="startGrab()"
                            >
                                开始抓取 {{ counts.selected }} 部
                                <n-icon :component="ArrowForwardOutline" :size="13" />
                            </button>
                        </template>

                        <template v-else-if="task.mode === 'grab'">
                            <button type="button" class="ffw-btn" :disabled="!!grabActing" @click="pauseGrab">
                                <n-icon :component="PauseOutline" :size="13" /> 暂停
                            </button>
                            <button type="button" class="ffw-btn ffw-btn--danger" :disabled="!!grabActing" @click="stopGrab">
                                <n-icon :component="StopOutline" :size="13" /> 终止
                            </button>
                        </template>

                        <template v-else-if="task.mode === 'grab-pause'">
                            <button
                                v-if="counts.ready"
                                type="button"
                                class="ffw-btn"
                                :disabled="!!grabActing || !!applyActing"
                                @click="startApply"
                            >
                                写入已抓到的 {{ counts.ready }} 部
                            </button>
                            <button type="button" class="ffw-btn ffw-btn--primary" :disabled="!!grabActing" @click="resumeGrab">
                                <n-icon :component="PlayOutline" :size="13" /> 继续
                            </button>
                            <button type="button" class="ffw-btn ffw-btn--danger" :disabled="!!grabActing" @click="stopGrab">
                                <n-icon :component="StopOutline" :size="13" /> 终止
                            </button>
                        </template>

                        <template v-else-if="task.mode === 'apply'">
                            <button type="button" class="ffw-btn ffw-btn--danger" :disabled="!!applyActing" @click="stopApply">
                                <n-icon :component="StopOutline" :size="13" /> 终止
                            </button>
                        </template>

                        <template v-else-if="task.mode === 'grab-done'">
                            <button
                                v-if="blockedSites.length"
                                type="button"
                                class="ffw-btn"
                                :disabled="challengeRunning"
                                @click="passChallenge"
                            >
                                <n-icon :component="ShieldCheckmarkOutline" :size="13" />
                                {{ challengeRunning ? '等待人工过验证…' : '过验证重抓' }}
                            </button>
                            <button
                                v-if="retryTargets.length"
                                type="button"
                                class="ffw-btn"
                                @click="startGrab(retryTargets, grabJob?.id)"
                            >
                                补抓 {{ retryTargets.length }} 条
                            </button>
                            <button type="button" class="ffw-btn ffw-btn--ghost" @click="runScan">重扫</button>
                            <button
                                type="button"
                                class="ffw-btn ffw-btn--primary"
                                :disabled="!counts.ready"
                                @click="startApply"
                            >
                                确认写入 {{ counts.ready }} 部
                                <n-icon :component="ArrowForwardOutline" :size="13" />
                            </button>
                        </template>

                        <template v-else>
                            <button type="button" class="ffw-btn ffw-btn--ghost" @click="runScan">重扫</button>
                            <button type="button" class="ffw-btn ffw-btn--primary" @click="setShowModal(false)">完成</button>
                        </template>
                    </template>
                </TaskDock>
            </template>
        </AssistantShell>
    </n-modal>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { NModal, NSelect, NIcon } from 'naive-ui';
import useConfirm from '@/hooks/useConfirm';
import {
    ArrowForwardOutline,
    PauseOutline,
    PlayOutline,
    RefreshOutline,
    ShieldCheckmarkOutline,
    StopOutline,
} from '@vicons/ionicons5';
import { apiUrl, getAction, postAction } from '@/utils/request';
import useNotify from '@/hooks/useNotify';
import AssistantShell from './assistant/AssistantShell.vue';
import TaskDock from './assistant/TaskDock.vue';
import CoverCard from './assistant/CoverCard.vue';
import SkeletonList from './assistant/SkeletonList.vue';
import { buildCoverItems, buildCoverTask, summarize } from './assistant/coverModel';
import type { ApplyRowLike, CoverItem, GrabRowLike, ScanTargetLike } from './assistant/coverModel';
import { isLiveJob } from './assistant/jobTypes';
import type { JobSnapshot } from './assistant/jobTypes';
import { useAssistantJob } from './assistant/useAssistantJob';
import { TOOLBAR_SELECT } from './assistant/toolbarSelect';
import { holdScanBeat } from './assistant/scanBeat';

/** 统一写 127.0.0.1：localhost 可能解析到 ::1，服务端只绑 IPv4 */
const API_BASE = 'http://127.0.0.1:3060';

/** 预览走本地代理：渲染层直接 <img> 外站图会被防盗链拦；代理与写盘同一条下载通道 */
const previewSrc = (url: string) => apiUrl(`${API_BASE}/assistant/preview?url=${encodeURIComponent(url)}`);

interface DiskRow {
    serial: string;
    drive: string;
    label: string;
    online: boolean;
    folders: number;
    covers: number;
}

/** 主界面「换封面」传进来的一个选中位置（与后端 `FacePick` 同形） */
interface FacePick {
    dir: string;
    name: string;
    ext?: string;
    kind: 'dir' | 'item';
}

interface ScanResult {
    serial: string;
    scope: string;
    targets: ScanTargetLike[];
    unmatched: { dir: string; name: string }[];
    skippedCategory: number;
    scannedDocs: number;
    probed?: number;
    received?: number;
}

const emit = defineEmits<{ refresh: [] }>();
const notify = useNotify();
const dialog = useConfirm();

const visible = ref(false);
const disks = ref<DiskRow[]>([]);
const scanLoading = ref(false);
const challengeRunning = ref(false);
const celebrate = ref(false);

const selectedSerial = ref<string | null>(null);
const scan = ref<ScanResult | null>(null);
/** 勾选集合，键 = writeRel；一张卡可能对应多个 writeRel（分卷） */
const sel = ref(new Set<string>());
/** 本批次已写成功的 writeRel —— 跨多次写入累积，重扫才清 */
const writtenRels = ref(new Set<string>());

/**
 * 「换封面」入口带来的选中位置。空 = 走「补封面」（扫描找"没有封面的"）；
 * 非空 = 只处理这些（"有但要换的"）。两者共用这一个面板、这一条链路。
 */
const facePicks = ref<FacePick[]>([]);
const faceMode = computed(() => facePicks.value.length > 0);

const {
    job: grabJob, acting: grabActing, track: trackGrab, trackAndWait: waitJob,
    pause: pauseGrab, resume: resumeGrab, stop: stopGrab, detach: detachGrab,
} = useAssistantJob(undefined, msg => notify('error', '操作没生效', msg));
const {
    job: applyJob, acting: applyActing, track: trackApply,
    stop: stopApply, detach: detachApply,
} = useAssistantJob(onApplySettled, msg => notify('error', '操作没生效', msg));

const busy = computed(() =>
    scanLoading.value || isLiveJob(grabJob.value) || isLiveJob(applyJob.value) || challengeRunning.value);

function onApplySettled(job: JobSnapshot): void {
    const next = new Set(writtenRels.value);
    for (const r of job.rows as ApplyRowLike[]) if (r.ok) next.add(r.writeRel);
    writtenRels.value = next;

    emit('refresh'); // 写完立即失效了对应目录缓存，主网格刷新就能看到新脸
    if (job.status === 'done') {
        celebrate.value = true;
        setTimeout(() => (celebrate.value = false), 680);
    }
    if (job.status === 'error') notify('error', '写入失败', job.message);
    else if (job.status === 'cancelled') notify('info', '写入已终止', job.message);
    else notify('success', '写入完成', job.message);
}

// ── 视图模型（判定全在 coverModel，模板只负责画） ─────────────
const targets = computed(() => scan.value?.targets ?? []);
const unmatched = computed(() => scan.value?.unmatched ?? []);
const grabRows = computed<GrabRowLike[]>(() => (grabJob.value?.rows as GrabRowLike[] | undefined) ?? []);

/** 写入行 = 累积的「已写入」+ 当前 apply job 的行（后者排在后面，覆盖前者） */
const applyRows = computed<ApplyRowLike[]>(() => {
    const out: ApplyRowLike[] = [...writtenRels.value].map(writeRel => ({ writeRel, ok: true }));
    for (const r of (applyJob.value?.rows as ApplyRowLike[] | undefined) ?? []) out.push(r);
    return out;
});

const items = computed<CoverItem[]>(() => buildCoverItems(
    targets.value,
    grabRows.value,
    applyRows.value,
    /**
     * ⚠️ 这里要的是「**正在**抓」，不是 `isLiveJob`。
     * `isLiveJob` 把 `paused` 也算活着 ⇒ 暂停后未处理的卡仍停在 `pending` ⇒
     * 点阵继续转，看起来像"暂停根本没生效"（2026-11-08 主人："暂停没用，loading 依旧播动画"）。
     */
    { live: grabJob.value?.status === 'running', selected: sel.value },
));

const counts = computed(() => summarize(items.value, sel.value));
const task = computed(() => buildCoverTask(grabJob.value, applyJob.value, counts.value));

const diskSelectOptions = computed(() => disks.value.map(d => ({
    value: d.serial,
    label: `${d.label || d.drive || '(离线)'} · ${d.online ? '在线' : '离线'} · ${d.folders} 目录`,
})));

const blockedSites = computed(() => [...new Set(
    grabRows.value.filter(r => r.status === 'blocked' && r.blockedSite).map(r => r.blockedSite!),
)]);

/** 还没拿到封面的目标：试过但失败/被拦的（认不出番号的除外 —— 再抓还是认不出） */
const retryTargets = computed(() => {
    const rels = new Set(items.value
        .filter(i => i.state === 'blocked' || i.state === 'miss' || i.state === 'error')
        .flatMap(i => i.writeRels));
    return targets.value.filter(t => rels.has(t.writeRel));
});

/** 任务在跑/暂停 ⇒ 锁住勾选（队列已定，这时改选择只是自欺） */
const selLocked = computed(() => isLiveJob(grabJob.value) || isLiveJob(applyJob.value));

const isSelected = (item: CoverItem) => item.writeRels.some(r => sel.value.has(r));

const toggleCard = (item: CoverItem) => {
    if (selLocked.value) return;
    const next = new Set(sel.value);
    if (isSelected(item)) for (const r of item.writeRels) next.delete(r);
    else for (const r of item.writeRels) next.add(r);
    sel.value = next;
};

// ── 扫描 ────────────────────────────────────────────────────
const loadDisks = async () => {
    try {
        const res = await getAction(`${API_BASE}/getDisks`);
        disks.value = ((res.disks ?? []) as DiskRow[]).filter(d => d.serial);
        // 只有一块盘就自动选上；多盘必须用户自己选，不替他做主
        if (!selectedSerial.value && disks.value.length === 1) selectedSerial.value = disks.value[0].serial;
    } catch (e) {
        notify('error', '取盘列表失败', String(e));
    }
};

const applyScanResult = (result: ScanResult) => {
    scan.value = result;
    sel.value = new Set(result.targets.map(t => t.writeRel)); // 默认全选（已锁决策）
    writtenRels.value = new Set();
    detachGrab();
    detachApply();
};

const runScan = async () => {
    // 任务在跑/暂停时不许重扫：重扫会把已抓到的结果整批顶掉
    if (isLiveJob(grabJob.value) || isLiveJob(applyJob.value)) {
        notify('info', '先处理当前任务', '任务还在（暂停中），继续或终止它之后再重扫');
        return;
    }
    if (!faceMode.value && !selectedSerial.value) return;

    scanLoading.value = true;
    const startedAt = performance.now();
    try {
        if (faceMode.value) {
            // 把主界面选中的**位置**展开成目标清单（零读盘，只读缓存）；
            // 返回的 targets 与「补封面」同形 ⇒ 下游零改动
            const res = await postAction(`${API_BASE}/assistant/faces`, { picks: facePicks.value });
            if (res.serial) selectedSerial.value = res.serial as string;
            applyScanResult({
                serial: (res.serial ?? '') as string,
                scope: '',
                targets: (res.targets ?? []) as ScanTargetLike[],
                unmatched: [],
                skippedCategory: 0,
                scannedDocs: 0,
                probed: (res.probed as number | undefined) ?? 1,
                received: (res.received as number | undefined) ?? facePicks.value.length,
            });
        } else {
            const res = await postAction(`${API_BASE}/assistant/scan`, { serial: selectedSerial.value, relPath: '' });
            applyScanResult(res as ScanResult);
        }
    } catch (e) {
        notify('error', faceMode.value ? '展开选中项失败' : '扫描失败', String(e));
    } finally {
        // 与头像面板同一条时间线：骨架留满一拍再换内容（见 assistant/scanBeat.ts）
        await holdScanBeat(startedAt);
        scanLoading.value = false;
    }
};

const onDiskChange = (serial: string) => {
    selectedSerial.value = serial;
    void runScan();
};

/** 深度重扫：把写入过的目录用实时清单（readdir+stat，不抽帧）复核后重出清单 */
/** 深度重扫前的确认 —— 统一走 Overlay 的 confirm（与头像写入同一份实现） */
const confirmDeepRescan = () => dialog.warning({
    title: '深度重扫',
    content: '把写入过的目录用实时清单复核一遍（只读文件名，不抽帧）。确定吗？',
    positiveText: '深度重扫',
    negativeText: '取消',
    onPositiveClick: () => deepRescan(),
});

const deepRescan = async () => {
    if (!selectedSerial.value || busy.value) return;
    try {
        const res = await postAction(`${API_BASE}/assistant/rebuild`, { serial: selectedSerial.value, relPath: '' });
        applyScanResult(res as ScanResult);
        if (res.refreshed) notify('success', '深度重扫完成', `实时复核了 ${res.refreshed} 个目录`);
        else if (scan.value?.targets.length) notify('info', '深度重扫完成', '盘不在线或没有写入记录，结果来自缓存');
    } catch (e) {
        notify('error', '深度重扫失败', String(e));
    }
};

// ── 任务 ────────────────────────────────────────────────────
const startGrab = async (list?: ScanTargetLike[], appendTo?: string) => {
    const picked = list ?? targets.value.filter(t => sel.value.has(t.writeRel));
    if (!picked.length) return;

    if (!appendTo) {
        detachApply();
        writtenRels.value = new Set();
    }
    try {
        const res = await postAction(`${API_BASE}/assistant/jobs`, {
            kind: 'grab',
            serial: selectedSerial.value,
            targets: picked,
            // 「换封面」必须绕开命中缓存：否则会拿回同一张图，"已替换"就成了假话
            ...(faceMode.value ? { force: true } : {}),
            ...(appendTo ? { jobId: appendTo } : {}),
        });
        if (!res.jobId) {
            notify('info', '没有可抓的目标', res.message || '');
            return;
        }
        if (res.reused) notify('info', '抓取', res.message || '已接上正在跑的那个抓取任务');
        trackGrab(res.jobId);
    } catch (e) {
        notify('error', '抓取启动失败', String(e));
    }
};

/** 被拦 → 人工过验证 → 过完自动补抓被拦的那批（结果并进同一个 job） */
const passChallenge = async () => {
    if (!blockedSites.value.length || challengeRunning.value) return;
    challengeRunning.value = true;
    try {
        for (const siteId of blockedSites.value) {
            const res = await postAction(`${API_BASE}/assistant/jobs`, { kind: 'challenge', siteId });
            const job = await waitJob(res.jobId);
            if (job.status !== 'done') {
                notify('warning', '人工过验证', job.message || '验证没通过，可以再试一次');
                return;
            }
        }
        const rels = new Set(grabRows.value.filter(r => r.status === 'blocked').map(r => r.writeRel));
        const blocked = targets.value.filter(t => rels.has(t.writeRel));
        if (blocked.length && grabJob.value) await startGrab(blocked, grabJob.value.id);
        else await runScan();
    } catch (e) {
        notify('error', '人工过验证失败', String(e));
    } finally {
        challengeRunning.value = false;
    }
};

const startApply = async () => {
    if (!grabJob.value || grabJob.value.status === 'running' || isLiveJob(applyJob.value)) return;
    const picks = items.value
        .filter(i => i.state === 'ok' && i.writeRels.some(r => sel.value.has(r)))
        .flatMap(i => i.writeRels);
    if (!picks.length) return;

    try {
        const res = await postAction(`${API_BASE}/assistant/apply`, {
            serial: selectedSerial.value,
            jobId: grabJob.value.id,
            picks,
        });
        if (!res.jobId) {
            notify('info', '没有可写入的封面', res.message || '');
            return;
        }
        trackApply(res.jobId);
    } catch (e) {
        notify('error', '写入启动失败', String(e));
    }
};

// ── 开关面板 ────────────────────────────────────────────────
/**
 * ⚠️ 打开永远是**程序主动调的**（带 picks），所以 `@update:show` 只管关闭：
 * 打开时 naive 会把 `visible = true` 回声回来，事件只带一个 boolean ——
 * 若拿它去调 `setShowModal(true)`，第二个参数 `picks` 就是 undefined，
 * 刚设好的「换封面」选择会被当场清空（真机踩过）。
 */
const onModalShowChange = (v: boolean) => {
    if (!v) void setShowModal(false);
};

const setShowModal = async (v: boolean, picks?: FacePick[]) => {
    visible.value = v;
    if (!v) {
        detachGrab();
        detachApply();
        facePicks.value = []; // 关面板就清掉挑选，否则下次从「补封面」进来会沿用
        return;
    }
    // 只有显式传了才覆盖（防"回声调用"把选择清掉）
    if (picks) facePicks.value = picks;

    await loadDisks();

    // 面板关了任务还在跑（job 活在主进程内存里）：重开时挂回去，
    // 不然用户会以为关闭 = 任务没了。**暂停中的也要挂**。
    let attached = false;
    try {
        const res = await getAction(`${API_BASE}/assistant/jobs`);
        const live = (res.jobs as JobSnapshot[]).find(j =>
            (j.kind === 'grab' || j.kind === 'apply') && isLiveJob(j));
        if (live) {
            if (live.kind === 'grab') trackGrab(live.id);
            else trackApply(live.id);
            attached = true;
        }
    } catch {
        // 没有任务 / 服务没起来都无所谓，走正常流程
    }

    // 没有在跑的任务就必须重算清单：否则第二次打开会显示上一次的清单
    //（跨模式、换盘重开都要重算）
    if (!attached) await runScan();
};

defineExpose({ setShowModal });
</script>
