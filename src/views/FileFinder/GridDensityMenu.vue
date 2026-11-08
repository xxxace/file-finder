<template>
    <!-- 网格密度切换：一颗图标按钮 + 下拉三档。
         ⚠️ 2026-11-08 顶栏升级：**去掉了按钮上的中文标签**（原来"▦ 宽松 ⌄"≈88px）。
         原注释的理由是"纯图标看不出当前档"，那件事改用**按钮自己的激活态**回答：
         偏离默认档（宽松）时按钮带底色（`.is-on`），与「平铺」同一套语言；
         另外 `title` / 下拉里的对勾都还在报具体档位。
         为什么不常显文字：工具条里有 4 颗图标，任何一颗带字都会让它比邻居"高一级"，
         而"一屏铺几列"是视图偏好、不是主操作。 -->
    <n-dropdown trigger="click" :options="options" :menu-props="menuProps" @select="onSelect">
        <n-button size="small" :class="{ 'is-on': isCustom }" :title="`视图密度：${currentLabel}（点击切换）`"
            :aria-label="`视图密度：${currentLabel}`">
            <template #icon>
                <!-- `Grid`（2×2 方格）＝ 布局 / 一屏铺几列。主人 2026-11-08 裁决：
                     这颗"原先的已经很好了"，换 `Resize` 那版被否。
                     ⇒ 与「平铺」的 `Apps`（3×3 九宫格）确实同为方格，但两颗都靠位置与
                     tooltip 区分，不必为消重而改。 -->
                <n-icon :component="GridOutline" />
            </template>
        </n-button>
    </n-dropdown>
</template>

<script setup lang="ts">
import { computed, h } from 'vue';
import { NButton, NDropdown, NIcon } from 'naive-ui';
import { CheckmarkOutline, GridOutline } from '@vicons/ionicons5';
import type { DropdownMenuProps, DropdownOption } from 'naive-ui';
import { DENSITY_OPTIONS, DEFAULT_DENSITY, labelOf } from './density';
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
 * 按钮的激活态：**偏离默认档**才亮。
 *
 * 纯图标之后，"当前是哪一档"没有文字可读了 —— 用底色回答"我动过它"，
 * 用 title / 下拉对勾回答"动到哪一档"。默认档不亮：一进应用就亮着的开关
 * 会让整条工具条看起来"有东西被选中"，而其实什么都没改过。
 */
const isCustom = computed(() => props.modelValue !== DEFAULT_DENSITY);

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
