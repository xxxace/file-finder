# 动效学习与提取 · 2026-11-08

**目的**：把 LeiBox 三个样本的「丝滑」拆成可复刻的机制，供后续派任务时直接引用。
**结论先行**：丝滑 ≠ 曲线好看。三个样本的共同点按贡献排序是 ——
**① 同一个节点承担形变（不做两组交叉淡入）> ② 进出用不同曲线/时长 > ③ 速度驱动形变 > ④ 延迟阶梯 > ⑤ 模糊做转场遮罩 > ⑥ 弹簧积分器**。
前 4 条用纯 CSS 就能拿到 80% 的效果，第 6 条只在需要「可中断 / 可打断 / 可反演」时才必要。

样本来源（本地）：

| 样本 | 权威实现 | 动效载体 |
|---|---|---|
| 玻璃标签栏 `glass-tab-menu` | `LeiBox/src/lib/motion-core/glass-tab-menu.{js,css}` | 手写弹簧积分器 + 每帧写 inline style |
| 弹性访问申请 `bouncy-access` | `LeiBox/public/ai/packages/bouncy-access/vue.json` 内 `...Engine.js`（CSS 段） | 纯 CSS `transition` + `.is-expanded` 单类切换 |
| 分享邀请面板 `share-invite` | `LeiBox/src/lib/motion-core/share-invite.mjs` + `src/lib/ShareInvite/share-motion.ts` | GSAP timeline + 解析式弹簧缓动 |

---

## 一、六个可迁移机制

### 机制 1 · 同节点形变（最大贡献，不是曲线问题）

三个样本无一例外：**形变发生在一个始终存在的 DOM 节点上，而不是"旧元素淡出 + 新元素淡入"**。

- `share-invite`：`SHARE_INVITE_PROMPT` 明确写死禁令 —— *"同一个分享标题按钮持续存在……不能换成两个独立按钮交叉淡入"*。实现上 `gsap.set(morph, button)` 一次性 tween 掉 `left/top/width/height/paddingLeft/gap/fontSize/fontWeight/color/backgroundColor`。
- `bouncy-access`：`"同一头像节点从堆叠移动为列表，不新建两组淡入"`。CSS 里 `.avatar-1/.avatar-2` 只是换 `transform: translate(x,y)` 和 `z-index`。
- `glass-tab-menu`：`.gt-tabs` 与 `.gt-menu` 都在**同一个 `.gt-panel` 里**，靠 `scaleX/scaleY` 互相替代，不换节点。

**判据**：如果你在两个状态里写了 `v-if` / `v-show` 互斥的两个元素，就已经丢了丝滑的 70%。
代价：需要元素在两个状态下都"存在且合法"，因此布局必须用绝对定位 + transform，不能用文档流。

### 机制 2 · 非对称进出（最便宜的 20%）

`bouncy-access` 把这条直接写成注释：

```css
/* Expand: 带有 1.35 过冲的高张力弹簧 */
--spring-expand:   cubic-bezier(0.34, 1.35, 0.45, 1);  /* 0.5s */
/* Collapse: 迅速收紧不反弹的平滑曲线 */
--ease-collapse:   cubic-bezier(0.32, 0.72, 0, 1);     /* 0.35s */
```

落地手法很关键：**收起曲线写在基础选择器上，展开曲线写在状态类上**，这样同一个属性天然走两条曲线。

```css
.widget            { transition: height .35s var(--ease-collapse), border-radius .35s var(--ease-collapse); }
.widget.is-expanded{ transition: height .5s  var(--spring-expand), border-radius .5s var(--spring-expand); }
```

`share-invite` 用数值版做同一件事，且**两轴错开**：

```ts
open:  width  { k: 306.25, c: 28,      dur: 0.70, delay: 0     }
       height { k: 196,    c: 18.34,   dur: 0.86, delay: 0.057 }
close: width  { k: 400,    c: 33,      dur: 0.64, delay: 0.07  }
       height { k: 600.25, c: 43.365,  dur: 0.62, delay: 0     }
```

展开时 **宽先动、高晚 57ms**，收起时 **高先动、宽晚 70ms**，且收起两轴都比展开更硬更快。
→ 观感是"先探出去再撑开"，而不是一个矩形整体缩放。

业界交叉验证（外部资料一致）：退出必须比进入快，进入 200–300ms / 退出 150–200ms；`cubic-bezier(0.34,1.35,0.45,1)` 的 `y1=1.35` 就是过冲量，超过 1.4 会显得廉价。

### 机制 3 · 速度驱动形变（"Q 弹"的真正来源）

`glass-tab-menu` 的选中块不止平移，它还**根据瞬时速度变形**：

```js
const travel = clamp(Math.abs(selection.v) / 7);              // 速度 → 0..1
indicator.style.transform = `translateX(${selection.p*183}px) scale(${1+travel*.08},${1+travel*.25})`;
lens.style.opacity        = String(travel);                    // 运动时才出现的反光
indicator.style.background = `rgba(255,255,255,${.98-.95*travel})`;  // 越快越透明
indicator.style.boxShadow  = `0 ${7-3*travel}px ${17+5*travel}px rgba(82,77,99,${.15-.07*travel})`;
```

三个信号叠加（横向拉伸 25%、竖向拉伸 8%、变透明、阴影变远）→ 大脑读成"这个东西有质量、被拖着走、停下才落定"。
**注意上限**：拉伸封顶 25%，透明度封顶 95%，`press` 脉冲 clamp 在 `.48`。过冲不设上限就会变成橡皮糖。

**纯 CSS 的近似做法**：不用 JS 也能拿到形变感，但只能拿到"固定幅度"，拿不到"随速度变化"。这是必须付 JS 代价的地方。

### 机制 4 · 延迟阶梯（编排，不是装饰）

- `bouncy-access`：四行内容展开延迟 `.08 / .12 / .16 / .20s`（transform 用弹弓曲线 0.5s，opacity 只用 `0.3s ease` —— **同一元素的两个属性不同时长**）；收起时**全部去掉延迟**，`.1s` 内消失。
- `share-invite`：`stagger: 0.035`，总入 0.5s，起点延后 0.13s（等外壳先动）。
- `glass-tab-menu`：靠三个倒计时变量 `morphDelay=.075 / compressionDelay=.09 / contentDelay=.17`，在同一个 tick 循环里递减，不用 `setTimeout`（可被下一次点击直接打断）。

**铁律：阶梯只加在进入上，退出一律不延迟且更快。** 外部资料给的额度：每项 20–60ms，超过 6 项就不再递增（否则用户等动画）。

### 机制 5 · 模糊做转场遮罩

`glass-tab-menu` 最取巧的一行：

```js
const blur = 22 * Math.sin(p * Math.PI);   // p=0 → 0；p=0.5 → 22；p=1 → 0
```

**两端清晰、中途最糊**。它把"标签栏→六宫格"这种形状完全对不上的切换，糊掉了中途的错位感。
`share-invite` 同法：内容入 `blur(3px)→0`、面板出 `blur(5px)`。

**代价警告**：`filter: blur()` 每帧重新栅格化，面积大就会掉帧。只在 ≤ 400×400px 的元素上用；全屏转场用 `backdrop-filter` 或 View Transitions。

### 机制 6 · 弹簧积分器（只在需要"可打断"时才上）

```js
function step(state, h, stiffness, damping) {
  state.v += ((state.target - state.p) * stiffness - state.v * damping) * h;
  state.p += state.v * h;
  if (Math.abs(state.p - state.target) < .0001 && Math.abs(state.v) < .001) { state.p = state.target; state.v = 0; }
  return state.p !== state.target || state.v !== 0;   // 返回"还在动吗"
}
// 每帧把 dt 拆成 3 个子步，dt 上限 32ms
for (let i = 0; i < 3; i++) { const h = Math.min(.032, dt) / 3; moving = step(opening, h, 400, 26) || moving; }
```

为什么值得手写而不是用 CSS：**打断即续**。展开到一半点收起，`target` 变负、`p/v` 保持原值，速度自然反向，没有跳变 —— CSS transition 中途反向会有明显顿点。

配套纪律（比公式重要）：
- **只在动的时候跑 RAF**：`wake()` 起、`settle()` 停，`demo.dataset.moving` 暴露给调试。空闲零帧。
- **settle 阈值**：`< .0001` 位移且 `< .001` 速度才停，否则永远抖。
- **`prefers-reduced-motion` 直接 `settle()`**，不是把时长设成 0（设 0 会让积分器一帧跳变但保留 overshoot）。
- **给速度"踢一脚"**：`pendingKick = 17 * gap`（gap = 目标与当前的距离）。距离大时额外注入初速，才有"弹出去"的观感。

`share-invite` 走的是另一条路 —— 把弹簧**解析成缓动函数**再交给 GSAP，好处是能用 timeline 编排、能 `kill()`，坏处是不能中途反向（所以它每次先 `transition?.kill()` 再从当前值重来）：

```ts
export function springEase(stiffness: number, damping: number, duration: number) {
  const decay = damping / 2;
  const frequency = Math.sqrt(stiffness - decay * decay);
  return (progress: number) => {
    if (progress === 0 || progress === 1) return progress;
    const time = progress * duration;
    return 1 - Math.exp(-decay * time) *
      (Math.cos(frequency * time) + decay / frequency * Math.sin(frequency * time));
  };
}
```
⚠️ 前提 `stiffness > (damping/2)²`，否则 `Math.sqrt` 出 NaN → 整条缓动静默失效（本项目踩过同类坑，见 MEMORY §三.0）。

---

## 二、两条与我们直接冲突的既有事实

1. **我们已经在用 View Transitions 做主题切换**（`src/styles/theme-transition.css` + `theme/transition.ts`，圆形扩散）。
   ⇒ 主题切换这条线**不要**再往里塞 CSS 动画，快照层会叠灰雾。动效改造要绕开它。

2. **左轨提示胶囊已经是"同节点滑动"**（`RailTip.vue` + `useRailTip.ts`，`0.43s cubic-bezier(.16,1,.3,1)`）。
   ⇒ 这条已经是机制 1 的正确实现，是判断"我们有没有动效审美"的反例 —— 我们有，只是**没有统一成系统**。

---

## 三、全项目动效现状盘点（实测）

`grep transition|animation|@keyframes` 全 `src/`：

| 文件 | 命中 | 性质 |
|---|---|---|
| `styles/theme-transition.css` | 13 | View Transitions 相关，非传统动画 |
| `views/FileFinder/index.vue` | 8 | 全是 `.08s`–`.25s` 的 `ease`，单属性打补丁 |
| `views/Shell/RailTip.vue` | 5 | 唯一成体系的（滑动胶囊） |
| `views/Playlists/index.vue` | 3 | 零散 |
| `views/Shell/RailNav.vue` | 1 | `background-color .15s ease` |
| `views/Cache/index.vue` | 1 | 零散 |

**没有一份动效 token**：`tokens.css` 里没有任何 `--ff-dur-*` / `--ff-ease-*`。
⇒ 这是"不丝滑"的结构性原因：**每个组件各写各的时长，观感必然散**。

---

## 四、可直接搬的 token 草案（待裁决）

```css
:root {
  /* 时长阶梯 —— 按元素尺寸分档，不按组件分档 */
  --ff-dur-tap:    120ms;  /* 按压反馈、图标态 */
  --ff-dur-hover:  160ms;  /* 悬停变色，绝不位移 */
  --ff-dur-swap:   220ms;  /* 内容替换、标签切换 */
  --ff-dur-panel:  300ms;  /* 面板/弹层进入 */
  --ff-dur-exit:   180ms;  /* 一切退出，永远比进入短 */

  /* 曲线：进入带轻微过冲，退出收紧不反弹 */
  --ff-ease-enter: cubic-bezier(0.34, 1.28, 0.42, 1);
  --ff-ease-exit:  cubic-bezier(0.32, 0.72, 0, 1);
  --ff-ease-move:  cubic-bezier(0.16, 1, 0.30, 1);   /* 位置迁移，沿用 RailTip 现有值 */

  /* 延迟阶梯上限 */
  --ff-stagger: 40ms;
}
```

**过冲量取舍**：`1.35` 是样本值，`1.28` 是我给的保守值。本项目是**生产力工具**（网格里几百个封面、高频点选），过冲过大在密集列表里会晃眼。这条需要主人裁决 —— 见交付时的提问。

---

## 五、禁用清单（来自样本反面 + 外部资料一致）

- ❌ `transition: all`
- ❌ 动画 `width/height/top/left/margin`（除非用 FLIP 量过；`share-invite` 敢动 `width/height` 是因为容器只有 320px 且是唯一版面）
- ❌ `scale(0)` 出现（用 `opacity + translateY(8px)`，或 `scale(.96)`）
- ❌ 给 hover 加位移/抬升（`bouncy-access` 明确："hover 仅变颜色，不能抬升按钮或移动图标"）
- ❌ 永久 `will-change`
- ❌ 键盘触发进入动画（外部资料：键盘操作不应有入场动画）
- ❌ 只有 `@media (hover:hover)` 之外的 hover 动画（触屏会"卡住"）
- ❌ 少 `prefers-reduced-motion` 分支

---

## 六、候选改造面（按性价比排序，**未开工**）

| # | 面 | 现有 | 可拿到什么 | 代价 |
|---|---|---|---|---|
| 1 | 动效 token + 统一曲线 | 无 | 全项目观感一致，后续所有改动自动受益 | 纯 CSS，零JS，改 20 处 |
| 2 | 网格封面 hover / 选中 | `transform .08s` | 机制 2+4：悬停快、选中带过冲 | 纯 CSS |
| 3 | 预览层开合 | 无 | 机制 1+5：从缩略图位置长出（FLIP）+ 模糊过场 | 中，需量 rect |
| 4 | 视图切换（文件/清单/缓存） | 无 | 机制 1：内容区交叉位移，不是硬切 | 中 |
| 5 | 弹层（换封面/规则编辑器） | naive `n-modal` 默认 | 机制 2：改成非对称进出 | 低，覆盖主题变量 |
| 6 | 左轨提示胶囊 | 已有 | 机制 3：加速度拉伸（它已读得到目标位置，可推速度） | 低 |
| 7 | 顶部进度条 | galaxy Canvas 已重 | 已经是机制 6 纪律（RAF 启停），**不动** | — |

**⚠️ 读盘清单**：以上 7 项**全部零读盘**，纯前端渲染层，不碰扫描/缩略图/加密链路。

---

## 七、我没验证的部分（诚实标注）

- **没在真机上目视过三个样本**。以上参数全部来自源码静态阅读 + 官方 prompt，**手感结论是推理**，不是实测。若要确认，跑 `docs/motion-lab.html`（同批交付），把三套机制都做成可调旋钮。
- `glass-tab-menu` 的 `borderRadius = 73.5 + 12.5*p`，即**展开时圆角变大**（74→86px）。与 `bouncy-access` 相反（32→24px，展开更方）。两者都对，取决于"容器是否要更像胶囊"。我这条存疑，未找到判据。
- Electron 渲染层（本机 Chromium）对 `backdrop-filter` 的合成开销我**没测**。样本大量用磨砂，若我们要抄玻璃质感，必须先测 400 张封面上叠 `backdrop-filter` 的帧率 —— 这是唯一有真实性能风险的一项。
