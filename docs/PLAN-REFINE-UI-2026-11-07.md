# 界面改造 v2 · 实施计划（B 档 · 完全无彩）

> **For agentic workers:** 按任务顺序执行，每个任务结束必须过 typecheck；视觉改动需主人 30 秒目视。
> 设计事实来源：`docs/DESIGN-REFINE-2026-11-07.md`（简称 SPEC），本计划只记**决策**，不复述理由。

**Goal:** 把五个界面统一到一套无彩、三层灰、四档字阶的设计语言上，并把所有值收敛进 token 层。

**Architecture:** L1 原始值 → L2 语义 → L3 落地（`naive-theme.ts` 映射 + `ui.css` 语义类）。业务 `.vue` 不许出现色值字面量。
naive-ui 无法接收 `var()`，故 `naive-theme.ts` 用 `getComputedStyle` 读 L2 变量并包成 `computed`，随 `isDark` 重算。

**Tech Stack:** Vue 3 + naive-ui 2.45.3 + `@vicons/ionicons5`；无测试框架 ⇒ 验证 = typecheck + 只读探针 + 真机目视。

**Spec:** `docs/DESIGN-REFINE-2026-11-07.md`

## Global Constraints

- **不改** `electron/`、`density.ts`、`gridGeometry.ts`、`useGridCursor.ts`、`usePreview.ts`、`openDecision.ts`。**零读盘**。
- **特性神圣**：双击打开、S/F5/D 快捷键、面包屑折叠与点击、计数角标位置（10-02 裁决）、密度三档（10-29）。
- 字重只用 **400 / 500**；圆角只用 **3 档**（10 / 8 / 999）；文字色只用 **2 档**。
- naive 的默认按钮去边框写 `1px solid transparent`，**不许写 `none`**（会少 2px、hover 跳动）。
- 不新增依赖。
- 旧 token 名（`--ff-bg` `--ff-pink` `--ff-text-3` …）**先保留为别名**，逐屏替换完再在 Task 8 删除。

## Review Focus

1. **盘不在 / 读不到 / 空目录**三种状态在无彩后是否仍能一眼区分（对应 `n-alert` 与空状态文案）。
2. **面包屑折叠态**（`crumbFold`）在 tag 透明化后，`›` 分隔符是否与折叠的 `…` 打架、点击区域是否仍覆盖整段。
3. **深色三档灰**：panel 贴 canvas、hover 贴 panel、弹层贴遮罩，三处是否糊成一片。
4. **浅色主题**：`--ff-accent` 在浅色下是近黑，主按钮黑底白字——是否被误认为禁用。
5. **密度三档切换后**网格列数与行结构缓存是否仍失效（改样式不该碰它，但要回归）。

---

### Task 1: token 层重建（L1 + L2）

**Files:**
- Modify: `src/styles/tokens.css`（整文件重写）

**Interfaces:**
- Produces: L2 变量 `--ff-canvas --ff-panel --ff-raised --ff-raised-hover --ff-line --ff-line-strong --ff-text-1 --ff-text-2 --ff-accent --ff-on-accent --ff-danger --ff-warn --ff-ok`；尺度 `--ff-r-card(10) --ff-r-ctl(8) --ff-r-pill(6)`、`--ff-fs-title(15) --ff-fs-body(13) --ff-fs-meta(12) --ff-fs-eyebrow(11)`、`--ff-h-nav(48) --ff-h-list(34) --ff-h-table(36) --ff-h-head(32) --ff-h-ctl(28)`、`--ff-sp-1..6(4/8/12/16/24)`。
- 旧名保留为别名：`--ff-bg→canvas`、`--ff-surface→panel`、`--ff-fill→raised`、`--ff-text-3→text-2`、`--ff-text-muted→text-2`、`--ff-pink/--ff-blue→accent`。

- [ ] 深色：canvas `#0e0e0e`、panel `#1f1f1f`、raised `#242424`、raised-hover `#2a2a2a`、text-1 `#ededed`、text-2 `#8f8f8f`、line `rgba(255,255,255,.08)`、line-strong `.14`
- [ ] 浅色：canvas `#f7f7f8`、panel `#ffffff`、raised `#f0f0f1`、raised-hover `#e8e8ea`、text-1 `#1a1a1a`、text-2 `#5c5c5c`、line `rgba(0,0,0,.08)`
- [ ] `--ff-accent: var(--ff-text-1)`，`--ff-on-accent: var(--ff-canvas)`（无彩＝反色；换品牌色只改这两行）
- [ ] `--ff-tip-*` 按新灰阶重算（深色保留磨砂 + 内描边，浅色保留轻投影）
- [ ] 保留 `--ff-rail-w` `--ff-cover-ratio` `--ff-grid-gap` 原值
- [ ] 跑 `npm run typecheck`

**Verify:** 应用启动后整体变中性（粉蓝全消失）；主人目视「没有粉色残留」。

### Task 2: naive 主题映射改为读 token（**步骤 0 验真，架构成败在此**）

**Files:**
- Modify: `src/styles/naive-theme.ts`、`src/App.vue:2`

**Interfaces:**
- Produces: `useNaiveOverrides(): ComputedRef<GlobalThemeOverrides>`，内部 `readVar(name, fallback)`。

- [ ] `readVar`：`getComputedStyle(document.documentElement).getPropertyValue(name).trim()`
- [ ] `overrides = computed(() => { void isDark.value; return build() })` —— `void isDark.value` 只是声明依赖，不是逻辑
- [ ] 映射：`primaryColor = accent`、`borderRadius = 8`、`borderRadiusSmall = 8`、`fontWeightStrong = '500'`、`bodyColor/modalColor/cardColor/popoverColor` 取 panel/raised
- [ ] `App.vue` 把 `:theme-overrides="isDark ? darkOverrides : lightOverrides"` 改成 `:theme-overrides="overrides"`
- [ ] 跑 `npm run typecheck`

**Verify（主人 30 秒）：** ①主按钮是白底黑字（不是蓝） ②「更多」下拉悬停项是淡白不是蓝灰 ③任意勾选框勾上是白的。
**这一步不过 ⇒ 立刻停，改回「TS 里写一份 hex」的退路**（牺牲单一真相源，换正确性）。

### Task 3: `ui.css` 语义类

**Files:**
- Create: `src/styles/ui.css`；Modify `src/main.ts`（import）

- [ ] `.ff-icon-btn`（28×28 / R8 / 透明 / hover `--ff-raised-hover` / 图标继承 `--ff-text-2`）
- [ ] `.ff-text-btn`、`.ff-primary-btn`、`.ff-field`
- [ ] `.ff-eyebrow`（11 / 500 / `.08em` / text-2）
- [ ] `.ff-metric`（label + value 两行）

**Verify:** typecheck 0；类名在 Task 4-7 里被引用。

### Task 4: 护栏探针（现在建，现在就能挡）

**Files:**
- Create: `docs/probes/tokens/no-raw-color.mjs`

- [ ] 扫 `src/**/*.vue`、`src/**/*.ts`，排除 `src/styles/tokens.css`
- [ ] 命中规则：`#` 后跟 3/6 位十六进制、`rgba?(`；输出「文件:行 内容」+ 总数
- [ ] 总数 > 基线（首次跑的值）即 exit 1；Task 8 把基线改成 0

**Verify:** `node docs/probes/tokens/no-raw-color.mjs` 打印基线数并列出命中位置（预期 12 处色值 + 若干 rgba）。

### Task 5: 网格页头部（工具条 + 面包屑 + 图标）

**Files:** Modify `src/views/FileFinder/index.vue`（`:341` import、`.header-bar`/`.toolbar`/`.crumb` 样式块）、`GridDensityMenu.vue`

- [ ] `Search→SearchOutline`、`Refresh→RefreshOutline`
- [ ] 面包屑：`--n-color: transparent`、`--n-border: 0 0 0`、`padding: 0 2px`；当前段 `bold→500`；角标 `#d03050→--ff-raised` + `--ff-text-1`
- [ ] 返回/更多 → `.ff-icon-btn`；搜索 `#303033→--ff-raised`；密度 → `.ff-text-btn`
- [ ] 所有控件高 28、圆角 8、垂直居中

**Verify:** 主人目视工具条「一行齐平、只有三种形态」；面包屑折叠仍可点。

### Task 6: 网格卡片
`index.vue` 的 `.image-box-item` / 标题 / 角标 / `cursor` 环 —— R8、标题 13/500、选中 2px `--ff-accent` 内环、hover 只提亮描边。

### Task 7: 缓存页
`Cache/index.vue` —— 统计行改 4 个 `.ff-metric`；表格头 32 / 行 36 / 数字右对齐 tabular-nums；排序箭头 hover 才现；盘标签去绿改无彩 pill；底栏左右分段。

### Task 8: 设置页 + 左轨 + 收尾
`Settings/index.vue`（label 在上、站点行 34、去掉选中竖线）、`Shell/RailNav.vue`（图标 20、激活 `--ff-raised`）、
删除全部旧 token 别名、**探针基线改 0**、`docs/DESIGN-REFINE` 标注"已实施"。
