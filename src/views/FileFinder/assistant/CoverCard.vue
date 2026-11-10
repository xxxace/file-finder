<template>
    <article
        class="ffw-card"
        :class="{ 'is-sel': selected }"
        :data-state="item.state"
        :style="{ animationDelay: `${Math.min(index, 14) * 24}ms` }"
    >
        <div class="ffw-card__media">
            <div class="ffw-card__ph">{{ item.title }}</div>
            <img
                v-if="coverSrc"
                class="ffw-card__art"
                :src="coverSrc"
                referrerpolicy="no-referrer"
                alt=""
                loading="lazy"
                @error="emit('broken')"
            />
            <DotField v-if="item.state === 'pending' || extracting" :active="true" />
            <span v-if="item.badge" class="ffw-card__badge">{{ item.badge }}</span>
            <button
                v-if="action !== 'none'"
                type="button"
                class="ffw-card__act"
                :title="action === 'reframe' ? '换一帧（往后走一档）' : '抽一帧当封面'"
                @click.stop="emit('frame')"
            >
                <n-icon :component="action === 'reframe' ? RepeatOutline : CameraOutline" :size="13" />
            </button>
            <button
                type="button"
                class="ffw-card__check"
                :disabled="locked"
                :title="locked ? '任务进行中，先暂停或终止' : selected ? '取消选择' : '选择'"
                @click="emit('toggle')"
            >
                <n-icon :component="CheckmarkOutline" :size="12" />
            </button>
        </div>

        <div class="ffw-card__cap">
            <span class="ffw-card__name" :title="item.title">{{ item.title }}</span>
            <span class="ffw-card__kind">{{ item.kindText }}</span>
        </div>
        <div class="ffw-card__path" :title="item.path">{{ item.path || '盘根' }}</div>
    </article>
</template>

<script setup lang="ts">
import { NIcon } from 'naive-ui';
import { CameraOutline, CheckmarkOutline, RepeatOutline } from '@vicons/ionicons5';
import DotField from '@/components/DotField/DotField.vue';
import type { CoverAction, CoverItem } from './coverModel';

/**
 * 一张封面卡 = 一部片（同番号的分卷收在一张卡里）。
 * 封面图落地用「同节点」：占位块留着，图从 blur 8px 长出来 ——
 * 不做两块交叉淡入，那会丢掉"同一张卡在变"的连续感。
 */
/**
 * `locked` = 任务在跑/暂停：这时**禁止改勾选**。
 * 抓取队列在发起时就已经定好，此时点勾选既不会让它停下、也不影响它抓谁，
 * 只会让"选中数"变来变去 —— 点了有反馈却没效果，比禁用更糟（2026-11-08 主人裁决）。
 *
 * `broken` = 预览图在浏览器里加载失败。抓取时验证过 ≠ 渲染时还能取到（网络会变），
 * 这是**唯一**能观测到"这张图此刻显示不出来"的地方 ⇒ 交给父层把卡标成不可写。
 */
defineProps<{
    item: CoverItem;
    coverSrc: string;
    selected: boolean;
    locked: boolean;
    index: number;
    /** 右上动作位（抽帧 / 换一帧 / 无）。判据在 coverModel.actionOf */
    action: CoverAction;
    /** 这一张正在抽帧（点阵 + 动作位不出现），与整批 job 的 pending 不同：它是单卡的 */
    extracting?: boolean;
}>();
const emit = defineEmits<{ toggle: []; broken: []; frame: [] }>();
</script>
