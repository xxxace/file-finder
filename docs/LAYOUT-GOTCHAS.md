# 布局类坑（从 `.workbuddy/memory/MEMORY.md` §十一 搬出来的）

> 为什么搬：`MEMORY.md` 有**注入截断**的体积上限，这三条正文太长，把它们放在这里、
> `MEMORY.md` 只留一行索引。**内容逐字保留，没有丢。**
> 触发场景：改任何"容器 / 滚动 / flex"的 UI 时先读一遍。

## 1. 表格内部滚动 + 表头吸顶

- ① 外层要有**确定高度**：`max-height` **只封顶、不给高度**，`flex:1 1 auto` 的子项就没有剩余空间可分，
  表格会按内容长（实测 60 行 = **4235px**）压根不受约束。
- ② 滚动交给 DataTable 自己：加 **`flex-height`**，它会把表头渲染成独立的一块
  （`.n-data-table-base-table-header`），滚动只发生在 body 里。
- ③ **别**给外层 div 加 `overflow:auto` + 给 `thead` 加 `position:sticky` —— 实测无效
  （表头相对表格跑到 −3562px）。
- 代价：卡片要给 `height:86vh`（恒定高，不再随内容变矮）。
- ⚠️ 配套事实：`n-spin` 的 DOM 是 `.n-spin-container > .n-spin-content > slot`，
  这条 flex 链上**每一层都要** `flex:1 1 auto; min-height:0`，少一层（尤其 `.n-spin-container`）
  高度就传不下去。
- 模板：`src/components/HistoryTable/index.vue`；探针 `docs/probes/table-scroll/`（可一键复算）。

## 2. 弹窗内只有表格滚

别把 `overflow` 加在卡片内容上 —— 那会变成整个弹窗 body 滚动。用户明确要求：**只有表格滚**。

## 3. 小窗口下「flex 子项被挤压」是一类病

症状常表现为"**文字竖排成一个字一行** / 元素悬在半空"。
（实例：分页器内部 `flex-wrap: nowrap`，被挤压后把「共 N 项」压到内容最小宽 ≈12px。）

**通用解法**：
- 容器给 `flex-wrap: wrap`（装不下就整块换行）
- 要"整块不缩"的一方给 `flex: 0 0 auto`
- 会被压成竖排的文本再补 `white-space: nowrap`

探针：`docs/probes/narrow-layout/`（扫 680→1100 宽度复算）。

⚠️ **附带的坑**：**别把 `scrollWidth > clientWidth` 当"可横向滚动"的判据** ——
被父级裁掉的内容 `scrollWidth` 照样更大，会把"改前"也判成可滚动，**证据不能用**。
正确判据是 computed `overflow-x` ∈ {`auto`, `scroll`} **且**内容更宽。
