# file-finder 备忘（索引）

> 本文件是**索引**：细节一律写 `docs/`，这里最多一行指针。曾 18.7KB 被注入截断两次 ⇒ **上限 ~9KB，新增内容先问「能不能只加一行」**。
> 附录：`MEMORY-APPENDIX-2026-{10-03,10-04,10-05}.md`（§九/§十一/§十二 · §十三 · 探针细则/脱敏清单/长清单）。

## 一、最高优先级
**减少对移动硬盘的读写**，冲突时以此为准；涉及扫盘的方案必须附**读盘清单**。
「零读盘」= 读盘有代价（寻道/耗电/寿命）⇒ **尽可能少读**，**不是"绝对禁止写盘"**。

## 二、协作（他 ADHD + 阅读障碍）
- 正文 **≤10 行** + 优先**一张图** + 需他做的动作一行；过程/根因/数据落 `docs/`
- 问「还有哪些没做」→ **只给剩余清单**，不复盘
- 问「X 能不能/有没有/怎么用」= **认知需求**（讲机制 + 给可自跑实验），结尾**不许**加"要我执行吗"
- ⚠️ **不许拿"确认"当严谨**：他**转述的事实**与**做出的裁决** ⇒ 直接采信；**只有我自己的技术主张才需探针证明**
- 有**成本梯度**时先摆**成本阶梯**让他选
- 改主进程 ⇒ **重启 dev**；改扫描逻辑 ⇒ 按**刷新（↻）**重建缓存
- ⚠️ **UI 验证先让他 30 秒目视**，**别动不动搭无头探针**（10-21 被叫停）。探针只在「静态全对、症状仍在」时用一次

## 三、铁律
0. **subagent 的「结论」不采信，只采信它指出的位置**；压缩/二进制格式**先看真实结构**
0.1 **「零引用」≠「该删」**：先问「当初为什么留着」；**判据必须用对字段**；**`文件:行号` 一律实测核过**
0.2 **不许说"这版是终版"**；说"已穷尽"前先问：是我设计的验证，还是只复现了别人的命令？
1. **特性默认神圣**：他声明过的便捷设计不动；真有问题才**提交讨论**，通过才改
2. 其余问题：多视角交叉验证 + 确认没理解错 → **用正确的方式修，不许打补丁**（判据=同类场景会不会复发），**必须标证据等级**（静态/推理/实测）
3. `grep` 计数不能证"运行时渲染出一份"；反向也成立（`import.meta.glob`）⇒ 查死代码看**入口有没有人调**
4. ⚠️ 判「某机制有没有用」必须**同查生产者 + 消费者**。**11-07 已删 `flexible.ts`**（前提消失、`rem` 零消费；`body.fontSize=12×dpr` 已搬 `main.ts`）
5. 不在 `n-space` 放**会增减**的子元素 ⇒ 用裸 flex `.hstack`
6. 缓存层**永不自动删**；`wire()` 唯一出口；`CACHE_VERSION=2` 非必要不升；`CACHE_KEY`/`CACHE_IV` **永不可改**
7. **脱敏仓库**：入库文本不许出现真实番号/演员名/作品名/真机目录名/盘序列号/用户名。⚠️ 最易漏**探针输出文件** ⇒ **改探针别打绝对路径**。提交前扫三样 + `git status --porcelain -uall`（遗留 12 文件 → appendix-10-05 §三）

## 四、文档索引
- ⚠️ **`docs/` 结论可能是错的**（含标"真根因"的）⇒ 引用前问「有没有被后来的实测推翻过」。**权威 = `VERDICT-2026-10-03.md`（第四版）**
- **开工先读**：`PROJECT-MEMO-2026-09-24.md` · `DESIGN-CONVERGED-2026-09-24.md` §六 · `UX-DESIGN-INPUT-2026-09-24.md`（**§二事实不许推翻／§四神圣清单**）
- **没有测试框架** ⇒ 验证三件套：`typecheck` 0 error + `docs/probes/` 只读探针 + 真机目视（**别写 TDD 式假测试**）；证据**必须 `.txt`**；`@media (max-width)` 看 viewport ⇒ 须 `win.setSize()`

## 五、当前状态（长清单 → appendix-10-05 §二）
- **11-10 扫描三入口**：刷新（当前层真读＝↻/F5）· **更新读取**（原补全）· **重新读取**（原重读）。探测信号＝目录自己 mtime（`SearchCache.dirMtime`，老缓存无此字段即当变了、不升版本）；**当前层永远逐条比对**（mtime 探不到"copy 覆盖同名"，实测过），深层才用 mtime 近似；没变的层靠 `probeLayers.dirs` 带回子目录名单，否则等于剪掉整棵子树。旧「补全」的缺大图补扫已并入（`needsPreview`＋`hasBin`，零读盘）。⚠️ `getDisks` 默认读启动缓存 ⇒ 拔插后拿不到 serial 会静默退化成整片盲读（已改为 refresh 重试 + 明确中止）；`missing` 与 `offline` 必须分开。全文 `docs/DESIGN-SCAN-MODES-2026-11-10.md`
- **11-10 抽帧当封面 + 自动带盘**（分支 `feat/cover-frame`，8 任务 + 复核 5 修）：抽帧=另一个取图来源，`FrameRow extends GrabRow` 走同一个 `/assistant/apply`（取字节唯一分支 `frameFile ? localCover() : getVerifiedCover()`）；卡键唯一真相源 `assistant/cardKey.ts`；阶梯/纯色 `assistant/frameMath.ts`（1/2/3/5/8/12/18/25/35/50%，≥90% 同色自动跳 3 档）；帧缓存 `~/.file-finder/frames/<serial>/<key16>_a..p..s..n{nonce}.jpg`（一张卡一份，**nonce 必变**否则换一帧吃旧图；档位由已存文件名反推）；引用判定**不要 sidecar**（卡键可复算）；回收住「设置→通用→抽帧缓存」（inventory 零读盘 → verify 在线才 stat → purge 服务端重算再删，列表即审阅）。⚠️ 盘点必须 `maxDocs:Infinity`（默认 3000 截断会误判孤儿真删）；`kind:'cover'` 天然看不见 ⇒ `ORPHAN_MIN_AGE_MS=24h` 挡。全文 `docs/DESIGN-COVER-FRAME-2026-11-10.md` + `docs/PLAN-COVER-FRAME-2026-11-10.md`
- **11-10 双向导航（`feat/nav-forward`，11-11 已快进合并 master、分支已删）**：栈→**数组+游标**（`useNavStack.ts`），`goStep(±1)` 一份恢复逻辑；顶栏 `[▤][←][→][↻]`（tooltip **必须键帽** `{text,keys}`，不许写「（Backspace）」），「清空导航历史」在**右键菜单末尾**单独一组 + 确认框。⚠️ 模板不解包 `nav.canBack` ⇒ 只能读解构出的顶层 ref（否则按钮永远置灰）；⚠️ 快照要 `shown` 守卫（数据没落地不许拍，否则连按后退记错屏）。`docs/DESIGN-NAV-FORWARD-2026-11-10.md`
- **11-10 启动画面（11-11 并入 master，701e7d0）**：preload 覆盖层 = **桌面 logo 组装**（icon.svg 内联拆件：白格落格→白环描边→蓝手柄），点缀色 = 手柄蓝 `#049EFF`（galaxy 紫 `--ff-bar-*` 不挪用）。判据（调研定案）：**纯色底+居中 logo+动效只作用在 logo 本身**，背景装饰/文字 = 廉价感来源。⚠️ 画布色 `#0e0e0e`/`#f1f2f3` 共 **5 个落点**（useTheme · tokens.css · preload · index.html 内联 · main 的 backgroundColor）改要一起改；⚠️ 全屏元素 transform 入场**只能向上/左位移**（向下溢出 ⇒ body 滚动条闪）。`docs/ANALYSIS-PRELOAD-SCREEN-2026-11-10.md`
- **11-10 换屏"过滤失效/整份数据闪一下"已修**：`fileList = filterByName(dataSource, searchText)` 两边写入不在一拍（导航同步清词、数据等接口）⇒ 中间渲染「上一屏全量 × 空词」。唯一落点改为 `useScreenData.commit()` 同块写两者，词只由 `loadScreen(entry,{adoptSearch:true})` 携带（仅 enter/back）。`docs/FIX-FILTER-FLASH-ON-NAV-2026-11-10.md`。⚠️ 两个状态决定一个视图 ⇒ 写入必须同拍。
- **galaxy 进度层（11-08 二轮已从窗口顶部搬进地址槽 `.nav-zone`、铺满整盒；顶部 `n-loading-bar` 保留只加 `visibility:hidden` —— ⚠️ **不能用 display:none／height:0**，否则 `rect` 全归零、进度比例读不到）**：`components/GalaxyLoadingBar/`（Canvas 照抄 `drawPixels`+`drawSparks`；**不接管进度**，每帧读 `.n-loading-bar` 的 rect.width，naive 仍是唯一真相源；ResizeObserver 启停 RAF）+ `tokens.css` 的 `--ff-bar-*`。判据：**空格 + 明暗不一 + 左稀右密**，CSS 每格一样永远不像（前两版 4px 渐变 / 14px 点阵都被否）；光晕必须三层且亮心偏白，否则"死紫"。探针 `probes/galaxy-bar/pattern.mjs`。全文 `docs/FIX-LOADING-BAR-GALAXY-2026-11-08.md`
- **11-08 面包屑换层"零位移"+ 节奏统一**（八轮，全部探针实测）：详见 `docs/FIX-CRUMB-MOTION-2026-11-08.md`（**万字，改头部件必读**）。要点：角标槽上移 `.nav-zone` 常驻 48px · 退场抄 rect 钉 absolute 再线性淡出 · 当前段删 `n-spin`（顶文字 7px）· `.scan-bar` 挂卸用 `grid-template-rows: minmax(0,1fr)↔minmax(0,0fr)` · 一拍 **200ms + `cubic-bezier(0.19,1,0.22,1)`**（不过冲）+ 拍内分带 · 目录脸用 `transform: scale(.7↔1)` 不用改宽高 · 网格换内容=只动 opacity（`gridDissolve.ts`，绝不碰几何）· 筛选刻意不做 · 帧级探针用 `nextTick` 同步读 `getComputedStyle`（rAF 会丢帧）· 方向键边界滚动单次 smooth/长按瞬时（`e.repeat`），**禁止 CSS `scroll-behavior:smooth`**。⚠️ **11-10 已取消段数折叠**（`max=4` 是按"槽只占半条顶栏"定的过期常量）：改成全显 + CSS 逐段省略，`docs/DESIGN-CRUMB-NO-FOLD-2026-11-10.md`
- **11-08 顶栏升级已落地**：44px 单行三段 `[▤][←/⨯][↻] │ 地址槽(--ff-field 填充,30高,flex:1) │ [⌕][▦][⊞] | [⋯]`，全 28×28；搜索 28 图标⇄220 输入（挤压地址槽，两向 transition 走拍内分带）；返回常驻置灰、栈底变 ⨯；刷新搬进导航区；更多移到最右；密度去文字靠 `.is-on` 表档位。⚠️ **Less `.is-open &` 会编译成 `.is-open .toolbar …`（祖先顺序反、静默失效）**，修饰类一律另起全路径规则；⚠️ 槽上的 hover 只能用 `--ff-ctl-on`（深色下 `--ff-ctl-hover` == `--ff-field`）。全文 `docs/DESIGN-HEADER-UPGRADE-2026-11-08.md`
- **10-29 网格密度三档**（6/8/12，localStorage）：唯一真相源 `FileFinder/density.ts` → `--ff-grid-cols`；`grid` + `repeat(N,minmax(0,1fr))`，列数必须**精确 = N**；窄窗不降档；切档**必须**失效 `useGridCursor` 行缓存（走 `deps.cols`）。`docs/DESIGN-GRID-DENSITY-2026-10-29.md`
- **10-22 补/换封面暂停·终止·试跑中断**：`jobs.ts` 加 Gate + pause/resume/reopen。`docs/FIX-COVER-PAUSE-2026-10-22.md`
- **10-22 webp/视频裂图**：打包版 `@ffmpeg-installer` 在 asar 内 ⇒ `ENOENT` ⇒ webp/抽帧全挂（jpg/png 走 nativeImage 正常）；`thumbnail.ts` 加 `realBin()` + `asarUnpack` 显式化。**旧缓存失败条目要按 ↻ 才重扫**。`docs/FIX-WEBP-VIDEO-COVER-2026-10-22.md`
- **Q1 增量对账**：`server/index.ts` 9 处 ~25 行，闸门只在 `readFolder`
- **唯一真缺口 = 全局搜索**：`index.vue` 只过滤当前层；`data[].name` 全在内存 ⇒ 纯前端可搜、零读盘（**只下发投影，绝不下发原始 `data[]`**）
- **伪缺口**：`create_at` 刷新年龄、抽帧失败率 0.5%、ffprobe 泄漏（已修）
- 根目录 `searchCache.db` = **主人主动备份** ⇒ 保留；真库在 `%USERPROFILE%\.file-finder\`。基线 `5 盘 · 218 记录 · 1471 条目`。视频扩展名唯一真相源 `server/videoExt.ts`（改要同步 `index.vue` 的 `VIDEO_EXT_RE` + 重启 dev）
- **10-05 P3.1/P3.2 站点规则编辑器**：三段式 + 占位符管道 `urlTemplate.ts` + 点选图片 + 录一遍（页面写 sessionStorage，主进程 400ms 轮询）。`docs/IMPLEMENT-RULE-BUILDER-P3.2-2026-10-05.md`，探针 39/39
- **待重启 dev 目视**：底部状态条挂卸 · 网格密度切档 · 文件夹 size · 预览抢点击 · 盘条 chip · 预览层排版 · 离线看大图 · zip 还原 · exe 图标
- `.toolbar{flex-wrap:nowrap}` + `.header-bar .n-input{width:200px}` **两条不许删**

## 六、待他动作
重启 dev · PRD §15/§16 真机自测 · 目视验收离线只读层 · 真机回归导航。
**打包**：关掉运行中的 app 再 `npm run build`（旧 exe 里 ffmpeg 起不来），再对没封面的目录按 **↻**。❌ 不再待办 `npm install`。

## 七、暂缓
视觉去重/以图搜图**砍掉**；盘舰队看板、常驻增量索引**短期不做**；走「功能完善」路线。

## 八、管理助手（active，只做 JAV）
- **11-10 补封面两铁律**：「命中」= 能下载且能解码成真 JPEG（`coverImage.ts` 的 `getVerifiedCover()` 是**唯一判据**，grab/preview/apply 共用）；`runApply` **封面落盘成功后才搬视频**，失败⇒盘上零改动。⚠️ 旧版先搬视频后下图 ⇒ 产出 `A/A.mp4` 没封面。`docs/FIX-COVER-FALSE-HIT-2026-11-10.md`
- 隐藏 BrowserWindow 抓取（不引 puppeteer/cheerio）；站点规则=JSON 候选链；接口 `/assistant/*`；UI=全屏 `n-modal`；apply 后**必须 `removeCache`**；`tmp→rename` 原子写 + `apply.log`
- `cf_clearance` 绑 IP+UA+TLS ⇒ **不能**走 Node `fetch`，全程 Chromium 网络栈
- `avatar.jpg`/`cover.jpg` 是**保留名，助手永不写**。降级链：番号→站点封面；认不出→**视频抽帧**；都不行→手动 URL。**禁止**对"认不出"自动乱搜
- `parseTitle` = 有序候选链（FC2 排前；连写无分隔**不识别**；**空格不算分隔符**；容器判断先于条目）：`docs/FIX-PARSE-TITLE-COVERAGE-2026-10-22.md`
- ⚠️ `route()` 精确匹配 pathname ⇒ 任务 id 走 `?id=`；⚠️ 隐藏窗使 `window-all-closed` 永不触发 ⇒ 加 `win.on('closed')`
- 站点：freejavbt / javwine / javbus / javdock / onejav / javtext.net，均无账号
- 数据 `~/.file-finder/`：`assistant/rules.json`（明文真相源，删了回落 PRESET）、`cover-backup/<serial>/`（**无自动回滚入口**）、`assistant-hits.jsonl`、`apply.log`

## 九、实测事实（错了会误导）· 全文 → appendix-10-03 §九
**图片**：缩略图 384/q78、大图长边 2048/q82；`t-<sig>`/`p-<sig>` 同源两尺寸（`sig` 锚在缩略图字节），`/preview` 懒生成幂等 ⇒ 点一次后 0 读盘；加密于 `~/.file-finder/bin/`；**离线/视频大图 = 有没有 `p-*`**。
**常被引用**：网格一行 6 个（旧 flex 方案）· **Windows 目录 size 恒 0** ⇒ 唯一不读盘路=缓存子树求和 · 本机无 SVG 光栅化器 ⇒ 用无头 Electron。

## 十、五条硬约束（他原话）
1. **不加「操作」列** —— 打开固定为**双击**
2. **不要读盘** —— 统计必须纯内存汇总
3. **尽量不加扫盘功能**，若有**必须主动告诉他**（每轮附读盘清单）
4. 交付前自查：**自洽／有没有误解／有没有把握**（未实测必须标出）
5. **不允许手动输入/编辑路径**（2026-09-30）—— 路径只能由"点击/选择"产生

## 十一、已验证写法 · 全文 → appendix-10-03 §十一
`render()` 节点 `<style scoped>` 匹配不到 ⇒ 不带 scoped + 外层前缀 · 并发用**请求序号**不用 `if(loading)` · 改下发逻辑先找**唯一出口** · ⚠️ **同一件事有多条路径时必须共用一份实现** · **覆盖 naive-ui 主题变量必须 `!important`** · **自绘元素别用 `--color-*`（项目根本没定义）**：用 `#a1a1a1`/`#dbdbdb`/`#f6f7f9`/`rgba(110,123,173,.10)` 或继承 `--n-*` · 改 naive-ui 定位属性连带清 `transform` · teleport 出的 DOM 非 scoped + 多一层祖先前缀 · 布局坑见 `docs/LAYOUT-GOTCHAS.md`

## 十二、两条自检问句 · 全文 → appendix-10-03 §十二
1. **判据落在"事实"还是"快照"上？**（`path.startsWith('#')` 曾导致盘插回也打不开）
2. **尺寸/行数是常量还是用户数据的函数？** 无界内容包 `flex-wrap` ⇒ 高度成数据函数 ⇒ `nowrap`+`min-width:0`+折叠

## 十三、注释与文件规模纪律 · 全文 → appendix-10-04
只留**判据/陷阱**（1~3 行）；实测数据表搬 `docs/`；推理过程删。
⚠️ `index.vue` 曾 2304 行、注释 37.5% ⇒ **改完自己量**，超 30% 自己提。
⚠️ **模块化**（他明确要求）：纯逻辑抽 `.ts`，UI 按职责拆子组件；**单个新文件 ≤ ~250 行**；别过度拆，**职责单一**才是目的。
