<template>
    <!-- 设置页（2026-11-09 拆身份重构）：
         左侧分类导航 + 右侧单列面板（Microsoft 应用设置准则 / macOS HIG 同一骨架）。
         ⚠️ 身份纪律：这里只放「偏好」（低频、影响行为）；工作流命令留在工具现场
         —— 规则编辑器整体住在 SiteRulesPanel，录一遍/试跑等命令不进壳。 -->
    <div class="page">
        <header class="page-head">
            <h1>设置</h1>
            <span class="page-sub">{{ current?.desc }}</span>
        </header>
        <div class="settings-wrap">
            <nav class="settings-nav" aria-label="设置分类">
                <button v-for="p in PANELS" :key="p.key" type="button" class="nav-row"
                    :class="{ 'is-active': panel === p.key }" :aria-current="panel === p.key ? 'page' : undefined"
                    v-tip="p.tip" @click="panel = p.key">
                    <span class="nav-name">{{ p.name }}</span>
                    <span class="nav-desc">{{ p.desc }}</span>
                </button>
            </nav>

            <section class="settings-main">
                <GeneralPanel v-if="panel === 'general'" />
                <SiteRulesPanel v-else />
            </section>
        </div>
    </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import GeneralPanel from './GeneralPanel.vue';
import SiteRulesPanel from './SiteRulesPanel.vue';

type PaneKey = 'general' | 'rules';

/** 一级目的地必须表达**稳定的心智模型**，不为单项设置开一级页（Apple/GNOME 同准则） */
const PANELS: { key: PaneKey; name: string; desc: string; tip?: string }[] = [
    { key: 'general', name: '通用', desc: '音效 · 备份与迁移', tip: '通用偏好' },
    { key: 'rules', name: '站点规则', desc: '封面抓取站点配置' },
];

const STORAGE_KEY = 'ff.settings.pane';

function readStored(): PaneKey {
    try {
        const v = localStorage.getItem(STORAGE_KEY);
        if (v === 'general' || v === 'rules') return v;
    } catch { /* 存不下就用默认 */ }
    return 'general';
}

const panel = ref<PaneKey>(readStored());
watch(panel, (v) => {
    try { localStorage.setItem(STORAGE_KEY, v); } catch { /* 同上 */ }
});

const current = computed(() => PANELS.find((p) => p.key === panel.value));
</script>

<style lang="less" scoped>
.page {
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
    flex-direction: column;
    padding: 20px 24px 0;
    box-sizing: border-box;
}

.page-head {
    display: flex;
    align-items: baseline;
    gap: 10px;
    margin-bottom: 12px;

    h1 {
        margin: 0;
        font-size: 16px;
        font-weight: 500;
    }
}

.page-sub {
    font-size: 12px;
    color: var(--ff-text-2);
}

.settings-wrap {
    display: flex;
    flex: 1 1 auto;
    min-height: 0;
    gap: 20px;
    padding-bottom: 16px;
}

/* 左导航：与左轨同族的「圆角 8 灰底激活态」；行 = 名称 + 说明两层 */
.settings-nav {
    flex: 0 0 190px;
    width: 190px;
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding-top: 2px;
}

.nav-row {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
    padding: 8px 12px;
    border: 0;
    border-radius: var(--ff-r-ctl);
    background: transparent;
    color: var(--ff-text-1);
    font: inherit;
    text-align: left;
    cursor: pointer;
    transition: background-color var(--ff-dur-hover) ease;

    &:hover { background: var(--ff-ctl-hover); }

    &.is-active { background: var(--ff-ctl-on); }
}

.nav-name {
    font-size: 13px;
    font-weight: 500;
}

.nav-desc {
    font-size: 12px;
    color: var(--ff-text-2);
}

.settings-main {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    flex-direction: column;
}
</style>
