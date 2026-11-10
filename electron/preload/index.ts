function domReady(condition: DocumentReadyState[] = ['complete', 'interactive']) {
  return new Promise(resolve => {
    if (condition.includes(document.readyState)) {
      resolve(true)
    } else {
      document.addEventListener('readystatechange', () => {
        if (condition.includes(document.readyState)) {
          resolve(true)
        }
      })
    }
  })
}

const safeDOM = {
  append(parent: HTMLElement, child: HTMLElement) {
    if (!Array.from(parent.children).find(e => e === child)) {
      return parent.appendChild(child)
    }
  },
  remove(parent: HTMLElement, child: HTMLElement) {
    if (Array.from(parent.children).find(e => e === child)) {
      return parent.removeChild(child)
    }
  },
}

/**
 * 启动覆盖层 —— 「桌面 logo 组装」（调研定案 docs/ANALYSIS-PRELOAD-SCREEN-2026-11-10.md §十一/§十二）。
 * 一线产品共识：纯色底 + 居中 logo + 动效只作用在 logo 本身；无背景装饰、无文字。
 * mark 用的是**桌面图标本体**（build/icon.svg 内联，ico/png 的同一源文件）——
 * ⚠️ icon.svg 改动时这里要同步：内联是为了零资源加载 + 能拆零件做动画。
 *
 * 编排：圆板浮现 → 2×2 方格逐个落格（文件网格的隐喻）→ 白环描边画出 → 蓝手柄补画 → 轻呼吸。
 * 三点用 logo 手柄蓝 #049EFF —— 那套紫（--ff-bar-*）是 galaxy 进度条的专属色板，不挪用。
 * ⚠️ 手柄画在环下层是 logo 自己的裁决（icon.svg 内注释），结构保持原样。
 * 配色判据：背景 = 主题画布（dark #141414 / light #f1f2f3），主题读 localStorage
 * `ff-theme`（useTheme.ts 的键，默认 dark）—— ⚠️ 画布色/主题键共 **5 个落点**，改要一起改：
 * useTheme.ts · tokens.css · 这里 · index.html 内联脚本+内联 style · main/index.ts 的 backgroundColor。
 */
function useLoading() {
  let theme: string | null = null
  try {
    theme = localStorage.getItem('ff-theme')
  } catch {
    // 存储被禁用时按应用默认主题（dark）走
  }
  const dark = theme !== 'light'
  const bg = dark ? '#141414' : '#f1f2f3'
  const blue = '#049EFF' // logo 手柄蓝（build/icon.svg 唯一的品牌点缀色）

  const styleContent = `
.app-loading-wrap {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: ${bg};
  z-index: 9;
  transition: opacity 320ms cubic-bezier(0.19, 1, 0.22, 1);
}
.app-loading-wrap.is-out { opacity: 0; }
.app-loading-inner {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 30px;
  transition: opacity 320ms cubic-bezier(0.19, 1, 0.22, 1), transform 320ms cubic-bezier(0.19, 1, 0.22, 1);
}
.app-loading-wrap.is-out .app-loading-inner { opacity: 0; transform: translateY(-8px); }
.app-loading-mark {
  animation: app-mark-in .5s ease-out .05s both, app-mark-breathe 2.6s ease-in-out 1.5s infinite;
}
.app-loading-mark .lens, .app-loading-mark .handle {
  stroke-dasharray: 100;
  stroke-dashoffset: 100;
}
.app-loading-mark .lens {
  animation: app-draw .8s cubic-bezier(.65, 0, .35, 1) .35s forwards;
}
.app-loading-mark .handle {
  animation: app-draw .3s ease-out 1s forwards;
}
.app-loading-mark .cells rect {
  opacity: 0;
  transform: scale(.7);
  transform-box: fill-box;
  transform-origin: 50% 50%;
  animation: app-pop .35s cubic-bezier(0.19, 1, 0.22, 1) forwards;
}
.app-loading-mark .cells rect:nth-child(1) { animation-delay: .5s; }
.app-loading-mark .cells rect:nth-child(2) { animation-delay: .62s; }
.app-loading-mark .cells rect:nth-child(3) { animation-delay: .74s; }
.app-loading-mark .cells rect:nth-child(4) { animation-delay: .86s; }
.app-loading-dots { display: flex; gap: 10px; animation: app-fade-in .4s ease-out .9s both; }
.app-loading-dots i {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: ${blue};
  opacity: .25;
  animation: app-dot 1.2s ease-in-out infinite;
}
.app-loading-dots i:nth-child(2) { animation-delay: .15s; }
.app-loading-dots i:nth-child(3) { animation-delay: .3s; }
@keyframes app-draw { to { stroke-dashoffset: 0; } }
@keyframes app-pop { to { opacity: 1; transform: scale(1); } }
@keyframes app-mark-in {
  from { opacity: 0; transform: scale(.94); }
  to { opacity: 1; transform: scale(1); }
}
@keyframes app-mark-breathe {
  0%, 100% { transform: scale(1); }
  50% { transform: scale(1.04); }
}
@keyframes app-fade-in { from { opacity: 0; } to { opacity: 1; } }
@keyframes app-dot {
  0%, 100% { opacity: .25; transform: translateY(0); }
  50% { opacity: 1; transform: translateY(-3px); }
}
@media (prefers-reduced-motion: reduce) {
  .app-loading-mark, .app-loading-mark .lens, .app-loading-mark .handle,
  .app-loading-mark .cells rect, .app-loading-dots, .app-loading-dots i { animation: none; }
  .app-loading-mark .lens, .app-loading-mark .handle { stroke-dashoffset: 0; }
  .app-loading-mark .cells rect { opacity: 1; transform: none; }
  .app-loading-dots { opacity: 1; }
  .app-loading-dots i { opacity: 1; }
  .app-loading-wrap, .app-loading-inner { transition: none; }
}
  `
  const oStyle = document.createElement('style')
  const oDiv = document.createElement('div')

  oStyle.id = 'app-loading-style'
  oStyle.innerHTML = styleContent
  oDiv.className = 'app-loading-wrap'
  // 与 build/icon.svg 同源同结构（gradient id 改成 ff-tile 防与页面内 SVG 撞 id）
  oDiv.innerHTML = `
<div class="app-loading-inner">
  <svg class="app-loading-mark" viewBox="0 0 1024 1024" width="76" height="76" fill="none">
    <defs>
      <linearGradient id="ff-tile" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#525866"/>
        <stop offset="0.55" stop-color="#3A3F49"/>
        <stop offset="1" stop-color="#2E323A"/>
      </linearGradient>
    </defs>
    <rect width="1024" height="1024" rx="250" fill="url(#ff-tile)"/>
    <rect x="1.5" y="1.5" width="1021" height="1021" rx="248.5" fill="none"
          stroke="#FFFFFF" stroke-opacity="0.15" stroke-width="3"/>
    <g transform="translate(-100.6 -100.6) scale(1.2)">
      <line class="handle" x1="627" y1="627" x2="762" y2="762" pathLength="100"
            stroke="#049EFF" stroke-width="83" stroke-linecap="round"/>
      <g class="cells" fill="#FFFFFF">
        <rect x="362" y="362" width="96" height="96" rx="22"/>
        <rect x="490" y="362" width="96" height="96" rx="22"/>
        <rect x="362" y="490" width="96" height="96" rx="22"/>
        <rect x="490" y="490" width="96" height="96" rx="22"/>
      </g>
      <circle class="lens" cx="474" cy="474" r="218" pathLength="100" fill="none" stroke="#FFFFFF" stroke-width="77"/>
    </g>
  </svg>
  <div class="app-loading-dots"><i></i><i></i><i></i></div>
</div>
  `

  // removeLoading 会被 postMessage 和 4999ms 兜底各调一次：只退场一次
  let leaving = false

  return {
    appendLoading() {
      safeDOM.append(document.head, oStyle)
      safeDOM.append(document.body, oDiv)
    },
    removeLoading() {
      if (leaving) return
      leaving = true
      // 退场（320ms 过渡）走完才摘节点；先摘就会失去过渡
      setTimeout(() => {
        safeDOM.remove(document.head, oStyle)
        safeDOM.remove(document.body, oDiv)
      }, 340)
      oDiv.classList.add('is-out')
    },
  }
}

// ----------------------------------------------------------------------

const { appendLoading, removeLoading } = useLoading()
domReady().then(appendLoading)

window.onmessage = ev => {
  ev.data && ev.data.payload === 'removeLoading' && removeLoading()
}

setTimeout(removeLoading, 4999)
