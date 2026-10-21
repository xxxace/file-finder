# DESIGN-PLAYLIST-2026-10-21 · 收藏分类（清单 / Playlist）功能方案 · 终版

> 状态：**已锁定（v1）** —— 2026-10-21 业主批准「按推荐来」，经代码交叉验证 + 体验审查后定稿。
> 需求原话：「加个收藏分类功能，保持现有功能不变，选中某个文件进文件清单，类似听歌软件的自定义歌单 / 视频网站的 playlist。风格尽量统一，不要 table 式列表，功能设计合理、体验好。」

---

## 一、决策记录（已锁定）

| # | 决策 | 内容 |
|---|---|---|
| D1 | **详情落点** | 主视图**虚拟屏**（path = `@pl:<id>`），复用网格/光标/搜索/预览/打开/返回 —— 全站只有一份网格实现 |
| D2 | **命名** | 功能名「**清单**」；系统默认清单「**收藏**」（不可删、不可改名） |
| D3 | **v1 范围** | L1：一键加入收藏 + 选单加入自定义清单 + 货架 + 详情屏 + 移除 + 删清单确认。**L2 拖拽排序、L3 批量加入后置**（他触发再做） |
| D4 | **存储** | `~/.file-finder/playlists.json` 明文 JSON + 串行写队列 + tmp→rename 原子写（照 `assistant/rules.ts` 先例，不进 nedb 加密库） |
| D5 | **条目身份** | 盘序列号 + 盘内相对路径 + 快照（name/ext/type/size/sig/files）—— 与只读锚点 `#serial/relPath` 同机制 |
| D6 | **边界行为** | 同文件可进多个清单、可重复加入；移除无确认；删清单 dialog 确认；离线条目显示徽标不消失；文件被搬走 → 保留快照，打开时走现有错误提示 |
| D7 | **唯一既有代码精化** | `previewUrlOf` 的 canBuild 从屏幕级 `readOnlyLevel` 改为条目级 `!isReadOnlyPath(item.dir)`（§三-C2 证明在现有屏幕上等价） |

---

## 二、方案总览

```
主网格（现有，一字不改）
  右键卡片 ⇒ 「加入收藏」1 击入默认清单 ｜ 「加入清单…」弹选单（✓ 已收录 + ＋ 新建）
  已收录卡片 ⇒ 左上角星标（绝对定位，不碰网格几何）
        │
货架（全屏 modal · 卡片网格，非 table）
  封面拼格(≤4 张 bin 仓缩略图) + 名称 + 数量；右键 ⇒ 重命名 / 删除；末位「＋ 新建清单」
        │ 点击卡片
清单详情屏（主视图虚拟屏 @pl:<id>）
  面包屑「清单 / <名称>」；复用网格全部能力；刷新/重读/换封面在该屏禁用；
  离线条目 ⇒ 右上角「离线」徽标；右键 ⇒ 复制文件名 / 从清单移除
        │ 数据层（除"打开那一刻"外全程零读盘）
  playlists.json（系统盘）── 条目身份 = serial + relPath
  打开那一刻 ⇒ resolveAnchor（现有接口）把序列号解析成此刻盘符
```

---

## 三、交叉验证记录（每条假设 ≥2 个独立证据）

### C1 锚点身份机制可直接复用 ✅
- 证据①（服务端）：`ANCHOR_PREFIX='#'`、`resolveAnchorController`、`anchorOfController` 已存在（server/index.ts:854-890、1816、1890-1891）
- 证据②（渲染层）：`openFile` 已在打开那一刻走 `resolveAnchor`，且注释明确「判据必须是事实（盘此刻在不在），不能是地址形态」（index.vue:987-1013）
- 证据③（纯函数）：`ancestorsOf` 已能解析 `#serial/rel` 面包屑（utils/index.ts:124-136）
- ⇒ 清单条目存 serial+relPath，打开/面包屑/离线判定全部走既有机制，**零新机制**。

### C2 `previewUrlOf` 必须改条目级判据（D7）✅
- 证据①：现状 `canBuild = !item.previewReady && item.type === 'image' && !readOnlyLevel.value`（index.vue:390）—— 屏幕级
- 证据②：清单屏是在线/离线**混合**屏；`previewUrlOf` 用 `fullPathOf(item)` 逐条拼 `p` 参数（index.vue:391）⇒ 判据本就该逐条
- 等价性证明：在线屏所有 `item.dir` 都是实时路径（`toWire` 补盘符，server/index.ts:814）⇒ `isReadOnlyPath(dir)` 恒假 ≡ `!readOnlyLevel`；只读屏全是锚点 ⇒ 恒真 ≡ `readOnlyLevel`。**现有两类屏幕行为逐像素不变**，混合屏才正确。

### C3 导航栈可干净扩展 ✅
- 证据①：`enterScreen(path, mode)` 是唯一导航入口（index.vue:839），`NavEntry` 已含 mode/searchText/scrollY/cursorKey（index.vue:313-346）
- 证据②：`fetchSeq` 是**模块级**序号（index.vue:1130），`fetchFolder` 只写"最新那次" ⇒ 清单取数函数共用同一计数器，跨屏切换同样防过期覆盖
- 证据③：`jumpTo`（保留历史跳转）先例已在（index.vue:906）——「从货架进详情、返回可回」是同构动作
- ⚠️ **抓到的集成细节**：`fetchFolder` 有 6 个调用点（651/871/1218/1367/1674/2136）。若每点加 `if (pl)` 分支 = 6 处补丁（项目明令禁止的形态）。
  ⇒ **结构解法**：新增唯一出口 `loadScreen(entry: NavEntry)`，内部按 `entry.pl` 分派；5 个需要分支的点（onBack 恢复、refreshAfterApply、扫描收尾、swapTop、enterScreen）全部改调 `loadScreen`。onRefresh 加 playlistLevel 守卫后永不会在清单屏跑，不需要分支。

### C4 预览层零改动复用 ✅
- 证据：`usePreview` 的全部入参是 fileList/keyOf/displaySrcOf/previewUrlOf（usePreview.ts:46-85），`previewEntries` 从 fileList 派生（:177）⇒ 清单条目只要是 WiredFileInfo 形状，预览/翻页/定位/渐进清晰全链路自动生效

### C5 图名派生共用一份实现 ✅
- 证据：`thumbNameOf`/`previewNameOf`/`hasBin`（server/index.ts:194-195、786-803）
- 落地：把这两个 1 行命名函数**搬进 `binStore.ts`**（bin 仓本就是名字与内容的真相源），index.ts 与 playlist 路由都从那里 import —— 不新增第二份实现、不造循环依赖

### C6 存储模式有先例可抄 ✅
- 证据：`rules.ts` 的 FILE_STORE + WRITE_CHAINS 串行写队列 + atomicWrite(tmp→rename) + JSON 损坏回落 PRESET（rules.ts:280-320）
- ⇒ playlistStore.ts 逐字照搬同一模式（含"损坏不崩、回落空清单"）

### C7 盘在线判定零读盘 ✅
- 证据：`getDrives()` 进程内缓存（driveIdentity.ts:125）；`serialOfDrive(letter)` 内存注册表（:70）
- ⇒ serial→letter 用 `getDrives().find(d => d.serial === s)`；加入时反查 letter→serial 用 `serialOfDrive`。都不碰盘

### C8 插拔响应可挂接 ✅
- 证据：`ff-disks-changed` 已有监听与 swapTop 降级/升级逻辑（index.vue:2074、2127-2156）
- ⇒ `onDisksChanged` 开头加一个分支：栈顶是清单屏 ⇒ 重取清单条目 + 刷新全局收录索引（徽标/✓ 自动翻转），silent（徽标变化本身即反馈）

### C9 其余事实核对 ✅
- 空态机制：`emptyTip` computed（index.vue:554）加清单分支文案
- 面包屑首段不可点：`onCrumbClick` 对 root 直接 return（index.vue:918）⇒ 清单屏的「清单」根段要能开货架，加**一个**分支（:917 处）
- modal 先例：`AssistantRulesModal` 全屏 preset="card"（:1-3）；`HistoryTable` v-model:show 轻量 modal（:2）⇒ 货架用后者（轻量、可点遮罩关）
- 图标实物确认：AlbumsOutline / BookmarkOutline / ListOutline 均存在于 node_modules/@vicons/ionicons5
- POST 路由：`route()` + `req.body`（server/index.ts:1859、1975）；前端 getAction/postAction/deletAction 三件套（request.ts:77-97）
- 扫描期安全：扫描循环刻意不碰 dataSource（index.vue:1462-1464 注释）⇒ 扫描中进清单屏安全；「清单」按钮在 scanning/picking 时禁用（同「更多」的手法）
- 网格几何：`pick-badge` 绝对定位先例（index.vue:189-194、2497-2509，top-right）⇒ 星标放 **top-left**、离线徽标放 **top-right 下方**，都不参与布局

---

## 四、体验审查记录（U1–U12，全部落入设计）

| # | 审查点 | 决议 |
|---|---|---|
| U1 | 货架封面 | 取前 4 个**有图**条目（hasBin 过滤）的 `t-<sig>` 拼 2×2；空清单 = 居中 BookmarkOutline 占位，不留空白 |
| U2 | 选单排序 | 「★ 收藏」置顶（默认清单）→ 自定义按创建时间 → 分隔线 → 「＋ 新建清单」；已收录的清单打 ✓ |
| U3 | 加入反馈 | toast 一行「已加入「收藏」」+ 该卡左上角**星标即刻出现**（全局收录索引驱动）—— 不弹窗、不打断 |
| U4 | 详情屏右键 | 复制文件名 + 从清单移除（保留复制，与主网格一致） |
| U5 | 重命名/新建 | **行内编辑**（货架内该格变输入框，回车确认/Esc 取消）—— 不引入 dialog 机器，速度最快 |
| U6 | 删清单 | dialog 确认，正文列「名称 + N 个条目」（破坏性动作同「重读这一片」用 dialog 的先例） |
| U7 | 面包屑 | 「清单 / <名称>」，当前段带条目数角标（同 `data-count` 先例）；点「清单」根段 = 开货架（回总览的捷径） |
| U8 | 搜索框 | 清单屏过滤清单内条目（fileList 机制免费获得） |
| U9 | 离线条目 | 徽标 + **不灰化**（缩略图仍可用）—— 同只读层哲学：内容可用，只是盘不在 |
| U10 | 空清单提示 | 「这个清单还是空的 —— 在网格里右键卡片「加入收藏」即可收录」（告诉下一步做什么） |
| U11 | 工具栏入口 | 「缓存记录」旁的图标按钮（AlbumsOutline），tooltip「我的清单」；scanning/picking 时禁用 |
| U12 | 收录索引 | 启动时 GET /playlists 一次（轻量索引：id/name/system/count/covers/keys）；加入/移除后重取；插拔时重取 —— 星标与 ✓ 永不脱焊 |

---

## 五、数据模型（终版）

```ts
// ~/.file-finder/playlists.json
interface PlaylistFile { version: 1; playlists: Playlist[] }
interface Playlist {
  id: string;                 // pl_<rand>
  name: string;
  system?: boolean;           // true = 「收藏」，不可删不可改名
  createdAt: number;
  items: PlaylistItem[];
}
interface PlaylistItem {
  id: string;                 // it_<rand>
  serial: string;             // 盘序列号 = 身份
  relPath: string;            // 盘内相对路径（条目所在目录，同 FileInfo.dir 语义）
  name: string; ext?: string; // 显示名快照
  type: FileKind;             // folder | image | video | file
  size: number;               // 字节快照
  sig?: string;               // 缩略图指纹 ⇒ bin 仓取图，零读盘
  files?: { name: string; size: number }[];  // 目录代言卡快照 ⇒ 双击行为与主网格一致
  addedAt: number;
}
```

**为什么必须存 `files` 快照**：`decideOpen` 靠 `isDirCard`（files 非空）区分"这一格代表什么"（openDecision.ts:51）—— 丢了 files，"一部片一个目录"会被错判成图片弹预览（2026-10-04 真机 bug 的同一判据）。

**加入时前端只送卡片快照** `{dir, name, ext, type, size, sig, files}`，serial/relPath 由**服务端**从 dir 推导（在线：splitPath + serialOfDrive；离线：解析 `#` 前缀）—— 渲染层永远不碰序列号（既有分工）。

---

## 六、服务端设计

### 6.1 新文件
- `electron/server/playlistStore.ts`（~150 行）：JSON 存储 + CRUD（照 rules.ts 模式：内存态 + 串行写队列 + 原子写 + 损坏回落）
- `electron/server/playlist.ts`（~140 行）：HTTP 路由 + 条目装配
- `electron/server/index.ts`：注册 7 条路由（~10 行）；`thumbNameOf`/`previewNameOf` 搬去 binStore.ts（2 行移动 + import 改动）

### 6.2 路由（camelCase，同 `/openFolder` 家族）

| 路由 | 作用 |
|---|---|
| `GET /playlists` | 收录索引：`[{id, name, system, count, covers[≤4], keys[]}]`；keys = 每条目**当前形态**的 `dir/name`（在线=实时盘符，离线=锚点）—— 前端直接与 `keyOf(card)` 比对 |
| `POST /playlistCreate` `{name}` | 新建（重名允许） |
| `POST /playlistRename` `{id, name}` | 重命名（system 拒服 400） |
| `POST /playlistDelete` `{id}` | 删除（system 拒服 400） |
| `GET /playlistItems?id=` | 详情：逐条装配成 WiredFileInfo —— dir 在线补盘符/离线给锚点；thumb/avatar/preview/previewReady 按 wire() 同款规则（hasBin 过滤） |
| `POST /playlistAdd` `{id, entries[]}` | 加入（服务端推导 serial+relPath；写盘串行） |
| `POST /playlistRemove` `{id, key}` | 按当前形态 key 移除首个匹配 |

---

## 七、前端设计

### 7.1 新文件
- `src/views/FileFinder/playlist.ts`（~160 行）：类型 + API 客户端 + **模块级响应式收录索引**（单一状态源，货架/选单/星标/✓ 共读）+ 纯函数（probe 可测：key 规范化、拼格选取、离线判定）
- `src/views/FileFinder/PlaylistShelfModal.vue`（~220 行）：货架 modal（卡片网格 + 行内新建/重命名 + 右键删除确认）
- `src/views/FileFinder/PlaylistPicker.vue`（~90 行）：「加入清单…」选单内容（✓ 状态 + ＋ 新建行内输入）

### 7.2 `index.vue` 改动（~+160 行，全部挂在既有机制上）
1. `NavEntry` 加 `pl?: { id: string; name: string }`；路径前缀常量 `PL_PREFIX = '@pl:'`
2. 新增 `loadScreen(entry)` 唯一出口（C3），5 个调用点改调它；`fetchPlaylistItems(id)` 共用 `fetchSeq`
3. `enterPlaylist(id, name)`：同 enterScreen 职责（rememberCurrentScreen + push + noteIntent + 视口归零 + 取数）
4. `crumbs` computed 加清单分支（U7）；`onCrumbClick` 加「清单根段开货架」一个分支
5. `emptyTip` 加清单分支（U10）；`banner` 加清单屏 info 条（「清单视图：内容来自你的收录，盘不在的条目已标出」）
6. `playlistLevel` computed + 6 处守卫（刷新/重读/补全/换封面/补封面/F5）与 readOnlyLevel 并列
7. 工具栏「清单」按钮（ AlbumsOutline，tooltip，scanning/picking 禁用）
8. 右键菜单加「加入收藏 / 加入清单…」；清单屏右键换「从清单移除」
9. 网格卡片加星标 `<i class="pl-badge">`（top-left，绝对定位）
10. `onDisksChanged` 加清单屏分支（C8）
11. `previewUrlOf` 的 canBuild 改条目级（D7）

---

## 八、读盘清单（终版）

| 动作 | 读盘 |
|---|---|
| 新建/改名/删除清单、加入/移除条目、看收录索引 | **0**（系统盘 JSON） |
| 货架、详情屏、星标/✓ 状态 | **0**（快照 + bin 仓缩略图 + 内存盘表） |
| 详情屏双击文件条目 | 打开那一刻读（= 现有行为；盘不在 ⇒ resolveAnchor 提示） |
| 详情屏双击**文件夹**条目 | 定位该目录；没缓存过 ⇒ 触发一次扫描（同「缓存记录」跳转，唯一隐性读盘） |
| 详情屏图片停住 0.3s 升级清晰版 | 首次生成时读一次原图（现有 /preview 行为，之后本地命中） |

---

## 九、分期与验证

- **v1（本轮实现）**：§五~§八全部。
- **P2（他触发再做）**：拖拽排序（L2）、批量挑选加入（L3）、清单导入/导出。
- **验证三件套**（无测试框架）：
  1. `npm run typecheck` 0 error；
  2. `docs/probes/playlist/` 只读探针：key 规范化、拼格选取、JSON 往返、损坏回落（纯函数直 bundle 测）；
  3. 重启 dev 真机验收清单：加入(星标即刻出现) → 选单 ✓ → 货架拼格/行内改名 → 详情(搜索/预览/打开) → 拔盘(徽标+打不开提示) → 插盘(自动翻实时) → 移除 → 删清单确认 → 返回栈完整性。
