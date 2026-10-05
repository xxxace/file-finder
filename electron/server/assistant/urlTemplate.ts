/**
 * URL 模板引擎（纯函数，无 Electron 依赖 ⇒ 可被探针直接 bundle 测）
 * ===========================================================================
 * 占位符：`{q}` 或 `{q|fn|fn…}`
 *   - `{q}`      = 经站点 `queryTransform` 处理（+ URL 编码）—— **存量规则的语义，不许变**
 *   - `{q|fn…}`  = 对**原始**查询词套管道函数（**不再**叠加 queryTransform）
 * 管道函数：`noDash`(去横杠) / `lower` / `upper` / `num`(最长数字段) / `alpha`(字母拼接) / `raw`(不编码)
 *
 * ⚠️ **本文件不依赖任何其他模块** —— 因为 `rules.ts` 要反向引用它（`buildStepScript` 用它填输入框），
 *    依赖一旦双向就成环。`QueryTransform` / `applyQueryTransform` 因此也放在这里由 `rules.ts` 转出。
 */

export type QueryTransform = 'none' | 'strip-dash' | 'lower';

export function applyQueryTransform(q: string, t?: QueryTransform): string {
    if (t === 'strip-dash') return q.replace(/-/g, '');
    if (t === 'lower') return q.toLowerCase();
    return q;
}

const PLACEHOLDER = /\{q((?:\|[A-Za-z]+)*)\}/g;

/** 取**最长的一段**连续匹配（长度相同取靠后的） */
function longestRun(s: string, re: RegExp): string {
    const runs = s.match(new RegExp(`${re.source}+`, 'g')) || [];
    let best = '';
    for (const r of runs) if (r.length >= best.length) best = r;
    return best;
}

function applyPipe(v: string, fn: string): string {
    switch (fn) {
        case 'noDash': return v.replace(/-/g, '');
        case 'lower': return v.toLowerCase();
        case 'upper': return v.toUpperCase();
        // ⚠️ 必须是**最长的一整段**数字，不能把所有数字拼起来 ——
        // `FC2-PPV-1234567` 拼起来会得到 `21234567`（把 FC2 的 2 也吃进去），拼出的地址是错的。
        case 'num': return longestRun(v, /\d/);
        // 字母同理取拼接（去掉数字与符号）：`FC2-PPV` → `FCPPV`
        case 'alpha': return v.replace(/[^A-Za-z]/g, '');
        default: return v; // 'raw' 在编码那一步决定，这里不动
    }
}

/**
 * 展开模板。
 * `encode=false` 用于**非 URL 场合**（把值填进搜索框）—— 那里不该做 URL 编码，
 * 但占位符语法（含管道）必须与 URL 场合完全一致，否则录出来的 `{q|noDash}` 会被当字面量输进去。
 */
export function expandUrl(template: string, query: string, transform?: QueryTransform, encode = true): string {
    return template.replace(PLACEHOLDER, (_m, suffix: string) => {
        const fns = String(suffix).split('|').filter(Boolean);
        if (!fns.length) {
            const v = applyQueryTransform(query, transform);
            return encode ? encodeURIComponent(v) : v;
        }
        let v = query;
        for (const f of fns) v = applyPipe(v, f);
        return fns.includes('raw') || !encode ? v : encodeURIComponent(v);
    });
}

/**
 * 录制到的输入值里，把**测试番号**换成占位符。
 * 用户是拿某个番号演示的 —— 原样记下来等于规则只对那一个号码有效。
 */
export function replaceQueryInValue(value: string, query: string): string {
    if (!value || !query) return value;
    if (value === query) return '{q}';
    if (value.replace(/-/g, '') === query.replace(/-/g, '')) return '{q|noDash}';
    if (value.toLowerCase() === query.toLowerCase()) return '{q|lower}';
    if (value.replace(/-/g, '').toLowerCase() === query.replace(/-/g, '').toLowerCase()) return '{q|noDash|lower}';
    return value;
}

export interface DerivedTemplate {
    ok: boolean;
    /** 反推出来的模板（`ok:false` 时是原样地址） */
    template: string;
    /** 命中的写法，如 '{q|noDash}'；`ok:false` 时为空 */
    hit: string;
}

/** 变体按「离原样最近」排序：先试原样，再试大小写，最后才试去横杠与纯数字 */
function variantsOf(query: string): { text: string; ph: string }[] {
    const raw = query;
    const noDash = raw.replace(/-/g, '');
    const num = longestRun(raw, /\d/);
    const all = [
        { text: raw, ph: '{q}' },
        { text: raw.toLowerCase(), ph: '{q|lower}' },
        { text: raw.toUpperCase(), ph: '{q|upper}' },
        { text: noDash, ph: '{q|noDash}' },
        { text: noDash.toLowerCase(), ph: '{q|noDash|lower}' },
        { text: noDash.toUpperCase(), ph: '{q|noDash|upper}' },
        { text: num, ph: '{q|num}' },
    ];
    const seen = new Set<string>();
    return all.filter((v) => {
        if (!v.text || seen.has(v.text)) return false;
        seen.add(v.text);
        return true;
    });
}

function safeDecode(s: string): string {
    try {
        return decodeURIComponent(s);
    } catch {
        return s;
    }
}

/**
 * 从一个**真实页面地址**反推模板：把查询词出现的位置换成占位符。
 *
 * ⚠️ 只在 **path + search** 里找，**不碰 origin** —— 否则很短的查询词（纯数字）会先在
 *    域名/端口上命中，反推出一个荒唐的模板。
 * 只替换**第一处**命中（多段重复的情况留给人判断，不猜）。
 */
export function deriveTemplate(href: string, query: string): DerivedTemplate {
    if (!href || !query) return { ok: false, template: href, hit: '' };
    const target = safeDecode(href);

    let zone = target;
    let prefix = '';
    let suffix = '';
    try {
        const u = new URL(target);
        prefix = u.origin;
        zone = u.pathname + u.search;
        suffix = u.hash;
    } catch {
        /* 不是标准 URL：退化成全文查找 */
    }

    for (const v of variantsOf(query)) {
        const at = zone.indexOf(v.text);
        if (at < 0) continue;
        return {
            ok: true,
            template: prefix + zone.slice(0, at) + v.ph + zone.slice(at + v.text.length) + suffix,
            hit: v.ph,
        };
    }
    return { ok: false, template: target, hit: '' };
}
