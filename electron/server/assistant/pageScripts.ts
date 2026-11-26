/**
 * 页面内注入脚本（拾取图片 / 录制动作）
 * ===========================================================================
 * 通信机制：**页面把结果写进 `sessionStorage`，主进程轮询读**。
 * 为什么不用 `executeJavaScript` 的 Promise 回传：用户点一下可能触发整页跳转，
 * 脚本上下文一销毁 Promise 就永不 resolve（或 reject）—— 而 sessionStorage 同源跨页保留 ⇒ 不怕导航。
 *
 * ⚠️ 内联 `selectorCandidates` 用的是它**运行时的函数源码**（`toString()`），
 * 所以那个函数必须自包含（见 selectorGen.ts 顶部说明）。
 */
import { selectorCandidates } from './selectorGen';

export const REC_KEY = '__ff_rec';
export const PICK_KEY = '__ff_pick';
export const DONE_KEY = '__ff_done';

/** 拾取/录制共用的页面内 helper：元素描述 + 唯一性校验后的最佳选择器 */
function helperSource(): string {
    return `
var SELGEN = (${selectorCandidates.toString()});
function esc(v){ return String(v).replace(/[^\\w-]/g, function(c){ return '\\\\' + c; }); }
function desc(el){
  var d = { tag: el.tagName.toLowerCase(), id: el.id || '', cls: [], attrs: {}, idx: 0, total: 0 };
  var i, cl = el.classList || [];
  for (i = 0; i < cl.length && i < 6; i++) d.cls.push(cl[i]);
  var KEYS = ['data-src','data-original','data-poster','property','itemprop','name','type','role','placeholder','aria-label'];
  for (i = 0; i < KEYS.length; i++) { if (el.hasAttribute(KEYS[i])) d.attrs[KEYS[i]] = el.getAttribute(KEYS[i]); }
  var p = el.parentElement;
  if (p) {
    var same = [], kids = p.children;
    for (i = 0; i < kids.length; i++) { if (kids[i].tagName === el.tagName) same.push(kids[i]); }
    d.total = same.length; d.idx = same.indexOf(el);
  }
  return d;
}
function best(el){
  var list = SELGEN(desc(el)), i, j, s;
  for (i = 0; i < list.length; i++) { try { if (document.querySelectorAll(list[i]).length === 1) return list[i]; } catch (e) {} }
  var p = el.parentElement;
  if (p) {
    var plist = SELGEN(desc(p));
    for (i = 0; i < plist.length; i++) {
      for (j = 0; j < list.length && j < 2; j++) {
        s = plist[i] + ' > ' + list[j];
        try { if (document.querySelectorAll(s).length === 1) return s; } catch (e) {}
      }
    }
  }
  return list.length ? list[list.length - 1] : '';
}
function xpathFor(el){
  if (!el || el.nodeType !== 1) return '';
  if (el.id && !/^[a-z0-9]{8,}$/i.test(el.id)) return '//*[@id="' + el.id.replace(/"/g, '') + '"]';
  var parts = [];
  var cur = el;
  while (cur && cur.nodeType === 1 && cur !== document.body && parts.length < 6) {
    var tag = cur.tagName.toLowerCase();
    var p = cur.parentElement;
    if (!p) { parts.unshift(tag); break; }
    var same = [], kids = p.children;
    for (var i = 0; i < kids.length; i++) { if (kids[i].tagName === cur.tagName) same.push(kids[i]); }
    var seg = same.length > 1 ? tag + '[' + (same.indexOf(cur) + 1) + ']' : tag;
    parts.unshift(seg);
    if (p.id && !/^[a-z0-9]{8,}$/i.test(p.id)) {
      parts.unshift('//*[@id="' + p.id.replace(/"/g, '') + '"]');
      return parts.join('/');
    }
    cur = p;
  }
  return '//' + parts.join('/');
}
function put(key, val){
  try { sessionStorage.setItem(key, JSON.stringify(val)); sessionStorage.setItem('${DONE_KEY}', '1'); } catch (e) {}
}
`;
}

/** 清掉上一次的残留（同源 sessionStorage 会跨次保留） */
export function buildClearScript(): string {
    return `(function(){try{sessionStorage.removeItem(${JSON.stringify(REC_KEY)});`
        + `sessionStorage.removeItem(${JSON.stringify(PICK_KEY)});`
        + `sessionStorage.removeItem(${JSON.stringify(DONE_KEY)});}catch(e){}return 1;})()`;
}

/** 主进程轮询读结果 */
export function buildReadScript(key: string): string {
    return `(function(){try{return {done: sessionStorage.getItem(${JSON.stringify(DONE_KEY)}) === '1',`
        + ` value: (function(){var v = sessionStorage.getItem(${JSON.stringify(key)}); return v ? JSON.parse(v) : null;})()};}`
        + `catch(e){return {done: false, value: null};}})()`;
}

/**
 * 拾取页面元素：
 * - mode === 'cover': 用 elementsFromPoint 穿透遮罩层，识别 img / picture / video[poster] / background-image；
 *   自动探测实际有效的属性（如 src|data-src|data-original 或 bg / poster），并同时生成 CSS 与 XPath。
 * - mode === 'text' / 'link': 拾取文本或链接（支持标题、演员名、演员链接）。
 * - 支持滚轮 / ↑↓ 微调选中层级。
 */
export function buildPickerScript(mode: 'cover' | 'text' | 'link' = 'cover'): string {
    return `(function(){
  if (window.__ffPicker) return 1;
  window.__ffPicker = 1;
  var MODE = ${JSON.stringify(mode)};
${helperSource()}
  var hot = null;
  var tip = document.createElement('div');
  tip.setAttribute('style', 'position:fixed;left:50%;top:12px;transform:translateX(-50%);z-index:2147483647;pointer-events:none;background:#111;color:#fff;font:12px/1.6 system-ui,sans-serif;padding:6px 12px;border-radius:8px;max-width:85vw;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;box-shadow:0 4px 14px rgba(0,0,0,.4)');
  var baseTip = MODE === 'cover'
    ? '点选封面图（支持背景图/穿透遮罩，↑↓微调层级，Esc 取消）'
    : MODE === 'link' ? '点选链接元素（Esc 取消）' : '点选文本元素（Esc 取消）';
  tip.textContent = baseTip;
  document.body.appendChild(tip);

  function bgUrl(el){
    try {
      var bg = (el.style && el.style.backgroundImage) || getComputedStyle(el).backgroundImage || '';
      var m = /url\\(\\s*["']?([^"')]+)["']?\\s*\\)/i.exec(bg);
      return m ? m[1].trim() : '';
    } catch(e){ return ''; }
  }
  function imgAttrOf(el){
    if (!el) return { attr: 'src|data-src', src: '' };
    var tag = el.tagName.toLowerCase();
    if (tag === 'video') return { attr: 'poster', src: el.getAttribute('poster') || '' };
    if (tag !== 'img') {
      var bg = bgUrl(el);
      if (bg) return { attr: 'bg', src: bg };
    }
    var ds = el.getAttribute('data-src') || el.getAttribute('data-original') || '';
    var s = el.getAttribute('src') || '';
    return {
      attr: ds ? 'src|data-src|data-original' : 'src|data-src',
      src: s || ds || ''
    };
  }
  function draw(el){
    if (hot && hot.style) { try { hot.style.outline = hot.__ffOld || ''; } catch (e) {} }
    hot = el;
    if (el && el.style) {
      try { el.__ffOld = el.style.outline; el.style.outline = '2px solid #e24b4a'; } catch (e) {}
      var sel = best(el);
      var cnt = 0;
      try { cnt = sel ? document.querySelectorAll(sel).length : 0; } catch(e){}
      tip.textContent = baseTip + (sel ? ' ｜ ' + sel + ' (匹配 ' + cnt + ')' : '');
    } else {
      tip.textContent = baseTip;
    }
  }
  function pick(ev){
    var stack = document.elementsFromPoint ? document.elementsFromPoint(ev.clientX, ev.clientY) : [ev.target];
    if (MODE === 'cover') {
      for (var i = 0; i < stack.length; i++) {
        var el = stack[i];
        if (!el || el.nodeType !== 1 || el === tip || tip.contains(el)) continue;
        if (el.tagName === 'IMG') return el;
        if (el.tagName === 'PICTURE') { var im = el.querySelector('img'); if (im) return im; }
        if (el.tagName === 'VIDEO' && el.getAttribute('poster')) return el;
        if (bgUrl(el)) return el;
      }
      var t = ev.target;
      if (t && t.closest) { var c = t.closest('img'); if (c) return c; }
      return null;
    }
    if (MODE === 'link') {
      for (var j = 0; j < stack.length; j++) {
        var e2 = stack[j];
        if (!e2 || e2.nodeType !== 1 || e2 === tip || tip.contains(e2)) continue;
        var a = e2.tagName === 'A' ? e2 : (e2.closest ? e2.closest('a') : null);
        if (a) return a;
      }
    }
    var raw = ev.target;
    if (!raw || raw.nodeType !== 1 || raw === tip || tip.contains(raw)) return null;
    return raw;
  }
  document.addEventListener('mouseover', function(ev){ draw(pick(ev)); }, true);
  document.addEventListener('click', function(ev){
    var el = hot || pick(ev);
    if (!el) return;
    ev.preventDefault(); ev.stopPropagation();
    var sel = best(el);
    var xp = xpathFor(el);
    var info = MODE === 'cover' ? imgAttrOf(el) : { attr: MODE === 'link' ? 'href' : 'text', src: '' };
    put('${PICK_KEY}', {
      selector: sel,
      xpath: xp,
      attr: info.attr,
      weak: /:nth-of-type\\(/.test(sel),
      src: info.src
    });
  }, true);
  document.addEventListener('keydown', function(ev){
    if (ev.key === 'Escape') { ev.preventDefault(); put('${PICK_KEY}', { cancel: true }); return; }
    if (hot && ev.key === 'ArrowUp' && hot.parentElement && hot.parentElement !== document.body) {
      ev.preventDefault(); draw(hot.parentElement);
    } else if (hot && ev.key === 'ArrowDown' && hot.firstElementChild) {
      ev.preventDefault(); draw(hot.firstElementChild);
    }
  }, true);
  return 1;
})()`;
}

/**
 * 录制动作：用户自己搜一次，我们把他做的「输入 / 点击 / 按 Enter」记下来。
 */
export function buildRecorderScript(): string {
    return `(function(){
${helperSource()}
  var steps = [];
  try { steps = JSON.parse(sessionStorage.getItem('${REC_KEY}') || '[]'); } catch (e) { steps = []; }
  function updateLabel(){
    if (window.__ffRecTxt) window.__ffRecTxt.textContent = '正在录制（已录 ' + steps.length + ' 步）：搜索一次后点结束';
  }
  function save(){ try { sessionStorage.setItem('${REC_KEY}', JSON.stringify(steps)); } catch (e) {} updateLabel(); }
  if (window.__ffRec) { save(); return 1; }
  window.__ffRec = 1;

  var bar = document.createElement('div');
  bar.setAttribute('style', 'position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:2147483647;pointer-events:none;display:flex;align-items:center;gap:10px;background:#111;color:#fff;font:13px/1.5 system-ui,sans-serif;padding:8px 14px;border-radius:999px;box-shadow:0 4px 16px rgba(0,0,0,.5)');
  var txt = document.createElement('span');
  window.__ffRecTxt = txt;
  var btn = document.createElement('button');
  btn.textContent = '结束录制';
  btn.setAttribute('style', 'pointer-events:auto;cursor:pointer;background:#e24b4a;color:#fff;border:0;border-radius:999px;padding:4px 12px;font:13px/1.5 system-ui,sans-serif');
  bar.appendChild(txt); bar.appendChild(btn);
  btn.addEventListener('click', function(){
    try { sessionStorage.setItem('${DONE_KEY}', '1'); } catch (e) {}
    bar.style.display = 'none';
  }, true);
  document.body.appendChild(bar);
  updateLabel();

  document.addEventListener('input', function(ev){
    var el = ev.target;
    if (!el || !el.tagName) return;
    var t = el.tagName.toLowerCase();
    if (t !== 'input' && t !== 'textarea') return;
    var s = best(el);
    if (!s) return;
    var last = steps[steps.length - 1];
    if (last && last.act === 'type' && last.selector === s) last.value = el.value;
    else steps.push({ act: 'type', selector: s, value: el.value });
    save();
  }, true);

  document.addEventListener('keydown', function(ev){
    if (ev.key !== 'Enter') return;
    var el = ev.target;
    if (!el || !el.tagName) return;
    var t = el.tagName.toLowerCase();
    if (t !== 'input' && t !== 'textarea') return;
    var s = best(el);
    if (!s) return;
    steps.push({ act: 'press', selector: s, key: 'Enter' });
    save();
  }, true);

  document.addEventListener('click', function(ev){
    var el = ev.target;
    if (!el || el.nodeType !== 1 || bar.contains(el)) return;
    var s = best(el);
    if (!s || s === 'body' || s === 'html') return;
    steps.push({ act: 'click', selector: s });
    save();
  }, true);

  save();
  return 1;
})()`;
}
