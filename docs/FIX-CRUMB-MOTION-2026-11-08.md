# 固定 · 面包屑（文件地址）跳动 + 无过渡 · 2026-11-08

## 症状（主人原话）

> 文件地址的渲染显示有问题，没有那种丝滑的动画效果，每次好像都是重新渲染，而且会跳动很难受

截图：`F: > videos`，头部左侧。

## 根因（两条，互相独立）

### ① 一次导航 = 5~6 次**瞬时**布局变化，且零过渡

面包屑这一排的宽度是「当前路径」的函数，而 `enterScreen()` 是**先压栈再取数**（`index.vue:1074`）：

| 时刻 | 变化 | 谁被推着走 |
|---|---|---|
| 点击瞬间 | 新段插入（key 不同 ⇒ 新节点） | 后面的「返回」按钮 |
| 点击瞬间 | 旧当前段丢掉 `crumb-current` ⇒ `font-weight` 500→400、`flex` 由 `0 0 auto` 变 `0 1 auto` | 同上 |
| 点击瞬间 | 旧当前段丢掉 `[data-count]` 角标（≈24~40px） | 同上 |
| 点击瞬间 | `loading=true` ⇒ `n-spin` 塞进新当前段（8+12=20px） | 同上 |
| 取数落地 | `loading=false` ⇒ 转圈移除（−20px） | 同上 |
| 取数落地 | 新当前段拿到 `[data-count]`（+24~40px） | 同上 |

六次全是**同步重排**，没有任何一条 `transition` 接住它们。而且 `.nav-zone` 里没有一条 transition 命中 `.crumb`（全文件只有 8 处，全是别的元素）—— 所以不是"动画不够好看"，是**根本没有动画**。

### ② 折叠阈值那一下，整排节点被销毁重建

原来是模板里 `v-if="crumbFold"` / `v-else` **两棵互斥的树**：

```html
<template v-if="crumbFold">  <!-- 首段 + … + 当前段 -->
<template v-else>            <!-- 全部段 -->
```

`foldCrumbList` 在段数 > 4 时返回对象、否则 `null` ⇒ 层级跨过 4 的那一下，Vue 把整棵子树卸载、再挂另一棵。
视觉上就是"整排地址重新渲染一次"。而且节点换了，"移动前的位置"根本不存在 ⇒ **任何过渡都不可能做**。

## 改了什么

| # | 位置 | 改动 |
|---|---|---|
| 1 | `src/styles/tokens.css` | 新增 5 档时长 + 3 条曲线（`--ff-dur-*` / `--ff-ease-*`）。这是全项目**第一份**动效 token —— 之前每个组件各写各的 `.08s`~`.43s`。 |
| 2 | `src/views/FileFinder/crumbRows.ts`（新） | 折叠 / 不折叠统一成**一个** `buildCrumbLayout()`，产出 `{ head, fold, tail, headCurrent }`。纯函数，零 DOM。 |
| 3 | `index.vue` 模板 | 两棵树合成一棵；`.nav-zone` 改成 `<TransitionGroup name="fx" tag="div">`。 |
| 4 | `index.vue` 样式（非 scoped 块） | `.fx-move` / `.fx-enter-active` / `.fx-leave-active`，含 `prefers-reduced-motion` 分支。 |

### 关键判断：为什么 TransitionGroup 包的是 `.nav-zone` 而不是面包屑

因为**跳得最厉害的不是面包屑，是「返回」按钮**。它排在面包屑后面，面包屑一变宽它就被推着走。

- 只包面包屑 ⇒ 面包屑内部 FLIP 了，但「返回」照样硬跳，最多治一半。
- 包整个 `.nav-zone` ⇒ 「返回」也是 keyed 子项，位置一变就吃到 `-move`，跟着滑过去。

这也解释了为什么**没有**去改「返回」的位置：位移是"面包屑宽度是路径的函数"的必然结果，
想让它不动只能给它一块固定宽度的空位（会白白浪费几十像素）。**让它平滑地动，比不让它动便宜得多。**

### 为什么拆成 head / fold / tail 三段而不是一个 `v-for`

`TransitionGroup` 的 FLIP 只认**元素**子节点。`<template v-for>` 产生的是 fragment，
拿不到 `el`，位移会**静默失效**（不报错，就是不动）。折叠占位是 `n-popover`、其余是 `n-tag`，
两类节点没法在同一个 `v-for` 里渲染 ⇒ 拆三段，每段仍是 keyed 元素。

## 过渡参数

```css
.fx-move          { transition: transform 260ms cubic-bezier(.16,1,.3,1) }  /* FLIP：位置迁移 */
.fx-enter-active  { transition: opacity + transform 300ms cubic-bezier(.34,1.28,.42,1) }
.fx-enter-from    { opacity: 0; transform: translateX(-8px) }               /* 从父级那侧长出 */
.fx-leave-active  { display: none }                                          /* 同步撤出布局，见第二轮 */
```

- 进入带过冲（`y1=1.28`），退出收紧不反弹 —— 两条曲线，不是一条。
- 退出**不做淡出**，原因见「第二轮 · 瑕疵 A」：淡出期间元素仍占位，FLIP 拿不到 delta。
- `prefers-reduced-motion` 直接切终态（不能只把时长设 0，否则 `-enter-from` 的位移会在同一帧闪一下）。

## 验证

| 项 | 结果 | 等级 |
|---|---|---|
| `npm run typecheck` | 0 error | 实测 |
| vite 模块编译（HMR 实际拉取） | 200，`_TransitionGroup` 已进渲染函数 | 实测 |
| `docs/probes/crumbs/layout.mjs` | **17 PASS / 0 FAIL** | 实测 |
| 真机目视（跳动是否消失、过渡是否顺） | **未做** | — |
| `docs/probes/tokens/no-raw-color.mjs` | PASS（未超基线） | 实测 |

探针覆盖：展开态逐段等价、单段时首段=当前段、折叠态「首段+…+当前段」、
清单屏空 `path` 不塌成同一个 key、空路径不抛、`…` 不混进 tail。

## 第二轮：反向导航（1-2-3 → 1-2）仍然不做过渡

主人复测：**`1-2 → 1-2-3` 很丝滑，`1-2-3 → 1-2` 时「2」往右跳一下**。

第一版有两个瑕疵同向叠加，且都只在**反向**这条路上暴露 —— 正向被进入动画盖住了。

### 瑕疵 A：退出只做淡出，元素还占着位置 ⇒ FLIP 从头到尾没触发

第一版写的是：

```css
.fx-leave-active { transition: opacity 180ms }   /* ❌ */
```

查 `@vue/runtime-dom` 的 `TransitionGroupImpl`（v3.5，`runtime-dom.esm-bundler.js`）确认了量位置的时机：

| 步骤 | 时机 |
|---|---|
| `positionMap.set(child, getPosition(child.el))` | **render 里**（patch 前），记"移动前" |
| `addTransitionClass(el, leaveActiveClass)` | **patch 期间**（mutation 阶段） |
| `onUpdated` → `recordPosition` → `applyTranslation` | **post-flush**，量"移动后" |

淡出时元素**仍占着位置** ⇒ 这一步布局根本没变 ⇒ 所有 `dx === 0` ⇒ `applyTranslation` 全部跳过
⇒ 一帧都没滑。等 180ms 结束节点被摘掉，剩下的一排（含「返回」）就在一帧内硬塌回去。

**修**：`.fx-leave-active { display: none }` —— 同步撤出布局，塌陷发生在这个更新帧里，
`onUpdated` 就能量到 delta，FLIP 才真的开始滑。

> ⚠️ 不能用 `position: absolute` 撤出：绝对定位子项在 **flex 容器**里的静态位置按
> "它是唯一的 flex 项"算 ⇒ 会被丢到内容区最左边，等于整段瞬移到起点再淡出。

### 瑕疵 B：角标是占宽的 flex 项 ⇒ 一段"变成当前段"的那一瞬整段变宽 40px

`2` 从"历史段"变成"当前段"时同时拿到 `font-weight: 500` + `[data-count]` 角标。
角标原来是 `flex: 0 0 auto; margin-left: 6px` —— **吃宽度**。
中文在 400/500 下字宽不变（1em），所以那 40px **全部来自角标**：就是"2 往右跳一下"。

**修**：角标改成 `position: absolute` 画在 `.crumb-current` 恒定预留的 `padding-right: 42px` 槽里。

| 动作 | 改前 | 改后 |
|---|---|---|
| 加角标 | 整段 +40px，瞬跳 | **零布局**，槽早就在 |
| 数字位数变化（1 位→4 位） | 整段跟着变宽 | 零布局 |
| "留槽"这一下 | — | `padding-right` 走 `transition`，**渐变** |

配套两条：
- `.crumb { justify-content: flex-start }` —— 槽在右边，居中会让**文字**跟着槽宽横移。贴左则槽怎么变、文字都不动。
- 角标用 `@keyframes` 入场（`opacity + scale(.7→1)`）。它是 `::after`，**命中选择器那一刻才被创建**，没有上一帧可过渡，不加动画就是"啪"地冒出来。

### 为什么 `padding-right` 能和 FLIP 同时存在（先算过再写的）

FLIP 在 t=0 给「返回」一个 `translate(dx)` 并把它过渡到 0；同时 `padding-right` 把布局往右推。
视觉位置 = 布局位移 + transform，两项都单调、同时长同曲线 ⇒ 合成仍是单调曲线，不会打架。
**如果槽宽直接换值不渐变**，则「2」的右边缘仍是瞬跳 —— 所以这两条必须一起改。

## 残余问题

| 问题 | 状态 |
|---|---|
| 「返回」横向硬跳 | ✅ 已由 FLIP 接管 |
| 角标让当前段瞬跳 | ✅ 已改为不占布局 |
| 退出无淡出 | ⚠️ **故意**：退出必须"立刻让位"，FLIP 才有 delta。视线跟的是在滑的邻居 |
| 空文件夹时当前段有 42px 空槽 | ⚠️ `crumbCount` 为 `null` 时不画角标，槽仍在（换来的是宽度恒定） |
| 折叠跨阈值（深度 4↔5）时多段同时消失 | 未单独验证 |

## 一条经验（值得进 MEMORY）

**"没有动画"和"跳动"经常是同一个根因的两面**：先查有多少次同步重排、有没有一条 transition 接住，
再谈曲线。反过来先调曲线 = 给抖动包一层缓动，只会更难受。

---

## 第三轮：结构级返工（前两轮都是治症状）

主人复测后给了判据，而且判据是对的：

> `F > videos` → `F > videos > a`（其实多了 a）；
> `F > videos > a` → `F > videos`（其实只是少了 a）—— 而不是每次都全部重渲染

### 为什么前两轮注定治不好

**一条物理约束**：在一次 append / remove 里，**排在变动点右边的东西必然被推着走**。
「返回」原来排在面包屑**后面** ⇒ 末尾多一段 / 少一段，它一定要横移。
我前两轮做的都是"让这次横移更平滑"（FLIP、缓动、非对称），
但主人要的是**这次横移根本不该存在**。滑过去也是动，动着就还是"怪"。

### 结论：让面包屑右边为空

```
改前：[文件夹 chip] [盘符] › [段] › [当前段] [返回] [工具条…]
改后：[文件夹 chip] [返回] [盘符] › [段] › [当前段] [工具条…]
                                  ↑ 右边是空的
```

于是：

| 动作 | 变化 | 其余 |
|---|---|---|
| `F: › videos` → `F: › videos › a` | 末尾**多出 a**（淡入 + 从左侧 8px 归位） | 一个像素不动 |
| `F: › videos › a` → `F: › videos` | 末尾**少了 a**（立刻消失） | 一个像素不动 |
| 当前段换人 | 角标淡入 / 淡出 | 一个像素不动 |

（Windows 资源管理器 / macOS Finder / Chrome 都是这个顺序 —— 同一条约束推出来的，不是我挑的审美。）

### 连带三处

1. **退出改回 `display: none`（瞬时）**。上一轮为了让 FLIP 有差可补才用瞬时撤出；
   现在右边空了，"少一段"本来就只影响自己 ⇒ 立刻消失最诚实。
   淡出会让 180ms 里同时看到「上一层的角标 + 还没消失的这一段」，自相矛盾。
2. **角标：占宽的 flex 项 → 预留槽 + 绝对定位 + 无过渡**。
   走过三版：① 占宽 ⇒ 推开「返回」＝"右跳"；② 预留槽 + `transition` ⇒ 宽度对了，但
   过渡会在 260ms 里把**新进场的段**慢慢挤开（换一种怪）；③ 定稿：预留槽、**不加过渡**，
   一次布局算完就落定。槽是长在当前段自己的盒子里（无背景 ⇒ 看不见），右边没邻居 ⇒ 推不到人。
3. **`justify-content: flex-start`**：槽在右，居中会让**文字**跟着槽宽横移；贴左则文字钉死。

### FLIP 的现状

`.fx-move` 保留，但**退居兜底**：正常增删时没有任何邻居会动，它静默空转；
只有路径长到撞上 `max-width: 50%`、整排要收缩时才命中，避免硬挤。

### 代价（明确承认）

**「返回」的位置变了。** 这是本次唯一可见的 UI 变化，也是达成"只变增量"的必要条件 ——
只要它在面包屑右边，就一定会被推动，没有第三种可能。

---

## 第四轮：先量再改（前三轮全是"看代码猜"）

前三轮每一轮都被驳回一次，共同点：**我一次都没量过**。
这一轮先造探针 `docs/probes/crumb-motion/`，把"跳"变成 `getBoundingClientRect()` 的数字，
再动手。

### 探针的构成（真到底，不手抄）

| 件 | 来源 |
|---|---|
| Chromium | 真 Electron 窗口（offscreen，rAF 照常推进） |
| naive-ui / Vue | `node_modules` 里的 UMD |
| CSS | `index.vue` 的 **scoped + 非 scoped 两个** style 块 + `tokens.css`，`compileStyleAsync` 真编译 |
| 布局推导 | `crumbRows.ts` 用 esbuild 打成 IIFE，探针调**真函数** |

> ⚠️ 不能复用 `header-width/build-css.mjs`：那个 `if (!style.scoped) continue`，
> 而本轮的过渡规则（`.fx-move` / `.fx-enter-*` / `.fx-leave-active`）全在**非 scoped** 块里。

### 判据：`t0` 那一刻的 left

Vue 的 FLIP 在 `onUpdated` 里**同步**写 `transform: translate(dx,dy)`，
而 `nextTick()` 正好在 post-flush 之后 ⇒

- `t0.left == before.left` ⇒ 被 transform 拉回原位了，**会滑过去**；
- `t0.left == 最终位置` ⇒ **一跳到位，没有任何过渡接住它**。

四个场景各抓 5 个时刻（before / t0 / rAF / +80ms / +450ms）。

### 造探针时自己踩的三个坑（都会导致量到"另一个东西"）

1. **复刻件必须跟着实现改**。第一版改完 `index.vue` 重跑，`btn:清空` 变成 `btn:返回` 还在闯——
   因为探针的模板是**自己抄的一份**，它测的还是旧的两分支按钮。⇒ 复刻件是负债，改完必须同步。
2. **`id` 不能用文字**。第一版 `id = 'btn:' + 文字`，于是"同一个节点只换了文案"被报成
   "旧的走了、新的来了" —— 恰好是本轮要证明的那件事被命名法抹掉了。改成给节点打持久 `__pid`。
3. **伪元素拿不到几何**。`getComputedStyle(el,'::after')` 只有 `content`、没有 rect。
   验证"角标有没有被 `overflow:hidden` 裁掉"改用**命中测试**（伪元素算在生成它的元素身上）：
   在 `当前段.right + 10/20/30` 各打一枪，返回当前段 = 画出来了且没被裁。

### 量出来的根因（唯一一处瞬时几何变化）

四个场景里，`F:` 与 `videos` 的 `left` **全程零位移**。唯一在 `t0` 就变了的东西是：

```
crumb:F:   padR  42px → 2px     ← 一帧内，40px 空槽被搬走
```

`.crumb-current { padding-right: 42px }` —— 那个角标槽长在"当前段"身上。而**当前段恒等于最后一格**，
换层时它**换人**（`F:` → `videos`）⇒ 40px 空槽在一帧里从上一格搬到下一格，
中间那一格被迫横移 40px，位置**正在"F: 与 videos 之间"**。这就是主人报的那句话。

> 前三轮我一直在给这次横移"加过渡"，方向就是错的：**它根本不该发生**。
> 而且它不可过渡 —— 同一个元素上的 padding 变化与 FLIP 的 transform 会打架。

### 三处改动

1. **角标槽：从"当前段身上"上移到"行级常量"**
   `.nav-zone { --crumb-badge-slot: 48px; padding-right: var(--crumb-badge-slot); }`
   ⇒ 谁当当前段都占同一块。当前段于是**只剩换色/换字重**，零布局事件。
   ⚠️ 必须配 `box-sizing: border-box` + `max-width: calc(50% + var(--crumb-badge-slot))`：
   内容区预算仍是 50%（否则最窄那档白丢 48px），多出的 48px 落在 padding 里；
   `overflow:hidden` 的裁剪边界是 **padding box** ⇒ 角标不会被裁（命中测试已验）。
2. **`::after` 从 `right: 2px` 改成 `left: 100%; margin-left: 6px`** ⇒ 画在当前段**盒子外侧**，
   落在上面那个常驻槽里。当前段的宽度不随角标有无/位数变化。
3. **「返回 / 清空」合并成一个节点**。原来是两颗**不同 key** 的按钮，1↔2 时
   `TransitionGroup` 当成"旧的走、新的来"（旧的一帧塌掉 + 新的从 -8px 淡入）——
   宽度一样也救不了"节点被重建"。现在 key 恒定，`v-if` 只判"有没有出口"，文字与提示走 computed。
   逻辑逐字不变：`>1` → `onBack`（Backspace 仍只走它）、`===1` → `clearNav`、`0` → 不渲染。

### 结果（`docs/probes/crumb-motion/out.txt`）

```
场景                       F: left      F: padR      videos left       按钮
① F: → F:>videos           124.81 恒    2px→2px      —→143.63→151.63   B1 同一节点（清空→返回）
② 2 段 → 3 段             124.81 恒    2px→2px      151.63 恒          B1 不变
③ 3 段 → 2 段             124.81 恒    2px→2px      151.63 恒          B1 不变
④ F:>videos → F:          124.81 恒    2px→2px      —                 B1 同一节点（返回→清空）

瞬跳：**无**（四个场景全部）     恒存段宽度变化：**无**（除离场那一格）
角标：`::after content = "35"`，`right+10/20/30` 三处命中都返回当前段 ⇒ 画出来了、没被裁
```

**「只多了 a / 只少了 a」现在是字面成立的**：第 2/3 段换层时，前段的 left 和 width 一个像素都不动。

### 不在本轮范围（别当全绿）

- **折叠（>4 层）那条路**没测：`…` 那格是 `<n-popover>`，组件根不一定是单个元素，
  `TransitionGroup` 的 FLIP 能不能拿到它的 `el` **没验证**。已知疑点，未动。
- **探针 ≠ 真机**：根 chip 用的是定宽替身（导航期间它本来就不变），
  且真机上 `loading` 会在当前段里插一个 `n-spin`（在当前段内部，不推邻居）。
  这两条差异都不影响本轮判据，但**任何观感结论仍以真机为准**。

---

## 第五轮：进 / 退不对称（"进正常、退会跳"）

修完第四轮之后主人回来说：`F: › videos` 正常、`F: › videos › a` 也正常，
**但 `F: › videos › a =》F: › videos` 会跳**。

### 根因：一句话 —— enter 有 300ms，leave 是 0ms

`.fx-enter-active` 有 300ms 淡入 + `-8px` 归位；`.fx-leave-active` 写的是 `display: none`。
所以"多一段"是**长出来的**，"少一段"是**没了**。这个不对称就是"不丝滑"本身。

### 为什么不能只是把 `display: none` 换成淡出

第二轮已经踩过：留着占位 ⇒ 整排在这 180ms 里一动不动、结束时一帧塌回去；
Vue 的 FLIP 只在 `onUpdated` 量一次位移，全程量到 0 ⇒ 一帧都没滑。

⇒ 两个条件必须同时成立：
1. **脱离文档流**（行立刻塌，FLIP 量到的是真位移）；
2. **位置钉死**（不能瞬移）。

`position: absolute` 单独撤出违背后半条：flex 容器里的绝对定位子项，静态位置按
"它是唯一的 flex 项"算 ⇒ 会被丢到内容区最左边（第二轮也踩过）。

**正解**：`@before-leave="pinLeaving"` —— 此刻元素还在文档流里、`getBoundingClientRect()` 是真的，
抄一份 left/top/width/height 写成内联绝对定位，再交给 CSS 淡出。
`.nav-zone` 加 `position: relative` 当定位祖先（用 `absolute` 不用 `fixed`：fixed 的坐标系
会被祖先的 transform / filter 改写）。

### 做完之后连着踩的三个衍生坑（都是截图/数字抓出来的，不是想到的）

1. **淡出不能用 `--ff-ease-exit`**。那条曲线是给位移的（前重后轻）：
   180ms 的 **90ms 处 opacity 已经掉到 0.1** ⇒ 肉眼看就是"闪一下没了"，等于没做动画。
   ⇒ `opacity` 用 **linear**、`transform` 继续用 `--ff-ease-exit`。
   修完 90ms 处是 **0.63**（`out.txt` 的 `op t0→t80`）。
2. **幽灵上还挂着一个角标**，和新的当前段正在淡入的那个并排 ⇒ 截图里是 `videos 35 35`。
   ⇒ 在 `pinLeaving` 里 `el.removeAttribute('data-count')`。
   ⚠️ **不是**写 CSS 去盖：`.crumb-current[data-count]::after` 在 **scoped** 块里，
   编译后多挂一个 `[data-v-*]` 属性选择器，非 scoped 块里怎么写都打不过它（除非上 `!important`）。
   摘属性 = 零特异性纠纷。
3. **角标的落点正好压在幽灵身上**（角标挂当前段右边缘 +6px，下一段起点是 +12px）
   ⇒ 幽灵被整个盖住，淡出还是看不见（放大截图里只剩一个 `›` 压在角标边上）。
   ⇒ 角标入场加 **120ms 延迟**（`--ff-dur-badge: 180ms` + delay 120ms，`both` 填充保证延迟期间不可见）。
   于是顺序变成：**先看到那段走，再看到数字来**。

### 结果

```
场景 ③  F: › videos › a  →  F: › videos
  crumb:a     t0.left 210.98（钉在原位）→ t80 207.37 → t400 已移除
              opacity 1 → 0.63 → 0
  crumb:F:    left 124.81 恒 · width 14.81 恒
  crumb:videos left 151.63 恒 · width 47.36 恒
  按钮        B1 同一节点
  角标        t0 不可见（延迟）· 450ms 时已画出（命中测试通过）

场景 ④  F: › videos → F:  同上（videos 幽灵 151.63 → 148.02 → 移除）
场景 ①② 进方向不受影响
```

视觉证据：`shot-leave-90ms.png`（1×）、`shot-leave-zoom.png`（窗口 zoom ×2，能看清 `a` 正在淡）。

### 探针自身又踩一个坑

**`zoomFactor` 按 origin 持久化在 userData 里**。为拍放大截图调了一次 ×2，
下一次跑所有几何量全腰斩（导航区 749 → 352.54）。⇒ `run.cjs` 开机先 `setZoomFactor(1)`。

### 仍然不在范围

- 折叠（>4 层）那条路的 `…` 是 `<n-popover>`，FLIP 能否拿到它的 `el` 仍未验证。
- 角标"消失"（当前段换人时旧角标被摘）仍是瞬时的：伪元素没有"删除动画"可用。

---

## 第六轮：`videos` 是**纵向**在跳（"从上跳到下"）

第五轮之后主人说：`F: › videos › a` → `F: › videos` 时「高亮的 videos 会跳一下，
它根本不需要重新渲染，最多就是从灰色变成高亮不可点」，并补充 **"从上跳到下"**。

前五轮我量的全是 `left` —— **纵向一次都没量过**。补上后一次命中。

### 真根因（一行）

当前段模板里有 `<n-spin v-if="loading && i === last" :size="12" style="margin-left:8px" />`：
**转圈是当前段的一个子元素**，一插进 `.n-tag__content` 就把文字顶上去，`loading` 结束后再掉回来。

```
场景⑤ 3→2 期间 loading=true
  加载中   videos  w=47.36→47.36  h=28→28   **文字dy = 0 → -7**   子转圈=2
  加载完   videos  w=47.36→47.36  h=28→28   **文字dy = -7 → 0**   子转圈=0
```

**tag 的 rect 完全没动**（高 28、顶 16）—— 所以我前五轮量 tag 的量法永远看不到它；
字是**在 tag 里面**被挤走的。这就是"从上跳到下"：导航时被顶上去 7px，取数完成后掉回来 7px。

顺带证明这个转圈是**纯副作用**：它对宽度贡献 **0.00px**（47.36 不变）⇒ 连"在转"都没人看得见，
唯一实际效果就是把这一格挤变形。

### 改了三处

1. **删掉面包屑里的 `n-spin`**。它是重复的第二个指示器 —— `enterScreen` / `onBack` 里
   `loadingBar.start() / finish()` 一直在跑，顶部那条进度条才是正经位置。
   若要恢复"这一层在加载"的可见信号，请在**网格区**做，别塞进面包屑。
2. **去掉 `.crumb-current` 的 `font-weight: 500`**。它是这里唯一**会让字形整体重画**的东西；
   颜色只是重新上色。灰 → 亮本来就够（浅色 `#61666d → #18191c`，深色 `#8f8f8f → #ededed`）。
   现在当前段的差别只剩：**亮一档 + 光标 default**（= 主人说的"灰色变高亮不可点"）。
3. **角标入场只淡入，去掉 `scale(0.7→1)`**。18px 的小胶囊上再叠一层"胀出来"的运动，
   属于"换层时还有东西在动"；角标是纯信息，不值得动。

### 另外量到的（排除项，别再怀疑这些）

| 怀疑 | 实测 | 结论 |
|---|---|---|
| 字重 400→500 改字宽 | Geist 变体 canvas 量：`videos 41.71 → 41.71`，差 0 | 与位移无关 |
| 字重改字体垂直度量 | `fontBoundingBoxAscent/Descent` 400/500 都是 `14/4` | 与位移无关 |
| 角标槽 / padding / flex 换人 | `F:` 与 `videos` 的 left / width / top 全程恒定 | 与位移无关 |
| 幽灵占位 | 幽灵是 `position:absolute` 且宽高钉死 | 不参与布局 |

### 这一轮的方法论教训（重要）

**只量一个轴 = 没量。** 前五轮把 `left` 量到小数点后两位、把 FLIP 的 `t0` 判据都建起来了，
却从来没量过 `top` 和"文字在自己格子里的偏移" —— 而真正的 bug 正好在纵向、在 tag **内部**。
下一轮开始：位移探针必须同时采 `left / top / width / height`，并且**采到叶子节点**
（只看容器的 rect 会漏掉"容器没动、内容被挤走"这一类）。

---

## 第七轮：底部状态条「挂上 / 摘掉」也要有动画

**需求原话**：「换封面底部的操作栏渲染和卸载时也要有动画效果」。

### 先说清楚是哪一条

`换封面`（`picking`）与扫描（`scanning`）**共用**页面底部那一条 `.scan-bar`：

```
.file-finder (flex column)
├── .header-bar
├── .image-box      flex: 1   ← 网格
└── .scan-bar-slot  ← 就是它（本轮加的壳）
    └── .scan-bar   换封面：标签 + 已选数 + 清空/退出/换封面
                    扫描中：已扫/待扫 + 取消
```

它**在文档流里**（不是浮层），而且挂在网格**下面**。所以：

- 只做淡入淡出 = **假动画**。卸载那一帧 `.image-box` 立刻长高 50px，条再自己淡出去，
  观感是"网格先跳一下，然后一条半透明的东西慢慢消失"。
- 要平滑，**高度必须跟着一起过渡**。

### 为什么用 grid 轨道，而不是 `height` / `max-height`

| 方案 | 问题 |
|---|---|
| `height: auto → 0` | `auto` 不可插值，过渡**根本不启动** |
| `max-height: 50px → 0` | 魔数。内容一变（多一条 `正在取消…` 提示）就剪错高度；写大了收得慢、像"慢慢塌" |
| `grid-template-rows: minmax(0,1fr) ↔ minmax(0,0fr)` | 零魔数，内容多高都收得干净 —— **选它** |

### 两个前提，缺一不可（第一版就是漏了第①条，一像素都没收起来）

1. 轨道必须 `minmax(0, …)`。裸写 `0fr` 等于 `minmax(**auto**, 0fr)`，
   轨道的自动最小尺寸取内容的 `min-content` ⇒ `.scan-bar` 的 `min-height: 40px` 直接把它顶死。
2. 里层 `.scan-bar` 要 `overflow: hidden`。网格项的自动最小尺寸只有非 `visible` 才归 0。

证据等级：**实测**。`docs/probes/bar-collapse/`（真 Chromium 152，结构 1:1 复刻：
flex 列 + 带 `min-height` 的内层 + 下面一个 `flex: 1` 的"网格"）——
第一版裸 `0fr`：收起后槽高 **50**、中间帧 **0**；改成 `minmax(0,…)` 后：中间帧 **12**、
槽 50 → 0、网格顶边同步上移。

### 改动

```
模板：<Transition name="fx-bar"><div v-if="scanning || picking" class="scan-bar-slot"> … </div></Transition>
样式：.scan-bar-slot{display:grid;grid-template-rows:minmax(0,1fr);overflow:hidden;flex:0 0 auto}
      .fx-bar-enter-active{transition: grid-template-rows var(--ff-dur-move) var(--ff-ease-move),
                                       opacity var(--ff-dur-hover) linear}
      .fx-bar-leave-active{transition: grid-template-rows var(--ff-dur-move) var(--ff-ease-exit),
                                       opacity var(--ff-dur-exit) linear}
      .fx-bar-enter-from, .fx-bar-leave-to{grid-template-rows:minmax(0,0fr);opacity:0}
      @media (prefers-reduced-motion: reduce){ …transition:none }
```

- **`opacity` 用 `linear`，不用 `--ff-ease-exit`**：那条曲线是给**位移**的（前重后轻），
  180ms 的淡出在 90ms 处就掉到 0.1 ⇒ 肉眼等于"闪一下"。这个坑第五轮在面包屑上踩过。
- 壳 `.scan-bar-slot` 上写 `flex: 0 0 auto`：该被压缩的是网格（`flex: 1`），不是这条。
- `.scan-bar` 原来的 `min-height: 40px` 保留，但注释改了 —— 它现在只管
  "扫描条 ↔ 挑选条换文案时别自己长高把网格顶一下"，**管不到**整条挂上/摘掉。
- 扫描条和挑选条共用同一个元素，所以动画天然是同一份；两者不会同时出现
  （进模式前会等扫描结束）。

### 结果与证据等级

| 项 | 结论 | 等级 |
|---|---|---|
| `minmax(0,1fr) ↔ minmax(0,0fr)` 在 Chromium 152 能否插值 | 能，200ms 一拍下 12 帧中间高度 | **实测**（`probes/bar-collapse/`） |
| 编译后选择器真的进了产物 | `.scan-bar-slot[data-v-*]` / `.fx-bar-*-active[data-v-*]` 都在 | **实测**（`build-css.mjs` + dev server 拉的 style 模块） |
| `npm run typecheck` | 0 error | **实测** |
| dev server | 200，且已服务到含 `fx-bar` 的样式 | **实测** |
| **真组件里**点「换封面 → 退出」是否顺滑 | —— | **静态，待真机目视** |

### 待确认（一句）

"底部的操作栏"若指的是**补封面弹层**（`AssistantCoverModal.vue`）底部那条
`.ffassist-footer` —— 它是**常驻**的，只有内部阶段块（`applyActive` / `grabActive` / 待抓取）
在 `v-if` 之间换，本体从不挂卸。要不要给那几个阶段块之间加交叉过渡，是**另一处**，等一句话再说。

---

## 第八轮：按参考件重定"拍"（面包屑 + 底部条同一个节奏）

**需求原话**：「`localhost:3000/docs/animations/inline-text-morph` 这个动效的节奏很舒服：
① 刚才的路径切换能升级成这种吗？② 还有刚才的底部操作栏出现和卸载也可以升级吗？」

### 先把它拆开（不是"感觉"，是读源码抄下来的数）

那个页面来自本地一个 Next.js 参考项目（dev server 跑在 3000），组件本体
`public/motion/inline-text-morph.html`：

- `:307` — Torph 的配置就是 **`duration: 200` + `cubic-bezier(0.19, 1, 0.22, 1)`**。
- `:141` — 库默认是 `duration: 400`，**页面故意改成一半**。所以"舒服"不等于"慢"。
- `:147`（压缩行）— 三条拍内的比例常量：退场透明度 `0.45`、进场透明度 `0.25`、
  新出现的元素透明度窗口 `0.5` 且 `delay = 0.25`。

合起来是三件事，**只有第 ③ 条我们原来完全没有**：

| # | 参考件的做法 | 我们原来 |
|---|---|---|
| ① | **一拍 200ms**：走、来、宽高变化全在同一拍里，不排队 | 进场 300 / FLIP 260 / 退场 180 —— 三拍 |
| ② | **拍内分带**：进场延迟 25% 拍、只用后 50% 拍显形（**先落位、后显形**）；退场只用前 45% 拍（**先消失、后收摊**） | 透明度跟着位移走全程 |
| ③ | **曲线不过冲**，全程单调 | `--ff-ease-enter` 是 `0.34, 1.28, 0.42, 1`，**过冲 1.28** |

第 ③ 条最关键，也最反直觉：`tokens.css` 里那条注释原本写着"进入带一点过冲（有质量感）"，
而主人觉得舒服的那份**没有一点过冲**。上一轮把 `font-weight` 去掉、把角标的 `scale` 去掉，
其实都是在往同一个方向收 —— 这一轮把曲线本身也收了。

### 改动：只动 token，两个元素自动跟着走

`src/styles/tokens.css`：

```
--ff-dur-move:  260ms → 200ms      /* 一拍 */
--ff-dur-exit:  180ms → calc(一拍 × 0.45)   /* 90ms，退场带 */
--ff-dur-badge: 180ms → 120ms
--ff-ease-move: cubic-bezier(0.16,1,0.3,1) → cubic-bezier(0.19,1,0.22,1)   /* 与参考件逐字相同 */
新增 --ff-fade-in:       calc(一拍 × 0.5)    /* 显形窗口 */
新增 --ff-fade-in-delay: calc(一拍 × 0.25)   /* 前 1/4 拍只落位 */
```

⚠️ 三条派生量写 `calc() ` 而不是写死 90/100/50：改拍子时它们必须一起变，写死就一定会漂。
⚠️ `--ff-ease-enter`（过冲那条）**没删**，只从面包屑撤出 —— 面板/弹层仍保留过冲（有质量感）。
⚠️ 全仓 `var(--ff-dur-*)` 只有 11 处消费点，全部在 `index.vue` 的面包屑与底部条上，
所以这一改**不会波及**任何别的界面（改前先 grep 过）。

### 面包屑（`index.vue` 非 scoped 块）

```
.fx-enter-active { transform: 一拍 / move;  opacity: --ff-fade-in linear --ff-fade-in-delay }
.fx-enter-from   { opacity: 0; translateX(-6px) }
.fx-leave-active { pointer-events: none; opacity: 退场带 linear; transform: 一拍 / exit }
.fx-leave-to     { opacity: 0; scale(0.95) }
```

- 进场原来从 `-8px` 滑进来 —— 现在透明度前 50ms 是 0，那 8px 的 85% 根本看不见，
  所以缩到 6px，剩下的量刚好是"露出来的那一点归位"。
- 退场从 `translateX(-4px)` 改成 `scale(0.95)`：参考件的退场是**原地缩小**，不是"飘走"。
  幽灵的位置已经在 `pinLeaving` 里钉死，再叠横移只会读成"被挤出去"。
- 角标延迟从写死的 `120ms` 改成 `var(--ff-dur-exit)`：因为幽灵现在 90ms 就走完了，
  角标正好在它消失那一刻出现。**一个数改，两条规则自动对上。**

### 底部状态条

```
.fx-bar-enter-active { rows: 一拍 / move;  opacity: --ff-fade-in linear --ff-fade-in-delay }
.fx-bar-leave-active { rows: 一拍 / exit;  opacity: 退场带 linear }
```

退场 README：前 90ms 内容先化掉，剩下 110ms 空间慢慢收 —— 读起来是"东西没了，位置才让出来"。

### 实测（探针重跑，不是推算）

`docs/probes/crumb-motion/out.txt`（真 Chromium + 真编译 CSS）：

| 场景 | 改前 | 改后 |
|---|---|---|
| ① 根 → 一层，新段 `videos` | 300ms 淡入，t0 即开始显形 | t0 位置**已到终位**、透明度 0；t80 ≈ 0.33，约 150ms 到 1 |
| ③ 两层 → 一层，幽灵 `a` | 180ms，t80 还有 0.56 | 90ms，t80 只剩 0.26 |
| 全部四个场景 | — | **瞬跳：无**（每个位移都被 FLIP 接住）；恒存段宽度变化：**无** |

`docs/probes/bar-collapse/out.txt`（同样同步成 200ms 一拍）：
中间帧 **16 → 12**，槽 50→0；前 6 帧 `50, 50, 29.5, 15.3, 7.8, 4.1`——
一眼能看出 expo-out 的形状：**先砸下去、再稳稳收住**。

### 没做，以及为什么

参考件最狠的一点是**宽高用 WAAPI 做速度继承**（`Zt/ze`：连续变宽时下一次动画
从"当前速度"接着跑，不从 0 重启）。我们是纯 CSS transition，做不到这个 ——
要做得把面包屑的位移换成 WAAPI，等于重写引擎。**刻意不做**：连续切层的收益远小于风险。

---

## 第九轮：进「换封面」时目录的脸是硬跳的（布局动画 → 合成动画）

**需求原话**：「当点击换封面时，一些头像或者封面好像会切换样式，这些是否也可以用上？
不然没有过渡，感觉很生硬。」

### 先定位"是哪一处"

全模板只有**一处**样式随 `picking` 变（`grep 'picking ?'` 只有一条命中）：

```html
<!-- 旧 -->
<n-image v-else-if="!!item.avatar" … :style="picking ? 'width:100%;height:100%' : 'width:70%;height:70%'" />
```

即**目录的脸**：常态缩到 70%（密网格里 100% 太抢眼），进「换封面」时放到 100%（要看得清）。
带 `thumb` 的图片/视频分支**没有**任何 `picking` 相关样式，`coverBackdrop()` 也不读 `picking`
—— 所以"封面"确实没有第二处，切换的只有目录的脸。

### 为什么不能只是"给宽高加个 transition"

能加（内联样式改动同样会触发 CSS transition），但那是**布局动画**：
进/出模式时一屏可能有**几百个目录**同时改 `width`/`height`，每帧重排几百张卡片，
必然发涩 —— 而且是"进模式那一下"发涩，最不该卡的时刻。

改成**盒子恒 100% + `transform: scale(0.7 ↔ 1)`**：

- 视觉结果**逐像素相同**：`object-fit: contain` 先把图按比例缩满 100% 的盒子，再整体乘 0.7，
  等于原来"70% 的盒子 + contain"。对任意长宽比都成立。
- `transform` 不触发布局，只重绘自己那一层。
- 顺带把"内联字符串拼样式"变成"一个类"，过渡才写得进去。

```
.card-avatar          { transform: scale(0.7); transition: transform 一拍 / move }
&.pickable .card-avatar { transform: scale(1) }
@media (prefers-reduced-motion: reduce) { .card-avatar { transition: none } }
```

### 两个"是不是真的会生效"的坑（都核过了）

1. **scoped 能不能命中组件根节点？** 能。`n-image` 的根是 `<div class="n-image">`，
   父组件的 `data-v-*` 会挂到子组件根元素上。编译产物实测：
   `.image-box-item .card-avatar[data-v-*]` / `.image-box-item.pickable .card-avatar[data-v-*]`。
   先例也在同一个文件里：`.n-image.can-preview { cursor: pointer }` 就是这么写的。
   ⚠️ 但 `n-image` **内部**的 `img` 拿不到这个属性，那层仍然必须 `:deep()` —— 两件事别混。
2. **`v-memo` 会不会拦住重渲染？** 依赖里已经有 `picking && isPickable(item)`，
   而 `isPickable = type==='image' || (folder && !!avatar)` —— 正好覆盖"会渲染 `.card-avatar`"
   的那批元素，所以类会跟着变。
   ⚠️ 已知边角（**不是本轮引入**）：`type==='video'` 但**没有** `thumb`、只有 `avatar` 的元素
   会走 `.card-avatar` 分支，却不满足 `isPickable` ⇒ memo 命中 ⇒ 它不跟着缩放。
   改前改后行为一致（改前也需要重渲染才会换内联宽度），只是现在表现成"停在 70%"。

### 证据等级

| 项 | 等级 |
|---|---|
| 全模板只有一处 `picking` 相关样式 | **实测**（grep） |
| 编译后的选择器文本 | **实测**（`build-css.mjs` 产物） |
| 组件根节点带 `data-v-*`（Vue scoped 规则 + 同文件先例） | **静态** |
| 真机上 0.7→1 是否顺、几百个目录时会不会卡 | **待目视** |

⚠️ 如果一屏目录特别多时这一下反而发涩，退路不是回内联宽高，而是**只对进入可见区域的卡片做**
或者干脆去掉缩放（`tokens.css` 里把 `--ff-dur-move` 用到这条上就是唯一开关）。

---

## 第十轮：方向键高亮（焦点环）—— 参考件的拍**搬不过来**，能搬的是结构

**需求原话**：「方向键高亮选中能不能也上这种效果？」

### 先把真实节拍查清楚（原来那条注释引错了对象）

`index.vue` 的 `.image-box-item { transition: transform .08s ease-out }` 上面写着
「必须短于方向键连发间隔（usePreview 的 `KEY_REPEAT_MIN_MS = 100ms`）」—— **错的**：

- `usePreview.KEY_REPEAT_MIN_MS = 100` 是**预览层翻页**的节流（`usePreview.ts:218`）。
- 真正管网格光标的是 `useGridCursor.MOVE_REPEAT_MIN_MS = 60`（`useGridCursor.ts:419`）：
  长按 ≈16 格/秒，**且只节流 `e.repeat`**（单击零延迟，见 `:464`）。

注释已改。这个数决定了这一轮的全部结论。

### 所以 200ms 一拍在这里是错的（不是"不好看"，是"会坏"）

长按方向键每 60ms 走一格。若把环的过渡设成一拍 200ms：

- 每一个环都画不完就被下一次移动接管 ⇒ 任何时刻屏幕上有 **3 个半透明的环**；
- 用户正在"用方向键找那一格"，而"哪一格是当前"恰恰靠环的**存在感** ⇒ 精度丢失。

项目自己已经踩过一次同一个坑：`.08s` 就是从 `.18s` 改下来的，理由写得明明白白
「每次过渡都跑不完就被下一次打断，快移时等于没有反馈」。

**参考件能给的是结构，不是时长**：

| | 参考件 | 这里 |
|---|---|---|
| 进场 | 一拍的后 50% 显形（因为它没有"每 60ms 重来一次"这回事） | **60ms**（= 一格的时间，必须画得完） |
| 退场 | 前 45% 拍消失 | **`--ff-dur-exit`**（同样的 45% 概念，只是拍子按 60ms 那格算不出来，取 90ms） |
| 位置 | 字形自己会移动 | 环**从不移动**（每张卡各画各的），所以"位移"这一项根本不存在 |

### 改了两处

```
.card-cover              { transition: outline-color/width/offset + box-shadow  → 退场带 }
.image-box-item.cursor   .card-cover { transition: … → 60ms }   /* 进场覆盖 */
```

- **进场**：环从卡片自带的 1px 发丝线长到 3px 高亮、留缝从 -1px 撑到 2px、阴影淡入，60ms。
  原来是零过渡的"啪一下贴上"，现在能看出它是"长出来的"，但仍在**一格之内**画完。
- **退场**：同一个过程反着来，用退场带（90ms）。这是本轮能感知到的主要变化 ——
  从 A 挪到 B 时，A 的环不再瞬间消失，而是**缩回卡片边框里**；两张卡之间从"硬切"变成"交接"。
- 三个属性都能插值：`outline-width`/`outline-offset` 是长度，`outline-color` 是颜色；
  `box-shadow` 从 `none` 到实体阴影 Chromium 按"全 0 透明"插值，不会跳。

### 刻意没动的

- `.image-box-item` 的 `transform: .08s`：`scale(1.012)` 是 1.2%，改 60/90/200 都看不出来。
- `.card-title` 的 `color .15s`：**悬停共用同一条过渡**，动它等于顺手改 hover 的手感 —— 不碰。

### 刻意不做的：让环"滑"过去

最像参考件的做法是**共享一个环元素 + FLIP 位移**（环从上一格滑到下一格）。**否决**：
环是**位置信号**，滑动天生迟到。单击时它好看，长按时环会一路追在光标后面 ——
把"我现在在哪一格"这件事变模糊，正是这一格存在的唯一理由。

### 证据等级

| 项 | 等级 |
|---|---|
| 真实连发间隔 60ms（`MOVE_REPEAT_MIN_MS`，只节流 `e.repeat`） | **实测**（读源码） |
| 编译后两条规则：`.image-box-item.cursor .card-cover[data-v]`（0,4,0）> 基类（0,3,0） | **实测**（`build-css.mjs` 产物），所以不依赖书写顺序 |
| `typecheck` 0 / dev 200 | **实测** |
| 真机上按方向键的手感 | **待目视** |

⚠️ 60ms 是"几乎感觉不到"的时长。如果主人觉得还是硬，**加长进场**就是错的（会开始追不上），
正确的下一步是把环换成"共享元素 + 瞬时定位、只淡入淡出"的写法 —— 但那要先证明长按时不糊。

---

## 第十一轮：网格"整块换内容"的溶解入场（加载 / 密度；筛选**刻意不做**）

**需求原话**：「卡片的加载，过滤框筛选和视图密度的切换能不能也如此丝滑？有过渡？
会不会破坏现有功能或者产生新BUG？带来性能问题？」——四个问题，逐条答。

### 先把三件事分开：它们的"换内容频率"差三个数量级

| | 触发频率 | 一次换掉多少 | 结论 |
|---|---|---|---|
| 换层加载 / 首屏铺满 | 用户点一次 | 几百张**全部**（key 全换） | 做 |
| 切视图密度 | 用户点一次 | 不换内容，**纯重排** | 做 |
| 过滤框筛选 | **每个按键** | 几十~几百张进出 | **不做** |

### 为什么是"淡进来"，而不是"淡出去再淡进来"

这三件事都是**一帧之内把整块内容换掉**：旧内容在同一帧就没了，没有可淡的东西。
所以只能让新内容从 0 淡进来 —— **跳跃发生在"还看不见"的那一帧**，读起来就是一次溶解。
（这也是为什么它和面包屑那套"退场 45% 带"不冲突：那边有"旧内容"可以退，这边没有。）

### 实现：`src/views/FileFinder/gridDissolve.ts` + 一个 watch

```
watch([dataSource, gridCols], () => dissolveGrid(imageBox.value), { flush: 'post' })
dissolveGrid(el) → el.animate([{opacity:0},{opacity:1}], { duration: --ff-dur-move, easing: --ff-ease-move, fill: 'backwards' })
```

- **只挂两个源**：`dataSource`（换层/首屏）、`gridCols`（密度）。**刻意不含 `searchText`**。
- 时长/曲线从 `tokens.css` 读（`getPropertyValue`），不写字面量 —— 和面包屑、状态条同一拍。

### 为什么不是 `<TransitionGroup>` / 每张卡一个 `animation`

- 一次换层是**几百张同时进出**：几百次 FLIP 测量 + 几百个合成层；筛选更是**每个按键**来一次。
- `<TransitionGroup>` 还要给每张卡加/摘类，那会和 `v-memo` 的跳过逻辑打架
  （memo 命中的卡片根本不参与 patch，过渡类加不上，结果是一半动一半不动）。
- `.image-box` 是**滚动容器**，节点身份不能换（换层要恢复 `scrollTop`，
  `useGridCursor` 也按这个节点量几何）⇒ 也不能用 `:key` 重挂来触发入场。
- ⇒ 只剩"容器上跑一个动画"这一条路，成本 = **1 个动画**。

### 会不会破坏功能 / 产生新 BUG

风险**只有一个**，而且很明确：这个容器上任何**几何**属性（`transform`/`width`/`height`）
都会污染 `getBoundingClientRect`，而 `probeLayout` 分行、定位、滚动恢复全都要读它。
所以模块第一行规矩就是：**只碰 `opacity`**。

其余交互核对过：
- `.image-box.is-locating`（定位时把非焦点卡压到 0.3）走的是**子元素**的 opacity，与容器叠加，不冲突；
- `prefers-reduced-motion` 直接整段不跑（不是跑到一半停）；
- 失败分支 `dataSource = []`（notFound / 清空根目录）也会触发一次淡入，那是**终态**，不会"闪两下"；
- 正常导航里 `dataSource` 每次只赋值一次（`fetchFolder` 是唯一写入口），不存在连触发。

### 会不会有性能问题

- 换层：**一个**动画，一个合成层，200ms 后自动消失。不是几百个。
- 唯一新增开销：每次触发多一次 `getComputedStyle`（读两个自定义属性），可忽略。

### 实测（`docs/probes/grid-dissolve/`，真 Chromium 152 + 真 Vue + 真模块）

判据不是"看起来淡了"，而是**"内容已经换完、但还没有帧被画出来的那一刻，透明度是多少"**：

| | 那一刻的透明度 | currentTime=0 | =100ms（半程） | =200ms |
|---|---|---|---|---|
| 实际实现 | **0** | 0 | 0.98 | 1 |
| 对照：不写 `fill` | 0 | 0 | 0.98 | 1 |

⇒ 内容是新的、画面还没画，此时透明度已是 0 ⇒ **跳跃落在看不见的那一帧**，成立。
⇒ 顺带修正一条我自己的错误主张：`fill: 'backwards'` 在这版 Chromium 上**不是必需的**
（动画一创建就进入 current，不是 pending）。保留它只为把"未开始期间显示什么"钉死成首帧。

⚠️ 探针第一版用 rAF **逐帧采样**，两次跑出 `0` 和 `0.41` 两个答案 —— 这个窗口是 offscreen 的，
rAF 会被合并/丢帧，"第几帧"根本不可信。改成 `await nextTick()` 后**同步读**才稳定。
这条对以后所有"帧级"探针都成立。

### 筛选为什么不做（不是"懒得做"）

- 它的节奏是**每个按键**。在那个频率上，任何过渡都不是"丝滑"，是**闪烁**——
  用户打字时会看到内容一直在半透明里泡着。
- 想让"剩下的卡滑到新位置"就必须 FLIP 几百张，且每个按键都来一次 ⇒ 打字必卡。
- 而且筛选的语义本来就是**瞬时**的：你在找一个名字，界面应该立刻只剩它。
  参考件里"退场只占一拍 45%"那条也没法用 —— 它的退场是"一次一个元素"，这里是"一次几百个"。

### 证据等级

| 项 | 等级 |
|---|---|
| 换内容前一刻透明度 = 0（同构接线：真 Vue + `flush:'post'` + 真模块） | **实测** |
| 曲线：100ms 已到 0.98（expo-out） | **实测** |
| `typecheck` 0 / dev 200 / 模块能被 dev 解析 | **实测** |
| 真机上换层、切密度的手感；几百张时是否掉帧 | **待目视** |

---

## 第十二轮：方向键滚到边界时，单次平滑 / 长按瞬时

**需求原话**：「方向键导致的可视区滚动能否也带上丝滑的滚动效果？你看下是用原生还是动效，
注意性能和顺畅性，还有滚动的速度。」

### 先量，再选（`docs/probes/scroll-smooth/`，真 Chromium 152）

| 场景 | 结果 |
|---|---|
| 单次 150px（一格） | 到位 **210ms** |
| 单次 600px（四格） | 到位 **415ms** |
| 轨迹（150px，每约 40ms 取一点） | `0 → 16 → 96 → 136 → 148 → 150`（45/88/131/174/219ms） |
| 长按：每 60ms 追加一格，**平滑** | 每步落后 `150, 242, 272, 393, 442, 511, 572, 636` px |
| 同上，追平情况 | 最后一次追加后 600ms 仍在 **714 / 1200** ⇒ **根本没追平** |
| 长按：每 60ms 一格，**瞬时**（现状） | 每步落后 `0, 0, 0, 0, 0, 0, 0, 0` |

⇒ 判据很干脆：**平滑版在长按时最大落后 636px，一格才 150px ⇒ 光标早就被滚出视口了。**
所以不能一刀切，只能按"这一次移动是不是人手点的一下"分流。

### 分流：`e.repeat` 就是那个判据

`onGridKeydown` 里本来就有 `if (e.repeat)` 的节流（`MOVE_REPEAT_MIN_MS = 60`），
它描述的事实和这里要的完全一样 —— 于是放在一起，顺手把 `!e.repeat` 传下去：

```
moveCursor(dir, !e.repeat) → focusCursor(key, { smooth }) → scrollIntoViewIfNeeded(key, smooth)
```

- **单次按键** → `behavior: 'smooth'`，一格 210ms（正好落在我们"一拍 200ms"的同一量级）。
- **长按** → `behavior: 'auto'`，和原来完全一样（瞬时、落后 0）。

### 为什么用原生，而不是自己在 rAF 里写 `scrollTop`

1. **性能**：长按/换层的同一帧里，`probeLayout` 要对几百个格子读 `offsetTop`
   （`rowTops` 滚动一次就失效）。把滚动也塞进我们自己的 rAF，等于在**最忙的那一帧**再加一份写入。
   原生滚动跑在 Blink 自己的滚动动画里，不抢这份预算。
2. **正确性**：`scrollIntoView` 会替我们处理格子的 `scroll-margin-block`（外圈那 6px 环让位）。
   自己算 `scrollTop` 就得把这层 margin、以及"元素相对滚动容器"的换算再实现一遍 ——
   这个文件里已经有一条教训写着"用 offsetTop 就得再换算 scrollTop，多一处易错"。
3. **打断**：单次平滑还在跑时用户滚了滚轮，原生会**自动让位**给用户输入；
   自绘的话要自己挂 `wheel`/`pointerdown` 去取消，少一个就是一个"抢滚动"的 bug。

### 为什么不用 CSS `scroll-behavior: smooth`（一行搞定但会炸）

它对这个滚动容器是**全局生效**的，会顺手把 `onBack` 的 `scrollTo(恢复 scrollY)` 和
`enterScreen` 的 `scrollTo(0, 0)` 一起变成动画；而它们后面紧跟的**"回读确认"是当帧读
`scrollTop` 的**（`index.vue` 里那段"数据第一条 === DOM 第一条"的判据）⇒ 会读到动画中间值。
⇒ 只在这一个函数里逐次传参，不碰 CSS。已 grep 全仓：没有别处写 `scroll-behavior`。

### 顺手对齐的一件事：末行/首行的强制对齐也要带 `behavior`

原来那两句是 `box.scrollTop = 0` / `= box.scrollHeight`（瞬时赋值）。它们会**覆盖**
上一行的 `scrollIntoView` ⇒ 不一起改成 `scrollTo({ top, behavior })` 的话，
首/末行的单次移动会是"平滑刚起步就被一句瞬时赋值掐掉"，等于没做。

### 谁**不**受影响（全部保持瞬时）

| 调用点 | 为什么保持瞬时 |
|---|---|
| `revealAndFlash`（预览层飞回来定位） | 可能跨几百行，415ms+ 的滚动配 600ms 的高亮窗口不合适；而且是已有行为，不在这次需求里 |
| `onItemClick` / 换封面点选 | 鼠标点的格子本来就在视口内，滚不动 |
| 缩放/切密度后的 `scheduleEnsureVisible` | 布局刚变，等 150ms 再滚；这时要的是"立刻归位"，不是动画 |
| `onBack` / `enterScreen` 的 `scrollTo` | 见上：后面有当帧的回读确认 |

`focusCursor` 的 `smooth` 默认 **false**，只有 keydown 那条路径显式传 `true`
⇒ 上表全部不用改，也不会因为"以后有人调 focusCursor"而悄悄变成动画。

### 减少动效

`prefers-reduced-motion: reduce` 时一律回落到 `auto`。⚠️ 原生 `behavior: 'smooth'`
**不会**自己降级，必须自己判（`prefersReducedMotion()` 每次现读，不缓存）。

### 证据等级

| 项 | 等级 |
|---|---|
| 单次 150px = 210ms / 600px = 415ms | **实测**（`probes/scroll-smooth/`） |
| 长按平滑落后 636px、600ms 后仍未追平 | **实测** |
| 长按瞬时落后 0 | **实测** |
| 全仓没有 `scroll-behavior` 规则 | **实测**（grep） |
| `typecheck` 0 / dev 200 | **实测** |
| 真机手感（单次那一下是否"迟"、长按是否顺） | **待目视** |

⚠️ 速度是原生按距离给的，不可调。若嫌 210ms/格偏慢，唯一出路是自绘 rAF（换来可调时长，
但失去上面三条）。先看真机，别提前换。
