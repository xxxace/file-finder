/**
 * 跨页跳转的意图（清单页/缓存页 → 文件页）。
 *
 * 为什么需要它：三页现在是**三条独立路由**，没有父子关系，
 * 不能再像以前那样由文件页直接调用自己的 `openHistory` / `enterPlaylist`。
 *
 * 用法：别的页 `openInFiles({ kind:'playlist', ... })` 然后 `router.push('/')`；
 * 文件页在 `onActivated` 里 `consumeTarget()` —— **取一次就清空**，
 * 所以刷新/再来一次不会重复触发。
 */
import { ref } from 'vue';

export type FileTarget =
    | { kind: 'path'; path: string; nonce: number }
    | { kind: 'playlist'; id: string; name: string; nonce: number };

export type TargetInput =
    | { kind: 'path'; path: string }
    | { kind: 'playlist'; id: string; name: string };

const pending = ref<FileTarget | null>(null);

/** 同一个目标连点两次也要生效 ⇒ 带 nonce（消费方按引用比较即可） */
let seq = 0;

export function openInFiles(target: TargetInput) {
    pending.value = { ...target, nonce: ++seq } as FileTarget;
}

export function consumeTarget(): FileTarget | null {
    const t = pending.value;
    pending.value = null;
    return t;
}
