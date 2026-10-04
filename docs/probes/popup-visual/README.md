# 探针：多文件弹层「到底长什么样」（改前 / 改后一图对照）

复算：

```bash
bash docs/probes/popup-visual/run.sh
```

产出：`popup-before-after.png`（对照图）+ `out.txt`（两版的盒模型实测数）。

## 问的是什么

业主 2026-10-05：「这个多个文件弹出层好丑」（截图里 4 个格子长得一模一样）。
先把**丑在哪**量出来，再证明改后真的改掉了 —— 这两件事都只有真 Chromium 能答：

- 布局是继承 + 特异性的结果（`.file-item span` 有没有被网格那条
  `white-space:nowrap` / `height:38px!important` 吃掉），手抄一份"等效 CSS"正好把这个变量抄没；
- `popup-before-after.png` 用**两个 iframe** 装两套 CSS —— 两版的 `.file-item` 规则会互相覆盖，
  同一个文档里没法同时渲染。

CSS 不是手抄的：`build-css.mjs` 从活源码 `src/views/FileFinder/index.vue` 真实编译 `<style scoped>`（less + scoped 转换）。
改前那版的编译产物是 `css-before.snapshot.css`（2026-10-05 的快照）。

## 实测（`out.txt`）

| 量 | 改前 | 改后 | 说明 |
|---|---|---|---|
| `.file-item` 尺寸 | 84 × 84 | **150 × 116** | |
| `.file-cover` 盒 | **0 × 0** | 18.7 × 26 | 改前**根本没画出来**（漏了 `fiv-cla fiv-icon-*`，只剩 `blank.svg` 且无尺寸） |
| `.file-cover` 背景 | `blank.svg` | **`mp4.svg`**（按扩展名） | |
| `span` 的 `white-space` | `nowrap` | **`normal`** | 改前写在这层的 `word-break` / 多行**全是死代码** |
| `span` 盒 | 78 × 38（**单行**） | 132 × 30（2 行，名字长了就到 45 = 3 行） | 改前尾部省略 ⇒ 4 个同前缀的文件名显示成一样的 `[TST-593…` |
| 大小那一行 | 无 | `1.29 GB` / `1.18 GB` / `2 MB` / `43 KB` | |
| popover / 列表宽 | — | 664 / 636 | 4 个一行（`max-width: min(660px, 88vw)`） |
| 超长名（第 4 个样本） | — | `clientHeight 45 < scrollHeight 60` + `-webkit-line-clamp: 3` | 多行 `…`；⚠️ 只有 `display:-webkit-box` 能让 line-clamp 生效 |

## ⚠️ 两条「探针故意量不到」的东西（别以为探针全绿就没事）

1. **橙色焦点环**：业主报的弹层橙框是 UA 的 `:focus-visible { outline: auto }`
   （色值取自**系统强调色**，所以是橙的；项目里没有任何橙色）。
   **无头里复现不出** —— 没有真实输入，Chromium 不给 `:focus-visible`，
   连 `focus({ focusVisible: true })` 也不生效（`run.cjs` 里有最小复现：实测 `focusVisible: false`）。
   ⇒ 这类"**只在真实交互下才出现**"的 UA 行为，探针的空白**不是**证据。
2. **观感**：这一页只量盒模型；"好不好看"仍然只能人眼看（见 `ui-render-verify` 的三层边界）。

## ⚠️ 一个必须记下来的坑：图标是**顺序敏感**的

`.file-cover` 的兜底 `blank.svg` 与 `.fiv-cla.fiv-icon-mp4` **特异性打平**（都是 `0,2,0`）⇒ 谁在后面谁赢。
探针第一版把两个 `<link>` 写反了，渲染出来"图标全空"，差点得出"图标坏了"的错误结论。

真实产物里 fiv **在后**（实测 `dist/assets/index-*.css`：`.file-cover[` 在偏移 12124、
`.fiv-cla.fiv-icon-mp4` 在 595983 ⇒ fiv 覆盖兜底）⇒ `after.html` 照抄这个顺序。
**改这两个 `<link>` 的顺序会让对照图静默失真。**

（网格第 172 行那个 `file-cover fiv-cla fiv-icon-${ext}` 是同一个机制，同样顺序敏感 ——
本探针没动它，只是照抄。）
