<template>
    <aside class="rail">
        <div class="rail-group">
            <n-tooltip v-for="it in RAIL_ITEMS" :key="it.key" placement="right">
                <template #trigger>
                    <button type="button" class="rail-item" :class="{ 'is-active': active === it.key }"
                        :aria-label="it.label" @click="$emit('select', it.key)">
                        <n-icon :size="22" :component="it.icon" />
                    </button>
                </template>
                {{ it.label }}
            </n-tooltip>
        </div>

        <div class="rail-group">
            <n-tooltip placement="right">
                <template #trigger>
                    <button type="button" class="rail-item" :class="{ 'is-active': active === 'settings' }"
                        aria-label="设置" @click="$emit('select', 'settings')">
                        <n-icon :size="21" :component="SettingsOutline" />
                    </button>
                </template>
                设置（站点规则）
            </n-tooltip>

            <n-tooltip placement="right">
                <template #trigger>
                    <button type="button" class="rail-item" :aria-label="isDark ? '切到浅色' : '切到深色'"
                        @click="$emit('toggle-theme')">
                        <n-icon :size="20" :component="isDark ? SunnyOutline : MoonOutline" />
                    </button>
                </template>
                {{ isDark ? '切到浅色' : '切到深色' }}
            </n-tooltip>
        </div>
    </aside>
</template>

<script setup lang="ts">
/**
 * 左导航轨 —— B 站那一列的骨架。
 *
 * 上面 = 内容目的地（文件 / 清单 / 缓存），下面 = 设置 + 主题。
 * 「更多」「刷新」「换封面」这类**跟当前这一层数据绑定**的动作留在文件页头部 ——
 * 把层级不同的东西塞进同一条轨，用户就得先想"这个按钮作用于谁"。
 */
import { NIcon, NTooltip } from 'naive-ui';
import { MoonOutline, SettingsOutline, SunnyOutline } from '@vicons/ionicons5';
import { RAIL_ITEMS } from './nav';
import type { RailKey } from './nav';

defineProps<{
    active: RailKey;
    isDark: boolean;
}>();

defineEmits<{
    (e: 'select', key: RailKey): void;
    (e: 'toggle-theme'): void;
}>();
</script>

<style scoped lang="less">
.rail {
    flex: 0 0 var(--ff-rail-w);
    width: var(--ff-rail-w);
    height: 100%;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    align-items: center;
    padding: 14px 0;
    box-sizing: border-box;
    background: var(--ff-surface);
}

.rail-group {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
}

.rail-item {
    width: 44px;
    height: 44px;
    display: grid;
    place-items: center;
    border: 0;
    padding: 0;
    border-radius: var(--ff-radius-ctl);
    background: transparent;
    color: var(--ff-text-2);
    cursor: pointer;
    transition: background-color 0.15s ease, color 0.15s ease;

    &:hover {
        background: var(--ff-fill);
        color: var(--ff-text-1);
    }

    /* 选中 = 粉色图标 + 极淡粉底（B 站只用颜色表达位置，不做整块高亮） */
    &.is-active {
        background: var(--ff-pink-weak);
        color: var(--ff-pink);
    }
}
</style>
