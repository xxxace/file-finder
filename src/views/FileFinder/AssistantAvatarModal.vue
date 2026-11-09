<template>
    <n-modal
        :show="show"
        preset="card"
        :closable="false"
        :mask-closable="!busy"
        :close-on-esc="!busy"
        style="width: 100vw; height: 100vh"
        content-style="padding: 0; height: 100%"
        @update:show="onShowChange"
    >
        <AssistantShell title="头像回收" :busy="busy" @close="onShowChange(false)">
            <template #meta>
                目标 <b :title="scopeLabel">{{ scopeLabel }}</b>
                <i />
                待处理 <b>{{ counts.total }}</b>
                <i />
                已匹配 <b>{{ counts.matched }}</b>
                <i />
                选中 <b>{{ counts.selected }}</b>
            </template>

            <template #tools>
                <n-select
                    class="ffw-select"
                    :value="activeSource"
                    :options="sourceOptions"
                    :theme-overrides="TOOLBAR_SELECT"
                    size="small"
                    style="width: 168px"
                    :disabled="busy"
                    @update:value="onSourceChange"
                />
                <button
                    v-if="activeSource === 'gfriends'"
                    type="button"
                    class="ffw-btn ffw-btn--ghost"
                    :disabled="busy"
                    @click="updateIndex"
                >
                    {{ updatingIndex ? '更新中…' : '更新索引' }}
                </button>
                <button type="button" class="ffw-btn ffw-btn--ghost" :disabled="busy || !activeIsOnline" @click="rescan">
                    <n-icon :component="RefreshOutline" :size="13" />
                    扫描
                </button>
            </template>

            <div v-if="!activeIsOnline" class="ffw-notice">
                <n-icon :component="CloudOfflineOutline" :size="14" />
                磁盘离线，只能查看缓存；写入前请先接上移动硬盘
            </div>

            <SkeletonList v-if="scanning" variant="row" :count="10" />

            <div v-else-if="!rows.length" class="ffw-empty">
                <div>
                    <b>{{ hasScanned ? '这一层没有缺头像的人物目录' : '还没开始查' }}</b>
                    <template v-if="hasScanned">
                        已自动排除已有头像的目录，以及能识别为影片番号的目录
                    </template>
                    <template v-else>点右上角「扫描」列出这一层缺头像的人物目录</template>
                </div>
            </div>

            <div v-else class="ffw-rows">
                <AvatarRowItem
                    v-for="(row, i) in rows"
                    :key="row.relDir"
                    :row="row"
                    :index="i"
                    :avatar-src="row.avatarUrl ? previewSrc(row.avatarUrl) : ''"
                    :locked="rowLocked"
                    @toggle="toggleRow(row)"
                    @rename="onRename(row, $event)"
                    @recheck="recheck(row)"
                    @manual-input="onManualInput(row, $event)"
                    @manual-apply="applyManual(row)"
                />
            </div>

            <template #dock>
                <TaskDock
                    :phase="task.phase"
                    :ratio="task.ratio"
                    :status="task.status"
                    :detail="task.detail"
                    :celebrate="celebrate"
                >
                    <template #actions>
                        <template v-if="task.mode === 'match'">
                            <button type="button" class="ffw-btn" @click="matcher.pause()">
                                <n-icon :component="PauseOutline" :size="13" /> 暂停
                            </button>
                            <button type="button" class="ffw-btn ffw-btn--danger" @click="matcher.stop()">
                                <n-icon :component="StopOutline" :size="13" /> 终止
                            </button>
                        </template>

                        <template v-else-if="task.mode === 'match-pause'">
                            <button type="button" class="ffw-btn ffw-btn--primary" @click="matcher.resume()">
                                <n-icon :component="PlayOutline" :size="13" /> 继续
                            </button>
                            <button type="button" class="ffw-btn ffw-btn--danger" @click="matcher.stop()">
                                <n-icon :component="StopOutline" :size="13" /> 终止
                            </button>
                        </template>

                        <template v-else-if="task.mode === 'apply'">
                            <button type="button" class="ffw-btn ffw-btn--danger" :disabled="!!applyActing" @click="stopApply">
                                <n-icon :component="StopOutline" :size="13" /> 终止
                            </button>
                        </template>

                        <template v-else-if="task.mode === 'apply-done'">
                            <button type="button" class="ffw-btn ffw-btn--ghost" @click="rescan">扫描</button>
                            <button type="button" class="ffw-btn ffw-btn--primary" @click="onShowChange(false)">完成</button>
                        </template>

                        <template v-else-if="!matchStarted">
                            <button type="button" class="ffw-btn ffw-btn--primary" :disabled="!rows.length" @click="startMatch">
                                开始匹配 {{ rows.length }} 个
                                <n-icon :component="ArrowForwardOutline" :size="13" />
                            </button>
                        </template>

                        <template v-else>
                            <button type="button" class="ffw-btn ffw-btn--ghost" :disabled="rowLocked" @click="toggleSelectAll">
                                {{ allSelected ? '取消全选' : '全选' }}
                            </button>
                            <button type="button" class="ffw-btn ffw-btn--ghost" :disabled="!matchedCount || rowLocked" @click="selectMatchedOnly">
                                仅选已匹配
                            </button>
                            <button
                                type="button"
                                class="ffw-btn ffw-btn--primary"
                                :disabled="!counts.selected || !activeIsOnline"
                                @click="confirmApply"
                            >
                                写入 {{ counts.selected }} 个头像
                                <n-icon :component="ArrowForwardOutline" :size="13" />
                            </button>
                        </template>
                    </template>
                </TaskDock>
            </template>
        </AssistantShell>
    </n-modal>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { NModal, NSelect, NIcon } from 'naive-ui';
import useConfirm from '@/hooks/useConfirm';
import {
    ArrowForwardOutline,
    CloudOfflineOutline,
    PauseOutline,
    PlayOutline,
    RefreshOutline,
    StopOutline,
} from '@vicons/ionicons5';
import { API_BASE, apiUrl, postAction } from '@/utils/request';
import useNotify from '@/hooks/useNotify';
import AssistantShell from './assistant/AssistantShell.vue';
import TaskDock from './assistant/TaskDock.vue';
import AvatarRowItem from './assistant/AvatarRow.vue';
import SkeletonList from './assistant/SkeletonList.vue';
import { buildAvatarTask, countRows, selectedWithImage } from './assistant/avatarModel';
import type { AvatarRow } from './assistant/avatarModel';
import { TOOLBAR_SELECT } from './assistant/toolbarSelect';
import { holdScanBeat } from './assistant/scanBeat';
import { resolveDriveContext } from './assistant/driveContext';
import type { JobSnapshot } from './assistant/jobTypes';
import { isLiveJob } from './assistant/jobTypes';
import { useAssistantJob } from './assistant/useAssistantJob';
import { useAvatarMatcher } from './assistant/useAvatarMatcher';

const previewSrc = (url: string) => apiUrl(`${API_BASE}/assistant/preview?url=${encodeURIComponent(url)}`);

const props = withDefaults(
    defineProps<{
        show: boolean;
        currentPath?: string;
        serial?: string;
        relPath?: string;
        isOnline?: boolean;
    }>(),
    { currentPath: '', serial: '', relPath: '', isOnline: true },
);

const emit = defineEmits<{ (e: 'update:show', v: boolean): void; (e: 'applied'): void }>();
const notify = useNotify();
const dialog = useConfirm();

const activeSource = ref<'javbus' | 'gfriends'>('javbus');
/**
 * ⚠️ 标签要短：168px、12px 字号下，11 个汉字就会被 naive 折成 "（…）"，
 * 而截断的下拉在工具条里更像"坏了"。（"推荐"不再标注 —— 它本来就是默认值。）
 */
const sourceOptions = [
    { label: 'JavBus 官方写真', value: 'javbus' },
    { label: 'Gfriends 社区库', value: 'gfriends' },
];

const rows = ref<AvatarRow[]>([]);
const scanning = ref(false);
const hasScanned = ref(false);
const updatingIndex = ref(false);
const celebrate = ref(false);

const activeSerial = ref('');
const activeRelPath = ref('');
const activeIsOnline = ref(true);

const matcher = useAvatarMatcher();
const { job: applyJob, acting: applyActing, track: trackApply, stop: stopApply, detach: detachApply } =
    useAssistantJob(onApplySettled, msg => notify('error', '操作没生效', msg));

const busy = computed(() =>
    scanning.value || matcher.live.value || applyJob.value?.status === 'running' || applyJob.value?.status === 'paused');

const counts = computed(() => countRows(rows.value));
const scopeLabel = computed(() => {
    if (props.currentPath) return props.currentPath;
    const rel = activeRelPath.value ? `/${activeRelPath.value}` : '';
    return activeSerial.value ? `${activeSerial.value}${rel}` : '当前目录';
});
const allSelected = computed(() => rows.value.length > 0 && rows.value.every(r => r.selected));
/** 匹配是否跑过（决定底栏是"开始匹配"还是"写入"） */
const matchStarted = computed(() => matcher.total.value > 0);
const matchedCount = computed(() => rows.value.filter(r => r.state === 'matched').length);
const task = computed(() => buildAvatarTask(
    { live: matcher.live.value, paused: matcher.paused.value, stopped: matcher.stopped.value, done: matcher.done.value, total: matcher.total.value },
    applyJob.value ? { status: applyJob.value.status, processed: applyJob.value.progress.processed, total: applyJob.value.progress.total } : null,
    counts.value,
));

// ── 行操作 ──────────────────────────────────────────────────
/** 匹配/写入进行中 ⇒ 锁住勾选（匹配会自己勾，写入队列也已经发出去了） */
const rowLocked = computed(() => matcher.live.value || isLiveJob(applyJob.value));

const toggleRow = (row: AvatarRow) => {
    if (rowLocked.value) return;
    // 没有图就没东西可写：勾上只会让"写入 N 个"和实际动作对不上
    if (!row.avatarUrl) {
        notify('info', '这一行没有图', '先匹配或手动填一张，才能勾选写入');
        return;
    }
    row.selected = !row.selected;
};

const onRename = (row: AvatarRow, name: string) => {
    row.cleanName = name.trim();
};

const onManualInput = (row: AvatarRow, url: string) => {
    row.manualUrl = url;
};

const selectMatchedOnly = () => {
    if (rowLocked.value) return;
    for (const row of rows.value) row.selected = row.state === 'matched';
};

const toggleSelectAll = () => {
    if (rowLocked.value) return;
    const next = !allSelected.value;
    for (const row of rows.value) row.selected = next && !!row.avatarUrl;
};

/** 显式触发匹配（不跟扫描绑在一起：这一步联网，得由用户决定什么时候开始） */
const startMatch = () => {
    if (!rows.value.length || matcher.live.value) return;
    void matcher.run(rows.value, activeSource.value);
};

/** 改了名字就重查这一个（Enter / 失焦触发） */
const recheck = async (row: AvatarRow) => {
    if (!row.cleanName) return;
    row.state = 'matching';
    const outcome = await matcher.rematch(row, activeSource.value);
    if (outcome === 'matched') notify('success', '已匹配', row.matchedName || row.cleanName);
    else notify('info', '没找到', `${row.cleanName}：可以改个写法，或手动填图`);
};

const applyManual = (row: AvatarRow) => {
    const url = row.manualUrl.trim();
    if (!url) {
        notify('warning', '请输入图片直链');
        return;
    }
    row.avatarUrl = url;
    row.state = 'matched';
    row.matchedName = row.cleanName || '自定义头像';
    row.message = '';
    row.selected = true;
};

// ── 扫描 / 匹配 ─────────────────────────────────────────────
const rescan = async () => {
    if (!activeSerial.value || !activeIsOnline.value) return;
    matcher.reset();
    detachApply();
    const startedAt = performance.now();
    scanning.value = true;
    hasScanned.value = true;
    try {
        const res = await postAction(`${API_BASE}/assistant/avatar/scan`, {
            serial: activeSerial.value,
            relPath: activeRelPath.value,
        });
        if (res.code !== 200) {
            notify('error', '扫描失败', res.error || '');
            return;
        }
        rows.value = ((res.candidates ?? []) as { relDir: string; folderName: string; cleanName: string }[])
            .map(c => ({
                relDir: c.relDir,
                folderName: c.folderName,
                cleanName: c.cleanName,
                matchedName: null,
                avatarUrl: null,
                state: 'pending' as const,
                selected: false,
                manualUrl: '',
                message: '',
            }));
    } catch (e) {
        notify('error', '扫描请求出错', String(e));
    } finally {
        // 骨架留满一拍再换行：否则扫盘 30ms 返回，骨架闪一帧就没了（见 scanBeat.ts）
        await holdScanBeat(startedAt);
        scanning.value = false;
    }
};

const updateIndex = async () => {
    updatingIndex.value = true;
    try {
        const res = await postAction(`${API_BASE}/assistant/avatar/index-update`, {});
        if (res.code === 200) {
            notify('success', '索引已更新', `收录 ${res.actorCount || 0} 位`);
            if (rows.value.length) await rescan();
        } else {
            notify('error', '更新索引失败', res.error || '');
        }
    } catch (e) {
        notify('error', '更新索引出错', String(e));
    } finally {
        updatingIndex.value = false;
    }
};

const onSourceChange = (value: 'javbus' | 'gfriends') => {
    activeSource.value = value;
    if (hasScanned.value && activeSerial.value) void rescan();
};

// ── 写入 ────────────────────────────────────────────────────
/** 写入前的确认 —— 统一走 Overlay 的 confirm（旧 n-popconfirm 是全站唯一漏网的旧样式） */
const confirmApply = () => dialog.warning({
    title: '写入头像',
    content: `为这 ${counts.value.selected} 个目录下载并写入 avatar.jpg，已有旧头像会先备份。确定吗？`,
    positiveText: '写入',
    negativeText: '取消',
    onPositiveClick: () => startApply(),
});

const startApply = async () => {
    const items = selectedWithImage(rows.value).map(r => ({ relDir: r.relDir, avatarUrl: r.avatarUrl! }));
    if (!items.length) {
        notify('warning', '没有可写入的头像');
        return;
    }
    try {
        const res = await postAction(`${API_BASE}/assistant/jobs`, {
            kind: 'avatar',
            serial: activeSerial.value,
            items,
        });
        if (!res.jobId) {
            notify('info', '没有可写入的头像', res.message || '');
            return;
        }
        if (res.reused) notify('info', '写入', res.message || '上一次写入还没结束');
        trackApply(res.jobId);
    } catch (e) {
        notify('error', '写入启动失败', String(e));
    }
};

/** 每拍把 job 的行贴回对应的界面行：绿一个是一个，不等到整批结束 */
watch(
    () => applyJob.value?.rows,
    (list) => {
        if (!list?.length) return;
        const byRel = new Map(rows.value.map(r => [r.relDir, r]));
        for (const r of list as { relDir: string; ok: boolean; message: string }[]) {
            const row = byRel.get(r.relDir);
            if (!row) continue;
            row.state = r.ok ? 'written' : 'writefail';
            row.message = r.message;
            if (r.ok) row.selected = false;
        }
    },
);

function onApplySettled(job: JobSnapshot): void {
    emit('applied');
    if (job.status === 'done') {
        celebrate.value = true;
        setTimeout(() => (celebrate.value = false), 680);
    }
    if (job.status === 'error') notify('error', '写入失败', job.message);
    else if (job.status === 'cancelled') notify('info', '写入已终止', job.message);
    else notify('success', '写入完成', job.message);
}

// ── 开关 ────────────────────────────────────────────────────
const onShowChange = (v: boolean) => {
    emit('update:show', v);
};

watch(
    () => props.show,
    async (open) => {
        if (!open) {
            matcher.reset();
            detachApply();
            return;
        }
        hasScanned.value = false;
        rows.value = [];
        matcher.reset();
        const ctx = await resolveDriveContext({
            serial: props.serial || undefined,
            relPath: props.relPath,
            isOnline: props.isOnline,
            currentPath: props.currentPath,
        });
        activeSerial.value = ctx.serial;
        activeRelPath.value = ctx.relPath;
        activeIsOnline.value = ctx.online;
        // ⚠️ **不在打开时自动查**（2026-11-08 主人要求）：
        // 打开面板只解析盘上下文，扫描与匹配都由「扫描 / 开始匹配」显式触发 ——
        // 这一步会联网，不该在他只是看一眼的时候偷偷跑。
    },
);
</script>
