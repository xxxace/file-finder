<template>
    <div>
        <div v-if="!steps.length" class="empty-hint">若填入「入口地址」即可直达详情页，这里留空即可。</div>
        <div v-for="(s, i) in steps" :key="i" class="step-row">
            <n-select v-model:value="s.act" :options="ACT_OPTIONS" style="width: 92px; flex: 0 0 92px" />
            <n-input v-if="s.act === 'goto'" v-model:value="s.url"
                placeholder="跳转地址模板，如 https://站点/search?q={q}" />
            <template v-else>
                <n-input v-model:value="s.selector"
                    :placeholder="s.act === 'wait' ? '等待元素选择器（留空则按毫秒等待）' : '目标元素选择器，如 #search-input'" />
                <n-input v-if="s.act === 'type'" v-model:value="s.value" placeholder="输入内容，写 {q} 代表番号"
                    style="width: 210px; flex: 0 0 210px">
                    <template #prefix><span class="in-lbl">输入</span></template>
                </n-input>
                <n-input v-else-if="s.act === 'press'" v-model:value="s.key" placeholder="Enter"
                    style="width: 136px; flex: 0 0 136px">
                    <template #prefix><span class="in-lbl">按键</span></template>
                </n-input>
                <n-input v-else-if="s.act === 'wait'" v-model:value="s.ms" placeholder="留空=等元素"
                    style="width: 156px; flex: 0 0 156px">
                    <template #prefix><span class="in-lbl">毫秒</span></template>
                </n-input>
            </template>
            <div class="row-btns">
                <n-button size="small" quaternary :disabled="i === 0" title="上移" @click="move(i, -1)">
                    <template #icon><n-icon><ArrowUpOutline /></n-icon></template>
                </n-button>
                <n-button size="small" quaternary :disabled="i === steps.length - 1" title="下移" @click="move(i, 1)">
                    <template #icon><n-icon><ArrowDownOutline /></n-icon></template>
                </n-button>
                <n-button size="small" quaternary class="del-btn" title="删除此步骤" @click="steps.splice(i, 1)">
                    <template #icon><n-icon><TrashOutline /></n-icon></template>
                </n-button>
            </div>
        </div>
        <n-button size="small" dashed @click="add">
            <template #icon><n-icon><AddOutline /></n-icon></template>
            添加一步
        </n-button>
    </div>
</template>

<script setup lang="ts">
import { NButton, NIcon, NInput, NSelect } from 'naive-ui';
import { AddOutline, ArrowDownOutline, ArrowUpOutline, TrashOutline } from '@vicons/ionicons5';
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

.in-lbl {
    font-size: 12px;
    color: var(--ff-text-2);
    margin-right: 4px;
}

.row-btns {
    display: flex;
    align-items: center;
    gap: 2px;
    flex: 0 0 auto;
}

.del-btn {
    /* 同 RuleSiteList：not a `color:` —— naive 的 `:hover` 会把它盖掉 */
    --n-text-color: var(--ff-danger) !important;
    --n-text-color-hover: var(--ff-danger) !important;
    --n-text-color-pressed: var(--ff-danger) !important;
    --n-text-color-focus: var(--ff-danger) !important;
}

.empty-hint {
    font-size: 13px;
    color: var(--ff-text-2);
    margin-bottom: 10px;
}
</style>
