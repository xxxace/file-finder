/**
 * happy-dom → 全局 DOM。必须在 import 'vue' / 'naive-ui' **之前**跑完，
 * 所以它是 entry 的第一个 import（esbuild 按 import 顺序求值）。
 */
const { Window } = require('happy-dom');

const win = new Window({ url: 'http://localhost:3344/' });
const doc = win.document;

const define = (k, v) => {
    try {
        Object.defineProperty(globalThis, k, { value: v, writable: true, configurable: true });
    } catch (e) {
        /* 有些是 getter-only，跳过 */
    }
};

define('window', win);
define('self', win);
define('document', doc);
define('navigator', win.navigator || { userAgent: 'happy-dom' });

// happy-dom 提供了一大批 DOM 构造器，逐个挂到 global 上（vue/naive-ui 会直接引用裸名字）
const names = [
    'HTMLElement', 'HTMLDivElement', 'HTMLSpanElement', 'HTMLButtonElement', 'HTMLInputElement',
    'HTMLCanvasElement', 'HTMLIFrameElement', 'HTMLImageElement', 'HTMLStyleElement', 'HTMLLinkElement',
    'HTMLSelectElement', 'HTMLTextAreaElement', 'HTMLAnchorElement', 'HTMLFormElement',
    'Element', 'Node', 'NodeList', 'NodeFilter', 'Text', 'Comment', 'DocumentFragment',
    'SVGElement', 'SVGSVGElement', 'ShadowRoot', 'Range', 'DOMRect', 'DOMRectReadOnly', 'DOMRectList',
    'Event', 'CustomEvent', 'MouseEvent', 'PointerEvent', 'KeyboardEvent', 'FocusEvent', 'InputEvent',
    'AnimationEvent', 'TransitionEvent', 'UIEvent', 'WheelEvent', 'TouchEvent',
    'MutationObserver', 'ResizeObserver', 'IntersectionObserver', 'PerformanceObserver',
    'CSSStyleSheet', 'CSSStyleDeclaration', 'CSS', 'MediaQueryList', 'DOMParser', 'XMLSerializer',
    'Image', 'Blob', 'File', 'FileReader', 'URL', 'URLSearchParams', 'XPathResult', 'XMLHttpRequest',
    'HTMLCollection', 'DOMTokenList', 'Attr', 'CharacterData', 'ProcessingInstruction',
    'DocumentType', 'TreeWalker', 'AbortController', 'AbortSignal', 'Storage', 'localStorage', 'sessionStorage'
];
for (const n of names) {
    const v = win[n];
    if (v !== undefined) define(n, v);
}

// 这两个必须绑定 this = win
if (win.getComputedStyle) define('getComputedStyle', win.getComputedStyle.bind(win));
if (win.matchMedia) define('matchMedia', win.matchMedia.bind(win));
else define('matchMedia', () => ({ matches: false, addListener() { }, removeListener() { }, addEventListener() { }, removeEventListener() { } }));

// rAF：happy-dom 有，但 vue 可能直接读裸名字
if (!globalThis.requestAnimationFrame) define('requestAnimationFrame', win.requestAnimationFrame ? win.requestAnimationFrame.bind(win) : (cb) => setTimeout(() => cb(Date.now()), 0));
if (!globalThis.cancelAnimationFrame) define('cancelAnimationFrame', win.cancelAnimationFrame ? win.cancelAnimationFrame.bind(win) : clearTimeout);

// 给 entry 用（避免在 ESM 里 require 自己）
define('__happyWin', win);
define('__happyDoc', doc);

module.exports = { win, doc };
