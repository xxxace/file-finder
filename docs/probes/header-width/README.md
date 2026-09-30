# 探针 · 头部行数 / 面包屑折叠 / 单条截断

**一句话**：用真 Chromium 量「头部高度到底是常量还是内容的函数」。

## 复跑

```bash
bash docs/probes/header-width/run.sh          # 先重建真 CSS，再跑，输出写 out.txt
```

（等价于 `node docs/probes/header-width/build-css.mjs` + `env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe docs/probes/header-width/run.cjs`）

- **零读盘**：夹具是写死的假路径，不碰 `searchCache.db`、不 stat 任何盘。
- 页面加载的是 `node_modules` 里**真的** naive-ui UMD + `vue.global`，所以量到的是真组件 + 真 CSS。

## 两个变体的差别（就是本轮的改动）

| | `old`（改造前写法） | `new`（候选实现） |
|---|---|---|
| 样式来源 | **手写复刻**（`index.html` 里的 `.old-header`）· 不带 scoped 属性 | **`css-real.generated.css`** —— 从两个 SFC 的 `<style scoped>` **真实编译**（less + scoped 转换） |
| 左区容器 | `.hstack{flex-wrap:wrap}` | `.nav-zone{nowrap; flex:1 1 auto; min-width:0; max-width:50%; overflow:hidden}` |
| 面包屑 | 全部层级平铺，无 `max-width`、无省略 | 折叠成「首段 + `…` + 父 + 当前」；每段 `max-width:160px` + 省略号 |
| 单项 | 不设 `flex` | `.crumb{flex:0 1 auto; min-width:0}`（可收缩）· `.crumb-current{flex:0 0 auto}`（永不被压掉） |
| 工具条 | `nowrap` + `align-self:flex-end` | `nowrap` + `flex:0 0 auto`（不参与压缩） |

> ⚠️ **为什么 `new` 一定要用真 CSS**：手抄一份"等效 CSS"只能证明"这套写法在普通 CSS 下成立"，
> **证明不了 `:deep()` / `:not()::before` 在 scoped 转换之后还成立**。
> 第一版就是手抄的 —— 那是个真实的验证缺口，`build-css.mjs` 是为此加的。

## 判据（`run.cjs` 里自动判定）

1. **头部高在四档窗口宽度下完全一致** ← 核心。这就是"高度是常量"的定义
2. 当前段可见（折叠后"我在哪"没被挤出屏幕）
3. 工具条不溢出

`old` 只作对照打印，不参与判定。

## 实测结果（2026-10-01，真 Chromium + 真 scoped CSS，见 `out.txt`）

```
new 头部高：640→36px  800→36px  1280→36px  1920→36px     ← 常量 ✓
old 头部高：640→196px 800→196px 1280→116px 1920→76px      ← 内容的函数 ✗
new 截断段数：3/3/3/2                                     ← max-width + 省略号确实生效
new 分隔符 ::before content：["›","›","›","›"]             ← scoped 规则命中（四档都不是 none）
new 导航区宽：640→12px  800→172px  1280→616px  1920→936px
当前段可见：四档全 true · 工具条未溢出：四档全 true
```

⇒ 三件事被同时证明：
1. 「头部高度是用户数据的函数」这个诊断**成立**（`old` 随窗口变），且已被改成常量（`new` 恒 36px）。
2. `:deep(.n-tag__content)` 与 `:not(.crumb-root)::before` 在**真实 scoped 转换后**确实命中（截断数与 `::before` content 两处独立证据）。
3. 导航区的**可用宽度**有了实测数字（见下）。

## ⚠️ 已知局限（别把它当全绿）

- **窗口 ≲ 900px 时面包屑基本不可用**（实测：640px → 导航区只有 **12px**；800px → 172px）。
  原因是**工具条固定约 580px 且不参与压缩**，剩下的才给导航区。
  ⚠️ 而工具条那 580px 里有两条**动不得**的东西：搜索框 `width:200px`（项目里明确标了"不许删"）
  与三个按钮的文案（用户已声明沿用，改名有认知成本）⇒ **这个取舍是"接受"，不是"没发现"**。
  1280px 起导航区有 616px，舒适。
- **列名 `顶边簇数(仅参考)` 不是"行数"**：它把**所有子孙元素**的顶边按 10px 容差聚类，
  tag 内部的 avatar/content 也会各算一次，所以绝对值偏大。它只能看**变化趋势**
  （`old` 变，`new` 不变）。判断"几行"请用 `头部高`。
- **观感（颜色、`›` 的位置、当前层加粗）不在本探针范围内** —— 那只能真机目视。
  本探针只证明"该规则命中了、且没把布局弄坏"。
- `old` 的样式是**手写复刻**、不是从 git 抽出来的旧文件 ⇒ 它是"等效对照"，不是"旧代码原样"。

## 附加：工具条预算（`__measureToolbar` / `__measureToolbarPlans`）

同一个页面还提供两个测量函数，用来回答"**工具条是导航区不够的元凶吗**"：

```
── 工具条预算 ──  总宽 605px = 子元素 533 + gap 72（12px × 6）
  补全这一片 90 · 重读这一片 90 · 补封面 62 · 缓存记录 34 · 角标 26 · 搜索框 200 · 刷新 31

── 形态对比（工具条宽 / 640px 下的导航区宽）──
  now 605/0(溢出)   short 507/85   short2 419/173   more 387/205
```

⚠️ **两个必须记着的坑（都踩过）**

1. **复刻件也要打 scoped 属性**：`n-input` 漏了 `data-v-probe` ⇒ 真实 CSS 里的
   `width: 200px` 不生效 ⇒ 把它量成 175px，**整张预算表偏小 25px**。
2. **"导航区 = 0 且工具条未溢出 = false" 是要读出来的信号**：它说明当前形态在窄窗口下
   **会溢出**，不是"挤一挤还能用"。第一版只看导航区宽，把这一条漏过去了。
