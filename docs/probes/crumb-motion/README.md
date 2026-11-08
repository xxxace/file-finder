# 探针 · 面包屑换层时的位移（逐元素 left / width）

**一句话**：把"面包屑跳动"变成数字 —— 谁动了、动多少、有没有过渡接住。

```bash
bash docs/probes/crumb-motion/run.sh     # 输出写 out.txt
```

零读盘：夹具是写死的假路径，不碰 `searchCache.db`。

## 判据（只有一条，但足够）

Vue 的 FLIP 在 `onUpdated` 里**同步**写 `transform: translate(dx,dy)`，
而 `nextTick()` 正好落在 post-flush 之后 ⇒ 拿 `t0` 这一帧的 `getBoundingClientRect()`：

| `t0.left` | 含义 |
|---|---|
| `== before.left` | 被 transform 拉回原位了 ⇒ **会滑过去** |
| `== 最终位置` | **一跳到位，没有任何过渡接住它** ← 就是"跳" |

配套四条：**恒存段的 width 变化**（"只多了 a"要求前段宽度不变）、
**按钮是不是同一个节点**（换文案 ≠ 换节点）、
**离场元素的 `opacity` 序列**（退场必须也有动画 —— enter 有 300ms 而 leave 是 0ms
就是"进正常、退会跳"的全部原因）、
**`top` 与 `文字dy`**（纵向）。

⚠️ **必须采到叶子节点**：容器（`.crumb`）的 rect 不变，**不代表里面的字没动**。
真实踩坑：当前段里的 `<n-spin>` 把文字顶上去 7px，而 tag 的 `w/h/top` 全程恒定 ——
只量容器的话这个 bug 永远看不见（前五轮就是这样漏掉的）。
`文字dy` = `.crumb-text` 的 top 减去它所在 `.crumb` 的 top。

## 四个场景

`F:` ↔ `F: > videos` ↔ `F: > videos > a`，覆盖 1↔2↔3 段两个方向。
另有两条专项：
- **⑤** 3→2 期间 `loading=true`（量当前段里的转圈 / 任何"插进当前段的子元素"）
- **⑥** 字重 400→500 的字宽与字体垂直度量（真 `Geist-Variable.woff2` + canvas 量）

并写出两张退场进行中的截图：`shot-leave-90ms.png`（1×）、`shot-leave-zoom.png`（窗口 zoom ×2）。

## 四个坑（踩过，别重犯）

1. **复刻件必须跟着实现改** —— 探针模板是自己抄的一份，改了 `index.vue` 不同步 = 量到旧实现。
   连 `@before-leave` 这种新钩子也要一起抄。
2. **`id` 不能用文字** —— `'btn:' + 文字` 会把"同一节点换文案"报成"节点被替换"。
   用页面里给元素打的持久 `__pid`。
3. **伪元素没有几何** —— `getComputedStyle(el,'::after')` 只有 `content`。
   验"角标有没有被 `overflow:hidden` 裁掉"只能用**命中测试**（伪元素算在生成它的元素身上）。
4. **`zoomFactor` 按 origin 持久化**在 userData 里 —— 拍过放大截图之后，下一次跑所有几何量腰斩
   （导航区 749 → 352.54）。`run.cjs` 开机先 `setZoomFactor(1)`。

## 覆盖边界

- 只覆盖 **≤3 段**（不触发折叠）。折叠（>4 层）那条路上的 `…` 是 `<n-popover>`，
  FLIP 能不能拿到它的 `el` **未验证**。
- 根 chip 是**定宽替身**（导航期间它本来就不变）。真机上 `loading` 会在当前段内部插
  `n-spin` —— 在当前段内部，不推邻居。
- **观感仍然只能真机目视**；本探针只证明"该动的动、不该动的一个像素都没动"。
