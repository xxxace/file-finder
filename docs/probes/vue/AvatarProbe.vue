<template>
    <n-config-provider :theme="darkTheme" :theme-overrides="overrides">
        <AssistantShell title="头像回收">
            <template #meta>
                目标 <b>E:</b>
                <i />
                待处理 <b>4</b>
                <i />
                已匹配 <b>1</b>
                <i />
                选中 <b>1</b>
            </template>

            <template #tools>
                <n-select
                    class="ffw-select"
                    :value="source"
                    :options="sourceOptions"
                    :theme-overrides="TOOLBAR_SELECT"
                    size="small"
                    style="width: 168px"
                />
                <button type="button" class="ffw-btn ffw-btn--ghost">扫描</button>
            </template>

            <div class="ffw-rows">
                <AvatarRowItem
                    v-for="(row, i) in rows"
                    :key="row.relDir"
                    :row="row"
                    :index="i"
                    :avatar-src="row.avatarUrl || ''"
                    :locked="false"
                    @toggle="row.selected = !row.selected"
                    @rename="(v: string) => (row.cleanName = v)"
                />
            </div>

            <template #dock>
                <TaskDock phase="idle" :ratio="0" status="已选 1 / 已匹配 1" detail="写入 avatar.jpg，旧头像自动备份">
                    <template #actions>
                        <button type="button" class="ffw-btn ffw-btn--ghost">仅选已匹配</button>
                        <button type="button" class="ffw-btn ffw-btn--primary">开始匹配 4 个</button>
                    </template>
                </TaskDock>
            </template>
        </AssistantShell>
    </n-config-provider>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { NConfigProvider, NSelect, darkTheme } from 'naive-ui';
import AssistantShell from '/src/views/FileFinder/assistant/AssistantShell.vue';
import AvatarRowItem from '/src/views/FileFinder/assistant/AvatarRow.vue';
import TaskDock from '/src/views/FileFinder/assistant/TaskDock.vue';
import { TOOLBAR_SELECT } from '/src/views/FileFinder/assistant/toolbarSelect';
import type { AvatarRow } from '/src/views/FileFinder/assistant/avatarModel';
// ⚠️ 必须带上应用自己的主题覆盖，否则截图和真机是两套配色（勾选色/按钮色都不一样）——
// 那这份探针就没有意义了。
import { useNaiveOverrides } from '/src/styles/naive-theme';

const overrides = useNaiveOverrides();

const source = ref<'javbus' | 'gfriends'>('javbus');
const sourceOptions = [
    { label: 'JavBus 官方写真', value: 'javbus' },
    { label: 'Gfriends 社区库', value: 'gfriends' },
];

/** 内联渐变当"已匹配的头像"，不依赖网络 */
const AVATAR =
    'data:image/svg+xml;utf8,' +
    encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#5b6472"/><stop offset="1" stop-color="#2a2e35"/></linearGradient></defs><rect width="96" height="96" fill="url(#g)"/></svg>',
    );

const base = {
    matchedName: null as string | null,
    avatarUrl: null as string | null,
    selected: false,
    manualUrl: '',
    message: '',
};

const rows = ref<AvatarRow[]>([
    { ...base, relDir: '人物/样本甲', folderName: '[STUDIO] 样本甲', cleanName: '样本甲', state: 'pending' },
    {
        ...base,
        relDir: '人物/样本乙',
        folderName: '[STUDIO] 样本乙',
        cleanName: '样本乙',
        state: 'matched',
        selected: true,
        matchedName: '样本乙',
        avatarUrl: AVATAR,
        source: 'javbus',
    },
    {
        ...base,
        relDir: '人物/样本丁',
        folderName: '[STUDIO] 样本丁',
        cleanName: '样本丁',
        state: 'matching',
    },
    {
        ...base,
        relDir: '人物/样本丙',
        folderName: '[STUDIO] 样本丙',
        cleanName: '样本丙',
        state: 'miss',
        message: 'JavBus 与 Gfriends 都没有收录',
    },
]);
</script>
