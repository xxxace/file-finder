<template>
    <div>
        <div v-for="(c, i) in candidates" :key="i" class="step-row">
            <n-select v-model:value="c.kind" :options="KIND_OPTIONS" style="width: 104px" />
            <n-input v-model:value="c.selector" :placeholder="PH[i % PH.length]" />
            <n-input v-if="c.kind === 'css'" v-model:value="c.attr"
                placeholder="属性，可用 | 回退（默认 src|data-src）" style="width: 260px" />
            <n-button size="tiny" quaternary :disabled="i === 0" @click="move(i, -1)">↑</n-button>
            <n-button size="tiny" quaternary :disabled="i === candidates.length - 1" @click="move(i, 1)">↓</n-button>
            <n-button size="tiny" quaternary @click="candidates.splice(i, 1)">删</n-button>
        </div>
        <n-button size="small" dashed @click="add">添加一个选择器</n-button>
    </div>
</template>

<script setup lang="ts">
import { NButton, NInput, NSelect } from 'naive-ui';
import { KIND_OPTIONS, type FieldCandidate } from './ruleDraft';

/** 契约同 `RuleStepList`：直接改父级草稿里的这个数组 */
const props = defineProps<{ candidates: FieldCandidate[] }>();

/** 占位提示按"这一条是什么类型"给例子 —— 顺序试候选链，越靠前越优先 */
const PH = ['.movie .photo-frame img', 'og:image', 'cover.*\\.jpg'];

/**
 * 默认带**属性回退链**：懒加载站的 `src` 常是占位图、真地址在 `data-src`，
 * 而 `lazyloaded` 这类类名要等图真加载完才加上（隐藏窗不滚动，可能永远不加）。
 * 一条候选覆盖三种时机，比让用户自己猜该写哪个属性稳。
 */
function add() {
    props.candidates.push({ kind: 'css', selector: '', attr: 'src|data-src|data-original' });
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
</style>
