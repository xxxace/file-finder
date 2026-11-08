<template>
    <div v-if="variant === 'card'" class="ffw-grid">
        <div v-for="i in count" :key="i" class="ffw-skel">
            <div class="ffw-skel__media" />
            <div class="ffw-skel__line" />
            <div class="ffw-skel__line is-short" />
        </div>
    </div>
    <div v-else class="ffw-rows">
        <div v-for="i in count" :key="i" class="ffw-skel-row">
            <div class="ffw-skel-row__face" />
            <div class="ffw-skel-row__text">
                <div class="ffw-skel__line" />
                <div class="ffw-skel__line is-short" />
            </div>
        </div>
    </div>
</template>

<script setup lang="ts">
/**
 * 骨架屏：**只用于"清单还没到"**（重扫 / 首次打开）。
 * 刻意不做扫光条 —— 扫光会暗示"在推进、有进度"，而这段时间恰恰没有进度可言；
 * 静态呼吸只说一件事："东西在来的路上"。
 */
withDefaults(defineProps<{ variant: 'card' | 'row'; count?: number }>(), { count: 8 });
</script>
