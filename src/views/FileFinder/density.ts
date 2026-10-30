/**
 * 网格密度档位：**列数的唯一真相源**。
 *
 * 为什么单独一个文件：列数同时被三处需要 ——
 * ① CSS 布局（`--ff-grid-cols`，见 `index.vue` 的 `.image-box-item`）
 * ② 下拉控件（显示"宽松 · 6 列"）
 * ③ 键盘选择器（列数变 ⇒ 行结构变 ⇒ 缓存必须失效，见 `useGridCursor` 的 `cols`）
 * 三处各写一个 6/8/12 就是三份会漂移的真相；放这里，另两处只读不写。
 *
 * ⚠️ 列数**不再参与任何响应式断点**。2026-10-21 主人裁定过「删掉 5/3/2/1 断点、
 * 恒定列数」，本次是「用户自己选列数」，不是把断点加回来。
 * 窄窗唯一的下限保护在 CSS：`.image-box-item` 的 `min-width`（`--ff-grid-min-cell`）。
 */

export type Density = 'wide' | 'normal' | 'tight';

export interface DensityOption {
    key: Density;
    /** 菜单里显示的中文档名 */
    label: string;
    cols: number;
}

/**
 * 档位顺序 = UI 菜单顺序 = 从松到紧。
 *
 * 数值依据（2048 屏、去掉左轨与内边距后容器约 1960px）：
 * 6 列 ≈ 310px/格、8 列 ≈ 229px、12 列 ≈ 147px。
 * 12 列是"扫片"档，格宽仍在缩略图（384px，DPR 1.5 下需 220px）的可读范围内。
 */
export const DENSITY_OPTIONS: readonly DensityOption[] = [
    { key: 'wide', label: '宽松', cols: 6 },
    { key: 'normal', label: '标准', cols: 8 },
    { key: 'tight', label: '紧凑', cols: 12 },
];

/**
 * 默认 = `wide`（6 列）= 加这个功能之前的样子。
 * 切换是可选动作，不该一打开就变样。
 */
export const DEFAULT_DENSITY: Density = 'wide';

const STORAGE_KEY = 'ff.grid.density';

/** 档位 → 列数。非法档位按默认档算（调用方只有拿到 `Density` 才会进来，兜底是给存储值的）。 */
export function colsOf(d: Density): number {
    return DENSITY_OPTIONS.find(o => o.key === d)?.cols ?? DENSITY_OPTIONS[0]!.cols;
}

/** 档位 → 中文名（tooltip / 菜单用）。 */
export function labelOf(d: Density): string {
    return DENSITY_OPTIONS.find(o => o.key === d)?.label ?? DENSITY_OPTIONS[0]!.label;
}

/**
 * 读上次选择。
 *
 * ⚠️ **白名单校验**，不是"读出来就用"：存储里的值可能是
 * 空串、上一个版本的 key、手改的乱码、甚至 JSON —— 任何一个直接塞进
 * `--ff-grid-cols` 都会让网格静默塌掉（`calc(100% / NaN)` 整条声明失效，
 * 格子退回内容宽 → 一行一个）。宁可退回默认档。
 *
 * 读也可能抛（隐私模式 / 存储被策略禁掉）⇒ 一并兜住。
 */
export function loadDensity(): Density {
    try {
        const v = localStorage.getItem(STORAGE_KEY);
        return DENSITY_OPTIONS.some(o => o.key === v) ? (v as Density) : DEFAULT_DENSITY;
    } catch {
        return DEFAULT_DENSITY;
    }
}

/** 写上次选择。写失败只是"下次不记得"，**绝不能因此崩**（同上：隐私模式会抛）。 */
export function saveDensity(d: Density): void {
    try {
        localStorage.setItem(STORAGE_KEY, d);
    } catch {
        /* 存不下就算了 */
    }
}
