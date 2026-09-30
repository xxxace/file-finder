# 探针：表格「内部滚动 + 表头吸顶」

**问题**（用户真机反馈）：「表格的 header 为什么还是会跟着滚动消失在可视区域？」

**回答**：因为**表格根本没有被高度约束**，滚的是包表格的那层 div 而不是表格自己的 body。

## 复算

```bash
bash docs/probes/table-scroll/run.sh     # 结果写进 out.log
```

用**项目自带 electron**（无头 offscreen）当真实浏览器，页面加载**真 naive-ui UMD 包** +
真 Vue，渲染同样的卡片 / n-spin / n-data-table 结构，然后量：
① 滚的到底是哪个元素；② 滚到底之后表头还在不在表格可视区内。

## 实测结论（`out.log`）

| 变体 | 卡片 CSS | 表格实测高 | 滚的是谁 | 滚到底后表头 |
|---|---|---|---|---|
| **old**（第一版实现） | `max-height: 86vh` + `.table-wrap{overflow:auto}` + `thead{position:sticky}` | **4235 px** | `table-wrap(672/4235)` | **顶部相对表格 −3562 → 滚走了** ❌ |
| **new**（现在） | `height: 86vh` + `.table-wrap{display:flex}` + DataTable `flex-height` | **672 px** | `n-scrollbar-container(622/4186)`（DataTable 自己的 body） | **相对表格顶部 1 px → 钉住** ✅ |

## 为什么第一版不行（根因）

1. **`max-height` 只封顶，不给确定高度** —— 容器高度仍是"内容高度"。
   于是 `flex: 1 1 auto` 的子项**没有剩余空间可分**，表格按内容长到 4235 px，压根没被约束。
2. 表格没被约束 ⇒ `.table-wrap` 那层 `overflow:auto` 就变成**整张表**的滚动容器，
   表头是表格的一部分，自然跟着滚。
3. 给 `thead` 加 `position: sticky` 也没救到 —— 它的祖先里那层 `overflow` 把 sticky 的参照系
   换成了"整张表"的可视区，而表头从来没离开过那张表。

**正确做法**：① 给卡片**确定高度**（`height: 86vh`）让 flex 链有东西可分；
② 滚动交给 DataTable 自己（`flex-height`）—— 它会把表头渲染成**独立的一块**
（`.n-data-table-base-table-header`），滚动只发生在 body 里。类名与机制在
`node_modules/naive-ui/es/data-table/src/{MainTable,styles/index.cssr}.mjs` 里核对过。

## 代价（要知道的）

卡片从"最小 86vh、内容矮就矮"改成"**恒定 86vh**"。列表页这是合适的
（翻页时面板不跳），代价是只有几行数据时下方会留空白。
