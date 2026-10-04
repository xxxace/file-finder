# grid-cursor-intent · 「顺序即依赖」与「换屏判据」

```bash
node docs/probes/grid-cursor-intent/run.mjs
```

跑的是**真 Vue**（`@vue/reactivity`），不是复刻的判据。

## 为什么这个探针是独立的一个

前两轮这个 bug 连修两次没好，根因是**我在探针里手抄了一份判据** ——
改探针不改真代码，回退真源码时探针依然全绿（与同一天 `isGridKeyBlocked` 那次同一个错）。

## 那个 bug 的精确机制

`enterScreen` 原本的顺序：

```
history.push(...) → noteIntent() → searchText.value = '' → fetchFolder()
```

而 `fileList = computed(() => filterByName(dataSource.value, searchText.value))`
⇒ **清空搜索词本身就会让列表变一次** ⇒ 指纹变 ⇒ watch 触发
⇒ `takeIntent()` 把 `armed` **提前消费掉**
⇒ 等 fetchFolder 成功、`dataSource` 真正换新时 `armed` 已是 false ⇒ **焦点永不落**。

而"点一下"能用，是因为 `onItemClick → focusCursor` **直写 `cursorKey`**，不经过 watch。

⇒ 修法只有一句：**`noteIntent()` 必须放在所有"会引起列表变化"的动作之后。**
⇒ **顺序即依赖**：这不是风格问题，是这条链上唯一的时序约束。

## 用例

场景 1（意图在清搜索词之前，= 真 bug）· 场景 2（修好后）· 场景 3（无搜索词时两种顺序）
· 场景 4（连续两次 enterScreen）· 场景 5（同屏刷新不抢焦点）
