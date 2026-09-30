# file-finder 项目备忘（索引）

> 细节都在 `docs/`，本文件只留**铁律 + 当前状态 + 关键决策**。超 ~10KB 会在注入时被截断，故保持精简。

## 一、最高优先级
**减少对移动硬盘的读写。** 冲突时以此为准。

## 二、协作方式（用户 ADHD + 阅读障碍）
- 交付：正文 ≤10 行 + 优先一张图 + 需要他做的动作一行；过程/根因/验证数据落 `docs/`
- 他问「还有哪些没做」→ **只给剩余清单**，别复盘
- 先判提问类型：问「X 不能吗/有没有/怎么用」= 认知需求（讲机制+可自跑实验），结尾**不许**追加"要我执行吗"
- 改主进程必须**重启 dev**；改扫描逻辑按**刷新（↻）**重建那条缓存

## 三、铁律（跨会话）
1. **特性默认神圣**：用户声明过的便捷设计不动，只有判断真有问题才**提交讨论**，通过才改。
2. 其余问题：多视角交叉验证 + 确认没理解错 + 确认真要修 → **用正确的方式修，不许打补丁**（判据=以后同类场景还会不会复发）。结论标**证据等级**（静态/推理/实测）；未实测写"未实测"。
3. `grep` 计数只能证"源码有一份"，不能证"运行时渲染出一份"（2026-09-24 误判过）。
4. 不在 `n-space` 放会增减的子元素（naive-ui 2.45.3 每子项 key 都是 `1`）。
5. 缓存层**永不自动删**；白名单重建（`wire()` 唯一出口）；`CACHE_VERSION=2` 非必要不升；`CACHE_KEY`/`CACHE_IV` **永不可改**。
6. **这是「脱敏仓库」**（远端 `github.com/xxxace/file-finder`，`fff69a0` 确立标准）：任何入库文本（源码注释 / `docs/` / `.workbuddy/memory/` / 探针 / 夹具）**不许**出现真实番号、真实演员名、真实作品名、真机目录与文件名、纯数字站点流水号、盘序列号、用户名。
   - 占位风格：番号 → `TST-xxx`（或保留格式族的三段式 `FC2-PPV-1000001`、数字前缀 `200GANA-1001` / `1PONDO-100001`，让解析器示例仍成立）；演员名 → `示例演员A…H`；作品/系列名 → `示例作品标题`；片商 → `示例片商`；路径 → `D:/sample/videos/…`。
   - ⚠️ **写"我脱敏了"的复盘日志时最容易复发** —— 别把原值当例子抄一遍，只写类别与占位风格（2026-09-30 踩过）。
   - 入库前自检：`git grep -nE '[A-Z]{2,6}[0-9]{0,3}-[0-9]{3,5}'` + 比对 `HEAD` 已有标识集合，**新增的真实标识一律先替换再提交**。完整手法见 skill `.workbuddy/skills/desensitize-audit/`（含"别用通用 hex 当模式"这个坑）。
   - ⚠️ **已知遗留（2026-09-30 自检发现，未清，等用户决定）**：`HEAD` 里仍有 **12 个文件**含真实标识，且**都不是当轮新增的**（更早的提交就已入库）——
     最重的是 `docs/PRD-manager-assistant-2026-09-25.md`（7 处）、`docs/CODE-REVIEW.md`（4 处）；
     另有 `docs/ARCH-PLAN.md`、`.workbuddy/memory/2026-09-2{4,5}.md`、`docs/probes/{scan-rules/run.mjs,scan-rules/fixture.json,scan-real/run.mjs,parse-title/run.mjs}`；
     以及 3 个源码注释里的 Windows 默认目录名（`electron/utils/driveIdentity.ts`、`electron/server/assistant/scan.ts`、`src/views/FileFinder/AssistantCoverModal.vue`，属轻量）。
     **改工作区只能让"以后"干净，历史里的还在** ⇒ 真要清得改写历史 + 强推。**不擅自动别的会话的文档（单一真相源）**。

## 四、文档索引
- `docs/PROJECT-MEMO-2026-09-24.md`（特性/缓存/依赖契约/P0-P2/加密备份/n-space 全文）
- `docs/DESIGN-CONVERGED-2026-09-24.md` §六（P0/P1/P2 落地，开工先读）
- `docs/VERIFY-P0-2026-09-24.md` · `AUDIT-VERIFY` · `UPGRADE-PLAN` · `DESIGN-BACKUP`
- 探针 `docs/probes/`：`nspace-dup/` · `scan-rules/` · `parse-title/` · `fc2-check.js` · `scan-real/` · `png-inspect.py`；`electron-headless-verify` skill
- 管理助手：`docs/PRD-manager-assistant-2026-09-25.md`（v1.0，权威）、`docs/DESIGN-manager-assistant-2026-09-25.md`、`docs/KICKOFF-assistant-ui-2026-09-25.md`（Phase 5 开工件）
- 「缓存记录」面板方案（2026-09-30，**待批准、代码未动**）：`docs/DESIGN-CACHE-PANEL-2026-09-30.md`（v3 方案，含用户四条硬约束 + 读盘清单 + 自洽性审查）、`docs/PLAN-cache-panel-2026-09-30.md`（实施计划 A/B/C 三阶段）、`docs/cache-panel-mockup-2026-09-30.html`（mockup）；探针 `docs/probes/cache-panel-{stats,ghost,size,size2,size3,agg-cost}.mjs`（只读解密真库，可复算）
- **本项目没有测试框架**：`package.json` 只有 `dev` / `typecheck` / `build`。⇒ 验证手段固定为「`npm run typecheck` 0 error」+「`docs/probes/` 只读探针」+「真机目视」；**不要写 TDD 式的假测试步骤**。

## 五、当前状态（2026-09-30 晚，HEAD=`70c8a88`）
- **「缓存记录」面板阶段 A 已提交**（`6189a17`），阶段 B **代码已落地、未提交**（改 5 个文件 + 1 个探针）：
  `src/utils/index.ts`（新增 `formatBytes`，支持 TB）、`electron/server/nedb.ts`（`loadMeta` 加 `withBytes`+排序，**默认参数与老行为一致**）、
  `electron/server/index.ts`（`/getHistory` 返回 `bytes`+`sort`/`dir`；`/getDisks` 加 `stats`）、
  `src/components/HistoryTable/index.vue`（总览句 + 「大小」列 + 服务端排序）、`src/views/FileFinder/index.vue`（`getSize` 改薄封装）。
  **阶段 B 改了主进程 ⇒ 必须重启 dev**；期望值：`5 块盘 · 213 个目录 · 1247 个条目 · 已读到 3.35 TB · 库 81.7 MB · 最近扫描 2026-09-27 22:32`。
  阶段 C **代码已落地、未提交**：① 删除进唯一写入链（**`nedb.ts` 已删掉 `removeByIds`** —— 那是绕开链的口，
  证据 `docs/probes/remove-race/`）② `/getDisks` 默认不重探盘符（`?refresh=true` 才探）③ 离线盘显示 `离线(序列号后4位)`
  ④ 搜索认盘符（整词相等）+ 打开聚焦搜索框。
  **故意不做**：chips 换下拉 / 盘可改名 / 上下键选行 —— 理由见 `docs/PLAN-cache-panel-2026-09-30.md` §4。
  改了主进程 ⇒ 阶段 B 起**必须重启 dev**。
- P0+P1+P2 / 加密备份还原合并 已落地实测；离线盘只读浏览已落地（界面待目视）
- n-space 重复 key 修复 + 连带布局回归已修（`.toolbar{flex-wrap:nowrap}` + `.header-bar .n-input{width:200px}` 两条**不许删**）
- 管理助手：Phase 1 + 2A + 5 代码全落地；真机自测部分通过（scan 命中 23/25=92%）；**真机未全验**
  - **视频扩展名已收成单一真相源 `electron/server/videoExt.ts`（2026-09-25 末）**：原散在 4 处（server/index.ts ×2、scan.ts、index.vue 正则）已 centralize；补 `m4v/mov/mpg/ts/m2ts/mts/webm/ogv/3gp`，**m4v 漏扫已修**（m4v 原不在任何名单 → 被当 `type:'file'`，既不抽帧也不进封面补全）
  - 改了主进程 → **必须重启 dev** 才生效

## 六、待用户动作
- **重启 dev**（他跑的还是旧代码）
- 跑 Phase 2A/5 真机自测（PRD §15/§16）；目视验收离线只读层 + 工具条状态条
- `ffprobe` 超时回收（实测泄漏成立）；"改数据文件前先退出应用"文案；`compact()` 留删

## 七、暂缓功能（2026-09-25 口头留档）
- 视觉去重/以图搜图：**砍掉**。盘舰队全景（看板）：保留短期不做（插盘轻量 diff 同步）。常驻增量索引：保留短期不做（与看板同底座）。最终走「**功能完善**」路线。

## 八、管理助手模块（active，2026-09-25）
定位：file-finder **内部模块**，当前只做 JAV。
- 架构决策：Electron **隐藏 BrowserWindow** 抓取（不引 puppeteer/cheerio）；站点规则=**JSON 候选链**（数据非代码）；写盘默认只写封面文件（移动/文件夹化列为可选）；接口走 `route()` 咽喉点加 `/assistant/*`；UI=全屏 `n-modal`（**浅色**，无 darkTheme）。
- apply 写封面后**必须 `removeCache` 失效**（否则 UI 旧脸）；目标目录内 `tmp→rename` 原子写 + `apply.log` + 回滚。
- `cf_clearance` 与 IP+UA+TLS 三绑定 → **不能**交给 Node `fetch`，抓取全程走 Chromium 网络栈（单例隐藏窗+独立 partition，页面内 `querySelector` 抽）。
- 关键事实：`server/index.ts` 有 `DIR_COVER_FILES=['avatar.jpg','cover.jpg']` → 封面落对名 UI 自动当目录脸（展示层零改动）。**`cover.jpg`/`avatar.jpg` 是保留名，助手永不写**；影片封面与文件夹同名（`AAA-123/AAA-123.jpg`），卡片名=封面图文件名去扩展名（`handleCover`）。
- 站点：`freejavbt/javwine/javbus/javdock/onejav`（+`javtext.net` 演员），**均无账号**；确认强度=默认全选→一键确认。
- 线索降级链（用户洞察）：能解析番号→站点抓官方封面；认不出→**从视频抽帧**（复用 `videoThumb`，零网络/零误配）；都不行→行内手动 URL。**禁止**为"认不出"自动关键词乱搜（=制造误配）。触发前先拿全量 `targets/unmatched/skippedCategory` 真实比例。
- `parseTitle` 已重写（有序候选链，FC2 特例排前；连写无分隔一律不识别——宁可漏不可错）；探针 `docs/probes/parse-title/run.mjs`（20/20）。
- 容器判断先于条目判断（目录名是番号→分卷折进 `cover.jpg`，不许再拿分卷名过闸门）。
- 用户决策：不追求面面俱到，认不出一律回归人工，接受"舍弃一部分"。
- `javbus` 演员头像多占位图（`uc.javbus22.com/uc/avatar.php?uid=0`）→ Phase 4 补头像须检测占位图跳过、换可靠源、头像字段不能套含 `avatar` 的封面黑名单。
- ⚠️ `route()` 精确匹配 pathname（`server/index.ts:1106`）→ **不支持 `/:id`**，任务 id 走 `?id=`。
- ⚠️ 隐藏窗会让 `window-all-closed` 永不触发 → `main/index.ts` 加 `win.on('closed', destroyTrackedWindows)`。

## 九、实测铁律1. 验证须先放"已知存在 ID"当控制组（验 FC2 用 javdock 1000002/1000003；旧 fc2-check.js 拿 javbus 验 FC2→假阴性差点改错）。
2. javbus 不收 FC2；预置 5 站仅 javdock 收。onejav 404、jav.wine 挂广告、freejavbt 详情需 `/en/` 前缀。
3. dryrun 分不清 404 和选择器错 → Phase 3 面板必带 HTTP 状态/页面标题。
4. unmatched 有 46% 是目录（182 条里 83 条 folder）→ 维持现状，别再提拆桶（用户否决）。
5. 真数据探针：`docs/probes/scan-real/run.mjs`（真 scan.ts + 真 searchCache.db 只读解密）；key 从 nedb.ts 常量推导。
6. **缓存库实测基线（2026-09-30）**：215 行 = 213 条记录 + 2 行 nedb `$$indexCreated`；**死行 0**；81.7 MB 全是真内容（缩略图 base64）→ **「压缩库能瘦身」是伪需求**；5 块盘 / 213 目录 / 1247 条目。
   ⚠️ 读库时**必须跳过 `$$indexCreated` 行**，否则会误判成"有一条字段残缺的幽灵记录"（本轮踩过）。
7. **`DriveInfo.label` 从来没被赋值**：`driveIdentity.ts:63` 的 `probe()` 写死 `label: ''`（注释却写"用户起的名字"）；实测 `disks.json` 全空 → **离线盘只剩「未插入」，两块盘都不在就是两行一样**。
8. **大小维度可用（2026-09-30 实测）**：`FileInfo.size` 本来就有；**收敛条目的 size = 该子目录所有文件之和**（`server/index.ts:347-398`）。213 条里 210 条能算出量，单层最大 492.55 GB，全库 **3.35 TB**；内存聚合 **0.07 ms**（零额外磁盘 I/O）。
   **双算 = 0**（判据：父层"非 folder 条目"的名字 ∉ 同名子记录名集合；反证 208 对配对全是 folder 条目）。原因是**收敛目录永远不会产生独立记录**（双击封面条目=打开视频，不进目录）。
9. **`parseSize` 把 TB 截断了**：`src/utils/index.ts:3` 是 `gb = bytes/1G % 1024` → 1.83 TB 渲染成 `850.xxGB`、2 TB 渲染成 `0.00GB`。**静默输出错误数字**。
10. **删除不过唯一写入点**：`removeHistoryBatch → removeByIds`（`nedb.ts:353`）直接 `nedb.remove`，**不经过 `queueCacheWrite`**，与后台扫描可交错 → "删了又回来"。**未实测**。
11. **`HistoryTable` 换每页条数不重置页码**（`:284-287`）→ 第 10 页 × 100 条 = 第 901~1000 条 > 213 条 → **翻到空白页**。
12. **缓存记录入口不可发现**：`index.vue:53-57` 是**无文字、无 tooltip** 的脚印图标按钮；`index.vue:58` 的 `n-badge` 是"当前目录条目数"，但站在它旁边像它的角标。
13. **nedb 全库常驻内存**：`node_modules/@seald-io/nedb/lib/datastore.js:416-418` `getAllData() { return this.indexes._id.getAll() }` → `find()` 不碰文件、`projection` 只是下发前删字段。⇒ **面板做任何聚合都是零新增磁盘 I/O**（静态证据；实测遍历 213 条 `data[].size` 求和 0.07 ms）。这条决定了"能不能在不读盘的前提下加统计"。
14. **面板每次打开都强扫盘符**：`/getDisks` → `getDrives(true)` → 对 C–Z 每个盘符 `stat('X:/')` + **无条件写** `disks.json`（`driveIdentity.ts:105-108, 173-181`）。**既有行为**。⚠️ 会不会唤醒插着的移动硬盘 **未实测**；建议改成只在「刷新」时探测。

## 十、「缓存记录」面板的四条硬约束（用户 2026-09-30 原话，跨会话生效）
1. **不加「操作」列** —— 打开方式固定为**双击路径/名称**（他确认该列没有别的功能）。可发现性不许靠加列解决。
2. **不要读盘，只汇总已有缓存的文件大小** —— 做任何统计都必须是纯内存汇总。
3. **尽量不加扫盘功能，尽可能利用已有缓存**；若有这类功能**必须主动告诉他**（→ 每轮方案都要附「读盘清单」）。
4. 交付前必须自查：**是否合理自洽 / 有没有误解 / 有没有把握**（未实测的必须标出来）。

## 十一、已验证的写法（可复用，别重新踩）
1. **naive-ui DataTable 的 `render()` 里生成的节点，`<style scoped>` 匹配不到**：`render` 回调在 **DataTable 自己的渲染上下文**执行，节点拿到的是 DataTable 的 scope id。⇒ 给这些节点写样式要用**不带 scoped 的 `<style>` + 外层类名前缀隔离**（本项目：`.cache-panel .dir-cell { … }`）。先例：`src/components/HistoryTable/index.vue` 末尾的 style 块。
2. **并发请求别用 `if (loading) return` 守卫**（会丢掉后发的那次，界面停在旧结果）⇒ 用**请求序号**：`const my = ++seq; … if (my !== seq) return;`，让"旧的响应永远覆盖不了新的"成为结构保证。
3. **`n-input` 吃掉 composition 事件**：naive-ui 在**它自己的 render 里**把 `onCompositionstart/end` 绑到内部 input（`input/src/Input.mjs:928-929`），外面传同名 prop 会被顶掉。而 composition **会冒泡** ⇒ **在外面套一层普通 div 接**。
4. **要让表格"内部滚动 + 表头吸顶"**（踩过两次，实测在 `docs/probes/table-scroll/out.log`）：
   ① 外层必须有**确定高度** —— `max-height` **只封顶、不给确定高度**，`flex:1 1 auto` 的子项**没有剩余空间可分**，
   表格会按内容长（实测 60 行 = 4235px）压根不受约束；
   ② 滚动交给 DataTable 自己 —— 加 **`flex-height`**，它会把表头渲染成独立的一块
   （`.n-data-table-base-table-header`），滚动只发生在 body 里；
   ③ **别**给外层 div 加 `overflow:auto` + 给 `thead` 加 `position:sticky` —— 实测无效（表头相对表格跑到 −3562px）。
   模板见 `src/components/HistoryTable/index.vue`；探针 `docs/probes/table-scroll/`（可一键复算）。
   代价：卡片要给 `height:86vh`（恒定高，不再随内容变矮）。
   ⚠️ 配套事实：`n-spin` 的 DOM 是 `.n-spin-container > .n-spin-content > slot`（`spin/src/Spin.mjs`），
   `contentStyle` 落在 `.n-spin-content` 上 —— 这条 flex 链上**每一层都要** `flex:1 1 auto; min-height:0`，
   少一层（尤其 `.n-spin-container`）高度就传不下去。
5. **面板内滚动不能靠 `overflow` 加在卡片内容上**（会变成整个弹窗 body 滚）。用户明确要求：**只有表格滚**。

## 十二、判据要落在"事实"上，不能落在"形态/快照"上（2026-09-30 血泪）
真缺陷：判断"只读层的文件能不能打开"用的是 `path.startsWith('#')` —— **地址长什么样**。
而地址形态只是"当初扫描那一刻盘在不在"的**历史快照** ⇒ 盘插回来地址不变 ⇒ **永久打不开**。
**正确的问题永远是"此刻的事实是什么"（盘在不在），并由知道事实的那一方（服务端）当场回答。**
⇒ 修法：加 `/resolveAnchor`，在**动作发生那一刻**解析，而不是靠一个固化下来的状态标记。
**自检问句：这个判断依赖的是"现在的事实"还是"过去的快照"？**
