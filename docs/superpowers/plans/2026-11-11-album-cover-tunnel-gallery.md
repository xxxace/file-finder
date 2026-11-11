# 全库 3D 专辑封面漫游画廊 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在应用中新增全库/跨盘 3D 专辑封面漫游画廊（Album Cover Tunnel Gallery），利用已缓存的真实封面构建高性能、单 Draw Call、显存受控（<45MB）的 WebGL2 沉浸式三维穿行画廊。

**Architecture:** 
1. **数据层（NeDB + 本地 HTTP 服务）**：在 `electron/server/nedb.ts` 实现纯内存全库带封面条目聚合 `findAllCachedCovers`，在 `server/index.ts` 暴露 `/getAllCovers` 接口，零读盘秒级响应。
2. **渲染引擎（Three.js + WebGL2 InstancedMesh）**：将 LeiBox 的 `album-cover-tunnel` 核心算法改造为 TypeScript 强类型引擎。全场景 14 层网格由单一 `InstancedMesh` 渲染（1 Draw Call）；维护 96 层固定大小的 `DataArrayTexture` 纹理环形池（384×384 分辨率），卡片从本地 `/thumb` 异步解码并发写入，通过 Mipmap Bias 实现零成本景深模糊与半分辨率体积光后处理。
3. **交互与视图层（Vue 3 + RailNav）**：在左侧导航轨新增 `tunnel` 一级入口与 `/tunnel` 路由；提供全景全屏 HUD 操作栏（自动巡航、盘符筛选、空格暂停），中央对焦卡片提供「一键预览/播放」与「定位至文件夹」联动。

**Tech Stack:** Three.js (^0.185.1), WebGL2 (InstancedMesh, DataArrayTexture), Vue 3, TypeScript, Naive UI, NeDB, Node.js HTTP Server.

**Spec:** `docs/superpowers/specs/2026-11-11-album-cover-tunnel-gallery-design.md`

## Global Constraints

- **显存与性能底线**：必须使用 2D 纹理数组（`DataArrayTexture`）与实例网格（`InstancedMesh`），单 Draw Call 绘制所有封面；纹理池上限锁定在 96 张以绝不爆显存（<45MB VRAM），稳定 60 FPS。
- **零物理读盘**：所有数据直接从内存中的 `SearchCache` 读取并校验 `binStore` 索引，严禁触发任何文件系统扫描。
- **资源清理自律**：组件卸载或切页时必须彻底释放所有 Three.js 几何体、纹理、材质、后期通道并停止 RAF，窗口不可见时自动暂停动画。
- **类型安全**：所有新建和改动文件必须 100% 通过 `npm run typecheck`。

## Review Focus

1. **空库兜底**：当用户尚未扫描过任何带封面的目录时，画廊应展示优雅的空状态提示与引导，而不是三维黑屏或抛异常。
2. **离线盘封面可用性**：即使物理移动硬盘已拔除，只要 `binStore` 存在该缩略图缓存，条目依然可以正常载入并在 3D 隧道中漫游。
3. **纹理异步载入竞争**：在用户高速穿梭或切换盘符过滤时，旧的异步图片写入不得污染新的纹理图层，切页时应安全中止未完成的解码。
4. **焦点联动容错**：点击飞入中央的封面若因原盘离线无法直接打开文件，需优雅给出「磁盘离线」轻提示，而不是静默失败。
5. **快捷键冲突防护**：空格键暂停/恢复自动巡航、方向键选择邻近卡片等事件监听必须在全屏或场景激活时捕获，避免污染搜索框等输入控件。

---

### Task 1: 后端全库封面聚合接口与探针测试

**Files:**
- Modify: `electron/server/nedb.ts`
- Modify: `electron/server/index.ts`
- Create: `docs/probes/tunnel/all-covers-test.mjs`

**Interfaces:**
- Produces: `findAllCachedCovers(serial?: string): Promise<TunnelCoverItem[]>` in `nedb.ts`
- Produces: `GET /getAllCovers?serial=&limit=` in `server/index.ts`

- [ ] **Step 1: 编写失败探针测试**

在 `docs/probes/tunnel/all-covers-test.mjs` 编写探针：
- 测试 `findAllCachedCovers()` 返回所有带有效 `sig` 的条目。
- 测试过滤掉目录项（`isDirectory === true` 或 `type === 'folder'`）。
- 测试按 `serial:dir/name` 唯一去重。
- 测试支持 `serial` 过滤。

- [ ] **Step 2: 运行探针验证失败**

运行：`node docs/probes/tunnel/all-covers-test.mjs`  
预期：FAIL（模块中尚无 `findAllCachedCovers` 方法）。

- [ ] **Step 3: 在 `electron/server/nedb.ts` 实现 `findAllCachedCovers`**

实现：
```ts
export interface TunnelCoverItem {
    id: string;
    name: string;
    dir: string;
    serial: string;
    sig: string;
    type: string;
    ext?: string;
    size?: number;
    files?: FileInfoFiles[];
}

export async function findAllCachedCovers(serial?: string): Promise<TunnelCoverItem[]>
```
逻辑：
1. 查 NeDB 中所有 `SearchCache` 文档（若指定 `serial` 则增加匹配）。
2. 遍历 `doc.data`，提取 `it.sig && !it.isDirectory && it.type !== 'folder'`。
3. 检查 `hasBin(thumbNameOf(it.sig))`，确认本地缩略图文件真实存在。
4. 按 `${doc.serial}:${it.dir}/${it.name}` 去重，组装为 `TunnelCoverItem` 返回。

- [ ] **Step 4: 在 `electron/server/index.ts` 注册 `/getAllCovers` 路由**

在 `electron/server/index.ts` 增加：
```ts
async function getAllCoversController(req: Req, res: http.ServerResponse) {
    const serial = req.params?.get('serial') || undefined;
    const items = await findAllCachedCovers(serial);
    sendJson(res, { code: 200, data: { items, total: items.length } });
}
route('/getAllCovers', getAllCoversController);
```

- [ ] **Step 5: 运行探针验证通过**

运行：`node docs/probes/tunnel/all-covers-test.mjs`  
预期：PASS（探针全部通过）。

- [ ] **Step 6: 提交代码**

```bash
git add electron/server/nedb.ts electron/server/index.ts docs/probes/tunnel/all-covers-test.mjs
git commit -m "feat(tunnel): add findAllCachedCovers nedb query and /getAllCovers endpoint"
```

---

### Task 2: 安装 Three.js 依赖与类型定义

**Files:**
- Modify: `package.json`

**Interfaces:**
- Produces: `three` and `@types/three` dependencies available in workspace

- [ ] **Step 1: 安装 Three.js 依赖**

运行：`npm install three@^0.185.1 && npm install -D @types/three@^0.185.1`

- [ ] **Step 2: 验证安装与类型检查**

运行：`npm run typecheck`  
预期：Exit code 0。

- [ ] **Step 3: 提交代码**

```bash
git add package.json package-lock.json
git commit -m "chore: install three and @types/three"
```

---

### Task 3: 移植与构建 3D 封面隧道渲染引擎（Engine & Shaders）

**Files:**
- Create: `src/components/AlbumCoverTunnel/types.ts`
- Create: `src/components/AlbumCoverTunnel/engine.ts`

**Interfaces:**
- Produces: `createAlbumCoverTunnel(container: HTMLElement, options: TunnelOptions): TunnelController`

- [ ] **Step 1: 编写引擎接口类型定义 `types.ts`**

定义：
- `TunnelCover`: `{ id: string; src: string; title: string; raw: any }`
- `TunnelOptions`: `{ height?: number; theme?: 'dark' | 'light'; autoTravel?: boolean; onSelect?: (item: TunnelCover) => void; onHover?: (item: TunnelCover | null) => void }`
- `TunnelController`: `{ destroy(): void; update(options: Partial<TunnelOptions>): void; setCovers(covers: TunnelCover[]): Promise<void>; pause(): void; resume(): void; isPaused(): boolean }`

- [ ] **Step 2: 实现 3D 渲染核心 `engine.ts`**

将 LeiBox 原版重构为现代模块化 TypeScript 实现：
1. **几何与材质**：
   - 合并卡片盒子几何体 `BoxGeometry(S, S, TH)` 与投影几何体 `PlaneGeometry(S*1.6, S*1.6)`，设置 `aPart`。
   - `ShaderMaterial`：内嵌 LeiBox 原创着色器（正面采样 `sampler2DArray`、侧面亚克力与纸芯条纹、倒角流光高光、背景渐变星云、Mipmap bias 景深模糊）。
2. **InstancedMesh**：
   - 14 层棋盘格布局，构建约 400 个实例，设置 `aTex`、`aLook`、`aPh`、`aFog` 等顶点缓冲属性。
3. **DataArrayTexture 纹理池（384×384）**：
   - 维护 96 层纹理数组，支持通过 `HTMLImageElement` / `ImageBitmap` 异步分批更新层，调用 `texture.needsUpdate = true`。
4. **后期处理**：
   - `EffectComposer` + `RenderPass` + 半分辨率 `UnrealBloomPass` + 径向色差与体积光 ShaderPass。
5. **物理运动与屏幕拾取**：
   - 滚轮/拖拽穿行惯性衰减，空闲对齐最近层；
   - 屏幕空间投影拾取，悬停吸起抬升，同层邻居排斥推开；
   - 点击卡片沿 3D 贝塞尔弧线飞入中央焦点并推进相机；
   - 方向键移动对焦点。
6. **资源治理**：
   - `ResizeObserver` 响应容器尺寸；
   - `IntersectionObserver` 监听可见性，不可见时休眠 RAF；
   - 完整的 `destroy()` 方法释放全部 WebGL 对象。

- [ ] **Step 3: 运行类型检查验证**

运行：`npm run typecheck`  
预期：PASS。

- [ ] **Step 4: 提交代码**

```bash
git add src/components/AlbumCoverTunnel/types.ts src/components/AlbumCoverTunnel/engine.ts
git commit -m "feat(tunnel): implement Three.js WebGL2 album cover tunnel engine"
```

---

### Task 4: 3D 封面隧道 Vue 组件与 HUD 交互层

**Files:**
- Create: `src/components/AlbumCoverTunnel/AlbumCoverTunnel.vue`

**Interfaces:**
- Produces: `<AlbumCoverTunnel :items="covers" @select="onSelect" @navigate-dir="onNavigateDir" />`

- [ ] **Step 1: 实现 `AlbumCoverTunnel.vue` 模板与组件逻辑**

实现内容：
1. **DOM 容器**：挂载 3D Canvas 容器 `#stage`，绑定尺寸自适应与触摸/鼠标事件。
2. **HUD 顶栏**：
   - 返回按钮（回到上一页）。
   - 自动漫游切换按钮（带运行状态呼吸灯，提示快捷键空格）。
   - 封面总数角标。
   - 全屏切换按钮。
3. **HUD 底部焦点卡片操作栏**：
   - 当某张封面飞入中央对焦时展示其信息：作品名、磁盘/路径、文件大小。
   - 操作按钮：
     - `[预览/播放]`：派发 `select` 事件呼出预览浮层。
     - `[在文件中定位]`：派发 `navigate-dir` 事件。
4. **生命周期绑定**：
   - `onMounted` 实例化 `createAlbumCoverTunnel`。
   - `watch(() => props.items)` 动态分批向引擎更新纹理。
   - `onBeforeUnmount` 调用 `controller.destroy()`。

- [ ] **Step 2: 运行类型检查验证**

运行：`npm run typecheck`  
预期：PASS。

- [ ] **Step 3: 提交代码**

```bash
git add src/components/AlbumCoverTunnel/AlbumCoverTunnel.vue
git commit -m "feat(tunnel): create AlbumCoverTunnel.vue component with HUD controls"
```

---

### Task 5: 导航轨整合、路由开辟与全局页面接入

**Files:**
- Modify: `src/views/Shell/nav.ts`
- Modify: `src/views/Shell/RailNav.vue`
- Modify: `src/router/index.ts`
- Create: `src/views/Tunnel/index.vue`

**Interfaces:**
- Produces: `/tunnel` route and left rail navigation entry for 3D Gallery

- [ ] **Step 1: 扩充导航定义 `nav.ts` 与 `RailNav.vue`**

1. 在 `src/views/Shell/nav.ts` 中：
   - 在 `RailKey` 联合类型中增加 `'tunnel'`。
   - 在 `RAIL_PATHS` 中增加 `tunnel: '/tunnel'`。
2. 在 `src/views/Shell/RailNav.vue` 中：
   - 导入或编写立体立方体/画廊图标。
   - 在清单（playlists）和缓存（cache）之间增加「3D 漫游」项，赋予 Tooltip 提示「3D 封面漫游」。

- [ ] **Step 2: 注册 `/tunnel` 路由**

在 `src/router/index.ts` 中增加：
```ts
const TunnelPage = () => import('@/views/Tunnel/index.vue');
// 在 routes 数组加入:
{ path: '/tunnel', name: 'tunnel', component: TunnelPage },
```

- [ ] **Step 3: 实现全屏独立页 `src/views/Tunnel/index.vue`**

页面逻辑：
1. 进入页面时调用 `apiUrl('/getAllCovers')` 获取全库已缓存封面元数据。
2. 映射为带 `/thumb?k=...` 的条目清单，传入 `<AlbumCoverTunnel>`。
3. 盘符筛选器：支持切换「全部磁盘」或指定某块在线/离线盘。
4. 联动操作处理：
   - `onSelect(item)`：调用 `usePreview` 或打开应用预览模态框。
   - `onNavigateDir(item)`：通过 `router.push('/')` 并携带目录路径，自动切换回文件浏览视图并定位该文件夹。
5. 音效联动：在吸附与点击选择时调用 `playSfx('menu-click')` 或轻敲音效。

- [ ] **Step 4: 运行类型检查验证**

运行：`npm run typecheck`  
预期：PASS。

- [ ] **Step 5: 提交代码**

```bash
git add src/views/Shell/nav.ts src/views/Shell/RailNav.vue src/router/index.ts src/views/Tunnel/index.vue
git commit -m "feat(tunnel): integrate tunnel gallery into router and left rail nav"
```

---

### Task 6: 构建验证与综合体验验收

**Files:**
- Test: 全库构建与类型测试

- [ ] **Step 1: 运行全工程类型检查**

运行：`npm run typecheck`  
预期：无任何 TypeScript 报错。

- [ ] **Step 2: 运行 Vite 生产打包验证**

运行：`npx vite build`  
预期：构建成功，产物正确生成。

- [ ] **Step 3: 提交代码**

```bash
git commit --allow-empty -m "chore(tunnel): verify build and typecheck pass"
```
