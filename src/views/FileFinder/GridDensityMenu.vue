<template>
    <!-- 网格密度切换：一颗按钮 + 下拉三档。
         为什么不是三段常显按钮组：工具栏已有 4 个控件，1024 最小窗下导航区还要留折叠余量
         （主人 2026-10-29 裁定「空间不够」）。为什么按钮上带中文：纯图标看不出当前档，
         而"当前是哪一档"正是这个控件最要紧的信息。 -->
    <n-dropdown trigger="click" :options="options" :menu-props="menuProps" @select="onSelect">
        <n-button size="small" :title="`视图密度：${currentLabel}（点击切换）`">
            <template #icon>
                <n-icon :component="GridOutline" />
            </template>
            {{ currentLabel }}
            <!-- 箭头放 default 槽里：naive-ui 的 Button **没有 `suffix` 插槽**
                 （只有 default / icon / loading），写 `#suffix` 会被静默丢掉。 -->
            <n-icon :component="ChevronDownOutline" size="12" style="margin-left: 3px; vertical-align: -1px" />
        </n-button>
    </n-dropdown>
</template>

<script setup lang="ts">
import { computed, h } from 'vue';
import { NButton, NDropdown, NIcon } from 'naive-ui';
import { CheckmarkOutline, ChevronDownOutline, GridOutline } from '@vicons/ionicons5';
import type { DropdownMenuProps, DropdownOption } from 'naive-ui';
import { DENSITY_OPTIONS, labelOf } from './density';
import type { Density } from './density';

const props = defineProps<{
    modelValue: Density;
    /**
     * 下拉的样式参数，由父组件把 `moreMenuProps` **函数本身**传进来（不是调用结果：
     * naive-ui 的 `menu-props` 两种形态都收，传函数才能与「更多」菜单共用同一份）。
     * ⚠️ 不在这里自己写一份：项目里浮层的 CSS 变量只在 `index.vue` 有**一处**，
     * 复制一份就是第二个会漂移的真相（"更多"菜单与这里迟早长得不一样）。
     */
    menuProps?: DropdownMenuProps;
}>();

const emit = defineEmits<{
    (e: 'update:modelValue', v: Density): void;
}>();

const currentLabel = computed(() => labelOf(props.modelValue));

/**
 * 菜单项：中文名 + 列数。当前档打勾。
 * 未选中的项也占一个等宽的 `icon` 槽（透明占位），否则三行的文字会左右错开两格。
 */
const options = computed<DropdownOption[]>(() =>
    DENSITY_OPTIONS.map(o => ({
        key: o.key,
        label: `${o.label} · ${o.cols} 列`,
        icon:
            o.key === props.modelValue
                ? () => h(NIcon, null, { default: () => h(CheckmarkOutline) })
                : () => h('span', { style: 'display:inline-block;width:14px' }),
    })),
);

const onSelect = (key: string) => {
    const next = DENSITY_OPTIONS.find(o => o.key === key);
    if (next) emit('update:modelValue', next.key);
};
</script>
