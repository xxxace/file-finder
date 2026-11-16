# 抽卡页对齐 `holo-reverse` 原码（2026-11-15 · 第二轮）

> 参考站：`D:\code\holo-reverse`（`src/app.js` 673 行 / `src/styles.css` 185 行，逐字一致的原站恢复版）。
> 本轮业主口径：**照抄源项目，只改内容，不改交互 / 视觉 / 动效。**
> 上次复盘的结论（`RETRO-LUCKY-VS-HOLO-2026-11-15.md`）是"驱动范式"；这一轮是**逐机制对账**。

## 一、三个症状 → 根因 → 改法

| 症状 | 根因（实测/静态） | 改法 |
|---|---|---|
| 撕包没有声音；撕多快都一样 | 只用项目配方音效播了两个固定音（`lucky-tear` / `lucky-burst`），而参考站的撕裂声是**常驻噪声源 + 每帧按手的角速度改音量** | 逐行移植 `voices()`：`rip/grab/eep/phew/boing/pop/swirl/land/lift/tick/arrive`，见 `src/views/Lucky/voices.ts` |
| 彩虹在开包时一闪一闪 | `RainbowFlow.glow` 手写成 `c = 0` 的**无阻尼振子**：撕裂期间不透明度在 0↔2 之间来回（数值复算：60 帧内 2 次冲过 1、4 次落回 0）；且 `opacity` 被写过负值（非法值被浏览器丢弃 ⇒ 保持上一帧）。另：包一落下去就 `flow.reset()`，把彩虹**直接掐灭** | `glow = new Spring(0, .5)`（阻尼 = 4π/response）；不透明度夹到 0~1；落地后按参考站的 `anchor` 把倾斜慢慢扶正，不再 reset |
| 卡片和源码差意思；鼠标在卡上会抖 | ① 卡片内部用 `pointermove` + `getBoundingClientRect()` 算倾角 —— **卡片一转，包围盒变，同一鼠标位置算出的角度又变**（正反馈），还叠在外层弹簧倾角上；② 卡面压根没有 `.holo` 箔层；③ 舞台没有 `perspective`，`translateZ` 不产生任何视觉（厚度/抬升/螺旋 z 全是白写） | 卡面反光改由**卡自己的 `ry/rx`** 逐帧反推（`nx = ry/24`）；删掉卡内指针监听；补 `.holo`（闪点 mask）+ `.glare` + `.glaze`；`.scene` 加 `perspective: 1400px / 50% 40%` |

## 二、本轮补齐的机制（对照 `app.js`）

**撕（`clips / steer / finish`）**

- 侧面 18 片 `rim`（左右各 9）终于有了：撕开时被撕到的那一侧连同顶部一起抬走（`top = max(baseTop, yAt(side)+1.4)`）。
- `steer` 的弯曲量改成**逐帧向目标插值**（`k += (目标 − k) * .3`），且先钳 ±.7 再乘 `pw/ph` —— 原来是直接跟手，撕口像被钳子夹着抖。
- 撕条卷曲度 `tear.roll = rand(.65, 1.4)`：原来固定 1.05，每包撕条的卷法一模一样。
- 撕条两端不再加重叠（`d<0 && lo===xt` / `d>0 && hi===xt`），尖端不会多出一小截。
- 顺着 `tear.roll` 与 `finish()` 的随机角：松手/点按时 `th/to` 是 `rand(14,30)` / `-rand(20,44)`，不是定值。
- 拖动选边时把纵向基准挪到当前指针（`drag.y0 = clientY; dy = 0`）。原来改的是 `x0` —— 进度会顿一拍。
- 开包瞬间：**摆平**（`P.rx/ry.set(.3) → 0`）+ 反冲（`y.v += 320`、`rz.v -= dir*40`）+ 20ms 后掉下去。原来 240ms 才掉，且包还在跟鼠标扭头。
- 姿态目标只在 `sealed` 算（参考站 `state === 'enter' | 'idle'` 分支）。

**光流**：`.flow`（与包同框，承接三轴变换）/ `.rays`（撕口上方画布）拆成两层；落地后走 `anchor` 指数衰减，不再整片消失。

**卡包外观**：地面投影位置修正（原 `top:130%` 再叠 JS 的 `translate` ⇒ 影子被推到包下方约 0.8 个包高之外，等于没有）；金属撕边投影挂到容器 `.lips` 上（`clip-path` 在 filter 之后生效，同一元素上写 `drop-shadow` 会被裁掉）；撕条正面补回 "Tear here" 印刷字。

**卡片**：`.holo` 覆盖图窗（`inset: 4.3% 6% 35.7%`，闪点 mask 110px），`.glare` / `.glaze` 用回参考站公式；名称 `9cqw/700`、类型胶囊改中性灰、编号 `3.8cqw` + `tabular-nums`；`.slab` 用卡纸边色；`up` 逻辑（抬起就压在上层，直到沉回邻卡之下）、`rank`（螺旋/竖屏按 z 排序）；静置呼吸 `motion` 受"减少动态效果"控制。

## 三、音效接线（谁在什么时候响）

| 时机 | 调用 | 位置 |
|---|---|---|
| 包飞进来 | `arrive()` | `LuckyPack.onMounted`（`!reduce`） |
| 按下 | `grab()` | `onDown` |
| 开始撕（选边那一刻） | `eep()` | `startTear()` |
| 撕的每一帧 | `rip(dp/dt)` | 主循环（`dp>0` 才有音量，松手归零） |
| 松手没撕完 | `phew()` / `boing()`（撕过 / 只拉过） | `onUp` |
| 撕到底 | `rip(0)` + `pop(!reduce)` | `openPack()` |
| 螺旋开始 | `swirl(1.25)` | `CardShow.onUnwind` |
| 每张落位 | `land(name, slot)` | `CardShow.onLand` |
| 悬停抬起 | `lift(slot)` | 页面 `onPointer` |
| 再来一包 | `tick()` | `redraw()` |

静音/音量跟应用设置 `sfxPrefs`（`ff.sfx`），不另起开关；`AudioContext` 在首次手势里建（浏览器自动播放策略），离开页面 `sleepVoices()` 关掉。

## 三·补、第二轮（同日 22:30）：五条细节 + 一个几何探针

| # | 症状 | 真因 | 改法 |
|---|---|---|---|
| 1 | 彩虹顶端留白 | `RainbowFlow` 的 `vw/vh` 用的是**窗口**。抽卡页的舞台上下有 chrome，包心比窗口中心低，`roof/reach` 全按窗口算 ⇒ 光流提前收尾。mask/滤镜区也按同一套窄盒子算，等于又加了一把剪刀 | `setSize` 改成收「包心到舞台四边」的四个距离；`roof` 再往上让 18 单位；mask/滤镜区给足（上 -120、高 +260） |
| 2 | 卡包偏高 | 舞台居中，而参考站是全窗口居中 | `--pack-drop: clamp(14px, 4.4vh, 56px)`，**卡片层 `.scene` 同步下沉**（否则卡片从包口上方飞出来） |
| 3 | 小窗口卡片装不下 | `fanSpot` 只按宽度算 `s`，且下限 0.6；`vw/vh` 还是窗口 | `s = min(fitW, fitH)`、下限 0.34；`vw/vh` 改用**舞台**尺寸（`CardShow.setBox`），螺旋半径、按 z 排名的 `tall` 一并换 |
| 4 | 没有等级 | 参考站 `tier: common/rare/ultra` + 四个标签（● Common / ◆ Rare / ◆◆ Holo rare / ★ Ultra rare） | `rarityOf(bytes)`：容量档决定等级（<1G / <3G / <8G / ≥8G）。三档改三个变量：`--frame / --ink / --edge`。`rare` = 深蓝 + 图窗彩虹细边；`ultra` = 金 + 卡纸上的放射光芒（用 `--ff-frame-mask` 把图窗挖空，箔仍不碰照片） |
| 5 | 卡片不像、名字偏大 | 名称 9cqw | 7.4cqw；`.no` 补容量、`.rar` 改等级标签；类型胶囊改中性灰（`currentColor` 16%） |

**探针**：`docs/probes/lucky-geometry/`（假数据，验**几何**）。
坑：无头 Chrome/Edge 的 `--virtual-time-budget` 只快进 `setTimeout`，**rAF 仍走真实节拍**
⇒ 截图永远停在动画开头。探针把 rAF 换成可手动泵的队列（16.7ms/帧），弹簧才走在确定的帧数上。

## 三·再补（同日 23:10）：性能 / 概率 / 自适应

业主口径：「照抄就完事了，垃圾代码或者抄错的删除重写即可」。这一轮做的全是**删我自己的发明**。

### 卡（性能）

| 我加的东西 | 为什么删 | 改成 |
|---|---|---|
| `.scene` 永远是 `preserve-3d` | 五张卡每帧参与 3D 排序，卡片层无法整块缓存 | 出包时加 `.is-flat`（= 参考站 `scene.classList.add('flat')`） |
| `if (p > 0) applyClips(p)` | 手停住时仍在每帧重写 ~40 个 `clip-path` | 参考站的守卫：`dp > 0 || |tearP.v| > .001` |
| 每帧 60 次 `querySelector` 找撕条的子元素 | 纯浪费 | 挂载时索引一次（`indexPlies()`） |
| `.win::after` 用 padding+mask 抠彩虹环 | 每帧多合成一层带 mask 的图层 ×5 | 删；稀有档只改既有 `box-shadow` 的亮边 |
| `.glaze::after` 单独一层高光 | 同上 | 并回 `.glaze` 的 background（参考站原写法） |
| 每帧无条件写 `--gx/--gl/--gt/--gm` | 值没变也写 = 整包重绘 | 字符串比对，没变不写 |
| 卡面 `--px/--py/--hyp` 每帧写 | 写一次 = 整张卡（箔+眩光+清漆）重绘 | 值没变不写 + 取整 1% + **静置降到 12fps** |
| 彩带每片纸都读一次包姿态 | 240 次/帧 × 拼对象 | 每帧读一次，传进去 |
| 包掉出屏幕还在算 | `fall.y` 无限增长 | 超过 `innerHeight` 停算（参考站同一句） |
| 辉光滤镜区给到 -120/+260 | `<g filter>` 按滤镜区开离屏位图，区域越大越贵 | 收到实画范围（mask 仍给足） |

### 等级概率（抄错的）

上一版拿"容量档"当等级 ⇒ 真实收藏 1~3G 占多数 ⇒ 一包五张里四张 Rare。
参考站是**固定构成**：`● Common ×2 + ◆ Rare ×1 + ◆◆ Holo rare ×1 + ★ Ultra rare ×1`，
每包只重洗**顺序**（它包装背面就印着 "One holo in every pack"）。
现在 `rollRarities(5)` 就按这套来，探针连测 50 包构成恒定。

### 自适应（漏抄的）

参考站 `resize` 里有一句 `for (const c of cards) if (c.f) c.f = fan(c)` —— 我漏了，
所以缩小/放大窗口之后卡片还停在旧落点。现在 `CardShow.refan()` 在 resize 时重算；
配合上一轮把扇形/螺旋/命中测试全部改成按**舞台**尺寸（`setBox`），才是真的"跟着容器变"。

## 三·三补（同日 23:55）：光流改 canvas（唯一真瓶颈）+ 点包即撕

### 1. 这次终于**量到**了瓶颈（不再是"去掉已知重绘源"）

上一轮的性能改动全靠推理，业主回「还是有点卡顿，光效还有卡片的动画会卡」。于是搭了一次
**含绘制的真实帧时间**测量：

- 探针页面自己用 rAF 采样（记 `performance.now()` 的帧间隔），把一个固定剧本跑完：
  sealed → tear → cards → land → idle；
- 结果 POST 给 `docs/probes/lucky-geometry/collect.cjs`（127.0.0.1:5189 收一条就退），写 `bench.json`；
- **不能用 `--virtual-time-budget`**：它只快进 `setTimeout`，rAF 仍走真实节拍，量不到。

**基线（1440×900，dpr 1，改之前）**

| 阶段 | avg | p50 | max |
|---|---|---|---|
| sealed | 12.0 | 6.1 | 194.1 |
| **tear** | **72.3** | 36.5 | **491.0** |
| cards | 8.1 | 6.1 | 36.4 |
| land | 6.1 | 6.1 | 18.1 |
| idle | 6.6 | 6.1 | 91.0 |

**逐层关掉（kill 开关）归因 tear 阶段**

| 关掉什么 | avg ms/帧 | 帧数 |
|---|---|---|
| 什么都不关 | 38.2 | 47 |
| **光流（71 条 SVG path + 高斯滤镜 + 蒙版）** | **8.9** | **202** |
| 蒙版 | 27.9 | — |
| 边缘亮线 | 11.8~33.2 | — |
| 模糊滤镜 | 55 | — |

JS 侧只有 0.08ms/帧 ⇒ **瓶颈 100% 在绘制/光栅化，跟 JS 一行关系都没有**。

**改法**：`src/views/Lucky/flow.ts` 整文件从 SVG 重写成 **一张 canvas**。几何逐行照抄
（仍是"包宽的 1% "为单位、35 条带、行波公式一字未改），换的是绘制方式：

| 参考站的 SVG 做法 | canvas 里等价的一步 |
|---|---|
| 71 条 `<path>` 每帧重算 `d` + 浏览器重新解析上万个坐标 | 35 条带子一次 `beginPath` + 一次 `fill` |
| 外层 `<g filter="feGaussianBlur">` | 离屏 `scratch` 画一遍 → `ctx.filter='blur(2.5px)'` 贴一次（α .55）+ 清晰贴一次 |
| radial `mask` 收尾 | 主画布上 `destination-in` + 一个径向渐变，合成一次 |
| 10 个 mote 各一条 `<circle>` + 渐变 | 一张预渲染的径向渐变贴图 `drawImage` |
| 亮边 36 条 `stroke` | 隔帧画（`frames % 2`），肉眼无差 |
| 分辨率跟着 DOM 走 | `BACKING` 上限 1.5（光带本来就糊，放大看不出，少烧 4 倍像素） |

**改后（含 bloom）**：tear **avg 9.7 / p50 6.1 / p95 12.3**，与"完全关掉光流"的 8.0ms 持平；
cards/land/idle 全部 6.1（vsync 地板）。视觉复核 `02-rainbow-top.png`：颜色、贴顶、条带无缝都保持。

⚠️ 单位仍然是**包宽的 1%**，别顺手改成像素 —— 一改，包一大一小彩虹就比例失真。

### 2. 拆包不再有按钮

业主：「不需要专门搞个按钮拆开，源项目点击卡包就能触发（最多鼠标悬浮给 tooltip）」。
参考站确实只有 `cursor: grab` + 包装正面印着 "Tear here ⟶"，没有任何按钮。

- 删掉底栏那颗「拆开这一包」；封着时底栏**故意留空**（高度恒定 56px，等"再来一包"出现时不跳）；
- 点击撕开本来就通：`onUp` 里 `moved === false` → `finishTear(0.55)`，与参考站的 click 分支同一条；
- hover 提示用 `v-tip`（键帽 `Space` 是**真绑定**的：页面 keydown 里空格确实撕包）。
  ⚠️ `<button>` 在 pointerdown 后会拿到焦点，而 `v-tip` 的 focus 也会 `showTip` ⇒
  只调一次 `hideTip()` 挡不住（150ms 后又冒出来）。正确做法是让**绑定值本身变空**
  （`used` 标记一旦动手就永久收起），不是跟延迟赛跑。

### 3. 自适应还有一处漏：`cw/ch` 只在 `reset()` 里给过

上一轮补了 `refan()`，但 `refan()` 用的是 `this.cw`，而 `cw/ch` 只在重抽一包时写一次。
CSS 的 `--cw` 是 `min(400px,52vh)*.69*.84`，缩窗口它就变了 ⇒ **几何里还是旧尺寸**，
五张卡要么叠一起要么散太开。现在 `setBox()` 一并接管 `cw/ch`（挂载与 resize 都走它），
`reset(count)` 只重置运行时状态 —— 一个几何入口，不再有两份尺寸。

## 四、证据等级

- **实测（数值复算）**：彩虹 `glow` 的两种阻尼下不透明度序列（c=0 → 0↔2 振荡；c=8π → 单调收敛到 1）。
- **静态（可复算）**：`app.js` 与本仓逐行对照（`clips`/`steer`/`finish`/`open`/`aimed`/帧内卡片段/`voices`）；`typecheck` 0 error；三个 SFC 的 `less` 编译通过。
- **推理（未真机）**：卡片抖动来自 `getBoundingClientRect()` 正反馈 —— 依据是"被 2° 倾斜的卡片包围盒会变"，这是几何必然；没有真机帧级抓取。
- **实测（无头截图）**：`docs/probes/lucky-geometry/` 四张 —— 彩虹贴顶、卡包下沉、1440/1000 两种宽度下五张卡都完整。
- **实测（数据层探针）**：`node docs/probes/lucky-draw/probe.cjs` → 33 PASS / 0 FAIL（含"50 包构成恒定 2C/1R/1H/1U"）。
- **实测（含绘制的帧时间，2026-11-15 第四轮）**：改用 rAF 采样 + 本地收集器后量到了真数 ——
  光流 SVG 版 tear 72.3ms/帧 → canvas 版 **6.2~9.7ms/帧**（多次跑，p50 恒 6.1 = 地板）。
- **实测（同一套剧本补上彩带 `?fx=1`）**：cards / land / idle 仍是 6.1ms 地板 ⇒
  240 片彩带 + 五张卡同时动，在这台机器上**不是**瓶颈（此前量分漏了彩带，这次补上）。
- **实测（倍率）**：dpr 2 / 1920×1080@1.25 下 tear avg 13.2~13.6、p95 24~42，
  但**关掉光流也还是 12.8** ⇒ 高倍率下换成了卡包自身的 CSS 重绘（14 处 `clip-path`/帧），
  不再是光流。同时每次跑都有 5~8 帧 190~290ms 的尖峰，形态像"光栅倍率切换"的一次性代价。
- **未实测**：真机 GPU 手感。无头只有 SwiftShader，**尖峰到底是渲染还是环境，这里判不了**；
  要在业主机器上验（问一句窗口分辨率 + 显示缩放就能定位）。
- **未实测**：卡片动画在探针里已到 6.1ms 地板，但探针不带真实封面图（解码/显存），
  真机 5 张真图仍有未知量。
- **未做**：角色表情（眨眼/痛苦/汗）——我们没有角色；页面 chrome（顶栏/底栏）保持本仓风格。
- **等级不是编的**：判据是容量（本来就印在卡上），同一部作品每次抽到的等级恒定。

## 五、一个坑：`127.0.0.1:5173` 不是这个源

`5173` 上跑的是 `D:\code\x-site`（"Card Pack Holographic Showcase"，另一份复刻，`src/styles/stage.css` + `holo-shader.css`）；
`holo-reverse` 自己的 `npm start` 是 **4173**。对账以 `D:\code\holo-reverse` 的 `app.js`/`styles.css` 为准。
