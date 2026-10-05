/**
 * 管理助手 · 站点规则模型 + 存储 + 页面内抽取脚本生成
 * ===========================================================================
 * 设计要点（对应 PRD §5 D3/D4、§7）：
 *   - 站点提取逻辑 = 「数据」不是「代码」：每站一条 JSON 规则，字段用**有序候选链**，
 *     运行时依次试、命中即用（把旧 avatar-finder 里 data-src→data-poster→preview 的
 *     手写 fallback 泛化成通用机制）。
 *   - 抽取在**页面内**用 document.querySelector 执行（见 buildExtractScript），
 *     所以不需要 cheerio、也不涉及跨栈 cookie（PRD D1/D4）。
 *   - 存储是明文 JSON（`~/.file-finder/assistant/rules.json`），不走 nedb 加密库：
 *     规则量小、要能手改/导入导出；并发写用串行队列 + tmp→rename 原子写兜住。
 */
import * as fsp from 'node:fs/promises';
import * as fs from 'node:fs';
import path from 'node:path';
import { applyQueryTransform, expandUrl, type QueryTransform } from './urlTemplate';

// 查询词的变换方式原本定义在本文件；为了让 `buildStepScript` 复用模板引擎（且不成环），
// 已搬到 `urlTemplate.ts` —— 这里转出去，既有调用方（`index.ts` 等）的 import 路径不用改。
export { applyQueryTransform };
export type { QueryTransform };

export type CandidateKind = 'css' | 'meta' | 'regex';

/** 单个字段的一次抽取尝试：按顺序依次试，命中即用 */
export interface FieldCandidate {
    kind: CandidateKind;
    /** css: 选择器；meta: meta 的 name/property；regex: 正则字符串 */
    selector: string;
    /** css: 取哪个属性（默认 src；'text' 取文本）；regex: 不用 */
    attr?: string;
    /** regex: 取第几个捕获组（默认 1） */
    group?: number;
}

export interface FieldRule {
    candidates: FieldCandidate[];
}

export interface SiteFields {
    cover?: FieldRule;
    title?: FieldRule;
    actress?: FieldRule;
    actressLink?: FieldRule;
}

/**
 * 动作序列的一步（P3.1）。
 * ⚠️ **有副作用：每步只允许执行一次** —— 与幂等、可反复重试的抽取脚本不同，
 * 绝不能塞进 `runExtract` 的轮询循环（click 返回 undefined ⇒ 循环不退出 ⇒ 反复点击）。
 */
export type ActionStep =
    | { act: 'type'; selector: string; value: string }   // value 支持 {q}
    | { act: 'click'; selector: string }
    | { act: 'wait'; selector?: string; ms?: number };

export interface SiteRule {
    id: string;
    name: string;
    enabled: boolean;
    /** 详情页 URL 模板，{q} 为查询词，如 https://www.javbus.com/{q} */
    detailUrl: string;
    /** MVP 统一走隐藏窗口（S1 实测：这是唯一能过 CF 的通道） */
    transport: 'browser';
    needsCookie?: boolean;
    queryTransform?: QueryTransform;
    /** 动作序列（可空）。缺省 = 行为与现在完全一致（纯 URL 型的站零改动） */
    steps?: ActionStep[];
    fields: SiteFields;
}

/** 从页面抽出的原始字段值（试跑面板要显示这些） */
export interface ExtractedFields {
    cover?: string;
    title?: string;
    actress?: string;
    actressLink?: string;
    /** 页面 <img> 数量与样例（排查"页面取到没 / 选择器对不对"用） */
    imgCount: number;
    sampleSrcs: string[];
}

/** 封面黑名单：抽到这些路径的图不算封面（否则会把站点 logo 当命中——S1 的假阳性教训） */
const COVER_BLACKLIST = 'logo|theme|banner|spinner|placeholder|icon|1px|pixel|loading|ajax|sprite';

/**
 * 生成一段**在页面内执行**的抽取脚本，返回 ExtractedFields。
 * 候选链按 kind 分派：css / meta / regex；封面额外过黑名单。
 */
export function buildExtractScript(fields: SiteFields): string {
    return `(function(){
      var FIELDS = ${JSON.stringify(fields)};
      var BAD = new RegExp(${JSON.stringify(COVER_BLACKLIST)}, 'i');
      function rawSrc(el){
        if(!el) return '';
        var s = el.getAttribute('src') || el.getAttribute('data-src') || el.getAttribute('data-original') || el.getAttribute('data-404-fallback') || '';
        if(!s && el.getAttribute('srcset')) s = el.getAttribute('srcset').split(',')[0].trim().split(' ')[0];
        if(s && s.indexOf('//')===0) s = 'https:' + s;
        return s;
      }
      function tryCss(c){
        var el = document.querySelector(c.selector);
        if(!el) return '';
        if((c.attr||'src') === 'text') return (el.textContent||'').trim();
        if((c.attr||'src') === 'html') return (el.innerHTML||'').trim();
        return el.getAttribute(c.attr || 'src') || '';
      }
      function tryMeta(c){
        var el = document.querySelector('meta[name="'+c.selector+'"],meta[property="'+c.selector+'"]');
        return el ? (el.getAttribute('content')||'').trim() : '';
      }
      function tryRegex(c){
        var m = new RegExp(c.selector, 'i').exec(document.documentElement.outerHTML);
        if(!m) return '';
        return (m[c.group||1]||'').trim();
      }
      function abs(v){
        if(!v) return '';
        if(/^(https?:|data:|blob:)/i.test(v)) return v;
        if(v.indexOf('//')===0) return 'https:' + v;
        // 根相对（/pics/…）与路径相对都要按页面地址补全 —— javbus 的封面就是 /pics/cover/*.jpg
        try { return new URL(v, document.baseURI).href; } catch(e) { return v; }
      }
      function runField(fr, opts){
        var isCover = !!(opts && opts.cover), isUrl = !!(opts && opts.url);
        if(!fr || !fr.candidates) return '';
        for(var i=0;i<fr.candidates.length;i++){
          var c = fr.candidates[i], v = '';
          try {
            v = c.kind==='css' ? tryCss(c) : c.kind==='meta' ? tryMeta(c) : c.kind==='regex' ? tryRegex(c) : '';
          } catch(e){ v=''; }
          if(!v) continue;
          if(isUrl) v = abs(v);
          if(isCover && BAD.test(v)) continue;
          return v;
        }
        return '';
      }
      var out = {
        cover: runField(FIELDS.cover, {cover:true, url:true}),
        title: runField(FIELDS.title, null),
        actress: runField(FIELDS.actress, null),
        actressLink: runField(FIELDS.actressLink, {url:true}),
        imgCount: document.images.length,
        sampleSrcs: []
      };
      for(var k=0;k<document.images.length && out.sampleSrcs.length<5;k++){
        var s = rawSrc(document.images[k]);
        if(s) out.sampleSrcs.push(s.slice(0,140));
      }
      return out;
    })()`;
}

/**
 * 生成**单步**动作脚本（页面内执行，返回 Promise/对象）。
 *
 * 为什么是单步而不是整串：点击常触发整页导航 ⇒ 脚本上下文被销毁 ⇒ 整串脚本的
 * Promise 永不 resolve。所以调用方（`runSteps`）**每步单独 executeJavaScript 一次**，
 * 并把"导航打断"当作该步已成功。
 *
 * `type` 用 prototype 上的 `value` setter 写值再派发 input/change —— 受控输入
 * （React/Vue）只有这样才会更新内部状态；直接赋 `el.value` 会被框架覆盖。
 */
export function buildStepScript(step: ActionStep, query = ''): string {
    if (step.act === 'type') {
        const sel = JSON.stringify(step.selector);
        // ⚠️ 与 URL 用**同一个**引擎（`encode=false`：填进输入框的不该做 URL 编码）——
        // 录出来的 `{q|noDash}` 这类写法在这里也必须被认出来，否则会被当字面量填进搜索框，
        // 动作永远搜不到东西（"试跑通了、抓取反而错"的另一半）。
        const val = JSON.stringify(expandUrl(step.value || '', query, undefined, false));
        return `(function(){
          var el = document.querySelector(${sel});
          if(!el) return { ok:false, why:'not-found' };
          try { el.focus(); } catch(e){}
          try {
            var d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
            if (d && d.set) d.set.call(el, ${val}); else el.value = ${val};
          } catch(e){ el.value = ${val}; }
          try {
            el.dispatchEvent(new Event('input', { bubbles:true }));
            el.dispatchEvent(new Event('change', { bubbles:true }));
          } catch(e){}
          return { ok:true };
        })()`;
    }
    if (step.act === 'click') {
        const sel = JSON.stringify(step.selector);
        return `(function(){
          var el = document.querySelector(${sel});
          if(!el) return { ok:false, why:'not-found' };
          try { el.click(); } catch(e){}
          return { ok:true };
        })()`;
    }
    const sel = step.selector ? JSON.stringify(step.selector) : 'null';
    const ms = Number(step.ms) > 0 ? Number(step.ms) : 8000;
    return `(async function(){
      var SEL = ${sel}, MS = ${ms};
      if(!SEL){ await new Promise(function(r){ setTimeout(r, MS); }); return { ok:true }; }
      var t0 = Date.now();
      while (Date.now() - t0 < MS) {
        if (document.querySelector(SEL)) return { ok:true };
        await new Promise(function(r){ setTimeout(r, 200); });
      }
      return { ok:false, why:'timeout' };
    })()`;
}

/**
 * 预置站点规则。
 * - javbus：S1 实测**真命中**（封面 /pics/cover/*.jpg），默认启用。
 * - 其余来自旧 avatar-finder 的 parserMap（真实用过的选择器），但 S1 暴露：
 *   freejavbt/javdock 当前选择器抽到 logo、javwine/javtext 查询方式不对、onejav CF 待破。
 *   故一律 `enabled:false`，等 Phase 1-3 用「规则试跑闸门」按站校准后再开。
 */
export const PRESET_RULES: SiteRule[] = [
    {
        id: 'javbus', name: 'javbus', enabled: true, transport: 'browser',
        detailUrl: 'https://www.javbus.com/{q}',
        fields: {
            cover: { candidates: [
                { kind: 'css', selector: '.movie .photo-frame img', attr: 'src' },
                { kind: 'css', selector: '.screencap .bigImage img', attr: 'src' },
                { kind: 'css', selector: '.movie img', attr: 'src' },
                { kind: 'meta', selector: 'og:image' },
            ] },
            title: { candidates: [
                { kind: 'css', selector: '.movie .photo-info h3', attr: 'text' },
                { kind: 'css', selector: 'h3', attr: 'text' },
            ] },
            actress: { candidates: [
                { kind: 'css', selector: '.star-name a', attr: 'text' },
            ] },
            actressLink: { candidates: [
                { kind: 'css', selector: '.star-name a', attr: 'href' },
            ] },
        },
    },
    {
        id: 'freejavbt', name: 'freejavbt', enabled: false, transport: 'browser',
        detailUrl: 'https://freejavbt.com/{q}',
        fields: { cover: { candidates: [
            { kind: 'css', selector: '.video-cover', attr: 'data-src' },
            { kind: 'css', selector: '#player0', attr: 'data-poster' },
            { kind: 'meta', selector: 'og:image' },
        ] } },
    },
    {
        id: 'javwine', name: 'javwine', enabled: false, transport: 'browser',
        detailUrl: 'https://jav.wine/{q}',
        fields: { cover: { candidates: [
            { kind: 'regex', selector: 'url\\(\\s*["\']?([^"\')]+)["\']?\\s*\\)', group: 1 },
            { kind: 'meta', selector: 'og:image' },
        ] } },
    },
    {
        id: 'javdock', name: 'javdock', enabled: false, transport: 'browser',
        detailUrl: 'https://www3.javdock.com/zh/video/{q}',
        fields: { cover: { candidates: [
            { kind: 'css', selector: '.data-no-lazy.lazyloaded', attr: 'data-404-fallback' },
            { kind: 'meta', selector: 'og:image' },
        ] } },
    },
    {
        id: 'onejav', name: 'onejav', enabled: false, transport: 'browser',
        detailUrl: 'https://onejav.com/torrent/{q}',
        queryTransform: 'strip-dash',
        fields: { cover: { candidates: [
            { kind: 'css', selector: '.column .image', attr: 'src' },
            { kind: 'meta', selector: 'og:image' },
        ] } },
    },
];

// ---------------------------------------------------------------------------
// 存储：内存态 + 串行写队列 + 原子写
// ---------------------------------------------------------------------------

const FILE_STORE = new Map<string, SiteRule[]>();
const WRITE_CHAINS = new Map<string, Promise<unknown>>();

function rulesPath(dataDir: string): string {
    return path.join(dataDir, 'assistant', 'rules.json');
}

function queueWrite(file: string, task: () => Promise<void>): Promise<void> {
    const prev = WRITE_CHAINS.get(file) ?? Promise.resolve();
    const next = prev.then(task, task);
    WRITE_CHAINS.set(file, next.catch(() => undefined));
    return next;
}

async function atomicWrite(file: string, text: string): Promise<void> {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    await fsp.writeFile(tmp, text, 'utf8');
    await fsp.rename(tmp, file);
}

export async function loadRules(dataDir: string): Promise<SiteRule[]> {
    const cached = FILE_STORE.get(dataDir);
    if (cached) return cached;

    const file = rulesPath(dataDir);
    let rules: SiteRule[] = [];
    let existed = true;
    if (fs.existsSync(file)) {
        try {
            const parsed: unknown = JSON.parse(await fsp.readFile(file, 'utf8'));
            rules = Array.isArray(parsed) ? (parsed as SiteRule[]) : [];
        } catch {
            rules = PRESET_RULES.map(r => ({ ...r }));
        }
    } else {
        existed = false;
        rules = PRESET_RULES.map(r => ({ ...r }));
    }

    FILE_STORE.set(dataDir, rules);
    if (!existed) {
        await queueWrite(file, () => atomicWrite(file, JSON.stringify(rules, null, 2)));
    }
    return rules;
}

export async function saveRule(dataDir: string, rule: SiteRule): Promise<SiteRule[]> {
    const rules = await loadRules(dataDir);
    const i = rules.findIndex(r => r.id === rule.id);
    if (i >= 0) rules[i] = rule; else rules.push(rule);
    FILE_STORE.set(dataDir, rules);
    await queueWrite(rulesPath(dataDir), () => atomicWrite(rulesPath(dataDir), JSON.stringify(rules, null, 2)));
    return rules;
}

export async function deleteRule(dataDir: string, id: string): Promise<SiteRule[]> {
    const rules = (await loadRules(dataDir)).filter(r => r.id !== id);
    FILE_STORE.set(dataDir, rules);
    await queueWrite(rulesPath(dataDir), () => atomicWrite(rulesPath(dataDir), JSON.stringify(rules, null, 2)));
    return rules;
}
