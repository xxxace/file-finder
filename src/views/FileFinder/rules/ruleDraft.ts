/**
 * 站点规则编辑器 · 纯逻辑层（无 Vue 依赖）
 * ---------------------------------------------------------------------------
 * 为什么单独成文件：草稿的克隆 / 提交整理 / 保存闸门都是**纯函数** ——
 * 混在 .vue 里既没法被探针直接 bundle 测，也把组件撑大。
 */

export type Transform = 'none' | 'strip-dash' | 'lower';
export type ActKind = 'type' | 'click' | 'wait';
export type CandKind = 'css' | 'meta' | 'regex';

export interface FieldCandidate { kind: CandKind; selector: string; attr?: string; group?: number }

/** 草稿态：`ms` 一律是字符串 —— 它直接绑在 `n-input` 上（`n-input` 只吃 string） */
export interface ActionStep { act: ActKind; selector?: string; value?: string; ms?: string }

export interface SiteRuleDraft {
    id: string;
    name: string;
    enabled: boolean;
    detailUrl: string;
    transport: 'browser';
    queryTransform: Transform;
    /** 草稿内**一律是数组**（`cloneRule()` 兜底），免得模板里到处判空 */
    steps: ActionStep[];
    fields: { cover: { candidates: FieldCandidate[] } };
}

/** 提交态：`ms` 是数字（后端 `buildStepScript` 读它） */
export interface ActionStepWire { act: ActKind; selector?: string; value?: string; ms?: number }
export interface SiteRuleWire extends Omit<SiteRuleDraft, 'steps'> { steps: ActionStepWire[] }

export interface StepOutcome { index: number; act: string; ok: boolean; why?: string }

/** 一次试跑的结果（三段式回显的数据源） */
export interface TestRun {
    kind: 'ok' | 'error';
    /** 只有 kind==='error' 时有值（本地错误 / 后端 4xx-5xx） */
    message?: string;
    ok: boolean;
    cf: boolean;
    httpStatus: number;
    pageTitle: string;
    cover: string;
    title: string;
    steps: StepOutcome[];
    /** 页面上 <img> 的数量 —— 0 说明页面根本没到（被拦/走错页），不是选择器问题 */
    imgCount: number;
    /** 前几张图的真实地址（src/data-src/…），用来判断"真图在哪个属性里" */
    sampleSrcs: string[];
    /** 抓不到时，当时那份页面 HTML 存到了哪（数据目录里的绝对路径）—— 自己打开看真相 */
    snapFile?: string;
    /** 抓不到时页面实际停在哪个地址 */
    snapUrl?: string;
}

export const TRANSFORM_OPTIONS = [
    { label: '不处理', value: 'none' },
    { label: '去掉横杠', value: 'strip-dash' },
    { label: '转小写', value: 'lower' },
];

export const ACT_OPTIONS = [
    { label: '输入', value: 'type' },
    { label: '点击', value: 'click' },
    { label: '等待', value: 'wait' },
];

export const KIND_OPTIONS = [
    { label: 'CSS', value: 'css' },
    { label: 'meta', value: 'meta' },
    { label: '正则', value: 'regex' },
];

const newCoverChain = (): FieldCandidate[] => [{ kind: 'css', selector: '', attr: 'src' }];

export const blankRule = (): SiteRuleDraft => ({
    id: '',
    name: '',
    enabled: true,
    detailUrl: '',
    transport: 'browser',
    queryTransform: 'none',
    steps: [],
    fields: { cover: { candidates: newCoverChain() } },
});

/**
 * 把**任何来源**的规则（后端 JSON / 编辑器草稿）变成完整可编辑的草稿。
 * 后端存量规则没有 `steps` / `images`（P3.1 才新增）⇒ 这里必须兜底。
 */
export function cloneRule(raw: unknown): SiteRuleDraft {
    const base = blankRule();
    const r = (raw ?? {}) as Partial<SiteRuleDraft>;
    const c = JSON.parse(JSON.stringify(r)) as Partial<SiteRuleDraft>;
    return {
        ...base,
        ...c,
        transport: 'browser',
        queryTransform: (c.queryTransform ?? 'none') as Transform,
        steps: Array.isArray(c.steps) ? (c.steps as ActionStep[]) : [],
        fields: {
            cover: {
                candidates: c.fields?.cover?.candidates?.length
                    ? c.fields.cover.candidates
                    : newCoverChain(),
            },
        },
    };
}

/** 草稿 → 提交给后端的形状：丢掉空候选、`wait` 的空 `ms` 去掉、`ms` 转数字 */
export function toPayload(d: SiteRuleDraft): SiteRuleWire {
    return {
        ...d,
        steps: d.steps.map((s) => {
            const o: ActionStepWire = { act: s.act };
            if (s.selector) o.selector = s.selector;
            if (s.act === 'type') o.value = s.value || '{q}';
            if (s.act === 'wait') {
                const n = Number(s.ms);
                if (n > 0) o.ms = n;
            }
            return o;
        }),
        fields: { cover: { candidates: d.fields.cover.candidates.filter((c) => !!c.selector) } },
    };
}

/**
 * 保存闸门：**试跑通过 且 封面有命中值**（PRD AC-7）。
 * ⚠️ 这是产品要求，不是可选校验 —— 不让"没验证过的规则"进生产。
 */
export function canSave(last: TestRun | null, d: SiteRuleDraft): boolean {
    if (!last || last.kind !== 'ok' || !last.ok || !last.cover) return false;
    return !!d.id && !!d.detailUrl;
}

/** 列表里显示站点主机名（地址写错时不至于整行空白） */
export function hostOf(url: string): string {
    try {
        return new URL(url).host;
    } catch {
        return url;
    }
}
