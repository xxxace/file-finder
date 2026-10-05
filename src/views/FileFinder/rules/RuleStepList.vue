<template>
    <div>
        <div v-if="!steps.length" class="empty-hint">这个站不需要先搜索？那就留空。</div>
        <div v-for="(s, i) in steps" :key="i" class="step-row">
            <n-select v-model:value="s.act" :options="ACT_OPTIONS" style="width: 104px" />
            <n-input v-model:value="s.selector" placeholder="要操作的元素选择器，如 #search-input" />
            <n-input v-if="s.act === 'type'" v-model:value="s.value" placeholder="输入内容，写 {q} 代表番号"
                style="width: 240px" />
            <n-input v-else-if="s.act === 'wait'" v-model:value="s.ms" placeholder="毫秒（留空=等元素出现）"
                style="width: 160px" />
            <n-button size="tiny" quaternary :disabled="i === 0" @click="move(i, -1)">↑</n-button>
            <n-button size="tiny" quaternary :disabled="i === steps.length - 1" @click="move(i, 1)">↓</n-button>
            <n-button size="tiny" quaternary @click="steps.splice(i, 1)">删</n-button>
        </div>
        <n-button size="small" dashed @click="add">添加一步</n-button>
    </div>
</template>

<script setup lang="ts">
import { NButton, NInput, NSelect } from 'naive-ui';
import { ACT_OPTIONS, type ActionStep } from './ruleDraft';

/**
 * 契约：`steps` 是**父级草稿里的同一个数组**（不是拷贝），
 * 所以这里直接改它的元素 / splice / push 就等于改草稿 —— 不需要一堆 update 事件。
 */
const props = defineProps<{ steps: ActionStep[] }>();

function add() {
    props.steps.push({ act: 'type', selector: '', value: '{q}' });
}

function move(i: number, d: number) {
    const a = props.steps;
    const j = i + d;
    if (j < 0 || j >= a.length) return;
    [a[i], a[j]] = [a[j], a[i]];
}
</script>

<style lang="less" scoped>
.step-row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
}

.step-row .n-input { min-width: 0; }

.empty-hint {
    font-size: 12px;
    opacity: .6;
    margin-bottom: 8px;
}
</style>
