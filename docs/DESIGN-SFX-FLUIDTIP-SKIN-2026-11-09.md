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
