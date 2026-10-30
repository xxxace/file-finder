# 网格密度三档 · 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:executing-plans`（本项目按 native 方式执行）。步骤用 `- [ ]` 勾选跟踪。

**Goal:** 给网格加一个常驻的三档密度开关（宽松 6 / 标准 8 / 紧凑 12 列），切换零读盘、记住选择。

**Architecture:** 列数只有一个真相源 `density.ts` → 绑定到 `.image-box` 的 CSS 变量 `--ff-grid-cols` → `.image-box-item` 消费。紧凑档额外覆盖一组 `--item-*` 尺寸变量（标题/角标），不动第二条选择器。窄窗保护靠 `min-width` 让 `flex-wrap` 自动少放格子，不加 JS 监听。

**Tech Stack:** Vue 3 + TS + naive-ui（`n-dropdown` / `n-button`）+ Less（scoped）。

**Spec:** `docs/DESIGN-GRID-DENSITY-2026-10-29.md`

## Global Constraints

- **本项目没有测试框架**：验证三件套 = `npm run typecheck` 0 error + `docs/probes/` 只读探针（本次不需要）+ 真机目视。**不要写 TDD 式假测试**。
- 列数写死的地方只允许一处：`--ff-grid-cols` 的消费点。别在别处再出现数字 `6`/`8`/`12` 参与布局。
- `.toolbar { flex-wrap: nowrap }`、`.header-bar .n-input { width: 260px }` 两条不许动。
- 同排格子必须等高（`gridGeometry.groupRows()` 按 `offsetTop` 分行）⇒ 标题区高度只能由档位决定。
- 切换不得触发任何请求 / 读盘。
- 单个新文件 ≤ ~250 行；纯逻辑进 `.ts`，UI 进子组件。

## Review Focus

最可能咬人的输入/条件，各任务的验收要盯住：

1. **切档后第一次按 → / ↓**：行结构缓存若没失效，会按旧列数跳格（与 2026-10-04 "第 4 行起全错"同族）。
2. **布局缓存与 `min-width` 自动降档**：档位声明 12 列、窄窗实际放 10 列时，`rows` 仍来自 DOM 实测 ⇒ 正确，但切档时仍要失效一次（档位变 = 行结构必变）。
3. **`localStorage` 里的脏值**（空串 / 旧 key / 乱写）：必须静默退回 `wide`，不能白屏。
4. **紧凑档标题与角标**：147px 宽下若 40px 标题不缩，卡片头重且两行字挤；标题高与字号必须同档位一起换。
5. **flat 模式下切档**：只应重排 DOM，不该触发 `fetchFolder` / 不再读盘。

---

### Task 1: 档位表与持久化

**Files:**
- Create: `src/views/FileFinder/density.ts`
- Modify: `src/styles/tokens.css`（`:root` 里 `--ff-grid-gap: 16px` 附近加一行）

**Interfaces:**
- Produces:
  - `type Density = 'wide' | 'normal' | 'tight'`
  - `interface DensityOption { key: Density; label: string; cols: number }`
  - `const DENSITY_OPTIONS: DensityOption[]`（顺序 `wide → normal → tight`，**这个顺序就是 UI 顺序**）
  - `const DEFAULT_DENSITY: Density`（`'wide'`）
  - `function colsOf(d: Density): number`
  - `function loadDensity(): Density`
  - `function saveDensity(d: Density): void`

- [ ] **Step 1: 新建 `density.ts`**

档位表（字面量必须与设计稿一致）：

| key | label | cols |
|---|---|---|
| `wide` | 宽松 | 6 |
| `normal` | 标准 | 8 |
| `tight` | 紧凑 | 12 |

`loadDensity()`：读 `localStorage['ff.grid.density']`，**白名单校验**（`DENSITY_OPTIONS.some(o => o.key === v)`），非法/缺失/读抛异常一律返回 `DEFAULT_DENSITY`。`saveDensity()` 用 `try { } catch { }` 吞掉隐私模式写失败（不允许因为存不下就崩）。

- [ ] **Step 2: `tokens.css` 加最小格宽 token**

`:root` 内加 `--ff-grid-min-cell: 110px;`，注释一行：窄窗下让 flex 自动少放格子（配合 `.image-box-item` 的 `min-width`）。

- [ ] **Step 3: 验证**

Run: `npm run typecheck`
Expected: 0 error。

- [ ] **Step 4: 提交**

```bash
git add src/views/FileFinder/density.ts src/styles/tokens.css
git commit -m "feat(grid): 密度档位表与持久化"
```

---

### Task 2: 密度切换控件

**Files:**
- Create: `src/views/FileFinder/GridDensityMenu.vue`

**Interfaces:**
- Consumes: `DENSITY_OPTIONS` / `colsOf` / `Density`（Task 1）
- Produces: 组件，props `{ modelValue: Density; menuProps?: Record<string, string> }`，emit `update:modelValue(d: Density)`

- [ ] **Step 1: 写组件**

结构：`n-dropdown` 包一颗 `n-button size="small"`（图标 = 九宫格内联 SVG，14×14；再加 `ChevronDownOutline` 小箭头），`trigger="click"`，`menu-props` 走 props 传入（**样式只留一份在 `index.vue` 的 `moreMenuProps`**，不要在这里复制那份 CSS 变量字符串）。

`options` = `DENSITY_OPTIONS.map(o => ({ label: \`${o.label} · ${o.cols} 列\`, key: o.key, icon: o.key === modelValue ? renderIcon(CheckmarkOutline) : undefined }))`。

`onSelect(key)` ⇒ `emit('update:modelValue', key as Density)`。**不做本地状态**（受控）。

- [ ] **Step 2: 加 tooltip**

按钮外包 `n-tooltip`，文案：`视图密度（当前：${当前档 label}）`。

- [ ] **Step 3: 验证**

Run: `npm run typecheck`
Expected: 0 error。

- [ ] **Step 4: 提交**

```bash
git add src/views/FileFinder/GridDensityMenu.vue
git commit -m "feat(grid): 密度切换下拉控件"
```

---

### Task 3: 选择器跟着列数失效

**Files:**
- Modify: `src/views/FileFinder/useGridCursor.ts`（deps 类型约 54-106 行；`watch` 区域约 504-505 行）

**Interfaces:**
- Consumes: 无（只收一个 number 的 computed）
- Produces: `deps.cols?: ComputedRefLike<number>`（可选，不传则行为与今天完全一致）

- [ ] **Step 1: deps 增加 `cols`**

类型注释写清理由：**列数变 ⇒ 每行装几个变 ⇒ 行结构变**，而 `layoutCache` 只在 `fileList` 与 `window resize` 时失效，切档两个都不触发 ⇒ 不订阅就会按旧列数跳格。

- [ ] **Step 2: 订阅**

在已有 `watch(() => fileList.value, invalidateLayout)` 旁边加：`if (cols) watch(cols, invalidateLayout);`

⚠️ **不要**在 `index.vue` 的切换回调里手动调失效 —— 新增第二个切档入口就会忘。

- [ ] **Step 3: 验证**

Run: `npm run typecheck`
Expected: 0 error（`cols` 可选，现有调用点不传也通过）。

- [ ] **Step 4: 提交**

```bash
git add src/views/FileFinder/useGridCursor.ts
git commit -m "fix(grid): 列数变化时作废行结构缓存"
```

---

### Task 4: 主界面接线 + 尺寸变量

**Files:**
- Modify: `src/views/FileFinder/index.vue`
  - 模板：工具栏（82-135 行区间，flat 按钮左侧）、`.image-box` 节点（148 行）
  - 脚本：import 区、`useGridCursor` 调用（2198 行）
  - 样式：`.image-box`（2974-3002）、`.image-box-item`（3062-3076）、`.card-title`（3184-3196）、`.badge`（3166-3178）

**Interfaces:**
- Consumes: `density.ts`（Task 1）、`GridDensityMenu.vue`（Task 2）、`useGridCursor.cols`（Task 3）

- [ ] **Step 1: 状态与派生**

`const density = ref<Density>(loadDensity())`、`const gridCols = computed(() => colsOf(density.value))`、`watch(density, saveDensity)`。
`useGridCursor({ ...现有, cols: gridCols })`。

- [ ] **Step 2: 模板挂控件与变量**

工具栏 flat 按钮**左侧**：`<GridDensityMenu v-model="density" :menu-props="moreMenuProps()" />`。
`.image-box` 加 `:data-density="density"` 与 `:style="{ '--ff-grid-cols': gridCols }"`。

- [ ] **Step 3: 列宽改由变量驱动**

`.image-box-item` 里 `--item-width: calc(100% / 6)` → `calc(100% / var(--ff-grid-cols, 6))`；并加 `min-width: var(--ff-grid-min-cell);`（`width` 是首选值、`min-width` 是硬下限 ⇒ 窄窗自动降档）。

- [ ] **Step 4: 尺寸变量化（只有紧凑档覆盖）**

`.image-box` 上定义：`--item-title-h: 40px; --item-title-fs: 14px; --item-title-lh: 20px; --item-badge-h: 18px; --item-badge-fs: 12px; --item-pad-b: 6px;`
`.image-box[data-density='tight']` 覆盖为 `34px / 12px / 17px / 16px / 11px / 4px`。
`.image-box-item` 的 `padding-bottom`、`.card-title` 的 `height/font-size/line-height`、`.badge` 的 `height/line-height/font-size` 全部改成读这些变量。

⚠️ `.image-box-item` 里的 `height: 40px` 若还有别处残留，一并换掉 —— 数字只允许活在变量里。

- [ ] **Step 5: 验证**

Run: `npm run typecheck` → 0 error。
Then 真机目视（30 秒，别搭无头探针）：
1. 三档列数对（6 / 8 / 12），右侧贴边不空一截。
2. 切到紧凑档：标题两行不被切、角标不溢出、同排等高。
3. 每档切完**立刻按 → 和 ↓**：焦点按当前列数走，不跳错格。
4. 重启 app 档位保持。
5. 窗口拉到 1024 宽 + 紧凑档：自动少放几列（约 8），不出 85px 小格。
6. flat 模式下切档：无 spinner、无请求（控制台无 `/api` 记录）。

- [ ] **Step 6: 提交**

```bash
git add src/views/FileFinder/index.vue
git commit -m "feat(grid): 网格密度三档开关"
```

---

## 完成后

- 记录：本设计稿 + 本计划就是这一期的变更记录（项目近期的 `CHANGES-*` 已停更，改为按主题落 `DESIGN-*`/`FIX-*`）。
- 记忆备忘：`MEMORY.md` 的「当前状态」加一行（设计稿与计划路径）。
- 告诉主人：**重启 dev**，然后按 Task 4 Step 5 的 6 条目视。
