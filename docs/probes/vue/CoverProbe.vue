<template>
    <n-config-provider :theme="darkTheme" :theme-overrides="overrides">
        <AssistantShell title="补封面">
            <template #meta>
                目标 <b>E:</b>
                <i />
                待抓 <b>3</b>
                <i />
                已抓到 <b>3</b>
                <i />
                选中 <b>3</b>
            </template>

            <div class="ffw-grid">
                <CoverCard
                    v-for="(item, i) in items"
                    :key="item.key"
                    :item="item"
                    :index="i"
                    :selected="item.state === 'ok'"
                    :locked="false"
                    :cover-src="item.coverUrl || ''"
                />
            </div>

            <template #dock>
                <TaskDock phase="run" :ratio="0.38" status="抓取中 3 / 8" detail="逐部查站点，命中一张就地长出来">
                    <template #actions>
                        <button type="button" class="ffw-btn">暂停</button>
                        <button type="button" class="ffw-btn ffw-btn--danger">终止</button>
                    </template>
                </TaskDock>
            </template>
        </AssistantShell>
    </n-config-provider>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { NConfigProvider, darkTheme } from 'naive-ui';
import AssistantShell from '/src/views/FileFinder/assistant/AssistantShell.vue';
import CoverCard from '/src/views/FileFinder/assistant/CoverCard.vue';
import TaskDock from '/src/views/FileFinder/assistant/TaskDock.vue';
import type { CoverItem } from '/src/views/FileFinder/assistant/coverModel';
import { useNaiveOverrides } from '/src/styles/naive-theme';

const overrides = useNaiveOverrides();

const COVER =
    'data:image/svg+xml;utf8,' +
    encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#4a5568"/><stop offset="1" stop-color="#1f242b"/></linearGradient></defs><rect width="300" height="200" fill="url(#g)"/></svg>',
    );

const mk = (i: number, state: CoverItem['state']): CoverItem => ({
    key: 'k' + i,
    kind: 'file',
    title: `[STUDIO] 样本${i} - DEMO-${String(i).padStart(3, '0')}`,
    path: `分类A/子类/DEMO-${String(i).padStart(3, '0')}`,
    kindText: '覆盖',
    writeRels: [`分类A/子类/DEMO-${String(i).padStart(3, '0')}/cover.jpg`],
    state,
    badge: state === 'ok' ? 'JavBus' : state === 'miss' ? '未找到' : '',
    coverUrl: state === 'ok' ? COVER : null,
});

const items = ref<CoverItem[]>([
    mk(1, 'pending'),
    mk(2, 'ok'),
    mk(3, 'pending'),
    mk(4, 'miss'),
    mk(5, 'ok'),
    mk(6, 'pending'),
    mk(7, 'ok'),
    mk(8, 'miss'),
    mk(9, 'ok'),
    mk(10, 'pending'),
]);
</script>
