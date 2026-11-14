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
                    <!-- 范围是「条件」，不是「统计」：用项目里**可点选胶囊**的规格
                         （`Cache/index.vue` 的 `.disk-chip` —— 26 高 / 12px / 全圆 / 1px 描边）。
                         顶栏这一行是 2026-11-08 骨架定的「待补 · 认不出 · 跳过」，
                         别再往里塞靠下划线区分的链接 —— 那会把它变成一排找不着重点的字。 -->
                    <button
                        type="button"
                        class="ffw-scope"
                        :disabled="!canToggleScope"
                        v-tip="scopeTip"
                        @click="toggleScope"
                    >
                        <!-- 文字必须包一层：直接当 flex 的匿名文本节点时 `text-overflow` 不生效，
                             超长会把右边那颗图标挤扁（2026-11-14 踩到：图标被压成 0 宽） -->
                        <span class="ffw-scope__t">{{ scopeText }}</span>
                        <!-- 图标与卡片右上那颗「换一帧」同源同档（RepeatOutline / 13px）：
                             同一个语义在界面上只该有一种图形、一种大小 -->
                        <span v-if="openScope" class="ffw-scope__x" aria-hidden="true">
                            <n-icon :component="RepeatOutline" :size="13" />
                        </span>
                    </button>
                    <!-- ⚠️ 这里**不要**再放一个 `<i />` 分隔点：
                         胶囊自己带边框，已经足够把它和后面的统计分开；
                         加上那个 2px 圆点会紧贴胶囊右边框，看着就像"胶囊里多了一个点"
                         （2026-11-14 主人定位到的就是它）。 -->
                    待补 <b>{{ items.length }}</b>
                    <!-- 0 不占位：一行里塞满「跳过 0」只是噪音 -->
                    <template v-if="scan?.unmatched.length">
                        <i />
                        认不出番号 {{ scan.unmatched.length }}
                    </template>
                    <template v-if="scan?.skippedCategory">
                        <i />
                        分类目录跳过 {{ scan.skippedCategory }}
                    </template>
                    <!-- 系统盘上没人引用的抽帧帧：只给一条去设置清理的入口，不在工作流里插动作 -->
                    <template v-if="orphanCount">
                        <i />
                        <button type="button" class="ffw-meta-link" v-tip="`抽帧缓存里有 ${orphanCount} 张已无引用（${mb(orphanBytes)}），在设置里处理`" @click="goFrameCache">
                            旧帧 {{ orphanCount }}
                        </button>
                    </template>
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
                <button type="button" class="ffw-btn ffw-btn--ghost" :disabled="busy || !selectedSerial" @click="runScan()">
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
                    <b>{{ emptyTitle }}</b>
                    <template v-if="emptyHint">{{ emptyHint }}</template>
                    <!-- 范围收窄最危险的后果：**空 ≠ 齐了**。给一条出口，别让人对着一张空屏猜 -->
                    <button
                        v-if="canWidenScope"
                        type="button"
                        class="ffw-btn ffw-btn--ghost ffw-empty__act"
                        @click="widenScope"
                    >
                        扫描整个盘
                    </button>
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
                        :action="actionOf(item, frameBusy)"
                        :action-disabled="busy || (!!item.frame && item.frame.pct >= FRAME_STOP_PCT)"
                        :extracting="frameBusy.has(item.writeRels[0])"
                        :cover-src="srcOf(item)"
                        @toggle="toggleCard(item)"
                        @frame="startFrame(targetsOf(item))"
                        @broken="onCoverBroken(item.key)"
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
                    <!-- 总控勾选：一个盒子管全部 —— 勾上 = 全选、取消 = 全不选、半选 = 只选了一部分。
                         不另设「反选」按钮：checkbox group 里没有这个动作，它只是"先清空再挑几个"的捷径 -->
                    <template #lead>
                        <button
                            v-if="items.length && !selLocked"
                            type="button"
                            class="ffw-check"
                            :class="{ 'is-on': counts.selected > 0 }"
                            v-tip="allSelected ? '取消全选' : '全选'"
                            @click="toggleAll"
                        >
                            <n-icon v-if="allSelected" :component="CheckmarkOutline" :size="12" />
                            <span v-else-if="counts.selected" class="ffw-check__dash" />
                        </button>
                    </template>
                    <template #actions>
                        <!-- 批量抽帧：放在模式分支**之外** —— 有失败卡的那些时刻（grab-done / frame-done）
                             正是需要它的时候，塞进 idle 分支等于永远不出现 -->
                        <button
                            v-if="needFrameCount && !isLiveJob(frameJob) && !isLiveJob(applyJob) && !isLiveJob(grabJob)"
                            type="button"
                            class="ffw-btn ffw-btn--ghost"
                            :disabled="!canOperate"
                            v-tip="canOperate ? '把没有封面的用视频关键帧补上' : '这块盘现在不在线，插上盘再操作'"
                            @click="startFrame()"
                        >
                            没封面的 {{ needFrameCount }} 部抽帧
                        </button>

                        <template v-if="task.mode === 'idle'">
                            <button
                                type="button"
                                class="ffw-btn ffw-btn--primary"
                                :disabled="!counts.selected || scanLoading || !canOperate"
                                v-tip="canOperate ? '' : '这块盘现在不在线，插上盘再操作'"
                                @click="startGrab()"
                            >
                                开始抓取 {{ counts.selected }} 部
                                <n-icon :component="ArrowForwardOutline" :size="13" />
                            </button>
                            <!-- 只有回填帧、没有任何 job 时（关面板重开）也得能写 -->
                            <button
                                v-if="counts.ready"
                                type="button"
                                class="ffw-btn"
                                :disabled="!canOperate"
                                v-tip="canOperate ? '' : '这块盘现在不在线，插上盘再操作'"
                                @click="startApply"
                            >
                                确认写入 {{ counts.ready }} 部
                            </button>
                        </template>

                        <template v-else-if="task.mode === 'frame'">
                            <button type="button" class="ffw-btn" :disabled="!!frameActing" @click="pauseFrame">
                                <n-icon :component="PauseOutline" :size="13" /> 暂停
                            </button>
                            <button type="button" class="ffw-btn ffw-btn--danger" :disabled="!!frameActing" @click="stopFrame">
                                <n-icon :component="StopOutline" :size="13" /> 终止
                            </button>
                        </template>

                        <template v-else-if="task.mode === 'frame-pause'">
                            <button
                                v-if="counts.ready"
                                type="button"
                                class="ffw-btn"
                                :disabled="!!frameActing || !!applyActing || !canOperate"
                                @click="startApply"
                            >
                                写入已抽到的 {{ counts.ready }} 部
                            </button>
                            <button type="button" class="ffw-btn ffw-btn--primary" :disabled="!!frameActing" @click="resumeFrame">
                                <n-icon :component="PlayOutline" :size="13" /> 继续
                            </button>
                            <button type="button" class="ffw-btn ffw-btn--danger" :disabled="!!frameActing" @click="stopFrame">
                                <n-icon :component="StopOutline" :size="13" /> 终止
                            </button>
                        </template>

                        <template v-else-if="task.mode === 'frame-done'">
                            <button type="button" class="ffw-btn ffw-btn--ghost" @click="runScan()">重扫</button>
                            <button
                                type="button"
                                class="ffw-btn ffw-btn--primary"
                                :disabled="!counts.ready || !canOperate"
                                v-tip="canOperate ? '' : '这块盘现在不在线，插上盘再操作'"
                                @click="startApply"
                            >
                                确认写入 {{ counts.ready }} 部
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
                                :disabled="!!grabActing || !!applyActing || !canOperate"
                                v-tip="canOperate ? '' : '这块盘现在不在线，插上盘再操作'"
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
                                :disabled="!canOperate"
                                v-tip="canOperate ? '' : '这块盘现在不在线，插上盘再操作'"
                                @click="startGrab(retryTargets, grabJob?.id)"
                            >
                                补抓 {{ retryTargets.length }} 条
                            </button>
                            <button type="button" class="ffw-btn ffw-btn--ghost" @click="runScan()">重扫</button>
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
                            <button type="button" class="ffw-btn ffw-btn--ghost" @click="runScan()">重扫</button>
                            <button type="button" class="ffw-btn ffw-btn--primary" @click="setShowModal(false)">完成</button>
                        </template>
                    </template>
                </TaskDock>
            </template>
        </AssistantShell>
    </n-modal>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import { useRouter } from 'vue-router';
import { NModal, NSelect, NIcon } from 'naive-ui';
import useConfirm from '@/hooks/useConfirm';
import {
    ArrowForwardOutline,
    CheckmarkOutline,
    PauseOutline,
    PlayOutline,
    RefreshOutline,
    ShieldCheckmarkOutline,
    StopOutline,
    RepeatOutline,
} from '@vicons/ionicons5';
import { API_BASE, apiUrl, getAction, postAction } from '@/utils/request';
import useNotify from '@/hooks/useNotify';
import AssistantShell from './assistant/AssistantShell.vue';
import TaskDock from './assistant/TaskDock.vue';
import CoverCard from './assistant/CoverCard.vue';
import SkeletonList from './assistant/SkeletonList.vue';
import { buildCoverItems, buildCoverTask, actionOf, summarize, FRAME_STOP_PCT } from './assistant/coverModel';
import type { ApplyRowLike, CoverItem, GrabRowLike, ScanTargetLike } from './assistant/coverModel';
import { resolveDriveContext } from './assistant/driveContext';
import { isLiveJob } from './assistant/jobTypes';
import type { JobSnapshot } from './assistant/jobTypes';
import { useAssistantJob } from './assistant/useAssistantJob';
import { TOOLBAR_SELECT } from './assistant/toolbarSelect';
import { holdScanBeat } from './assistant/scanBeat';

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
const router = useRouter();

const visible = ref(false);
const disks = ref<DiskRow[]>([]);
const scanLoading = ref(false);
const challengeRunning = ref(false);
const celebrate = ref(false);
/** 完成光雾那个 680ms 定时器。不清的话：连续两次写入会叠多个，面板关了它还在写 ref */
let celebrateTimer: ReturnType<typeof setTimeout> | undefined;
onBeforeUnmount(() => { if (celebrateTimer) clearTimeout(celebrateTimer); });

const selectedSerial = ref<string | null>(null);
/**
 * 扫描范围（盘内相对路径，`''` = 整盘）。**与 `/assistant/scan` 的 `relPath` 同义**。
 *
 * ⚠️ 2026-11-13 之前这里永远是空串 —— 于是"在子目录里点补封面"其实扫的是整个盘，
 * 兄弟目录 TEMP2 的影片一起被列出来（主人报的问题）。路径信息一路都带着
 * （`resolveDriveContext` 早就返回了 `relPath`），只是在打开面板时被丢掉了。
 */
const scope = ref('');
/** 打开面板时站的那一层。范围 chip 靠它在「当前文件夹 ⇄ 整个盘」之间来回切 */
const openScope = ref('');
const scan = ref<ScanResult | null>(null);
/** 勾选集合，键 = writeRel；一张卡可能对应多个 writeRel（分卷） */
const sel = ref(new Set<string>());
/** 本批次已写成功的 writeRel —— 跨多次写入累积，重扫才清 */
const writtenRels = ref(new Set<string>());
/**
 * 预览图在浏览器里**加载失败**的卡（`@error`）。
 *
 * 抓取时服务端已验过一次，但渲染是另一个时刻（网络/CDN 会变）⇒ 浏览器是唯一能
 * 观测"这张图此刻能不能显示"的地方。坏掉的卡不许再显示碎图图标、不许报"已抓到"、
 * 更不许进写入名单（`startApply` 只收 `state==='ok'` 的卡）。
 */
const brokenCovers = ref(new Set<string>());
const onCoverBroken = (key: string) => {
    if (brokenCovers.value.has(key)) return;
    const next = new Set(brokenCovers.value);
    next.add(key);
    brokenCovers.value = next;
};

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
const {
    job: frameJob, acting: frameActing, track: trackFrame,
    pause: pauseFrame, resume: resumeFrame, stop: stopFrame, detach: detachFrame,
} = useAssistantJob(onFrameSettled, msg => notify('error', '操作没生效', msg));

const busy = computed(() =>
    scanLoading.value || isLiveJob(grabJob.value) || isLiveJob(applyJob.value)
    || isLiveJob(frameJob.value) || challengeRunning.value);

/** 盘在线才允许动盘（抓取/抽帧/写入）。离线时按钮置灰并说明原因 —— 扫描照旧可用 */
const canOperate = computed(() => {
    if (!selectedSerial.value) return false;
    const d = disks.value.find(x => x.serial === selectedSerial.value);
    return !d || d.online !== false;
});

// ── 范围：扫哪儿 ─────────────────────────────────────────────
/** 范围尾名。整盘 → 「整个盘」；否则只显示最后一段（全路径在 title 里） */
const scopeLabel = computed(() => {
    if (!scope.value) return '整个盘';
    const i = scope.value.lastIndexOf('/');
    return i === -1 ? scope.value : scope.value.slice(i + 1);
});

/** 从盘根打开时没有第二态可切；任务在跑时不许切（重扫会把已抓到的结果顶掉） */
const canToggleScope = computed(() => !!openScope.value && !busy.value && !faceMode.value);

/** 当前盘符（不含冒号）。取不到就空串 —— 不猜 */
const diskLetter = computed(() => {
    const d = disks.value.find(x => x.serial === selectedSerial.value);
    return (d?.drive ?? '').replace(/:$/, '');
});

/**
 * 胶囊上的字 = **盘符 + 文件夹**，不写"范围"两个字
 * （2026-11-14 主人：「tooltip 不要冗余提示文案且不要用范围，用盘符 + 文件夹会更好些」）。
 * 整盘时**只留盘符**（`D:`）—— 那时盘符本身就是完整定位，"整个盘"是多余的解释。
 */
const scopeText = computed(() => {
    const letter = diskLetter.value;
    if (!scope.value) return letter ? `${letter}:` : '整个盘';
    const part = scopeLabel.value;
    return letter ? `${letter}: ${part}` : part;
});

/**
 * 悬停只给**完整位置**。
 *
 * 不再写「只补 xxx 及以下 · 点击改为整个盘」那种说明 —— 右边那颗 ⇄ 已经在说"能切换"，
 * 再补一句就是重复。没有可切的状态时（从盘根打开）也就没有第二句可说。
 */
const scopeTip = computed(() => {
    const letter = diskLetter.value;
    if (!scope.value) return letter ? `${letter}:\\` : '';
    return letter ? `${letter}:\\${scope.value.replace(/\//g, '\\')}` : scope.value;
});

/**
 * 范围两态切换。**不做下拉菜单** —— 只有「当前文件夹 / 整个盘」两态，
 * 多一层菜单只是多一次点击、多一个要读的弹层。
 * 范围由 `runScan` 在成功后提交，这里只表达意图。
 */
const toggleScope = () => {
    if (!canToggleScope.value) return;
    void runScan(scope.value ? '' : openScope.value);
};

const widenScope = () => {
    if (!scope.value || busy.value) return;
    void runScan('');
};

function onApplySettled(job: JobSnapshot): void {
    const next = new Set(writtenRels.value);
    for (const r of job.rows as ApplyRowLike[]) if (r.ok) next.add(r.writeRel);
    writtenRels.value = next;

    emit('refresh'); // 写完立即失效了对应目录缓存，主网格刷新就能看到新脸
    if (job.status === 'done') {
        celebrate.value = true;
        if (celebrateTimer) clearTimeout(celebrateTimer);
        celebrateTimer = setTimeout(() => (celebrate.value = false), 680);
    }
    if (job.status === 'error') notify('error', '写入失败', job.message);
    else if (job.status === 'cancelled') notify('info', '写入已终止', job.message);
    else notify('success', '写入完成', job.message);
}

/**
 * 抽帧收尾。**盘上没有任何变化**（帧只落在系统盘缓存），所以不 emit refresh。
 * 在途标记在这里整批清掉：单卡重抽只有一两秒，按 settle 清就够了；
 * 批量时"还没有结果行的卡"由 `state:'pending'` 出自己的点阵。
 */
function onFrameSettled(job: JobSnapshot): void {
    frameBusy.value = new Set();
    if (job.status === 'error') notify('error', '抽帧失败', job.message);
    else if (job.status === 'cancelled') notify('info', '抽帧已终止', job.message);
    else notify('success', '抽帧完成', job.message);
}

// ── 视图模型（判定全在 coverModel，模板只负责画） ─────────────
const targets = computed(() => scan.value?.targets ?? []);
const unmatched = computed(() => scan.value?.unmatched ?? []);
const grabRows = computed<GrabRowLike[]>(() => (grabJob.value?.rows as GrabRowLike[] | undefined) ?? []);

/**
 * 此刻**真正在飞**的 writeRel —— 抓取和抽帧各自报，前端合并，**不推断**。
 *
 * ⚠️ 不要退回"选中且没结果就算在飞"：那会让几十张排队的卡一起转圈，
 * 既看不出在抓谁，又让点阵每帧要重绘几十个场（共享 rAF，但绘制量是 3 个场的十几倍）。
 */
const inflightRels = computed<ReadonlySet<string>>(() => new Set([
    ...(grabJob.value?.inflight ?? []),
    ...(frameJob.value?.inflight ?? []),
]));

/**
 * 抽帧的行 = **回填的**（服务端已存在的帧，关面板重开时恢复）+ **本次 job 的**。
 * job 行排在后面：同一个 writeRel 后者说了算，换一帧才不会被回填的旧帧顶住。
 */
interface FrameEntry { writeRel: string; frameFile: string; pct: number; attempt: number; skipped: number }
const frameIndex = ref<FrameEntry[]>([]);

const frameRows = computed<GrabRowLike[]>(() => {
    const fromIndex: GrabRowLike[] = frameIndex.value.map(f => ({
        writeRel: f.writeRel, status: 'ok' as const, coverUrl: null,
        frame: true, frameFile: f.frameFile, pct: f.pct, attempt: f.attempt, skipped: f.skipped,
    }));
    return fromIndex;
});

/** 本次 job 的帧行（与回填分开：回填是**更早**的结果，不该压过之后抓到的封面） */
const jobFrameRows = computed<GrabRowLike[]>(() => (frameJob.value?.rows ?? []) as GrabRowLike[]);

/**
 * 正在抽的卡的 writeRel。`state:'pending'` 只覆盖"这张卡还没有任何结果行"的情形，
 * 而「换一帧」的卡**本来就有行** ⇒ 必须另有一份在途标记，否则点了没有任何反馈。
 */
const frameBusy = ref<Set<string>>(new Set());

/**
 * 打开/重扫后把这批卡已抽过的帧捞回来（服务端 readdir + 算卡键，零读盘）。
 * 失败不打扰用户：回填只是"上次的进度"，没有它也能重新抽。
 */
const loadFrameIndex = async () => {
    if (!selectedSerial.value) return;
    try {
        const res = await postAction(`${API_BASE}/assistant/frames`, {
            serial: selectedSerial.value, targets: targets.value,
        });
        frameIndex.value = (res.frames ?? []) as FrameEntry[];
    } catch {
        frameIndex.value = [];
    }
};

// ── 抽帧缓存的"没人要了"提醒（只提醒，不在工作流里插动作） ────────────
const orphanCount = ref(0);
const orphanBytes = ref(0);
const mb = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/**
 * 后台盘一次"无引用的帧"（零读盘：缓存 + 系统盘 readdir），有就提醒一次。
 * ⚠️ 节流是**全局每天一次**，不按盘 —— 缓存是整机一件事，一块一块提醒很烦。
 * ⚠️ 不阻塞面板打开：它是提醒，不是工作流的一环。
 */
const checkOrphans = async () => {
    try {
        // 只算**当前这块盘**：角标要回答的是"我手上这块有没有垃圾"，不是全机器的账
        const res = await postAction(`${API_BASE}/assistant/frames/inventory`, { serial: selectedSerial.value });
        const list = (res.orphans ?? []) as { bytes: number }[];
        orphanCount.value = list.length;
        orphanBytes.value = list.reduce((n, o) => n + (o.bytes ?? 0), 0);
        if (!orphanCount.value) return;

        const today = new Date().toISOString().slice(0, 10);
        let last = '';
        try { last = localStorage.getItem('ff.frameCleanupNotified') ?? ''; } catch { /* 存不下就每次都提醒（可接受） */ }
        if (last === today) return;
        try { localStorage.setItem('ff.frameCleanupNotified', today); } catch { /* 同上 */ }
        notify('warning', `抽帧缓存有 ${orphanCount.value} 张用不到了`,
            `设置 → 通用 可清理 · ${mb(orphanBytes.value)}`);
    } catch {
        // 统计失败不影响补封面
    }
};

/** 去设置里处理：先关面板（任务在主进程里活着，回来会挂上） */
const goFrameCache = () => {
    void setShowModal(false);
    void router.push('/settings');
};

/** 写入行 = 累积的「已写入」+ 当前 apply job 的行（后者排在后面，覆盖前者） */
const applyRows = computed<ApplyRowLike[]>(() => {
    const out: ApplyRowLike[] = [...writtenRels.value].map(writeRel => ({ writeRel, ok: true }));
    for (const r of (applyJob.value?.rows as ApplyRowLike[] | undefined) ?? []) out.push(r);
    return out;
});

const items = computed<CoverItem[]>(() => {
    const base = buildCoverItems(
        targets.value,
        // 顺序 = 时间顺序（后者说了算）：回填帧（最早）→ 抓取行 → 本次抽帧行（最晚）。
        // ⚠️ 帧行不能无条件压在抓取行后面：重开面板后抓到的好封面会被上一天的旧帧永久遮蔽。
        [...frameRows.value, ...grabRows.value, ...jobFrameRows.value],
        applyRows.value,
        {
            frameBusy: frameBusy.value,
            inflight: inflightRels.value,
            selected: sel.value,
            /**
             * 「排队」标记只在任务活着时出现。
             * 没跑的时候没有队列，说"排队"是假话 —— 那时空卡就是"没扫到/不处理"。
             */
            live: isLiveJob(grabJob.value) || isLiveJob(frameJob.value),
        },
    );
    if (!brokenCovers.value.size) return base;
    // 只降级"刚抓到"的卡：已写入 / 已失败 / 被拦的卡各有自己的状态，别覆盖
    return base.map(i => brokenCovers.value.has(i.key) && i.state === 'ok'
        ? { ...i, state: 'error' as const, badge: '封面取不到', coverUrl: null }
        : i);
});

const counts = computed(() => summarize(items.value, sel.value));

/**
 * 队列里还有多少没轮到。**前端算，不加后端字段** ——
 * 三个输入都已经在快照里：`total − processed − 在飞 = 排队`。
 * 只在抓取正在跑时才有意义（暂停时停住的那个数仍然是真话，保留）。
 */
const queuedCount = computed(() => {
    const job = grabJob.value;
    const p = job?.progress;
    if (!job || !p || !isLiveJob(job)) return 0;
    return Math.max(0, p.total - p.processed - (job.inflight?.length ?? 0));
});

const task = computed(() => buildCoverTask(
    grabJob.value, frameJob.value, applyJob.value, counts.value, queuedCount.value,
));

/**
 * 空态必须分段，**不能一句「没有缺封面的视频」**。
 * 范围收窄之后，「这个文件夹压根没扫过」和「真的都补齐了」在界面上长得一模一样 ——
 * 那会让人以为已经补完，然后一直缺着（比报错更坏的静默失败）。
 */
const emptyTitle = computed(() => {
    if (faceMode.value) return '缓存里找不到你刚选的那些位置';
    if (!scan.value) return '还没扫描';
    if (scope.value && !scan.value.scannedDocs) return '这个文件夹还没有缓存记录';
    if (scope.value && scan.value.skippedCategory) return '这里只有分类目录';
    return '缓存里没有发现缺封面的视频';
});

const emptyHint = computed(() => {
    if (faceMode.value) {
        return `收到 ${scan.value?.received ?? 0} 个选中位置 · 查了 ${scan.value?.probed ?? 1} 块盘的缓存`;
    }
    if (!scan.value) return '';
    if (scope.value && !scan.value.scannedDocs) {
        return '它从没在「封面」视图下扫过，看不出缺哪张。换成整个盘，或回主界面把它刷新一次';
    }
    if (scope.value && scan.value.skippedCategory) {
        return `${scan.value.skippedCategory} 个文件夹下面还是文件夹，没有影片可补`;
    }
    return '刚在盘上手动删过图的话，点上面的「深度重扫」用实时清单复核';
});

/** 只剩"范围"这一个变量能解释空清单时，才给那条出口 */
const canWidenScope = computed(() => !faceMode.value && !!scope.value && !busy.value);

/** 帧预览走本地代理端点（帧在系统盘，`v` 由文件名里的 nonce 保证每次换帧都变） */
const frameSrc = (file: string) =>
    apiUrl(`${API_BASE}/assistant/frame?serial=${encodeURIComponent(selectedSerial.value ?? '')}&f=${encodeURIComponent(file)}`);

const srcOf = (item: CoverItem) =>
    item.frame ? frameSrc(item.frame.file) : (item.coverUrl ? previewSrc(item.coverUrl) : '');

/** 这张卡对应的扫描目标（一张卡可能对应多个 writeRel = 分卷） */
const targetsOf = (item: CoverItem) => targets.value.filter(t => item.writeRels.includes(t.writeRel));

/** 还没封面、且抽帧是合理选择的有几张（底栏批量按钮的计数） */
const needFrameCount = computed(() => items.value.filter(i => actionOf(i, frameBusy.value) === 'frame').length);

const markBusy = (rels: string[], on: boolean) => {
    const next = new Set(frameBusy.value);
    for (const r of rels) { if (on) next.add(r); else next.delete(r); }
    frameBusy.value = next;
};

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
const selLocked = computed(() =>
    isLiveJob(grabJob.value) || isLiveJob(applyJob.value) || isLiveJob(frameJob.value));

const isSelected = (item: CoverItem) => item.writeRels.some(r => sel.value.has(r));

const toggleCard = (item: CoverItem) => {
    if (selLocked.value) return;
    const next = new Set(sel.value);
    if (isSelected(item)) for (const r of item.writeRels) next.delete(r);
    else for (const r of item.writeRels) next.add(r);
    sel.value = next;
};

/**
 * 清单是否已经全选。选择条上那个方块靠它出三态（空 / 半 / 满）。
 * 用 `counts.selected`（按卡算）而不是 `sel.size`（按 writeRel 算）：
 * 一张卡可能压着 8 个分卷，拿 writeRel 比会永远对不上。
 */
const allSelected = computed(() => items.value.length > 0 && counts.value.selected === items.value.length);

/**
 * 总控勾选的标准行为（checkbox group 那一套，零学习成本）：
 * 已全选 ⇒ 全不选；否则 ⇒ 全选。
 * 全选用 `targets` 全量 —— 与 `applyScanResult` 落盘那一刻的口径一致。
 */
const toggleAll = () => {
    if (selLocked.value) return;
    sel.value = allSelected.value ? new Set() : new Set(targets.value.map(t => t.writeRel));
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
    brokenCovers.value = new Set(); // 新的一批 = 新的一批链接，旧的失败标记不许带过来
    frameIndex.value = [];          // 先清空：回填是异步的，旧盘的帧绝不能挂在新清单上
    frameBusy.value = new Set();    // 在途标记也是"上一批"的：重扫后不清会永久转圈
    detachGrab();
    detachApply();
    detachFrame();
};

/**
 * 扫描。
 *
 * @param nextScope 这次要扫的范围（盘内相对路径，`''` = 整盘）。不传 = 沿用当前范围。
 *
 * ⚠️ 范围**只在扫描成功之后才提交**：`scope` 与 `scan` 是同一个视图的两个输入，
 *    分两拍写就会出现"标着 TEMP、清单却是整个盘"的错配（与 11-10「换屏过滤失效」
 *    同一个形态）。失败时两者都停在旧值 ⇒ 任何时刻都是自洽的。
 */
const runScan = async (nextScope?: string) => {
    // 任务在跑/暂停时不许重扫：重扫会把已抓到的结果整批顶掉
    if (isLiveJob(grabJob.value) || isLiveJob(applyJob.value) || isLiveJob(frameJob.value)) {
        notify('info', '先处理当前任务', '任务还在（暂停中），继续或终止它之后再重扫');
        return;
    }
    if (!faceMode.value && !selectedSerial.value) return;

    const want = nextScope ?? scope.value;
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
            const res = await postAction(`${API_BASE}/assistant/scan`, { serial: selectedSerial.value, relPath: want });
            applyScanResult(res as ScanResult);
            scope.value = want; // 与上面的清单同一拍落地（见 runScan 的注释）
        }
        // 清单出来之后再把"上次抽过的帧"贴回去（服务端 readdir，零读盘）
        await loadFrameIndex();
    } catch (e) {
        notify('error', faceMode.value ? '展开选中项失败' : '扫描失败', String(e));
    } finally {
        // 与头像面板同一条时间线：骨架留满一拍再换内容（见 assistant/scanBeat.ts）
        await holdScanBeat(startedAt);
        scanLoading.value = false;
        void checkOrphans(); // 提醒类动作，不阻塞面板
    }
};

const onDiskChange = (serial: string) => {
    selectedSerial.value = serial;
    // 范围属于「路径」，路径属于某块盘 —— 换盘后旧范围没有意义：
    // 留着它会让新盘扫出 0 条，看着像"这盘封面都齐了"（静默假象）
    scope.value = '';
    openScope.value = '';
    void runScan();
};

/** 深度重扫：把写入过的目录用实时清单（readdir+stat，不抽帧）复核后重出清单 */
/** 深度重扫前的确认 —— 统一走 Overlay 的 confirm（与头像写入同一份实现） */
const confirmDeepRescan = () => dialog.warning({
    title: '深度重扫',
    // 范围收窄后复核范围也跟着变 —— 不说清楚，用户会以为整盘都复核过了
    content: `把写入过的目录用实时清单复核一遍（只读文件名，不抽帧）。${scope.value ? `这次只复核「${scopeLabel.value}」及以下。` : '这次复核整个盘。'}确定吗？`,
    positiveText: '深度重扫',
    negativeText: '取消',
    onPositiveClick: () => deepRescan(),
});

const deepRescan = async () => {
    if (!selectedSerial.value || busy.value) return;
    try {
        const res = await postAction(`${API_BASE}/assistant/rebuild`, { serial: selectedSerial.value, relPath: scope.value });
        applyScanResult(res as ScanResult);
        // ⚠️ 必须回填：`applyScanResult` 会把 frameIndex 清空，而只有 runScan 会重新拉。
        //    漏了这一句，深度重扫之后已抽好的帧全从卡上消失、`counts.ready` 归零，
        //    用户会再抽一遍 —— 那是一次次真读移动硬盘。
        await loadFrameIndex();
        if (res.refreshed) notify('success', '深度重扫完成', `实时复核了 ${res.refreshed} 个目录`);
        else if (scan.value?.targets.length) notify('info', '深度重扫完成', '盘不在线或没有写入记录，结果来自缓存');
    } catch (e) {
        notify('error', '深度重扫失败', String(e));
    }
};

// ── 任务 ────────────────────────────────────────────────────
const startGrab = async (list?: ScanTargetLike[], appendTo?: string) => {
    if (isLiveJob(frameJob.value) || isLiveJob(applyJob.value)) {
        notify('info', '任务进行中', '请等待抽帧或写入结束后再开始抓取');
        return;
    }
    const picked = list ?? targets.value.filter(t => sel.value.has(t.writeRel));
    if (!picked.length) return;

    brokenCovers.value = new Set(); // 重抓会拿新链接，旧的"取不到"标记一律作废
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

/**
 * 抽帧的唯一启动口 —— **单卡「换一帧」与底栏批量共用它**（不写第二份）。
 *
 * · 传 `list` = 抽这一张（卡右上角点的）
 * · 不传 = 把所有"还没封面"的卡一次抽完
 * · 有已结束的抽帧任务就 `appendTo` 续进去：起新 job 会让卡上的结果行整批失效
 */
const startFrame = async (list?: ScanTargetLike[]) => {
    if (!selectedSerial.value) return;
    if (!canOperate.value) {
        notify('info', '这块盘现在不在线', '插上盘再抽帧');
        return;
    }
    // 写盘或抓取正在进行：避免争用与读写冲突
    if (isLiveJob(applyJob.value) || isLiveJob(grabJob.value)) {
        notify('info', '任务进行中', '请等待抓取或写入结束后再抽帧');
        return;
    }
    const picked = list ?? targets.value.filter(t =>
        items.value.some(i => actionOf(i, frameBusy.value) === 'frame' && i.writeRels.includes(t.writeRel)));
    if (!picked.length) return;

    // 单卡「换一帧」：立刻点亮（只有一两秒，等 800ms 轮询太久）。
    // 批量抽帧**不**走这条 —— 后端 job.inflight 会报"当前这一张"，否则一按下去几十张卡一起转
    if (list?.length) markBusy(picked.map(t => t.writeRel), true);
    try {
        const res = await postAction(`${API_BASE}/assistant/jobs`, {
            kind: 'frame',
            serial: selectedSerial.value,
            targets: picked,
            // 已有且已结束的抽帧任务 ⇒ 续进去（暂停/运行中的不续，服务端本来也会挡）
            ...(frameJob.value && !isLiveJob(frameJob.value) ? { appendTo: frameJob.value.id } : {}),
        });
        if (!res.jobId) {
            markBusy(picked.map(t => t.writeRel), false);
            notify('info', '没有可抽帧的目标', res.message || '');
            return;
        }
        if (res.reused) {
            // 接上的是**已有的**那个 job —— 这一批目标被服务端丢掉了，别假装它在抽
            markBusy(picked.map(t => t.writeRel), false);
            notify('info', '抽帧', res.message || '已接上正在跑的那个抽帧任务');
            return;
        }
        trackFrame(res.jobId);
    } catch (e) {
        markBusy(picked.map(t => t.writeRel), false);
        notify('error', '抽帧启动失败', String(e));
    }
};

const startApply = async () => {
    if (isLiveJob(applyJob.value)) return;
    if (isLiveJob(grabJob.value) || isLiveJob(frameJob.value)) return;
    const picks = items.value
        .filter(i => i.state === 'ok' && i.writeRels.some(r => sel.value.has(r)))
        .flatMap(i => i.writeRels);
    if (!picks.length) return;
    if (!canOperate.value) {
        notify('info', '这块盘现在不在线', '插上盘再写入');
        return;
    }

    // 抓取与抽帧**各是一个 job**：两个都要交给服务端，否则抽帧的结果永远写不进去。
    // 也可以一个都没有（重开面板后 job 已回收、盘上只剩回填的帧）—— 那种情况靠 targets 兜底。
    const jobIds = [grabJob.value?.id, frameJob.value?.id].filter((x): x is string => !!x);
    if (!jobIds.length && !targets.value.length) return;

    try {
        const res = await postAction(`${API_BASE}/assistant/apply`, {
            serial: selectedSerial.value,
            jobIds,
            picks,
            // 回填的帧（job 已回收的那种）服务端要靠 targets 自己捞出来，否则被静默漏掉
            targets: targets.value,
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

/**
 * 打开/关闭面板。
 *
 * @param presetPath 主界面的当前路径。给它在多盘机器上少一次手选：
 *   能推出序列号、且那块盘**在线** ⇒ 直接预选并扫它；推不出 / 离线 ⇒ 保持空白
 *   （主人 2026-11-10：「离线盘不带，还是和现在一样空白即可」）。
 */
const setShowModal = async (v: boolean, picks?: FacePick[], presetPath?: string) => {
    visible.value = v;
    if (!v) {
        detachGrab();
        detachApply();
        detachFrame();
        // 关面板时任务可能还在跑（job 在主进程）。在途标记必须一起清：
        // 重开时它已经不是 live job，`onFrameSettled` 再也不会触发 ⇒ 那张卡会永久转圈。
        frameBusy.value = new Set();
        facePicks.value = []; // 关面板就清掉挑选，否则下次从「补封面」进来会沿用
        scope.value = '';     // 范围跟着"从哪打开"走，绝不留上一次的
        openScope.value = '';
        return;
    }
    // 只有显式传了才覆盖（防"回声调用"把选择清掉）
    if (picks) facePicks.value = picks;
    // 每次打开都重算范围：漏了这句，第二次从别处进来会沿用上一次的目录
    scope.value = '';
    openScope.value = '';

    await loadDisks();

    // 自动带盘：只在「补封面」（没有 picks）时做。
    // ⚠️ 不能加 `&& !selectedSerial` —— 那会让它只在本次会话第一次打开时成立，
    //    之后从哪块盘右键都还停在上一次的盘上（对着 E 盘操作、动的却是 D 盘）。
    if (!picks?.length && presetPath) {
        const ctx = await resolveDriveContext({ currentPath: presetPath });
        const online = ctx.serial && disks.value.find(d => d.serial === ctx.serial)?.online !== false;
        if (online) {
            selectedSerial.value = ctx.serial;
            // 站在哪就补哪：主界面在某个子目录里点进来，范围就是那个子目录（含其子树）。
            // 离线盘不带范围（本来也不预选盘），保持空白。
            // `scope` 由下面的 `runScan(openScope)` 在扫描成功后提交，这里只记"打开时在哪"。
            openScope.value = ctx.relPath;
        }
    }

    // 面板关了任务还在跑（job 活在主进程内存里）：重开时挂回去，
    // 不然用户会以为关闭 = 任务没了。**暂停中的也要挂**。
    let attached = false;
    try {
        const res = await getAction(`${API_BASE}/assistant/jobs`);
        const live = (res.jobs as JobSnapshot[]).find(j =>
            (j.kind === 'grab' || j.kind === 'apply' || j.kind === 'frame') && isLiveJob(j));
        if (live) {
            if (live.kind === 'grab') trackGrab(live.id);
            else if (live.kind === 'frame') trackFrame(live.id);
            else trackApply(live.id);
            attached = true;
        }
    } catch {
        // 没有任务 / 服务没起来都无所谓，走正常流程
    }

    // 没有在跑的任务就必须重算清单：否则第二次打开会显示上一次的清单
    //（跨模式、换盘重开都要重算）
    if (!attached) await runScan(openScope.value);
};

defineExpose({ setShowModal });
</script>
