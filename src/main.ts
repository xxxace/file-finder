import { createApp } from 'vue'
import App from './App.vue'
import { router } from './router'
import './styles/tokens.css'
import './styles/theme-transition.css'
// vectors 已完全包含 classic（369 条规则里 368 条逐字相同，剩 1 条选择器是其子集），只引这一个。
import 'file-icon-vectors/dist/file-icon-vectors.min.css';
import { preloadSfx } from './utils/sfx'
import { vTip } from './components/FluidTip/directive'

// 基准字号：物理 12px（= 12 × dpr CSS px）。自绘元素里没显式写 font-size 的靠它继承。
// 原 utils/flexible.ts 的另外两段（1rem 计算、.hairlines 检测）全仓已无消费方，已随文件删除。
document.body.style.fontSize = `${12 * (window.devicePixelRatio || 1)}px`

createApp(App)
  .use(router)
  .directive('tip', vTip)
  .mount('#app')
  .$nextTick(() => {
    postMessage({ payload: 'removeLoading' }, '*')
    preloadSfx() // 首屏落稳后把常用音预渲染进缓存（不占首屏）
  })
