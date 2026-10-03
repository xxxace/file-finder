# file-finder 备忘（索引）

> 细节在 `docs/`。本文件只留**铁律 + 当前状态 + 关键决策**。
> ⚠️ 超 ~10KB 注入会被截断 ⇒ 新增内容写 `docs/`，这里最多加一行。
> **§九/§十一/§十二 全文已迁 `docs/MEMORY-APPENDIX-2026-10-03.md`**（本文件只留摘要）。

## 一、最高优先级
**减少对移动硬盘的读写**，冲突时以此为准；涉及扫盘的方案必须附**读盘清单**。
- 「零读盘」= 读盘有代价（寻道/耗电/寿命）⇒ **尽可能少读**，**不是"绝对禁止写盘"**（主人 2026-10-03 澄清）。按「读盘代价」逐条标注，别读成一刀切禁令。

## 二、协作（他 ADHD + 阅读障碍）
- 正文 **≤10 行** + 优先**一张图** + 需他做的动作一行；过程/根因/数据落 `docs/`
- 问「还有哪些没做」→ **只给剩余清单**，不复盘
- 问「X 能不能/有没有/怎么用」= **认知需求**（讲机制 + 给可自跑实验），结尾**不许**加"要我执行吗"
- ⚠️ **不许拿"确认"当严谨**（2026-10-03 犯两次）：① 他**转述的事实**（「npm install 跑完了」）⇒ 直接采信不复核；② 他**做出的裁决**（「多盘同一部允许」）⇒ 直接接受，不论证。**只有我自己的技术主张才需探针证明**；他给的是**前提**，不是待验假设。
- 有**成本梯度**时先摆**成本阶梯**让他选，别替他把最完整那版做完
- 改主进程 ⇒ **重启 dev**；改扫描逻辑 ⇒ 按**刷新（↻）**重建那条缓存

## 三、铁律
0. ⚠️ **subagent 的「结论」不采信，只采信它指出的位置**（"判断"自己重算）；交叉审只发现分歧、不替代验证。压缩/二进制格式**先看真实结构**。
0.1 **「零引用」≠「该删」**：先问「当初为什么留着」。`printTree`/`getFileTree` 是上游被注释（真死代码）；`parseSize` 是主动留的"改错指引"（注释+先例出处）⇒ 特性不是垃圾。
0.2 **判据必须用对字段，选错结论反向**：曾拿 base64 字符长度当"图片大小"；真判据是 **JPEG 宽**（前 22KB 扫标记段，不解码整图）。
0.3 **不许说"这版是终版"**。说"已穷尽/已验证"前先问：是我设计的验证，还是只复现了别人的命令？
0.4 **`文件:行号` 一律实测核过再用**：曾照抄 `scan.ts:238`，真实是 **`:263`／`:472`**（错行号本身是旧文档留下的）。
1. **特性默认神圣**：他声明过的便捷设计不动；判断真有问题才**提交讨论**，通过才改。
2. 其余问题：多视角交叉验证 + 确认没理解错 + 确认真要修 → **用正确的方式修，不许打补丁**（判据=同类场景会不会复发）。**必须标证据等级**（静态/推理/实测），未实测就写"未实测"。
3. `grep` 计数不能证"运行时渲染出一份"；**反向也成立**：`import.meta.glob` 会让"被引用"看起来成立 ⇒ 查死代码看**入口有没有人调**。⚠️「引用了但没人用」更隐蔽。
4. ⚠️ **判「某机制有没有用」必须同查生产者 + 消费者**：`flexible.ts` 定义 `1rem=clientWidth/10`，被 `--item-height:1.5rem` 消费；只看消费者会反向。删了网格 192px 塌成 24px。查压缩 CSS 前先看真实结构（带冒号的 grep 会 0 命中）。
5. 不在 `n-space` 放**会增减**的子元素（2.45.3 每 key 恒 1）⇒ 用裸 flex `.hstack`。
6. 缓存层**永不自动删**；`wire()` 唯一出口；`CACHE_VERSION=2` 非必要不升；`CACHE_KEY`/`CACHE_IV` **永不可改**。
7. **脱敏仓库**（`github.com/xxxace/file-finder`，`fff69a0` 立标准）：入库文本**不许**出现真实番号/演员名/作品名/真机目录名/盘序列号/用户名。占位 `TST-xxx`、`示例演员A…H`、`示例作品标题`、`D:/sample/videos/…`。⚠️ 写"我脱敏了"的复盘最易复发——只写类别与风格，**别抄原值**（手法见 skill `desensitize-audit`）。
   ⚠️ 遗留未清（等他定）：`HEAD` 12 个文件含真实标识、都不是当轮新增（最重 `PRD-manager-assistant-2026-09-25.md`、`CODE-REVIEW.md`）。**不擅动别的会话的文档。**

## 四、文档索引
- ⚠️ **`docs/` 结论可能是错的**（实锤多次，含 `CHANGES-2026-10-02.md:346`「真根因（静态证据）」）⇒ **这类标签不会让结论变真**；引用前先问「有没有被后来的实测推翻过」。
  - 权威 = `VERDICT-2026-10-03.md`（第四版）；`BACKLOG`/`CLEANUP-AUDIT`/`ASSESSMENT` 是历史留档（已推翻）；`HANDOVER-2026-10-03.md` = 独立审阅材料，已由 `REVIEW-handover-2026-10-03.md` 审查
- **开工先读**：`PROJECT-MEMO-2026-09-24.md`（契约/特性/缓存全文）· `DESIGN-CONVERGED-2026-09-24.md` §六 · `UX-DESIGN-INPUT-2026-09-24.md`（**§二事实不许推翻／§四神圣清单／硬要求**）
- **各期产出（细节自阅）**：`DESIGN-UIUX/-PM-2026-09-24.md`｜助手 `PRD-manager-assistant-2026-09-25.md`（权威）｜面板 `DESIGN-/PLAN-CACHE-PANEL-2026-09-30.md`｜头部导航 `DESIGN-HEADER/-NAV-2026-09-30.md` + `PLAN-nav-header-2026-10-01.md`（**待真机目视**）｜10-02 `CHANGES-2026-10-02.md`（§五 网格贴边／§六 文件夹 size／§七 图标／§八 预览抢点击）+ `ANALYSIS-folder-size/-cover-blur-2026-10-02.md`
- 探针 `docs/probes/`（40+，详情自阅目录）；⚠️ `@media (max-width)` 看 **viewport** ⇒ 改 `#stage.style.width` 不触发断点，测响应式须 `win.setSize()`
- **没有测试框架**（只有 dev/typecheck/build）⇒ 验证三件套：`typecheck` 0 error + `docs/probes/` 只读探针 + 真机目视。**别写 TDD 式假测试**。探针证据**必须 `.txt`**（`.gitignore` 挡 `*.log`）。
- ⚠️ **探针入库判据（防膨胀）**：**结论进文档；脚本默认一次性**。只有 ① 会被**反复重跑**的断言 或 ② **重建成本高**的工具（无头 Electron / 真编译 CSS / PE·JPEG 二进制解析）才留。`docs/probes/` 现 **23 目录 / 146 文件**，估 **≈1/5 有留价值**。
  ⚠️ `run.sh` 里的 `env -u ELECTRON_RUN_AS_NODE` 是**真知识不是胶水**（漏了就退化成纯 Node、不跑窗口；**重复 8 份，应收成 1 个共享 runner**）。

## 五、当前状态（2026-10-03 · 详情见 `VERDICT-2026-10-03.md`）
- ⭐ **2026-10-03 23:40 增量对账（Q1）已落地** —— `electron/server/index.ts` 9 处、约 25 行，零入口/零前端改动；
  探针 `docs/probes/reconcile/` **13 PASS / 0 FAIL**（再扫一次 0 抽帧、新增只抽 1 张、删除 0 抽帧）。
  闸门**只加在唯一读取点 `readFolder`**，三条抽帧路径（文件 / 目录的脸 / 收敛封面）共用同一判据。
  ⇒ **待主人重启 dev 目视**（`wire()` 在下发路径，探针够不到）。方案见 `docs/IMPLEMENT-reconcile-2026-10-03.md`。
- **唯一真缺口 = 全局搜索**：`index.vue:466` `filterByName` 只过滤当前层；`data[].name` **1471/1471 全在内存**（`nedb.ts:229`）⇒ 纯前端可搜、零读盘（**投影**下发即可；**绝不能下发原始 `data[]`**，会冻界面）。
  ⚠️ **10-03 实测**：投影 `{name,dir,size,type,serial}` = **163 KB**（原文 ~100KB）；原始 `data[]` = **69.0 MB**（原文 78MB，疑取自根目录备份文件）。见 `probes/handover-audit/`
- **exe 图标早已完成**（10-02 22:50 打包）；10-03 真 PE 解析器复核：两个 exe 各 **7 条 RT_ICON**、PNG 尺寸恰 16/24/32/48/64/128/256。
- **伪缺口**：`create_at` 刷新年龄（`HistoryTable:317` 已可排序列）；抽帧失败率 0.5%；**ffprobe 泄漏已修**（`BATCH2-ffprobe` §七）。
- **性价比最高漏项**：cover-blur A 档（`scan.ts` 的 `e.avatar` 放宽成"脸够不够大"）。⚠️ **10-03 实测**：真收益 = **113 个目录**（cover 模式 114 − 1 分类目录）；**116 是统计口径错**（含 2 条非 cover、scanner 不读）。判据 `:263`+`:472`（不是 238）；**"抽共享函数"待复核**——第三处 `:632`（换封面）用同一谓词的反向。
- **该删 7 项**（曾 8，撤回 `parseSize`）；4 项有连带（`printTree`→`interface file`/`getSpace()`/`level_stack`；注释块→`index.vue:65-67`；`getFileTree`→`index.ts:419-427`）。❌ **`flexible.ts` 绝不能删**。
- 根目录 `searchCache.db` = **主人主动备份**（09-24·78.6MB，已过期）⇒ 保留；真库在 `%USERPROFILE%\.file-finder\`（10-02·92MB）。基线 `5 盘 · 218 记录(216 cover) · 1471 条目`。
- 视频扩展名单一真相源 `electron/server/videoExt.ts`；改它要同步 `index.vue` 的 `VIDEO_EXT_RE` 并重启 dev。
- **已落地**：面板 A/B/C · P0+P1+P2 · 加密备份还原 · 离线只读浏览(待目视) · 头部+导航(待目视) · 助手 Phase1+2A+5(未全验)。**待重启 dev 后目视**：文件夹 size · 预览抢点击 · 四条（窗口/右键去后缀/角标/标题）。
- n-space 重复 key 已修；`.toolbar{flex-wrap:nowrap}` + `.header-bar .n-input{width:200px}` **两条不许删**。

## 六、待他动作
重启 dev · PRD §15/§16 真机自测 · 目视验收离线只读层 · 真机回归导航（`PLAN-nav-header` §十一）· **exe 图标目视**（已配 `win.icon`）
· ❌ 不再列为待办：`npm install`（已跑完）。**旧结论作废**：`node_modules/.app-builder-bin-*` 是 2022 旧版残留，与打包无因果 ⇒ **必须 grep 真实 `require` 再判因果（别把相关当因果）**

## 七、暂缓
视觉去重/以图搜图**砍掉**；盘舰队看板、常驻增量索引**短期不做**；走「功能完善」路线。

## 八、管理助手（active，只做 JAV）
- 隐藏 BrowserWindow 抓取（不引 puppeteer/cheerio）；站点规则=JSON 候选链；默认只写封面文件；接口走 `route()` 加 `/assistant/*`；UI=全屏 `n-modal`（浅色）。apply 后**必须 `removeCache` 失效**；`tmp→rename` 原子写 + `apply.log` + 回滚
- `cf_clearance` 绑 IP+UA+TLS ⇒ **不能**走 Node `fetch`，全程 Chromium 网络栈
- `avatar.jpg`/`cover.jpg` 是**保留名，助手永不写**；有它们 UI 自动当目录脸。线索降级链：解析出番号 → 站点抓封面；认不出 → **视频抽帧**；都不行 → 手动 URL。**禁止**对"认不出"自动乱搜
- `parseTitle` = 有序候选链（FC2 排前；连写无分隔**不识别**）；**容器判断先于条目判断**
- ⚠️ `route()` 精确匹配 pathname ⇒ 不支持 `/:id`，任务 id 走 `?id=`；⚠️ 隐藏窗使 `window-all-closed` 永不触发 ⇒ 加 `win.on('closed', destroyTrackedWindows)`
- 站点：`freejavbt`/`javwine`/`javbus`/`javdock`/`onejav` + `javtext.net`，均无账号

## 九、实测事实（错了会误导）· 全文 → `docs/MEMORY-APPENDIX-2026-10-03.md` §九
控制组先验（FC2）· unmatched 46% 是目录（别再提拆桶）· 读库跳过 `$$indexCreated`（压缩库瘦身=伪需求）· `DriveInfo.label` 从没被赋值 · 收敛条目 size=子树和(双算=0,0.07ms) · `parseSize` TB 截断已被 `formatBytes` 取代 · HistoryTable 换页数不重置页码 · 主屏=逻辑 2048×1280 · minWidth 1024 非脑补 · **网格一行 6 个**(`100%/6−10px`+`.image-box` 负 margin；别换 gap/nth-child) · **Windows 目录 size 恒 0** ⇒ 唯一不读盘路=缓存子树求和(已落 `wire()`) · 本机无 SVG 光栅化器 ⇒ 无头 Electron（`force-device-scale-factor=1`、别提前 `win.destroy()`）

## 十、五条硬约束（他原话）
1. **不加「操作」列** —— 打开固定为**双击**。 2. **不要读盘** —— 统计必须纯内存汇总。 3. **尽量不加扫盘功能**，若有**必须主动告诉他**（每轮方案附读盘清单）。 4. 交付前自查：**自洽／有没有误解／有没有把握**（未实测必须标出）。 5. **不允许手动输入/编辑路径**（2026-09-30）—— 路径只能由"点击/选择"产生。

## 十一、已验证写法 · 全文 → `docs/MEMORY-APPENDIX-2026-10-03.md` §十一
`render()` 节点 `<style scoped>` 匹配不到 ⇒ 不带 scoped + 外层前缀 · 并发用**请求序号**不用 `if(loading)` · `n-input` 吃 composition ⇒ 外套 div · 改下发逻辑先找**唯一出口**(`wire()`/`apiUrl()`/`route()`)；字段只在**下发态**补（否则 `bytes` 双算）；**验收要覆盖用户真实路径** · 布局坑见 `docs/LAYOUT-GOTCHAS.md`

## 十二、两条自检问句 · 全文 → `docs/MEMORY-APPENDIX-2026-10-03.md` §十二
1. **判据落在"事实"还是"快照"上？** 曾用 `path.startsWith('#')` 判能否打开 ⇒ 盘插回也永久打不开。正解：`/resolveAnchor` 在**动作那一刻**问服务端。改任何 UI 条件前先过这一问。
2. **尺寸/行数是常量还是用户数据的函数？**（高度）无界内容包 `flex-wrap` ⇒ 高度成数据函数 ⇒ `nowrap`+`min-width:0`+折叠。⚠️ 紧接第二句：**固定一侧后另一侧还剩多少？**（宽度）先量预算。见 `DESIGN-HEADER` §18。
