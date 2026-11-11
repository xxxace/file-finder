# 设计文档 · 全库 3D 专辑封面漫游画廊（Album Cover Tunnel Gallery）

> 日期：2026-11-11  
> 状态：待确认（Ready for Review）  
> 关联：`D:\code\LeiBox\src\lib\motion-core\album-cover-tunnel.mjs` · `src/views/Shell/RailNav.vue` · `electron/server/index.ts` · `electron/server/nedb.ts`

---

## 1. 背景与目标（Intent & Goals）

### 1.1 背景
当前 `file-finder` 应用主要以二维网格（卡片流）和目录树的形式浏览媒体资源。用户在多个移动硬盘或本地磁盘中已扫描并缓存了大量作品封面（存储在 NeDB 中，缩略图落入 `binStore` 且通过 `/thumb` 提供极快解密响应）。
雷师傅在 `LeiBox` 中实现了一套惊艳的「3D 专辑封面隧道（`album-cover-tunnel`）」效果：卡片在纵深三维空间中形成无限循环穿行隧道，具备悬停磁吸、同层挤压避让、点击沿 3D 弧线飞入中央焦平面、景深光晕与体积光辉映的极高质感，且通过 InstancedMesh 与 DataArrayTexture 实现了单 Draw Call 的极高性能。
用户希望将该效果引入 `file-finder`，作为**全库/跨盘的独立 3D 漫游画廊**，利用应用中已缓存的真实封面让用户可以在三维空间中沉浸式穿行探索所有收藏。

### 1.2 目标（Goals）
1. **全库独立 3D 漫游视图**：在左侧导航轨（RailNav）中增加「3D 漫游」入口，开辟专属路由 `/tunnel`，汇聚全库所有已缓存封面。
2. **忠实复刻原版极致质感**：
   - 继承 LeiBox 的核心着色器效果：卡盒厚度亚克力质感、覆膜流光扫光、边缘倒角与软阴影、屏幕空间体积光束（God Rays）、基于 Mipmap Bias 的零开销景深模糊。
   - 继承核心运动物理：滚轮/拖拽平滑惯性穿梭、磁吸悬停抬升、点击弧线飞入中央并对焦、方向键跨格巡检、闲置自动巡航。
3. **针对海量封面的高性能显存控制（关键约束）**：
   - 用户缓存可能有数千乃至上万张封面，严禁将全库图片一次性塞入显存。
   - 采用 **64 ~ 96 槽位动态纹理环形池（Texture Array Ring Buffer）**，统一采样尺寸至 **384×384 RGBA**，将三维场景显存严格锁定在 **~45MB 以内**。
   - 结合后台异步批次调度，在用户穿行时无感替换远端层卡片，保证长期运行不爆显存、不卡帧。
4. **与应用现有功能的深度联动**：
   - 当封面被点击飞入中央焦点时，底部 HUD 显示该条目详细信息（作品名、所属盘符、路径、大小）。
   - 提供快捷动作：**一键打开预览/播放**（无缝接入应用现有预览系统）、**定位到目录**（跳转回文件页并打开所在文件夹）、**全屏切换**。
5. **桌面端资源自律**：
   - 页面切出、窗口最小化或组件销毁时，立即暂停渲染循环并彻底 dispose 几何体、纹理与合成器，不占用后台独显算力与功耗。

### 1.3 明确不做（Non-Goals）
1. **不触发任何物理扫盘**：数据完全读取自已有的 NeDB 缓存与本地 `binStore`，离线盘同样可凭缓存缩略图无障碍漫游，不唤醒或摩擦机械硬盘。
2. **不引入重型物理引擎**：吸附、飞入、惯性全部采用轻量阻尼指数衰减（Damped Springs），保持纯原生数学计算。

---

## 2. 备选方案与选型（Approaches）

| 方案 | 架构设计 | 显存与性能 | 交互体验 | 结论 |
|---|---|---|---|---|
| **方案 1：全量生成海量 Mesh + 独立 Texture** | 每个条目一个 Mesh，使用 `THREE.TextureLoader` 逐张载入 | 严重灾难：数百个 Draw Call，数百张独立纹理快速吃光 2GB+ 显存导致 WebGL 崩溃 | 开发简单，但完全不具备可用性 | 坚决否定 |
| **方案 2：固定 96 槽位纹理数组 + 空间网格循环映射（已选）** | 忠实沿用 LeiBox 的 `DataArrayTexture` + `InstancedMesh`（单次 Draw Call），全场景 14 层网格由 96 个纹理槽位按空间散列映射；全库条目在内存中维护轻量元数据列表，穿行时向远端图层增量分批更新 | **极佳**：1 Draw Call，显存恒定 ~45MB，稳定 60 FPS，彻底阻断显存泄漏 | 既具备百张画面的丰富度，又支持无限长河漫游 | **采纳** |
| **方案 3：离线大图集（Sprite Sheet Atlas）** | 后台把封面拼成一张 8192×8192 的巨大图集 | 动图集拼接计算量大，图集边缘采样容易渗色，且尺寸上限受老旧 GPU 限制 | 维护成本高，更新不灵活 | 放弃 |

---

## 3. 详细设计与规范（Specifications）

### 3.1 后端接口：全库封面元数据查询（`electron/server/`）
1. **NeDB 全库封面聚合查询**（`electron/server/nedb.ts`）：
   - 新增 `findAllCachedCovers(options?: { serial?: string }): Promise<TunnelCoverItem[]>`。
   - 从内存中的 `SearchCache` 文档中提取所有带有有效 `sig` 的非目录项，且通过 `hasBin(thumbNameOf(item.sig))` 确保本地缩略图存在。
   - 按 `serial:dir/name` 唯一去重，支持按盘符过滤或全库随机混洗打乱（Shuffle），让漫游充满探索未知感。
   - 数据结构：
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
     }
     ```
2. **HTTP 路由**（`electron/server/index.ts`）：
   - 新增 `GET /getAllCovers?serial=&limit=`。
   - 同样受 `LOCAL_TOKEN` 校验与统一 `route()` 错误捕获保护，纯内存响应，用时 <10ms。

### 3.2 3D 隧道渲染核心（`src/components/AlbumCoverTunnel/`）
基于 LeiBox 原版重构为强类型化的 Vue 3 / TypeScript 引擎：
1. **几何与着色（Geometry & Materials）**：
   - `mergedGeometry`：合并卡片厚度立方体（`BoxGeometry(S, S, TH)`）与背部投影面（`PlaneGeometry(S*1.6, S*1.6)`），并设置 `aPart` 标识。
   - `ShaderMaterial`：包含自定义 Vertex & Fragment 着色器。
     - 片元着色器内嵌背景光晕与深邃星云（`bgCol`）。
     - 正面采样 `sampler2DArray`，带有纸张噪点微粒、倒角微阴影、斜向扫过的亮光覆膜流光（`uTime` 驱动）。
     - 侧面展示亚克力透光边缘与纸芯纹理。
     - 景深：依据到焦平面的距离动态计算 `bias`，在 `texture(map, vec3(..., vTex), bias)` 处实现无损虚化。
2. **实例管理与纹理池（InstancedMesh & Texture Array）**：
   - `covers` 阵列：14 层 × 棋盘格布局（每层随机剔除 40% 形成空隙），共约 400 个实例。
   - `DataArrayTexture`：固定 96 层，384×384 分辨率。
   - 封面载入器：通过并发控制拉取 `/thumb?k=t-<sig>.enc`，在离屏 Canvas 缩放写入 `Uint8Array`，首屏载入 16 张即刻开机，后续利用 `requestIdleCallback` 或定时分批写入并调用 `texture.needsUpdate = true`。
3. **后处理（Postprocessing）**：
   - 半分辨率 `UnrealBloomPass`（辉光发散）。
   - 自定义通道：径向色差（Chromatic Aberration）+ 隧道中心向外辐射的 18 阶体积光条纹（God Rays）+ 动态电影噪点颗粒。
4. **生命周期与清理**：
   - 注册 `ResizeObserver` 响应窗口尺寸变化；
   - 挂载 `IntersectionObserver` 和 `visibilitychange`，切走立即 `cancelAnimationFrame`；
   - `destroy()` 彻底遍历释放 GPU 资源（Geometries, Materials, Textures, RenderTargets, Composer, Renderer forceContextLoss）。

### 3.3 前端视图与交互（`src/views/Tunnel/index.vue`）
1. **导航整合**：
   - `src/views/Shell/RailNav.vue`：在「文件」、「清单」之间或「设置」之前加入「3D 漫游」按钮，图标采用立体方块/画廊符号。
   - `src/views/Shell/nav.ts`：扩充 `RAIL_PATHS.tunnel = '/tunnel'`。
   - `src/router/index.ts`：配置路由 `/tunnel`，采用懒加载导入。
2. **界面 HUD 层**：
   - **顶部操作栏**：
     - 返回主页按钮。
     - 盘符筛选器（全部磁盘 / 指定磁盘）。
     - 漫游封面总数角标。
     - 自动漫游开关（空格键快捷切换）。
   - **底部焦点卡片浮层**：
     - 当某张封面飞入中央对焦（`heroC`）时，渐显卡片详情：作品标题、相对路径、文件大小。
     - 操作按钮组：
       - `[播放/预览]`：直接弹出既有 `usePreview` 大图或视频播放浮层。
       - `[定位目录]`：携带路径跳转回文件页（`router.push({ path: '/', query: { targetPath: ... } })`），无缝打开所在文件夹。
       - `[全屏]`：一键切换沉浸式全屏。
3. **音效联动**：
   - 继承项目现有音效系统 [sfx/engine.ts](file:///D:/code/file-finder/src/utils/sfx/engine.ts)，在悬停卡片吸起（`hover`）和飞入居中（`select`）时播放轻柔的晶体/轻敲音效。
