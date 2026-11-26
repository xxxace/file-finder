<template>
    <div class="rules-wrap">
        <RuleSiteList :rules="rules" :active-id="draft.id" @select="editRule" @create="newRule"
            @toggle="toggleRule" @remove="removeRule" @move="moveRule" />

        <section class="rules-main">
            <!-- 顶部固定栏：拆分「编辑提交（保存/还原）」与「调试工具条」，避免保存按钮换行掉落 -->
            <div class="editor-head">
                <div class="editor-bar">
                    <div class="editor-id">
                        <span class="editor-name">{{ draft.name || draft.id || '新建站点' }}</span>
                        <span v-if="isDirty" class="dirty-tag">未保存</span>
                    </div>
                    <div class="editor-acts">
                        <n-button v-if="isDirty && !isNew" size="small" quaternary title="放弃未保存修改"
                            @click="resetDraft">
                            <template #icon><n-icon><RefreshOutline /></n-icon></template>
                            还原
                        </n-button>
                        <n-button size="small" type="primary" :disabled="!saveReady" :loading="saving" @click="save">
                            <template #icon><n-icon><SaveOutline /></n-icon></template>
                            保存
                        </n-button>
                    </div>
                </div>
                <div class="debug-bar">
                    <span class="debug-lbl">调试番号</span>
                        <n-input ref="queryInputRef" v-model:value="testQuery" class="query-input"
                            placeholder="如 TST-001" />
                    <n-button v-if="running" size="small" type="warning" @click="cancelTest">取消试跑</n-button>
                    <n-button v-else size="small" secondary :disabled="!draft.detailUrl || !testQuery"
                        @click="runTest">
                        <template #icon><n-icon><PlayOutline /></n-icon></template>
                        试跑
                    </n-button>
                    <n-checkbox v-model:checked="showWindow" class="no-wrap">显示窗口</n-checkbox>
                    <n-button size="small" secondary :disabled="!draft.detailUrl" @click="openTarget">
                        <template #icon><n-icon><OpenOutline /></n-icon></template>
                        打开页面
                    </n-button>
                    <n-button v-if="pageId" size="small" secondary @click="useAsTemplate">
                        <template #icon><n-icon><LinkOutline /></n-icon></template>
                        提取模板
                    </n-button>
                </div>
            </div>

            <!-- 试跑结果就近回显在工具栏下方，无需上下翻找 -->
            <RuleTestResult :last="last" :challenging="challenging" @challenge="challengeAndRetry"
                @clear-session="clearSiteCookies" @close="last = null" />

            <!-- 第 1 步：入口 -->
            <div class="rule-card">
                <div class="step-head">
                    <span class="step-badge">1</span>
                    <span class="step-title">入口地址</span>
                    <span class="step-sub">配置站点名称与打开作品页的地址规则</span>
                </div>

                <div class="field-grid">
                    <div class="field-col">
                        <label class="field-lbl">站点 ID（唯一标识）</label>
                        <n-input v-if="isNew" v-model:value="draft.id" placeholder="英文标识，如 mysite（保存后不可改）" />
                        <n-input v-else :value="draft.id" readonly />
                    </div>
                    <div class="field-col">
                        <label class="field-lbl">显示名称</label>
                        <n-input v-model:value="draft.name" placeholder="列表里看到的名字，如 JavBus" />
                    </div>
                </div>

                <div class="field-col mt">
                    <label class="field-lbl">地址模板（用 {q} 表示番号位置）</label>
                    <div class="row">
                        <n-input v-model:value="draft.detailUrl"
                            placeholder="例如 https://www.javbus.com/{q}（若要先站内搜索，填首页地址即可）"
                            @blur="autoFillId" />
                        <n-select v-model:value="inserting" :options="VAR_OPTIONS" placeholder="插入变量"
                            style="width: 176px; flex: 0 0 176px" @update:value="insertVar" />
                    </div>
                    <div v-if="urlPreview" class="url-preview">
                        实际访问：<span>{{ urlPreview }}</span>
                    </div>
                </div>

                <div class="row mt">
                    <span class="lbl">默认番号格式</span>
                    <n-select v-model:value="draft.queryTransform" :options="TRANSFORM_OPTIONS"
                        style="width: 150px; flex: 0 0 150px" />
                    <span class="note">仅对普通 {q} 生效；若地址中已使用 {q|...} 变体，则按该变体处理</span>
                </div>
            </div>

            <!-- 第 2 步：动作 -->
            <div class="rule-card">
                <div class="step-head">
                    <span class="step-badge">2</span>
                    <span class="step-title">站内动作</span>
                    <span class="step-sub">可选：若必须先在站内搜索框输入再点击进入详情页，可在此录制步骤</span>
                </div>
                <div class="row">
                    <n-button size="small" secondary :loading="recording" :disabled="!draft.detailUrl"
                        @click="recordSteps">
                        <template #icon><n-icon class="rec-dot"><RadioButtonOnOutline /></n-icon></template>
                        {{ recording ? '正在录制…' : '录一遍操作' }}
                    </n-button>
                    <span class="note">打开网页后像平时那样搜索一次（支持输入、点击、按 Enter），点「结束录制」即可生成步骤</span>
                </div>
                <div class="mt">
                    <RuleStepList :steps="draft.steps" />
                </div>
            </div>

            <!-- 第 3 步：封面提取 -->
            <div class="rule-card">
                <div class="step-head">
                    <span class="step-badge">3</span>
                    <span class="step-title">封面提取规则</span>
                    <span class="step-sub">推荐直接点选图片；按从上到下顺序尝试，命中第一张有效图即用</span>
                </div>
                <div class="row">
                    <n-button size="small" secondary :loading="picking === 'cover'" :disabled="!draft.detailUrl"
                        @click="pickField('cover')">
                        <template #icon><n-icon><ColorWandOutline /></n-icon></template>
                        点选页面图片
                    </n-button>
                    <span class="note">{{ pickHint }}</span>
                </div>
                <div class="mt">
                    <RuleCoverList :candidates="coverCandidates" mode="cover" />
                </div>

                <details class="adv-fields">
                    <summary>高级字段：标题 / 演员 / 演员链接（可选，不影响封面抓取）</summary>
                    <div class="adv-block">
                        <div class="row">
                            <span class="lbl">标题</span>
                            <n-button size="tiny" secondary :loading="picking === 'title'" :disabled="!draft.detailUrl"
                                @click="pickField('title')">点选标题</n-button>
                        </div>
                        <div class="mt-sm">
                            <RuleCoverList :candidates="draft.fields.title.candidates" mode="text" />
                        </div>

                        <div class="row mt">
                            <span class="lbl">演员名称</span>
                            <n-button size="tiny" secondary :loading="picking === 'actress'" :disabled="!draft.detailUrl"
                                @click="pickField('actress')">点选演员</n-button>
                        </div>
                        <div class="mt-sm">
                            <RuleCoverList :candidates="draft.fields.actress.candidates" mode="text" />
                        </div>

                        <div class="row mt">
                            <span class="lbl">演员链接</span>
                            <n-button size="tiny" secondary :loading="picking === 'actressLink'"
                                :disabled="!draft.detailUrl" @click="pickField('actressLink')">点选链接</n-button>
                        </div>
                        <div class="mt-sm">
                            <RuleCoverList :candidates="draft.fields.actressLink.candidates" mode="link" />
                        </div>
                    </div>
                </details>
            </div>
        </section>
    </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { NButton, NCheckbox, NIcon, NInput, NSelect } from 'naive-ui';
import {
    ColorWandOutline, LinkOutline, OpenOutline, PlayOutline,
    RadioButtonOnOutline, RefreshOutline, SaveOutline,
} from '@vicons/ionicons5';
import { API_BASE, deletAction, getAction, postAction } from '@/utils/request';
import useNotify from '@/hooks/useNotify';
import RuleSiteList from '@/views/FileFinder/rules/RuleSiteList.vue';
import RuleStepList from '@/views/FileFinder/rules/RuleStepList.vue';
import RuleCoverList from '@/views/FileFinder/rules/RuleCoverList.vue';
import RuleTestResult from '@/views/FileFinder/rules/RuleTestResult.vue';
import {
    blankRule, canSave, cloneRule, previewUrl, suggestRuleId, toPayload, TRANSFORM_OPTIONS,
    type SiteRuleDraft, type TestRun,
} from '@/views/FileFinder/rules/ruleDraft';

const DEFAULT_PICK_HINT = '点选后自动识别 CSS / XPath 与图片属性（支持背景图与遮罩穿透）';

const notify = useNotify();
const rules = ref<SiteRuleDraft[]>([]);
const draft = ref<SiteRuleDraft>(blankRule());
const savedSnap = ref(JSON.stringify(toPayload(blankRule())));
const isNew = ref(true);
const testQuery = ref('');
const running = ref(false);
const challenging = ref(false);
const saving = ref(false);
const last = ref<TestRun | null>(null);
const showWindow = ref(false);
const pageId = ref('');
const inserting = ref<string | null>(null);
const picking = ref<'cover' | 'title' | 'actress' | 'actressLink' | ''>('');
const recording = ref(false);
const pickHint = ref(DEFAULT_PICK_HINT);
const queryInputRef = ref<{ focus: () => void } | null>(null);

const VAR_OPTIONS = [
    { label: '{q} 番号原样', value: '{q}' },
    { label: '{q|noDash} 去掉横杠', value: '{q|noDash}' },
    { label: '{q|lower} 转小写', value: '{q|lower}' },
    { label: '{q|upper} 转大写', value: '{q|upper}' },
    { label: '{q|num} 最长数字段', value: '{q|num}' },
    { label: '{q|alpha} 仅字母', value: '{q|alpha}' },
    { label: '{q|noDash|lower} 去横杠+小写', value: '{q|noDash|lower}' },
    { label: '{q|raw} 不做URL编码', value: '{q|raw}' },
];

const coverCandidates = computed(() => draft.value.fields.cover.candidates);
const saveReady = computed(() => canSave(last.value, draft.value));
const isDirty = computed(() => JSON.stringify(toPayload(draft.value)) !== savedSnap.value);
const urlPreview = computed(() => {
    const q = testQuery.value.trim();
    const tpl = draft.value.detailUrl.trim();
    if (!q || !tpl || !/\{q/i.test(tpl)) return '';
    return previewUrl(tpl, q, draft.value.queryTransform);
});

async function loadRules() {
    const res = await getAction(`${API_BASE}/assistant/rules`);
    rules.value = ((res?.rules ?? []) as unknown[]).map(cloneRule);
}

function editRule(r: SiteRuleDraft) {
    draft.value = cloneRule(r);
    savedSnap.value = JSON.stringify(toPayload(draft.value));
    isNew.value = false;
    last.value = null;
    pageId.value = '';
    pickHint.value = DEFAULT_PICK_HINT;
}

function newRule() {
    draft.value = blankRule();
    savedSnap.value = JSON.stringify(toPayload(draft.value));
    isNew.value = true;
    last.value = null;
    pageId.value = '';
    pickHint.value = DEFAULT_PICK_HINT;
}

function resetDraft() {
    const orig = rules.value.find((r) => r.id === draft.value.id);
    if (orig) editRule(orig);
}

function autoFillId() {
    if (!isNew.value || draft.value.id.trim()) return;
    const guessed = suggestRuleId(draft.value.detailUrl);
    if (guessed) {
        draft.value.id = guessed;
        if (!draft.value.name.trim()) draft.value.name = guessed;
    }
}

async function toggleRule(r: SiteRuleDraft, value: boolean) {
    await postAction(`${API_BASE}/assistant/rules`, { ...toPayload(cloneRule(r)), enabled: value });
    await loadRules();
    if (!isNew.value && draft.value.id === r.id) {
        draft.value.enabled = value;
        // 仅同步 savedSnap 里的 enabled 字段，保留未保存的表单编辑状态
        try {
            const snap = JSON.parse(savedSnap.value) as Record<string, unknown>;
            snap.enabled = value;
            savedSnap.value = JSON.stringify(snap);
        } catch {
            savedSnap.value = JSON.stringify(toPayload(draft.value));
        }
    }
}

async function removeRule(r: SiteRuleDraft) {
    const res = await deletAction(`${API_BASE}/assistant/rules?id=${encodeURIComponent(r.id)}`);
    rules.value = ((res?.rules ?? []) as unknown[]).map(cloneRule);
    if (!isNew.value && draft.value.id === r.id) {
        if (rules.value[0]) editRule(rules.value[0]);
        else newRule();
    }
    notify('success', '站点规则', `已删除「${r.name || r.id}」`);
}

async function moveRule(index: number, delta: number) {
    const j = index + delta;
    if (j < 0 || j >= rules.value.length) return;
    const ids = rules.value.map((r) => r.id);
    [ids[index], ids[j]] = [ids[j], ids[index]];
    const res = await postAction(`${API_BASE}/assistant/rules/reorder`, { ids });
    rules.value = ((res?.rules ?? []) as unknown[]).map(cloneRule);
}

function ensureQueryIfNeeded(): boolean {
    if (/\{q/i.test(draft.value.detailUrl) && !testQuery.value.trim()) {
        notify('info', '站点规则', '入口地址包含 {q}，请先在顶部「调试番号」填一个测试番号');
        queryInputRef.value?.focus();
        return false;
    }
    return true;
}

function fail(message: string) {
    last.value = {
        kind: 'error', message, ok: false, cf: false,
        httpStatus: 0, pageTitle: '', cover: '', title: '', steps: [],
        imgCount: 0, sampleSrcs: [],
    };
}

async function openTarget() {
    if (!ensureQueryIfNeeded()) return;
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

async function useAsTemplate() {
    const res = await postAction(`${API_BASE}/assistant/windowUrl`, {
        id: pageId.value,
        query: testQuery.value,
    });
    if (res?.code !== 200) {
        notify('error', '站点规则', res?.error || '读不到那个窗口（可能已经关掉了）');
        pageId.value = '';
        return;
    }
    if (!res.ok) {
        notify('warning', '站点规则', '当前页地址里没包含测试番号 —— 若是搜索站请改用第 2 步「录一遍操作」');
        return;
    }
    draft.value.detailUrl = String(res.template || '');
    autoFillId();
    notify('success', '站点规则', `已识别详情页模板：番号位置写作 ${res.hit}`);
}

function insertVar(v: string) {
    draft.value.detailUrl = `${draft.value.detailUrl || ''}${v}`;
    inserting.value = null;
}

async function pickField(field: 'cover' | 'title' | 'actress' | 'actressLink') {
    if (!ensureQueryIfNeeded()) return;
    picking.value = field;
    const kind = field === 'cover' ? 'cover' : field === 'actressLink' ? 'link' : 'text';
    try {
        const res = await postAction(`${API_BASE}/assistant/pick`, {
            rule: toPayload(draft.value),
            query: testQuery.value,
            kind,
        });
        if (res?.code !== 200) { notify('error', '站点规则', res?.error || '打不开这个地址'); return; }
        if (res.cancelled) { notify('warning', '站点规则', '已取消点选'); return; }
        if (!res.ok || (!res.selector && !res.xpath)) {
            notify('warning', '站点规则', '没点到元素 —— 在窗口里点击目标位置即可');
            return;
        }
        const useXpath = !res.selector || (!!res.weak && !!res.xpath);
        const cand = {
            kind: useXpath ? ('xpath' as const) : ('css' as const),
            selector: String(useXpath ? res.xpath : res.selector),
            attr: String(res.attr || (field === 'cover' ? 'src|data-src' : field === 'actressLink' ? 'href' : 'text')),
        };
        draft.value.fields[field].candidates.unshift(cand);
        if (field === 'cover') {
            pickHint.value = res.weak
                ? `已添加 XPath 到第 1 条（若改版失效可重新点选或试跑确认）`
                : `已添加到第 1 条：${cand.selector}（属性 ${cand.attr}）`;
        }
        notify('success', '站点规则', '已将点选结果加入第 1 条候选');
    } finally {
        picking.value = '';
    }
}

async function recordSteps() {
    if (!ensureQueryIfNeeded()) return;
    if (!testQuery.value.trim()) {
        notify('info', '站点规则', '提示：未填调试番号时，输入的搜索词不会自动替换为 {q}');
    }
    recording.value = true;
    try {
        const res = await postAction(`${API_BASE}/assistant/record`, {
            rule: toPayload(draft.value),
            query: testQuery.value,
        });
        if (res?.code !== 200) { notify('error', '站点规则', res?.error || '打不开这个地址'); return; }
        if (res.cancelled) { notify('warning', '站点规则', '已取消录制'); return; }
        if (!res.ok) {
            notify('warning', '站点规则', '没录到动作 —— 操作完后记得点击底部红色的「结束录制」按钮');
            return;
        }
        const list = (res.steps ?? []) as { act: 'type' | 'click' | 'press'; selector: string; value?: string; key?: string }[];
        const mapped = list.map((s) => ({ act: s.act, selector: s.selector, value: s.value, key: s.key }));
        draft.value.steps = draft.value.steps.length ? [...draft.value.steps, ...mapped] : mapped;
        notify('success', '站点规则', `已录到 ${list.length} 步操作`);
    } finally {
        recording.value = false;
    }
}

let testAbort: AbortController | null = null;

async function runTest() {
    const p = toPayload(draft.value);
    if (!p.detailUrl) { notify('warning', '站点规则', '请先填写入口地址'); return; }
    const ac = new AbortController();
    testAbort = ac;
    running.value = true;
    last.value = null;
    try {
        const res = await postAction(`${API_BASE}/assistant/dryrun`, {
            rule: p,
            query: testQuery.value,
            show: showWindow.value,
        }, { signal: ac.signal });
        if (res?.code && res.code !== 200) { fail(res.error || `试跑失败（${res.code}）`); return; }
        const f = (res?.fields ?? {}) as {
            cover?: string; title?: string; actress?: string; actressLink?: string;
            imgCount?: number; sampleSrcs?: string[];
        };
        const hitOk = !!res?.ok && !!f.cover;
        if (hitOk) {
            draft.value.verified = true;
            draft.value.verifiedAt = new Date().toISOString();
        }
        last.value = {
            kind: 'ok',
            ok: !!res?.ok,
            cf: !!res?.cf,
            httpStatus: Number(res?.httpStatus ?? 0),
            pageTitle: String(res?.pageTitle ?? ''),
            cover: String(f.cover ?? ''),
            title: String(f.title ?? ''),
            actress: String(f.actress ?? ''),
            actressLink: String(f.actressLink ?? ''),
            steps: res?.steps ?? [],
            imgCount: Number(f.imgCount ?? 0),
            sampleSrcs: (f.sampleSrcs ?? []) as string[],
            snapFile: String((res?.snapshot as { file?: string } | null)?.file ?? ''),
            snapUrl: String((res?.snapshot as { url?: string } | null)?.url ?? ''),
        };
    } catch (e) {
        if (ac.signal.aborted) notify('info', '站点规则', '已取消试跑');
        else fail(String(e));
    } finally {
        running.value = false;
        if (testAbort === ac) testAbort = null;
    }
}

async function challengeAndRetry() {
    challenging.value = true;
    try {
        const res = await postAction(`${API_BASE}/assistant/rules/challenge`, {
            rule: toPayload(draft.value),
            query: testQuery.value,
        });
        if (res?.ok) {
            notify('success', '站点规则', '验证已通过，正在重新试跑');
            await runTest();
        } else if (!res?.abandoned) {
            notify('warning', '站点规则', '验证超时或未完成');
        }
    } finally {
        challenging.value = false;
    }
}

async function clearSiteCookies() {
    const res = await postAction(`${API_BASE}/assistant/rules/clear-session`, {
        rule: toPayload(draft.value),
        query: testQuery.value,
    });
    if (res?.ok) notify('success', '站点规则', '已清理该站点的本地 Cookie 与缓存');
    else notify('warning', '站点规则', '清理失败（请检查入口地址是否有效）');
}

const cancelTest = () => {
    testAbort?.abort();
};

async function save() {
    saving.value = true;
    try {
        if (last.value?.ok && last.value?.cover) {
            draft.value.verified = true;
            draft.value.verifiedAt = new Date().toISOString();
        }
        const res = await postAction(`${API_BASE}/assistant/rules`, toPayload(draft.value));
        if (res?.code && res.code !== 200) { notify('error', '站点规则', res.error || '保存失败'); return; }
        savedSnap.value = JSON.stringify(toPayload(draft.value));
        await loadRules();
        isNew.value = false;
        notify('success', '站点规则', '已保存 —— 规则即时生效');
    } finally {
        saving.value = false;
    }
}

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
.rules-wrap {
    display: flex;
    flex: 1 1 auto;
    min-height: 0;
    gap: 16px;
}

.rules-main {
    flex: 1 1 auto;
    min-width: 0;
    overflow-y: auto;
    padding-right: 6px;
    display: flex;
    flex-direction: column;
    gap: 12px;
}

/* 顶部固定栏是全页唯一「真的会盖住滚动内容」的面 ⇒ 只有这里吃 backdrop 模糊，
   所以走 --ff-glass-cover-*（够不透明，字不会从底下渗上来）。 */
.editor-head {
    position: sticky;
    top: 0;
    z-index: 2;
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 12px 16px;
    border-radius: var(--ff-r-card);
    background: var(--ff-glass-cover-bg);
    box-shadow: var(--ff-glass-cover-shadow);
    backdrop-filter: var(--ff-glass-cover-backdrop);
}

.editor-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
}

.editor-id {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
}

.editor-name {
    font-size: var(--ff-fs-title);
    font-weight: 500;
    color: var(--ff-text-1);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.editor-acts {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: 0 0 auto;
}

.debug-bar {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
    padding-top: 10px;
    border-top: 1px solid var(--ff-line);
}

.debug-lbl {
    font-size: var(--ff-fs-meta);
    font-weight: 500;
    color: var(--ff-text-2);
    white-space: nowrap;
}

.query-input {
    width: 170px;
    flex: 0 0 170px;
}

.rec-dot {
    color: var(--ff-danger);
}

.dirty-tag {
    font-size: var(--ff-fs-eyebrow);
    color: var(--ff-warn);
    white-space: nowrap;
}

/* 玻璃板：同 GeneralPanel 的 .set-card（不挂 backdrop，理由见 tokens 的 --ff-glass-*） */
.rule-card {
    padding: 14px 16px;
    border-radius: var(--ff-r-card);
    background: var(--ff-glass-bg);
    box-shadow: var(--ff-glass-shadow);
}

.step-head {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
    margin-bottom: 12px;
}

.step-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    border-radius: var(--ff-r-pill);
    background: var(--ff-raised);
    font-size: var(--ff-fs-meta);
    font-weight: 500;
    color: var(--ff-text-1);
    flex: 0 0 auto;
}

.step-title {
    font-size: var(--ff-fs-title);
    font-weight: 500;
    color: var(--ff-text-1);
}

.step-sub {
    font-size: var(--ff-fs-meta);
    color: var(--ff-text-2);
}

.field-grid {
    display: flex;
    gap: 12px;
}

.field-col {
    flex: 1 1 0;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 5px;
}

.field-lbl {
    font-size: var(--ff-fs-meta);
    font-weight: 500;
    color: var(--ff-text-2);
}

.url-preview {
    font-size: var(--ff-fs-meta);
    color: var(--ff-text-2);
    word-break: break-all;
    padding: 2px 2px 0;

    span {
        font-family: ui-monospace, monospace;
        color: var(--ff-text-1);
    }
}

.row {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 10px;
}

.row > .n-input {
    flex: 1 1 220px;
    min-width: 0;
}

.test-bar {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 10px;
}

.no-wrap {
    white-space: nowrap;
    flex-shrink: 0;
}

.mt { margin-top: 10px; }
.mt-sm { margin-top: 6px; }

.lbl {
    font-size: var(--ff-fs-body);
    color: var(--ff-text-1);
    white-space: nowrap;
}

.note {
    font-size: var(--ff-fs-meta);
    line-height: 1.5;
    color: var(--ff-text-2);
}

.adv-fields {
    margin-top: 12px;
    padding: 10px 12px;
    border-radius: var(--ff-r-ctl);
    background: var(--ff-raised);

    summary {
        cursor: pointer;
        font-size: var(--ff-fs-body);
        font-weight: 500;
        color: var(--ff-text-1);
    }
}

.adv-block {
    margin-top: 10px;
}
</style>
