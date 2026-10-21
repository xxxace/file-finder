<template>
    <!-- 「加入清单…」选单（右键卡片 → 第二级浮层）。YouTube「Save to playlist」同款：
         现有清单置顶（默认清单带 ★、已收录打 ✓），底部直接建新单并加入。 -->
    <div class="pl-picker">
        <!-- 已收录的行**禁用**（打 ✓）：允许再点一次就是给"重复条目"开口子 -->
        <n-button v-for="pl in index.playlists" :key="pl.id" size="small" block class="pl-row"
            :disabled="pl.keys.includes(itemKey)" @click="pick(pl)">
            <span class="pl-row-name">{{ pl.system ? '★ ' : '' }}{{ pl.name }}</span>
            <span class="pl-row-count">{{ pl.count }}</span>
            <b v-if="pl.keys.includes(itemKey)" class="pl-row-check" title="已在这个收藏夹里">✓</b>
        </n-button>
        <div class="pl-new">
            <n-input v-model:value="newName" size="small" placeholder="新收藏夹名称" clearable @keyup.enter="createAndAdd" />
            <n-button size="small" type="primary" :disabled="!newName.trim()" @click="createAndAdd">新建并加入</n-button>
        </div>
    </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { NButton, NInput } from 'naive-ui';
import { addToPlaylist, createPlaylist, playlistIndex } from './playlist';
import type { PlaylistSummary } from './playlist';
import type { CardSnapshot } from '../../../electron/server/playlist';

const props = defineProps<{
    /** 要加入的卡片快照（服务端据此推导盘身份） */
    card: CardSnapshot;
    /** 该卡片当前形态的 key —— 用来给已收录的清单打 ✓ */
    itemKey: string;
}>();
const emit = defineEmits<{
    (e: 'added', name: string): void;
    (e: 'failed', message: string): void;
}>();

const index = playlistIndex();
const newName = ref('');
const card = computed(() => props.card);

const pick = async (pl: PlaylistSummary) => {
    try {
        await addToPlaylist(pl.id, card.value);
        emit('added', pl.name);
    } catch (e) {
        emit('failed', String(e));
    }
};

const createAndAdd = async () => {
    const name = newName.value.trim();
    if (!name) return;
    try {
        const created = await createPlaylist(name);
        if (created) await addToPlaylist(created.id, card.value);
        emit('added', name);
    } catch (e) {
        emit('failed', String(e));
    }
};
</script>

<style lang="less" scoped>
.pl-picker {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 200px;
    max-width: 280px;

    .pl-row {
        justify-content: flex-start;

        :deep(.n-button__content) {
            width: 100%;
            justify-content: flex-start;
        }
    }

    .pl-row-name {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        text-align: left;
    }

    .pl-row-count {
        opacity: 0.55;
        font-size: 12px;
        margin-right: 6px;
    }

    .pl-row-check {
        color: #18a058;
    }

    .pl-new {
        display: flex;
        gap: 6px;
        margin-top: 4px;
        padding-top: 8px;
        border-top: 1px solid #ececec;
    }
}
</style>
