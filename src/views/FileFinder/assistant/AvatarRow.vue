<template>
    <div
        class="ffw-row"
        :class="{ 'is-sel': row.selected }"
        :data-state="row.state"
        :style="{ animationDelay: `${Math.min(index, 14) * 24}ms` }"
        tabindex="0"
    >
        <button
            type="button"
            class="ffw-row__check"
            :disabled="locked || !row.avatarUrl"
            v-tip="checkTitle"
            @click="emit('toggle')"
        >
            <n-icon :component="CheckmarkOutline" :size="11" />
        </button>

        <div class="ffw-row__face">
            <!-- 匹配中必须把旧头像摘掉，否则旧图会和点阵叠在一起（重查已匹配的行时会看到） -->
            <n-image
                v-if="avatarSrc && row.state !== 'matching'"
                class="ffw-row__avatar"
                :src="avatarSrc"
                :preview-src="avatarSrc"
                width="48"
                height="48"
                object-fit="cover"
                :img-props="{ style: 'cursor: zoom-in' }"
            />
            <DotField v-if="row.state === 'matching'" :active="true" />
            <n-icon v-else-if="!avatarSrc" :component="PersonOutline" :size="15" />
        </div>

        <div class="ffw-row__text">
            <div class="ffw-row__name" :title="row.folderName">{{ row.folderName }}</div>
            <div class="ffw-row__path" :title="row.message || row.relDir">{{ row.message || row.relDir }}</div>
        </div>

        <input
            class="ffw-field"
            :value="row.cleanName"
            placeholder="名字"
            aria-label="识别名"
            @change="onRename"
            @keydown.enter.passive="emit('recheck')"
        />

        <div class="ffw-row__state">
            <span class="ffw-state" :class="stateTone(row.state)">
                <n-icon
                    v-if="row.state === 'matched' || row.state === 'written'"
                    :component="CheckmarkOutline"
                    :size="12"
                />
                <n-icon v-else-if="row.state === 'miss'" :component="HelpOutline" :size="12" />
                <span class="ffw-state__text">{{ stateText(row.state) }}</span>
                <span v-if="row.source" class="ffw-state__src">
                    · {{ row.source === 'javbus' ? 'JavBus' : 'Gfriends' }}
                </span>
            </span>
        </div>

        <div class="ffw-row__act">
            <n-popover trigger="click" placement="bottom-end" :show-arrow="false">
                <template #trigger>
                    <button type="button" class="ffw-btn ffw-btn--ghost">换图</button>
                </template>
                <div class="ffw-manual">
                    <div class="ffw-manual__label">粘贴图片直链：</div>
                    <input
                        class="ffw-field"
                        :value="row.manualUrl"
                        placeholder="https://…"
                        @input="onManualInput"
                    />
                    <div class="ffw-manual__foot">
                        <button type="button" class="ffw-btn ffw-btn--primary" @click="emit('manual-apply')">应用链接</button>
                    </div>
                </div>
            </n-popover>
        </div>
    </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { NIcon, NImage, NPopover } from 'naive-ui';
import { CheckmarkOutline, HelpOutline, PersonOutline } from '@vicons/ionicons5';
import DotField from '@/components/DotField/DotField.vue';
import { stateText, stateTone } from './avatarModel';
import type { AvatarRow } from './avatarModel';

/**
 * 一行 = 一个待补头像的目录。
 * 「换图」留在行内（不再多一层弹窗）—— 用户改的是一个具体的行，
 * 让他回到那行去改，比让他回到一个全局面板快。
 */
const props = defineProps<{ row: AvatarRow; avatarSrc: string; locked: boolean; index: number }>();

/**
 * 没有图的行**不许勾**：勾了也写不进去（`selectedWithImage` 会把它过滤掉），
 * 只会让"写入 N 个"的数字和实际动作对不上（2026-11-08 主人问「未找到为什么还能勾」）。
 */
const checkTitle = computed(() => {
    if (props.locked) return '任务进行中，先暂停或终止';
    if (!props.row.avatarUrl) return '没有匹配到图，不能写入';
    return props.row.selected ? '取消选择' : '选择';
});

const onRename = (e: Event) => emit('rename', (e.target as HTMLInputElement).value);
const onManualInput = (e: Event) => emit('manual-input', (e.target as HTMLInputElement).value);

const emit = defineEmits<{
    toggle: [];
    rename: [name: string];
    recheck: [];
    'manual-input': [url: string];
    'manual-apply': [];
}>();
</script>

<style scoped>
.ffw-row__act {
    display: flex;
    justify-content: flex-end;
}

.ffw-manual {
    width: 280px;
    display: flex;
    flex-direction: column;
    gap: 8px;
}

.ffw-manual__label {
    font-size: var(--ff-fs-meta);
    color: var(--ff-text-2);
}

.ffw-manual__foot {
    display: flex;
    justify-content: flex-end;
}
</style>
