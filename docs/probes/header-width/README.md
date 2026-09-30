# 探针 · 头部行数 / 面包屑折叠 / 单条截断

**一句话**：用真 Chromium 量「头部高度到底是常量还是内容的函数」。

## 复跑

```bash
bash docs/probes/header-width/run.sh          # 输出写 out.txt
```

（等价于 `env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe docs/probes/header-width/run.cjs`）

- **零读盘**：夹具是写死的假路径，不碰 `searchCache.db`、不 stat 任何盘。
- 页面加载的是 `node_modules` 里**真的** naive-ui UMD + `vue.global`，所以量到的是真组件 + 真 CSS。

## 两个变体的差别（就是本轮的改动）

| | `old`（改造前写法） | `new`（候选实现） |
|---|---|---|
| 左区容器 | `.hstack{flex-wrap:wrap}` | `.nav-zone{nowrap; flex:1 1 auto; min-width:0; max-width:50%; overflow:hidden}` |
| 面包屑 | 全部层级平铺，无 `max-width`、无省略 | 折叠成「首段 + `…` + 父 + 当前」；每段 `max-width:160px` + 省略号 |
| 单项 | 不设 `flex` | `.crumb{flex:0 1 auto; min-width:0}`（可收缩）· `.crumb-current{flex:0 0 auto}`（永不被压掉） |
| 工具条 | `nowrap` + `align-self:flex-end` | `nowrap` + `flex:0 0 auto`（不参与压缩） |

## 判据（`run.cjs` 里自动判定）

1. **头部高在四档窗口宽度下完全一致** ← 核心。这就是"高度是常量"的定义
2. 当前段可见（折叠后"我在哪"没被挤出屏幕）
3. 工具条不溢出

`old` 只作对照打印，不参与判定。

## 实测结果（2026-10-01，见 `out.txt`）

```
new 头部高：640→56px  800→56px  1280→56px  1920→56px     ← 常量 ✓
old 头部高：640→136px 800→136px 1280→96px   1920→56px     ← 内容驱动 ✗
new 截断段数：4/4/4/2                                     ← max-width + 省略号确实生效
当前段可见：四档全 true · 工具条未溢出：四档全 true
```

⇒ 「头部高度是用户数据的函数」这个诊断**成立**，且分区 + 折叠把它变成了常量。

## ⚠️ 已知局限（别把它当全绿）

- **列名 `顶边簇数(仅参考)` 不是"行数"**：它把**所有子孙元素**的顶边按 10px 容差聚类，
  tag 内部的 avatar/content 也会各算一次，所以绝对值偏大。它只能看**变化趋势**
  （`old` 7/7/6/5 会变，`new` 恒 5 不变）。判断"几行"请用 `头部高`。
- **窗口 < ~900px 时面包屑基本没地方**：工具条是 `flex:0 0 auto` 的固定约 600px，
  剩下的才给导航区 ⇒ 窄到这个程度时面包屑会被压成「…」。这与资源管理器地址栏的行为一致
  （它也是被压/截断，而不是换行把内容顶下去）。**没有实测具体阈值**。
- **观感（颜色、`›` 分隔符的位置）不在本探针范围内** —— 那只能真机目视。
