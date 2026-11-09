<template>
    <div class="ffo-banner">
        <span class="ffo-banner__icon" :class="`is-${kind}`">
            <component :is="iconOf(kind)" />
        </span>
        <div class="ffo-banner__text">
            <div v-if="title" class="ffo-banner__title">{{ title }}</div>
            <slot />
        </div>
    </div>
</template>

<script setup lang="ts">
/**
 * 页内条幅（替代 `n-alert`）。
 *
 * ⚠️ n-alert 是**零接管**：主题映射里根本没有 Alert 这一项，切主题它不跟着变 ——
 *   这就是"被原库影响"最直白的一处。所以自己画：底 = `--ff-raised` 一档、
 *   语义色只上在图标和标题上，不做整块彩色底（彩色块在深色主题下会脏）。
 */
import { computed } from 'vue';
import { CheckmarkCircleOutline, InformationCircleOutline, WarningOutline, CloseCircleOutline } from '@vicons/ionicons5';
import type { OverlayKind } from './store';
import './overlay.css';

const props = defineProps<{
    /** 与 n-alert 的 type 同名（含 'default'），未知值一律当 info。 */
    type?: string;
    title?: string;
}>();

const kind = computed<OverlayKind>(() => {
    const t = props.type;
    return t === 'success' || t === 'warning' || t === 'error' ? t : 'info';
});

const ICONS: Record<OverlayKind, unknown> = {
    success: CheckmarkCircleOutline,
    info: InformationCircleOutline,
    warning: WarningOutline,
    error: CloseCircleOutline,
};

function iconOf(k: OverlayKind) {
    return ICONS[k];
}
</script>
