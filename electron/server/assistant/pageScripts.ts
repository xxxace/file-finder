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
  var KEYS = ['data-src','data-original','data-poster','property','itemprop','name','type','role'];
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
 * 拾取一张图：hover 高亮 → 点一下 → 把选择器写进 sessionStorage。
 * 点到不是 `img` 的地方会自动落到**最近的 img**（点包裹它的链接也算）。
 */
export function buildPickerScript(): string {
    return `(function(){
  if (window.__ffPicker) return 1;
  window.__ffPicker = 1;
${helperSource()}
  var hot = null;
  var tip = document.createElement('div');
  tip.setAttribute('style', 'position:fixed;left:50%;top:12px;transform:translateX(-50%);z-index:2147483647;pointer-events:none;background:#111;color:#fff;font:12px/1.6 system-ui,sans-serif;padding:5px 10px;border-radius:6px;max-width:80vw;white-space:nowrap;overflow:hidden;text-overflow:ellipsis');
  tip.textContent = '点一下你要抓的那张图（按 Esc 取消）';
  document.body.appendChild(tip);

  function draw(el){
    if (hot && hot.style) { try { hot.style.outline = hot.__ffOld || ''; } catch (e) {} }
    hot = el;
    if (el && el.style) { try { el.__ffOld = el.style.outline; el.style.outline = '2px solid #e24b4a'; } catch (e) {} }
  }
  function pick(ev){
    var el = ev.target;
    if (!el || el.nodeType !== 1 || el === tip || tip.contains(el)) return null;
    if (el.tagName === 'IMG') return el;
    return el.closest ? el.closest('img') : null;
  }
  document.addEventListener('mouseover', function(ev){ draw(pick(ev)); }, true);
  document.addEventListener('click', function(ev){
    var el = pick(ev);
    if (!el) return;
    ev.preventDefault(); ev.stopPropagation();
    var sel = best(el);
    put('${PICK_KEY}', { selector: sel, weak: /:nth-of-type\\(/.test(sel), src: el.getAttribute('src') || el.getAttribute('data-src') || '' });
  }, true);
  document.addEventListener('keydown', function(ev){
    if (ev.key === 'Escape') { ev.preventDefault(); put('${PICK_KEY}', { cancel: true }); }
  }, true);
  return 1;
})()`;
}

/**
 * 录制动作：用户自己搜一次，我们把他做的「输入 / 点击」记下来。
 * 输入的值先原样记，**主进程再把其中的测试番号换成 `{q}`**。
 * 每条即时写 sessionStorage ⇒ 中途发生页面跳转也不会丢。
 */
export function buildRecorderScript(): string {
    return `(function(){
${helperSource()}
  var steps = [];
  try { steps = JSON.parse(sessionStorage.getItem('${REC_KEY}') || '[]'); } catch (e) { steps = []; }
  function save(){ try { sessionStorage.setItem('${REC_KEY}', JSON.stringify(steps)); } catch (e) {} }
  if (window.__ffRec) { save(); return 1; }
  window.__ffRec = 1;

  var bar = document.createElement('div');
  bar.setAttribute('style', 'position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:2147483647;pointer-events:none;display:flex;align-items:center;gap:10px;background:#111;color:#fff;font:13px/1.5 system-ui,sans-serif;padding:8px 14px;border-radius:999px;box-shadow:0 4px 16px rgba(0,0,0,.5)');
  var txt = document.createElement('span');
  txt.textContent = '正在录制：像平时那样搜索一次（号码处会记成 {q}）';
  var btn = document.createElement('button');
  btn.textContent = '结束录制';
  btn.setAttribute('style', 'pointer-events:auto;cursor:pointer;background:#e24b4a;color:#fff;border:0;border-radius:999px;padding:4px 12px;font:13px/1.5 system-ui,sans-serif');
  bar.appendChild(txt); bar.appendChild(btn);
  btn.addEventListener('click', function(){
    try { sessionStorage.setItem('${DONE_KEY}', '1'); } catch (e) {}
    bar.style.display = 'none';
  }, true);
  document.body.appendChild(bar);

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
