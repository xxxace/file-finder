# 启动加载层（preload spinner）分析与去留建议（2026-11-10）

> 只读分析，代码一行未动。证据等级标注：【静态】= 读码确认；【实测】= 2026-11-07 dev 稳态埋点（PERF-ANALYSIS §十一）。

## 一、这个"preload 页面"到底是什么（机制）

**它不是独立 HTML 页面，是 preload 脚本注入主窗口 DOM 的一个全屏覆盖层。**

- `electron/preload/index.ts:34-81`：`useLoading()` 生成 `<style>` + `<div class="app-loading-wrap">`，`domReady()` 后插入 —— 深灰 `#282c34` 背景 + 白色方块 3D 旋转（loaders-css `square-spin`，electron-vite 模板默认样式）。
- 关闭链路：`src/main.ts:20` Vue mount 后 `$nextTick` 里 `postMessage({payload:'removeLoading'})` → `preload/index.ts:88-90` `window.onmessage` 收到后移除；兜底 `setTimeout(removeLoading, 4999)`。
- ARCH-PLAN.md 已有裁决级警告：preload 的 `window.onmessage` / `removeLoading` **必须原地保留**，`src/main.ts:11` 靠它关 spinner，删了就是白屏。

## 二、启动各阶段的真实画面（对应白屏在哪）

| 阶段 | 画面 | 说明 |
|---|---|---|
| T0 窗口创建 → 页面开始加载 | **白屏** | `main/index.ts:57` 未设 `show:false` 也未设 `backgroundColor`，窗口立即显示，页面未加载前是 OS 默认白底【静态】 |
| 页面加载完成 → Vue mount | 深灰底 + 白方块旋转 | preload 覆盖层顶上来的时段【静态】 |
| Vue mount → 覆盖层移除 | 主界面出现 | `removeLoading` 是同步移除，无过渡，背景色 `#282c34` 与主题 `--ff-canvas` 不一致 ⇒ 移除瞬间有一次**颜色跳变**【静态】 |
| 界面出现 → 首屏数据落地 | 界面空壳等数据 | dev 实测窗口出现 ≈1277ms、首屏数据 4056ms（含 Vite 按需编译 ~2.7s，打包版不重复付）【实测】 |

打包版模块求值比 dev 小一个量级（PERF-ANALYSIS §十一），但「窗口出现 → Vue 挂载」的白屏/覆盖层段在打包版依然存在，只是更短（未实测，量法见 §六）。

## 三、问题一：要不要去掉？

**不能裸删。** 删掉 `appendLoading` 后：

1. T0 的白屏段不变（窗口本来就立即显示）；
2. 原本被覆盖层盖住的「页面加载 → Vue mount」段变成**纯白屏**；
3. `src/main.ts` 的 `postMessage` 变成死消息，按"零引用"纪律要一起清。

结论：去掉覆盖层 = 把"不好看的加载动画"换成"更原始的白屏"，等待不会消失，只会更难看。

## 四、问题二：去掉后还会不会等待/白屏？

**会。** 白屏段的根源与覆盖层无关：

- 窗口创建后立即显示（无 `show:false` + `ready-to-show` 控制）；
- 渲染层要经历：HTML/CSS/JS 加载 → Vue 编译挂载 → 首帧。这段在打包版约几百 ms（未实测）；
- 首屏数据另有等待（读盘 + 启动缓存），任何加载视觉手段都不消除它，只能包装它。

## 五、问题三：优化方案对比

| 方案 | 做法 | 收益 | 成本/风险 | 判断 |
|---|---|---|---|---|
| A. 裸删覆盖层 | 删 `useLoading()` 全套 | 无 | 白屏段变长变显眼；死代码清理 | ❌ 否决 |
| B. 延迟显示窗口（`show:false` + `ready-to-show`） | 窗口就绪才 `show()`，全程无加载画面 | 视觉上"无白屏" | 窗口出现延后 ⇒ 双击 exe 后几百 ms~1s 桌面无窗口，体感"点了没反应"；要同步删 main.ts/postMessage 整条链 | ⚠️ 不推荐：本应用启动段本就不短，需要"有东西在动" |
| C. 保留机制，重做视觉（推荐） | 只改 `useLoading()`：背景取主题 `--ff-canvas`、换 logo/细进度条动画、移除时加 ~200ms 淡出 | 覆盖层与主界面同色 ⇒ 移除瞬间无跳变，观感一体 | 极低：只动一个函数，关闭链路一字不动 | ✅ 推荐 |
| D. C 的补充：`BrowserWindow` 加 `backgroundColor` | 主进程窗口选项设为主题背景色 | 把 **T0 白屏段**也染成主题色 ⇒ 全程"无白屏"，覆盖层出场时零跳变 | 一行，零风险 | ✅ 与 C 搭配套用 |

**对比结论**：重做美观 preload（C+D）优于"去掉"。商业 Electron 应用（VS Code / Discord / Slack）全部保留启动画面，就是因为白屏无法归零、必须包装。本项目的现成资产可复用：galaxy 进度条的 `--ff-bar-*` 色板与 `drawPixels` 风格（`components/GalaxyLoadingBar/`）。

## 六、可自跑实验（不改代码即可复现）

1. 打包版白屏时长目测：`npm run build` 后双击 exe 手机秒表/录屏，观察「窗口出现 → 内容出现」段；
2. 主题一致性验证：亮/暗主题下各启动一次，看覆盖层移除瞬间的颜色跳变（当前必跳，因为 `#282c34` 与两套主题都对不上）;
3. 若要精确毫秒：临时在 `useLoading` 的 `appendLoading`/`removeLoading` 各打一行 `console.log(performance.now())`，量完删。

## 七、给结论一句话

**机制保留，视觉重做**：`useLoading()` 换项目风格 + `BrowserWindow.backgroundColor` 同色打底 + 移除加淡出；删除方案（A/B）都解决不了"白屏必须被包装"这个本质。

## 八、实施记录（2026-11-10 23:20，方案 C+D 已落地）

| 改动 | 文件 | 内容 |
|---|---|---|
| 覆盖层换皮 | `electron/preload/index.ts` | 深灰+白方块 → 主题画布底色（dark `#0e0e0e` / light `#f1f2f3`，读 localStorage `ff-theme`，默认 dark）+ 呼吸的放大镜 SVG（galaxy 紫 `#c7a1fa`）+ "File Finder" 字标 + 140px 细进度条往返扫动；`removeLoading` 改为加 `.is-out` 淡出（200ms，项目标准缓动），220ms 后才摘节点；`leaving` 标志挡 postMessage 与 4999ms 兜底的双重触发；`prefers-reduced-motion` 下关动画 |
| 原生底色 | `electron/main/index.ts` | `BrowserWindow` 加 `backgroundColor: '#0e0e0e'`（默认主题画布）——窗口出现 → 页面首个 paint 的 T0 段不再是 OS 白色。⚠️ 亮色用户 T0 会先暗一拍，首个 paint 后由 index.html 内联脚本纠正 |
| 首帧兜底 | `index.html` | head 加内联脚本：提前把 `ff-theme` 写进 `data-theme`（默认 dark）；内联 `<style>` 给 html 按主题染 `#0e0e0e` / `#f1f2f3` —— tokens.css 是打进 bundle 的 CSS，到位前 html 没有底色。html 层该样式常驻，body 的 `--ff-canvas` 盖在上面，切主题时经 `data-theme` 联动，不残留 |

**三处共用值（改要一起改）**：主题键 `ff-theme`（useTheme.ts）· 画布色 dark `#0e0e0e` / light `#f1f2f3`（tokens.css `--ff-canvas`）· preload 覆盖层与 index.html 内联样式都自带这两值（CSS 变量读不到）。

**契约不变**：`window.onmessage` / `removeLoading` / 4999ms 兜底 / `src/main.ts` 的 postMessage 一字未动。

**验证**：`npm run typecheck` 0 error（vue-tsc + tsc -p tsconfig.electron.json）。改了主进程与 preload ⇒ **必须重启 dev**。真机目视清单：
1. 暗色主题启动：全程无白闪，覆盖层 → 主界面淡出衔接，无颜色跳变；
2. 切亮色主题后重启：覆盖层应为亮色画布；
3. 覆盖层动画：放大镜呼吸 + 紫色细条扫动，`4999ms` 兜底仍生效（可临时注释 postMessage 验证）。

## 九、第二版：像素云动效 + 主界面交叉入场（2026-11-10 23:40）

业主反馈"不高级、没动效感觉"，参考 reactbits Pixel Blast（抖动像素云：漂移、闪烁、光标点亮）。

| 改动 | 文件 | 内容 |
|---|---|---|
| 像素云背景 | `electron/preload/pixelBg.ts`（新增） | 值噪声云漂移 + 逐格闪烁 + 光标点亮（energy 注入、每帧 ×0.9 衰减）；色板取 `--ff-bar-px-*`（紫主、青/粉点缀、白星），亮色主题用深调子。**性能判据**：画布内部分辨率 = 格子数（~320×180），CSS `image-rendering: pixelated` 拉伸，每帧一次 putImageData；destroy() 必须 cancel rAF + 摘 resize/mousemove 监听 |
| 覆盖层改版 | `electron/preload/index.ts` | wrap 里挂像素云 canvas（绝对定位在内容层之下）；退场从"淡出"升级为「整层 320ms 淡出 + 内容 scale(1.06) 穿过」；340ms 后摘节点 + `pixels.destroy()`；字标加字距 + 大写 |
| 主界面入场 | `src/views/Shell/index.vue` | `.shell` 加一次性 `shell-enter` 420ms（opacity 0→1 + translateY(8px) scale(.985)→none，项目标准缓动）。与覆盖层 320ms 淡出**交叉成一次溶解**。`.shell` 是 App 根只挂载一次 ⇒ 天然不因 KeepAlive 切页重跑。⚠️ transform 只在动画期间存在、结束帧 `none`，不留 fixed containing block（浮层已 teleport 到 body，双保险）；`prefers-reduced-motion` 关闭 |

**启动全程时间线**：原生底色（T0，backgroundColor）→ 像素云覆盖层（光标可点亮）→ Vue 挂载：postMessage ⇒ 覆盖层淡出+内容穿过（320ms）∥ `.shell` 入场（420ms）→ 主界面。无任何一段纯白/跳变。

契约与三处共用值（§八）不变。typecheck 0 error。

## 十、第三版：「镜片声呐」（2026-11-10 23:55，业主截图否掉第二版）

第二版实测（业主截图）：噪声云覆盖率过高 ⇒ **整屏雪花**，光标能量糊成一团。
教训：**抖动云这类效果的 coverage 必须压到个位数百分比**，满屏动 = 廉价感。

业主澄清：reactbits Background Studio 只是启发源，不要求做成 pixel-blast；另给了 liquid-ether / magic-rings 作参考。设计改走**品牌自洽**路线：File Finder 的 mark 就是放大镜 ⇒ 中央一圈圈荡开的**扫描涟漪**（magic-rings 的节奏）+ 极稀疏星点。

| 改动 | 文件 | 内容 |
|---|---|---|
| 背景重写 | `electron/preload/splashBg.ts`（替代 pixelBg.ts，已删） | 暗场 + 星点密度 1.2%（第二版 ~40%）+ 中央每 1.5s ping 一圈涟漪（半径 0.8 次缓出、透明度平方衰减）+ 鼠标划过 140ms 限频起小涟漪 |
| 旋钮集中 | 同上文件头 | CELL 星点颗粒 · STAR_DENSITY · RING_INTERVAL / RING_LIFE / PING_MAX_R · CURSOR_MAX_R / CURSOR_GAP / CURSOR_DIST —— 调整只动常量 |

实现仍是低分辨率画布（格子数）+ CSS pixelated；每帧几十个 fillRect + 几条 arc，成本比第二版（逐格噪声）低一个量级。typecheck 0 error。

## 十一、第四版：「画入的放大镜」（2026-11-10 23:58，业主否掉第三版后调研定案）

业主对像素云 / 涟漪两版都否（"密密麻麻""好丑"）⇒ 调研一线产品的启动画面，结论高度一致：

- **Spotify / Netflix / Airbnb / ChatGPT**：纯色底 + 居中 logo，**其余什么都不放**（ramotion.com："Avoid busy, complicated, and vibrant backgrounds"——星空/像素/涟漪全在被否之列）
- 动效 = **一个概念、作用在 logo 本身**（logo 组装 / 呼吸），不用背景装饰撑场面
- 文字 1~2 秒内读不完 ⇒ 不放字标
- 底色与第一屏押韵 + 交叉过渡 = "界面到达"而非"换页"（mobileappdesign.io §4，我们的交叉溶解方向正确，保留）
- 假等待、装饰性满屏动画 = 大忌

**落地（纯 CSS/SVG，零 canvas 零 rAF 零监听）**：
- 画面：主题画布底色 + 中央放大镜 mark + 三点呼吸。删掉字标、星点、涟漪、鼠标交互。
- 动效编排：mark 淡入微缩放（0.5s）→ 镜圈 stroke 描边画入（`pathLength=100` + dashoffset，0.9s）→ 手柄补画（0.35s）→ 整体轻呼吸（2.6s 循环）；三点 1.2s 错相呼吸（0.9s 后淡入）。
- 退场不变：整层 320ms 淡出 + 内容上浮 -8px，与 `.shell` 入场交叉溶解。
- `prefers-reduced-motion`：全部动画关闭、mark 静态完整显示、三点常亮。
- 文件收敛：`electron/preload/index.ts` 单文件（splashBg.ts 已删），契约（onmessage / removeLoading / 4999 兜底 / main.ts postMessage）未动。typecheck 0 error。

## 十二、第五版：桌面 logo 组装（2026-11-11 00:05，业主两条纠正）

1. **紫色不挪用**：那套紫（`--ff-bar-*`）是 galaxy 进度条的专属色板 ⇒ 启动画面的点缀色改成 **logo 手柄蓝 `#049EFF`**（build/icon.svg 唯一的品牌点缀色）。
2. **mark 换成桌面图标本体**：`build/icon.svg` 内联进 preload（同源同结构，gradient id 改 `ff-tile` 防撞）——ico/png 本就由它生成。图标是**桌面 logo**，比手画的通用放大镜更"是"这个应用。

**编排**（logo assembly，单一动效概念）：圆板浮现 → 2×2 白格逐个落格（.5s 起、每 120ms 一格，"文件网格"隐喻）→ 白环描边画出（.35s 起，0.8s）→ 蓝手柄补画（1s 起，0.3s）→ 整体轻呼吸；三点 1.2s 错相呼吸。
⚠️ 结构保留 icon.svg 内裁决：手柄画在环下层（否则蓝手柄骑在白环上）。方格 scale 动画必须 `transform-box: fill-box; transform-origin: 50% 50%`（SVG 内缩放原点默认在画布左上）。
⚠️ icon.svg 改动时 preload 内联那份要同步。typecheck 0 error。
