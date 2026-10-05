<template>
    <div v-if="last && last.kind === 'error'" class="result err">{{ last.message }}</div>
    <div v-else-if="last" class="result">
        <div class="seg">
            <span class="seg-title">页面</span>
            <span v-if="last.cf" class="bad">被站点验证拦住了 —— 先去「补封面」过一次验证再回来</span>
            <span v-else-if="!last.ok && last.httpStatus >= 400" class="bad">
                打不开（HTTP {{ last.httpStatus }}）—— 这个番号在该站可能不存在
            </span>
            <span v-else-if="!last.ok" class="bad">取不到，页面结构可能变了</span>
            <span v-else class="good">取到了{{ last.pageTitle ? '：' + last.pageTitle : '' }}</span>
        </div>

        <div v-for="s in last.steps" :key="s.index" class="seg">
            <span class="seg-title">第 {{ s.index + 1 }} 步</span>
            <span :class="s.ok ? 'good' : 'bad'">
                {{ s.ok ? '完成' : s.why === 'not-found' ? '没找到这个元素 —— 选择器可能变了' : '超时' }}
            </span>
        </div>

        <div class="seg">
            <span class="seg-title">封面</span>
            <span :class="last.cover ? 'good' : 'bad'">{{ last.cover || '没有命中任何候选' }}</span>
        </div>
        <div class="seg">
            <span class="seg-title">标题</span>
            <span class="dim">{{ last.title || '（没抓到，不影响封面）' }}</span>
        </div>
    </div>
</template>

<script setup lang="ts">
import type { TestRun } from './ruleDraft';

/**
 * 试跑三段式回显：**页面 → 每步动作 → 各字段命中值**。
 * 分段的唯一目的：让用户知道"卡在哪一段"，而不是只看到一句"失败了"。
 */
defineProps<{ last: TestRun | null }>();
</script>

<style lang="less" scoped>
.result {
    margin-top: 12px;
    padding: 10px 12px;
    border-radius: 8px;
    background: rgba(128, 128, 128, .08);
    font-size: 13px;
}

.result.err { color: #d03050; }

.seg {
    display: flex;
    gap: 8px;
    padding: 3px 0;
}

.seg-title {
    flex: 0 0 64px;
    opacity: .7;
}

.good { color: #18a058; }
.bad { color: #d03050; }
.dim { opacity: .75; word-break: break-all; }
</style>
