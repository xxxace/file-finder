# FileFinder Agent 协作规范与架构路标

## 1. 样式与视觉规范（唯一真相源）
- **唯一准则**：UI 样式、色彩、圆角、阴影看且只看 `src/styles/tokens.css`。
- **色彩纪律**：业务 `.vue` / `.ts` 严禁出现 `#hex` 或 `rgba(...)` 字面量，一律使用 `var(--ff-*)`。
- **高亮唯一性**：彩色高亮仅限 `var(--ff-highlight)` / `var(--ff-highlight-weak)` / `var(--ff-highlight-line)`（用于选中、悬浮、输入框焦点三处），其余均为中性灰。

## 2. 搜索与排查范围（防发散纪律）
- **代码检索必须指定路径**：使用 `git grep -n ... src/ electron/`，**严禁无路径全局 grep**。
- **文档性质声明**：`docs/` 下的 100+ 篇文档为历史演进与技术依据归档。代码实现以当前 `src/` 与 `electron/` 源码为准，**日常排查严禁主动通读 `docs/` 历史文档**。

## 3. 任务分级与最小切口原则
- **局部组件微调（事件/交互/文案/局部修复）**：
  - 严格就近在目标单文件（SFC）内部闭环，严禁跨模块发散。
  - **重要边界注意**：`src/views/FileFinder/HomeDisks.vue`（首页盘卡片）拥有独立的 scoped 样式，**完全不受 `grid.less` 控制**，修改首页盘卡片严禁调研 `grid.less`。
- **编辑效率**：
  - 单组件修改应通盘理解后在 1~2 次内完成模板、脚本与样式的整合交付，杜绝碎片化试探。

## 4. 验证基准
- 修改代码后，必须通过 `npm run typecheck`（`vue-tsc --noEmit && tsc -p tsconfig.electron.json`）。
