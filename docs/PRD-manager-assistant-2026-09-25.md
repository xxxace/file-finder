# PRD · 管理助手（JAV 封面 / 演员头像抓取）

> 版本 v1.1 · 2026-09-25 · 作者：奥卡姆剃刀大将军（架构）＋ 高级开发 / 产品经理 / UI·UX 三方评审合成
> v1.1 变更：锁定全部决策（站点清单 / 确认强度）；新增 §6.5 视觉与交互设计规范；新增 §14 Spike 执行清单。
> 关联：`docs/DESIGN-manager-assistant-2026-09-25.md`（本 PRD **取代**其 D1 与 Phase 2，其余沿用）

---

## 0. 信心声明（先说结论，标证据等级）

- **主链路有把握**：写对文件名即让目录"长脸"（静态证据：`server/index.ts:37,197-209`）、接口层零障碍（静态证据：`route()`/token/`req.body` 均已核实）、应用层非破坏可回滚。
- **前置闸门 S0 已过（实测）**：封面文件名契约已确定，见 §14。「写对文件名即自动长脸」成立。
- **前置闸门 S1 已过（实测，2026-09-25 真机）**：隐藏窗过 CF 成立（javdock 靠 1 次人工过即通过，javbus/freejavbt 无需过）；**javbus 真命中 100%** → GO。freejavbt/javdock 初测抽中 logo 系假阳性，已修脚本待 Phase 1 校准；onejav CF 待破、javwine/javtext 查询待校准，均不影响 GO（见 §14）。

---

## 1. 背景与根因

用户是本地文件收藏者（JAV 场景），用 file-finder 索引、浏览外置盘。**根因痛点：目录无"脸"→ 识别断裂 → 只能逐个打开视频确认**。表层痛点是"搜番号、下图、改名、放进目录"这套重复劳动。本模块自动化表层，交付根因价值——**恢复"一眼认出"的浏览体验**。

## 2. 目标 / 非目标

**目标**
- 用缓存（零读盘）找出缺封面的视频 → 从资源站抓封面补全 → 预览确认后安全写入。
- 站点提取逻辑用**可视化可编辑规则**管理，应对各站 DOM 易变。
- 可选：把演员名缓存下来，由用户按同名聚合、补演员头像。

**非目标（明确不做）**
- 移动 / 重命名 / 删除视频文件；全自动无确认写盘；内联 puppeteer；非 JAV 场景通用化；视觉去重（已砍）。

## 3. 用户故事

1. 一眼看到哪些片子没封面 → 集中补掉，不逐个翻目录。
2. 点一次把能抓到的都补上、抓不到的单独列出 → 不做一堆选择题，也不漏。
3. 补完每个目录都"有脸" → 浏览时一眼认出，不用打开视频。
4. 某站失效能当场改规则并试跑验证 → 模块不会因一次改版就废掉。
5. 补封面只新增文件、可一键撤销 → 不怕动坏片子。

## 4. 范围（已锁定，不再甩选择题给用户）

| 功能 | 档位 | 优先级 | 理由 |
|---|---|---|---|
| 缓存找缺封面视频（零读盘） | **MVP** | P0 | 入口，符合"少碰盘"铁律 |
| 文件名→番号解析（含 CD1/CD2、part、uncensored） | **MVP** | P0 | 解析错，门就打不开 |
| 隐藏窗口抓封面（过 CF + 弱防护站统一走它） | **MVP** | P0 | 目标站多带 CF，缺它命中率塌方 |
| 预览 + **批量确认**（默认全选，一键） | **MVP** | P0 | 唯一防误配闸门 |
| 安全应用（只写封面文件 + 回滚日志 + 失效缓存） | **MVP** | P0 | 非破坏可回滚 |
| 规则：**预置可用站** + 字段级可视化编辑 + 试跑回显 | **MVP** | P0 | 用户不懂技术，必须开箱即用、可自修 |
| 限速 / 串行 / 重试 / 可取消 | **MVP** | P1 | 降封禁 + 不压垮主进程 |
| 抓取顺手缓存演员名（仅落数据） | **MVP** | P2 | 零成本，为头像铺路 |
| 多站自动 fallback | 后续 | P1 | 提命中率，非首版闭环必需 |
| 规则点选可视化编辑 | 后续 | P1 | 低频事件，先稳 JSON/字段级 |
| 演员同名聚合 UI + 补头像 `avatar.jpg` | 后续 | P1 | 二级场景，依赖先有演员目录 |
| 文件夹化 + 移动视频 | 后续 | P2 | 不可逆风险，用户已说分类自己做 |
| 远程规则库在线更新 | 后续 | P2 | 锦上添花 |

## 5. 架构决策（含三方评审修正）

| # | 决策 | 依据 / 修正 |
|---|---|---|
| D1∗ | **抓取全程留在 Chromium 网络栈**：单例隐藏窗口（`show:false`，非 offscreen）+ 专用 `partition:'persist:assistant'`；HTML 用 `executeJavaScript` 在**页面内**取，字段抽取也在页面内跑 `querySelector`。**不取 cf_clearance 交给 Node fetch**（cf_clearance 与 IP+UA+TLS 指纹三绑定，undici 的 TLS 与 Chromium 不同，必失效）。 | **开发评审 P0 修正我原 D1**（未实测，查证支持） |
| D2 | 抓取放主进程，不进渲染层 | 渲染层有"HTTP 只走 request.ts"约定 |
| D3 | 站点规则 = 数据（非代码），字段=**有序候选链** | 应对 DOM 漂移 |
| D4 | **零新增运行时依赖**：不引 puppeteer、不引 cheerio（CSS 抽取在页面内做，不需要解析器）；`vitest` 只进 devDependencies | 打包契约 `notBundle()`；体积 |
| D5 | 接口走现有 `route()` 加 `/assistant/*`；长任务 **job 化**（`POST /jobs` → `GET /jobs/:id` 轮询 → `DELETE` 取消） | 前端 fetch 无超时；单请求挂死风险 |
| D6 | UI = **全屏 `n-modal`**，无 router；左栏三入口 + 右栏单屏状态机；`n-steps` 只作只读进度 | 项目零 router |
| D7 | 应用**默认只写封面文件**，绝不移动/删除视频；**封面文件名规则（S0 实测）**：影片→写 `<视频同名>.jpg`，目录/分类→写 `cover.jpg`（`avatar.jpg` 等效且优先）；覆盖前先备份、跨卷用"目标目录内 tmp → rename"；下载图**转码为真 JPEG** 再写 | 写盘原子性 + 图片格式坑 + S0 实测 |
| D8 | 演员流程可选、后置；抓封面时顺手存演员名，用户按同名聚合触发补头像，找不到即跳过 | 用户 2026-09-25 确认 |
| D9 | **应用成功后失效受影响目录的缓存**（`removeCache(serial, relPath, mode)`），否则 UI 仍是旧脸 | **开发评审 P0**（`:707-710` 命中缓存直接下发） |
| D10 | 打开面板时**短路全局快捷键**（`FileFinder:872-892` 的 window keyup） | **UX P0**（否则敲字触发后台搜索/重读） |
| D11 | 主题：**沿用应用现状（浅色）**，本功能不改全局主题 | **UX 事实纠正**：`App.vue:2` 无 `darkTheme`，应用是浅色（我此前误判为深色） |
| D12 | 助手窗口 `nodeIntegration:false, contextIsolation:true, sandbox:true`，显式真实 Chrome UA；主窗关闭时 `destroy()` 之，`activate` 用主窗引用 | 防指纹识别 + 防窗口生命周期冲突（开发 P0） |

## 6. 交互设计（UX）

信息架构：
```
管理助手（全屏 n-modal，骨架照抄 HistoryTable）
├─ header：标题 + 关闭
├─ 左栏：① 找封面(默认) │ ② 站点规则 │ ③ 演员聚合(Phase4 前整项隐藏)
└─ 底部常驻状态条：后台任务进度（切页不消失）
```

**主流程（单屏状态机，同刻仅一个 primary 按钮）**
1. **空态**：`[扫描缺封面]`（范围=当前栈顶目录，只读不可改）
2. **运行**：n-steps(只读) + 一条合并进度条 + `[取消]`（沿用既有软取消文案）
3. **预览确认**：`n-data-table` 每行 = 缩略图 + 番号 + 命中站 + 行内动作（换一张 / 看大图 / 手动填 URL / 跳过）；**默认全选**；主按钮 `[应用到选中的 N 条]` → `n-popconfirm` 二次确认
4. **完成**：`已写入 N 张` + `[打开存放文件夹]` + 回滚入口

**规则编辑器**：**字段级可视化**（候选链：`kind / selector / attr` 三控件 + `↑↓` 调序 + 加/删候选），**不是裸 JSON**（JSON 降级为"高级/导入导出"）。试跑结果**先报"页面取到了没（通道+字节数）"，再报各字段候选逐步命中值**；**封面字段未试跑通过则禁止保存**。

**状态与文案**（节选，naive-ui 组件 + 短句、无术语、给一个动作）
| 状态 | 视觉 | 文案 |
|---|---|---|
| 未扫描 | 浅灰小字 | 这一片还没检查过。点上面按钮开始找没封面的视频。 |
| 盘不在 | `n-alert` warning + **禁用主按钮** | 这块盘现在不在，插好后回主界面重扫这一片再来。 |
| 抓取中 | `n-progress` + 只读 steps | 正在抓取：ABC-123 → javbus；已处理 12/40；当前这条处理完就停 |
| 被 Cloudflare 挡 | `n-alert` warning + 按钮 | 被站点拦截，点"打开验证窗口"完成后自动重试。 |
| 行级未命中 | `n-tag` default（灰，非红） | 未命中 + 行内 `[手动填 URL] [跳过]` |
| 试跑未命中 | 候选行 `n-tag` error | 候选 1（css …）没命中 |
| 试跑页面取不到 | `n-alert` error | 页面没取到（可能超时/被墙），先确认站点能打开再调选择器。 |

**必须继承的避坑约定**：动态增减的子元素**禁用 `n-space`**（用裸 `.hstack`）；一个 update 事件**只挂一个 handler**（不 `v-model` 与 `:on-update` 并存）。

## 6.5 视觉与交互设计规范（UI/UX · 必须美观直观、反馈强）

> 原则：**美观 + 直观 + 强反馈**。借鉴对象**不限于同类工具**——谁在这方面做得最好就借谁。

**设计语言（借鉴 → 落地）**
| 借鉴对象 | 借什么 | 我们怎么做 |
|---|---|---|
| Linear / Vercel | 克制的层级、柔和留白、只用语义色的状态表达 | 复用 naive-ui token；面板内用局部 `n-config-provider themeOverrides` 定主色/圆角，**不污染全局** |
| Google Photos / Pinterest | 缩略图网格、点开大图、hover 才出操作 | 结果区缩略图列用 `NImage`（可点开大图）；hover 行出动作 |
| Stripe / GitHub | 破坏性操作先给"影响面"确认 | 应用前 `n-popconfirm` 明写"将写入 **N 个目录**" |
| Postman / Insomnia | 请求→响应分栏、逐项结果 | 规则试跑：左候选链、右结果，逐字段绿/红 |
| Arc / Raycast | 动效服务"状态变化"，不做装饰 | 150–200ms 淡入/滑入，尊重 `prefers-reduced-motion` |

**核心屏的视觉与反馈**
- **空态**：一句浅灰提示 + 主按钮，克制不插画。
- **运行**：**合并一条进度条** + 阶段标签 + 实时「正在抓：ABC-123 → javbus」；命中/未命中/被挡/失败 计数**实时跳动**。
- **预览**：缩略图 + 番号 + 命中站；勾选有明确选中环；行内 hover 出「换一张 / 看大图 / 手动填 URL / 跳过」；顶部一句「N 条命中，默认已全选」。
- **应用**：按钮 loading → 完成态一次性成功动效（勾）+「已写入 N 张」+ `[打开存放文件夹]`。
- **规则编辑**：三段式反馈——①页面取到没（通道+字节数）→ ②各候选逐步命中 → ③命中值原文。

**反馈矩阵（任何操作都要有即时反馈）**
| 触发 | 即时反馈 | 完成反馈 | 失败反馈 |
|---|---|---|---|
| 点扫描 | 按钮 loading + 进度出现 | 结果列表 | `n-alert` + 原因 |
| 抓取中 | 行内 shimmer / 进度 + 阶段标签 | 行状态转"命中" | 行 `n-tag` + 行内动作 |
| 点应用 | `n-popconfirm` + 按钮 loading | 成功勾 + 计数 + 下一步 | 可重试，已成功项不回退 |
| 试跑 | 按钮 loading | 逐字段绿/红 | 分"页面没取到"vs"选择器没命中" |

**动效与可访问性**
- 时长 150–200ms、ease-out；只动 `opacity/transform`；`prefers-reduced-motion` 下关闭。
- 语义色沿用现有约定：**warning = 用户可解决；error = 只能等/真坏了**（不混）。
- 全部键盘可达（除已知全局快捷键短路，见 D10）。

**实现手段**：基于 naive-ui 现有组件；新增的少量 less 变量与动画类只写在面板作用域，不改全局样式。⚠️ **观感必须真机目视验收**（无头验不了）。

## 7. 数据模型（修正版）

```ts
export interface FieldCandidate { kind: 'css' | 'meta' | 'regex'; selector: string; attr?: string; group?: number; }
export interface FieldRule { candidates: FieldCandidate[]; }
export interface SiteRule {
  id: string; name: string; enabled: boolean;
  detailUrl: string;            // 含 {q}
  transport: 'browser';         // MVP 统一走隐藏窗口；fetch 作后续优化
  needsCookie?: boolean;
  fields: { cover?: FieldRule; title?: FieldRule; actress?: FieldRule; actressLink?: FieldRule };
}
export interface GrabResult {
  videoRelPath: string; coverUrl?: string; title?: string;
  actresses?: { name: string; link?: string }[];
  hitSite?: string; status: 'ok'|'no-match'|'blocked'|'error'; message?: string;
}
```
- **抽取实现**：由 `runFieldRule` 拼一条 `executeJavaScript`，在页面内用 `document/querySelector` 依次试候选，返回 `{字段: 值}`（`regex/meta` 也在页面内做）。**无 cheerio、无跨栈 cookie 问题。**
- **存储**：`~/.file-finder/assistant/rules.json`、`actors.json`（明文 JSON，**不塞 searchCache.db**）；单进程内存态 + 串行写队列 + `tmp→rename` 原子写。

## 8. MVP 验收标准（可测）

| 编号 | Given / When / Then |
|---|---|
| AC-1 | Given 缓存含 M 个已知无封面影片，When 点"找缺封面"，Then 精确列出 M 条；**移动盘读取 = 0**（拔盘可跑通） |
| AC-2 | Given 20 个真实文件名（含 CD1/CD2、part、uncensored、无番号），When 解析，Then ≥18/20 正确；3 分卷归一为 1 个抓取目标。**✅ 实测 20/20**（`docs/probes/parse-title/run.mjs`） |
| AC-3 | Given 20 个无封面视频，When 一键抓取，Then ≥70% 得到有效封面；失败带人类可读原因；单条 ≤30s，整批不卡 UI |
| AC-4 | Given N 条结果，When 预览，Then 每条显示缩略图+片名+将写路径，**默认全选**；取消 K 条后写入恰 N−K |
| AC-5 | Given 用户确认，When 应用，Then 写入数=勾选数、路径 100% 正确；**视频/其他文件改动 = 0**；`apply.log` 行数=写入数；**缓存已失效**、刷新后 tile 显示新封面 |
| AC-6 | Given 一次已应用任务，When 回滚，Then 该次写入的封面全部移除、原状复原 |
| AC-7 | Given 一条规则+样例 URL，When 试跑，Then 回显命中值；**封面字段未通过则禁止保存**；开箱 ≥1 预置规则可用 |
| AC-8 | Given 一个已知 CF 站，When 走 browser 通道，Then 能拿到含目标节点的 HTML（人工过一次后复用 session 的后续成功率 ≥80%） |
| AC-9 | Given 手造三例（影片目录+封面 / 仅 cover.jpg / 演员目录），When 启动看 tile，Then **锁定 apply 应写文件名**；未实测前不写 apply |

## 9. 边界场景

| 场景 | 期望行为 | 文案 |
|---|---|---|
| 大片切 3 份 | 归一到基础番号，共用 1 张封面，只抓 1 次 | 检测到 3 个分卷，共用这张封面 |
| 命名与封面不一致 | 以解析番号为准；解析失败进"待处理"，**不自动写** | 认不出番号，已跳过（可手动填写） |
| 抓不到 | 进"未补全"列表，不阻塞其余，可换站重试 | 12 个没找到封面，可换个站再试 |
| 匹配错 | 预览拦截；移除并可加黑名单 | （预览缩略图 + 片名对照） |
| 无演员名 | 跳过，不建空目录，不报错 | 这片没有演员信息，已跳过 |
| CF 拦截 | 切 browser；仍失败则提示人工验证或跳过；全程限速 | 这个站要验证，点这里完成后再继续 |
| 站点改版 | 命中率骤降 → 试跑报红 → 提示规则过期；不影响他站 | javbus 规则可能过期了（命中 0），请更新或换站 |

## 10. 成功度量

| 指标 | 阈值 |
|---|---|
| 补全成功率 | ≥70% |
| 误配率 | ≤2%（有确认兜底趋近 0） |
| **批量确认耗时** | **<10s/批**（最决定是否持续使用的开关） |
| 撤销率 | ≤5% |
| 零破坏 | 视频移动/删除 = 0（硬指标） |
| 规则稳定期 | 平均 ≥30 天，或月维护 ≤1 次 |

## 11. 分阶段实施（两个 go/no-go 前置）

- **S0 ✅ 已过（实测）**：apply 影片写 `<视频同名>.jpg`、目录写 `cover.jpg`。
- **S1 · 抓取 spike**（go/no-go）：✅ **已过（2026-09-25 真机实测）** —— 隐藏窗过 CF 成立，javbus 真命中 100% → GO。详见 §14 与 `docs/spike-S1-result.md`。
- **Phase 1 ✅ 已落地（代码；`npm run typecheck` + `vite build` 均 exit 0）**：`electron/server/assistant/{rules,match,siteFetch,index}.ts`；路由 `GET/POST/DELETE /assistant/rules`、`POST /assistant/dryrun`（无写盘）。⚠️ **真机未验证**（沙箱无 GUI，跑不了隐藏窗）→ 自测见 §15。
- **Phase 2A ✅ 已落地（代码；`npm run typecheck` + `vite build` 均 exit 0；分类规则有探针实测）**：
  抓取层强化 —— 串行队列 + 同主机限速 + 退避重试 + 取消（`assistant/queue.ts`）；
  **job 化**（`assistant/jobs.ts`，路由 `POST/GET/DELETE /assistant/jobs`）；
  **人工过 CF 可见窗**（`siteFetch.ts` 的 `passChallenge`，`POST /assistant/jobs {kind:'challenge'}`）；
  **零读盘「找缺封面」**（`assistant/scan.ts`，`POST /assistant/scan`）；
  抓取编排（`assistant/grab.ts`：同番号只抓一次、多站顺序 fallback、失败即结果）。
  ✅ **首轮真机自测已通过（2026-09-25，见 §16）**：链路全通（扫描 → 抓取 → job 轮询 → 结果表），
  5 条试抓命中 2 条（`TST-560`、`TST-1127` 各拿到真实封面 URL），**全程零写盘**。
  ⚠️ 该轮暴露 `parseTitle` 缺陷（实测 **13/20**，不满足 AC-2）→ **已修**：
  - **`parseTitle` 重写（真机自测驱动）**：原单条正则 `([A-Za-z]{2,7})[-_ ]?(\d{2,6})` 两类错 ——
    ① 分隔符**可选** → `tst26 - 示例片商` 被误判成 `TST-26`（**假阳性**：白搜一遍，且万一该号真实存在就会**写错封面**）；
    ② 字母段不吃数字 → `FC2-PPV-1000001` 被截成 `PPV-100000`、`200GANA-1001` → `GANA-1001`、`1PONDO-100001_001` → `PONDO-100001`（**真番号被截断 = 永久漏判**，对外只表现为"抓不到封面"）。
    改为**有序候选链**（① FC2 多段特例 → ② 通用"字母段+**必需**分隔符+数字段"），并明确
    **连写无分隔一律不识别**（`SSIS001`/`tst26` 形式上无法区分，两侧代价不对称 → 按 PRD §9 取"宁可漏，不可错"）。
  - 探针：`node docs/probes/parse-title/run.mjs`（**真实** `match.ts`，20 例含真机日志里的真实文件名 → **20/20**）；
    `node docs/probes/scan-rules/run.mjs`（**真实** `scan.ts` + 夹具，3 用例，验"文件形态/目录形态/分类目录/范围/跨盘"）。
  - 一键自测脚本：`docs/probes/phase2a-selftest.js`（**零占位符**，见 §16）。
  - `scan` 现在把"跳过"**拆成两件不同的事**：`unmatched`（**认不出番号的明细**，界面要展示、支持行内手动兜底）
    与 `skippedCategory`（分类目录 —— 补它会把"分类"画成"作品"，是**正确行为不是问题**）。
    混在一起会让"认不出番号"的数字虚高（真机首轮那个 72 里就混了分类目录）。→ 见 §17。
- **Phase 2B**：apply —— 原子写（**目标目录内** tmp → rename）+ 图片转真 JPEG + 应用后失效受影响目录缓存（`removeCache`）+ `apply.log` + 回滚。
  **并入 Phase 5 一起上**：写盘是破坏性动作，没有"二次确认 UI"就没有验收路径（AC-5/AC-6 都要点按钮才能验），
  单独先做只是把一份**不可测的破坏性代码**提前放进主进程 —— 收益为零、风险不为零。
- **Phase 3**：字段级可视化规则编辑器 + 试跑闸门 + 预置规则。
- **Phase 4**：演员元数据缓存 + 同名聚合 + 可选补头像。
  ⚠️ **已知坑（用户 2026-09-25 提示）**：javbus 的演员头像**很多是默认占位图**（如 `uc.javbus22.com/uc/avatar.php?uid=0`）。Phase 4 必须：① 头像字段**不能**套用封面黑名单（封面黑名单含 `avatar` 会误杀头像）；改为**按字段配置黑名单**；② 检测占位图（`uid=0`/`default`/`noavatar`/`nophoto`）并当作"无头像"**跳过**、不写入；③ 优先换更可靠的演员头像源。
- **Phase 5**：预览确认 UI + 安全应用 + 回滚 + 全流程验收。

每阶段结束：`npm run typecheck` exit 0；纯函数（`runFieldRule`/`parseTitle`/`normalizeActorName`）建议加 `vitest`（devDep）单测；界面真机目视。

## 12. 风险

| 风险 | 缓解 |
|---|---|
| **隐藏窗过不了 CF（尤其交互式 Turnstile）** | S1 spike 前置；失败回退 fetch-only / 换源 |
| **规则长期维护（最大隐性成本）** | 预置多站 + 试跑快速定位 + 后续 AI 代写规则 |
| 合规 / ToS | 个人低频、限速、优先开放的源 |
| 写盘副作用 | 只写封面文件、可回滚、覆盖前备份 |
| 主进程压力 / ffprobe 已知泄漏 | 抓取串行限速，不与 ffprobe 并发叠压 |

## 13. 决策台账（全部锁定，无待办选择题）

**用户已定（2026-09-25）：**
- **目标站点**（来自旧 `avatar-finder` 代码，**均无账号 / 无 cookie**）：
  - 封面：`freejavbt` / `javwine` / `javbus` / `javdock` / `onejav`
  - 演员：`javtext.net`（`?type=actress&q=`）
- **确认强度**：默认全选 → 一眼扫过 → **一键确认**（不做逐条确认）。
- **要 spike**，但**不在当前上下文做**（子 agent / 新会话）。
- **不追求解析面面俱到（2026-09-25 追加，原话："本来就没有的肯定是找不到的，我们肯定是要舍弃一部分的，没办法面面俱到的，还是要回归一部分给人工"）**：
  能自动的自动；**认不出的一律回归人工**（列出来给人看，可手动给线索或跳过）。用户明确接受"舍弃一部分"。
  → 因此**不**为"认不出"设计花哨的自动猜测（拿名字乱搜关键词 = 直接制造误配，违反 §10）。

**团队代决（不再打扰用户）：** UI=全屏 `n-modal`；应用=只写封面文件、不移动/不删；浏览器层=隐藏窗口、不引 puppeteer；规则=预置站 + 字段级可视化编辑；演员流程后置；**主题沿用现状浅色**；不引 cheerio；长任务 job 化。

## 14. Spike 执行清单（go/no-go）

### S0 · 封面文件名契约 ✅ 已过（**实测**）
- **结论（一句话）**：**影片有脸 → 写 `<视频同名>.jpg`；目录/分类有脸 → 写 `cover.jpg`（`avatar.jpg` 等效、优先级更高）。**
- **反例（关键）**：往影片目录写 `cover.jpg` **不会**让影片变成封面卡，只会让该目录变成一个带 70% 小图标、还得点进去的文件夹——"找缺封面"目标落空。
- **其他实测事实**：
  - 收敛**不检查文件名**（只看图片扩展名），但**卡片名 = 封面图文件名去扩展名**（`handleCover:396`）→ 用别的名字会让卡片丢掉番号。所以"同名"是唯一正确选择。
  - `DIR_COVER_FILES` 顺序即优先级：两图都在时 `avatar.jpg` 胜出。
  - 分类目录要脸，必须**它自己目录里**有 `cover.jpg`/`avatar.jpg`；子目录里的图对它无效。
  - WebP 封面**不会**空白（`imageThumb` 的 ffmpeg 兜底确实生效，"WebP 空白"那条注释描述的是加兜底前）。
- **方法**：不改仓库一字节，用 esbuild 内存插桩暴露 `readFolder/handleCover`，`electron` 重定向到替身（按文件头判可解性 + trace 实际解码路径），真 ffmpeg 造夹具。harness：`%TEMP%/ff-s0-dircover/probe.mjs`（一行复跑：`node "$TEMP/ff-s0-dircover/probe.mjs"`）。
- **未覆盖**：真 Electron `nativeImage` 解码（沙箱用替身）、前端 tile 观感（需真机目视）。

### S1 · 隐藏窗口过 Cloudflare + 命中率（**新会话、真机**）

> ✅ **S1 已 GO（2026-09-25 真机实测）**：隐藏窗过 CF 成立，javbus 真命中 100% 满足闸门。完整结论与每站真假命中见 `docs/spike-S1-result.md`。
> 诚实备注：freejavbt/javdock 初测「100%」是抽中站点 logo 的假阳性（已修脚本黑名单）；javwine/javtext/onejav 为 Phase 1-3 校准项，不影响 GO。

- **为什么新会话**：需真实网络 + 可能人工过一次验证窗口 + 真机目视，不适合沙箱/子 agent。
- **步骤**：
  1. `npm run dev` 起应用。
  2. 用隐藏 `BrowserWindow`（`show:false` + `partition:'persist:assistant'`）加载 5 个封面站的详情页；轮询目标选择器，取 `outerHTML`。
  3. 记录：每站是否需人工过验证、是否需 cookie；对 **10 个真实番号**统计单站命中率。
  4. **go/no-go**：至少 1 站 ≥70% 且可稳定复用 session；否则回退 fetch-only 或换源，并重估整体。
- **产出**：`docs/spike-S1-result.md`（含每站结果表 + 结论）。

## 15. Phase 1 真机自测（照抄即可）

1. `npm run dev` 起应用 → 界面里按 `F12` 开 DevTools 控制台。
2. 取口令：`const t = require('electron').ipcRenderer.sendSync('ff-token')`
3. 列规则：`await fetch(\`http://127.0.0.1:3060/assistant/rules?t=${t}\`).then(r=>r.json())` → 应返回 5 条预置规则（javbus 启用）。
4. 单站试跑：
```js
await fetch(`http://127.0.0.1:3060/assistant/dryrun?t=${t}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ siteId: 'javbus', query: 'TST-218' })
}).then(r => r.json())
```
→ 期望 `{ ok:true, cf:false, fields:{ cover:'https://…/pics/cover/….jpg', … } }`。

判读：`cf:true` = 被 CF 拦（Phase 2 接「人工过验证」）；`ok:false` = 选择器没命中，去 §6.5 的试跑面板校准。

**首次自测结果（2026-09-25 真机）**：`/assistant/rules` 返回 5 条预置规则 ✓；`/assistant/dryrun` javbus/`TST-218` 抽到 `title`/`actress`(`示例演员X`)/`actressLink` ✓、CF 未拦 ✓——链路全通。唯一问题：`cover` 拿到的是**站内相对路径** `/pics/cover/c6b1_b.jpg`（下载会失败）。**已修**：抽取器改用 `new URL(v, document.baseURI)` 补全根相对/路径相对；复跑应得 `https://www.javbus.com/pics/cover/c6b1_b.jpg`。

## 16. Phase 2A 真机自测

> ⚠️ **改了主进程代码 → 必须先重启 `npm run dev`**，否则跑的还是旧进程。

### 懒人版（推荐，零占位符）

前置：先在界面上点开几个**装影片的文件夹**（让它进缓存 —— 扫描只认缓存）。

1. `F12` 打开 DevTools，切到 **Console**。
2. 打开 `docs/probes/phase2a-selftest.js`，**整段复制**粘进 Console 回车。
   （Chromium 首次粘贴会要你手打一次 `allow pasting` —— 只这一次。）
3. 它自己完成：查在线盘 → 挑缓存最多的那块 → 找没封面的位置 → 抓前 5 条 → 每 3 秒报进度 → 最后 `console.table` 出结果。
   **全程不写任何文件**；看到 `coverUrl` 形如 `https://www.javbus.com/pics/cover/….jpg` 就算链路通了。
   想全量抓就把脚本里的 `LIMIT = 5` 改成 `0`。

### 手动版（想逐步看每个接口用哪个就照这个走）

1. `F12` 开 DevTools，取口令：`const t = require('electron').ipcRenderer.sendSync('ff-token')`
2. 取盘序列号：`const disks = (await fetch(\`http://127.0.0.1:3060/getDisks?t=${t}\`).then(r=>r.json())).disks`
   → 记下你要扫的那块盘的 `serial`。
3. **找缺封面**（零读盘，拔盘也能跑）：
```js
await fetch(`http://127.0.0.1:3060/assistant/scan?t=${t}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ serial: '<serial>', relPath: '<你刚浏览过的目录，盘内相对路径>' })
}).then(r => r.json())
```
   → 期望 `{ code:200, targets:[ {kind,dir,name,writeRel}, … ], scannedDocs, skipped }`。
   `targets[].writeRel` 就是**将来会写哪个文件**：`…/TST-218.jpg`（影片是文件）或 `…/SSIS-001/cover.jpg`（影片是目录）。
4. **起抓取任务**（立刻返回 jobId，不会挂住请求）：
```js
const { jobId, total } = await fetch(`http://127.0.0.1:3060/assistant/jobs?t=${t}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ kind: 'grab', serial: '<serial>', relPath: '<relPath>' })
}).then(r => r.json())
```
5. **轮询进度**（多敲几次看数字在跳）：
```js
(await fetch(`http://127.0.0.1:3060/assistant/jobs?t=${t}&id=${jobId}`).then(r=>r.json())).job
```
   → 期望 `status` 由 `running` → `done`；`rows[i]` 命中项带 `coverUrl`（应为 `https://www.javbus.com/pics/cover/….jpg`）。
6. **取消**：`await fetch(\`http://127.0.0.1:3060/assistant/jobs?t=${t}&id=${jobId}\`, { method:'DELETE' }).then(r=>r.json())` → `{ cancelled:true }`
7. **人工过 CF**（javdock 这类交互式挑战）：
```js
await fetch(`http://127.0.0.1:3060/assistant/jobs?t=${t}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ kind: 'challenge', siteId: 'javdock' })
}).then(r => r.json())
```
   → 应**弹出一个可见窗口**；你手点过验证后窗口自动关闭，任务变 `done`。
   之后再抓 javdock 会**复用**这次拿到的 session（不必再过一次）。

判读：`rows` 里出现大量 `no-match` = 选择器过期（Phase 3 的试跑面板修）；出现 `blocked` = 该站要人工过验证（走第 7 步）。

### 首轮真机自测结果（2026-09-25，用户实跑懒人版）

- ✅ **链路全通**：`/getDisks` → `/assistant/scan`（11 条缓存 → 28 个待补目标）→ `/assistant/jobs`(grab) → 轮询 → `console.table` 结果表；**全程零写盘**。
- ✅ 5 条试抓命中 2 条：`TST-560` → `…/pics/cover/87to_b.jpg`、`TST-1127` → `…/pics/cover/oe7_b.jpg`。
- ⚠️ 另外 3 条 `no-match` 的根因**不是"规则过期"**，是 `parseTitle` 出问题（日志里 `TST-26 → javbus` 直接暴露假阳性）：
  - `tst26 - 示例片商` → 误判 `TST-26`、`tst64 - 示例片商` → `TST-64`（**假阳性**）
  - `FC2-PPV-1000001` → 截断成 `PPV-100000`（**真番号被截断**）
  - → 已重写 `parseTitle`（见 §11），探针 **20/20**；scan 探针回归通过；`typecheck` + `vite build` exit 0。
- 说明：修好后"认不出番号"的计数会**上升**（原先被误识别的现在归入"跳过"）—— 这是变准而非变差。
  这类"作品名+序号"（`tst26 - 示例片商`）本来就没有番号，会进"认不出番号"清单，可用行内「手动填 URL」兜底。

---

## 17. 开放问题：认不出番号的片子怎么办（**等真实分布再定**）

**用户 2026-09-25 指出**：有些文件名根本不是番号，"是我乱打的"（自制品 / 合集 / 自拍）。

**现状行为（正确，别改）**：进 `unmatched` 清单，**不自动抓**。
那些片子在上番号站**本来就不存在对应作品**，拿名字硬搜只会搜到**别人的**片子 —— 直接违反 §10「误配率 ≤2%」。

**要修正的隐含假设**：番号不是"前提"，只是一条**线索**。正确模型是**线索降级链**：

| 优先级 | 线索 | 动作 | 代价 / 风险 |
|---|---|---|---|
| 1 | 文件名 / 目录名能解析出番号 | 去站点抓**官方封面** | 需网络；有 CF / 站点改版风险 |
| 2 | 认不出番号 | **从视频抽一帧当封面**（本地生成） | 要读盘（一帧、用户主动触发、一次就好）；**零网络、零误配、不依赖番号** |
| 3 | 抽帧失败 / 用户想换 | 行内「手动填 URL」（§6 已有） | 人工 |

**架构判断**：优先级 2 用**抽帧**，而不是"拿名字当关键词去搜站点"。
理由：关键词搜索的误配率与 §10 的硬指标直接冲突；而"用这部片自己的画面当封面"在**识别**这个目标上恰是最优材料 ——
封面的作用本来就是"一眼认出是哪部"，不是"好看"。
复用既有能力：`utils/thumbnail.ts` 的 `videoThumb()` **已经在**为每个视频抽帧（目前只在内存里做缩略图、不落盘）。
写入文件名沿用现有规则（S0 实测）：影片是文件 → `<视频同名>.jpg`；影片在目录里 → 该目录的 `cover.jpg`。

**首轮全量数据（2026-09-25 真机）**：`targets` **25** / `unmatched` **75** / `skippedCategory` **0**；
抓取 **命中 23 / 未命中 2（92%）**（远超 AC-3 的 ≥70%）。未命中两条：`FC2-PPV-1000001`、`TST-042`（页面打开了但没抽到封面，待查）。
目录形态与文件形态**同时**判对：`TST-036/cover.jpg`、`TST-006/cover.jpg`（目录）与 `示例演员G/TST-560.jpg`（文件）并存无冲突。

**❌ FC2 假设已证伪（2026-09-25 实测，别再重跑旧版脚本）**：
上一版曾假设"75 个 `unmatched` 样例里的纯数字 = 丢了 `FC2-PPV-` 前缀的 FC2 番号"。**实测推翻**：

| 测试 ID | 来源 | javbus | javdock |
|---|---|---|---|
| `TST-218` | 传统番号（控制组） | ✅ 有效作品页 | — |
| `FC2-PPV-1000002` / `1000003` | 已知真实 FC2（控制组） | — | ✅ 有效作品页 |
| `FC2-PPV-1000001` | **你盘里带前缀那条** | ❌ 404 | ✅ 「示例作品标题A…」 |
| `FC2-PPV-1000004` | **你盘里带前缀那条** | ❌ 404 | ✅ 「示例作品标题B…」 |
| `1000011` `1000012` `1000013` `1000014` `1000015` | 你那批**纯数字** | ❌ 404 | ❌ **0/5 全 404** |

三条结论：
1. **javbus 不收 FC2** —— 同一个 ID 在 javbus 404、javdock 有效，是"站的选择"问题，不是 ID 的问题。**旧版 `fc2-check.js` 拿 javbus 验 FC2 = 判据无效，结论是假阴性**，已重写成"横向筛站"探针。
2. **那些纯数字不是 FC2 番号** —— javdock 明明收 FC2、连同一目录的 `1000001`/`1000004` 都有，你那 5 条试的**一条都没有**。它们更像外部视频站/下载器的**流水号**（参照 `files/temp/3d` 的 `10000021-720p` 命名形态），归入**优先级 2（抽帧）/人工**。
3. **但捞到一个更大的事实：我们预置的 5 个站里只有 javdock 收 FC2**（javbus 404、onejav 404、jav.wine 被挂成广告页、freejavbt 有 FC2 分区但详情 URL 格式不符）。而 javdock 在预置里是 `enabled:false`、封面选择器还是 S1 那个假阳性规则 → **你盘里所有 FC2 内容（`files/temp/FC2/*`、`示例演员H/FC2-PPV-*`）现在永远抓不到**。要补 FC2，Phase 3 必须把 javdock 开起来并重写它的封面规则。

---

## 18. `unmatched` 的真实构成（2026-09-25 用真代码扫真缓存实测）

**手法**：`docs/probes/scan-real/run.mjs` —— esbuild 打包**真实 `scan.ts`**，把 `../nedb` 桩到
**真实 `~/.file-finder/searchCache.db`**（只读解密）。零读盘、零写盘、不启动 Electron。
一行复跑：`node docs/probes/scan-real/run.mjs <serial>`（不带参数取第一个盘）。

| 盘 | targets | unmatched | 其中：video（真·没封面的片子） | 其中：folder（**分组目录**） |
|---|---|---|---|---|
| B6C5EBFC | 25 | 75 | 63 | 12（`download/videos` 层全是演员名） |
| 00CBC6EE | 26 | 26 | 7 | **19**（`videos` 层全是演员名） |
| 10469870 | 5 | 75 | 29 | **46**（`files/temp` 层） |
| FE8CDC72 | 2 | 6 | 0 | 6（`新建文件夹` 层） |
| **合计** | **58** | **182** | **99** | **83（46%）** |

**发现 1 —— `unmatched` 里 46% 是目录（已否决，不改）**：
实测 182 条里有 83 条是演员名/分类名**目录**，不是片子。
曾建议拆第三桶 `unmatchedDirs`。**用户 2026-09-25 否决**：原话"不需要搞这么复杂，找不到就找不到又不是天塌了"。
→ **维持现状**：不拆桶、不给目录单独建清单。认不出的都在 `unmatched` 里，处理方式就是"默认不抓、想要的手动填 URL"。**这条到此为止，别再提。**

**发现 2 —— 分卷被双重上报（真缺陷，已修）**：
`videos/示例演员E/TST-088/` 里的 `TST-088A_FHD` / `TST-088B_FHD` 修复前**既**产出
`TST-088/cover.jpg` 目标、**又**被报成"认不出番号" —— 一个文件两种身份。
根因：番号闸门排在 `selfIsMovieDir`（容器判断）**之前**。已修：容器判断提前（`scan.ts`），
并用夹具 `film/TST-088/` 用例锁住（`scan-rules` 4 项断言全过）。
复跑真数据：00CBC6EE `unmatched` 26 → **24**，targets 不变。

**发现 3 —— `dryrun` 分不清"作品不存在"和"选择器不对"**：
`runExtract` 对 404 页也会"页面加载成功但抽不到" → `ok:false, err:null`。
校准规则（尤其 javdock）时这是主要绊脚石。属 Phase 3 试跑面板的必做项：把 HTTP 状态/页面标题带回。
