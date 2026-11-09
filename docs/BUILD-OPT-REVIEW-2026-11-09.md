# 打包/构建优化评审（2026-11-09）

> 触发：主人问「能不能优化打包速度 / 移除产物注释 / 压缩提高性能 / 还有什么点」。
> 本文是**评审结论**，未动手改任何配置。证据等级标注：【静态】=读配置可得；【推理】=未实测。

## 一、现状（【静态】）

- `npm run build` = `typecheck`（vue-tsc 全量 + tsc）→ `vite build`（renderer + main + preload 三次构建）→ `electron-builder`（asar + NSIS）。
- vite build 默认 `minify: 'esbuild'` → **产物已不含任何普通注释**，只保留版权类 legal comments（`/*! ... */`、license 横幅）。这是 esbuild/Rollup 默认行为，未配置也会生效。
- ⚠️ 唯一漏网的"注释类"负载是 **sourcemap**：main 写死 `sourcemap: true`、preload 写死 `sourcemap: 'inline'`（注释标 "For Debug"），无环境区分 → 打包版把它们全带进 asar 发了货。
- naive-ui 全部按需 named import（grep 全 src 无全量引入），tree-shaking 生效，无需 unplugin。
- `files: ["dist"]`、`asarUnpack` 只放 ffmpeg/ffprobe → electron-builder 这层没有赘肉。

## 二、成本阶梯与结论

### ① 关生产 sourcemap（零成本、高收益，建议做）
改法（保留 VS Code 调试流，因为该流程本来就走 `VSCODE_DEBUG` 环境变量）：

```ts
// main
sourcemap: !!process.env.VSCODE_DEBUG,
// preload
sourcemap: process.env.VSCODE_DEBUG ? 'inline' : false,
```

代价：打包版崩溃时没有栈映射（目前asar里带着也没见他真用过）。收益：asar 与安装包直接变小，preload 的 inline map 是把整个 map 塞进 JS 里，尤肥。

### ② `build:fast` 拆脚本（零风险，建议做）

```json
"build": "npm run typecheck && vite build && electron-builder",
"build:fast": "vite build && electron-builder"
```

vue-tsc 全量类型检查通常是整条链最慢的一段。验证三件套纪律不变：交付前照旧跑 `npm run typecheck`，只是打包脚本不强制它。

### ③ 不建议动的（有代价、低收益）
- **删 license 注释**：产物里只剩版权横幅，几 KB 以内，删它违反第三方合规惯例。如坚持要删才换 terser（`build.terserOptions.format.comments: false`），但 terser 更慢、与"提速度"目标自相矛盾。
- **去掉 `vue → vue.esm-bundler.js` 别名**：若全 SFC 编译则不需要运行时编译器，可省几十 KB【推理，未实测】。但该别名是刻意写的，删前必须先验证没有任何运行时模板字符串编译（`h('div', ...)` 不算，`template: '...'` / 动态组件才算）。
- **gzip/brotli 预压缩**：Electron 本地加载不走网络，预压缩反而多一次解压，负优化。
- **rolldown-vite / 换构建内核**：实验性，收益不确定，风险不对称。
- **动 asar 结构 / files 列表**：fluent-ffmpeg 等运行时依赖必须留在 asar（ffmpeg/ffprobe exe 已正确 asarUnpack），没有可删项。

### ④ 打包速度的其它事实
- Electron 本体下载有全局缓存，二次打包不再下载（已默认受益）。
- `rmSync('dist')` 全量重建是必要的（防陈旧文件混入），不动。
- 安装包体积大头是 Electron 运行时本体（~70MB+），与本项目配置无关，无解。

## 三、可自跑验证实验（他自己能跑）

```bash
npx vite build
# 1. 看注释是否真的没了：
findstr /c:"//" dist\electron\main\index.js | find /c "://"   # 大量命中属正常（URL/字符串），肉眼看头部即可
# 2. 看 sourcemap 有没有被发货：
dir dist\electron\main\*.map
# 3. 对比 asar 前后体积：
dir release\*\win-unpacked\resources\app.asar
```
