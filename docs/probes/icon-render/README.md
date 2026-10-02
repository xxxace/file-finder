# icon-render —— 应用图标从 SVG 到 ICO

给 **一个** 问题提供硬证据：`build/icon.svg` 到底有没有变成一张「四角透明、各档尺寸精确、16px 还认得出」的 Windows 图标。

```
bash docs/probes/icon-render/run.sh          # 生成图标（证据写 out.txt）
node docs/probes/icon-render/ico-read-check.cjs   # 反向验证：读回来的 ICO 还能不能解码
```

## 为什么要跑真 Chromium

这台机器上**没有任何 SVG 光栅化器**（实测：`sharp` / `@resvg/resvg-js` / `canvas` / `jimp` / `cairosvg` / `Pillow` / ImageMagick 全无）。
为一次性图标引一个原生依赖不划算，而仓库里已经有同一条先例 —— `docs/probes/header-width/run.cjs` 用无头 Electron 截图。
用 Electron 还有个附带好处：**渲染它的就是我给主人看的那套 AA**，所见即所得。

## 产出

| 文件 | 用途 |
|---|---|
| `build/icon.svg` | 矢量源，唯一的真相源，手写 |
| `build/icon.ico` | `16/24/32/48/64/128/256` 七档内嵌 PNG —— exe / 桌面快捷方式 / 开始菜单 |
| `build/icon.png` | 1024×1024 —— mac / Linux 兜底，也是 electron-builder 的转换源 |
| `public/favicon.ico` | 与 `icon.ico` 同一份 —— **窗口左上角**那个小图标（`electron/main/index.ts:57`、`index.html:5` 都指向它） |
| `png/icon-<size>.png` | 每档单存一份，便于复算与目视 |
| `preview.png` | 深浅两种底下的真实尺寸对照（视觉证据） |

`build/icon.ico` 与 `public/favicon.ico` 由脚本同时写入 —— **改图标只改 SVG，然后重跑脚本**，不要手改这两个二进制。

## 四个坑（照抄 header-width，另加两条图标特有的）

1. 本机 shell 注入了 `ELECTRON_RUN_AS_NODE=1` ⇒ 必须 `env -u` 真删掉，设空串没用。
2. 换独立 userData + 禁 GPU —— dev 实例占着默认 userData 的 GPUPersistentCache。
3. `show:false` 的窗口在 Windows 上不参与合成 ⇒ `offscreen: true` + 关后台节流。
4. **`force-device-scale-factor=1`** —— 本机主屏 1.25 缩放（见 `probes/win-size/`）。
   不锁 1 的话 `capturePage` 收回来的是 1.25 倍，「32px 图标」会变成 40px。
   实测锁 1 后七档全部命中目标边长（见 `out.txt` 的「尺寸精确」）。
5. **4 倍超采样再缩回来** —— 放大镜环在 16px 上描边只有 1.2px，Chromium 小尺寸 AA 偏糊；
   在 64px 上渲染再 Lanczos 缩到 16px 明显更干净。
6. ⚠️ **`win.destroy()` 不能提前调**：脚本没注册 `window-all-closed`，关掉唯一的窗口会让 Electron
   直接开始退出流程，后面 `loadFile` 预览页就报 `ERR_FAILED (-2)`。第一版就是这么挂的。
   所以全程**只开一个窗口**，改内容尺寸复用（`__setSize`），最后才 destroy。

## 判据

| # | 判据 | 结果 |
|---|---|---|
| ① | 七档产出的边长 = 目标边长 | ✅ 16/24/32/48/64/128/256 全中 |
| ② | 四角 `alpha=0`、中心 `alpha=255`（**真透明**，不是被拍成黑/白底） | ✅ 七档全过 |
| ③ | ICO 容器结构合法（reserved=0 / type=1 / count=7，每条内嵌 PNG 签名 `89504e47`） | ✅ |
| ④ | 写出来的 ICO 还能被读回来 | ✅ `nativeImage` → 256×256，非空 |
| ⑤ | electron-builder 那一关吃不吃得下 | ✅ app-builder 原样透传、无 `InvalidConfigurationError`（`out-build.txt`） |
| ⑥ | **exe 里的图标长什么样** | ⚠️ **未实测** —— 完整打包被环境挡住（见下），请先 `npm install` 再 `npm run build` |

① ② 是**从 `toBitmap()` 直接读 BGRA 的 alpha 字节**判的，不靠"看起来像透明"。
④ 是反向验证：光看 ICO 字节合法没有意义，得有人能解码它。
⑤ 是**定向**打最关键那一环 —— electron-builder 会调 `app-builder icon` 做转换 + 尺寸校验，
   过不了这一关就抛 `InvalidConfigurationError`。顺带对照出：让它从 `icon.png` 自己生成，
   只会得到 **256 一档** ⇒ 手写七档 ICO 是更好的选择。

### ⚠️ 为什么⑥没测成（跟图标无关）

1. 环境 safe-delete 拦了 electron-builder 清输出目录（81 文件 > 阈值 50）；
2. 沙箱拦了解压 Electron 之后的目录改名（`EPERM`）；
3. **真根因**：`require.resolve('app-builder-bin')` → `MODULE_NOT_FOUND`，
   `node_modules` 里只剩 npm 的暂存目录 `.app-builder-bin-YaNL61c1`
   ⇒ 图标转换那一步必然调不到工具。**先 `npm install`。**


## 已知观感（未做优化）

16 / 24 两档里，放大镜内部的 2×2 网格已经糊成一团，靠外形轮廓辨认。
通行做法是给 ≤24px 单独出一版**简化标记**（去掉网格、加粗环），
成本约十几行 —— 但这是**观感取舍，等主人点头再动**。
