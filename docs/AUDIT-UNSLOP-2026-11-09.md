# unslop 审计 · File Finder 主界面（2026-11-09）

skill: [heydamir/unslop](https://github.com/heydamir/unslop) (CC BY 4.0, Damir Sokolovsky @heydamir)
已安装到 `~/.workbuddy/skills/unslop/`。

## 结论

**没有 slop。** 这不是「AI 生成味」的界面，是一套有成文裁决的设计系统。

判据（skill 第 3 步的「No slop」档）：走完 `signs.md` 七组信号，命中的只有**三处已被明确裁决过的例外**，
以及 1 处真问题（应用图标）。所以**不走九遍 pass，不重设计**。

## 逐组审计

证据等级：静态 = 读代码/grep；目视 = 真窗口截图。

| 组 | 信号 | 结果 |
|---|---|---|
| 面与色 | 紫蓝渐变 / 渐变字 / 彩色发光 / 色雾 / 霓虹边 / 五个近似色调 / 处处高亮 / 玻璃卡 | 无。面是中性四阶（#0e0e0e / #1f1f1f / #242424 / #2a2a2a），文本两档，高亮只用三处（选中/悬浮/焦点） |
| 字 | 800/900 标题 / 大写宽字距标签 / 字号爆炸 / 负字距 / 斜体 | 无。四档字号（15/13/12/11）+ 两档字重；Geist + MiSans VF 可变字重 |
| 图标 | emoji 当图标 / emoji 在 pill 里 / 多色混用 / 离列 | 无。单一线性图标集，28px 方格定宽 |
| 间距 | 任意值 / 同行不同高 / 分组倒置 | 无。4px 尺度（tokens.css `--ff-sp-*`）；封面定 3/2 比例 + 标题定两行高 ⇒ 同行等高（`gridGeometry` 分行算法的前提） |
| 文案 | 招呼语 / 感叹号 / 炒作词 / 尾句号 / 假数据 | 仅 `views/Cache/index.vue:504,625` 两处错误提示带「！」 |
| 组件 | 发光 pill 计数 / PRO·New 徽标 / 全是 pill / 彩虹图表 | 无。圆角分层正确（卡 10 / 控件 8 / pill 6） |
| 动效 | `transition-all` / `hover:scale` / 弹跳过冲 / 属性动画 | 无。`grep transition-all` 零命中（仅 crumb-motion.css 注释里说明"不能合成一条"）；曲线与拍长集中在 tokens `--ff-dur-*` / `--ff-ease-*` |

### 三处「命中但不算」的例外（主人已裁决，不动）

| 位置 | 为什么像 slop | 为什么留下 |
|---|---|---|
| galaxy 进度条（`components/GalaxyLoadingBar/`） | 紫/青/粉点阵 + 三层光晕，教科书级「purple glow」 | 2026-11-08 主人裁决「全抄参考件，并且也用紫色」；一次性状态指示器、不可点 |
| ScanGlow 扫描光雾（`--ff-glow-1/2/3` 绿蓝紫） | 彩色径向色雾 | 定义是「光本身的颜色」，不属于界面配色；2026-11-08 多轮调校 |
| 彩色文件夹图标（`FolderSelector`） | 全界面无彩，只有它是橙黄 | 主人原话「我用彩色图标是想让界面丰富些」；是"这是起点"的记忆点 |

## 真问题（只有 1 条够格，另 2 条是微调）

### 1. 应用图标：蓝紫渐变圆角方块（唯一「AI 味」最重的地方）

`build/icon.png` —— 蓝→紫渐变 (#5b8def → #7c5cf0) 圆角方块 + 白放大镜 + 4 个圆角小方块。
它同时出现在窗口左上角、任务栏和 exe 上。

slop 判据原文：「Logo as a gradient tile with a sparkle and a gradient wordmark → product name as text plus a simple flat mark」
「Logo mark as a glossy orb, a gradient ball or a glowing dot → a flat glyph in one solid color」

**这是整个产品唯一一处蓝紫渐变** —— 界面本身已裁决「无彩」，图标却是最典型的 AI 配色。
图形（放大镜 + 网格）本身是对的（它描述的正是产品：在网格里查找），**只有那层渐变是 slop**。

建议：保留图形，去掉渐变 → 单色扁平。深色底用 `--ff-text-1` 的白、浅色底用 `--ff-raw-t1` 的黑；
或统一图标底为 `#049eff`（`--ff-highlight`，唯一高亮）单色纯底 + 白字形。

⚠️ 需确认：现图标可能是主人特意挑的。按「特性默认神圣」，此条**只提交，不动手**。

### 2. 卡片角标「1 个文件」信息量≈0，却每张占一块

`index.vue:268` `<span v-if="item.files && item.files.length" class="badge">{{ item.files.length }} 个文件</span>`

一屏 40 张卡里 39 张显示「1 个文件」。这个角标抄的是 B 站封面下沿（左播放量 / 右时长），
但 B 站左边那个数字每条都不同，这里几乎恒定 1 ⇒ **只学了形式，丢了信息**。
代价是每张封面多压一块半透明 pill，而封面本身是密集的海报拼贴。

可选的小改（任一，都很小）：
- `v-if="item.files && item.files.length > 1"` —— 只有多文件时才出现，单位数不显示
- 或者保留位置、改成纯图标 + 数字（去掉「个文件」三个字），宽度从 ~64px 降到 ~34px

### 3. 数字格式不统一（极小）

同一屏上 `786 GB` / `4.94 GB` / `915.40 MB` —— 0 位小数与 2 位小数混排。
根因是 `getSize()` 按单位分支各写各的小数位。`signs.md`：「Numbers in mixed formats … → one format, tabular figures」。
改法：统一按「≥100 取整、<100 取两位」或一律两位，并给角标加 `font-variant-numeric: tabular-nums`。

## 被排除的怀疑（避免报告只列负面）

| 初始怀疑 | 核实 | 结论 |
|---|---|---|
| 原生标题栏是浅色、应用是深色（低分辨率缩略图上看到） | 高分辨率截图 | **不成立**，标题栏跟随主题是深色 |
| 顶栏地址槽右侧大片空白 = dead band | 读 `index.vue:4-12` 注释 | **刻意**：槽是唯一弹性槽位，右边没东西才能"零位移" |
| 选中卡蓝色边框 + 蓝字 = 高亮泛滥 | 读 tokens 注释 | **刻意**，2026-11-07 裁决「高亮只用在三处」 |
| 红角标 = 语义色当装饰 | 读 tokens 注释 | **已裁决**（主人要求用回红 badge） |

## 补扫（2026-11-09 21:56，为提交前收尾）

第一轮只审了深色 + 网格视图。这轮改用**全局信号扫描**替代逐屏目视（`grep` 全 `src` + 项目自带配色护栏）：

| 信号 | 命中 | 判定 |
|---|---|---|
| 感叹号文案 | `Cache/index.vue:504, 625` | **已改**：`失败！` → `失败：`（第二条原是「获取历史数据列表错误！」，语病，一并改成「失败」） |
| `transition: all` | 0 | ✅ |
| `hover:scale` | 0（`scale(1.03/1.04)` 两处是**图片入场起点**，配 `opacity 0→1` + `blur 8px→0`，不是 hover） | ✅ 保留 |
| 无限循环动画 | `assistant/workspace.css` 三处 | ✅ 保留：`ffw-pulse` 是 dock 上的**活状态灯**（`[data-phase='pause']` 时 `animation:none`、变 warn 色；done 变 ok），`ffw-breathe` 只用在骨架屏 |
| 色值字面量 | 0 | ✅ `node docs/probes/tokens/no-raw-color.mjs` → PASS |

仍未逐屏目视：浅色主题、列表视图、预览层、设置页、各弹层、空状态。
它们共用同一套 token 与同一条护栏，所以「结构性问题」的概率低，但**不构成"已审"**。

## 参考

- 审计对象：`src/views/FileFinder/index.vue`（127 KB）、`src/styles/tokens.css`（554 行）
- 截图取证方式：`desktopCapturer` 抓窗口缩略图（只读，不碰数据），产物已删除
