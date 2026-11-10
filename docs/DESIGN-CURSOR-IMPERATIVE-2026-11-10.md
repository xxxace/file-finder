# 光标标记改命令式（`data-cursor`）—— 2026-11-10

> 业主：**"按你说的做，但要确保界面流畅，是正向增益不是逆向优化；代码别堆在一个文件里，能模块化就模块化。"**

## 1. 为什么改（成本拆在哪儿）

光标环本身不贵：`outline` **不参与布局、不参与命中测试**；`transform: scale(1.012)` 走合成层。
贵的是**"哪一格是光标"这个事实从哪来** —— 原来模板里写着：

```html
v-memo="[..., cursorKey === keyOf(item), ...]"
:class="{ cursor: cursorItem !== undefined && cursorKey === keyOf(item) }"
```

⇒ **每按一次方向键**，整个 `v-for` 作用域都要重建一遍 vnode，并逐条求值 `v-memo` 的依赖数组
（N 条 × 3 次 `keyOf` + 2 次集合查询）。平铺几千格时那是每键 1–3ms 的纯开销，
而屏幕上其实只动了**两张卡**。

**这不是猜的**：`cursorKey` 出现在模板的渲染依赖里，方向键改它 ⇒ 组件必须重渲染，这是 Vue 的模型决定的。

## 2. 三个方案与取舍

| 方案 | 思路 | 省下什么 | 代价 | 结论 |
|---|---|---|---|---|
| A. 单环 div（绝对定位 + `translate`） | 容器里挂**一个**环元素，用 transform 移到目标格 | 环的绘制走合成层 | 要把 `.image-box` 变成定位祖先（改掉所有卡片的 `offsetParent`）；环默认会**吃掉整张卡的点击**（必须 `pointer-events:none`）；`is-locating` 的 `:not(.cursor)` 全要重写 | **不做**：省的是本来就不贵的绘制 |
| B. 每卡常驻伪元素环 + 只切 `opacity` | 环一直在，靠 `opacity` 显隐 | 环的显隐走合成 | 每张卡多一层伪元素（5000 张就是 5000 个绘制层候选）；**仍然依赖 `cursorKey`** ⇒ 重渲染没省 | **不做** |
| C. 命令式标记 + 现有 CSS | 环的样式一字不改，只把"谁被打标"从模板搬到 JS | **重渲染直接归零** | 元素重建后要补打 | **做了这个** |

## 3. 实现（三个落点，互相独立）

1. **新模块 `src/views/FileFinder/cursorMark.ts`（~85 行）**
   `useCursorMark(root: () => HTMLElement | null)` → `{ apply, refresh, dispose }`。
   只做"打标 / 摘标"，不滚屏、不读 `fileList`。缓存"上一格"元素，目标没变时**一次 DOM 写都不做**。
2. **接线 `useGridCursor.ts`（+12 行）**
   - `watch(cursorKey, k => mark.apply(k), { flush: 'post' })` —— 所有写入点（`focusCursor` / `setCursorKey`）自动覆盖，**不新增写入入口**。
   - 原来的 `watch(fileList, invalidateLayout)` 里补一句 `nextTick(() => mark.refresh(cursorKey))`：列表换了 ⇒ 元素可能整批重建 ⇒ 补打。
   - `dispose()` 里摘标（`KeepAlive` 会留着 DOM）。
3. **模板 / CSS**
   - 模板：删 `cursorKey` 的 memo 依赖与 `cursor` 类绑定；`cursorItem` 不再被页面使用，从解构里去掉。
   - CSS 三处选择器改名：`.image-box-item.cursor` → `[data-cursor]`、
     `.image-box.is-locating .image-box-item:not(.cursor)` → `:not([data-cursor])`、
     `.image-box.is-locating .image-box-item.cursor` → `[data-cursor]`。
     （嵌套在里面的 `.card-cover` 环、`.card-title` 变色、`scale/z-index` **一行都不用改**，它们跟着外层走。）

## 4. 为什么是 `data-*` 而不是 `classList`

`class` 是 Vue 管的属性：卡片下次 patch，Vue 会用模板算出的 class **整个覆盖**，
手工加的 `cursor` 类会**静默消失**（这正是"环偶尔不见了"这类毛病的典型来历）。
`data-*` 不在 Vue 的 patch 范围里，patch 完仍在。

## 5. 边界与容易踩的点（都核过）

| 场景 | 结果 | 依据 |
|---|---|---|
| **定位闪烁**（关预览飞回来 / 双击定位） | 正常：`revealAndFlash` 先 `focusCursor`（改 `cursorKey`），mark 由 `flush:'post'` 在同一拍内落定，`is-locating` 的压暗在 paint 之前就能看到 `[data-cursor]` | Vue 的 post 队列在同一轮微任务里刷完，早于绘制 |
| 列表整批重建（换目录 / 过滤） | 补打：`fileList` watch → `nextTick` → `refresh` | 元素重建时 `data-*` 随元素消失 |
| 野 key（`onBack` 恢复的 key 不在这一屏） | 找不到元素 ⇒ 打不上 ⇒ **环自动消失**，与旧的"派生判据"行为一致 | `find()` 返回 null |
| `KeepAlive` 切页回来 | 环还在（DOM 没销毁）；真卸载时 `dispose` 摘掉 | — |
| 切密度档 | 卡片元素复用（`:key` 不变）⇒ 标记天然还在 | keyed diff |
| 命中测试 | **无变化**：`outline` 不参与；`transform` 仍是 1.012（本来就有） | — |
| 拖拽 | 网格里**没有** `draggable`/`dragstart`，不涉及 | 全仓 grep |
| 每次移动的 DOM 成本 | 一次属性选择器查询（5000 节点约 0.1–0.2ms `[推理]`）+ 一次 `setAttribute` | 未在真机 profile |

## 6. 验收

- `npm run typecheck` 0 error；构建通过。
- `grep -rn "\.cursor\b" src/views/FileFinder/styles/` 只剩注释，无类选择器；`[data-cursor]` 三处齐。
- 真机（**纯渲染层，热更新即可，但改的是网格行为 ⇒ 建议重启 dev 再验**）：
  1. 方向键单步移动 ⇒ 环跟着走；**长按**连续移动 ⇒ 环不丢、不落后
  2. 搜索过滤：光标格还在 ⇒ 环在；被过滤掉 ⇒ 环消失，且**不残留在别的卡上**
  3. 「定位」（预览里回车 / 双击定位）⇒ 整屏压暗、目标卡亮 + 环在
  4. 后退回上一屏 ⇒ 环回到原来那一格（`cursorKey` 恢复生效）
  5. 切密度档 ⇒ 环仍在同一格
  6. 关掉预览后按方向键 ⇒ 环继续正常移动（确认没有"预览层状态卡住光标"）

## 7. 正向增益的判定（业主关心的"别是逆向优化"）

- **省掉**：方向键触发的整屏 vnode 重建（N 条 × 5 次表达式求值）。
- **新增**：每次移动 1 次 `querySelector` + 1–2 次 `setAttribute`；列表变化时 1 次 `querySelector`。
- 净效果：N 越大越赚；N=50（普通目录屏）两者都在噪声内，**不会有感**。
- 后续若 profile 显示 `querySelector` 成了新热点：把 `probeLayout` 里已建好的 `elByKey`
  Map 暴露出来，`apply` 改成 O(1) 查表（当前**没做**，避免为未证实的瓶颈加耦合）。
