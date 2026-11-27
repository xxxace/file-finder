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

export type CandidateKind = 'css' | 'meta' | 'xpath' | 'regex' | 'script';

/** 单个字段的一次抽取尝试：按顺序依次试，命中即用 */
export interface FieldCandidate {
    kind: CandidateKind;
    /** css: 选择器；meta: meta 的 name/property；xpath: XPath 表达式；regex: 正则；script: JS 函数体/表达式 */
    selector: string;
    /** css/xpath: 取哪个属性（默认 src；'text' 取文本；'bg' 取背景图 url） */
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
 * 动作序列的一步（P3.1 + 扩展）。
 * ⚠️ **有副作用：每步只允许执行一次** —— 与幂等、可反复重试的抽取脚本不同，
 * 绝不能塞进 `runExtract` 的轮询循环。
 */
export type ActionStep =
    | { act: 'type'; selector: string; value: string }   // value 支持 {q}
    | { act: 'click'; selector: string }
    | { act: 'press'; selector?: string; key: string }   // 按键（如 Enter）
    | { act: 'goto'; url: string }                       // 跳转 URL（支持 {q}）
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
    /** 最近一次试跑是否已通过（仅作 UI 状态展示，不阻塞草稿保存） */
    verified?: boolean;
    verifiedAt?: string;
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
      function extractBg(el){
        try {
          var bg = (el.style && el.style.backgroundImage) || getComputedStyle(el).backgroundImage || '';
          var m = /url\\(\\s*["']?([^"')]+)["']?\\s*\\)/i.exec(bg);
          return m ? m[1].trim() : '';
        } catch(e){ return ''; }
      }
      function looksUrl(v){
        if(!v) return false;
        if(/^data:/i.test(v)) return true;
        return !/[\\s{};()'"]/.test(v);
      }
      function abs(v){
        if(!v) return '';
        if(/^(https?:|data:|blob:)/i.test(v)) return v;
        if(v.indexOf('//')===0) return 'https:' + v;
        try { return new URL(v, document.baseURI).href; } catch(e) { return v; }
      }
      function validVal(v, opts){
        if(!v) return '';
        var isCover = !!(opts && opts.cover), isUrl = !!(opts && opts.url);
        if(isUrl && !looksUrl(v)) return '';
        if(isUrl) v = abs(v);
        if(isCover && BAD.test(v)) return '';
        return v;
      }
      function readElAttr(el, attrSpec, opts){
        if(!el) return '';
        var A = attrSpec || 'src';
        if(A === 'text') return validVal((el.textContent||'').trim(), opts);
        if(A === 'html') return validVal((el.innerHTML||'').trim(), opts);
        if(A === 'bg') return validVal(extractBg(el), opts);
        var keys = A.split('|');
        for(var i=0;i<keys.length;i++){
          var k = keys[i].replace(/^\\s+|\\s+$/g,'');
          var v = '';
          if(k === 'bg') v = extractBg(el);
          else if(k === 'style') {
            var st = el.getAttribute('style') || '';
            var sm = /url\\(\\s*["']?([^"')]+)["']?\\s*\\)/i.exec(st);
            v = sm ? sm[1].trim() : st;
          } else {
            v = el.getAttribute(k) || '';
            if(k === 'srcset' && v) v = v.split(',')[0].replace(/\\s+/g,' ').trim().split(' ')[0];
          }
          var ok = validVal(v, opts);
          if(ok) return ok;
        }
        return '';
      }
      function docsList(){
        var list = [document];
        try {
          var frames = document.querySelectorAll('iframe');
          for(var i=0;i<frames.length && i<5;i++){
            try { if(frames[i].contentDocument) list.push(frames[i].contentDocument); } catch(e){}
          }
        } catch(e){}
        return list;
      }
      function tryCss(c, opts){
        var docs = docsList();
        for(var d=0; d<docs.length; d++){
          var els = docs[d].querySelectorAll(c.selector);
          for(var i=0; i<els.length && i<20; i++){
            var v = readElAttr(els[i], c.attr, opts);
            if(v) return v;
          }
        }
        return '';
      }
      function tryXpath(c, opts){
        var docs = docsList();
        for(var d=0; d<docs.length; d++){
          try {
            var snap = docs[d].evaluate(c.selector, docs[d], null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
            for(var i=0; i<snap.snapshotLength && i<20; i++){
              var n = snap.snapshotItem(i);
              if(!n) continue;
              var v = '';
              if(n.nodeType === 1) v = readElAttr(n, c.attr, opts);
              else v = validVal((n.textContent || n.nodeValue || '').trim(), opts);
              if(v) return v;
            }
          } catch(e){}
        }
        return '';
      }
      function tryMeta(c, opts){
        var el = document.querySelector('meta[name="'+c.selector+'"],meta[property="'+c.selector+'"]');
        return validVal(el ? (el.getAttribute('content')||'').trim() : '', opts);
      }
      function tryRegex(c, opts){
        var m = new RegExp(c.selector, 'i').exec(document.documentElement.outerHTML);
        if(!m) return '';
        return validVal((m[c.group||1]||'').trim(), opts);
      }
      function tryScript(c, opts){
        var code = String(c.selector || '').trim();
        if(!code) return '';
        var fn;
        try {
          fn = /\breturn\b/.test(code) ? new Function('doc', 'win', code) : new Function('doc', 'win', 'return (' + code + ')');
        } catch(e){
          try { fn = new Function('doc', 'win', code); } catch(e2){ return ''; }
        }
        var r = fn(document, window);
        return validVal(r == null ? '' : String(r).trim(), opts);
      }
      function runField(fr, opts){
        if(!fr || !fr.candidates) return '';
        for(var i=0;i<fr.candidates.length;i++){
          var c = fr.candidates[i], v = '';
          try {
            v = c.kind==='css' ? tryCss(c, opts)
              : c.kind==='meta' ? tryMeta(c, opts)
              : c.kind==='xpath' ? tryXpath(c, opts)
              : c.kind==='regex' ? tryRegex(c, opts)
              : c.kind==='script' ? tryScript(c, opts) : '';
          } catch(e){ v=''; }
          if(v) return v;
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
      for(var k=0;k<document.images.length && out.sampleSrcs.length<8;k++){
        var s = rawSrc(document.images[k]);
        if(s) out.sampleSrcs.push(s.slice(0,200));
      }
      return out;
    })()`;
}

export function buildStepScript(step: ActionStep, query = '', transform?: QueryTransform): string {
    if (step.act === 'type') {
        const sel = JSON.stringify(step.selector);
        const val = JSON.stringify(expandUrl(step.value || '', query, transform, false));
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
          try { el.scrollIntoView({ block:'center', inline:'center' }); } catch(e){}
          try { el.click(); } catch(e){}
          return { ok:true };
        })()`;
    }
    if (step.act === 'press') {
        const sel = step.selector ? JSON.stringify(step.selector) : 'null';
        const key = JSON.stringify(step.key || 'Enter');
        return `(function(){
          var el = ${sel} ? document.querySelector(${sel}) : document.activeElement;
          if(!el) return { ok:false, why:'not-found' };
          try { el.focus(); } catch(e){}
          var k = ${key};
          var init = { key: k, code: k === 'Enter' ? 'Enter' : k, keyCode: k === 'Enter' ? 13 : 0, which: k === 'Enter' ? 13 : 0, bubbles: true, cancelable: true };
          var notCancelled = el.dispatchEvent(new KeyboardEvent('keydown', init));
          el.dispatchEvent(new KeyboardEvent('keypress', init));
          el.dispatchEvent(new KeyboardEvent('keyup', init));
          if(k === 'Enter' && notCancelled && el.form) {
            try {
              if(typeof el.form.requestSubmit === 'function') el.form.requestSubmit();
              else el.form.submit();
            } catch(e){}
          }
          return { ok:true };
        })()`;
    }
    if (step.act === 'goto') {
        return JSON.stringify(expandUrl(step.url || '', query, transform));
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

export async function reorderRules(dataDir: string, ids: string[]): Promise<SiteRule[]> {
    const rules = await loadRules(dataDir);
    const byId = new Map(rules.map(r => [r.id, r]));
    const next: SiteRule[] = [];
    for (const id of ids) {
        const r = byId.get(id);
        if (r) { next.push(r); byId.delete(id); }
    }
    for (const r of byId.values()) next.push(r);
    FILE_STORE.set(dataDir, next);
    await queueWrite(rulesPath(dataDir), () => atomicWrite(rulesPath(dataDir), JSON.stringify(next, null, 2)));
    return next;
}

/**
 * 并入外部导入的站点规则（只增不删：本地已有同 id 规则保持不动，缺失的追加）。
 */
export async function mergeRules(dataDir: string, incoming: unknown[]): Promise<number> {
    if (!Array.isArray(incoming) || incoming.length === 0) return 0;

    const rules = await loadRules(dataDir);
    const existingIds = new Set(rules.map(r => r.id));
    let added = 0;

    for (const item of incoming) {
        if (!item || typeof item !== 'object') continue;
        const rule = item as Partial<SiteRule>;
        if (
            typeof rule.id !== 'string' || !rule.id.trim()
            || typeof rule.name !== 'string'
            || typeof rule.detailUrl !== 'string'
            || !rule.fields || typeof rule.fields !== 'object'
        ) {
            continue;
        }
        if (existingIds.has(rule.id)) continue;
        existingIds.add(rule.id);
        rules.push(rule as SiteRule);
        added += 1;
    }

    if (added > 0) {
        FILE_STORE.set(dataDir, rules);
        await queueWrite(rulesPath(dataDir), () => atomicWrite(rulesPath(dataDir), JSON.stringify(rules, null, 2)));
    }
    return added;
}
