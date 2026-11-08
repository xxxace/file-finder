<template>
    <div class="ffw-shell">
        <header class="ffw-bar">
            <button type="button" class="ffw-icon-btn" :disabled="busy" title="返回" @click="emit('close')">
                <n-icon :component="ChevronBackOutline" :size="16" />
            </button>
            <span class="ffw-title">{{ title }}</span>
            <span class="ffw-sep" />
            <div class="ffw-meta"><slot name="meta" /></div>
            <span class="ffw-spacer" />
            <div class="ffw-tools"><slot name="tools" /></div>
        </header>

        <main class="ffw-stage">
            <slot />
        </main>

        <slot name="dock" />
    </div>
</template>

<script setup lang="ts">
import { NIcon } from 'naive-ui';
import { ChevronBackOutline } from '@vicons/ionicons5';
import './workspace.css';

/**
 * 工作台外壳：顶栏 44 + 主区 + 底栏插槽。
 * 两个面板共用它 —— 容器统一是"看起来像同一家的产品"的前提。
 * `busy` 只挡返回：任务在跑时离开，等于把进度条扔了（任务本身还在主进程里）。
 */
withDefaults(defineProps<{ title: string; busy?: boolean }>(), { busy: false });

const emit = defineEmits<{ close: [] }>();
</script>
