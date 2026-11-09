<template>
    <aside ref="railRef" class="rail">
        <div class="rail-group">
            <button v-for="(it, i) in RAIL_ITEMS" :key="it.key" :ref="(el) => setButton(i, el)" type="button"
                class="rail-item" :class="{ 'is-active': active === it.key }" :aria-label="it.label"
                @click="$emit('select', it.key)" @pointerenter="onEnter($event, i)" @pointerleave="leave"
                @focus="onEnter($event, i)" @blur="leave">
                <n-icon :size="20" :component="it.icon" />
            </button>
        </div>

        <div class="rail-group">
            <button :ref="(el) => setButton(SETTINGS_INDEX, el)" type="button" class="rail-item"
                :class="{ 'is-active': active === 'settings' }" aria-label="设置" @click="$emit('select', 'settings')"
                @pointerenter="onEnter($event, SETTINGS_INDEX)" @pointerleave="leave"
                @focus="onEnter($event, SETTINGS_INDEX)" @blur="leave">
                <n-icon :size="20" :component="SettingsOutline" />
            </button>

            <button :ref="(el) => setButton(THEME_INDEX, el)" type="button" class="rail-item"
                :aria-label="isDark ? '切到浅色' : '切到深色'" @click="onToggleTheme"
                @pointerenter="onEnter($event, THEME_INDEX)" @pointerleave="leave"
                @focus="onEnter($event, THEME_INDEX)" @blur="leave">
                <n-icon :size="20" :component="isDark ? SunnyOutline : MoonOutline" />
            </button>
        </div>

        <RailTip :labels="TIP_LABELS" :y="tipY" :width="tipWidth" :shown="tipOn" :snap="tipSnap" :mark-row="setRow" />
    </aside>
</template>

<script setup lang="ts">
/**
 * 左导航轨 —— B 站那一列的骨架。
 *
 * 上面 = 内容目的地（文件 / 清单 / 缓存），下面 = 设置 + 主题。
 * 「更多」「刷新」「换封面」这类**跟当前这一层数据绑定**的动作留在文件页头部 ——
 * 把层级不同的东西塞进同一条轨，用户就得先想"这个按钮作用于谁"。
 *
 * 提示是**一个**会滑动的胶囊（`RailTip` + `useRailTip`），不是每颗按钮各弹一个 `n-tooltip`：
 * 后者天生做不出"同一个气泡连续换内容"，滑过去才有那条轨是一整体的感觉。
 */
import { computed, ref } from 'vue';
import { NIcon } from 'naive-ui';
import { MoonOutline, SettingsOutline, SunnyOutline } from '@vicons/ionicons5';
import { RAIL_ITEMS } from './nav';
import type { RailKey } from './nav';
import { playSfx } from '@/utils/sfx';
import RailTip from './RailTip.vue';
import { useRailTip } from './useRailTip';

const { active, isDark } = defineProps<{
    active: RailKey;
    isDark: boolean;
}>();

const emit = defineEmits<{
    (e: 'select', key: RailKey): void;
    (e: 'toggle-theme', source: HTMLElement | null): void;
}>();

const railRef = ref<HTMLElement | null>(null);
const { tipY, tipWidth, tipOn, tipSnap, setButton, setRow, show, leave } = useRailTip(railRef);

/** 胶囊里 5 行的顺序 = 上组 3 个 + 下组 2 个，必须与下面模板的排列一致 */
const SETTINGS_INDEX = RAIL_ITEMS.length;
const THEME_INDEX = RAIL_ITEMS.length + 1;
const TIP_LABELS = computed(() => [
    ...RAIL_ITEMS.map((it) => it.label),
    '设置（站点规则）',
    isDark ? '切到浅色' : '切到深色',
]);

/** 触屏没有 hover 语义：轻点会接着给 button 焦点，交给 focus 那条路去显示 */
const onEnter = (event: Event, index: number) => {
    if (event instanceof PointerEvent && event.pointerType === 'touch') return;
    playSfx('hover');
    show(index);
};

/** 连按钮本身一起带出去 —— 圆形扩散的圆心取它的中心；不传就退化成视口中心，差很多 */
const onToggleTheme = (event: MouseEvent) =>
    emit('toggle-theme', event.currentTarget as HTMLElement | null);
</script>

<style scoped lang="less">
.rail {
    position: relative;
    /* 提示胶囊要压到右侧页面内容之上；页面内最高只用到 z-index 3（封面角标契约） */
    z-index: 20;
    flex: 0 0 var(--ff-rail-w);
    width: var(--ff-rail-w);
    height: 100%;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    align-items: center;
    padding: 14px 0;
    box-sizing: border-box;
    background: var(--ff-chrome-bg);
    /* 与顶栏共用同一个 chrome 底色，**不画右边线**（2026-11-08 裁决）：
       底色比画布亮一档，明度差已经把"轨道"和"内容"分开了。
       `box-sizing: border-box` 已设 ⇒ 哪天要补回 1px，它含在 64 的宽度里，不额外挤网格。 */
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
    border-radius: var(--ff-r-card);
    /* 常态**没有底色**，但图标是亮的 —— 这是 WorkBuddy 侧栏最容易被忽略的一条：
       它的图标从来不是灰的，灰的是"未启用"，不是"未选中"。
       （2026-11-08 主人两次指着截图问"图标颜色真的学到精髓了？"就是这一条。） */
    background: transparent;
    color: var(--ff-chrome-icon);
    cursor: pointer;
    transition: background-color 0.15s ease;

    /* 悬停与选中**同一个值**（主人 2026-11-08 给定：深 #313131 / 浅 #ebebeb）。
       两者不是"分不出"，而是：悬停是"路过就亮"，选中是"一直亮着"。 */
    &:hover {
        background: var(--ff-chrome-active);
    }

    &.is-active {
        background: var(--ff-chrome-active);
    }
}
</style>
