# cursor-scale-row · 焦点格的 scale 会不会污染行结构

```bash
bashdocs/probes/cursor-scale-row/run.sh
```

**验什么**：业主 2026-10-04 真机报「按右不一定动，按上却去了右」。

**根因不是几何算法错，是量纲错**：
`index.vue:2214` 给焦点格加了 `transform: scale(1.012)`，
而 `useGridCursor.probeLayout` 用 `getBoundingClientRect().top` 分行、
`gridGeometry.groupRows` 的容差只有 `ROW_EPS = 1`。
`getBoundingClientRect()` 返**变换后**的矩形 ⇒ 焦点格比同排兄弟高
`(1.012−1)/2 × 307.2px = 1.843px` > 1px ⇒ **它被单独判成一行**。

## 判据

| # | 验什么 | 结果 |
|---|---|---|
| D1 | 基线：无焦点格时行结构 | 2 行 × 6 格，同排 top 极差 **0.0000px** |
| D2 | 焦点格在行尾（`k5`）| 偏移 **1.843px** ⇒ 行结构碎成 **5/1/6** |
| D3 | 焦点格在行中间（`k2`）| 碎成 **2/1/3/6**（更碎） |
| D4 | 转场**刚开头**那一帧 | scale≈1 ⇒ **不**劈开 |
| D4b | 转场**中段**（≈90ms）| 偏移 1.859px ⇒ **劈开**（真实运行时会读到这一帧） |
| D5 | **控制组**：去掉 scale | 偏移 0.0000px ⇒ 行结构恢复 2×6 |
| D6 | **治本量**：`offsetTop` | 对焦点格偏移 **0.0000px** ⇒ 分行正确 |
| D7 | 两种坐标各有分工 | 滚动 234px 后 `rect.top − offsetTop = −234` |
| D8 | `offsetParent` 是谁 | **BODY** ⇒ **推翻 `gridGeometry.ts:177` 的注释前提** |

**18 PASS / 0 FAIL。**

## 为什么必须真渲染

偏移量 = `transform` × 高度，而高度 = `1.5rem`、`rem` 由 `flexible.ts` 按窗口宽度算出来
⇒ 不开真窗口、拿不到真 rect，算出来的数只是"我以为的数"。

## 与 `grid-cursor/` 的分工（**别混**）

`grid-cursor/` 测**纯函数**（喂手造的 `CellBox` 序列，验"给对的 top 时groupRows 判得对不对"）
⇒ 它**按定义看不到** transform 改 top 这件事。缺口在**覆盖范围**，不在被测算法。
本探针补的正是那一层：真排版下的 rect 长什么样。

## ⚠️ 同步义务

`index.html` 里的 CSS 是 `index.vue` 的**等效复制**（只保留与行的 top 有关的部分）。
**改产品样式时必须同步改这里** —— 复制错了探针就白测。
