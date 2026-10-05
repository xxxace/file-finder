# crumb-clip · 面包屑 `.crumb-text` 顶部被 overflow 裁切

**复跑**：`bash docs/probes/crumb-clip/run.sh`（先重建真实 scoped CSS，再重建 `out.txt`）
**用什么跑**：真 Chromium（无头 Electron）+ 真 naive-ui + **真实编译产物** CSS
（`../header-width/css-real.generated.css`，由 `build-css.mjs` 从 `index.vue` 的 `<style scoped>` 编译）。

## 根因（实测）

naive-ui 的 `.n-tag { line-height: 1 }` **继承**进 `.crumb-text`。而省略号的前置条件是
`overflow: hidden` —— 它的**裁剪盒就只有 `1em` = 14px**，比字体自己的内容区（实测 **16~20px**）还矮。
字形墨迹因此被压在裁剪边界上：

- 应用字体链下墨迹顶到裁剪盒顶的余量只有 **0~1px**（刀锋状态）；
- **换主字体就跑出盒外** ⇒ 实测 `Courier New` 下顶余量 **-0.5px**，相对 tag 顶第 6 行（裁剪盒顶在 7px）**被整行切掉**。

⇒ 用户的"顶部 1-2px 被裁"= 这个刀锋状态落到被裁那一侧。**加粗**让被切的那一行笔画更粗、更显眼；
**省略号**提供了那个 `overflow:hidden` 裁剪盒 —— 两者叠加才看得见，但病根是 `line-height:1`。

## 判据（为什么不能"看盒子"）

1. 字形墨迹的溢出（ink overflow）**不进** `scrollHeight` ⇒ 量盒子永远量不到，必须像素级；
2. 被裁时剩下的墨迹**正好从裁剪边界开始** ⇒ "墨迹顶 vs 盒顶"在被裁的渲染上永远读到 0，看不出丢了东西；
3. 唯一可靠对照 = **同一位置、只把裁剪盒撑大**：`padding` 撑开 padding-box（= overflow 的裁剪边界）
   + 负 `margin` 抵消布局 ⇒ 两列的像素差就是被裁掉的墨迹。`out.txt` 里 ①② / ③④ 就是这一对。

## 结论（`out.txt`）

| 列 | 说明 | 被裁组合 |
|---|---|---|
| ①② | **修复前**（显式写回 `line-height:1`） | **4/20** —— `courier`：顶行被切(28px @ 6~6px)；`lh09`：顶+底被切 |
| ③④ | **当前 scoped CSS**（含修复） | 20 个正规组合 **0/20**（只剩 `lh09` 这个**故意**把盒子压到 0.9em 的对照） |

- 顶余量：`chain / 新建文件夹` **0.5px → 7.5px**；`courier / 新建文件夹` **-0.5px → 6.5px**
- `line-height` **14px → 28px**（= `--n-height`）；`tag` 高**恒 28px**（零布局影响，行盒居中 ⇒ 字形位置不变）
- 横向**省略号行为不变**（`text-overflow` 仍是 `ellipsis`，水平截断判定未变）
- `lh09` 行 = 灵敏度实验：把裁剪盒压到 0.9em（12.6px），**必然**被切 ⇒ 把"盒子比墨迹矮"这个机制变成可见结果

## 别重犯的三个坑

1. 截图框把**上一行的标签文字**框进来 ⇒ 差异全是标签造成的（扫描区间要排除标签行与 tag 上下边框）；
2. 旋钮挂在 `.nav-zone.k-*` 上，而 `.nav-zone` **漏了 `data-v-probe`** ⇒ **所有旋钮静默失效**，
   连报三轮"0 裁切"（真实 scoped CSS 与探针覆盖都要求那个属性）⇒ 每轮先看「旋钮生效校验」；
3. 窗口高度不够 ⇒ `capturePage` 抛 `UnknownVizError`（行数 × 行高必须装得下）。
