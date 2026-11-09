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
