<template>
    <aside class="rules-side">
        <div class="side-head">
            <span class="side-title">站点列表（{{ rules.length }}）</span>
            <n-button size="small" secondary @click="emit('create')">
                <template #icon><n-icon><AddOutline /></n-icon></template>
                新建站点
            </n-button>
        </div>
        <div class="side-list">
            <div v-for="(r, idx) in rules" :key="r.id" class="rule-row" :class="{ 'is-active': r.id === activeId }"
                @click="emit('select', r)">
                <n-checkbox :checked="r.enabled" @update:checked="(v: boolean) => emit('toggle', r, v)"
                    @click.stop />
                <div class="rule-info">
                    <div class="rule-top">
                        <span class="rule-name">{{ r.name || r.id }}</span>
                        <span v-if="r.verified" class="rule-badge ok">已验</span>
                    </div>
                    <span class="rule-host">{{ hostOf(r.detailUrl) }}</span>
                </div>
                <span class="row-ops" @click.stop>
                    <n-button size="small" quaternary :disabled="idx === 0" title="上移（提高优先级）"
                        @click="emit('move', idx, -1)">
                        <template #icon><n-icon><ArrowUpOutline /></n-icon></template>
                    </n-button>
                    <n-button size="small" quaternary :disabled="idx === rules.length - 1" title="下移（降低优先级）"
                        @click="emit('move', idx, 1)">
                        <template #icon><n-icon><ArrowDownOutline /></n-icon></template>
                    </n-button>
                    <n-popconfirm positive-text="确认删除" negative-text="取消" @positive-click="emit('remove', r)">
                        <template #trigger>
                            <n-button size="small" quaternary class="del-btn" title="删除该站点规则">
                                <template #icon><n-icon><TrashOutline /></n-icon></template>
                            </n-button>
                        </template>
                        确定删除站点「{{ r.name || r.id }}」吗？删除后不可恢复。
                    </n-popconfirm>
                </span>
            </div>
        </div>
        <p class="side-note">
            勾选表示参与批量抓取，列表从上到下即为尝试顺序。规则保存在系统盘，不影响硬盘文件。
        </p>
    </aside>
</template>

<script setup lang="ts">
import { NButton, NCheckbox, NIcon, NPopconfirm } from 'naive-ui';
import { AddOutline, ArrowDownOutline, ArrowUpOutline, TrashOutline } from '@vicons/ionicons5';
import { hostOf, type SiteRuleDraft } from './ruleDraft';

defineProps<{ rules: SiteRuleDraft[]; activeId: string }>();
const emit = defineEmits<{
    select: [rule: SiteRuleDraft];
    create: [];
    toggle: [rule: SiteRuleDraft, value: boolean];
    remove: [rule: SiteRuleDraft];
    move: [index: number, delta: number];
}>();
</script>

<style lang="less" scoped>
.rules-side {
    width: 268px;
    flex: 0 0 268px;
    display: flex;
    flex-direction: column;
    border-right: 1px solid var(--ff-line);
    padding-right: 14px;
    min-height: 0;
}

.side-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 10px;
}

.side-title {
    font-size: var(--ff-fs-body);
    font-weight: 500;
    color: var(--ff-text-1);
}

.side-list {
    flex: 1 1 auto;
    overflow-y: auto;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
}

.rule-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px;
    border-radius: var(--ff-r-ctl);
    cursor: pointer;

    &:hover { background: var(--ff-ctl-hover); }

    /* 选中行 = 玻璃高亮片（与设置页左导航同一份材质，见 tokens 的 --ff-glass-hi-*） */
    &.is-active {
        background: var(--ff-glass-hi-bg);
        box-shadow: var(--ff-glass-hi-shadow);
    }
}

.rule-info {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
}

.rule-top {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
}

.rule-name {
    font-size: var(--ff-fs-body);
    font-weight: 500;
    color: var(--ff-text-1);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.rule-badge {
    font-size: var(--ff-fs-eyebrow);
    padding: 1px 6px;
    border-radius: var(--ff-r-pill);
    background: var(--ff-raised);
    flex: 0 0 auto;

    &.ok { color: var(--ff-ok); }
}

.rule-host {
    font-size: var(--ff-fs-meta);
    color: var(--ff-text-2);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.row-ops {
    display: flex;
    align-items: center;
    gap: 2px;
    flex: 0 0 auto;
    opacity: 0;
    transition: opacity .12s;
}

.rule-row:hover .row-ops,
.rule-row.is-active .row-ops {
    opacity: 1;
}

.del-btn {
    /* ⚠️ 不能只写 `color:` —— naive 的 `.n-button:hover{color:var(--n-text-color-hover)}`
       与我们同权重、且注入更晚，悬停时红图标会被换成默认文字色（"删除按钮 hover 会变色"）。
       钉住 naive 自己的变量，四个状态一起红，不打 specificity 补丁。 */
    --n-text-color: var(--ff-danger) !important;
    --n-text-color-hover: var(--ff-danger) !important;
    --n-text-color-pressed: var(--ff-danger) !important;
    --n-text-color-focus: var(--ff-danger) !important;
}

.side-note {
    font-size: 12.5px;
    line-height: 1.5;
    color: var(--ff-text-2);
    margin-top: 12px;
}
</style>
