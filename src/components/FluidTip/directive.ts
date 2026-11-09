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
 *  - 键帽 `keys` 只许标**真实绑定了**的快捷键，没有就不给。
 */
import type { Directive } from 'vue';
import { hideTip, showTip, type TipPayload } from './fluidTip';

interface Binding { text: string; keys?: string }

const store = new WeakMap<HTMLElement, Binding>();

const onEnter = (event: Event) => {
    const el = event.currentTarget as HTMLElement;
    const cfg = store.get(el);
    if (!cfg || !cfg.text) return;
    if (event instanceof PointerEvent && event.pointerType === 'touch') return;
    showTip(el, cfg);
};
const onLeave = () => hideTip();

export const vTip: Directive<HTMLElement, string | TipPayload> = {
    mounted(el, binding) {
        const cfg: Binding =
            typeof binding.value === 'string'
                ? { text: binding.value }
                : { text: binding.value?.text ?? '', keys: binding.value?.keys };
        store.set(el, cfg);
        el.addEventListener('pointerenter', onEnter);
        el.addEventListener('pointerleave', onLeave);
        el.addEventListener('focus', onEnter);
        el.addEventListener('blur', onLeave);
    },
    updated(el, binding) {
        const cfg: Binding =
            typeof binding.value === 'string'
                ? { text: binding.value }
                : { text: binding.value?.text ?? '', keys: binding.value?.keys };
        store.set(el, cfg);
    },
    unmounted(el) {
        el.removeEventListener('pointerenter', onEnter);
        el.removeEventListener('pointerleave', onLeave);
        el.removeEventListener('focus', onEnter);
        el.removeEventListener('blur', onLeave);
        store.delete(el);
    },
};
