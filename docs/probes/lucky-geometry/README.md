# 抽卡几何探针（假数据）

> **只读**：不碰本地服务、不读数据库、不发请求。
> 与隔壁 `../lucky-visual/`（真数据 + 真主进程截图）的分工：那一份验**行为**，这一份验**几何**。

## 为什么还要一份

彩虹"到不到顶"、卡片"装不装得下"、卡包"沉得够不够低"都是**几何**：
它们同时取决于窗口尺寸 / 舞台尺寸 / 上下 chrome 三者，读代码要推三遍，而且推不准 ——
这一轮的三个问题（彩虹顶部留白、小窗口卡片溢出、卡包偏上）全是这么来的。

数据是假的（真数据要占 3060 端口，会和业主运行中的实例打架），但**组件、CSS、
`fanSpot/orbitAt/RainbowFlow` 全是产品代码本体**，量的就是产品几何。

## 跑法

```bash
# ① 起探针服务器（普通 vite，不带 electron 插件）
npx vite --config docs/probes/lucky-geometry/vite.config.ts

# ② 无头 Edge 截图（端口 5188；localhost 走 IPv6，用 127.0.0.1 会连不上）
"/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" \
  --headless=new --disable-gpu --no-proxy-server --hide-scrollbars \
  --force-device-scale-factor=1 --window-size=1440,900 --virtual-time-budget=3000 \
  --screenshot=out.png "http://localhost:5188/docs/probes/lucky-geometry/lucky.html?state=fan"
```

参数：`state=sealed|tear|fan`、`frames=N`（手动泵的帧数，仅 `tear` 用）。

## 量帧时间（`?measure=1`）

截图只能证明"长什么样"，证明不了"多贵"。`?measure=1` 是另一条路：

1. 同一个 rAF 把整段剧本（sealed → tear → cards → land → idle）跑完，
   每帧记 `performance.now()` 之差，按阶段出 `n/avg/p50/p95/max/over20/over33`；
2. 跑完 `POST` 给 `collect.cjs`（127.0.0.1:5189，收一条写 `bench.json` 就退出）；
3. **必须真跑**，不能加 `--virtual-time-budget`（它会把时间轴快进，帧时间全废）。

```bash
node docs/probes/lucky-geometry/collect.cjs &          # 先起收集器
"/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" \
  --headless=new --no-proxy-server --hide-scrollbars \
  --force-device-scale-factor=1 --window-size=1440,900 \
  "http://localhost:5188/docs/probes/lucky-geometry/lucky.html?measure=1"
```

`&kill=flow,blur,flap,lips,edges,motes` 可以逐层关掉再量 —— 靠这张对照表才定位到
"彩虹光流一个人吃掉 30ms/帧"（详见 `docs/DESIGN-LUCKY-PARITY-2026-11-15.md` §三·三补）。

⚠️ 无头走 SwiftShader，**量到的是 CPU 光栅化成本**。它适合做 A/B 对比（同一环境、同一剧本），
不适合当"真机多少 fps"的结论。

## 一个必须知道的坑：无头模式下 rAF 几乎不跑

`--virtual-time-budget` 会把 `setTimeout` 快进到底，但 **rAF 仍受真实渲染节拍约束**
⇒ 直接截图永远拍到动画开头那几帧（表现是"包还在飞进来、彩虹刚冒头"）。
所以探针把 `requestAnimationFrame` 换成了**可手动泵的队列**：按 16.7ms/帧推 N 帧，
弹簧就走在确定的帧数上（可复现）。`state=fan` 干脆跳过整段编排，直接落到扇形。

## 产物

| 图 | 看什么 |
|---|---|
| `01-sealed.png` | 卡包落定后的位置（应明显低于舞台正中） |
| `02-rainbow-top.png` | 彩虹顶端**贴到画面最上沿**、上方没有留下浅色横条 |
| `03-fan-wide.png` | 1440 宽：五张卡整排、四档等级（暖白/深蓝/金） |
| `04-fan-narrow.png` | 1000 宽：卡片按容器缩到 ~0.7、仍全部可见 |

## 边界

- 只证明**几何**对不对，不证明审美；封面是空的（`无封面` 占位）。
- 卡片间距/缩放走的是"减少动态效果"那条分支（直接落位），与真实编排的终点一致。
