# 界面质感升级 · 音效 + Fluid Tip + 重皮 · 2026-11-09

分支：`feat/sfx-fluid-tip-skin`（自 master @ ahead 15 切出）

## 〇、grill 决策记录（主人已确认）

| # | 决策 |
|---|---|
| 1 | **无彩裁决不动**：不引入 react-bits 的彩色渐变，只摘交互与质感 |
| 2 | 非商用；**有现成的轮子就用现成的**，不闭门造车 |
| 3 | Tooltip **只改功能页**；左轨胶囊（RailTip）是特色，**保持原样** |
| 4 | **不上 hover 音效**：Apple HIG 同判据——hover 是高频连续动作（Apple HIG / macOS / VS Code 均不做）；reactbits.dev 的 hover 音效是营销站表演 |
| 5 | **方向键 / 回车不上音效**：判据「视觉反馈已即时的动作不加声」（预览层弹出本身即最强反馈） |
| 6 | 音效事件 = 离散、低频、缺视觉反馈 三条件筛出，主人过目确认 |

## 一、架构（已落地 · 第一批）

```
src/utils/sfx/
  engine.ts    ← react-bits react-bits-sound.ts 去壳版（剥离 React hook，1069 行纯 Web Audio）
  recipes.ts   ← 9 个音效配方（Sound Lab interface.js 逐字 JSON，Node 实跑解析所得）
  index.ts     ← 唯一入口 playSfx(event)：事件表 + 60ms 去重 + localStorage ff.sfx + 空闲预渲染
```

- **零二进制音频资产**：Sound Lab 音效本质是 Web Audio 合成配方，运行时合成、AudioBuffer LRU 缓存（96 条）⇒ 不碰打包路径/asarUnpack，也不需要 Howler（它管音频文件，我们无文件）。
- **许可**：MIT + Commons Clause —— 音效/引擎可用于应用（含商用），不得单独倒卖或做成托管服务。已在 recipes.ts 头部标注来源。
- **接线的唯一出口**：`useNotify`（success → `success` 音，6 页自动覆盖）；主题切换在 `useTheme.toggleTheme`（daylight/nightfall）；密度切档在 `GridDensityMenu.onSelect`（notch）。设置 UI 在 Settings 页底部（开关 + 音量 + 试听）。

## 二、事件 → 音效对照

| 事件 | 音效 | 接线点 |
|---|---|---|
| 密度/视图档位切换 | notch（柔性棘轮） | GridDensityMenu ✅ |
| 主题切换 | daylight / nightfall | useTheme ✅ |
| 扫描/补全/apply 完成 | bloom（上扬双音） | useNotify(success) ✅ |
| 开关 开/关 | clasp / unclasp | Settings 音效开关 ✅ |
| 收藏添加 | bead | 待接线（收藏流） |
| 复制/导出完成 | ping | 待接线（显式调用点） |
| 错误 | nudge | **暂缓**：扫描偶发失败 toast 较多（抽帧失败率 ~0.5%），真机确认频率再挂 |

## 三、后续批次

- **第二批 · Fluid Tip（功能页单例胶囊）**：teleport 到 body 的一颗胶囊；同簇相邻锚点滑动换字、孤立点 snap 淡入；`v-tip` 指令替换 ~58 处 `n-tooltip`；kbd 快捷键角标只标真绑了快捷键的按钮。左轨 RailTip 不动。
- **第三批 · 三页质感对齐**（文件卡片 / 收藏 / 设置·站点规则）：只做 tokens v2 对齐——圆角同心、hover 只变色、空/载/错三态；不引入彩色。

## 四、自查与诚实标注

- typecheck 0 error（vue-tsc + electron tsc）✅
- 音效**未真机试听**（合成引擎为 react-bits 逐字代码，参数未改动；风险主要在首次 AudioContext 建立时机——由首次用户手势触发，浏览器策略天然合规）
- Settings 音效条**未真机目视**；待主人重启 dev 后验收
- `engine.ts` 为 vendored 第三方代码（1069 行，超项目 250 行规矩）：**不许手改**，升级 = 重新拷贝上游文件重新去壳；头部已标注

## 五、第二批 · Fluid Tip 落地记录（同日）

```
src/components/FluidTip/
  fluidTip.ts       ← 状态单例：同簇判定(≤160px 相邻→滑动) / 孤立→snap / 75ms 离开缓冲
  directive.ts      ← v-tip 指令（全局注册）：v-tip="'文案'" 或 v-tip="{ text, keys: 'S' }"
  FluidTipHost.vue  ← 全局唯一宿主（App.vue 与 OverlayHost 并排，Teleport body, z 4000）
```

- **已替换**（顶栏工具簇 = 演示滑动的主场景，7 锚点）：FolderSelector、返回/前进、刷新、搜索(S 带真键帽)、密度、平铺。`NTooltip` 已从 index.vue / FolderSelector 摘除。
- **保留 naive 的**：Cache 盘条 chip 的多行明细提示（富内容非单行胶囊的工种）；其余 `title=` 原生提示待后续顺手换。
- 交互动效：滑动 = transform 200ms `--ff-ease-move`（一拍），snap = 只淡入；触屏不显示；disabled 按钮无 hover 事件（与 n-tooltip 行为一致）。
- typecheck 0 error；**未真机目视** —— 待主人验收：顶栏从「选择文件夹」滑到「刷新/搜索/平铺」应看到同一颗胶囊滑动换字，跳到网格内任意 title= 处应是 snap 落位。

## 六、验收反馈第一轮（主人 2026-11-09）

1. **FolderSelector 键帽**：新增 `keys` prop，index.vue 传 `keys="D"`、label 去掉 "(D)" 后缀（键帽接管快捷键展示）。
2. **仿照不像 → 拿到官方源码逐字对齐**：找到 `WarmTooltip`（`src/content/Micro/WarmTooltip/WarmTooltip.css`）。修正：字号 12.5px / letter-spacing -0.01em / gap 7px / padding 6px 10px（去掉固定 32px 高）/ 双层投影；键帽 = 高 1.55em、radius 0.4em、bg 10%、**inset 0 -1px 0 下沿暗线**（键帽像"键盘键"的关键，此前缺的就是它）、color 72%。首现加 150ms warm-up 延迟（官方 400ms，取 150 保 fluid），簇内滑动仍即时跟手。
3. **左轨 hover 音效**：主人指定，覆盖"不上 hover 音"一般规则。新增 nib 配方（tiny gentle tick），EVENT_VOLUME_DB 再压 -8dB；接在 RailNav.onEnter（pointerenter + focus 共用出口，触屏已排除）。

## 七、第三批 · 三页 tokens 对齐（同日）

**结果：`no-raw-color` 探针 53 → 0，业务代码零色值字面量**（typecheck 0 error）。

| 位置 | 旧（裸值） | 新（token） | 说明 |
|---|---|---|---|
| 封面"已选"绿圈 + 勾选角标 | `#18a058` | `--ff-status-ok` | 勾选=图形级绿（浅 #34c759/深 #4ade80，比旧值更亮更对） |
| 收录星标 | `#d8a00f` | `--ff-status-warn` | 图形级琥珀 |
| 失效徽标 | `#d03050` | `--ff-danger-badge` | 同值替换 |
| 徽标外圈/勾/白字 | `#fff` ×5 | `--ff-on-highlight` | 两主题恒白 |
| 打开遮罩/徽标描边 | `rgba(0,0,0,…)` | `--ff-mask` | 压照片的暗层，同语义 |
| 列表视图文件名/大小 | `#374151`/`#9ca3af` | `--ff-text-1`/`-2` | ⚠️ 旧值在深色主题下对比度仅 ~1.8:1（近隐形），token 顺带修掉 |
| PlaylistPicker | `#18a058`/`#ececec` | `--ff-status-ok`/`--ff-line` | |
| RuleSiteList | 紫灰 hover/active、灰分隔线 | `--ff-ctl-hover`/`--ff-ctl-on`/`--ff-line-strong` | 对齐「悬浮/选中与菜单栏统一」裁决 |
| RuleTestResult | `#18a058`/`#d03050`/灰底 | `--ff-ok`/`--ff-danger`/`--ff-raised` | 文字级语义色（非图形级） |
| FluidTipHost 键帽/投影 | rgba ×5 | 新 `--ff-tooltip-kbd-*`/`--ff-tooltip-shadow` | 永远反色深底，值进 tokens.css（同 --ff-media-* 工种） |

未动（有判据）：`.cursor` 的 `transform: scale(1.012)`（键盘焦点态非 hover，注释已论证）；Cache 盘条富提示（naive）。
**未真机目视** —— 待主人验收三页明暗两主题。

## 八、第四批 · 设置页拆身份重构（同日，主人批准）

依据：Microsoft《Guidelines for app settings》+ Apple HIG + GNOME/libadwaita + Raycast/Linear 实践。

- **反模式诊断**：原页 = 站点规则编辑器（工具）戴着设置牌子；偏好（音效）缩在底部。Microsoft 明文「工作流命令不进设置页」。
- **新骨架**：左导航（通用 / 站点规则，图标行 = 名称+说明，圆角 8 灰底激活态，同左轨一族）+ 右单列面板（max-width 900）。
  - `GeneralPanel`：音效卡（SettingsCard 行：左标题说明右控件）· 备份与迁移卡（BackupPanel 整块复用——2026-11-08 抽离时预留的归宿）· 关于卡（版本号，无音效来源披露——主人裁定）。
  - `SiteRulesPanel`：规则编辑器**原样搬入**（工具现场一字未动）。
  - pane 记忆 localStorage `ff.settings.pane`（Apple：恢复最近查看）。
- 「打开数据目录」不重复进关于卡（BackupPanel 已有同一动作）。
- typecheck 0 error；未真机目视。

## 九、备份与迁移动作行重设计（同日，主人："感觉都是文本"）

范式来源：1Password / Bitwarden / Telegram / 浏览器 profile 导出（同一套）。
- 每动作一整行：语义图标（出=↑ 进=↓ 合并=git-merge 文件夹=folder-open）+ 动词标题 + **后果说明放第二行**；整行可点；行内 NSpin 代替按钮 loading。
- 危险动作（从文件还原）= 标题级红文字 `--ff-danger`（macOS HIG 模型，沿用）。
- ≤5 动作不折叠；折叠是"高级区"工种——原折叠还造成"备份与迁移"标题出现两次。
- **逻辑/文案零改动**，对外仍是 `migrated` 事件；GeneralPanel 卡头描述同步去掉"折叠区"字样。
- typecheck 0 error；未真机目视。

## 十、收尾三优化（同日）

1. **回车开文件 2s 节流**：只锁 `open-item`（播放器），目录 drill（导航）不锁——连进两层目录不能被 2s 卡住。
2. **定位蒙层动效化**：`is-locating` 的 opacity 过渡挪到 `.image-box-item` 基类——原来撤销蒙层是硬切（.3→1 瞬跳）；现在压暗 .12s / 恢复 .2s 进出不对称；蒙层期间光标卡 scale 1.012→1.02 再抬一档（同族 scale 语言，不引入第二色，遵守 2026-10-04 撤橙框结论）。
3. **预览开合过渡 token 化**：覆盖 naive 的 fade-in-scale-up（原 .2s scale .9 弹跳 + 退场缩尺）→ 进场 200ms --ff-ease-move scale .965、退场 140ms 只淡出；写在 index.vue 非 scoped 块（预览 DOM teleport 到 body）。缩放/拖动不受影响（transition 类动画后即摘，内联 cssText 独立）。
- typecheck 0 error；未真机目视。

## 十一、预览工具栏重构（同日，主人批准：选框要、bar 居中、美感照 Apple/react-bits）

- **回归居中胶囊 bar**：撤销 2026-11-08 的"贴底通栏"裁定（2048px 上 9 颗图标视觉重量全失）；玻璃底 + 999px 圆角 + 投影。
- **三组结构**（Apple Quick Look）：信息段（名称·计数）｜位置组（定位·上一条·下一条）｜变换组（旋转×2·原尺寸·缩放±）｜✕；组间发丝分隔，✕ 前间距加大（防误触教训）。
- **滑动选框**（LeiBox multi-cursor-builder live-selection-box 模型，曲线 .35s cubic-bezier(.2,.8,.2,1) 照抄其源码）：一颗 .ptb-sel 在图标间滑，全站第三个"同节点形变"实例。
- **按下回弹** scale .94（--ff-ease-enter 过冲族）；命中区 36px；naive 图标（.n-base-icon 28px/padding8）拍平进格子。
- 逻辑零改动（onClick 全保留）；typecheck 0 error；未真机目视。

## 十二、工具栏二轮（同日）
- 点击区=选框=36px：naive 点击处理器挂在图标 span 上（20px），CSS 撑满 cell 后三面积重合。
- bar 宽度上限已有（min(92vw,980px)），名称 min(40vw,560px) 截断；宽度变化走 WAAPI FLIP（旧宽→新宽，过冲 1.4），名称/计数变更做 200ms 拍内分带滑入。

## 十三、确认框漏网之鱼收口（同日，主人点名）

- 症状：头像回收"写入"的确认还是旧样式（n-popconfirm，不吃 tokens 主题覆盖）。
- 为什么会漏：n-popconfirm 是 naive 直渲染的气泡，**不在 naive-theme 的主题覆盖链上**，
  而 Overlay confirm（useConfirm → OverlayHost）才是全站确认框的唯一出口——
  这两处是当初抽 Overlay 时漏改的存量。
- 修法（一份实现，不是点补丁）：AssistantAvatarModal（写入 N 个头像）与
  AssistantCoverModal（深度重扫）全部改走 `useConfirm().warning({...})`，
  文案原样平移；NPopconfirm import 摘除。
- 漏网审计：全库 `n-popconfirm|NPopconfirm|useDialog|useMessage|window.confirm` 已**清零**
  （仅存注释里的历史记录）；`useNotification` 无调用方（App.vue 的 Provider 暂留无害）。
- typecheck 0 error。

## 十四、失败音 + 插拔音（同日，主人点名）
- **warning/error toast 全部响 warn（nudge）**：撤销此前"等真机确认频率"的搁置——56 处全是离散低频的用户动作失败（文件失效/盘不在/表单校验），接在 useNotify 唯一出口。
- **移动硬盘插拔**：Sound Lab dawn（接入上扬）/ dusk（拔出下落）。payload 只有当前盘列表 ⇒ 在 onDisksChangedIpc 与上一次差分；首次事件只建基线不响（启动≠接入）。
