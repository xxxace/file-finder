# 审计与收敛：全站 tooltip 一致性（2026-11-14）

> 触发：业主「我感觉很不统一这一个样式那一个样式的，你确认一下是否属实」、
> 「主样式以 header-bar 操作按钮的 tooltip 为基准，我不希望到处用，处处有差异」。
>
> 结论：**属实**。本轮已把「动作提示」全部收敛到 `v-tip` 一套材质（原生 title 37 → 14 处），
> 剩下的 14 处是**按规范保留**的全文预览，不是漏网。

## 一、唯一基准

| 项 | 值 | 来源 |
|---|---|---|
| 实现 | `v-tip` 指令 → `FluidTipHost.vue` | `src/components/FluidTip/` |
| 底色（浅） | `rgba(0,0,0,.86)` | `--ff-tooltip-bg` |
| 底色（深） | `rgba(30,30,32,.92)` + `blur(16px) saturate(140%)` | 同上 |
| 文字 | `--ff-tooltip-text` | 浅 `#fff` / 深 `--ff-text-1` |
| 投影 | `--ff-tooltip-shadow` | 深色带 1px 白发丝内描边 |
| 几何 | 圆角 `8px`、`12.5px`/500、`nowrap`、首现 150ms | `FluidTipHost.vue` `.ftip` |

**这就是「顶栏那颗按钮的提示」，全站提示只有一个视觉答案。**

## 二、规范（已写进代码，不是只写在文档里）

判据落在 `src/components/FluidTip/directive.ts` 头部注释 + `tokens.css` 的 `--ff-tooltip-*` 段 ——
两个位置都是"以后要改这块的人一定会看见"的地方。

| 信息形态 | 用什么 | 判据 |
|---|---|---|
| 动作名 / 状态 / **为什么点不动** / 快捷键 | `v-tip`（反色深片） | 只在 hover 时才有意义，界面上无处常驻 |
| 截断文本的**全文预览**（名称 / 路径 / 标题 / 大小） | 原生 `title` | 见下，**不要**换成 v-tip |
| ≥2 行结构化信息（键值表） | `v-tip` + `body`（玻璃面板） | 单行胶囊装不下表格；11-14 裁决 |

**全文预览为什么留在原生 —— 不是懒，是更对：**
1. 这类提示出在列表/网格里，是**扫视**场景。`v-tip` 150ms 首现 + 簇内滑动会随指针连续弹出，
   比原生 ~1s 延迟**更吵**；原生的延迟正好当过滤器。
2. **零 DOM、零监听器**。网格里可能上千条目，每个挂一条指令是纯浪费 —— 业主担心的"性能负担"，
   在这个场景是真实存在的，不是假想。

## 三、⚠️ 一个被实测推翻的错误结论（留给后来人）

第一版审计里我断言：「`v-tip` 依赖 `pointerenter`，而 `disabled` 元素不派发指针事件
⇒ 禁用态的"为什么点不动"只能用原生 title，这是技术阻碍」。

**这个断言是错的。** 探针实测（`docs/probes/disabled-hover/probe2.cjs`，Electron 37.10.3）：

```
A. enabled  button                => on:pointerenter, on:pointerleave
B. disabled button                => off:pointerenter, off:pointerleave    ← 成对派发
C. disabled + pointer-events:none => （零事件）                             ← 对照组有效
```

- `disabled` 只抑制**激活类**事件（click / 键盘激活），**不抑制** pointer/mouse 的 over/enter/move。
- 只有 `pointer-events: none` 才完全不派发 —— 对照组零事件证明探针本身可信。
- `elementFromPoint` 对 `pointer-events:none` 返回 `BODY`，坐标与命中测试也对得上。

⇒ **禁用按钮可以放心用 `v-tip`**，`pointerleave` 成对派发，不会把提示卡住。

（教训：我差点因为一个未经验证的"浏览器常识"改坏 `CoverCard` 的两处提示 —— 那里 title 的内容
100% 是为禁用态写的，换过去会变成"悬停没有任何反馈"。刹车踩在"先跑最小复现"上，而不是
"再读一遍代码"。另：第一版探针的对照组 CSS 选择器写错了（`#pe-none` vs `id="offPN"`），
差点得出"pointer-events:none 也派发事件"的反向错误结论 —— 对照组救的正是这个。）

## 四、本轮改动清单

### 已换 `v-tip`（23 处）

| # | 文件:行 | 内容 | 备注 |
|---|---|---|---|
| 1 | `assistant/AssistantShell.vue:4` | 返回 | 两个助手面板共用 |
| 2 | `assistant/CoverCard.vue:30` | 换一帧 / 已经到中段了… | 原为禁用态解释 |
| 3 | `assistant/CoverCard.vue:41` | 选择 / 取消选择 / 任务进行中… | 原为禁用态解释 |
| 4 | `assistant/AvatarRow.vue:13` | `checkTitle` | 原为禁用态解释 |
| 5 | `Cache/index.vue:32` | 刷新 | **原来最刺眼的一处**；同日复查发现它还多认了一遍盘，已改为零读盘，文案回到两个字（见 §六） |
| 6 | `AssistantCoverModal.vue:53` | 抽帧缓存有 N 张已无引用… | |
| 7 | `AssistantCoverModal.vue:142` | 全选 / 取消全选 | |
| 8-13 | `AssistantCoverModal.vue:157,168,180,220,243,278` | 补封面 / 这块盘现在不在线… | 6 处同一句话 |
| 14 | `HomeDisks.vue:20` | 离线盘序列号（在线时为空串 ⇒ 不显示） | 在线时原本只是重复盘名 |
| 15 | `HomeDisks.vue:38` | 选择顶层目录 | |
| 16 | `PlaylistPicker.vue:10` | 已在这个收藏夹里 | |
| 17 | `Settings/FrameCacheBlock.vue:33` | 只重算系统盘上的缓存与记录 | |
| 18 | `Settings/FrameCacheBlock.vue:42` | 核实按钮的三态说明 | |
| 19 | `AlbumCoverTunnel.vue:36` | 暂停漫游 / 继续自动穿行 + **Space 键帽** | 原来把"(空格)"塞在文案里，现在走真键帽 |
| 20 | `AlbumCoverTunnel.vue:44` | 全屏体验 / 退出全屏 | |
| 21 | `AlbumCoverTunnel.vue:51` | 实时渲染帧率 | |
| 22 | `AlbumCoverTunnel.vue:105` | 在文件列表中定位 | |
| — | `AlbumCoverTunnel.vue:17` | **删除** `title="返回"` | 按钮里有 `<span>返回</span>`，纯重复；保留只会多弹一个灰块 |

### 保留原生 `title`（14 处，全部是全文预览）

| # | 文件:行 | 内容 |
|---|---|---|
| 1 | `index.vue:94` | 面包屑首段全路径 |
| 2 | `index.vue:104` | 面包屑各段全路径 |
| 3 | `index.vue:246` | 列表项 `名称 + 大小` |
| 4 | `index.vue:295` | 网格项目录路径 |
| 5 | `index.vue:315` | 卡片标题 |
| 6 | `index.vue:435` | 搜索结果 `名称 + 大小` |
| 7 | `assistant/CoverCard.vue:49` | 作品名 |
| 8 | `assistant/CoverCard.vue:52` | 路径 |
| 9 | `assistant/AvatarRow.vue:36` | 文件夹名 |
| 10 | `assistant/AvatarRow.vue:37` | 说明 / 相对路径 |
| 11 | `Playlists/index.vue:23` | 收藏夹名 |
| 12 | `AlbumCoverTunnel.vue:81` | 卡片标题 |
| 13 | `AlbumCoverTunnel.vue:86` | 目录路径 |
| 14 | `AssistantAvatarModal.vue:14` | 目标范围全路径（`scopeLabel`） |

**共同点**：文字本身已经在屏幕上，title 只负责补全被 `text-overflow` 截掉的部分。
它们出现在网格 / 列表 / 面包屑这种指针会快速扫过的区域 —— 换成 `v-tip` 是"为了统一而制造噪音"。

### 不动（刻意，有裁决依据）

| 落点 | 材质 | 依据 |
|---|---|---|
| 卡片回收 hover（`CoverCard.vue` 的 `article`） | 玻璃面板 `--ff-tip-*` | 业主 11-14 明确排除；富内容是键值表，单行装不下 |
| 缓存页盘条 chip hover（`Cache/index.vue:514`） | 同上 | 同属"富内容"，与卡片回收同一工种 |
| 左轨胶囊（`RailTip.vue`） | 玻璃面板 | 2026-11-09 裁决"左轨专属特色，不动"；它是**滑动胶囊**，不是气泡 |
| `n-slider` 数值气泡（`Settings/GeneralPanel.vue`） | naive Tooltip 主题 | 已配 `--ff-tooltip-bg`，底色一致 |

## 五、仍然存在的差异（诚实记录）

1. **富内容玻璃面板 vs 单行黑片**：同一个 hover 动作，一行字是黑片、多行表是玻璃片。
   这是 11-14 的裁决（业原话「卡片的 tooltip 为什么还是乌漆嘛黑」），本轮**未改**。
   若业主认为这也是"不统一"，需要重新裁决 —— 但它属于"面板"而非"气泡"，我倾向保留。
2. **`--ff-tip-*` 与 `--ff-tooltip-*` 命名混淆**：前者是磨砂面板，后者才是 tooltip。
   改名会触及 6 个文件，收益是"以后没人搞混"。本轮**未做**（不在"统一配色"的诉求内）。

## 六、附：缓存页刷新为什么不再碰盘（2026-11-14 追加）

业主追问「刷新并重探盘符是什么意思？不是刷新缓存列表吗？难道还读盘？」——**读盘了**，但那是
第二层的事，被混进了第一层。三层必须分开说：

| 层 | 动作 | 读什么 | 谁在做 | 能不能省 |
|---|---|---|---|---|
| **① 认盘** | `fs.stat('X:/')` × 26 个盘符 | 卷序列号（`stat.dev`），**不碰目录内容** | `diskWatch`（插拔瞬间一次）· `findDriveByLetter`（打开文件夹时复核 1 个盘符） | **不能** —— WM_DEVICECHANGE 只说"设备变了"，不说"是哪块盘"。不探测就只能轮询，更糟 |
| **② 扫目录** | readdir + mtime → 写缓存 | 目录项与修改时间 | 文件视图的「刷新 / 更新读取 / 重新读取」 | 能 —— 但这是**功能本身**，业主要的就是它 |
| **③ 读文件** | 缩略图 / 抽帧 / 封面 | 文件字节 | 图像管线、管理助手 | 按需 |

**原实现的问题**：缓存页那个「刷新」调的是 `/getDisks?refresh=true` ⇒ 它做了一次**①**。
而主进程 `diskWatch` 在插拔时刚做过同样的事，并把结果推给了本页。
代码注释自己写着「等于拿 26 次 stat 换一次刚做过的事」—— 明知冗余还留着。

**改法**（`Cache/index.vue`）：`onRefresh` 与 `reloadAfterDataChange` **合并成一个 `refreshList()`**
（原来两份实现做同一件事），一律走无 `refresh` 的 `/getDisks`（读进程内盘表缓存，零读盘）。
按钮文案回到「刷新」。三个入口共用：刷新按钮 / 删除还原合并后 / 插拔 IPC 推送。

**代价（诚实记录）**：失去"手动重探盘符"的兜底。若 `diskWatch` 的钩子漏了事件，
界面只能等下一次插拔或重启应用才恢复。判定为可接受 —— 因为槽点事件的覆盖率是实测过的
（`docs/probes/hotplug/`），而且"为了一个罕见兜底让每次点刷新都碰盘"明显不划算。

## 七、验证

- `npm run typecheck`：0 error。
- 探针：`docs/probes/disabled-hover/probe.cjs` + `probe2.cjs`，输出 `out.txt`（已实测）。
- **未做真机目视**：提示首现延迟、簇内滑动、全屏隧道层的压盖效果，需业主重启 dev 后目视。
  尤其是 `AlbumCoverTunnel`（全屏层）——`.ftip` 是 `z-index: 4000`，隧道内最高 `15`，
  静态看能压住，但**未实测**。
