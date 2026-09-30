# file-finder 备忘（索引）

> 细节在 `docs/`。本文件只留**铁律 + 当前状态 + 关键决策**。
> ⚠️ 超 ~10KB 注入时会被**截断** ⇒ 新增内容写 `docs/`，这里最多加一行索引。

## 一、最高优先级
**减少对移动硬盘的读写。** 冲突时以此为准。涉及扫盘的方案必须附**读盘清单**。

## 二、协作（他 ADHD + 阅读障碍）
- 正文 **≤10 行** + 优先**一张图** + 需他做的动作一行；过程/根因/数据落 `docs/`
- 问「还有哪些没做」→ **只给剩余清单**，不复盘
- 问「X 能不能/有没有/怎么用」= **认知需求**（讲机制 + 给可自跑的实验），结尾**不许**加"要我执行吗"
- 有**成本梯度**时先摆**成本阶梯**让他选，别替他把最完整那版做完
- 改主进程 ⇒ **重启 dev**；改扫描逻辑 ⇒ 按**刷新（↻）**重建那条缓存

## 三、铁律
1. **特性默认神圣**：他声明过的便捷设计不动；判断真有问题才**提交讨论**，通过才改。
2. 其余问题：多视角交叉验证 + 确认没理解错 + 确认真要修 → **用正确的方式修，不许打补丁**（判据=同类场景还会不会复发）。**必须标证据等级**（静态/推理/实测），未实测就写"未实测"。
3. `grep` 计数不能证"运行时渲染出一份"。
4. 不在 `n-space` 放**会增减**的子元素（2.45.3 每个 key 都是 `1`）⇒ 用裸 flex `.hstack`。
5. 缓存层**永不自动删**；`wire()` 唯一出口；`CACHE_VERSION=2` 非必要不升；`CACHE_KEY`/`CACHE_IV` **永不可改**。
6. **脱敏仓库**（`github.com/xxxace/file-finder`，`fff69a0` 立标准）：入库文本**不许**出现真实番号/演员名/作品名/真机目录文件名/站点流水号/盘序列号/用户名。占位：`TST-xxx`、`示例演员A…H`、`示例作品标题`、`D:/sample/videos/…`（番号保留格式族，让解析示例仍成立）。
   ⚠️ **写"我脱敏了"的复盘时最易复发**——只写类别与占位风格，**别抄原值**。手法见 skill `desensitize-audit`。
   ⚠️ **遗留未清（等他定）**：`HEAD` 里 12 个文件含真实标识、**都不是当轮新增**（最重 `docs/PRD-manager-assistant-2026-09-25.md`、`docs/CODE-REVIEW.md`）。改工作区只能让"以后"干净，真要清得改历史+强推；**不擅动别的会话的文档**。

## 四、文档索引
- 开工先读：`docs/PROJECT-MEMO-2026-09-24.md`（契约/特性/缓存全文）· `docs/DESIGN-CONVERGED-2026-09-24.md` §六 · `docs/UX-DESIGN-INPUT-2026-09-24.md`（**§二事实不许推翻 / §四神圣清单 / 硬要求**）
- 角色产出：`docs/DESIGN-UIUX-2026-09-24.md` · `docs/DESIGN-PM-2026-09-24.md`
- 管理助手：`docs/PRD-manager-assistant-2026-09-25.md`（权威）+ 同名 `DESIGN-` / `KICKOFF-`
- 缓存面板：`docs/DESIGN-CACHE-PANEL-2026-09-30.md` · `docs/PLAN-cache-panel-2026-09-30.md` · `docs/cache-panel-mockup-2026-09-30.html`
- 头部/面包屑：`docs/DESIGN-HEADER-2026-09-30.md` + `docs/DESIGN-NAV-2026-09-30.md`（§12 四问自查）+ `docs/PLAN-nav-header-2026-10-01.md`（三阶段计划 + §十一 实施结果）—— **已落地（4 提交），待真机目视**；探针 `docs/probes/header-width/`（真 Chromium 量头部高度）· `docs/probes/crumbs/`
- 探针 `docs/probes/`：`scan-real/`（真 scan + 真库只读）· `parse-title/` · `table-scroll/` · `preview-fill/` · `remove-race/` · `cache-panel-*`；skill：`electron-headless-verify` · `real-module-probe` · `ui-render-verify`
- **没有测试框架**（`package.json` 只有 dev/typecheck/build）⇒ 验证固定三件套：`typecheck` 0 error + `docs/probes/` 只读探针 + 真机目视。**别写 TDD 式假测试**。
- 探针证据**必须 `.txt`**（`.gitignore` 挡 `*.log`，否则文档引用变死链）。

## 五、当前状态（2026-09-30 晚）
- 缓存面板 A/B/C **全部落地并提交**：`formatBytes`（支持 TB）；`loadMeta` 加 `withBytes`+排序；`/getHistory` 回 `bytes`+`sort`/`dir`；`/getDisks` 加 `stats` 且**默认不重探盘符**；删除进唯一写入链（**`removeByIds` 已删**）；离线盘显 `离线(序列号后4位)`；搜索认盘符；开面板聚焦搜索框。**故意不做**：chips 换下拉 / 盘改名 / 上下键选行。基线 `5 盘 · 213 目录 · 1247 条目 · 3.35 TB · 库 81.7 MB`
- P0+P1+P2、加密备份还原合并、离线只读浏览 **已落地**（界面待目视）
- n-space 重复 key 已修；`.toolbar{flex-wrap:nowrap}` + `.header-bar .n-input{width:200px}` **两条不许删**
- 管理助手 Phase 1+2A+5 落地，真机自测部分通过（scan 23/25），**真机未全验**
- 视频扩展名单一真相源 `electron/server/videoExt.ts`；改它要同步 `index.vue` 的 `VIDEO_EXT_RE` 并重启 dev

## 六、待他动作
重启 dev · 跑 PRD §15/§16 真机自测 · 目视验收离线只读层 · **真机回归导航**（选根/下钻/返回/刷新/批量扫描 + 缓存跳转→返回，见 `PLAN-nav-header` §十一）· `ffprobe` 超时回收（泄漏实测成立）

## 七、暂缓
视觉去重/以图搜图 **砍掉**；盘舰队看板、常驻增量索引 **短期不做**；走「功能完善」路线。

## 八、管理助手（active，只做 JAV）
- 隐藏 BrowserWindow 抓取（不引 puppeteer/cheerio）；站点规则=JSON 候选链；默认只写封面文件；接口走 `route()` 加 `/assistant/*`；UI=全屏 `n-modal`（浅色）
- apply 后**必须 `removeCache` 失效**；目标目录 `tmp→rename` 原子写 + `apply.log` + 回滚
- `cf_clearance` 绑 IP+UA+TLS ⇒ **不能**走 Node `fetch`，全程 Chromium 网络栈
- `avatar.jpg` / `cover.jpg` 是**保留名，助手永不写**；有它们 UI 自动当目录脸
- 线索降级链：解析出番号 → 站点抓封面；认不出 → **视频抽帧**；都不行 → 手动 URL。**禁止**对"认不出"自动乱搜（=误配）
- `parseTitle` = 有序候选链（FC2 排前；连写无分隔**一律不识别**）；**容器判断先于条目判断**
- ⚠️ `route()` 精确匹配 pathname ⇒ 不支持 `/:id`，任务 id 走 `?id=`
- ⚠️ 隐藏窗使 `window-all-closed` 永不触发 ⇒ 加 `win.on('closed', destroyTrackedWindows)`
- 站点：`freejavbt` / `javwine` / `javbus` / `javdock` / `onejav` + `javtext.net`，均无账号

## 九、实测事实（错了会误导）
1. 验证**先放"已知存在 ID"当控制组**（验 FC2 曾拿 javbus → 假阴性）。javbus 不收 FC2，5 站仅 javdock 收；onejav 404；jav.wine 挂广告；freejavbt 详情需 `/en/`。
2. unmatched 里 **46% 是目录** ⇒ 维持现状，别再提拆桶（他否决）。
3. **缓存库**：215 行 = 213 记录 + 2 行 `$$indexCreated`；死行 0；81.7 MB 全是真内容 ⇒ **「压缩库瘦身」是伪需求**。⚠️ 读库**必须跳过 `$$indexCreated`**。
4. `DriveInfo.label` **从来没被赋值**（`probe()` 写死 `''`）⇒ 已用「离线(序列号后4位)」绕过。
5. **收敛条目的 size = 该子目录所有文件之和**；**双算 = 0**；内存聚合 0.07 ms ⇒ **面板做聚合是零新增磁盘 I/O**（nedb 全库常驻内存，`getAllData()` 不碰文件）。
6. `parseSize` 曾把 TB 截断（`% 1024`）⇒ 已由 `formatBytes` 取代。
7. `HistoryTable` 换每页条数**不重置页码** ⇒ 会翻到空白页。
8. 缓存记录入口原为无文字无 tooltip 的脚印图标；旁边 `n-badge` 是"当前目录条目数"却**像它的角标**（待裁决）。

## 十、五条硬约束（他原话，跨会话）
1. **不加「操作」列** —— 打开固定为**双击**；可发现性不许靠加列解决。
2. **不要读盘** —— 统计必须是**纯内存汇总**。
3. **尽量不加扫盘功能**；若有**必须主动告诉他**（⇒ 每轮方案附读盘清单）。
4. 交付前自查：**自洽 / 有没有误解 / 有没有把握**（未实测必须标出）。
5. **不允许手动输入 / 编辑路径**（2026-09-30）—— 路径只能由"点击 / 选择"产生；"可编辑地址栏"这类双模式一概不做。

## 十一、已验证写法（别重新踩）
1. **DataTable `render()` 生成的节点，`<style scoped>` 匹配不到** ⇒ 用不带 scoped 的 `<style>` + 外层类名前缀。先例 `HistoryTable/index.vue` 末尾。
2. 并发别用 `if (loading) return` 守卫 ⇒ 用**请求序号** `const my=++seq; if(my!==seq) return;`。
3. `n-input` **吃掉 composition 事件** ⇒ 外面套一层普通 div 接（会冒泡）。
4. **表格内部滚动 + 表头吸顶**：① 外层要有**确定高度**（`max-height` 不给高度，子项会撑到 4235px）② 滚动交给 DataTable（加 **`flex-height`**）③ **别**用外层 `overflow:auto` + `thead{sticky}`（实测无效）。⚠️ `n-spin` 的 DOM 是 `.n-spin-container > .n-spin-content > slot`，flex 链**每层**都要 `flex:1 1 auto; min-height:0`。
5. 弹窗内**只有表格滚**，别在卡片内容上加 `overflow`。

## 十二、两条自检问句（血泪换来）
1. **判据落在"事实"还是"快照"上？** 曾用 `path.startsWith('#')`（地址形态=历史快照）判"能不能打开" ⇒ 盘插回来也**永久打不开**。正解：`/resolveAnchor` 在**动作那一刻**问服务端。
   ⚠️ 2026-09-30 一天内**再犯两次**（`v-if="dir"` 控制返回按钮、`emptyTip` 判 `dir`）⇒ **改任何 UI 条件前先过这一问**。
2. **这个尺寸/行数，是常量还是用户数据的函数？**（**高度**）头部 `.hstack{flex-wrap:wrap}` 包着无界的「根路径 + 面包屑」⇒ 路径一长 / 层级一多就换行，把网格挤下去。正解：容器 `nowrap` + `min-width:0`；内部按**层数折叠**（保首尾，当前层永远可见）+ 单条 `max-width` + ellipsis。
   ⚠️ **紧接着问第二句：固定那一侧之后，另一侧还剩多少？**（**宽度**）2026-10-01 实测：工具条 **605px** 且 `flex:0 0 auto` 不参与压缩 ⇒ 导航区只能吃剩下的 ⇒ **窗口 ≲650px 时工具条溢出头部、导航区 = 0**（改造前是换行、不溢出）。**给窄容器定"谁让路"前，先量出固定那一侧的预算。**
   方案与三档瘦身（保守 539 · 推荐 489 · 彻底 ≈299）见 `docs/DESIGN-HEADER-2026-09-30.md` §18；实测手段 `docs/probes/header-width/`（真 Chromium + **真编译的 scoped CSS**，可量头部高 / 导航区宽 / 工具条预算）。
