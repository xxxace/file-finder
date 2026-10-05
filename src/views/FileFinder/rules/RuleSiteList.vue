<template>
    <aside class="rules-side">
        <div class="side-head">
            <span class="side-title">站点（{{ rules.length }}）</span>
            <n-button size="small" @click="emit('create')">新建站点</n-button>
        </div>
        <div class="side-list">
            <div v-for="r in rules" :key="r.id" class="rule-row" :class="{ 'is-active': r.id === activeId }"
                @click="emit('select', r)">
                <n-checkbox :checked="r.enabled" @update:checked="(v: boolean) => emit('toggle', r, v)"
                    @click.stop />
                <span class="rule-name">{{ r.name || r.id }}</span>
                <span class="rule-host">{{ hostOf(r.detailUrl) }}</span>
            </div>
        </div>
        <p class="side-note">
            勾选 = 参与抓取。改动即时生效 —— 规则存在系统盘，不碰移动硬盘。
        </p>
    </aside>
</template>

<script setup lang="ts">
import { NButton, NCheckbox } from 'naive-ui';
import { hostOf, type SiteRuleDraft } from './ruleDraft';

defineProps<{ rules: SiteRuleDraft[]; activeId: string }>();
const emit = defineEmits<{
    select: [rule: SiteRuleDraft];
    create: [];
    toggle: [rule: SiteRuleDraft, value: boolean];
}>();
</script>

<style lang="less" scoped>
.rules-side {
    width: 280px;
    flex: 0 0 280px;
    display: flex;
    flex-direction: column;
    border-right: 1px solid rgba(128, 128, 128, .24);
    padding-right: 14px;
    min-height: 0;
}

.side-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 10px;
}

.side-title { font-weight: 500; }

.side-list {
    flex: 1 1 auto;
    overflow-y: auto;
    min-height: 0;
}

.rule-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 6px;
    border-radius: 6px;
    cursor: pointer;

    &:hover { background: rgba(110, 123, 173, .12); }
    &.is-active { background: rgba(110, 123, 173, .2); }
}

.rule-name {
    flex: 1 1 auto;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.rule-host {
    font-size: 12px;
    opacity: .6;
    max-width: 110px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.side-note {
    font-size: 12px;
    opacity: .6;
    margin-top: 10px;
}
</style>
