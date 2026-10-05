# 规则编写器 P3.2 实现注记（2026-10-05）

> 设计来源：`docs/DESIGN-RULE-BUILDER-2026-10-05.md`（v1，已批准）。
> 本轮把 P3.2 的三件事都做完了：**反推入口模板 / 点选图片 / 录制动作**（外加他临时提的 **URL 拼法可配**）。
> 验证：`npm run typecheck` 0 错误；`node docs/probes/rule-builder/probe.cjs` → **39/39 PASS**（证据 `out.txt`）。
> ⚠️ 窗口相关逻辑探针够不到，**只能真机验**（见文末待验项）。

---

## 1. 三个能力（全部"看得见摸得着"）

| 能力 | 用户动作 | 产出 |
|---|---|---|
| **反推入口模板** | 「打开页面看看」→ 在窗里搜到某部作品 → 回面板「用它做模板」 | `detailUrl` 自动填好，并告诉你番号位置写作什么（如 `{q|noDash}`） |
| **录制动作** | 「录一遍」→ 在窗里像平时那样搜一次 → 点浮层的「结束录制」 | `steps` = 有序的 `type` / `click`，输入值里的测试番号自动换成 `{q}` |
| **点选图片** | 「点选图片」→ 在窗里点一下要抓的那张图（Esc 取消） | 一条 CSS 选择器，自动加进封面候选链**最前面** |

---

## 2. ⭐ 核心设计决策：用 `sessionStorage` 通信，不用 Promise 回传

页面内脚本要把结果交回主进程。**为什么不用 `executeJavaScript` 的 Promise**：
用户点一下可能触发整页跳转 —— 脚本上下文随之销毁，Promise **永不 resolve**（或 reject），主进程就卡住了。

⇒ 改成：**页面把结果写进 `sessionStorage`，主进程每 400ms 轮询读**。
- `sessionStorage` **同源跨页保留** ⇒ 录制过程中发生跳转，已记录的步骤**不会丢**。
- 主进程每轮都**重注入**一次脚本（页面内用 `window.__ffPicker` / `window.__ffRec` 守卫，幂等）——
  顺便把"跳转后丢掉的脚本"补回来。
- 三个 key：`__ff_rec`（录制的步骤）/ `__ff_pick`（拾取结果）/ `__ff_done`（完成标记）；
  开窗前先执行一次清理脚本，否则上一次的残留会被读到。

**已知限制**：`sessionStorage` 按**源**隔离 ⇒ 若录制途中跳到**另一个站点**（不同域名/端口），前面记的步骤会看不见。
同站内的跳转（搜索页 → 结果页 → 详情页）没问题 —— 真实场景基本都落在这里。

---

## 3. 选择器生成策略（稳定性分级）

`selectorGen.ts` 的 `selectorCandidates(desc)` 按"越靠前越不容易失效"排：

```
#id  >  meta[property]  >  tag[data-*]  >  tag.classA.classB  >  tag:nth-of-type（兜底）
```

主动**排掉的噪声**（用它们写规则 = 埋雷，站点一改版就失效）：
- 构建产物类名（`css-1a2b3c`、`sc-bdVaJa`）
- 状态类（`active` / `hover` / `selected` / `is-active`…）
- 哈希 id（字母数字混排且 ≥8 位，如 `a1b2c3d4e5`）
- 哈希化的 `data-*` 值（含 ≥6 位连续数字）
- 同辈同类元素多于 8 个时，**不给** `nth-of-type`（那种位置毫无意义）

页面内拿到候选后**逐个用 `querySelectorAll(sel).length === 1` 验证唯一性**；都不唯一才加父级前缀；
仍不行就用最后一个候选（前端会提示"这条不太稳"）。

⚠️ `selectorCandidates` 会被 **`toString()` 内联**进页面脚本执行 ⇒ 它必须**自包含**
（不引用外部变量、不用可选链等会被编译改写的语法）。这一点写在文件头，改它的人必须知道。

---

## 4. 文件清单（本轮）

| 文件 | 职责 | 行数 |
|---|---|---|
| `urlTemplate.ts` | URL 模板引擎：`expandUrl`（`{q|...}` 管道）/ `deriveTemplate`（反推）/ `replaceQueryInValue` | 132 |
| `selectorGen.ts` | 选择器生成（纯函数，可内联） | 63 |
| `pageScripts.ts` | 注入脚本：浮层 + 拾取 + 录制 + 读/清 sessionStorage | 166 |
| `siteRecord.ts` | 交互采集：开窗 → 等 CF → 清理 → 注入 → 轮询 | 145 |
| `siteActions.ts` | （P3.1.1）动作序列 + 浏览窗（含窗口 id 供反推） | 233 |
| `siteFetch.ts` | （P3.1.1）幂等抓取 + 人工过验证 | 248 |
| `AssistantRulesModal.vue` + `rules/` | 面板：插入变量 / 打开看看 / 用它做模板 / 录一遍 / 点选图片 | 5 文件 |

新增接口：`POST /assistant/openPage`、`/assistant/windowUrl`、`/assistant/pick`、`/assistant/record`。
⚠️ **后两个是长请求**（用户在窗口里操作，最长 10 分钟）—— 前端请求不要加超时（已确认 `request.ts` 无超时）。

---

## 5. 顺手修掉/清掉的

- ⚠️ **`{q|num}` 的真缺陷**：原实现"去掉所有非数字"会把 `FC2-PPV-1234567` 算成 `21234567`（吃进 `FC2` 的 2）⇒ 拼出错误地址。
  已改成**取最长连续数字段**。（探针先发现的）
- 撤掉两个**没有消费者**的东西：`SiteFields.images`（多图组——拾取器只做单张，多图没有使用场景）、
  `isFragileSelector`（未使用）。判据是"零引用 ⇒ 先看有没有场景；没有就不留着当死代码"。

## 5.1 代码审查（独立只读审查 + 逐条自查）后修掉的

派了一个**只读**子 agent 做独立审查，然后**逐条自己核实位置**才动手（子 agent 的结论不采信，只采信它指出的位置）。

| 级别 | 位置 | 问题 | 修法 |
|---|---|---|---|
| **P0** | `rules.ts` `buildStepScript` | `type` 的值只替换 `{q}`，而**录制侧会产出** `{q\|noDash}` / `{q\|lower}` ⇒ 这些占位符被当**字面量**填进搜索框，动作永远搜不到 | 改用 `expandUrl(value, query, undefined, false)`（同一引擎、不做 URL 编码）；为此把 `QueryTransform`/`applyQueryTransform` 搬到 `urlTemplate.ts`，**打破循环依赖** |
| **P0** | `grab.ts` | **生产抓取忽略 `rule.steps`**：试跑走了动作、真抓只打开入口 ⇒ 静默不命中。而保存闸门又是"试跑通过"，于是这种规则**能通过闸门** | 有 `steps` 就走 `runSteps`；并**取消超时重试**（动作有副作用，重试 = 重放点击） |
| P1 | `siteFetch.ts` | `runExtract` / `passChallenge` 未设 `setWindowOpenHandler` ⇒ 页面里任何 `window.open` 会开出**未登记**窗口，主窗关闭时应用退不掉 | 两处都设 |
| P1 | `siteActions.ts` | `openVisiblePage` 加载失败时**不销毁** ⇒ 留一个空白窗 + `PAGES` 里一个孤儿 id；且未与 `NAV_TIMEOUT` 竞速 ⇒ 请求会永久挂住 | 竞速 + 失败收窗 |
| P1 | 三处 `_blank` 接管 | 原为**无条件**同窗导航 ⇒ 站点广告/统计脚本的 `window.open` 会把当前窗导航走，动作与抽取全落错页 | 抽成 `adoptSameOriginPopups()`：**只接管同源**弹窗 |
| P1 | `index.ts` `pick`/`record` | 长请求未接取消 ⇒ 用户关弹窗后，那个可见窗与轮询循环仍会活满 10 分钟 | `abortOnClose(res)` → `AbortSignal` |
| P2 | `urlTemplate.ts` | `replaceQueryInValue` 缺 `{q\|noDash\|lower}` 变体；`deriveTemplate` 会在 **origin** 里误命中（短查询词，如纯数字）⇒ 反推出 `https://{q}.example.com/x` | 补变体；**只在 path+search 里找** |
| P2 | 死代码 | `pipesOf`/`usesQuery` 全项目无引用；`ElDesc.parent` 只构造不读取（页面内每次 hover 白递归 3 层） | 删 |

修完复验：`typecheck` 0、探针 **46/46**（新增 6 条，专门钉住上面两条 P0 的回归）。

> **教训（已进 MEMORY）**："同一件事有多条路径"是这类 bug 的温床 —— 拼 URL 有三处、抓取有两条通道
> （试跑/正式）。**先找唯一出口**，找不到就抽成共用函数，别让同一份逻辑在三个地方各写一遍。

---

## 6. 待真机验收（探针够不到）

1. 点「点选图片」→ 在窗口里点一张封面 → 面板出现选择器 → 「试跑」能抽到该图。
2. 点「录一遍」→ 在窗口里搜一次 → 点「结束录制」→ 面板出现 2 步（输入 + 点击），且输入值里是 `{q}`。
3. 录制**跨页**（搜索页 → 结果页）时步骤不丢（同站）。
4. 有 `_blank` 的站点：点搜索结果**不弹新窗口**（P3.1 的接管）。
5. 「用它做模板」在真实作品页上认得出番号；认不出时应给"没找到"的提示而不是乱填。

## 7. 仍未做

- 多图组（点一个容器抓里面所有图）——**等有使用场景再做**（当前产品闭环只需要一张封面）。
- 规则导入导出 / 定时规则体检（抄 JavSP 的"每天自测一次"）/ 多站 fallback（PRD 后续 P1）。
- `npm run build` 未跑；**未提交 git**（仓库里还有别的会话的改动）。
