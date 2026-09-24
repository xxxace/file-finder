# 修复：两个「重读这一片」+「取消」点了没用

> 2026-09-24 · 起因：用户指出「点了『补全这一片』之后出现两个『重读这一片』，而且取消按钮也没用」
> 探针：`docs/probes/nspace-dup/`（可一键复算，见 `run.sh`）· 原始日志：`docs/probes/nspace-dup/out.log`

---

## 一、结论（一句话）

**根因不在我们的扫描逻辑里，而在 `n-space` 这个组件**：naive-ui 2.45.3 的 `Space`
给**每一个**子项都写死同一个 Vue key（`key: 1`）。子元素个数一变，Vue 的 keyed diff
就会让**两个旧节点认领同一个新槽位**，多出来的那个永远留在 DOM 里 ——
界面上的重复按钮、点了没反应的「取消」，都是这一件事的两种表现。

我们这边的触发条件：那条工具条上，**扫描中把两个入口「就地换成」进度 + 取消**，
于是 `n-space` 的子元素个数随 `scanning` 变化。

---

## 二、机制（逐层）

### 2.1 naive-ui 把每个子项的 key 都写成 `1`

`node_modules/naive-ui/es/space/src/Space.mjs`，render 里：

```js
}, [!wrapItem && (useGap || internalUseGap) ? (...) : (openBlock(), createElementBlock(Fragment, {
  key: 1
}, [normalizeVNode(() => children.map((child, index) =>
    child.type === Comment ? child : (openBlock(), createElementBlock("div", {
      key: 1,                    // ← 每一层子项都是 1，不是 index
      role: "none",
      ...
    }, [normalizeVNode(() => child)], 6))))], 64))], 6);
```

CJS 产物 `lib/space/src/Space.js:109` 同样是 `key: 1`。
**证据等级：静态（可 grep 复算）** —— 已装版本 2.45.3 = npmmirror 上的最新版，没有可升的版本。

### 2.2 子元素个数一变，diff 就错位

`normalizeVNode(() => array)` 生成的是一个 `patchFlag = -2`（BAIL）的 Fragment，
于是 Vue 走 `patchChildren` → **`patchKeyedChildren`**（Vue 3 的通用全量 diff）。

以工具条为例，切换前后两帧的**形状**是：

| | 扫描前 | 扫描中 |
|---|---|---|
| 子项 | `[div(补全), div(重读), 注释, 注释]` | `[注释, 注释, div(进度), div(取消)]` |

前缀比对：`div` vs `注释` → 类型不同，停。
后缀比对：`注释` vs `div` → 类型不同，停。
于是走 `keyToNewIndexMap`：两个新 `div` 的 key **都是 1**，后写的顶掉前写的 →
map 里只剩一个槽位。两个旧 `div` 依次拿 key `1` 去查 → **查到同一个新位置** →
两个旧节点被 patch 进同一个槽位，其中一个**再也没人回收** → 留在 DOM 里。

每切换一次，多留一个节点。Vue 自己的 dev 警告把这件事喊了出来：

```
[Vue warn]: Duplicate keys found during update: 1 Make sure keys are unique.
  at <Space style={ 'align-self': 'flex-end' } align="center">
```

**证据等级：实测**（探针完整复现，见 §三）。

### 2.3 为什么「取消」点了没用

两件事叠出来的：

1. **残留的「取消」按钮仍在屏幕上**。第一次取消之后 `scanning` 变回 false，真正的
   那个「取消」本该消失 —— 但残留节点不会消失。用户再点它，`onScanCancel` 只是把
   `scanCancelled` 置位，而扫描循环早退出了，于是**毫无反应**。
2. **点击到生效之间没有任何反馈**（这一条是独立的真缺陷）：取消是软取消，只在
   **目录边界**生效（刻意的：半途掐断会留下写了一半的缓存）。而冷态移动硬盘上一个
   目录要好几个 10 秒 —— 点完之后界面上一点动静都没有，谁都会得出"这按钮没用"。

---

## 三、证据

探针：`docs/probes/nspace-dup/`，用 **happy-dom + 真 naive-ui 2.45.3** 跑，
模板由 `@vue/compiler-sfc` **真编译**（改前的 markup 逐字钉在 `templates.cjs` 里，
改后的从活源码按标记切）。

### 3.1 最小复现 —— 不需要 popconfirm、不需要组件上的 v-if

```html
<n-space align="center">
    <n-button v-if="!scanning">ALPHA</n-button>
    <n-button v-if="!scanning">BETA</n-button>
    <span v-if="scanning">busy</span>
    <n-button v-if="scanning">CANCEL</n-button>
</n-space>
```

| 场景 | 30 轮来回切 | Vue「Duplicate keys」 |
|---|---|---|
| S1 `n-space`（默认 `wrap-item`） | **FAIL 59 次**，`on#0=["CANCEL","CANCEL"]` | **60 条** |
| S2 `n-space :wrap-item="false"` | **FAIL 59 次**，同样两个 CANCEL | **60 条** |
| S3 对照组：裸 `div` | **PASS** | **0 条** |
| S4 改前的真实工具条 | **FAIL 59 次** | **60 条** |

→ 和 popconfirm 无关、和「组件上挂 v-if」无关；**只要 `n-space` 的子元素个数变化就中招**。
→ `:wrap-item="false"` 修不掉（两条分支都建 keyed Fragment，换汤不换药）。

### 3.2 逐字复现用户那一屏

全新实例，只切**一次**（点「补全这一片」→ 扫完）：

```
扫完那一帧 : ["取消","补全这一片","重读这一片","重读这一片"]
```

和用户截图完全一致。累积效应：

| 切换次数 | 界面上「取消」按钮个数 |
|---|---|
| 1 | 3（应为 1） |
| 30 | 30 |

### 3.3 修后验证

用**改后的真实模板**再跑 30 轮：

```
· DOM 骨架变化        : 0 次（应 0）
· 「重读这一片」重复  : 0 次（应 0）
· 扫描中仍可点入口    : 0 次（应 0）
→ PASS 工具条完全恒定

状态条点一次「取消」：按钮文字 ["正在取消…"] / disabled [true] / onScanCancel 1 次
状态条 30 轮出现消失：异常 0 次
Vue「Duplicate keys」警告总数：0（改前 60 条）
```

**证据等级：实测。**

---

## 四、修法：为什么这不是打补丁

| | 做法 | 判据「以后新增同类场景还会不会复发」 |
|---|---|---|
| ❌ 补丁 | 给每个会变的子元素加 `key` / 给每个入口加守卫 | 下次新增一个条件渲染的按钮，照样炸 |
| ✅ 修复（本次） | 这些位置**不再用 `n-space`**，换成裸 flex 容器（`.hstack`，`gap: 12px` 与 `n-space` 默认间距一致） | 裸容器没有 key 可比，子元素按位置 patch —— 这类错位在**结构上不可能发生** |

改了 **3 处**（都是"子元素个数会变"的容器）：

| 位置 | 为什么会变 |
|---|---|
| 头部左侧组 | `openStack` 的 `v-for` 面包屑 + 「返回」的 `v-if` |
| 头部右侧组 | 原来的扫描入口 `v-if="!scanning"` / 进度+取消 `v-if="scanning"` |
| 封面条目文件列表 popover | `v-for` 的文件个数 |

**另外两处 `n-space` 没动**（`FolderSelector` 的 `v-if/v-else`、`HistoryTable` 的 4 个固定控件）——
它们的子元素个数**恒定**，没有这个缺陷。只改错的，不为整齐而改。

---

## 五、顺手修掉的交互（向 PC 文件管理器看齐）

原来那条工具条的问题不只是 bug：**扫描中把两个入口"就地换成"进度 + 取消**，
按钮消失、变形、布局跳变 —— 用户说的"有点乱和随便"是准确的。

| | 原来 | 现在（PC 文件管理器那套） |
|---|---|---|
| 扫描入口 | 扫描中**消失** | **常驻**，忙碌时只置灰（资源管理器的按钮不会消失） |
| 进度 + 取消 | 挤进工具条，顶掉两个入口 | **独立一条状态条**，在网格下方整条出现/消失 |
| 工具条子元素 | 随状态变 | **恒定**（一个字都不随状态动） |
| 取消反馈 | 点了毫无动静 | 按钮**当场**变「正在取消…」并置灰，旁边补「当前这个目录扫完就停」 |
| 防重复点 | 无 | `cancelling` 置位后按钮 disabled |

保留没动的：两个入口**平铺**（不拿下拉藏）、「重读」带确认、「刷新」不改名只加 tooltip、
扫描中禁「刷新」（它带 `noCache`，两路并发读盘正是"串行、一次一块盘"要挡的事）。

代码位置：`src/views/FileFinder/index.vue`
（模板 3 处容器 + `.scan-bar` 状态条；脚本新增 `cancelling`，`onScanCancel` 与 `startScan` 的
`finally` 各补一次复位）。

### 5.1 换掉 `n-space` 带出的**布局**回归（同日修掉，真 Chrome 实测）

`n-space` 会给每个子项包一层 `<div>`，**恰好把搜索框的 `width: 100%` 关在盒子里**。
换成裸容器之后这个 100% 直接生效 → 搜索框独霸一整行 → 「刷新」被挤到第三行：
工具条从 1 行变成 **3 行**，头部高度 **37px → 117px**。用户截图报的"太浪费空间"就是这个。

修法（两条，都是结构性的，不是调数值）：
1. `.toolbar { flex-wrap: nowrap }` —— 右侧那一组**永不再换行**，"工具条只有一行"成为结构保证；
2. 搜索框给固定宽度 `200px`（`.header-bar .n-input`，带注释钉住不能删）。

**真 Chrome 实测**（`docs/probes/nspace-dup/layout-measure.cjs`，视口 1805 / 1280 / 900 三个宽度）：

| 变体 | 头部高 | 视觉行数 | 搜索框宽 |
|---|---|---|---|
| a　最初 n-space 原样（基线） | 37px | 1 | 235px |
| b　中间态裸 `.hstack`（用户截图） | **117px** | **3** | **570px** |
| c　修后 `.toolbar` + 200px | **37px** | **1** | 200px |

三个宽度下判据全 PASS（中间态确实坏掉 / 修后回到基线高度 / 修后行数=基线）。
截图量出来的原始数字也吻合：右侧组内容盒 x1099–1794（696px），搜索框独占成 696px 宽的一行。

> ⚠️ 这一条是我上一轮**改出来的**回归 —— 结构探针（happy-dom）没有布局引擎，
> 它当时报了 PASS 也没用。**结构对 ≠ 布局对**，两者要分开验（见 §六）。

---

## 六、未验证 / 待办

**已经能无头验的**（这次补上的能力，分两层，别混）：

| 层次 | 工具 | 能证明 | 不能证明 |
|---|---|---|---|
| **结构**（渲染出几个节点） | happy-dom + 真 naive-ui（`repro/verify`） | 同一次状态切换不会渲染出重复/残留节点、工具条 DOM 骨架恒定 | 任何尺寸/位置 |
| **布局**（占多大、几行） | 真 Chrome + Playwright（`layout-*`） | 头部高度、视觉行数、元素宽度 | 颜色、间距好不好看、对齐是否舒服 |
| **观感**（好不好看） | —— | —— | **只能人眼看** |

- ✅ **布局已实测**：三个视口宽度下工具条恒为一行、头部 37px（见 §5.1）。
- ⚠️ **观感仍需用户目视**：间距、对齐、状态条位置、只读横幅、禁用态灰度的深浅。
- 未做：把 `n-space` 从 `FolderSelector` / `HistoryTable` 里也换掉（它们子元素恒定，没有这个缺陷）。
- 未做（等点头）：`ffprobe` 超时回收；`compact()` 的取舍。
- 复算：`bash docs/probes/nspace-dup/run.sh`（步骤 1–4 需 happy-dom，步骤 5 需 playwright +
  本机 Chrome；两者都不进 `package.json`）。
