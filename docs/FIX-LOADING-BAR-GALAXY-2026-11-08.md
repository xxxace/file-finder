# 顶部进度条 = galaxy 轨道（Canvas 逐格照抄）· 2026-11-08

## 一句话
naive `n-loading-bar` 的**视觉层**由一块 Canvas 覆盖物承担，逐格跑参考的 `drawPixels()`：
深靛底 + 六色像素点（左疏右密）+ 前缘三层光晕与放射粒子。**去掉的只有大脑图标。**
厚度 12px（主人自己在 `tokens.css` 里定的）。前两版（CSS 渐变 / CSS 点阵）都被否，原因见下。

## 文件
| 文件 | 角色 |
|---|---|
| `src/components/GalaxyLoadingBar/draw.ts` | **纯逻辑**：逐格照抄 `drawPixels()`。无 DOM，可被探针直接跑 |
| `src/components/GalaxyLoadingBar/index.vue` | Canvas 覆盖物：每帧读 naive 的条宽/不透明度，喂给 draw |
| `src/App.vue` | 挂 `<GalaxyLoadingBar />` + provider 的 `container-style` |
| `src/styles/tokens.css` | L2 组 `--ff-bar-h/-base/-px-1..6/-glow` |
| `src/styles/naive-theme.ts` | `LoadingBar: { colorLoading: --ff-bar-base, height: --ff-bar-h }` |
| `docs/probes/galaxy-bar/pattern.mjs` | 只读探针：假 ctx 录 `roundRect`，验图案结构（**不需要浏览器**） |

⚠️ 已删除 `src/styles/loading-bar.css`（CSS 点阵方案，作废）。

## 为什么前两版都不像（这是本文件最该记住的部分）
| 版本 | 做法 | 死因 |
|---|---|---|
| 一版 | 4px 高 + 蓝渐变 + 点阵延迟 1.5s | 高只够 **1 排**点 ⇒ 本质虚线；延迟 1.5s ⇒ 快切永远看不到 |
| 二版 | 14px + CSS `repeating-gradient` 四色 | 每一格**一模一样**（同 alpha、同色序、无空格）⇒ 是一块规整织物 |
| 三版 | Canvas 逐格 | 每格有自己的 seed（相位）、自己的颜色、左疏右密的密度 |

**判据**：galaxy 的识别特征是「**空格 + 明暗不一 + 左稀右密**」，不是「彩色点阵」。
只要每格一样，怎么配色都不像。CSS 做不到逐格差异，这是必须上 Canvas 的**唯一**理由。

## 关键实现
- **不接管进度**：naive 仍是唯一真相源（4s 缓爬 / 收尾淡出 / 出错变红）。Canvas 每帧读
  `.n-loading-bar` 的 `rect.width` 与容器的 computed `opacity`，画在同一位置。
  ⇒ 没有第二条计时器、也不需要改 `index.vue` 的任何业务逻辑。
- **几何换算**（与原版唯一差异）：原版固定 49 列 × 5 排 × 8px 格（轨道 40px）。
  这里保持「每 8px 一排」⇒ `rows = round(h/8)`，当前 12px 得 2 排、格 6px、点 3.84px。
  **改 `--ff-bar-h` 会自动重算排数与格子**，不用同步改别处。
- **空转成本 0**：`ResizeObserver` 盯条（display 切换与宽度动画都会报尺寸变化）⇒ 只在有变化时
  唤醒 RAF；条藏起来时循环自己退出并清屏。childList 观察只负责"第一次出现时把 ResizeObserver 挂上"。
- **前缘光晕（替代大脑）**：三层同心径向渐变 + 26 条射线的放射性粒子。
  原版的这团光是大脑图标的 `drop-shadow(#8351ff / #7543fc70)`，**中心是被图标自己顶亮的**；
  图标去掉后只画一圈紫 = 一坨「死紫」（2026-11-08 主人原话「不是那种死紫色」）。所以必须三层：
  `#d9ccff`（亮心 α.92, r=0.75h）→ `#8351ff`（中圈 α.58, r=1.5h）→ `#7543fc`（外圈 α.34, r=2.6h）。
  粒子是 `drawSparks()` 逐行照抄：26 条射线（黄金角 2.399963）× 7 点，半径 27~114（按 40px 轨道等比缩），
  六色轮转、2~2.5px 方块，`burst=exp(-time*6)` 让每次加载开头有一次爆发。
  ⇒ 画布必须比条高大出一截（`pad = barH*3`），否则光晕会被下边界切平。
- **出错态**：读到 `n-loading-bar--error` 就清空画布，让 naive 的红条干净显示。
- **减动效**：`prefers-reduced-motion` 下冻结 `time`（点阵静帧、粒子不流动），但宽度照跟。

## ⚠️ naive 的 `started` 永不重置（这是最容易踩的一脚）
`init()` 里清了 `loading/entering/finishing/erroring`，**唯独不清 `started`** ⇒ 第一次加载之后，
`.n-loading-bar-container` **永久留在 body 里**，只靠 `display:none` 藏着。两个后果：
1. **判"条还在不在"不能用元素存在性**。用存在性的症状：循环永不退出，而 `display:none` 下
   `rect.width` 是 0 ⇒ 辉光被画在 `x=0` ⇒ **左上角一团紫光常驻不散**，同时白烧一个 60fps 的 RAF
   （2026-11-08 主人抓到的就是这个）。判据必须用 **`rect.height > 0`**：藏起来时 height 也归零，
   而刚起步 `width=0` 时 height 还是 14 —— 这两个状态只有 height 能分开。
2. **后续每次 `start()` 不增删节点**，只改 display ⇒ `MutationObserver(childList)` 之后再也不触发。
   叫醒必须换 `ResizeObserver`，否则第二次加载整条不亮。
3. **`start()` 是先插一个 `display:none` 的容器、下一拍（`await nextTick()`）才显示**。
   所以 `ResizeObserver` **必须在"看不到"的时候就挂上**；写成"看得见才挂"的话，第一拍
   `rect.height === 0` 直接 return ⇒ 观察器永远挂不上，此后只能靠别处碰巧往 body 插节点时
   被唤醒。症状：**要来回切好几次目录，像素层才出现**（2026-11-08 主人抓到的第二个坑）。
   正确顺序：`attach()`（先挂观察器）→ `measure()`（再看可见性）→ 启 RAF。

## 探针实测（`node --experimental-strip-types docs/probes/galaxy-bar/pattern.mjs`）
```
geometry    rows=2 cell=6.00 cols=198 dot=3.84
cells       183 / 396   空白率 54%
cell alpha  0.05 ~ 0.86
colors      #dc8cd5:31 #7061b5:38 #f4c1eb:26 #6656a0:37 #b3a3e8:19 #80d5d8:32
density     左 20% | 中 41% | 右 78%
glow rings  3 层：r=31 α=0.34 | r=18 α=0.58 | r=9 α=0.92
sparks      182 个，半径 8 ~ 36px，色 6 种
```
⇒ 排数、六色、空格率、密度梯度、三层光晕的「外淡内亮」、粒子铺开范围全部对得上参考。
**它证明不了好看**，只能证明结构没跑偏。

## 待真机验收
1. 进目录：深靛条拉出，六色像素点散落闪烁、右侧密、右端一团紫光跟着走。
2. 快速连点多层目录：不闪白、不卡顿（每帧最多约 400 个格子，实际画 180 个左右）。
3. 打开失败：红条，画布自动清空。
4. 切浅色主题：深靛条对比更强（预期）。
5. 空闲时 CPU 应回 0（RAF 已退出）。

## 已知差距
- 原版轨道 40px 高、5 排；12px 高只有 2 排。想要原尺寸质感就把 `--ff-bar-h` 调到 40（会自动变 5 排）。

## 回退
删 `<GalaxyLoadingBar />` + `GalaxyLoadingBar/` 目录 + `naive-theme.ts` 的 `LoadingBar.colorLoading`，
即回到 2px 纯色条（`--ff-bar-h` 也要一起删）。
