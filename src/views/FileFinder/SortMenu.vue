<template>
    <n-dropdown trigger="click" :options="options" :disabled="disabled" :menu-props="menuProps" @select="onSelect">
        <n-button size="small" :disabled="disabled" :class="{ 'is-on': isCustom }"
            v-tip="`排序：${currentLabel}`" :aria-label="`排序：${currentLabel}`">
            <template #icon>
                <n-icon :component="buttonIcon" />
            </template>
        </n-button>
    </n-dropdown>
</template>

<script setup lang="ts">
import { computed, h } from 'vue';
import type { Component } from 'vue';
import { NButton, NDropdown, NIcon } from 'naive-ui';
import type { DropdownMenuProps, DropdownOption } from 'naive-ui';
import { SwapVerticalOutline } from '@vicons/ionicons5';
import {
    SortDiskAsc24,
    SortDiskDesc24,
    SortNameAsc24,
    SortNameDesc24,
    SortSizeAsc24,
    SortSizeDesc24,
} from '@/components/icons/sort';
import { playSfx } from '@/utils/sfx';

export type SortMode =
    | 'default'
    | 'name-asc'
    | 'name-desc'
    | 'size-desc'
    | 'size-asc'
    | 'disk-asc'
    | 'disk-desc';

interface SortItem {
    key: SortMode;
    label: string;
    icon: Component;
    globalOnly?: boolean;
}

const SORT_ITEMS: ReadonlyArray<SortItem> = [
    { key: 'default', label: '默认顺序', icon: SwapVerticalOutline },
    { key: 'name-asc', label: '名称 A → Z', icon: SortNameAsc24 },
    { key: 'name-desc', label: '名称 Z → A', icon: SortNameDesc24 },
    { key: 'size-desc', label: '大小 从大到小', icon: SortSizeDesc24 },
    { key: 'size-asc', label: '大小 从小到大', icon: SortSizeAsc24 },
    { key: 'disk-asc', label: '盘符 在线优先', icon: SortDiskAsc24, globalOnly: true },
    { key: 'disk-desc', label: '盘符 逆序', icon: SortDiskDesc24, globalOnly: true },
];

const props = defineProps<{
    modelValue: SortMode;
    showDisk?: boolean;
    disabled?: boolean;
    menuProps?: DropdownMenuProps;
}>();

const emit = defineEmits<{
    (e: 'update:modelValue', v: SortMode): void;
}>();

const visibleItems = computed(() =>
    SORT_ITEMS.filter(item => !item.globalOnly || props.showDisk),
);

const currentItem = computed(() =>
    SORT_ITEMS.find(item => item.key === props.modelValue) ?? SORT_ITEMS[0],
);

const currentLabel = computed(() => currentItem.value.label);
const buttonIcon = computed(() => currentItem.value.icon);
const isCustom = computed(() => props.modelValue !== 'default');

const options = computed<DropdownOption[]>(() =>
    visibleItems.value.map(item => ({
        key: item.key,
        label: `${item.key === props.modelValue ? '✓ ' : ''}${item.label}`,
        icon: () => h(NIcon, null, { default: () => h(item.icon) }),
    })),
);

const onSelect = (key: string) => {
    const next = visibleItems.value.find(item => item.key === key);
    if (next && next.key !== props.modelValue) {
        playSfx('mode');
        emit('update:modelValue', next.key);
    }
};
</script>
