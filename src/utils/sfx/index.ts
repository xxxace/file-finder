/**
 * 音效门面 —— 全项目唯一入口（铁律：同一件事必须共用一份实现）。
 *
 * 用法：`playSfx('switch-on')`。事件表在下面，业务里**不许**直接 import engine。
 *
 * 三条纪律：
 *  ① 只给「离散、低频、缺视觉反馈」的事件上声音 —— hover / 方向键 / 打开预览一律不配
 *     （Apple HIG 同判据：声音只给离散动作；预览层弹出本身已是强反馈）。
 *  ② 同一事件 60ms 内去重：连点/连扫不会变成机关枪。
 *  ③ 设置（开关 + 音量）走 localStorage `ff.sfx`，模式照抄 `useTheme.ts`；
 *     首次**任何用户手势前**浏览器不让出声 —— 引擎在首次 play 时才建 AudioContext，天然合规。
 *
 * 性能：引擎内部按 recipe 渲染成 AudioBuffer 后缓存（**FIFO 96 条**：写满逐最旧的淘汰，
 * 不是 LRU —— 13 个事件 × 少数变体远达不到上限，没必要再引入一套访问序），重复播放零合成开销；
 * `preloadSfx()` 在空闲时把常用音预渲染一遍。
 */
import { reactive } from 'vue';
import { playSound, preloadSound, setSoundMuted, setSoundVolume, type Recipe } from './engine';
import { SFX_RECIPES, type SfxRecipe } from './recipes';

export type SfxEvent =
    | 'mode'          // 档位/步进切换（网格密度、视图模式）
    | 'menu-click'   // 左轨菜单点击（Nib tick）
    | 'switch-on'     // 开关打开
    | 'switch-off'    // 开关关闭
    | 'theme-light'   // 切到浅色
    | 'theme-dark'    // 切到深色
    | 'success'       // 扫描 / 补全 / apply 完成
    | 'pick'          // 收藏添加
    | 'done'          // 复制 / 导出完成
    | 'hover'         // 左轨入口 hover（主人 2026-11-09 指定，覆盖"不上 hover 音"的一般规则）
    | 'drive-in'     // 移动硬盘接入
    | 'drive-out'    // 移动硬盘拔出
    | 'warn';         // 失败 / 需要注意（2026-11-09 主人确认：用户动作的失败要有反馈）

const EVENT_RECIPE: Record<SfxEvent, SfxRecipe> = {
    mode: SFX_RECIPES.notch,
    'menu-click': SFX_RECIPES.nib,
    'switch-on': SFX_RECIPES.clasp,
    'switch-off': SFX_RECIPES.unclasp,
    'theme-light': SFX_RECIPES.daylight,
    'theme-dark': SFX_RECIPES.nightfall,
    success: SFX_RECIPES.bloom,
    pick: SFX_RECIPES.bead,
    done: SFX_RECIPES.ping,
    hover: SFX_RECIPES.hover,
    'drive-in': SFX_RECIPES.dawn,
    'drive-out': SFX_RECIPES.dusk,
    warn: SFX_RECIPES.nudge,
};

/** 个别事件在配方响度之上再压一档。Hover 配方本身已是 -23dB 的"微光"（官方按 hover 调的），
 *  不再额外压低 —— 要更轻先调这里。 */
const EVENT_VOLUME_DB: Partial<Record<SfxEvent, number>> = {};

const STORAGE_KEY = 'ff.sfx';
const DEBOUNCE_MS = 60;

interface SfxPrefs { on: boolean; vol: number }

function loadPrefs(): SfxPrefs {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
            const v = JSON.parse(raw) as Partial<SfxPrefs>;
            return { on: v.on !== false, vol: Math.min(1, Math.max(0, Number(v.vol) || 0.7)) };
        }
    } catch { /* 坏数据当没配过 */ }
    return { on: true, vol: 0.7 };
}

function savePrefs() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ on: sfxPrefs.on, vol: sfxPrefs.vol }));
}

/** Settings 页直接绑这个响应式对象；改值即持久化、即生效 */
export const sfxPrefs = reactive(loadPrefs());

function applyPrefs() {
    setSoundMuted(!sfxPrefs.on);
    setSoundVolume(sfxPrefs.vol);
}
applyPrefs();

export function setSfxEnabled(on: boolean) {
    sfxPrefs.on = on;
    applyPrefs();
    savePrefs();
    playSfx(on ? 'switch-on' : 'switch-off');
}

export function setSfxVolume(vol: number) {
    sfxPrefs.vol = Math.min(1, Math.max(0, vol));
    applyPrefs();
    savePrefs();
}

const lastPlayed = new Map<SfxEvent, number>();

/** hover 音抑制窗（主题切换动画专用）：动画期间浏览器会补发 leave→enter，
 *  锚定「点击时刻」关窗 1.2s（动画 650ms + 余量），窗口内 hover 音一律忽略。 */
let hoverSuppressedUntil = 0;

export function suppressHover(ms: number) {
    hoverSuppressedUntil = performance.now() + ms;
}

/** 播放一个界面事件音。静音/关开关时零开销直接返回。 */
export function playSfx(event: SfxEvent) {
    if (!sfxPrefs.on || sfxPrefs.vol <= 0) return;
    if (event === 'hover' && performance.now() < hoverSuppressedUntil) return;
    const now = performance.now();
    if (now - (lastPlayed.get(event) ?? -Infinity) < DEBOUNCE_MS) return;
    lastPlayed.set(event, now);
    playSound(EVENT_RECIPE[event] as unknown as Recipe, { volume: EVENT_VOLUME_DB[event] }).catch(() => undefined);
}

/** 空闲时把常用音预渲染进缓存（RAF 两拍后 ≈ 首屏已落稳） */
export function preloadSfx() {
    if (typeof requestAnimationFrame !== 'function') return;
    requestAnimationFrame(() => requestAnimationFrame(() => {
        // hover / menu-click 是频率最高的两个（左轨每进一个入口、每点一次菜单）——
        // 不预渲染的话**第一次**要等一次离线合成，手感会"虚"一下。
        const common: SfxEvent[] = ['hover', 'menu-click', 'mode', 'switch-on', 'theme-light', 'theme-dark', 'success'];
        common.forEach((event) => preloadSound(EVENT_RECIPE[event] as unknown as Recipe));
    }));
}
