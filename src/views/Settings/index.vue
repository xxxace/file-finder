<template>
    <!-- 设置页（2026-10-21 从全屏弹窗改路由页）：站点规则是**长期配置**，
         不是"当前这一屏的动作"—— 关掉后不需要回到刚才那一屏。 -->
    <div class="page">
        <header class="page-head">
            <h1>设置 · 站点规则</h1>
            <span class="page-sub">入口 / 动作 / 抽取三段式；保存后即时生效</span>
        </header>
        <div class="rules-wrap">
            <RuleSiteList :rules="rules" :active-id="draft.id" @select="editRule" @create="newRule"
                @toggle="toggleRule" />

            <section class="rules-main">
                <h4>① 入口</h4>
                <div class="row2">
                    <n-input v-model:value="draft.id" placeholder="站点 ID（英文，如 mysite）" :disabled="!isNew" />
                    <n-input v-model:value="draft.name" placeholder="显示名" />
                </div>
                <div class="row">
                    <n-input v-model:value="draft.detailUrl"
                        placeholder="详情页地址模板：番号处写 {q}，例如 https://站点/{q}" />
                    <n-select v-model:value="inserting" :options="VAR_OPTIONS" placeholder="插入变量"
                        style="width: 168px" @update:value="insertVar" />
                </div>
                <div class="row">
                    <span class="lbl">查询词变换</span>
                    <n-select v-model:value="draft.queryTransform" :options="TRANSFORM_OPTIONS" style="width: 160px" />
                </div>

                <h4>② 动作（可空 —— 不填就直接打开上面的地址）</h4>
                <div class="row">
                    <n-button size="small" :loading="recording" :disabled="!draft.detailUrl || !testQuery"
                        @click="recordSteps">录一遍</n-button>
                    <span class="note">在打开的窗口里像平时那样搜一次，我把它记成下面的步骤</span>
                </div>
                <RuleStepList :steps="draft.steps" />

                <h4>③ 封面选择器（按顺序试，命中即用）</h4>
                <div class="row">
                    <n-button size="small" :loading="picking" :disabled="!draft.detailUrl" @click="pickCover">
                        点选图片
                    </n-button>
                    <span class="note">{{ pickHint }}</span>
                </div>
                <RuleCoverList :candidates="coverCandidates" />

                <h4>④ 试跑</h4>
                <div class="row">
                    <n-input v-model:value="testQuery" placeholder="测试用番号，如 TST-123" style="width: 200px" />
                    <n-button type="primary" :loading="running" :disabled="!testQuery" @click="runTest">
                        试跑
                    </n-button>
                    <n-button :disabled="!draft.detailUrl" @click="openTarget">打开页面看看</n-button>
                    <n-button :disabled="!pageId" @click="useAsTemplate">用它做模板</n-button>
                    <n-checkbox v-model:checked="showWindow">显示窗口</n-checkbox>
                    <span class="note">用当前草稿试跑，不用先保存</span>
                </div>
                <RuleTestResult :last="last" />

                <div class="actions">
                    <n-button type="primary" :disabled="!saveReady" :loading="saving" @click="save">保存</n-button>
                    <span class="note">
                        {{ saveReady ? '保存后即时生效' : '先试跑，且封面要有命中值才能保存' }}
                    </span>
                </div>
            </section>
        </div>
    </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { NButton, NInput, NSelect, NCheckbox } from 'naive-ui';
import { getAction, postAction } from '@/utils/request';
import useNotify from '@/hooks/useNotify';
import RuleSiteList from '@/views/FileFinder/rules/RuleSiteList.vue';
import RuleStepList from '@/views/FileFinder/rules/RuleStepList.vue';
import RuleCoverList from '@/views/FileFinder/rules/RuleCoverList.vue';
import RuleTestResult from '@/views/FileFinder/rules/RuleTestResult.vue';
import {
    blankRule, canSave, cloneRule, toPayload, TRANSFORM_OPTIONS,
    type SiteRuleDraft, type TestRun,
} from '@/views/FileFinder/rules/ruleDraft';

// 统一写 127.0.0.1（同 FileFinder：localhost 可能解析到 ::1，服务端只绑 IPv4）
const API_BASE = 'http://127.0.0.1:3060';

const notify = useNotify();
const rules = ref<SiteRuleDraft[]>([]);
const draft = ref<SiteRuleDraft>(blankRule());
const isNew = ref(true);
const testQuery = ref('');
const running = ref(false);
const saving = ref(false);
const last = ref<TestRun | null>(null);
/** 试跑时把抓取窗显示出来 —— 用户反馈「看不到访问过程」（窗口结束仍会自动关闭） */
const showWindow = ref(false);
/** 刚才「打开页面看看」开的那个浏览窗的 id（用它反推入口模板） */
const pageId = ref('');
/** 「插入变量」下拉的受控值：插完清空 ⇒ 同一项还能再插一次 */
const inserting = ref<string | null>(null);
/** 点选 / 录制都是长请求（用户在窗口里操作），按钮要转圈 */
const picking = ref(false);
const recording = ref(false);
const pickHint = ref('在打开的窗口里点一下你要抓的那张图');

/** 可插入的占位符 —— 每种写法对应的"拼法"都写在标签里，不用记语法 */
const VAR_OPTIONS = [
    { label: '{q} 番号原样', value: '{q}' },
    { label: '{q|noDash} 去掉横杠', value: '{q|noDash}' },
    { label: '{q|lower} 转小写', value: '{q|lower}' },
    { label: '{q|upper} 转大写', value: '{q|upper}' },
    { label: '{q|num} 只留数字', value: '{q|num}' },
    { label: '{q|noDash|lower} 去横杠+小写', value: '{q|noDash|lower}' },
];

/** ⚠️ 直接把草稿里的数组交给子组件（子组件改它 = 改草稿），不要每层再拷一份 */
const coverCandidates = computed(() => draft.value.fields.cover.candidates);
const saveReady = computed(() => canSave(last.value, draft.value));

async function loadRules() {
    const res = await getAction(`${API_BASE}/assistant/rules`);
    rules.value = ((res?.rules ?? []) as unknown[]).map(cloneRule);
}

/** 切到某条规则 ⇒ 换草稿，并清掉上一次的试跑结果（否则"通过"的状态会串到别的站） */
function editRule(r: SiteRuleDraft) {
    draft.value = cloneRule(r);
    isNew.value = false;
    last.value = null;
}

function newRule() {
    draft.value = blankRule();
    isNew.value = true;
    last.value = null;
}

async function toggleRule(r: SiteRuleDraft, value: boolean) {
    await postAction(`${API_BASE}/assistant/rules`, { ...cloneRule(r), enabled: value });
    await loadRules();
    if (!isNew.value && draft.value.id === r.id) draft.value.enabled = value;
}

function fail(message: string) {
    last.value = {
        kind: 'error', message, ok: false, cf: false,
        httpStatus: 0, pageTitle: '', cover: '', title: '', steps: [],
    };
}

/**
 * 打开目标页给用户**自己看**（可见窗，不自动关闭）。
 * 地址由**后端**用同一套模板引擎展开 —— 免去"自己开浏览器研究站点"，
 * 也避免前端再实现一份拼法（两边不一致会出现"看到的是 A 页、抓的是 B 页"）。
 */
async function openTarget() {
    const res = await postAction(`${API_BASE}/assistant/openPage`, {
        rule: toPayload(draft.value),
        query: testQuery.value,
    });
    if (res?.code !== 200) {
        notify('error', '站点规则', res?.error || '打不开这个地址');
        return;
    }
    pageId.value = String(res.id || '');
}

/** 从那个浏览窗当前停的页面**反推模板**：番号那一截换成占位符 */
async function useAsTemplate() {
    const res = await postAction(`${API_BASE}/assistant/windowUrl`, {
        id: pageId.value,
        query: testQuery.value,
    });
    if (res?.code !== 200) {
        notify('error', '站点规则', res?.error || '读不到那个窗口（可能已经关掉了）');
        return;
    }
    if (!res.ok) {
        notify('warning', '站点规则', '这个地址里没找到该番号 —— 该站可能要先搜索（用②动作），或手动写');
        return;
    }
    draft.value.detailUrl = String(res.template || '');
    notify('success', '站点规则', `认出来了：番号位置写作 ${res.hit}`);
}

function insertVar(v: string) {
    draft.value.detailUrl = `${draft.value.detailUrl || ''}${v}`;
    inserting.value = null;
}

/** 点选一张图 → 加进封面候选链（放最前面：刚点的那张应该最优先） */
async function pickCover() {
    picking.value = true;
    try {
        const res = await postAction(`${API_BASE}/assistant/pick`, {
            rule: toPayload(draft.value),
            query: testQuery.value,
        });
        if (res?.code !== 200) { notify('error', '站点规则', res?.error || '打不开这个地址'); return; }
        if (res.cancelled) { notify('warning', '站点规则', '已取消点选'); return; }
        if (!res.ok || !res.selector) {
            notify('warning', '站点规则', '没点到图 —— 在窗口里点一下那张图就好');
            return;
        }
        coverCandidates.value.unshift({ kind: 'css', selector: String(res.selector), attr: 'src' });
        pickHint.value = res.weak
            ? `已加入：${res.selector}　（这条不太稳，站点改版可能失效）`
            : `已加入：${res.selector}`;
        notify('success', '站点规则', '已把这张图加进封面选择器');
    } finally {
        picking.value = false;
    }
}

/** 录一遍 → 用户的操作变成动作序列（值里的测试番号会被换成 {q}） */
async function recordSteps() {
    recording.value = true;
    try {
        const res = await postAction(`${API_BASE}/assistant/record`, {
            rule: toPayload(draft.value),
            query: testQuery.value,
        });
        if (res?.code !== 200) { notify('error', '站点规则', res?.error || '打不开这个地址'); return; }
        if (res.cancelled) { notify('warning', '站点规则', '已取消录制'); return; }
        if (!res.ok) {
            notify('warning', '站点规则', '没录到动作 —— 在窗口里操作完记得点「结束录制」');
            return;
        }
        const list = (res.steps ?? []) as { act: 'type' | 'click'; selector: string; value?: string }[];
        draft.value.steps = list.map((s) => ({ act: s.act, selector: s.selector, value: s.value }));
        notify('success', '站点规则', `录到 ${list.length} 步`);
    } finally {
        recording.value = false;
    }
}

async function runTest() {
    const p = toPayload(draft.value);
    if (!p.detailUrl) { notify('warning', '站点规则', '先填入口地址'); return; }
    running.value = true;
    last.value = null;
    try {
        const res = await postAction(`${API_BASE}/assistant/dryrun`, {
            rule: p,
            query: testQuery.value,
            show: showWindow.value,
        });
        if (res?.code && res.code !== 200) { fail(res.error || `试跑失败（${res.code}）`); return; }
        const f = (res?.fields ?? {}) as { cover?: string; title?: string };
        last.value = {
            kind: 'ok',
            ok: !!res?.ok,
            cf: !!res?.cf,
            httpStatus: Number(res?.httpStatus ?? 0),
            pageTitle: String(res?.pageTitle ?? ''),
            cover: String(f.cover ?? ''),
            title: String(f.title ?? ''),
            steps: res?.steps ?? [],
        };
    } catch (e) {
        fail(String(e));
    } finally {
        running.value = false;
    }
}

async function save() {
    saving.value = true;
    try {
        const res = await postAction(`${API_BASE}/assistant/rules`, toPayload(draft.value));
        if (res?.code && res.code !== 200) { notify('error', '站点规则', res.error || '保存失败'); return; }
        await loadRules();
        isNew.value = false;
        notify('success', '站点规则', '已保存 —— 规则即时生效');
    } finally {
        saving.value = false;
    }
}

/** 进页面即加载（原来是"打开弹窗时"加载） */
async function init() {
    last.value = null;
    await loadRules();
    const first = rules.value[0];
    if (first) editRule(first);
    else newRule();
}

onMounted(init);
</script>

<style lang="less" scoped>
/* 页容器（原来这里是 100vw×100vh 的弹窗） */
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
        color: var(--ff-text-1);
    }

    .page-sub {
        font-size: 12px;
        color: var(--ff-text-3);
    }
}

.rules-wrap {
    display: flex;
    flex: 1 1 auto;
    min-height: 0;
    padding-bottom: 16px;
    gap: 16px;
}

.rules-main {
    flex: 1 1 auto;
    min-width: 0;
    overflow-y: auto;
    padding-right: 6px;

    h4 {
        margin: 18px 0 8px;
        font-size: 13px;
        font-weight: 500;
        opacity: .85;
    }

    h4:first-child { margin-top: 0; }
}

.row,
.row2 {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-top: 8px;
}

.row2 > * {
    flex: 1 1 0;
    min-width: 0;
}

/* 模板输入框在 flex 行里要自己撑开（右侧是「插入变量」下拉） */
.row > .n-input {
    flex: 1 1 auto;
    min-width: 0;
}

.lbl {
    font-size: 13px;
    opacity: .8;
}

.note {
    font-size: 12px;
    opacity: .65;
}

.actions {
    display: flex;
    align-items: center;
    gap: 12px;
    margin: 18px 0 8px;
}
</style>
