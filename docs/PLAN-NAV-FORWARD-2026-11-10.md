# 双向导航（后退 / 前进）实施计划

> **For agentic workers:** 本仓**没有测试框架**（`package.json` 只有 dev / typecheck / build），
> 所以"测试"一律指 **`docs/probes/` 里的只读探针 + `npm run typecheck` + 真机目视**三件套。
> 不要新写 vitest / jest，那会被业主当"假测试"退回。
> 步骤用 `- [ ]` 勾选跟踪。

**Goal:** 把 `history` 从"进一屏压一屏、返回就 pop 掉"的栈，改成**数组 + 游标**，从而支持后退 / 前进两个方向，并把恢复逻辑收成一份。

**Architecture:** 新文件 `useNavStack.ts` 持有 `entries[] + index` 与"离开时快照"，对外只暴露 `current / canBack / canForward / push / step / replaceCurrent / reset`。页面侧所有导航入口（进入 / 后退 / 前进 / 换盘替换 / 清根）都只调这个方法表；`onBack` 里那 70 行恢复逻辑抽成 `restoreScrollOf()` 一份，两个方向共用。

**Tech Stack:** Vue 3 `<script setup>` + TypeScript（strict）+ naive-ui + esbuild（探针编译，仓里已有此用法）。

**Spec:** `docs/DESIGN-NAV-FORWARD-2026-11-10.md`（决策与理由都在那份，本计划只写"怎么落地"）。

## Global Constraints

- **零读盘**：本批只动渲染层（导航状态 + 顶栏 + 键盘）。任何步骤都不许新增 `/openFolder` 之外的服务端调用。
- `npm run typecheck` 必须 **0 error**（含 `tsc -p tsconfig.electron.json`）。
- 改完 `grep -n "history\.value" src/views/FileFinder/index.vue` 必须 **0 命中**。
- 单文件 ≤ ~250 行；新写注释**只留判据 / 陷阱**（1–3 行），推理过程删。
- **特性神圣**：`S` / `D` / `F5` / `Backspace` 行为不变；`[▤]` 起点、`[↻]` 刷新、`[⌕]` 搜索、密度、平铺、`⋯` 位置全不动。
- 两颗导航按钮**常驻、不 `v-if`**（11-08 纪律：按钮出现/消失会把面包屑推走 ~60px）。
- `CloseOutline` 用不到了就**连 import 一起删**（不留死引用）。
- 中文文案跟既有风格：tooltip 说人话 + 括号里带键名。

## Review Focus

执行时最可能咬人的五处（前两处探针覆盖，后三处只能目视 —— 在 Task 4 逐条走）：

1. **连点越界**：后退连按到底再按一次，必须**什么都不做**（不是把 `index` 压到 -1 后读到别的屏）。
2. **截断时机**：后退两屏后进新目录，前进键必须立刻变灰（尾巴被砍），且 `entries` 里不许留孤儿。
3. **`notFound` / 离线盘**：前进到已被删除或已拔盘的目录，必须走既有失败路径（横幅 + toast + 空列表），不许停在上一屏内容上无提示。
4. **清单屏交叉**（path 是 `@pl:<id>`）：目录 → 清单 → 后退 → 前进回来，面包屑必须是「收藏 › 名称」两段，网格必须是清单内容。
5. **拔盘换锚点**（`swapTop` → `nav.replaceCurrent`）：替换后 `index` 不许失步（前进/后退仍按原顺序走）。

---

### Task 1: `useNavStack.ts` + 纯逻辑探针

**Files:**
- Create: `src/views/FileFinder/useNavStack.ts`
- Create: `docs/probes/nav-stack/model.mjs`
- Create (证据): `docs/probes/nav-stack/out.txt`

**Interfaces:**
- Consumes: `vue` 的 `ref` / `computed`；`OpenMode` 类型从 `electron/server/nedb`（**type-only** import，运行期擦除 ⇒ 探针不需要 alias）。
- Produces（Task 2 依赖，签名逐字照用）:
  ```ts
  export interface NavEntry { path: string; mode: OpenMode; searchText: string; scrollY: number; cursorKey: string; pl?: { id: string; name: string } }
  export type NavSnapshot = Pick<NavEntry, 'scrollY' | 'searchText' | 'cursorKey'>;
  export function useNavStack(deps: { snapshot: () => NavSnapshot }): {
      current: ComputedRef<NavEntry | undefined>;
      hasAny: ComputedRef<boolean>;
      canBack: ComputedRef<boolean>;
      canForward: ComputedRef<boolean>;
      push: (entry: NavEntry) => NavEntry;
      step: (delta: 1 | -1) => NavEntry | undefined;
      replaceCurrent: (patch: Partial<NavEntry>) => void;
      reset: () => void;
  }
  ```

- [ ] **Step 1: 写探针（先失败）**

`docs/probes/nav-stack/model.mjs` —— 照抄 `docs/probes/crumbs/layout.mjs` 的 esbuild 加载法，
但要多一行 `external: ['vue']`（`vue` 的 ESM 在 Node 里可直接跑响应式，已实测可用）。
断言用 `node:assert/strict`，每条 `assert` 前先 `console.log` 一条人能读的标题（本项目探针惯例），
最后把全量输出 `writeFileSync` 到同目录 `out.txt`。

探针内容（断言即契约）：

```js
const E = (path) => ({ path, mode: 'cover', searchText: '', scrollY: 0, cursorKey: '' });
const snap = { scrollY: 10, searchText: 's', cursorKey: 'k' };
const nav = useNavStack({ snapshot: () => snap });

assert.equal(nav.current.value, undefined);          // 空栈
assert.equal(nav.hasAny.value, false);
assert.equal(nav.canBack.value, false);
assert.equal(nav.canForward.value, false);

nav.push(E('A')); nav.push(E('B')); nav.push(E('C'));
assert.equal(nav.current.value.path, 'C');
assert.equal(nav.canBack.value, true);
assert.equal(nav.canForward.value, false);

assert.equal(nav.step(-1).path, 'B');                // 后退
assert.equal(nav.step(-1).path, 'A');
assert.equal(nav.step(-1), undefined);               // 越界：不入栈、不改 index
assert.equal(nav.current.value.path, 'A');

assert.equal(nav.step(1).path, 'B');                 // 前进
assert.equal(nav.step(1).path, 'C');
assert.equal(nav.step(1), undefined);                // 尾巴尽头

nav.step(-1);                                        // 回到 B（离开 C 时拍了快照）
assert.equal(nav.current.value.path, 'B');
nav.step(-1);                                        // 回到 A
nav.push(E('X'));                                    // 在 A 处进新屏 ⇒ 截断 B/C
assert.equal(nav.current.value.path, 'X');
assert.equal(nav.canForward.value, false);
assert.equal(nav.step(1), undefined);                // 尾巴真的没了
assert.equal(nav.step(-1).path, 'A');                // 但 A 还在

nav.replaceCurrent({ path: 'A2' });                  // 换盘降级：替换不新增
assert.equal(nav.current.value.path, 'A2');
assert.equal(nav.canBack.value, false);

nav.reset();
assert.equal(nav.hasAny.value, false);
assert.equal(nav.current.value, undefined);
```

另加两条**快照写入点**断言（这是本次重构的核心不变量，别省）：

```js
// 离开哪一屏，快照就写在哪一屏身上（不是写在"要去的"那一屏）
nav2.push(E('P')); nav2.push(E('Q'));
nav2.step(-1);                                       // 离开 Q
assert.equal(nav2.current.value.path, 'P');
assert.equal(nav2.canForward.value, true);
nav2.step(1);                                        // 回到 Q
assert.equal(nav2.current.value.scrollY, 10);        // Q 记的是离开它那一刻的值
assert.equal(nav2.current.value.cursorKey, 'k');
```

- [ ] **Step 2: 跑探针确认它失败**

Run: `node docs/probes/nav-stack/model.mjs`
Expected: FAIL（`Cannot find module .../useNavStack.ts` —— 文件还不存在）

- [ ] **Step 3: 写 `src/views/FileFinder/useNavStack.ts`**

文件头注释只留三条判据：①为什么不是双栈（09-30 的隐式不变量）；②`snapshot` 为什么是函数（TDZ + 只有页面拿得到 DOM）；
③`index = -1` 与空数组一一对应（= 还没选文件夹）。`NavEntry` 的那几段老注释（`cursorKey` / `pl` / `mode`）**整段搬过来，不许压缩**。

实现要点（body 由实现者写，几条判据不能变）：

```ts
const entries = ref<NavEntry[]>([]);
const index = ref(-1);
const current = computed(() => entries.value.at(index.value));   // .at() 天然带 undefined，别用 [i]
const hasAny = computed(() => entries.value.length > 0);
const canBack = computed(() => index.value > 0);
const canForward = computed(() => index.value < entries.value.length - 1);

const snapshotCurrent = () => { const cur = current.value; if (cur) Object.assign(cur, deps.snapshot()); };

const push = (entry: NavEntry) => {
    snapshotCurrent();                                     // 先记旧屏，再动数组
    if (index.value < entries.value.length - 1) entries.value.splice(index.value + 1);  // 砍前进尾巴
    entries.value.push(entry);
    index.value = entries.value.length - 1;
    return entry;
};

const step = (delta: 1 | -1) => {
    const next = index.value + delta;
    if (next < 0 || next >= entries.value.length) return undefined;   // 越界：什么都不做
    snapshotCurrent();                                     // ★ 后退与前进共用这一处
    index.value = next;
    return entries.value[next];
};

const replaceCurrent = (patch: Partial<NavEntry>) => { const cur = current.value; if (cur) Object.assign(cur, patch); };
const reset = () => { entries.value = []; index.value = -1; };
```

- [ ] **Step 4: 跑探针确认全绿**

Run: `node docs/probes/nav-stack/model.mjs`
Expected: 全部 `assert` 通过，末行打印 `PASS`；`out.txt` 里能看到每个断言的标题。

- [ ] **Step 5: Commit**

```bash
git add src/views/FileFinder/useNavStack.ts docs/probes/nav-stack
git commit -m "feat(nav): useNavStack —— 数组+游标的导航模型（含探针）"
```

---

### Task 2: 页面换装 + 顶栏两颗按钮 + 清空进 ⋯

> ⚠️ 这一整个 task **必须一个 commit**：中间态既没有"清空"入口、也编译不过（同一文件内换装，
> 无法拆成可独立编译的步骤）。所以 Steps 1–7 是连续编辑，**Step 8 的 typecheck 才是门**。

**Files:**
- Modify: `src/views/FileFinder/index.vue`（模板 26 行附近 + 24–43 行按钮组 + 678–697 + 816 + 845 + 960 + 977 + 988 + 1083–1089 + 1096–1154 + 1295–1365 + 1410 + 1420–1421 + 1433–1468 + 1477–1497 + 1573 + 1582 + 1967–1981）
- Modify: `src/views/FileFinder/index.vue:492`（图标 import）

**Interfaces:**
- Consumes: Task 1 的 `useNavStack` / `NavEntry`（`NavEntry` 从此**只从 `useNavStack.ts` 导入**，页面不再自己定义）。
- Produces: `goStep(delta: 1 | -1): Promise<void>`、`restoreScrollOf(to: NavEntry, seq: number): Promise<void>`、`onBack()`、`onForward()`（Task 3 的键盘要用后两个）。

- [ ] **Step 1: 接线 composable，替掉 `history` 声明与三个派生**

- 删 `index.vue:678` 的 `const history = ref<NavEntry[]>([])` 及其上注释；`NavEntry` 的 interface 定义（529–557）整段**搬进** `useNavStack.ts`，页面改成 `import type { NavEntry } from './useNavStack'`。
- 原位置写：
  ```ts
  const nav = useNavStack({
      snapshot: () => ({
          scrollY: imageBox.value?.scrollTop ?? 0,
          searchText: searchText.value,
          cursorKey: cursorKey.value,       // 声明在 1710，闭包捕获 ⇒ 调用时才求值，不 TDZ
      }),
  });
  ```
- `currentPath`（683）→ `nav.current.value?.path ?? ''`；`crumbs`（685–696）里的 `top` → `nav.current.value`；`playlistLevel`（845）→ `!!nav.current.value?.pl`。
- **模板要用到的三个 computed 必须再解构一次**（紧跟 `nav` 声明之后）：
  ```ts
  // ⚠️ `nav` 是普通对象，模板**不会**自动解包它的 `.value`：
  //    `:disabled="!nav.canBack"` 里 `!ComputedRef` 恒为 false ⇒ 两颗按钮永远置灰。
  //    所以模板只读这三个顶层名（顶层 ref 才会被 <script setup> 展开）。
  const { current: navCurrent, canBack, canForward, hasAny } = nav;
  ```
  脚本里继续用 `nav.step()` / `nav.push()` / `nav.replaceCurrent()` / `nav.reset()`（成员方法）。
  `navCurrent` 只在脚本里用（模板里已由 `currentPath` / `crumbs` 派生），别在模板里写 `navCurrent.path`。

- [ ] **Step 2: 其余 8 处读栈顶 + 1 处替换**

960 `reloadCurrentScreen`、977 `currentPlaylistId`、988 `refreshAfterApply`、1134 `enterScreen` 的取数目标、
1410 `toggleFlatView`、1421 `onRefresh`、1967 `topPl`、1974 `top` —— 一律 `nav.current.value`（`enterScreen` 里是 `nav.current.value!`，因为刚 `push` 过）。
1979 的 `swapTop`：`history.value.splice(...)` → `nav.replaceCurrent({ path })`（**替换**语义不变）。

- [ ] **Step 3: 长度判据 5 处 + 复位 2 处**

`!history.length`（模板 26、816、1420、1573、1582）→ `!hasAny`（模板里写 `!hasAny`，脚本里写 `!hasAny.value`）；
模板 26 那颗按钮的禁用判据改成 `:disabled="!canBack"`。
`history.value = []`（1438、1462）→ `nav.reset()`。

- [ ] **Step 4: 删 `rememberCurrentScreen`，前进/后退共用一个移动入口**

- 删 1083–1089 整个 `rememberCurrentScreen`（快照已搬进 `useNavStack.push/step`）。
- `enterScreen`（1096–1154）：首两行 `rememberCurrentScreen(); history.value.push({...})` → `nav.push({ path, mode, pl, searchText: '', scrollY: 0, cursorKey: '' });`，其余（`isFlatView` / `noteIntent` / `scrollTo(0,0)` / `loadScreen(nav.current.value!, {...})` / `myFetchSeq` / `nextTick` 二次归零）**一字不改**。那条"不许在这里写 `searchText`"的注释整段留着 —— 它保护的是 `useScreenData.commit()`。
- 把 `onBack`（1295–1365）拆成两半：
  - `restoreScrollOf(to: NavEntry, myFetchSeq: number)`：**原样搬** 1333–1364（含 `if (!box) return`、过期请求双查、`waitForGridOf`、clamp 回读），注释整段带走（`waitForGridOf` 和 `myFetchSeq` 那两段是踩坑记录）。
  - `goStep`：
    ```ts
    const goStep = async (delta: 1 | -1) => {
        const to = nav.step(delta);
        if (!to) return;                       // 越界：两个方向都静默
        noteIntent();                          // 顺序即依赖，见原 onBack 注释
        setCursorKey(to.cursorKey);
        const done = loadScreen(to, { adoptSearch: true });
        const myFetchSeq = getFetchSeq();
        await done;
        await restoreScrollOf(to, myFetchSeq);
    };
    const onBack = () => goStep(-1);
    const onForward = () => goStep(1);
    ```
- 删掉 `navBtnText` / `navBtnIcon` / `navBtnTip` / `onNavBtn`（1477–1497 那一整块，含注释），换成两颗按钮各自的常量 tooltip。

- [ ] **Step 5: 模板 —— 一颗变两颗**

`index.vue:24-43` 的按钮组改成：

```html
<n-button size="small" :disabled="!canBack" aria-label="返回上一屏"
    v-tip="canBack ? '返回上一屏（Backspace）' : '没有上一屏了'" @click="onBack">
    <template #icon><n-icon :component="ArrowBackOutline" /></template>
</n-button>
<n-button size="small" :disabled="!canForward" aria-label="前进到下一屏"
    v-tip="canForward ? '前进到下一屏（Alt+→）' : '没有下一屏'" @click="onForward">
    <template #icon><n-icon :component="ArrowForwardOutline" /></template>
</n-button>
```

左组顺序 `[▤][←][→][↻]`；`@vicons/ionicons5` 的 import（492 行）删 `CloseOutline`、加 `ArrowForwardOutline`。

- [ ] **Step 6: 「清空导航历史」进 ⋯ 菜单**

- **不动** `DIR_ACTIONS`（那份与右键菜单共用，清空是**导航动作**不是目录工具动作）。
- `moreOptions`（1600–1604）追加一条：
  ```ts
  const moreOptions = computed(() => [
      ...DIR_ACTIONS.map((a) => ({ label: a.label(), key: a.key, disabled: a.disabled() })),
      { label: '清空导航历史', key: 'clearNav', disabled: !hasAny.value },
  ]);
  ```
- `onMoreSelect` 加一支：`if (key === 'clearNav') { closeCtxMenu(); clearNav(); return; }` —— 排在既有分支之后；`clearNav()` 照旧走 `setRoot('')`。
- `clearNav` 上方那段注释改写一句：入口从"栈底那颗 ⨯"改成"⋯ 菜单"，**2026-10-05 的"栈底也得有出口"没撤销，只是搬家**（业主要的就是这句可回溯）。

- [ ] **Step 7: 全文件清理**

`grep -n "history" src/views/FileFinder/index.vue`：只剩注释里允许出现的（如 1438 上那段历史说明）；
凡是代码里的 `history` 一律 0 命中。`CloseOutline` 0 命中。

- [ ] **Step 8: typecheck**

Run: `npm run typecheck`
Expected: 0 error。有错只许改类型/引用，不许为了消错把 `!` 铺开。

- [ ] **Step 9: grep 验收 + Commit**

```bash
grep -c "history\.value" src/views/FileFinder/index.vue   # 期望 0
git add src/views/FileFinder/index.vue src/views/FileFinder/useNavStack.ts
git commit -m "feat(nav): 导航改数组+游标，顶栏加前进；清空搬进更多菜单"
```

---

### Task 3: 键盘 `Alt+←` / `Alt+→`

**Files:**
- Modify: `src/views/FileFinder/useGridCursor.ts:495-506`（`DIR_KEYS` 判据之前）
- Modify: `src/views/FileFinder/index.vue`（`onKeyup`：`picking` 短路块 + `Backspace` 分支附近）

**Interfaces:**
- Consumes: Task 2 的 `onBack` / `onForward`。
- Produces: 无（终态功能）。

- [ ] **Step 1: 关掉网格对修饰键的吞并**

`useGridCursor.ts` 的 `onGridKeydown` 里，在 `const dir = DIR_KEYS[e.key]` **之前**插一行：

```ts
if (e.altKey) return;   // Alt+←/→ 是导航（index.vue 的 keyup）——不收窄就会"选择器动一格 + 跳屏"同时发生
```

（keydown 里 `preventDefault` 挡不住 keyup ⇒ 不加这行会**两个动作都执行**。）

- [ ] **Step 2: 接上快捷键**

`index.vue` 的 `onKeyup`：先在 `if (picking.value) { ... }` 的短路条件里补上 `Alt+方向键`（与 `Backspace` 同族），
再在 `Backspace` 分支**之前**加：

```ts
if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
    e.preventDefault();
    void (e.key === 'ArrowLeft' ? onBack() : onForward());
    return;
}
```

`Backspace` 分支保持原样（仍只等于后退）。

- [ ] **Step 3: typecheck**

Run: `npm run typecheck`
Expected: 0 error。

- [ ] **Step 4: Commit**

```bash
git add src/views/FileFinder/useGridCursor.ts src/views/FileFinder/index.vue
git commit -m "feat(nav): Alt+←/→ 前进后退；网格不再吞 Alt+方向键"
```

---

### Task 4: 真机目视 + 落档

**Files:**
- Modify: `docs/DESIGN-NAV-FORWARD-2026-11-10.md`（把"未实测"改成结论）
- Modify: `docs/PLAN-NAV-FORWARD-2026-11-10.md`（勾选 + 记下目视结果）

- [ ] **Step 1: 重启 dev 再验**（渲染层改动，HMR 会残留旧状态）

Run: `npm run dev`（先关掉已在跑的窗口）

- [ ] **Step 2: 走 Review Focus 的 5 条 + 设计文档 §6 的 6 条**

逐条在 `docs/probes/nav-stack/out.txt` 末尾追加一行 `[目视] 场景N: 通过 / 现象…`（证据必须落 `.txt`）。
其中 3/4/5 条（notFound、清单屏交叉、拔盘换锚点）**必须**真机走，探针给不了。

- [ ] **Step 3: `onBack` 的回归哨兵**

后退两次 → 前进两次 → 再后退两次，来回三遍后确认：滚动位置、选择器高亮、搜索词三者都跟着屏走，
且**不会**出现"面包屑是清单、格子里是目录"。

- [ ] **Step 4: 落档 + Commit**

工作日志追加到 `.workbuddy/memory/2026-11-10.md`；`MEMORY.md` 的「当前状态」加**一行**指针指向本设计文档。

```bash
git add docs .workbuddy/memory
git commit -m "docs(nav): 双向导航目视结论与记忆落档"
```

---

## 执行 ledger（2026-11-10 · native 执行）

**Task 1** 完成（`870a433`）：`useNavStack.ts` 134 行 + 探针 17 条。
**Task 2** 完成（`845569c`）：14 处读栈顶替换、`rememberCurrentScreen` 删除、`goStep` 合并、顶栏两颗、清空进 ⋯。`typecheck` 0 error、`grep history.value` 0 命中。
**Task 3** 完成（`2a8d893`）：`useGridCursor` 的 `altKey` 守卫 + `onKeyup` 的 Alt 分支。
**Review 后修复**（`50f1959`）：`shown` 守卫 + 探针 ⑨（反证 `300 !== 200`），顺带 5 处过期注释。
**Task 4 部分完成**：探针 19/19、typecheck 0 error、`grep` 0 命中；**真机目视待业主**。

**Rulings**
| # | 决定 | 理由 | 错的代价 |
|---|---|---|---|
| 1 | 不加载 TDD skill、不建 `.superpowers` 工作区 | 本仓无测试框架，业主明令禁止"假测试"；RED-GREEN 由探针承担 | 缺逐任务评审门 ⇒ 已用一次全分支 fresh review 补上 |
| 2 | `restoreScrollOf` **不单独抽函数**，直接长在 `goStep` 里 | 只有一个调用方，抽出只多两个形参 | 将来出现第三条路径（如"跳到某屏"）时要再拆一次 |
| 3 | `onRefresh` 守卫 `!hasAny` → `cur` 判空 | TS 不会用真值收窄 `current`，否则要写 `cur!` 掩盖真分支 | 无（语义等价） |
| 4 | `enterScreen` 用 `nav.push()` 的返回值喂 `loadScreen` | 省掉一处 `nav.current.value!` | 无 |
| 5 | 「清空导航历史」只进 `moreOptions`，不进 `DIR_ACTIONS` | 后者与右键菜单共用，混进去会让右键多出一条导航动作 | 右键菜单将来的增项要另起数组 |
| 6 | `Alt+←/→` 允许长按重复 | 浏览器/资源管理器都这样；配合 `shown` 不会写错快照 | 长按会连跳几屏（用户自己停） |
| 7 | 探针产物落 `node_modules/.cache/`，不进 `os.tmpdir()` | `vue` 是 external，tmpdir 不在 node_modules 解析链上（实测 `ERR_MODULE_NOT_FOUND`） | 无 |
| 8 | 注释占比不动：42.4% → 42.3% | 文件本来就超 30%，本批没恶化；治理注释是另一件事，不塞进来 | 仍然超线，需单独立项 |
