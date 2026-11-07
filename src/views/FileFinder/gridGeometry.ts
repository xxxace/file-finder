/**
 * 网格几何：**纯函数**，不碰 DOM。
 *
 * ## 为什么要单独一个文件、且不含任何 DOM
 *
 * 网格的列数由密度档位决定（宽松 6 / 标准 8 / 紧凑 12，见 `density.ts`；
 * 2026-10-21 主人裁掉的是**自动断点**，不是"列数可调"），
 * 但本模块**不假设列数**：行结构仍由实测的 `offsetTop` 推出来 ——
 * 搜索过滤后的残行、以及将来若改密度，这里都不用动。
 *
 * 而"当前这一行有几格、下一行第几格"是**下标运算** —— 纯逻辑。
 * 把它从 DOM 探测里剥出来，才能用夹具把多列 + 残行 + 边界一次喂完做断言
 * （`docs/probes/grid-cursor/`）。留在 composable 里就只能靠真机目视，
 * 而目视**证伪不了**"残行时按↓ 会不会跳错格"。
 */

/**
 * 一个格子在这批里的位置。
 * ⚠️ rowTop 必须是布局坐标 offsetTop，不能用 getBoundingClientRect().top：焦点格 transform: scale(1.012) 会抬高 top 超过 ROW_EPS ⇒ 被判成单独一行 ⇒ 方向键错位（见 docs/ANALYSIS-arrow-key-misalign-2026-10-04.md）。
 * ⚠️ offsetTop 不含 transform；offsetParent 回落到 BODY（.image-box 无 position），可读可分行。
 */
export interface CellBox {
    key: string;
    /** **布局坐标**（`offsetTop`），同行必相等。**不要**传 `getBoundingClientRect().top`。 */
    rowTop: number;
}

/**
 * 同行判定的容差（px）。
 *
 * 为什么需要容差而不是 `===`：`offsetTop` 在不同缩放 / 字体加载下可能有亚像素差异，
 * 且它是**整数化**过的值，同一行理应完全相等；留 1px 是为了不因这点噪声把一行劈开。
 *
 * ⚠️ **这个值必须远小于「因transform 被污染的偏移量」，否则会漏判。**
 * `scale` 偏移 = `(scale−1)/2 × 格高`（主屏 ≈ 1.84px）**随窗口宽度线性变化** ——
 * 调大容差是**打补丁**（换台显示器就复发）。正解是传入不受 transform 影响的坐标。
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
 * 把一屏格子按 `rowTop`（**布局坐标**）分成有序的行。
 *
 * 输入顺序 = DOM 顺序 = `fileList` 顺序（模板里 `v-for` 直接铺 `fileList`），
 * 而 flex `row wrap` **保持 DOM 顺序** ⇒ 输出的 `rows[r][c]` 就是"从上到下、从左到右"的
 * 视觉位置，不需要额外排序。
 *
 * ⚠️ `cells[].rowTop` 必须是 `offsetTop`，**不能**是 `getBoundingClientRect().top`
 * —— 见 `CellBox` 上方那段约束（transform 污染会让焦点格被劈成单独一行）。
 *
 * @param cells 当前渲染出的全部格子（**含未进入视口的** —— 方向键要能走到屏幕外那一行）
 * @returns `rows[r][c].key`；空输入返回 `[]`
 */
export function groupRows(cells: CellBox[]): string[][] {
    const rows: string[][] = [];
    // 当前行的基准。`NaN` 起步 ⇒ 第一个格子必然开新行（`NaN > x` 恒 false）
    let base = Number.NaN;
    for (const cell of cells) {
        if (rows.length === 0 || Math.abs(cell.rowTop - base) > ROW_EPS) {
            rows.push([cell.key]);
            base = cell.rowTop;
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
 * 在 `rows` 里按方向走一格：左右到边界停住；上下按"目标行"投影。
 * ⚠️ 上下必须投影到目标行（列号 clamp 到该行长度）：残行可出现在任何位置，列号硬不变会让按 ↓ "停在原地"（用户以为程序坏了）；真正的边界是"目标行不存在"。
 * ⚠️ 左右仍停住，不能一起改成投影：横向越界 = 这一行到头，挪到别的行会破坏"左右 = 在这一行里移动"的空间直觉（X5 断言锁住）。
 */
export function stepPos(rows: string[][], from: Pos, dir: Dir): Pos {
    // 左右：列号硬不变，越界即停（"这一行到头了"）
    if (dir === 'left' || dir === 'right') {
        const next: Pos = { r: from.r, c: from.c + (dir === 'right' ? 1 : -1) };
        return outOfRange(rows, next) ? from : next;
    }
    // 上下：先看目标行在不在
    const nr = from.r + (dir === 'down' ? 1 : -1);
    if (nr < 0 || nr >= rows.length) return from;          // 真正的边界：停住
    // 目标行存在 ⇒ 列号投影到该行范围内（短行则落在它的末格）
    return { r: nr, c: Math.min(from.c, rows[nr]!.length - 1) };
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
 * @param rows    当前行结构（由 `groupRows` 从**布局坐标**算出）
 * @param viewTop    滚动容器**可视区顶边**的视口坐标（`imageBox.getBoundingClientRect().top`）
 * @param viewBottom 滚动容器**可视区底边**的视口坐标（同上 `.bottom`）
 * @param rowTops 每一行第一格的**视口坐标**（`getBoundingClientRect().top`），与 `rows` 同序。
 *                分开传是为了让本函数保持纯函数（不碰 DOM）。
 *
 * ⚠️⚠️ **`rowTops` 与 `rows` 是两个不同坐标系，别混用**：
 * - `rows` 来自**布局坐标**（`offsetTop`）⇒ **与 transform 无关**、**与滚动无关**
 * - `rowTops` 来自**视口坐标**（`getBoundingClientRect`）⇒ **跟着滚动变**（这正是它存在的理由）
 *
 * 实测（2026-10-04）：滚动 234px 后 `rect.top − offsetTop = −234` ⇒ 二者不可互换。
 * `rowTops` 用 rect 是**可以**的：它只用来判"这行在不在视口内"，
 * 1.8px 的 transform 偏移落在 `ROW_H_EPS` 的量级内，不影响相交判断。
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
