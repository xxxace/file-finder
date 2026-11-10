# 双向导航（后退 / 前进）设计 —— 2026-11-10

> 业主原话：**"加多一个操作前进，之前只能单向返回，我想变成双向，和文件管理器、浏览器差不多。
> 你看下要怎么设计，看看要不要重构功能，不要想着堆代码。"**
>
> 一句话结论：**不是重构，是换 state 形状**（栈 → 数组 + 游标）+ 把 `onBack` 里那 70 行
> 恢复逻辑抽成**一份**共用。净增一个新文件（~130 行），`index.vue` 净减。
> 所有 `文件:行号` 均为 2026-11-10 实测核过（`index.vue` 2017 行版）。

---

## 1. 目标 / 非目标

**目标**
- 后退与前进对称：两者都**不销毁**任何一屏，都能来回走（浏览器 / 资源管理器语义）。
- 离开一屏时记下的"这一屏的样子"（滚动 / 选择器 / 过滤词）在**两个方向**上都能复原。
- 数据模型只有**一份真相**，新增第 3、4 个导航入口时不用再动模型。

**非目标（明确不做，附理由）**
| 不做 | 理由 |
|---|---|
| 双数组（`backStack` + `forwardStack`） | 09-30 那次被"两个数组长度必须差 1"的**隐式不变量**坑过（`openStack` / `searchStack`）⇒ 同一个病不再犯第二次。见 `DESIGN-NAV-2026-09-30.md §2` |
| 长按后退弹出历史列表 | 本项目已点名否决长按 / hover 类交互（`DESIGN-NAV-2026-09-30.md §8`） |
| 前进尾巴跨重启保留 | 历史里全是真实路径，持久化等于存一棵可能失效的盘符树；收益 < 代价 |
| 复原 flat 平铺态 | 需要先解决 `isCacheRoot` 与 `isFlatView` 的时序（见 §7 遗留），混进来这批没法验 |
| 面包屑变成"从这个屏能前进到哪" | 面包屑 = **位置**（`ancestorsOf` 现算），前进尾巴 = **历史**。两者混用就是 09-30 修的"一数组两语义" |

---

## 2. 事实基线（为什么"加一行"不成立）

`DESIGN-NAV-2026-09-30.md §8` 曾写：「「前进」现在没有这个需求；`history` 模型已经天然支持，
**将来要加是加一行**」。**这句在三处被现实推翻：**

1. **返回是销毁式的**：`onBack` 第一句就是 `history.value.pop()`（`index.vue:1296-1297`）
   —— 那一屏连同它的 `scrollY` / `cursorKey` / `searchText` 一起被扔掉。没有"被扔掉的那一屏"
   就谈不上前进。⇒ 必须先有**不销毁的模型**。
2. **"当前屏"被 13 处按 `history[length-1]` 硬读**（表见 §4.3）。数组一旦配上游标，
   `length-1` 就不再等于当前屏 ⇒ 漏改一处就是**静默读错屏**（读到前进尾巴上：
   面包屑显示 A、刷新却重读 B）。这类错误没有报错、没有异常，只能靠"结构性消失"来防。
3. **`onBack` 有 70 行恢复逻辑**（`index.vue:1295-1365`：滚动 / 选择器 / 搜索词 / 焦点意图 /
   请求序号 / `waitForGridOf` 回读）。前进要复用同一套 —— 复制一份就是两份必然漂移的实现，
   正是业主禁止的"意大利面条"。

另有一条**键盘冲突**（实测代码，非推理）：`useGridCursor` 的 `onGridKeydown`（`useGridCursor.ts:495-506`）
对方向键**不看修饰键** ⇒ `Alt+→` 会先被网格吃成"选择器右移一格"。关掉它只需一条 `altKey` 守卫。

---

## 3. 方案：一个数组 + 一个游标

```
entries: [A][B][C][D][E]
                    ↑ index = 2（当前屏 = entries[index]）
后退 = index-- ，前进 = index++
在 index=1 处进新屏 X ⇒ splice(2) 砍掉尾巴，再 push X
```

- **游标只能 `step(±1)` 移动**，且**移动前**先给当前屏拍快照 ⇒ 后退与前进**共用同一段**。
- 长度不再等于"能不能后退"，改为 `index > 0` / `index < len-1`。
- `index = -1` + 空数组 = 「还没选文件夹」（与今天 `history.length === 0` 语义一一对应）。

---

## 4. 落点清单

### 4.1 新文件 `src/views/FileFinder/useNavStack.ts`（~130 行）

```ts
export interface NavEntry { path: string; mode: OpenMode; searchText: string; scrollY: number; cursorKey: string; pl?: { id: string; name: string } }

useNavStack({ snapshot })   // snapshot: () => Pick<NavEntry,'scrollY'|'searchText'|'cursorKey'>
  → { current, hasAny, canBack, canForward, push, step, replaceCurrent, reset }
```

- `NavEntry` **从 index.vue 迁到这里**（模型归模型文件，页面只消费）。
- `snapshot` 是**函数**不是值：它读 `imageBox.scrollTop` / `searchText` / `cursorKey`，
  三者都在页面里且声明顺序靠后 ⇒ 传值会 TDZ，传闭包在调用时才求值。
- `push(entry)`：`snapshotCurrent()` → `splice(index+1)` 砍尾巴 → `push` → `index = len-1`。
- `step(±1)`：越界返回 `undefined`（调用方只判一次）；否则 `snapshotCurrent()` → 移动 → 返回目标 `NavEntry`。
- `replaceCurrent(patch)`：给"换盘降级把当前屏路径换掉"（`index.vue:1979` 的 `swapTop`）用。
- `reset()`：给 `setRoot('')` / 换根用。

### 4.2 页面侧唯一的移动入口

```ts
const goStep = async (delta: 1 | -1) => {
    const to = nav.step(delta);
    if (!to) return;
    noteIntent();                       // 顺序即依赖，见原 onBack 注释
    setCursorKey(to.cursorKey);
    const done = loadScreen(to, { adoptSearch: true });
    const myFetchSeq = getFetchSeq();
    await done;
    await restoreScrollOf(to, myFetchSeq);   // 原 onBack 后半段，逐字搬出
};
const onBack = () => goStep(-1);
const onForward = () => goStep(1);
```

`restoreScrollOf(to, seq)` = 现 `index.vue:1333-1364`（含"过期请求不碰视口"与 clamp 回读），
**一字不改地抽出**，只把形参从闭包变量变成入参。这是本批唯一"搬代码"，也是最不该复制的东西。

### 4.3 13 处读栈顶 → 读 `nav.current.value`

| 行 | 现在 | 改成 |
|---|---|---|
| 683 | `currentPath` = `history[len-1]?.path` | `nav.current.value?.path ?? ''` |
| 688 | `crumbs` 的 `top`（清单屏判据） | `nav.current.value` |
| 845 | `playlistLevel` | `nav.current.value?.pl` |
| 960 | `reloadCurrentScreen` | `nav.current.value` |
| 977 | `currentPlaylistId` | `nav.current.value?.pl?.id ?? ''` |
| 988 | `refreshAfterApply` | `nav.current.value` |
| 1084 | `rememberCurrentScreen` | **删掉**（快照搬进 `useNavStack`，两处重复会漂移） |
| 1134 | `enterScreen` 取数目标 | `nav.current.value!`（`push` 之后） |
| 1298 | `onBack` 的 `to` | 由 `nav.step(-1)` 返回 |
| 1410 | `toggleFlatView` | `nav.current.value` |
| 1421 | `onRefresh` | `nav.current.value` |
| 1967 | `onDisksChanged` 的 `topPl` | `nav.current.value` |
| 1974 | `onDisksChanged` 的 `top` | `nav.current.value` |
| 1979 | `swapTop` 的 `splice` | `nav.replaceCurrent({ path })` |

长度判据（`!history.length` → `!nav.hasAny`）：`index.vue:26`（模板）、`816`、`1420`、
`1573`、`1582`；`1438` / `1462` 的 `history = []` → `nav.reset()`。

> **验收方式**：改完 `grep -n "history\.value" src/views/FileFinder/index.vue` 必须只剩 0 命中；
> `grep -n "history" ...` 只应剩注释。漏一处就还能搜到 —— 这条比"我看着都改完了"可靠。

### 4.4 顶栏：一颗变两颗

```html
[▤ 起点][← 后退][→ 前进][↻ 刷新] │ 地址槽 │ [⌕][▦][⊞] | [⋯]
```

- ←：`:disabled="!nav.canBack"`，tooltip「返回上一屏（Backspace）」/ 栈底时「没有上一屏了」。
- →：`:disabled="!nav.canForward"`，tooltip「前进到下一屏（Alt+→）」/ 尾巴空时「没有下一屏」。
- **两颗都常驻**（不 `v-if`）：11-08 那条"按钮一出现/消失就把面包屑推走 60px"的纪律继续生效。
- 代价：左侧组 +32px，从 `flex:1` 的地址槽里出（面包屑逐段省略兜底，结构不变 ⇒ 不触发重排）。
- 图标：`ArrowBackOutline`（已有）/ `ArrowForwardOutline`（`@vicons/ionicons5` 有，实测目录存在）。
  `CloseOutline` 从此无引用 ⇒ 连同 import 一起删。

### 4.5 「清空导航」搬进 ⋯ 菜单（业主 2026-11-10 裁决）

- 撤销 2026-10-05「栈底也得有出口」的**按钮位**（出口本身没撤销，只是搬家）。
- **不进 `DIR_ACTIONS`**：那份清单是"目录工具动作"，与右键菜单共用；清空是**导航动作**。
  在 `moreOptions` 计算里追加一条 `{ label: '清空导航历史', key: 'clearNav', disabled: !nav.hasAny }`，
  `onMoreSelect` 加一支 → `clearNav()`。判据：让右键菜单长出一条"清空导航"是错的。
- 代价：`⋯` 触发器 `:disabled="scanning"` ⇒ 扫描期间清空不可达（与"整组不可用"一致，接受）。

### 4.6 键盘：`Alt+←` / `Alt+→`（业主 2026-11-10 裁决）

两处，缺一不可：

1. `useGridCursor.ts` 的 `onGridKeydown`，在 `const dir = DIR_KEYS[e.key]` **之前**加
   `if (e.altKey) return;` —— 否则 `Alt+→` 先被网格吃成"右移一格"（keydown 拦了也仍会冒到 keyup ⇒ 会**同时**移动和跳屏）。
2. `index.vue` 的 `onKeyup`，放在「换封面」短路块**之后**、`Backspace` 分支**之前**：

```ts
if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
    e.preventDefault();
    void (e.key === 'ArrowLeft' ? onBack() : onForward());
}
```

「换封面」模式里把 `Alt+方向键` 一并短路（与 `Backspace` 同族：模式态下跳屏 = 屏幕上完全看不出跑偏）。
`Backspace` 仍然只等于后退（不上前进，避免"退格把视图推着走"的误触）。

---

## 5. 语义裁决

**业主裁决（2026-11-10）**
- 清空入口 → 搬进 ⋯ 菜单（顶栏 `[▤][←][→][↻]`）。
- 前进配 `Alt+←` / `Alt+→`，`Backspace` 继续等于后退。

**我的 call（可在验收时否决）**
1. **新导航截断前进尾巴**（浏览器语义）。后果：退两屏后点面包屑 / 进目录 ⇒ 前进键立刻变灰。
   替代方案（尾巴永久保留）会让"位置链"与"历史"长期不一致，与 §1 的非目标冲突。
2. **刷新（↻/F5）、apply 后刷新、换盘降级都不动尾巴**：它们走 `fetchFolder` 直连，不经过 `push`。
3. `setRoot`（选根 / 换根 / 清空）**清空全部历史**：那是"重新开始"，语义没变。
4. 前进到一屏时它的 `scrollY` 用"上次离开它时"记的值 —— 因为 `step()` 在**离开**时拍快照，
   两个方向对称，不需要第二套记录。
5. 前进尾巴里的屏若盘已拔出 ⇒ 走既有"离线 / 未找到"路径（与后退完全同一条），不新增分支。

---

## 6. 验收

- `npm run typecheck` **0 error**（新文件类型 + 13 处替换）
- `grep -n "history\.value" src/views/FileFinder/index.vue` → **0 命中**
- 真机目视（改扫描逻辑无关，但导航是纯渲染层 ⇒ **改完重启 dev**）：
  1. 钻三层 → 后退两次 → 加号变亮 → 前进两次**回到第三层**，滚动位置 / 选择器都在原处
  2. 后退一格后**点面包屑跳到别处** ⇒ 前进键立刻变灰（截断）
  3. 后退到清单屏 / 前进回目录屏，面包屑与网格内容一致（不许"面包屑是清单、格子里是目录"）
  4. `Alt+→` 前进时选择器**不动**（证明网格守卫生效），`Alt+←` 同理
  5. 栈底：←/→ 都灰，`⋯` 里「清空导航历史」可点，点完回到"还没选文件夹"
  6. 换封面模式里按 `Alt+→` 不跳屏
- 读盘：**零读盘**（本批只动渲染层状态与顶栏；`loadScreen` 复用既有缓存路径）。

---

## 7. 风险 / 遗留

| 项 | 状态 |
|---|---|
| **连按导航时中间屏的快照**（code review 2026-11-10 抓到） | **已修**。原设计"离开时拍快照"有一个漏洞：取数异步，连按两次后退时画面还停在旧屏，中间那屏会被记上**上一屏**的滚动位与过滤词（选择器却是它自己的）⇒ 以后前进回来**停错高度**，与 2026-10-04 那个病同族。修法：`useNavStack` 加 `shown` —— **只有数据真落到这一屏**（页面在 `loadScreen` 成功后 `markShown()`，失败不标记）才允许给它拍快照。探针 ⑨ 反证：去掉守卫后 `300 !== 200` |
| **flat 平铺态不随屏复原** | **遗留，本批不修**。`isFlatView` 不在 `NavEntry` 里，后退/前进都只沿用"离开那一屏时的值"；要修得先解决 `isCacheRoot`（异步探针）与 `isFlatView` 的时序，否则会引入新的闪烁 |
| forward 尾巴里的屏可能已失效（目录被删 / 盘拔出） | 与后退同一条失败路径（`notFound` → 空列表 + 横幅 + toast），不新增分支 |
| `NavEntry` 迁文件 | 只迁接口，字段含义与注释**整段带走**（`cursorKey` / `pl` 那些判据是历史踩坑记录，不能丢） |
| 内存 | 每屏一个 ~200 字节对象，历史长度 ≈ 用户点击次数；不设上限、不清理 |
| 「一条时间线」被截断的观感 | 会不会有人期待"退回去的那几屏还在"？按浏览器惯例否；若真机觉得别扭，改成"保留尾巴但标记失效"是一处 `splice` 的差别 |

---

## 8. 落地顺序（供 plan 展开）

1. 新建 `useNavStack.ts`（纯逻辑，可先用 `docs/probes/` 里的小脚本喂断言：push / step / 截断 / reset）
2. `index.vue` 接上：13 处替换 + 删 `rememberCurrentScreen` + 抽 `restoreScrollOf` + `goStep`
3. 顶栏两颗按钮 + 删 `CloseOutline`
4. ⋯ 菜单加「清空导航历史」
5. `useGridCursor` 的 `altKey` 守卫 + `onKeyup` 的 Alt 分支
6. `typecheck` → 重启 dev → 目视 §6
