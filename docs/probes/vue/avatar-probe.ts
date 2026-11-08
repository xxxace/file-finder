/**
 * 头像回收 · 行的静态渲染探针（不是测试，是"给我自己看一眼"）。
 *
 * 为什么需要：主人反馈「细节和 demo 完全不一样」，而我在这个环境里看不到他的屏幕。
 * 猜测改了三次都白改（参见 19:58 那次"先上后下"）。这里的做法是
 * **用真组件 + 真 CSS 渲染一遍**，截图后逐项对照 `docs/proto-assistant-2026-11-08.html`。
 *
 * 跑法：先 `npm run dev`（Vite 起在 [::1]:5173），再
 *   env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe docs/probes/vue/avatar-shot.cjs
 * 只看画面，不跑逻辑 —— 所以行数据是写死的三条。
 */
import { createApp } from 'vue';
import '/src/styles/tokens.css';
import AvatarProbe from './AvatarProbe.vue';

createApp(AvatarProbe).mount('#app');
