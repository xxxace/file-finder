/**
 * 站点规则编辑器 · 纯逻辑层（无 Vue 依赖）
 * ---------------------------------------------------------------------------
 * 为什么单独成文件：草稿的克隆 / 提交整理 / 保存闸门都是**纯函数** ——
 * 混在 .vue 里既没法被探针直接 bundle 测，也把组件撑大。
 */

export type Transform = 'none' | 'strip-dash' | 'lower';
export type ActKind = 'type' | 'click' | 'press' | 'goto' | 'wait';
export type CandKind = 'css' | 'xpath' | 'meta' | 'regex' | 'script';

export interface FieldCandidate { kind: CandKind; selector: string; attr?: string; group?: number }

/** 草稿态：`ms` 一律是字符串 —— 它直接绑在 `n-input` 上（`n-input` 只吃 string） */
export interface ActionStep { act: ActKind; selector?: string; value?: string; key?: string; url?: string; ms?: string }

export interface SiteRuleDraft {
    id: string;
    name: string;
    enabled: boolean;
    detailUrl: string;
    transport: 'browser';
    queryTransform: Transform;
    verified?: boolean;
    verifiedAt?: string;
    /** 草稿内**一律是数组**（`cloneRule()` 兜底），免得模板里到处判空 */
    steps: ActionStep[];
    fields: {
        cover: { candidates: FieldCandidate[] };
        title: { candidates: FieldCandidate[] };
        actress: { candidates: FieldCandidate[] };
        actressLink: { candidates: FieldCandidate[] };
    };
}

/** 提交态：`ms` 是数字（后端 `buildStepScript` 读它） */
export interface ActionStepWire { act: ActKind; selector?: string; value?: string; key?: string; url?: string; ms?: number }
export interface SiteRuleWire extends Omit<SiteRuleDraft, 'steps' | 'fields'> {
    steps: ActionStepWire[];
    fields: {
        cover: { candidates: FieldCandidate[] };
        title?: { candidates: FieldCandidate[] };
        actress?: { candidates: FieldCandidate[] };
        actressLink?: { candidates: FieldCandidate[] };
    };
}

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
    actress?: string;
    actressLink?: string;
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
    { label: '按键', value: 'press' },
    { label: '跳转', value: 'goto' },
    { label: '等待', value: 'wait' },
];

export const KIND_OPTIONS = [
    { label: 'CSS', value: 'css' },
    { label: 'XPath', value: 'xpath' },
    { label: 'meta', value: 'meta' },
    { label: '正则', value: 'regex' },
    { label: '脚本', value: 'script' },
];

const newCoverChain = (): FieldCandidate[] => [{ kind: 'css', selector: '', attr: 'src|data-src|data-original' }];

export const blankRule = (): SiteRuleDraft => ({
    id: '',
    name: '',
    enabled: true,
    detailUrl: '',
    transport: 'browser',
    queryTransform: 'none',
    verified: false,
    steps: [],
    fields: {
        cover: { candidates: newCoverChain() },
        title: { candidates: [] },
        actress: { candidates: [] },
        actressLink: { candidates: [] },
    },
});

/**
 * 把**任何来源**的规则（后端 JSON / 编辑器草稿）变成完整可编辑的草稿。
 */
export function cloneRule(raw: unknown): SiteRuleDraft {
    const base = blankRule();
    const r = (raw ?? {}) as Partial<SiteRuleDraft>;
    const c = JSON.parse(JSON.stringify(r)) as Partial<SiteRuleDraft>;
    const steps = Array.isArray(c.steps)
        ? (c.steps as Array<Partial<ActionStep> & { ms?: number | string }>).map((s) => ({
            ...s,
            act: (s.act ?? 'click') as ActKind,
            ms: s.ms !== undefined && s.ms !== null ? String(s.ms) : undefined,
        }))
        : [];
    return {
        ...base,
        ...c,
        transport: 'browser',
        queryTransform: (c.queryTransform ?? 'none') as Transform,
        steps,
        fields: {
            cover: {
                candidates: c.fields?.cover?.candidates?.length
                    ? c.fields.cover.candidates
                    : newCoverChain(),
            },
            title: { candidates: c.fields?.title?.candidates ?? [] },
            actress: { candidates: c.fields?.actress?.candidates ?? [] },
            actressLink: { candidates: c.fields?.actressLink?.candidates ?? [] },
        },
    };
}

/** 草稿 → 提交给后端的形状：丢掉空候选、`wait` 的空 `ms` 去掉、`ms` 转数字 */
export function toPayload(d: SiteRuleDraft): SiteRuleWire {
    const clean = (list: FieldCandidate[]) => list.filter((c) => !!c.selector.trim());
    const title = clean(d.fields.title?.candidates ?? []);
    const actress = clean(d.fields.actress?.candidates ?? []);
    const actressLink = clean(d.fields.actressLink?.candidates ?? []);
    const fields: SiteRuleWire['fields'] = {
        cover: { candidates: clean(d.fields.cover.candidates) },
    };
    if (title.length) fields.title = { candidates: title };
    if (actress.length) fields.actress = { candidates: actress };
    if (actressLink.length) fields.actressLink = { candidates: actressLink };

    return {
        ...d,
        id: d.id.trim(),
        name: d.name.trim(),
        detailUrl: d.detailUrl.trim(),
        steps: d.steps.map((s) => {
            const o: ActionStepWire = { act: s.act };
            if (s.selector) o.selector = s.selector;
            if (s.act === 'type') o.value = s.value || '{q}';
            if (s.act === 'press') o.key = s.key || 'Enter';
            if (s.act === 'goto') o.url = s.url || '';
            if (s.act === 'wait') {
                const n = Number(s.ms);
                if (n > 0) o.ms = n;
            }
            return o;
        }),
        fields,
    };
}

/**
 * 随时保存草稿：只需填写合法的站点 ID 与 http(s) 入口地址。
 */
export function canSave(_last: TestRun | null, d: SiteRuleDraft): boolean {
    return !!d.id.trim() && /^https?:\/\//i.test(d.detailUrl.trim());
}

/** 根据网址反推一个默认的站点 ID（如 https://www.javbus.com/{q} -> javbus） */
export function suggestRuleId(url: string): string {
    try {
        const host = new URL(url).hostname.replace(/^www\./i, '');
        const seg = host.split('.')[0] || host;
        return seg.toLowerCase().replace(/[^a-z0-9_-]/g, '');
    } catch {
        return '';
    }
}

/** 实时预览展开后的访问地址（与后端 urlTemplate.ts 口径一致） */
export function previewUrl(template: string, query: string, transform: Transform): string {
    if (!template || !query) return template;
    const applyPipe = (v: string, fn: string) => {
        if (fn === 'noDash') return v.replace(/-/g, '');
        if (fn === 'lower') return v.toLowerCase();
        if (fn === 'upper') return v.toUpperCase();
        if (fn === 'num') {
            const runs = v.match(/\d+/g) || [];
            return runs.reduce((a, b) => (b.length >= a.length ? b : a), '');
        }
        if (fn === 'alpha') return v.replace(/[^A-Za-z]/g, '');
        return v;
    };
    return template.replace(/\{q((?:\|[A-Za-z]+)*)\}/g, (_m, suffix: string) => {
        const fns = String(suffix).split('|').filter(Boolean);
        if (!fns.length) {
            const v = transform === 'strip-dash' ? query.replace(/-/g, '')
                : transform === 'lower' ? query.toLowerCase() : query;
            return encodeURIComponent(v);
        }
        let v = query;
        for (const f of fns) v = applyPipe(v, f);
        return fns.includes('raw') ? v : encodeURIComponent(v);
    });
}

/** 列表里显示站点主机名（地址写错时不至于整行空白） */
export function hostOf(url: string): string {
    try {
        return new URL(url).host;
    } catch {
        return url;
    }
}
