<template>
    <!-- 网格密度切换：一颗图标按钮 + 下拉三档。
         ⚠️ 2026-11-08 顶栏升级：**去掉了按钮上的中文标签**（原来"▦ 宽松 ⌄"≈88px）。
         "当前是哪一档"现在由**图标本身**回答：按钮图标 = 当前档的方块阵（2×2 / 3×3 / 4×4），
         比原来那颗恒定的 `GridOutline` 直观得多 —— 原来那颗三档共用一个图标，看不出当前值。
         另外偏离默认档时按钮仍带底色（`.is-on`）：图标答"改成什么"，底色答"你动过它"。
         为什么不常显文字：工具条里有 4 颗图标，任何一颗带字都会让它比邻居"高一级"，
         而"一屏铺几列"是视图偏好、不是主操作。 -->
    <n-dropdown trigger="click" :options="options" :menu-props="menuProps" @select="onSelect">
        <n-button size="small" :class="['icon-lg', { 'is-on': isCustom }]"
            v-tip="`视图密度：${currentLabel}`" :aria-label="`视图密度：${currentLabel}`">
            <template #icon>
                <!-- 图标随档位换。三颗都是自绘的同族方块阵（见 components/icons/grid.ts）：
                     块越来越少、越来越大 = 越来越松，这个递进关系比"三颗不同画法的库图标"清楚。
                     ⚠️ 这三颗的墨迹只占 viewBox 75%，比同排 ionicons 那几颗（81%）小一圈，
                     所以都套 `.icon-lg` 撑到 20px —— 那个类是在 `index.vue` 里定义的。 -->
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
import { DensityNormal24, DensityTight24, DensityWide24 } from '@/components/icons/grid';
import { playSfx } from '@/utils/sfx';
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

/** 档位 → 方块阵图标。阶梯关系由 `matrix(n, s, g)` 的三个参数决定，不要在这里改尺寸。 */
const DENSITY_ICON: Record<Density, Component> = {
    wide: DensityWide24,
    normal: DensityNormal24,
    tight: DensityTight24,
};

const currentLabel = computed(() => labelOf(props.modelValue));

/** 按钮上那颗：跟着当前档走，本身就是"当前值"的读数。 */
const buttonIcon = computed(() => DENSITY_ICON[props.modelValue]);

/**
 * 按钮的激活态：**偏离默认档**才亮。
 *
 * 从"有没有动过它"这个角度说，底色比图标更合适 —— 图标答"改成什么"，
 * 底色答"这不是出厂设置"。默认档不亮：一进应用就亮着的开关会让整条工具条
 * 看起来"有东西被选中"，而其实什么都没改过。
 */
const isCustom = computed(() => props.modelValue !== DEFAULT_DENSITY);

/**
 * 菜单项：**每档自己的方块阵** + 中文名 + 列数。
 *
 * ⚠️ 选中态用文案里那个 `✓`，不靠图标颜色：naive 的下拉没有"选中"样式，纯用颜色
 * 区分等于"只用颜色传达状态"（WCAG 1.4.1 不通过）。图标负责"这是哪一档"，
 * 打勾负责"选的是哪个"，两件事分开表达。
 */
const options = computed<DropdownOption[]>(() =>
    DENSITY_OPTIONS.map(o => ({
        key: o.key,
        label: `${o.key === props.modelValue ? '✓ ' : ''}${o.label} · ${o.cols} 列`,
        icon: () => h(NIcon, null, { default: () => h(DENSITY_ICON[o.key]) }),
    })),
);

const onSelect = (key: string) => {
    const next = DENSITY_OPTIONS.find(o => o.key === key);
    if (next) {
        playSfx('mode');
        emit('update:modelValue', next.key);
    }
};
</script>
