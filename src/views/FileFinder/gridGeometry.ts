/**
 * 网格几何：**纯函数**，不碰 DOM。
 *
 * ## 为什么要单独一个文件、且不含任何 DOM
 *
 * 网格的列数是**响应式**的：`--item-width` 在 5 个断点里是
 * `100%/6 → 20% → 33.33% → 50% → 100%`（`index.vue:1867` + `1940-1958`），
 * 也就是 **6 / 5 / 3 / 2 / 1 列**。写死 6 一定在窄窗全错。
 *
 * 而"当前这一行有几格、下一行第几格"是**下标运算** —— 纯逻辑。
 * 把它从 DOM 探测里剥出来，才能用夹具把 5 种列数 + 残行 + 边界一次喂完做断言
 * （`docs/probes/grid-cursor/`）。留在 composable 里就只能靠真机目视，
 * 而目视**证伪不了**"3 列时按↓ 会不会跳错格"。
 */

/** 一个格子在这批里的位置。`top` 是它的 `getBoundingClientRect().top`（视口坐标，px）。 */
export interface CellBox {
    key: string;
    top: number;
}

/**
 * 同行判定的容差（px）。
 *
 * 为什么需要容差而不是 `===`：`getBoundingClientRect()` 返回的是**浮点数**，
 * 而 flex 换行算出来的同一行各格 top 理论上相等、实际可能差零点几 px
 * （缩放系数、字体加载后的行高微调）。
 *
 * 取 1px：这个值必须**远小于行高、远大于浮点噪声**。行高是 `1.5rem`（≈192px @1280宽），
 * 所以 1px 绝不会把相邻两行误判成一行；而浮点噪声在正常缩放下远小于 1px。
 */
const ROW_EPS = 1;

/**
 * 视口边界的容差（px）——与 `ROW_EPS` 同值但**语义不同**，单独起名。
 *
 * 用途：`firstVisibleKey` 判"这一行与可视区相交"时要留一点余量，
 * 因为 `viewTop/viewBottom` 与 `rowTops` 都是**浮点**（`getBoundingClientRect` 的返回值），
 * "刚好贴在边上"的那一行不该因为差0.2px 就算成看不见。
 */
const ROW_H_EPS = 1;

/**
 * 把一屏格子按 `top` 分成有序的行。
 *
 * 输入顺序 = DOM 顺序 = `fileList` 顺序（模板里 `v-for` 直接铺 `fileList`），
 * 而 flex `row wrap` **保持 DOM 顺序** ⇒ 输出的 `rows[r][c]` 就是"从上到下、从左到右"的
 * 视觉位置，不需要额外排序。
 *
 * @param cells 当前渲染出的全部格子（**含未进入视口的** —— 方向键要能走到屏幕外那一行）
 * @returns `rows[r][c].key`；空输入返回 `[]`
 */
export function groupRows(cells: CellBox[]): string[][] {
    const rows: string[][] = [];
    // 当前行的基准 top。`NaN` 起步 ⇒ 第一个格子必然开新行（`NaN > x` 恒 false）
    let base = Number.NaN;
    for (const cell of cells) {
        if (rows.length === 0 || Math.abs(cell.top - base) > ROW_EPS) {
            rows.push([cell.key]);
            base = cell.top;
        } else {
            rows[rows.length - 1]!.push(cell.key);
        }
    }
    return rows;
}

/** 方向键的四个方向。用联合类型而不是字符串字面量拼装 —— 拼错在typecheck 就报。 */
export type Dir = 'up' | 'down' | 'left' | 'right';

/** 一个坐标。`{r,c}` 而不是数组下标：可读，且不会把行列写反。 */
export interface Pos {
    r: number;
    c: number;
}

/** 越界（含"这一行没这么长"）。 */
const outOfRange = (rows: string[][], p: Pos) =>
    p.r < 0 || p.r >= rows.length || p.c < 0 || p.c >= rows[p.r]!.length;

/**
 * 在 `rows` 里按方向走一格。**到边界停住，不环绕。**
 *
 * ## 为什么上下左右一律"停住"，不环绕
 *
 * 网格是**空间**：从第 1 项按 ← 跳到第 6 项，人会瞬间不知道刚才按了多少下、
 * 现在在哪一行。Windows 资源管理器 / macOS Finder 都是到边停住。
 *
 * （预览层那种"首尾环绕"是**序列**语义 —— 上一条/下一条本来就该循环，
 * 那是 naive-ui 自己的行为，与网格无关。两边不同**是刻意的**，见设计文档 §四。）
 *
 * ⚠️ 上下移动时列号**保持不变**：残行（最后一行可能没满）上按 ↓ 落到不存在的列
 * 就**停住**，而不是悄悄挪到该行最后一格 —— 那会让"↓ 是往下"这个直觉在末行失效。
 */
export function stepPos(rows: string[][], from: Pos, dir: Dir): Pos {
    const delta: Record<Dir, Pos> = {
        up: { r: -1, c: 0 },
        down: { r: 1, c: 0 },
        left: { r: 0, c: -1 },
        right: { r: 0, c: 1 },
    };
    const next: Pos = { r: from.r + delta[dir].r, c: from.c + delta[dir].c };
    return outOfRange(rows, next) ? from : next;
}

/**
 * 在 `rows` 里找 `key` 的坐标。找不到返回 `null`。
 *
 * 存key 不存坐标的原因（与 `usePreview` 同构）：**坐标是列表的函数**，
 * 列一变（窗口拖窄）同一个 key 的坐标就变了；反过来"这一格是第几行第几格"
 * 可以从当前布局现算，不需要任何同步代码。
 */
export function posOf(rows: string[][], key: string): Pos | null {
    for (let r = 0; r < rows.length; r++) {
        const c = rows[r]!.indexOf(key);
        if (c >= 0) return { r, c };
    }
    return null;
}

/**
 * 首次激活的落点：**视口里最靠上那一行的第一格**。
 *
 * ⚠️ 为什么不能取 `rows[0][0]`：`onBack` 会恢复这一屏的 `scrollY`
 * （`index.vue:903-906`）⇒ 从子目录返回时，屏幕可能停在**中间**。
 * 那时把选择器放到 `rows[0][0]` 就等于放到屏幕外 —— 用户按了方向键、什么都没看见。
 *
 * @param rows    当前行结构
 * @param viewTop    滚动容器**可视区顶边**的视口坐标（`imageBox.getBoundingClientRect().top`）
 * @param viewBottom 滚动容器**可视区底边**的视口坐标（同上 `.bottom`）
 * @param rowTops 每一行第一格的 `top`，与 `rows` 同序。分开传是为了让本函数保持纯函数
 *                （不碰 DOM）；调用方用同一批 `getBoundingClientRect()` 的结果一并算出来即可
 * @returns 落点 key；`rows` 为空返回 `''`
 */
export function firstVisibleKey(
    rows: string[][],
    rowTops: number[],
    viewTop: number,
    viewBottom: number,
): string {
    for (let r = 0; r < rows.length; r++) {
        const top = rowTops[r]!;
        // ⚠️⚠️ **双边界**，缺一不可（2026-10-04 code review 抓出）。
        // 只判下界（`top < viewBottom`）时：屏幕停在中间（`onBack` 恢复了 `scrollY`），
        // 第 0 行的 top 是个很大的**负数** ⇒ `top < viewBottom` 恒真 ⇒ 返回 `rows[0][0]`
        // ⇒ **选择器落在屏幕上方看不见的地方**，接着 `scrollIntoView` 把视口猛拉到最顶。
        // 而这个函数存在的**全部理由**就是"屏幕可能停在中间"（见 `useGridCursor` 的注释）
        // ⇒ 判据与自己的存在理由相反。判据必须是"**与可视区相交**"，不是"在可视区之下"。
        //
        // 容差同 `groupRows`：浮点噪声不该让"刚好贴着边的那行"被算成不可见。
        if (top < viewBottom - ROW_EPS && top + ROW_H_EPS > viewTop) return rows[r]![0]!;
    }
    // 所有行都与可视区不相交（内容太短 / 容器异常 / 网格还没渲染）
    // ⇒ 退回第一行第一格。**宁可落在屏幕外也不能"按方向键毫无反应"**。
    return rows[0]?.[0] ?? '';
}
