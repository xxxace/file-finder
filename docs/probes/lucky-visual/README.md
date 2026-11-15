# 抽卡页 · 真实截图 + 布局诊断

> **只读**：不写数据库、不改任何业务数据。
> 产物：`01-sealed.png`（未拆封）/ `02-opening.png`（拆到一半）/ `03-open.png`（五张落定）/ `04-open-dark.png` / `run.log`。

## 为什么要有它

这一页连着两轮「我自己 typecheck 全绿、业主打开却看不到开包」。两次都不是类型问题：

| 现象 | 真因 | 类型能抓到吗 |
|---|---|---|
| 一进来就是五张卡、没有盒子 | `.stage` 是 `display:grid`，盒子与扇形是**两个网格项**，被排成两行（盒子被挤出容器） | ❌ |
| 整页灰暗、没色彩 | `/getDisks` 响应是**平铺**的 `{disks}`，代码按 `res.data.disks` 读 ⇒ 恒假 ⇒ 全部判离线 ⇒ 叠了 `grayscale(.6)` | ❌ |
| 深色下盒子看不见 | 纸 #242424 套画布 #0e0e0e，再压一层暗雾膜 | ❌ |

纯 CSS 组合问题**只能靠看**。所以这里用项目真实主进程截图，而不是继续读代码。

## 跑法（两步，缺一不可）

```bash
# ① 只起 dev server。VSCODE_DEBUG 会让 vite-plugin-electron 不自动拉 Electron
VSCODE_DEBUG=1 npx vite

# ② 另开一个终端：用项目自己的 Electron 跑本脚本
env -u ELECTRON_RUN_AS_NODE \
  VITE_DEV_SERVER_URL=http://127.0.0.1:3344 \
  ./node_modules/electron/dist/electron.exe docs/probes/lucky-visual/shot.cjs
```

## 三条硬前提（踩过）

1. **`ELECTRON_RUN_AS_NODE` 必须去掉**：这个环境默认带它，Electron 会退化成纯 Node，
   `app` 是 `undefined`，报「Cannot read properties of undefined」。
2. **端口 3060 必须空着**：脚本 require 的是项目真实主进程，它会 `listen(3060)`。
   有残留实例时表现极具误导性 —— 服务起不来，请求打到**别人的**服务上、口令不匹配，
   于是两个接口都 403，界面上显示「还没有可以抽的封面」（把人引去扫描）。
   先 `netstat -ano | grep ":3060.*LISTENING"`，有就 `taskkill //PID <pid> //T //F`。
3. **必须用 `dist/electron/main/index.js`**：真服务 + 真 token 才能拿到真封面池（1203 部）。
   自己摆假数据截图，等于验证了一个不存在的页面。

## 脚本还查了两件事

- **接口直查**：打印 `tokenLen` 与 `/getDisks`、`/getAllCovers` 的状态码和前 240 字符。
  没有这一段，"池子为空"的三种病（服务没起 / 口令错 / 库没就绪）在界面上长得一模一样。
- **布局读数**：`caseStage`、`fan`、`stage` 的 `[宽, 高, top, left]` 与 `data-phase`、`.slot` 数量。
  两个元素是不是叠在同一个中心，看 `top/left` 就能判，不用猜。

## 已知边界

- 只证明「渲染出来了、位置对、动画跑过一帧」，**审美对不对**只能人眼看。
- 截图窗口受沙箱虚拟屏限制（实测内容区只有 ~725×800），所以卡片比真机小；
  这是环境，不是样式 bug。
