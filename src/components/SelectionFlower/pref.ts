/**
 * 选区开花的开关。**默认开启** —— 彩蛋藏起来就没人发现了。
 *
 * 存储格式照 `utils/sfx/index.ts`：localStorage 一条 JSON + 模块级 reactive，
 * 设置页直接绑 `bloomPrefs`，改值即持久化。
 * ⚠️ key 与 `ff-theme` / `ff.sfx` 同一命名空间。
 */
import { reactive } from 'vue';

const STORAGE_KEY = 'ff.selection-flower';

interface BloomPrefs {
    on: boolean;
}

function load(): BloomPrefs {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        // 只有明确写了 false 才算关（坏数据 / 老版本没这个键都当默认开启）
        if (raw) return { on: (JSON.parse(raw) as Partial<BloomPrefs>).on !== false };
    } catch {
        // 坏数据当没配过；隐私模式下 localStorage 本身也可能抛
    }
    return { on: true };
}

/** 设置页直接绑这个响应式对象 */
export const bloomPrefs = reactive(load());

export function setBloomEnabled(on: boolean) {
    bloomPrefs.on = on;
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ on }));
    } catch {
        // 存不下就本次会话内生效
    }
}
