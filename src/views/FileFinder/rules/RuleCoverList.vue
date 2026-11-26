<template>
    <div>
        <div v-for="(c, i) in candidates" :key="i" class="step-row">
            <n-select v-model:value="c.kind" :options="KIND_OPTIONS" style="width: 92px; flex: 0 0 92px" />
            <n-input v-model:value="c.selector" :placeholder="placeholderOf(c.kind, i)" />
            <n-input v-if="c.kind === 'css' || c.kind === 'xpath'" v-model:value="c.attr"
                :placeholder="attrPh" style="width: 180px; flex: 0 0 180px">
                <template #prefix><span class="in-lbl">属性</span></template>
            </n-input>
            <div class="row-btns">
                <n-button size="tiny" quaternary :disabled="i === 0" title="上移（提高优先级）" @click="move(i, -1)">
                    <template #icon><n-icon><ArrowUpOutline /></n-icon></template>
                </n-button>
                <n-button size="tiny" quaternary :disabled="i === candidates.length - 1" title="下移（降低优先级）"
                    @click="move(i, 1)">
                    <template #icon><n-icon><ArrowDownOutline /></n-icon></template>
                </n-button>
                <n-button size="tiny" quaternary class="del-btn" title="删除此选择器"
                    @click="candidates.splice(i, 1)">
                    <template #icon><n-icon><TrashOutline /></n-icon></template>
                </n-button>
            </div>
        </div>
        <n-button size="small" dashed @click="add">
            <template #icon><n-icon><AddOutline /></n-icon></template>
            添加一个选择器
        </n-button>
    </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { NButton, NIcon, NInput, NSelect } from 'naive-ui';
import { AddOutline, ArrowDownOutline, ArrowUpOutline, TrashOutline } from '@vicons/ionicons5';
import { KIND_OPTIONS, type CandKind, type FieldCandidate } from './ruleDraft';

/** 契约同 `RuleStepList`：直接改父级草稿里的这个数组 */
const props = defineProps<{ candidates: FieldCandidate[]; mode?: 'cover' | 'text' | 'link' }>();

const defaultAttr = computed(() =>
    props.mode === 'text' ? 'text' : props.mode === 'link' ? 'href' : 'src|data-src|data-original'
);
const attrPh = computed(() =>
    props.mode === 'text' ? '默认 text'
        : props.mode === 'link' ? '默认 href'
        : 'src|data-src|bg'
);

function placeholderOf(kind: CandKind, i: number): string {
    if (kind === 'xpath') return '//div[@class="cover"]//img';
    if (kind === 'meta') return 'og:image';
    if (kind === 'regex') return 'cover.*\\.jpg';
    if (kind === 'script') return 'doc.querySelector(".cover img")?.src';
    return i === 0 ? '.movie .photo-frame img' : 'CSS 选择器';
}

function add() {
    props.candidates.push({ kind: 'css', selector: '', attr: defaultAttr.value });
}

function move(i: number, d: number) {
    const a = props.candidates;
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
    color: var(--ff-danger);
}
</style>
