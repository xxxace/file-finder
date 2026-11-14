/**
 * `v-tip` 指令 —— 功能页 tooltip 的统一入口。
 *
 * 用法（替换原 `<n-tooltip><template #trigger>…</template>文案</n-tooltip>` 七行样板）：
 *   <n-button v-tip="'重新读取当前文件夹'">…</n-button>
 *   <n-button v-tip="{ text: '搜索', keys: 'S' }">…</n-button>
 *
 * 纪律：
 *  - 值为空串/undefined ⇒ 不显示（条件性提示直接算空即可）；
 *  - 触屏（pointerType==='touch'）不显示 —— 没有 hover 语义，交给 aria-label；
 *  - focus 也显示（键盘可达性），blur 收起；
 *  - 挂**可交互元素本身**（按钮 / 卡片 / 输入框），不要挂在它的子孙上 ——
 *    提示说的是"这个控件是干什么的"，挂到里面那一小块字上，热区也就只剩那一小块。
 *  - 键帽 `keys` 只许标**真实绑定了**的快捷键，没有就不给。
 *
 * ## 什么该用它、什么不该（2026-11-14 收敛，全站唯一判据）
 *
 * 视觉基准 = **顶栏操作按钮那颗胶囊**（`--ff-tooltip-*` 反色深片）。全站提示只有这一种材质，
 * 不许再出现"这一个样式那一个样式"。
 *
 * | 信息形态 | 用什么 | 判据 |
 * |---|---|---|
 * | 动作名 / 当前状态 / **为什么点不动** / 快捷键 | `v-tip` | 只在 hover 时才有意义，界面上无处常驻 |
 * | 截断文本的**全文预览**（名称、路径、标题、大小） | 原生 `title` | 见下，**不要**换成 v-tip |
 * | ≥2 行结构化信息（键值表） | `v-tip` + `body` | 单行胶囊装不下表格（走玻璃面板，见 FluidTipHost） |
 *
 * **全文预览为什么留在原生**（不是懒，是更对）：
 *  ① 这类提示出在列表/网格里，是"扫视"场景。`v-tip` 150ms 首现 + 簇内滑动，会随指针移动
 *     连续弹出，比原生 ~1s 延迟**更吵**；原生的延迟正好当过滤器用。
 *  ② 零 DOM、零监听器。网格里可能上千个条目，每个挂一条指令是纯浪费。
 *
 * ⚠️ **禁用按钮也能用 v-tip**（2026-11-14 实测，`docs/probes/disabled-hover/`）：
 *   `<button disabled>` 照常派发 `pointerenter` **与** `pointerleave`（成对，不会卡住），
 *   而 `pointer-events:none` 的对照组零事件 —— 探针能区分，结论可信。
 *   所以"禁用了只能用 title"这个借口不成立。
 */
import type { Directive } from 'vue';
import { hideTip, showTip, type TipPayload } from './fluidTip';

/** 字符串糖 `v-tip="'...'"` 与对象写法归一 —— mounted / updated 共用一份，否则两处迟早不一致 */
const toBinding = (value: string | TipPayload | undefined): TipPayload =>
    typeof value === 'string'
        ? { text: value }
        : { text: value?.text ?? '', keys: value?.keys, body: value?.body };

const store = new WeakMap<HTMLElement, TipPayload>();

const onEnter = (event: Event) => {
    const el = event.currentTarget as HTMLElement;
    const cfg = store.get(el);
    // 富内容可以没有 text（text 只作占位），所以判空要两者一起看
    if (!cfg || (!cfg.text && !cfg.body)) return;
    if (event instanceof PointerEvent && event.pointerType === 'touch') return;
    showTip(el, cfg);
};
const onLeave = () => hideTip();

export const vTip: Directive<HTMLElement, string | TipPayload> = {
    mounted(el, binding) {
        store.set(el, toBinding(binding.value));
        el.addEventListener('pointerenter', onEnter);
        el.addEventListener('pointerleave', onLeave);
        el.addEventListener('focus', onEnter);
        el.addEventListener('blur', onLeave);
    },
    updated(el, binding) {
        store.set(el, toBinding(binding.value));
    },
    unmounted(el) {
        el.removeEventListener('pointerenter', onEnter);
        el.removeEventListener('pointerleave', onLeave);
        el.removeEventListener('focus', onEnter);
        el.removeEventListener('blur', onLeave);
        store.delete(el);
    },
};
