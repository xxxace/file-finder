# 代码审查（2026-11-08 ~ 11-09 两日批量）

> 触发：主人「开始 code review 和审查，看是否有重复造轮子、重复代码、冗余代码、有问题的代码」。
> 范围：`git diff 15d4e7a..HEAD` 的 `src/` + `electron/`（75 文件，+11675 / −3493）；新增文件 40 个。
> 方法：自定指标（下表）→ 静态扫描 + 手工通读 + 跑现成探针。**未跑真机**，凡涉及运行时观感的结论都标了「未实测」。

---

## 一、指标与实测

| # | 维度 | 指标（可复算） | 实测 | 结论 |
|---|---|---|---|---|
| 1 | 类型 | `npm run typecheck` | **0 error** | ✅ |
| 2 | 重复块 | 归一化后 ≥8 行完全相同（跨文件或同文件间隔 >40 行） | **2 处**（阈值降到 6 行 → 7 处） | ✅ 基本干净 |
| 3 | 重复常量 | 同一字面量在多文件复制 | **`API_BASE` ×11** → 已收口为 1 | ✅ 已修 |
| 4 | 注释结构 | 连排注释块（`*/` 后无代码直接接 `/**`） | 18 → **8**（剩下的都是"段头 + 符号"的正常成对），错位 0 | ✅ 已修 |
| 5 | 规模 | 单文件行数 / 注释占比 | index.vue **4579 行 / 41.2%**（两天 +1309）；usePreview.ts 688 / 52.5% | ❌ P1 未动 |
| 6 | 死代码 | 零外部引用导出 / 零引用 token / 无消费者 provider | 真死 **2**（另 2 个经查是「有据保留」，见 §四）；token **16**；provider **3 层 → 0** | ✅ 已修 |
| 7 | 裸色 | `docs/probes/tokens/no-raw-color.mjs` | **2 → 0**（BASELINE 53 → 0） | ✅ 已修 |
| 8 | 硬编码动效 | `.vue`/`.css` 里 `cubic-bezier()` | **7 处**（tokens 之外） | ⚠️ P3 |
| 9 | 资源生命周期 | add/remove 监听、RAF、RO | add 19 / remove 18（差的 1 个是 `{once:true}`）；RAF 有 cancel、RO 有 disconnect | ✅ 无泄漏 |
| 10 | 类型逃逸 | 新增代码里 `any` / 双重断言 | 4 处（usePreview 2、sfx 2） | ⚠️ P3 |

---

## 二、P1：会咬人，建议先修

### 1. `API_BASE` 字面量复制 11 份

`const API_BASE = 'http://127.0.0.1:3060'` 出现在：

```
src/views/FileFinder/index.vue:563          src/views/FileFinder/playlist.ts:18
src/views/FileFinder/AssistantCoverModal.vue:202   src/views/FileFinder/AssistantAvatarModal.vue:179
src/views/FileFinder/assistant/driveContext.ts:3   src/views/FileFinder/assistant/useAssistantJob.ts:6
src/views/FileFinder/assistant/useAvatarMatcher.ts:5  src/views/Cache/index.vue:204
src/views/Cache/BackupPanel.vue:73          src/views/Playlists/index.vue:75
src/views/Settings/SiteRulesPanel.vue:82
```

其中 `driveContext / useAssistantJob / useAvatarMatcher / BackupPanel` 是这两天新写的 —— 新页面一开就再抄一份。

**为什么算 P1 而不是"顺手清理"**：`src/utils/request.ts` 已经被写成"所有 HTTP 出入的唯一咽喉点"（口令注入就在那儿），唯独**基址不在那儿**。端口是主进程起的（`electron/server`），改端口要动 11 个文件，漏一个的表现是"某个页面永远转圈"。

**修法**（唯一写入口，不是打补丁）：`request.ts` 里导出 `export const API_BASE = 'http://127.0.0.1:3060'`，11 处改成 import；顺手可以做成 `apiUrl('/thumb?k=...')` 直接收相对路径。
**判据**：以后新增页面还会不会复发？**现在的结构一定复发**（复制粘贴是最省力的路径），收进 request 之后不再有可抄的对象。
**证据等级**：静态（grep 11 处，可复算）。

### 2. `index.vue` 4579 行、注释 41.2%

- 11-07 基线 3270 行 → 现在 **4579**（两天 +2139/−826，净增 1309）。
- 结构：template 457 / script 2385 / style(scoped) 1365 / style(global) 350。
- 注释占比 **41.2%**（他自己定的上限是 30%，且纪律是"只留判据/陷阱，1~3 行"）。

直接后果不是"不好看"，是**我下次进来也找不到东西**：右键菜单、面包屑幽灵、预览工具条、扫描动效、键盘节流全在同一个 `setup` 里，互相读对方的 ref。

**最小拆分建议**（按职责，不做过度拆分，每个 ≤250 行）：

| 抽出物 | 内容 | 估计 |
|---|---|---|
| `useContextMenu.ts` | `ctxMenu/plPicker/openCtx/closeCtxMenu/onCtxKeydown/copyPath/revealInFolder` | ~180 行 |
| `useCrumbMotion.ts` | `pinLeaving` + `waitForGridOf` + 槽内 FLIP 相关 | ~120 行 |
| `ctx-menu.css` | 右键菜单约 300 行样式（已在 global 块里，天然可搬） | ~300 行 |
| `preview-bar.css` | `.ptb-*` 工具条样式（同上） | ~250 行 |

**证据等级**：静态（wc/grep 复算）。**注释超标不是错，是"叙述性注释写进了代码"** —— 过程、被推翻的版本、探针记录应落 `docs/`。

---

## 三、P2：确定的缺陷

### 3. 注释错位 5 处（新代码插在旧 JSDoc 与被注释对象之间）

| 位置 | 现在挂着的注释 | 下一行实际是谁 |
|---|---|---|
| `index.vue:1497` | "右键卡片 → 光标处弹极简菜单" | `closeCtxMenu()` |
| `index.vue:2232` | "「更多」下拉的项：disabled 条件…" | `moreMenuProps()` |
| `index.vue:2305` | "下拉选中。**「重读」的确认放在这里**…" | `glow`（扫描动效） |
| `index.vue:1591` | "只取数放进 dataSource…" | `let fetchSeq = 0` |
| `request.ts:36` | "后端出错也返回 HTTP 200…" | `class ApiError` |

另外 **`index.vue:1123` 与 `:1133` 是同一段 JSDoc 完整重复**（"弹「这个封面下有哪几个文件」那一层"），`openFileList` 头上顶了两份。

**为什么算缺陷**：注释描述的是"为什么这么写"，错位之后它变成**误导**（最坏的一种技术债——它看起来像权威）。这不只是清洁问题：`2305` 那条"重读确认"的注释现在贴在扫描动效上，下次改重读逻辑的人会以为那里已经解释过了。
**修法**：删重复的那份；5 处错位各归位。**判据**：根因是"插入代码时不留空行边界"，建议规则——**新函数永远插在它自己的注释之前，不要插进别人的注释与函数之间**。
**证据等级**：静态（逐处 sed 核过）。

### 4. 死代码（**查证后：真死 2 个，另 2 个有据保留**）

| 符号 | 位置 | 结论 |
|---|---|---|
| `isFinishedJob()` | `assistant/jobTypes.ts:35` | **已删**：零引用，同文件的 `isLiveJob` 在用 |
| `DEFAULT_PLAYLIST_NAME` | `views/FileFinder/playlist.ts:19` | **已删**：前端零引用；`defaultPlaylist()` 靠 `p.system` 判，不需要名字 ⇒ 顺带消掉"必须与服务端同值"这条双真相 |
| `parseSize()` | `src/utils/index.ts:22` | **保留**。原注释已写明"保留但不再使用"，且 `docs/MEMORY-APPENDIX-2026-10-05.md:56` 记录过"曾 8 项该删，**撤回 `parseSize`**"。它算错（取模截断 TB）是事实，但删它需要你点头，见 §八-4 |
| `printTree()` | `src/utils/index.ts:47` | **保留**。`/getFileTree` 路由还活着（`electron/server/index.ts:2006`），`docs/CHANGES-VS-ORIGINAL.md:20` 写着"目录树导出**已恢复**" ⇒ 它是**手动导出工具**（devtools 里调），不是死代码。只把 `electron/server/index.ts:583` 那句"渲染层用它画树"改成了事实陈述 |

**判据（含一次自我更正）**：我最初把这 4 个都算成"重构后忘了删"。逐条查证后**只有 2 个成立**——
`parseSize` 的注释本身就是保留声明，`printTree` 是文档明确"已恢复"的手动导出工具。
这正是"「零引用」≠「该删」"那条铁律：**引用数为 0 只是线索，不是判据**。
**证据等级**：静态（grep 全仓 + 两份历史文档交叉核对）。

### 5. 死分支：`ff-reveal-item` 的错误提示永远不触发

`electron/main/index.ts:193` 的 handler 恒 `return ''`（`shell.showItemInFolder` 无返回值），
`index.vue:1587` 的 `if (err) notify('error', '打开失败', …)` **不可能成立**。

同目录 `openFile` / `copyText` 的契约是"失败返回错误描述"，这里为了"契约一致"写了注释，但实现上做不到。文件不存在时表现为**点了没反应**——正是 `openFile` 当初被修掉的那个病（见该文件 `openFile` 的注释）。

**修法**（二选一，别两边都留）：
- ① 用 `fs.existsSync` 先判，不存在返回描述 ⇒ 契约真正成立；
- ② handler 改成无返回值语义，前端删掉 `if (err)` 分支，并在注释里写明"这个动作没有失败回执"。
**倾向 ①**：右键「打开所在文件夹」最常见的失败就是"文件被删了/盘拔了"，静默最糟。
**✅ 已按 ① 修**：`existsSync` 判存在 → 返回「文件不在了（可能已被删除，或这块盘没插）」。
**证据等级**：静态（handler 与调用点都读过）。

### 6. 裸色护栏已经失效

`docs/probes/tokens/no-raw-color.mjs` 的 `BASELINE = 53`，**实测只剩 2**：

```
src/styles/naive-theme.ts:201  boxShadow: '0 1px 3px rgba(0, 0, 0, 0.25)'
src/styles/naive-theme.ts:202  boxShadowFocus: 同上
```

⇒ 护栏现在允许**再退化 51 处**才报警，等于没有。探针自己的说明写着"每走完一个屏把 BASELINE 下调到当次实测值"。
**✅ 已修**：两条 shadow 换成新 token `--ff-ctl-shadow`（浅/深同值，因为它描述的是"拇指有厚度"不是主题色），
`BASELINE` 53 → **0**，探针现在 `PASS 业务代码里没有色值字面量` 且命中 0。
**证据等级**：实测（我跑了探针，exit=0）。

### 7. tooltip 三套并存

| 体系 | 用量 | 位置 |
|---|---|---|
| FluidTip（`v-tip`） | 7 处（+ usePreview 里 `withDirectives`） | 全局 |
| RailTip + useRailTip | 左轨 5 入口 | 左轨专属 |
| naive `n-tooltip` | **1 处** | `Cache/index.vue:87` 盘片 chips |

RailTip 与 FluidTip 的分工你已经裁决过（左轨特色，合理）。剩下的问题是 `Cache/index.vue:87` 那**唯一一处** naive tooltip —— 它是富内容（头 + 多行键值表），`v-tip` 只吃 `{text, keys}`，所以当时留着是对的；但结果是**浅色主题下它会露一版 naive 深底样式**（`disk-chip-tip` 的注释也写着"naive-ui 浅色主题的 tooltip 是深底白字，所以这里只调透明度"）。
**修法**（成本梯度，你挑）：
- 最省：给 `v-tip` 加 `html` / 渲染函数插槽（~30 行），那处一并迁走 ⇒ 全站一种 tooltip；
- 次省：`n-tooltip` 挂 `theme-overrides` 对齐 `--ff-tooltip-*`（只治这一处，属于补丁）；
- 不推荐：保持现状（主题一切就露馅）。

**✅ 已按「最省」修（2026-11-09 18:2x）**：`TipPayload` 增加 `body?: () => VNodeChild`（收渲染函数，
不收 HTML 字符串 —— 字符串要 v-html，等于给提示开注入口子），宿主多一个 `is-rich` 排版档；
`Cache` 盘片提示改成 `v-tip="chipTip(chip)"`，模板里那段 n-tooltip 删掉。
⇒ 全站**只剩两套**，而且分工清楚：

| 套 | 用于 | 为什么不能合并 |
|---|---|---|
| FluidTip（`v-tip`） | 所有"锚在某个控件上的提示"（含富内容） | — |
| RailTip（左轨） | 左轨 5 个入口 | 它不是一个锚点的气泡，而是**一个窗口在 5 行之间滑动**（窗口 translateY + 标签反向 translateY）。合并得给 FluidTip 长出"多行窗口"分支，而那个分支只有 1 个使用者 |

**证据等级**：typecheck 0 + `vite build` 通过；**观感未实测**（等他重启 dev 看盘片提示）。

### 8. 三层 naive provider 无消费者

`App.vue` 里 `n-dialog-provider` / `n-notification-provider` / `n-message-provider` 三层套着 `AppShell`，但 `useDialog` / `useNotification` / `useMessage` 全仓**零调用**（提示与确认已收口到 `OverlayHost` + `useNotify` + `useConfirm`）。
`n-loading-bar-provider` 要留（进度真相源仍是它，只是 `visibility:hidden`）。
**修法**：删两层（dialog/notification/message 都不用了），App.vue 立刻薄一截。
**✅ 已删**（三层全删，只留 `n-config-provider` + `n-loading-bar-provider`）；原来那圈空 provide 的说明换成了"为什么没有它们"。
**证据等级**：静态。

### 9. 音效两条小毛病

- `src/utils/sfx/index.ts:121` 的 preload 列表是 `['mode','switch-on','theme-light','theme-dark','success']`，**最常响的 `hover`（左轨每次进新入口）和 `menu-click`（每次点菜单）不在里面** ⇒ 首次响要等一次 OfflineAudioContext 离线渲染（几十 ms），可能表现为"第一下手感发虚"。**未实测**具体延迟。
- `src/utils/sfx/engine.ts:1032` `if (cache.size > 96) cache.delete(cache.keys().next().value)` 是 **FIFO**，而 `index.ts` 头部注释和 `docs` 都写 "LRU 96 条"。要么换真 LRU（Map 里 set 前先 delete 再 set 即可），要么把注释改成 FIFO。
- 附带：`engine.ts`（1069 行）是 react-bits 的移植件，**文件头无出处与许可**（许可说明只在 `recipes.ts` 里）。建议在 engine.ts 第 1 行补「来源仓库 + MIT/Commons Clause + 去壳改动点」，否则半年后没人知道它为什么是 2 空格缩进。

**证据等级**：静态；延迟影响未实测。

**✅ 已修**：`hover` / `menu-click` 已进 `preloadSfx` 列表；缓存注释按实现改成 **FIFO**（没改第三方代码，因为 13 个事件远达不到 96 上限，换成真 LRU 是纯赔本的复杂度）；`engine.ts` 补了「来源 / 许可 / 只删了 React 外壳 / 2 空格缩进是上游风格」的文件头。

---

## 四、P3：可以不动，但记一笔

1. **16 个零引用 token**（全仓只出现在定义行）：`--ff-sp-1/6`、`--ff-h-nav/list/table/head`、`--ff-grid-min-cell`、`--ff-dur-tap/enter`、`--ff-surface`、`--ff-pink-deep/weak`、`--ff-blue-deep/weak`、`--ff-radius-ctl/xs`。部分可能是"尺度留档"（sp/dur 那几档），但 `--ff-h-nav`、`--ff-surface`、`--ff-pink/blue` 家族更像重皮之后没删。**删前先问"当初为什么定义"**，别一刀切。
2. **`RailTip.vue` 里 expo.out 曲线写了 3 遍**（68 行两次 + 90 行），可提成一个局部 `--tip-ease`。
3. **`index.vue:3818/4438` 两处 CSS 硬编码 `cubic-bezier`**（其余 5 处都在 tokens 里）；JS 侧的（FLIP/WAAPI）无法用 CSS 变量，属合理。
4. **`previewToolbar()` 在 render 阶段做副作用**（`document.querySelector` 量宽、排 rAF、改 `lastBarW`）。它依赖 naive 内部类名 `.n-image-preview-toolbar`，naive 升级改名 ⇒ 静默失效。这是**有意识的取舍**（要量"旧宽"），但值得在注释里写清"升级 naive 必须复核 `ImagePreview.mjs` 行号"，否则是一颗定时炸弹。**未实测**升级风险。
5. **`usePreview.ts:544/593`** 的 `node: any` / `out: any[]`；`index.vue` 的 `waitForGridOf(path)` 形参未用（`void path`）—— 前者能靠 naive 的类型补，后者直接删参数更诚实（"留着为了可读"实际读不出什么）。
6. **`index.vue:2479-2522`** 的 `item: any` 是 10-04 的旧账（不是这两天新增），顺手可换 `WiredFileInfo`。

---

## 五、查过、确认没问题（免得你以为我漏了）

- **无内存/监听泄漏**：19 个 `addEventListener` 对 18 个 `remove`，差的 1 个是 `{once:true}`；所有 RAF 有 `cancelAnimationFrame`、所有 `ResizeObserver` 有 `disconnect`（GalaxyLoadingBar 三个 observer 也都断了）。
- **`drawPixels/drawSparks` 没有复制品**：已经整体搬进 `GalaxyLoadingBar/draw.ts`，`index.vue` 里不留第二份。
- **token 无同作用域重复定义**（0 处）；`tokens.css` 分块清晰。
- **没有死组件**：`DotField / ScanGlow / GalaxyLoadingBar / Banner / OverlayHost / FluidTipHost` 全部有真实挂载点。
- **自绘图标不是重复造轮子**：`icons/grid.ts` 的论证成立（Fluent 没有"同形状×三密度"语义），`icons/fluent.ts` 是"只内联两颗、不装七万颗全家桶"的合理取舍。
- **`CappedPreviewCache` 的字节淘汰逻辑正确**（更新已存在的 key 不会打乱 Map 插入顺序，淘汰从最旧开始，且永不淘汰刚写入那条）。
- **主题切换（`theme/transition.ts`）中断/清理路径完整**：连点先收上一次、`finished` 才拆样式、reduced-motion 与切后台都直接落色。

---

## 六、建议的动手顺序

1. `API_BASE` 收进 `request.ts`（11 处，机械改动，30 分钟）
2. 注释归位 + 删重复注释（5+1 处）
3. 删 4 处死代码 + 3 层 provider + 修 `ff-reveal-item` 死分支
4. 裸色 BASELINE → 2 →（换 var 后）→ 0
5. `index.vue` 拆 4 个块（这件事单独排，别和上面混；拆完再改逻辑）
6. `v-tip` 富内容插槽（决定要不要统一 tooltip）
7. sfx preload 补 `hover`/`menu-click`；engine.ts 补来源头

> 以上 1~4 都是"结构上不会再犯"的修法，5 是规模治理（不着急但要排），6~7 是体验/合规。

---

## 七、我没有做的事（避免误解）

- 没有跑真机、没有截图比对观感 —— 本文所有"看起来/可能"都标了未实测。
- 没有审 `docs/` 里 86 份笔记的结论正确性（那是另一件事）。

---

## 八、修复记录（2026-11-09 18:0x，主人「开始吧」之后）

### 做了什么（按 §六 的 1~4 + 7）

| # | 改动 | 文件 | 验证 |
|---|---|---|---|
| 1 | `API_BASE` 收进 `request.ts`（带"为什么不用 localhost"的唯一说明），11 处改 import，删掉 5 份重复的注释理由 | `utils/request.ts` + 11 处 | typecheck 0 |
| 2 | 注释归位：5 处错位 + 1 处整段重复；连排注释 18 → 8（剩下 8 处是"段头 + 符号"的正常成对） | `index.vue` `useGridCursor.ts` `usePreview.ts` `request.ts` | 脚本复扫 + typecheck |
| 3 | 删 `isFinishedJob` / 前端 `DEFAULT_PLAYLIST_NAME`；拆掉 3 层空 provider；`ff-reveal-item` 用 `existsSync` 把"文件没了"变成一句话 | `jobTypes.ts` `playlist.ts` `App.vue` `main/index.ts` | typecheck 0 |
| 4 | 裸色：新增 `--ff-ctl-shadow`（浅/深同值）、`BASELINE` 53 → **0** | `tokens.css` `naive-theme.ts` `no-raw-color.mjs` | 探针 PASS、命中 0 |
| 5 | sfx：`hover`/`menu-click` 进 preload；缓存注释按实现改 FIFO；`engine.ts` 补来源/许可头 | `sfx/index.ts` `sfx/engine.ts` | typecheck 0 |

顺手修的：`onCursorConfirm` 的 `{    if (` 单行挤两人；`electron/server/index.ts:583` 那句"渲染层用 printTree 画树"改成事实（渲染层不调它）。

### 没做的（要你点头）

1. **`index.vue` 拆 4 块**（P1 的另一半）。这是纯结构调整但动了 4000 行的边界，按约定单独排、单独 review；**没动**。
2. **tooltip 三套统一**（P2-7）。三条路各有代价，需要你选「给 v-tip 加富内容插槽」还是「就这一处保持 naive」。
3. **16 个零引用 token**（P3-1）。其中 `--ff-sp-*` / `--ff-dur-*` 可能是尺度留档，删之前要逐个问"当初为什么定义"。
4. **`parseSize`**。它算错（TB 取模），但注释与 10-05 的决定都是"保留"。要不要真删，你一句话。

### 这次没验证到的

- 没跑真机。`App.vue` 去 provider、`ff-reveal-item` 的新返回文案、sfx 预渲染 —— 都只有静态依据，
  **建议重启 dev 后各点一次**（步骤见 §九）。
- 没跑 `build`（打包链路与本次改动无关）。

---

## 九、给主人的 30 秒自检

1. 重启 dev → 右键任意卡片 → 「打开所在文件夹」→ 应开资源管理器并**选中**该文件。
2. 随便进两个左轨入口 → 第一次 hover / 第一次点菜单 → 应有声（若之前是静音，去设置打开）。
3. Settings / Cache 页随便跳一圈 → toast 与确认框照旧（证明删 provider 没伤到浮层）。
4. 开关一个 Switch → 拇指仍带那颗 1~3px 落影（证明 token 换对）。

---

## 十、拆分记录（2026-11-09 18:2x，主人「继续要拆」）

### 已经搬出去的（都是"结构必然"，不是风格偏好）

| 产物 | 内容 | 为什么这么切 |
|---|---|---|
| `views/FileFinder/preview-bar.css` | naive 预览层覆盖 + `.ptb-*` 工具条结构（210 行） | 这棵 DOM 由 naive 渲染再 teleport 到 body，本来就不该待在 SFC 里 |
| `views/FileFinder/ctx-menu.css` | `.ctx-*` + `n-popover:has(.ctx-menu)`（71 行） | 同上（popover 内容 teleport） |
| `views/FileFinder/crumb-motion.css` | `.nav-zone .fx-*` 过渡类（87 行） | 类名由 Vue 运行时动态加到组件根上，scoped 选择器够不到 |
| `views/FileFinder/useContextMenu.ts` | 菜单状态 + 定位 + 9 个动作（201 行） | 6 个模板入口 + 4 个状态字段散在 4000 行里没人一次看得完；与 `usePreview(deps)` 同一形状 |

**证据**：三份 CSS 的选择器与搬之前**逐字相同**、互不重叠 ⇒ 级联结果不变；构建产物里
`.ptb-cell` / `.ctx-item` / `.fx-leave-active` 仍各命中一处（`grep dist/assets/*.css`）。

### 顺带做的注释压缩（主人："代码能看懂的非特殊内容就没必要冗余注释"）

砍掉了**过程叙述**（第几轮、业主报过几次、探针路径），保留**判据与陷阱**。例：
`waitForGridOf` 24 行 → 9 行（保留"别用 path 判屏身份"这条会复发陷阱）、
Esc/Backspace 24 行 → 4 行、键盘高亮 20 行 → 3 行、角标槽 19 行 → 6 行。

⚠️ **没有**把长块全砍掉：剩下的 34.6% 里大多数是"为什么会这样"（硬件电流、盒模型、焦点语言），
不是复述代码。要继续压到 30% 以下就得动这些判据了 —— 那需要你点头。

### 现状

| 指标 | 拆之前 | 现在 |
|---|---|---|
| index.vue 行数 | 4579 | **3905** |
| 其中 template / script / scoped style | 457 / 2385 / 1365 | 457 / 2114 / 1334 |
| 块注释占比 | 41.2% | 34.4% |
| 全局 `<style>` 块 | 1 个（350 行） | 0（拆成 3 份 .css） |
| 组合式模块 | 1（usePreview） | 3（+ useContextMenu / useFileListPopover） |

### 第二轮（18:4x）：文件列表弹层

`useFileListPopover.ts`（95 行）承接 `popover` 状态 + `fileCursor` + `fileListBox` + 打开/关闭/键盘。

一个**必须记下来的细节**：`deps.isMultiFileCard` 的类型写成 `(item) => boolean` 会立刻让
`item.files` 变成可空、逼你在赋值处补 `?? []` —— 那是把判据抄第二遍。正确写法是保留
**类型谓词** `(item: CardLike) => item is DirCard`，让收窄照旧生效。

### 第二轮里我自己犯的同一个错（已修）

给 `Cache` 加 `chipTip` 时，我把新函数插在 `diskChips` 的注释与它之间 ⇒ 又造出一个孤儿注释。
这是本轮扫出来的（连排注释 9 处，其中 1 处是新造的）⇒ 立刻搬走，并顺手把原先就错的
两处一起归位（「盘列表变了」那段注释真正的主人是 `onDisksChangedIpc`；`onBack` 里两段讲
滚动恢复的注释合成一段）。连排注释 18 → 7，剩下的都是"段头 + 符号"的正常成对。

**教训**：新函数要插在**空白边界**上（上一段代码之后、下一段注释之前），不要插进
"注释 + 它的函数"中间 —— 这类错编译器抓不到，只能靠扫描脚本。

### 下一块

`handleOpen` + `onCursorConfirm` + `decideOpen` 的派发（约 80 行），以及 `scan` 那组状态。
再往后 `searchText / searchOpen` 那段可以并进 `useSearchSlot`。

---

## 十一、第三轮：扫描流 / 挑片模式 / 样式拆分（2026-11-09 19:0x）

### 又搬走三块

| 产物 | 内容 | 行数 |
|---|---|---|
| `useScanFlow.ts` | 批量扫描：队列、串行让出、软取消、进度、扫描动效（glow/glowKey）、`splitDrive`/`fetchScanContext`/`requestFolder` | 329 |
| `usePickMode.ts` | 换封面挑片：选中集合（存**位置**不存对象）、可选判据、单击/键盘共用入口 | 92 |
| `styles/{shell,header,grid,list}.less` | 原来那个 1334 行的 `<style scoped>` 按区域拆成 4 份，SFC 里只留 4 个 `<style lang="less" scoped src=…>` | 1338 |

`useScanFlow` 只保留 4 个依赖：`currentPath` / `notify` / `refreshScreen` / `fullPathOf`。
其中 `refreshScreen` 与右键菜单用的 `reloadCurrent` 合并成页面上**同一个** `reloadCurrentScreen()` ——
两处各写一遍 "取 history 末项再 loadScreen" 就是新的重复。

`picking` 这个开关**故意留在页面**：6 处守卫在读它，它不属于"挑片"这一个功能。

### 一次真的翻车（必须记）

拆样式时我用**绝对行号**切片，且脚本不幂等 —— 重跑后行号已漂移，把整个 scoped 块切成了垃圾，
`index.vue` 的样式一度只剩 4 个 `src` 引用、`.less` 里塞的是 `<style>` 标签。
**恢复**：从 `HEAD` 取回原 scoped 块 → 重新套用今天那两处注释压缩 → 重切。
校验：原块非空行 1263 / 现四文件 1233，差值 = 那两处压缩（32 行）；四个文件括号配平；
产物里 `.file-finder` / `.nav-zone` / `.image-box-item` / `.file-cover` 全部带同一个 `data-v-de2af889` ⇒ 作用域没丢。

**教训（写进习惯）**：按行号切文件前，**先断言目标行内容**（`lines[2184] === '<style…'`），
且脚本必须幂等（先检查"是不是已经切过"）。这类脚本没有编译器兜底，跑错就是静默毁文件。

### 现状

| 指标 | 起点（11-09 18:00） | 现在 |
|---|---|---|
| `index.vue` | 4579 行 / 注释 41.2% | **2187 行 / 29.5%** |
| 结构 | template 457 · script 2385 · style 1365 + 全局 350 | template 457 · script 1723 · 4 个 src 引用 |
| 组合式模块 | 1（usePreview） | **6**（usePreview / useContextMenu / useFileListPopover / useScanFlow / usePickMode / useGridCursor） |
| 样式文件 | 全部在 SFC 里 | 4 份 scoped .less + 3 份全局 .css |

### 下一批候选（按收益/风险排序）

1. `useNavigation`（fetchFolder + loadScreen + enterScreen + onBack + setRoot，约 400 行）——
   风险最高，动的是"哪一屏 / 滚到哪"的真相，**要单独一轮 + 真机回归**。
2. `useSearchSlot`（searchText / searchOpen / 输入框聚焦，约 120 行）。
3. `useDriveEvents`（插拔盘自动升降级，约 145 行）。

---

## 十二、第四轮：搜索槽 + 清死导入（2026-11-09 19:1x）

| 产物 | 内容 | 行数 |
|---|---|---|
| `useSearchSlot.ts` | 过滤词、展开态、聚焦时机、失焦收起 | 50 |

`index.vue` 2144 行（script 1680 / template 457 / 4 个样式引用）。

顺带清掉三处这次拆分暴露出来的死代码：`postAction` 导入（扫描与收藏移除都搬走后没人用了）、
`usePickMode` 返回的 `picked` / `togglePick`（页面只用 `pickedCount` / `isPicked` / `onItemClick`）。
**返回值和导入都只留有人在用的** —— 拆完不动这个，就等于自己造一批新死代码。

### 为什么没继续拆 `onDisksChanged`

它只有 60 行，但依赖 10 个（history / refreshIndex / fetchPlaylistItems / fetchFolder /
isReadOnlyPath / driveLetterOf / getAnchor / resolveAnchor / notify / playSfx），
拆完页面要写 10 行 deps、模块还要接管 `ipcRenderer.on/off` —— **净减不到 40 行，却多一层跳转**。
按"别过度拆、职责单一才是目的"，这一块留在页面更划算。判断记在这里，免得下一轮又来试一次。

### 现状与剩余

| 指标 | 起点 | 现在 |
|---|---|---|
| `index.vue` | 4579 行 / 块注释 41.2% | **2144 行 / 29.2%** |
| script | 2385 | **1680** |
| 组合式模块 | 1 | **7**（+ useSearchSlot），合计 2082 行 |
| 样式 | 全在 SFC | 4 份 scoped .less + 3 份全局 .css |

**唯一剩下的大块是导航**（fetchFolder + loadScreen + enterScreen + onBack + setRoot ≈ 400 行）。
它动的是"哪一屏 / 滚到哪"的真相，拆完必须走一次真机返回/下钻回归 —— **建议等你手上有空再动**，
我不在没有回归条件时先拆它。

---

## 十三、第五轮：取数三个入口（2026-11-09 20:1x，主人真机验收通过后）

`useScreenData.ts`（158 行）承接：`fetchFolder` / `fetchPlaylistItems` / `loadScreen` +
请求序号 `fetchSeq` + `BANNER_KINDS`。`index.vue` **2144 → 2027**。

### 形状上的一个取舍

`dataSource` / `loading` / `failKind` 三个 ref **留在页面**，模块只负责写：
界面各处都要读它们（空状态、横幅、网格），搬进模块等于让页面到处 `nav.dataSource`。
所以 deps 收 ref、写入点仍然只有模块这一个 —— **"谁读得多谁持有，谁改得多谁写"**。

请求序号不 Export 值而导出 `getFetchSeq()`：它是 `let`，页面只在两个地方要"我这次是第几号"，
给函数比给一个会过期的快照安全（那三处以前直接读模块级变量，现在也读不出旧值）。

### 顺手清掉的死导入（拆完不清，就是在造新死代码）

`ApiError` / `getPlaylistItems` / `PlaylistDetail` / `useLoadingBar` —— 都随取数一起搬走了，
页面里没人再用。用 `vue-tsc --noUnusedLocals` 筛（注意 `fileListBox` / `searchSlot` / `searchInput`
是**模板 ref**，会被误报，别删）。

同时修掉两处**过时注释**：`enterScreen` / `onBack` 里还写着"fetchSeq 声明在本文件下方"、
"它不把序号告诉调用方"—— 现在都不成立了。注释跟着代码走，不跟就是下一个人的坑。

### 现状与剩余

| 指标 | 起点 | 现在 |
|---|---|---|
| `index.vue` | 4579 行 / 块注释 41.2% | **2027 行 / 29.3%** |
| script | 2385 | **1563** |
| 组合式模块 | 1 | **8**（+ useScreenData） |
| 样式 | 全在 SFC | 4 份 scoped .less + 3 份全局 .css |

页面里剩下的导航相关只有"栈操作"这一层：`enterScreen` / `onBack` / `jumpTo` / `onCrumbClick` /
`setRoot` / `openHistory`（约 250 行）。它读 `history` 这个唯一真相、又要动 `searchText` /
`noteIntent` / 滚动恢复 —— 再拆就该把 `history` 也交出去，那是**状态机级**的改动，
得有回归条件再动。现在这个位置（取数已出、栈还留着）是风险与收益的平衡点。

---

## 十四、第六轮：过滤函数独立 + 一处字符类 bug（2026-11-09 20:2x）

`filterByName` 搬进 `filterByName.ts`（纯函数，可直接被探针跑）。`index.vue` 2027 → **1989**。

搬的时候发现真问题：原来的字符类是 **`/^[a-z|A-Z]/`** —— `|` 在字符类里是**字面量**，
所以"以竖线开头"的名字会被当成字母开头，进而走拼音分支。改成 `/^[A-Za-z]/`。
另外把 `indexOf(...) !== -1` 换成 `includes`，逻辑等价、少一层取反。

### 到这里停止机械拆分（记录判断，免得下次又来试）

页面剩 1989 行，其中约 440 行是**导航状态机**（`enterScreen` / `onBack` / `jumpTo` /
`onCrumbClick` / `setRoot` / `openHistory` / `waitForGridOf` + 滚动恢复）。
它有 15 个外部依赖（`dir` 12 处、`searchText` 10 处、`isFlatView` 8 处、`fetchFolder` 7 处 …），
`history` 又是它和页面共享的唯一真相。

⇒ 再往下拆不是"搬代码"，是**给导航设计一个接口**（谁持有 history、谁负责恢复滚动、
`noteIntent` 归谁）。这类改动必须能真机回归，且一次只能动一个决策点。
本轮到此为止：**取数已出、栈留着**，这个切分处内聚性最好。

### 六轮总账

| 指标 | 起点 18:00 | 现在 |
|---|---|---|
| `index.vue` | 4579 行 / 块注释 41.2% | **1989 行 / 29.4%** |
| script | 2385 | **1525** |
| 组合式模块 | 1 | **9** |
| 独立样式文件 | 0 | 7（4 scoped .less + 3 全局 .css） |
| 重复块（≥8 行） | 2（均为既有 vendored） | 2（未增） |
| 死导入 / 死导出 | 若干 | 拆一轮清一轮 |
