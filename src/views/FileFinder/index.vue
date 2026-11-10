<template>
    <div class="file-finder">
        <div class="header-bar">
            <!-- 顶栏三段（2026-11-08 定稿）：
                 `[▤ 起点][← 后退][→ 前进][↻ 刷新] │ [ 盘: › 段 › 当前段 ⑫ ] │ [⌕][▦][⊞] | [⋯]`
                 中间那条槽是头部**唯一的弹性槽位**（`flex: 1`）—— 它吃掉剩余宽度，
                 所以面包屑右边永远是空的：一次 append / remove 里，排在变动点右边的东西
                 必然被推着走；右边没东西，变化就只剩"多一段 / 少一段"。
                 继续用**裸 flex**、不用 n-space：naive-ui 2.45.3 的 Space 会给每个子项写死
                 同一个 key（`key: 1`），而这一组的子元素个数是**会变**的（v-for + 折叠占位），
                 一变就会重复 key、错位复用节点（docs/FIX-2026-09-24-nspace-duplicate-keys.md）。
                 ⚠️ 槽里每个子项都必须有 key（TransitionGroup 的进出场按 key 认人）。 -->
            <!-- 左侧四颗：起点 / 后退 / 前进 / 刷新（2026-11-10 双向导航）。
                 ⚠️ 它们**刻意不放进 TransitionGroup** —— 面包屑"零位移"的前提是
                 「排在变动点右边的东西必然被推着走」；常驻按钮挪出槽之后，槽里只剩面包屑，
                 这条约束就退化成"只多一段 / 只少一段"，干扰源被直接删掉。
                 顺序抄 Windows 资源管理器 / Chrome：`[←][→][↻][地址栏]`。

                 ⚠️ 后退 / 前进**两颗都常驻、不 `v-if`**，只在无路可走时置灰：
                 按钮一出现/消失就把整条面包屑推走 ~32px，正是 2026-11-08 修掉的那类跳动。
                 28px 方格定宽 ⇒ 图标怎么换连 1px 都不动（11-08 用 `←`/`⨯` 换字形验证过）。

                 ⚠️ 2026-11-10 裁决：原来那套"末尾一颗按 `history.length` 三态变形
                 （`←` 返回 → `⨯` 清空 → 空栈置灰）"**已撤**。加了前进之后
                 "后退不可用"与"该清空了"是两件事，一颗按钮表达不了。
                 ⇒ 「清空导航历史」搬到**右键菜单**末尾（出口没消失，只是搬家）。 -->
            <div class="nav-btns">
                <FolderSelector ref="folderSelector" v-model="dir" label="请选择文件夹" keys="D" @change="setRoot" />
                <n-button size="small" :disabled="!canBack" aria-label="返回上一屏"
                    v-tip="canBack ? { text: '返回上一屏', keys: 'Backspace' } : { text: '没有上一屏了' }"
                    @click="onBack">
                    <template #icon>
                        <n-icon :component="ArrowBackOutline" />
                    </template>
                </n-button>
                <n-button size="small" :disabled="!canForward" aria-label="前进到下一屏"
                    v-tip="canForward ? { text: '前进到下一屏', keys: 'Alt+→' } : { text: '没有下一屏' }"
                    @click="onForward">
                    <template #icon>
                        <n-icon :component="ArrowForwardOutline" />
                    </template>
                </n-button>
                <!-- 刷新住在导航区、不搬去动作区：它重读的是**当前这个位置**，
                     与「返回」同属位置动作。tooltip 只为说清它和「重读这一片」的分工。
                     扫描期间禁掉：它带 noCache、会真的再读一次盘，与整片扫描并发就是两路读盘。
                     只读层 / 清单屏也禁掉：那两种屏的源就是缓存，没有"重读"这回事。 -->
                <n-button size="small" :disabled="scanning || readOnlyLevel || playlistLevel"
                    aria-label="刷新" v-tip="{ text: '刷新', keys: 'F5' }" @click="onRefresh">
                    <template #icon>
                        <n-icon :component="RefreshOutline" />
                    </template>
                </n-button>
            </div>

            <!-- 地址槽（外层只管"一块面"，里层才是面包屑列表）—— 2026-11-08 第二轮。
                 为什么拆成两层：galaxy 进度像素层要**铺满整个槽**，而 `TransitionGroup` 的子节点
                 必须带 key、还会被 FLIP 挪来挪去 ⇒ 画布不能当它的兄弟。
                 ⚠️ 类名仍然叫 `.nav-zone`：非 scoped 块里有 10 处 `.nav-zone .fx-*` 在兜作用域，
                 面包屑挪进内层之后这些选择器**依旧命中**（后代选择器），一处都不用改。 -->
            <div class="nav-zone">
                <!-- 进度效果的落点：铺满整条地址槽（主人 2026-11-08："用到地址栏的盒子中，占满整个盒子"）。
                     进度**仍然以 naive 的 `.n-loading-bar` 为唯一真相源** —— 它现在只是
                     `visibility: hidden`（见 App.vue），尺寸照常读得到，本层只负责"画得好看"。 -->
                <GalaxyLoadingBar />

                <!-- 面包屑 = 从**盘符 / 离线锚点**到当前的完整链，由 `ancestorsOf(currentPath)` 现算。
                     为什么不按导航栈渲染：跳转到达的目录**不是"栈顶的子级"**，用栈拼会拼出
                     一条物理上不存在的路径（`videos › a › y`）——
                     见 docs/DESIGN-NAV-2026-09-30.md §12.3 的反证推演。
                     ⚠️ 2026-11-10 主人裁决：**不再按段数折叠**（原 `max = 4`，第 5 段起就折成
                     `盘符 › … › 当前`）。那个 4 是「地址槽只占半条顶栏」时代定的常量，
                     而 11-08 顶栏升级已经把 `max-width: 50%` 取消、槽变成"吃掉全部剩余宽度"
                     ⇒ 常量活着，它服务的那个预算早死了。现在**能放几段放几段**：
                     放不下时由 CSS 逐段收窄 + 省略号（历史段先让路，当前段 `flex: 0 0 auto`
                     永不被压），与 11-09「不设 max-width」是同一条裁决的延伸。
                     ⇒ 顺带修强了 11-08 的一条验收：结构不再随宽度变 ⇒ 搜索框展开挤压时
                     **不可能**引起整排重新折叠。 -->
                <!-- ⚠️ 2026-11-08 重构：原来是 `v-if="crumbFold"` / `v-else` **两棵互斥的树**。
                     层级跨过阈值的那一下，Vue 会销毁整棵子树、再重建另一棵 ⇒ 视觉上是
                     "整排地址重新渲染一次"（主人原话）。现在统一由 `crumbRows` 这一个数组驱动。
                     首段 / 其余段拆成两段渲染，是为了避开 `<template v-for>` + `v-if` 混用
                     （TransitionGroup 的 FLIP 拿不到 fragment）。 -->
                <TransitionGroup name="fx" tag="div" class="crumbs" @before-leave="pinLeaving">
                <n-tag v-if="crumbLayout.head" :key="crumbLayout.head.key" class="crumb"
                    :class="{ 'crumb-root': crumbLayout.head.kind === 'root', 'crumb-current': crumbLayout.headCurrent }"
                    :title="crumbLayout.head.path" :data-count="crumbLayout.headCurrent ? crumbCount : null"
                    @click="onCrumbClick(crumbLayout.head)">
                    <!-- ⚠️ 首段必须绑 `@click`（2026-11-08 code review 找回的回归）：
                         `onCrumbClick` 里 `kind === 'root'` 那支是**清单屏点根段回货架**的捷径。
                         head / tail 拆成两段渲染后首段独立成 `head`，当时没绑 ⇒ 那支变死代码。
                         磁盘根不必担心：`onCrumbClick` 自己会 return（点它不读盘）。 -->
                    <span class="crumb-text">{{ crumbLayout.head.name }}</span>
                </n-tag>
                <n-tag v-for="(row, i) in crumbLayout.tail" :key="row.key" class="crumb"
                    :class="{ 'crumb-root': row.kind === 'root', 'crumb-current': i === crumbLayout.tail.length - 1 }"
                    :title="row.path" :data-count="i === crumbLayout.tail.length - 1 ? crumbCount : null"
                    @click="onCrumbClick(row)">
                    <span class="crumb-text">{{ row.name }}</span>
                    <!-- ⚠️ 2026-11-08 第七轮：这里原来有一个
                         `<n-spin v-if="loading && i === last" :size="12" style="margin-left:8px" />`。
                         删掉，因为它**就是**主人报的"videos 从上跳到下"：
                         · 转圈是当前段的一个子元素，插进 `.n-tag__content` 后把**文字顶上去 7px**，
                           加载完再掉回来（探针实测 `文字dy = 0 → -7 → 0`，`out.txt` 场景⑤）；
                         · 它对宽度毫无贡献（实测 47.36 不变）⇒ 它连"在转"都没人看见，
                           纯粹是个把这一格挤变形的副作用。
                         · 而且它是**重复**的第二个指示器：`enterScreen` / `onBack` 里
                           `loadingBar.start()/finish()` 一直在跑，顶部那条进度条才是正经的地方。
                         要恢复"这一层在加载"的可见信号，请在**网格区**做，别塞进面包屑。 -->
                </n-tag>

                </TransitionGroup>
            </div>
            <!-- 动作区：搜索 / 视图组 / 更多。
                 顺序重排过一次（2026-11-08）：「更多」从**最左**挪到**最右** ——
                 它是兜底入口，永远排在末端（Chrome `⋮`、资源管理器 `⋯` 同理）；
                 原来它在最左、紧挨搜索框，等于"最不常用的东西占了最顺手的位置"。 -->
            <div class="toolbar">
                <!-- 搜索：一颗图标 ⇄ 一个输入框（主人 2026-11-08 裁决：宽度从**地址槽**里挤，不做浮层）。
                     为什么敢挤：面包屑**结构只跟路径走、不跟宽度走**（2026-11-10 起连段数折叠也去掉，
                     见上面 `.crumbs` 那段）⇒ 挤压只会让各段文字收窄/省略，**绝不触发整排重排**；
                     而右侧从 ~420px（⋯ + 搜索 260 + 3×28）降到 ~137px ⇒ 收起态面包屑多 +181px、
                     展开态仍 ≈ 今天 ⇒ **没有任何一个状态比现状更挤**。
                     账与前提：docs/DESIGN-HEADER-UPGRADE-2026-11-08.md §三。
                     ⚠️ 输入框**常驻**、不 `v-if`：换节点就丢了上一帧，宽度动画只能从 0 开始。
                     收起态它 `opacity:0` + `pointer-events:none`，点击由上面那颗图标按钮接住。 -->
                <div ref="searchSlot" class="search-slot" :class="{ 'is-open': searchOpen }">
                    <n-input ref="searchInput" v-model:value="searchText" placeholder="搜索" size="small" clearable
                        @keydown.esc="blurSearch" @blur="onSearchBlur" @focus="onSearchFocus">
                        <template #prefix>
                            <n-icon :component="SearchOutline" />
                        </template>
                    </n-input>
                    <!-- 快捷键键帽（原来在输入框内做 `kbd S`）挪进 tooltip：键帽只在"看得见输入框"时
                         才有意义，而收起态根本没有框。提示没丢，也不再占输入框的右侧空间。 -->
                    <n-button class="search-btn" size="small" aria-label="搜索（S）" @click="openSearch"
                        v-tip="{ text: '搜索', keys: 'S' }">
                        <template #icon>
                            <n-icon :component="SearchOutline" />
                        </template>
                    </n-button>
                </div>
                <!-- 视图密度：与下面「平铺」同属视图类动作，紧挨着放。
                     常驻（任何目录都能切），与 flat 互不影响 —— flat 决定"摊开哪些条目"，
                     密度决定"一屏铺几列"，两者正交。 -->
                <GridDensityMenu v-model="density" :menu-props="moreMenuProps" />
                <!-- 平铺视图切换：**任意层级**都能开（2026-11-10 放开，原来只许盘根）——
                     跳过中间的女优/分类目录，把当前这一层下面所有作品摊开。 -->
                <!-- 激活态见样式 `.toolbar :deep(.is-on)`（灰底 + text-1）。
                     **不用 `type="primary"`**：那会让一个视图开关变成整条工具栏最响的东西
                     （2026-11-07 截图里那块白方块就是它）。 -->
                <n-button class="icon-lg" size="small" :class="{ 'is-on': isFlatView }"
                    :disabled="scanning || !canToggleFlat" @click="toggleFlatView"
                    v-tip="isFlatView ? { text: '平铺视图' } : (canToggleFlat ? { text: '平铺这一层' } : { text: '清单不支持平铺' })">
                    <template #icon>
                        <!-- 2 列 × 3 行的**横向卡片** ⇒ "作品摊开成一片"，这就是平铺本身。
                             ⚠️ 换过四版才有定论：`Layers` 画的是"层"、是**被摊的对象**而不是
                             摊完的样子，当场被否；Fluent `GridDots` 是 3×3 **实心点**，与密度
                             那颗的方格读起来像同一档。现在改为自绘、且刻意用**宽高比 1.65 的
                             卡片**而不是正方形 —— 形状语言与密度三档（方格阵）分开，并排也
                             不会再被读成"第四档密度"。画法与尺寸见 `components/icons/grid.ts`。
                             旁边密度那颗也一并换成自绘方块阵（`GridDensityMenu.vue`）。 -->
                        <n-icon :component="FlatCards24" />
                    </template>
                </n-button>
                <span class="toolbar-sep" aria-hidden="true"></span>
                <n-dropdown trigger="click" :options="moreOptions" :disabled="scanning" :menu-props="moreMenuProps"
                    @select="onMoreSelect">
                    <!-- 只有图标，**不再带"更多"两个字**（主人 2026-11-08：不要两者并用）。
                       三点是跨平台的"更多"惯例，图标本身就够；带文字只是把工具条撑宽。
                       `aria-label` 补无障碍名字（没有文字时读屏会念不出来）。
                       ⚠️ 位置固定在**最右**（2026-11-08）：兜底入口永远排末端。
                       ⚠️ 同日换竖三点（Fluent `MoreVertical28Filled`）：竖的在最右端锚定更稳、不会
                       往外"流"。它纵向墨迹只占 76.8%（原横三点 81%）⇒ 与上面那颗共用
                       `.icon-lg` 的 20px 一起补回，别在这里单独写尺寸。 -->
                    <n-button class="icon-lg" size="small" :disabled="scanning" aria-label="更多">
                        <template #icon>
                            <n-icon>
                                <MoreVertical28Filled />
                            </n-icon>
                        </template>
                    </n-button>
                </n-dropdown>
            </div>
        </div>
        <!-- 2026-10-21 主人裁决：次栏整条去掉。
             盘条：没有场景 —— 换盘用左上角的选择器就够，多一排是重复入口；
             换封面：不是高频动作，回到「更多」里（低频动作不该占常驻位置）。 -->
        <!-- 失败横幅：和"空目录"那行浅灰小字是**两件事**，绝不能混成一件事。
             空 = 这里本来就没有东西；横幅 = 这里应该有东西、但现在读不到。
             不做 closable：它的寿命由取数结果管（下一次成功就自动消失）——
             手动关掉只会让"我读不到"这个事实重新变回一片空白，那是在骗人。
             文案来自服务端给的 kind（ApiError.kind），不是 match 错误文本。 -->
        <!-- 横幅在**文档流里**（顶栏不再是浮层 ⇒ 不用再替它让出 `--ff-header-h`），
             左右缩进与顶栏、网格共用同一个算式。 -->
        <Banner v-if="banner.text" :type="banner.type" style="margin: 8px var(--ff-content-inset) 4px">
            {{ banner.text }}
        </Banner>
        <!-- `--ff-grid-cols` 是列数的唯一出口（值来自 `density.ts`）；
             `data-density` 供紧凑档收缩标题/角标（见样式里那组 `--item-*` 变量）。 -->
        <!-- 只包一层：给扫描动效一个"铺满网格可视区"的定位祖先。
             动效必须只作用于这一块（不是整窗），而下面的 `.image-box` 自己是滚动容器，
             把遮罩放它里面会跟着内容一起滚走。 -->
        <div class="image-box-wrap">
            <div
                class="image-box"
                :class="{ 'is-glowing': !!glow }"
                ref="imageBox"
                :data-density="density"
                :style="{ '--ff-grid-cols': gridCols }"
                @contextmenu.prevent="onBlankContextMenu"
            >
                <!-- key 不能只用 item.name：封面条目的 name 取的是**封面图文件名**，
                     同一层的两个文件夹若都叫 cover.jpg，就会生成两个 key="cover"。
                     Vue 遇到重复 key 会复用错的组件实例，封面会串到别的格子里。
                     加上 dir 就唯一了（folder 模式下 dir 是父目录，同样唯一）。 -->
                <!-- ⚠️ `v-memo`：532 项时每次方向键都会把**整列 vnode** patch 一遍（卡片不是子组件，
                     所有状态都在同一渲染作用域）⇒ 长按发涩、滚动条一顿一顿。memo 里列的是
                     **影响这一格渲染的全部值**，光标移动时只有旧/新两张的数组会变，其余 530 个直接跳过。
                     ⚠️ 漏依赖的后果是"某处 UI 不跟着变" —— 以后给卡片加新状态时，必须同步加进这个数组。
                     ⚠️⚠️ 2026-11-10：`cursorKey` **已从这个数组里删掉**（连同下面的 `cursor` 类）。
                     光标现在是 `data-cursor` 标记（`cursorMark.ts`）—— 只要模板还读 `cursorKey`，
                     每按一次方向键就要重渲染整屏卡片；那笔开销在平铺几千格时是每键 1–3ms，
                     而屏幕上其实只动了两张卡。**别再加回来**。 -->
                <div v-for="(item) in fileList" :key="item.dir + '/' + item.name" v-memo="[
                    item, picking && isPickable(item), isPicked(item),
                    opening === keyOf(item), plMember.has(keyOf(item)),
                ]" class="image-box-item" :class="{
                        pickable: picking && isPickable(item), picked: isPicked(item),
                        // 光标（选择器）的环**不在这里**：它由 `data-cursor` 属性驱动（CSS 侧写
                        // `[data-cursor]`），由 `useGridCursor` 命令式打标。见上方 v-memo 那段。
                        opening: opening !== '' && opening === keyOf(item),
                    }" :data-key="keyOf(item)" @click="onItemClick(item)" @dblclick="handleOpen($event, item)"
                    @contextmenu.prevent="onContextMenu($event, item)" :title="item.name + ' ' + getSize(item.size)">
                    <!-- `pointer-events:none` 保住连点两张；`v-if` 而非 `v-show`（只转零点几秒，不值得留 DOM） -->
                    <div v-if="opening !== '' && opening === keyOf(item)" class="opening-mask">
                        <n-spin :size="20" />
                    </div>
                    <!-- 「换封面」模式下单击格子 = 选中/取消（见 onItemClick）。
                         判断"这张糊不糊"靠格子里的图本身（宽松档 310px、紧凑档 147px），不靠点开大图。
                         ⚠️ 2026-10-04 那条"预览层由 n-image-group 统一渲染、所以这里要
                         `preview-disabled`"的约束**已随 2026-11-10 换原生 `<img>` 消失**：
                         不再有 `n-image` 子节点，也就没有"srcList 模式下会 throwError"这回事。 -->
                    <!-- 封面块：16:9 定比例、圆角走 `--ff-radius-card`（换回直角只改 token）。
                         比例定死 ⇒ 同一行所有格子等高 —— 这是 `gridGeometry` 分行算法的前提，
                         ⚠️ 绝不能换成"由内容撑高"。 -->
                    <!-- ⚠️ 2026-11-10：**不再**用 `:style="coverBackdrop(item)"` 预置模糊底。
                         那一行把 `--cover-src: url(...)` 写进每一张卡，而它是 CSS
                         `background-image` —— **背景图没有 lazy**：样式一解析就发请求，
                         一屏 500 张卡就在打开瞬间打 500 个 `/thumb`（业主在 DevTools 里看到的）。
                         `loading="lazy"` 省下的全被它抵消。
                         现在由 `onCoverLoad`（图片自己加载完之后）再写这个变量，
                         而同一张图的字节已经在 HTTP 缓存里 ⇒ **零额外请求**。 -->
                    <div class="card-cover">
                        <!-- ⚠️ 2026-11-10 渲染层优化：图片/视频封面改用**原生 `<img>`**。
                             原来这里是 `n-image`：一张卡 = 一个组件实例 + 一套 props/watch +
                             一个 `IntersectionObserver`。平铺（从任意层向下）把卡片数从"几十"
                             变成"几千"时，这一项是挂载与内存里最贵的部分；而原生
                             `loading="lazy" decoding="async"` 干的是**同一件事**（进视口才解码），
                             还不占 Vue 实例。
                             ⚠️ **不挂 `.stop`**：点封面 = 开大图 + **继续冒泡给卡片**
                             （`.image-box-item` 的 `@click` 在「换封面」模式里是选中/取消，
                             它顺手把刚弹出的预览关掉 —— 那正是"两个动作打架"的既有解法）。
                             加了 `.stop` 会让"此刻正在挑封面"静默失效。
                             ⚠️ 目录的脸（`.card-avatar`）**仍是 `n-image`**：它那套
                             `preview-disabled` + 70%/100% `transform` 语义不值得为它重写，
                             而且平铺结果里根本没有目录条目（只摊叶子），换了是零收益。
                             ⚠️ 必须同时判 `item.thumb`：`thumbUrl(undefined)` 是空串，而
                             `<img src="">` 会被浏览器当成"当前页面地址"去加载 HTML ⇒ 裂图。 -->
                        <img v-if="(item.type === 'image' || item.type === 'video') && !!item.thumb"
                            class="card-img can-preview" :src="thumbUrl(item.thumb)" :alt="item.dir"
                            loading="lazy" decoding="async" @load="onCoverLoad" @click="openPreview(item)" />
                        <!-- 目录的脸：不挑封面时缩到 70%（密网格里 100% 太抢眼），
                             「换封面」模式下放到 100% 才看得清。缩放走 `.card-avatar` 的
                             `transform`（不是内联宽高）—— 理由见样式里那段注释：
                             这是**布局动画 vs 合成动画**的区别，一屏几百个目录时差一整条街。 -->
                        <n-image v-else-if="!!item.avatar" class="card-avatar" :src="thumbUrl(item.avatar)"
                            :alt="item.dir || ''" :lazy="true" objectFit="contain" preview-disabled
                            :img-props="{ onLoad: onCoverLoad }" />
                        <img v-else-if="item.type === 'folder'" :src="folderIcon" :alt="item.dir || ''" class="folder-face">
                        <!-- 类名必须小写：`fiv-icon-*` 是**大小写敏感**的 CSS 类，
                             而盘上有大写扩展名的文件（实测库里有 `.MOV`）⇒ `fiv-icon-MOV` 匹配不到任何图标。 -->
                        <div v-else :title="item.dir"
                            :class="`file-cover fiv-cla fiv-icon-${(item.ext || '').toLowerCase()}`" class="file-face">
                        </div>
                        <!-- 角标（B 站封面下沿那一排）：数量在左、大小在右。
                             `pointer-events:none` —— 它盖在封面上，但点它应该等于点封面。
                             ⚠️ 数量**只在 ≠1 时出现**（2026-11-09 主人裁决）：一屏几十张卡里
                             绝大多数都是「1 个文件」，那条恒定信息只占地方；但 **=0 要留** ——
                             "这个目录里一张片子都没有"是真信息（只有封面图时会走到这里）。
                             ⚠️ 判据必须是 `Array.isArray`：普通目录/单体文件没有 `files` 字段
                             （undefined），拿 `!len` 判会让它们全冒出一个「0 个文件」。
                             ⚠️ 大小那颗必须带 `.badge-size`：容器是 `space-between`，只剩一颗时
                             孤子会被推到**左**端 —— 那就不是"大小"的位置了（code review 抓到）。 -->
                        <div v-if="(Array.isArray(item.files) && item.files.length !== 1) || (item.size || 0) > 0" class="card-badges">
                            <span v-if="Array.isArray(item.files) && item.files.length !== 1" class="badge">{{ item.files.length }} 个文件</span>
                            <span v-if="(item.size || 0) > 0" class="badge badge-size">{{ getSize(item.size) }}</span>
                        </div>
                    </div>
                    <!-- 标题：**永远占两行的高度**（单行也留白）。
                         理由同上 —— 行高成了内容的函数，一行两行的格子就会矮一截，
                         `groupRows` 会把它单独判成一行，方向键从此横着跳。 -->
                    <div class="card-title" :title="item.name">{{ item.name }}</div>
                    <!-- 选中角标。⚠️ 用 `<i>` 而**不是** `<span>` —— `.image-box-item span` 那条
                         （1681 行）里有 `width:100%` + `height:38px !important`，会把角标拉成长条、
                         圆直接变形。换个元素最省事，也不用跟 `!important` 打架。
                         ⚠️ 绝对定位、**不参与布局** —— 格子宽高由 grid 的 `1fr` + 封面比例决定，同行必须等高
                         （`groupRows` 按 `offsetTop` 分行），参与布局就会带偏行结构 -->
                    <i v-if="isPicked(item)" class="pick-badge" aria-hidden="true"></i>
                    <!-- 收录星标（2026-10-21 清单）：这张卡已进某个清单。
                         ⚠️ 绝对定位、**不参与布局** —— 格子宽高由 grid 的 `1fr` + 封面比例决定，同行必须等高
                         （`groupRows` 按 `offsetTop` 分行），参与布局就会带偏行结构。
                         放左上角：pick-badge 在右上，两者不打架。 -->
                    <i v-if="plMember.has(keyOf(item))" class="pl-badge" aria-hidden="true"></i>
                    <!-- 已失效徽标（2026-11-06）：收藏夹内所属盘在线但确认丢失的条目。绝对定位右上角。 -->
                    <i v-if="item.missing" class="pl-missing-badge">已失效</i>
                </div>
                <!-- 空状态：只有一行浅灰小字。不加边框、不加图标、不加按钮 —— 保持极简观感 -->
                <div v-if="emptyTip" class="empty-tip">{{ emptyTip }}</div>
            </div>
            <ScanGlow
                v-if="glow"
                :key="glowKey"
                :kind="glow"
                :running="scanning"
                :cancelling="cancelling"
                :done="scanDone"
                :pending="scanPending"
                @cancel="onScanCancel"
                @swept="onScanSwept"
                @closed="glow = ''"
            />
        </div>
        <!-- 扫描状态条。PC 文件管理器的做法：**进度和「取消」成对待在独立的一条里**，
             不挤进工具条、不顶掉任何按钮（工具条那边只把动作置灰）。
             为什么不再"就地换"：那样工具条的子元素个数会随 `scanning` 变，
             而 naive-ui 的 n-space 在子元素个数变化时会重复 key、错位复用节点 ——
             界面上就出现了两个「重读这一片」和一个点了没反应的「取消」。
             现在这一条整条出现/消失，工具条一个字都不动。
             取消**点了立刻有反馈**：按钮当场变「正在取消…」并置灰。
             ⚠️ 取消只在**目录边界**生效（当前这个目录会扫完）—— 那是刻意的：
             半途中断会留下写了一半的缓存。所以文案要说"当前这个扫完就停"，
             不能让用户以为点了就应该立刻停。 -->
        <!-- ⚠️ 外面这层 `.scan-bar-slot` 只为一件事：**让"挂上 / 摘掉"这件事有高度可过渡**。
             这条状态条**在文档流里**（`.file-finder` 是 flex 列），所以只做淡入是不够的：
             卸载那一帧网格就会跳 50px、然后条自己再淡出去，等于没做。
             要平滑，**高度必须一起过渡**；而 `height: auto` 不能过渡、`max-height` 要写魔数
             （内容一变就剪错高度）。`grid-template-rows: minmax(0,1fr) ↔ minmax(0,0fr)`
             零魔数、内容多高都能收干净。Chromium 152 实测可插值（docs/probes/bar-collapse/）。
             ⚠️ 两个前提缺一不可，少一个就"收不起来"（第一版就是这么失败的）：
                ① 轨道写 `minmax(0, …)` —— 裸写 `0fr` = `minmax(auto, 0fr)`，
                   自动最小尺寸取内容的 min-content，`.scan-bar` 的 `min-height: 40px` 会把它顶死；
                ② 里层 `.scan-bar` 要 `overflow: hidden` —— 网格项的自动最小尺寸
                   只有非 visible 才归 0。
             ⚠️ 扫描条和挑选条**共用**这一条（同一个元素），动画自然也是同一份：
             它们不会同时出现（进模式前会等扫描结束）。 -->
        <!-- ⚠️ glow 期间**不出这一条**（2026-11-08 主人定位）：
             它在文档流里，挂上时靠 `grid-template-rows: 1fr→0fr` 从 0 长到 40px，
             而这 40px 是**从网格里扣的** ⇒ `.image-box-wrap` 变矮、里面的遮罩与 canvas
             被自下而上压扁，同时这条自己向下展开 —— 合起来就是"先上后下"。
             它的两条信息（已扫/待扫、取消）已经搬进光雾面板，功能没有丢。
             `picking` 那条与 glow 不会同时出现（进模式前会等扫描结束）。 -->
        <Transition name="fx-bar">
            <div v-if="(!glow && scanning) || picking" class="scan-bar-slot">
                <div class="scan-bar">
                    <!-- 「换封面」的挑选中。复用这一条而不动工具条 —— 工具条那条铁律是
                         "绝不消失、绝不换形、一个字都不随状态变"，所以模式态的信号只能住在这里。
                         两者不会同时出现（进模式前会等扫描结束）。 -->
                    <template v-if="!scanning">
                        <!-- 三段式：模式标签 → 状态 → 动作（右对齐）。
                             原来的形态是「一句 20 字说明 + 3 个按钮 + 一句帮助文案」全挤在一行，
                             没有主次、也没有留白，读起来像说明书。
                             帮助文案只在**一处都还没选**时出现 —— 选过了就不需要教了。 -->
                        <span class="pick-badge">换封面</span>
                        <span class="pick-count">已选 <b>{{ pickedCount }}</b> 处</span>
                        <span v-if="!pickedCount" class="scan-hint">点有封面的格子；没有封面的那是「补封面」管的事</span>
                        <span class="pick-spacer"></span>
                        <!-- 动作分**两档**：可逆的次要动作（清空 / 退出）与主操作（换封面）。
                             三个按钮等距平铺时读成同一档，主操作喊不出来 —— 组内 8、组间 16。
                             ⚠️ 0 选中时「清空」和「换封面」确实该禁用；它们与可点的「退出」必须**看得出差别**，
                             那条差异由主题层给（`naive-theme.ts` 的 Button.textColor / textColorDisabled），
                             不在这里写局部覆盖。 -->
                        <div class="pick-acts">
                            <n-button size="small" :disabled="!pickedCount" @click="clearPicked">清空</n-button>
                            <n-button size="small" @click="exitPick">退出</n-button>
                            <n-button class="pick-go" size="small" type="primary" :disabled="!pickedCount" @click="openFaces">
                                换封面
                            </n-button>
                        </div>
                    </template>
                    <template v-else>
                        <span class="scan-progress">{{ scanVerb }} {{ scanDone }} · 待 {{ scanPending }}</span>
                        <n-button size="small" :disabled="cancelling" @click="onScanCancel">
                            {{ cancelling ? '正在取消…' : '取消' }}
                        </n-button>
                        <span v-if="cancelling" class="scan-hint">当前这个目录扫完就停</span>
                    </template>
                </div>
            </div>
        </Transition>
        <!-- 「这个封面下有哪几个文件」那一层。
             ⚠️ 键盘进出全靠**焦点**，不是靠额外的守卫分支：
             `isGridKeyBlocked` 的 `e.target !== document.body` 在焦点落在某一项上时
             自动为真 ⇒ 网格的方向键监听收不到事件，**两个选择器不会打架**。
             而这一层若不给焦点，网格方向键就会穿透进来（用户以为在网格里按了方向键，
             结果焦点还停在一个看得见却没焦点的弹层上）。
             两条都是**必做项**，少任何一条键盘就失灵。-->
        <n-popover :show="popover.visible" :x="popover.x" :y="popover.y" trigger="manual" placement="bottom"
            @clickoutside="closeFileList">
            <!-- 同理换掉 n-space：这里 v-for 的是文件列表，个数天生会变 -->
            <div class="hstack file-list" tabindex="-1" ref="fileListBox" @keydown.stop="onFileListKeydown">
                <div v-for="(f, i) in popover.files" class="file-item" :class="{ 'file-cursor': i === fileCursor }"
                    :key="f.name" @dblclick="openFile(f.name)" :title="f.name + ` ${getSize(f.size) || ''}`">
                    <!-- 类型图标（`.file-cover` + fiv）。**必须带上 `fiv-cla fiv-icon-*`** ——
                         漏掉后半截时它只剩 `blank.svg` 且没有尺寸 ⇒ 高 0、等于没画，
                         整个条目就变成"一大块空白 + 一行截断的名字"（2026-10-05 业主报的丑） -->
                    <div class="file-cover fiv-cla" :class="`fiv-icon-${extOf(f.name)}`" aria-hidden="true"></div>
                    <span>{{ f.name }}</span>
                    <!-- 大小用 `<i>`：`.file-item span` 那条规则会吃掉 `span` -->
                    <i class="file-size">{{ getSize(f.size) }}</i>
                </div>
            </div>
        </n-popover>
        <n-popover :show="ctxMenu.visible" :x="ctxMenu.x" :y="ctxMenu.y" trigger="manual" placement="bottom-start"
            :show-arrow="false" @clickoutside="closeCtxMenu">
            <!-- 2026-11-09 重构：横排小按钮 → Apple 式纵向菜单（图标+标签+分组发丝线）。
                 内容被 n-popover teleport 到 body ⇒ 样式走文件末尾的非 scoped 块（.ctx-*）。 -->
            <div class="ctx-menu" tabindex="-1" @keydown.stop="onCtxMenuKeydown">
                <!-- 文件组：只有卡片右键才有（空白处没有"这一张"）。
                     只读层（锚点路径）没有真磁盘路径 ⇒ 复制地址/打开文件夹禁用。 -->
                <template v-if="ctxMenu.mode === 'card'">
                    <button type="button" class="ctx-item" @click="copyNameStem">
                        <n-icon :size="16" :component="CopyOutline" />
                        <span class="ctx-label">复制文件名</span>
                    </button>
                    <button type="button" class="ctx-item" :disabled="!!readOnlyLevel" @click="copyPath">
                        <n-icon :size="16" :component="LinkOutline" />
                        <span class="ctx-label">复制文件地址</span>
                    </button>
                    <button type="button" class="ctx-item" :disabled="!!readOnlyLevel" @click="revealInFolder">
                        <n-icon :size="16" :component="FolderOpenOutline" />
                        <span class="ctx-label">打开所在文件夹</span>
                    </button>
                    <div class="ctx-sep" aria-hidden="true"></div>
                    <!-- 收录组：同一个菜单位置，两种模式——清单屏 = 移除；目录屏 = 加入。
                         模式判据读 playlistLevel（NavEntry.pl 派生），不读 path 前缀。 -->
                    <button v-if="playlistLevel" type="button" class="ctx-item" @click="removeFromCurrentPlaylist">
                        <n-icon :size="16" :component="StarOutline" />
                        <span class="ctx-label">从收藏夹移除</span>
                    </button>
                    <template v-else>
                        <button type="button" class="ctx-item" @click="addToFavorite">
                            <n-icon :size="16" :component="StarOutline" />
                            <span class="ctx-label">加入收藏</span>
                        </button>
                        <button type="button" class="ctx-item" @click="openPlPicker">
                            <n-icon :size="16" :component="StarOutline" />
                            <span class="ctx-label">加入收藏夹…</span>
                            <n-icon :size="14" :component="ChevronForwardOutline" class="ctx-arrow" />
                        </button>
                    </template>
                    <div class="ctx-sep" aria-hidden="true"></div>
                </template>
                <!-- 目录工具组：卡片/空白两处都有，与「更多」下拉共用同一份 DIR_ACTIONS -->
                <button v-for="a in dirActions" :key="a.key" type="button" class="ctx-item"
                    :disabled="a.disabled" @click="runDirAction(a.key)">
                    <n-icon :size="16" :component="a.icon" />
                    <span class="ctx-label">{{ a.label }}</span>
                </button>
                <!-- 导航组：只此一条，单独一组压在末尾（2026-11-10 业主裁决：清空导航住右键菜单）。
                     为什么不并进上面的目录工具组：那一组是"这一层的工具"（可反复做）；
                     清空重置的是**视图状态**、不删任何数据 ⇒ 不加确认（业主同日裁决）。
                     判据 `hasAny` = 有没有走过路；扫描 / 挑封面期间也禁掉 ——
                     那两种状态下清空会把正在进行的活儿的舞台抽走（选中的格子还在、但看不见了）。 -->
                <div class="ctx-sep" aria-hidden="true"></div>
                <button type="button" class="ctx-item" :disabled="!hasAny || scanning || picking"
                    @click="onCtxClearNav">
                    <n-icon :size="16" :component="CloseOutline" />
                    <span class="ctx-label">清空导航历史</span>
                </button>
            </div>
        </n-popover>
        <!-- 「加入收藏夹…」选单：右键菜单的第二级，原地展开在同一坐标（同 submenu 手势） -->
        <n-popover :show="plPicker.visible" :x="plPicker.x" :y="plPicker.y" trigger="manual" placement="bottom-start"
            @clickoutside="plPicker.visible = false">
            <PlaylistPicker v-if="plPicker.card" :card="plPicker.card" :item-key="plPicker.key" @added="onPickerAdded"
                @failed="onPickerFailed" />
        </n-popover>
        <!-- ⚠️ `src-list` 绑的是 `usePreview` 里的**快照 ref**（打开预览那一刻拍一张），
             不是实时 computed —— 预览关着时不必扫整屏三遍（换屏 / 每次按键都省）。
             ⚠️⚠️ 但**关的时候绝不能清空**：naive 在淡出那 0.2s 里还要按 `current` 算图，
             空列表 ⇒ `src=undefined` ⇒ 原生裂图（2026-11-10 踩回来的坑，见 `previewSrcList` 的注释）。 -->
        <n-image-group :src-list="previewSrcList" :current="previewIndex" :show="previewOpen"
            :render-toolbar="previewToolbar" @update:show="onPreviewShowChange"
            @update:current="onPreviewCurrentChange" />
        <!-- 清单 / 缓存 / 站点规则 2026-10-21 起是**独立页**（左轨切换），不再挂在这里。
             ⚠️ 别再往这个文件里塞页级弹窗 —— 判据见 docs/DESIGN-BILIBILI-2026-10-21.md： -->
        <AssistantCoverModal ref="assistantModal" @refresh="refreshAfterApply" />
        <AssistantAvatarModal v-model:show="showAvatarModal" :current-path="currentPath" @applied="refreshAfterApply" />
    </div>
</template>

<script setup lang="ts">
import { formatBytes, ancestorsOf, isGridKeyBlocked, ANCHOR_PREFIX } from '@/utils';
import type { PathCrumb } from '@/utils';
import type { Component } from 'vue';
import { API_BASE, apiUrl, getAction } from '@/utils/request';
import { useContextMenu } from './useContextMenu';
import { useFileListPopover } from './useFileListPopover';
import { useScanFlow } from './useScanFlow';
import { usePickMode } from './usePickMode';
import { useSearchSlot } from './useSearchSlot';
import { useScreenData } from './useScreenData';
import { filterByName } from './filterByName';
import { buildMemberMap, playlistIndex, refreshIndex } from './playlist';
import type { CardSnapshot } from '../../../electron/server/playlist';
import folderIcon from '@/assets/fileTypeIcon/folder.png';
import useNotify from '@/hooks/useNotify';
import useConfirm from '@/hooks/useConfirm';
import Banner from '@/components/Overlay/Banner.vue';
import { usePreview } from './usePreview';
import { useGridCursor } from './useGridCursor';
import GridDensityMenu from './GridDensityMenu.vue';
import GalaxyLoadingBar from '@/components/GalaxyLoadingBar/index.vue';
// 预览层 / 右键菜单 / 面包屑过渡的全局样式（DOM 被 teleport 或由 naive 渲染，scoped 够不到）
import './preview-bar.css';
import './ctx-menu.css';
import './crumb-motion.css';
import { colsOf, loadDensity, saveDensity } from './density';
import type { Density } from './density';
import { buildCrumbLayout } from './crumbRows';
import { useNavStack } from './useNavStack';
import type { NavEntry } from './useNavStack';
import { dissolveGrid } from './gridDissolve';
import { decideOpen, isMultiFileCard } from './openDecision';
import { SearchOutline, RefreshOutline, SyncOutline, ArrowBackOutline, ArrowForwardOutline, CloseOutline, CopyOutline, StarOutline, ChevronForwardOutline, LinkOutline, FolderOpenOutline, CloudDownloadOutline, ImageOutline, PersonOutline, SettingsOutline, ImagesOutline } from '@vicons/ionicons5';
import { MoreVertical28Filled } from '@/components/icons/fluent';
import { FlatCards24 } from '@/components/icons/grid';
import { playSfx } from '@/utils/sfx';
import { NButton, NInput, NIcon, NImage, NImageGroup, NTag, NPopover, NSpin, NDropdown } from 'naive-ui';
import FolderSelector from '@/components/FolderSelector/index.vue';
import ScanGlow from './ScanGlow.vue';
import AssistantCoverModal from './AssistantCoverModal.vue';
import AssistantAvatarModal from './AssistantAvatarModal.vue';
import PlaylistPicker from './PlaylistPicker.vue';
import { consumeTarget } from './target';
import { useRouter } from 'vue-router';
import { ipcRenderer } from 'electron';
import { computed, nextTick, onActivated, onDeactivated, onMounted, onUnmounted, provide, ref, watch } from 'vue';
import type { WiredFileInfo } from '../../../electron/server/index';
import type { OpenMode } from 'electron/server/nedb';
/**
 * ⚠️ naive-ui 内部路径（深导入）。为什么非要用它：预览层由 `n-image-group` 渲染，
 * 而 `previewedImgProps`（"铺满视口" + "双击穿透给下面那张卡片"）**只从 `imageContext` 取**，
 * 而 naive-ui **没有给 group 留这个 prop** ⇒ 在本组件 `provide` 一次就能喂到它
 * （父链 `ImagePreview ← ImageGroup ← 本组件`）。合法性：naive-ui `package.json`
 * **没有 `exports` 字段**（实测）⇒ 深路径可导入；风险：升版本可能改路径，当前 pin 2.45.3。
 * ⚠️ 路径**必须带 `.mjs`**：本项目 `resolve.extensions` 没有 `.mjs` ⇒ 不带连 dev 都解析不了。
 */
import { imageContextKey } from 'naive-ui/es/image/src/interface.mjs';

// 与 electron/server/videoExt.ts 的 VIDEO_EXT 保持一致（渲染层不能 import server，保留正则副本）。
// 改了 videoExt.ts 这里要同步改。
const VIDEO_EXT_RE = /\.(mp4|mkv|avi|wmv|flv|mpeg|m4v|mov|mpg|ts|m2ts|mts|webm|ogv|3gp)$/i;

/**
 * 清单详情屏的路径前缀（2026-10-21 收藏分类）。与 `#`（只读锚点）同族：
 * 都不是磁盘上的真实路径。身份信息在 `NavEntry.pl` 上，path 只作寻址与面包屑显示。
 */
const PL_PREFIX = '@pl:';

/**
 * 缩略图按需取，不再内嵌进 /openFolder 的响应里。
 * 渲染层拿到的是个短 key，图走 /thumb —— 一个目录的响应体因此从几百 KB 降到几十 KB，
 * 而且 `loading="lazy"` 只让真正进入视口的那些发请求（2026-11-10 起是原生懒加载）。
 *
 * ⚠️ 带缓存：它在模板里**每条目每次全量渲染**都要算一遍（换屏、每次按键过滤），
 * 而 `encodeURIComponent` 是逐字符扫描 ⇒ 平铺 5000 条就是 5000 次。
 * 键是 `sig` 派生的短串，同一屏反复渲染时命中率 100%，缓存表几百条量级。
 * ⚠️ 缓存整条 URL 是安全的：`API_BASE` 是常量、`TOKEN` 在模块加载时由 sendSync 一次取定
 * （两者都不会在运行中变）⇒ 不会出现"缓存了旧端口/旧口令"导致裂图。
 */
const thumbUrlCache = new Map<string, string>();
const thumbUrl = (key?: string) => {
    if (!key) return '';
    const hit = thumbUrlCache.get(key);
    if (hit) return hit;
    const url = apiUrl(`${API_BASE}/thumb?k=${encodeURIComponent(key)}`);
    if (thumbUrlCache.size > 4096) thumbUrlCache.clear();    // 有界：满了整表丢，不做淘汰算法
    thumbUrlCache.set(key, url);
    return url;
};

/**
 * 条目的真实文件名。
 *
 * `item.name` 是**显示名** —— 封面条目取的是封面图文件名（不含扩展名），目录取目录名。
 * 所以还原磁盘上的名字必须带上 ext；而 ext 可能为空（没有扩展名的文件、目录），
 * 那就不能再补那个点了，否则 "README" 会变成 "README."。
 */
const fileNameOf = (item: WiredFileInfo) => (item.ext ? `${item.name}.${item.ext}` : item.name);

/** 条目在磁盘上的完整路径。dir 是服务端补过当前盘符的完整目录 */
const fullPathOf = (item: WiredFileInfo) => `${item.dir}/${fileNameOf(item)}`;

/**
 * 预览大图的地址。
 *
 * 服务端那个 `/preview` 出口有三种情形（见 server/index.ts 的 previewController）：
 * 本地已有 → 直接给（0 读盘）；本地没有但给了源路径 `p` → **读一次原图、生成、落盘**；
 * 都没有 → 404。
 *
 * 所以这里只在**该给 `p` 的时候**给：
 *   · 视频**永远不给** —— 它的"图"是抽帧，而且在扫描那一刻就已经生成好了；
 *     真给 `p` 就等于让浏览器去 GET 一个 5–7GB 的原片（第一目标严禁）。
 *   · 离线（只读层）不给 —— 地址是锚点，服务端读不了；给了只会白跑一次。
 */
const previewUrlOf = (item: WiredFileInfo) => {
    if (!item.preview) return '';
    const q = `k=${encodeURIComponent(item.preview)}`;
    // ⚠️ 2026-10-21（清单功能）从屏幕级 `readOnlyLevel` 改成**条目级** `isReadOnlyPath(item.dir)`：
    // 清单详情屏是在线/离线**混合屏**（每条目的盘在不在各自独立），屏幕级判据会把
    // 在线条目的图也当成"生成不了"。
    // 在原有两类屏幕上两者等价（在线屏所有 dir 都是实时路径、只读屏全是锚点）⇒ 行为不变。
    const canBuild = !item.previewReady && item.type === 'image' && !isReadOnlyPath(item.dir);
    return apiUrl(`${API_BASE}/preview?${q}${canBuild ? `&p=${encodeURIComponent(fullPathOf(item))}` : ''}`);
};

/**
 * 条目的身份。与网格那一格的 `:key`、`:data-key`、预览序列**同源** ——
 * 「定位」就是靠它把预览里的这一条对回网格里的那一格。
 * `dir` 是条目**自己所在**的目录（封面条目取的是那个子目录，见 server 的 handleCover）
 * ⇒ (dir, name) 唯一，同一层的两个子目录各有一张同名封面也不会撞。
 */
const keyOf = (item: WiredFileInfo) => `${item.dir}/${item.name}`;

/**
 * 预览层**立刻**显示的那张 —— 与网格里那张卡片**逐条同一规则**（"卡片的大图版"）：
 *   图片 / 视频 → 它自己的缩略图；目录 → 它的脸，没有脸就是文件夹图标。
 * 这些都是**本地已有**的图（缩略图在主进程内存/bin 里、浏览器也缓存着）⇒ 打开是瞬时的、零读盘。
 * 其他文件不参与序列（原因见 `previewEntries`）。
 */
const displaySrcOf = (item: WiredFileInfo) => {
    if (item.type === 'folder') return item.avatar ? thumbUrl(item.avatar) : folderIcon;
    return thumbUrl(item.thumb);
};

// ── 预览层（上一条/下一条 + 定位 + 渐进清晰）────────────────────────────────
// ⚠️ 调用点必须在下面 `fileList` / `picking` / `imageBox` 三个声明之后 —— 依赖没准备好就
//    传进去，composable 拿到的是空壳。真正的声明位置见文件下方「预览域接线」处。
// ⚠️ `previewedImgProps` 必须由本组件 provide 进 `imageContextKey` —— 预览层由
//    `n-image-group` 渲染，父链是 `ImagePreview ← ImageGroup ← 本组件`，
//    而 naive-ui 没给 group 留 `previewed-img-props` 这个 prop。

const dir = ref('');
/** 本页是不是在前台（KeepAlive 缓存后仍挂着 window 监听，键盘必须靠它收口） */
const pageActive = ref(true);
const router = useRouter();
const assistantModal = ref<typeof AssistantCoverModal | null>(null)
const showAvatarModal = ref(false);
/**
 * 「这个封面下有哪几个文件」弹层 —— 状态 / 定位 / 键盘都在 useFileListPopover 里。
 * ⚠️ openFile 反过来要读 popover.cover 算父目录，所以用闭包传它：
 *    此刻 openFile 还没声明，直接传值会当场 TDZ。
 */
const { popover, fileCursor, fileListBox, openFileList, closeFileList, onFileListKeydown } =
    useFileListPopover({
        isMultiFileCard,
        openFile: (name) => { void openFile(name); },
    });

/**
 * 顶栏搜索槽（过滤词 / 展开态 / 聚焦时机）—— 见 useSearchSlot.ts。
 * ⚠️ 不变量：收起 ⇒ 一定没有过滤词（否则网格会"莫名少一半"）。
 */
const { searchText, searchOpen, searchSlot, searchInput, openSearch, onSearchFocus, onSearchBlur, blurSearch } =
    useSearchSlot();

const imageBox = ref<HTMLDivElement | null>(null)
const folderSelector = ref<typeof FolderSelector | null>(null);
const dataSource = ref<WiredFileInfo[]>([]);
/**
 * 过滤视图。**派生**出来，不给任何人写权限。
 *
 * 原来 `fileList` 是个 ref，由两处分别写：`fetchFolder`（异步，写整份数据）和
 * `handleFilter`（同步，写过滤结果）。导航时的顺序是"先 handleFilter 再等响应"，
 * 响应回来 `fileList = data` 会把过滤结果冲掉 —— 搜索框里还留着词，列表已经变成全部了。
 * 改成 computed 之后它没有任何写入口，这类时序 bug 在结构上就不可能存在。
 */
const fileList = computed(() => filterByName(dataSource.value, searchText.value));
/**
 * 导航的**唯一状态**：历史（去过哪些屏）+ 游标。模型在 `useNavStack.ts`，本页只消费。
 * 为什么不留 `name`：面包屑的文字由 `ancestorsOf(currentPath)` 给（见 utils），
 * 一份数据只留一个来源。
 *
 * ⚠️ `snapshot` 传**函数**：`scrollY` 要读容器 DOM、另两样是本页的 ref，
 * 而本行的位置比 `cursorKey`（`useGridCursor` 那块，在文件后半）更靠前 ——
 * 传值会当场 TDZ。它在"离开某一屏那一刻"才求值。
 */
const nav = useNavStack({
    snapshot: () => ({
        scrollY: imageBox.value?.scrollTop ?? 0,
        searchText: searchText.value,
        cursorKey: cursorKey.value,
    }),
});
/**
 * ⚠️ 模板**不会**解包 `nav.canBack` 这种成员访问：`:disabled="!nav.canBack"` 里
 * `!ComputedRef` 恒为 false ⇒ 两颗按钮永远置灰。所以模板只读下面这三个顶层名
 *（顶层 ref 才会被 `<script setup>` 展开）；脚本里仍然用 `nav.step()` 那一组方法。
 */
const { canBack, canForward, hasAny } = nav;
/**
 * 当前这一屏的路径 —— 「位置」的一切都从它派生。
 * 因为它就是路径本身，所以**不可能**和界面显示的位置不一致（不存状态 ⇒ 不会不一致）。
 */
const currentPath = computed(() => nav.current.value?.path ?? '');
/** 面包屑：从起点到当前的完整链。**纯推导** ⇒ 跳转后自动正确，不需要任何同步代码。 */
const crumbs = computed(() => {
    // 清单屏：面包屑是「清单 / 名称」两段，不是磁盘路径 —— ancestorsOf 会把
    // `@pl:` 当 UNC 拆成物理上不存在的层级。根段不可点（点它开货架，见 onCrumbClick）。
    const top = nav.current.value;
    if (top?.pl) {
        return [
            { name: '收藏', path: '', kind: 'root' as const },
            { name: top.pl.name, path: top.path, kind: 'dir' as const },
        ];
    }
    return ancestorsOf(currentPath.value);
});
/**
 * 平铺视图（Flat 模式）：**从当前这一层向下**摊开所有作品，跳过中间的女优/分类目录。
 *
 * ⚠️ 2026-11-10 放开限制（业主：原来"只许盘根开"很难用）：任意层级都能开。
 * 服务端 `findSubtreeLeafItems` 本来就是"从传入路径向下合并**已缓存**的子树叶子"，
 * 纯内存零读盘 ⇒ 原来那道 `isCacheRoot` 闸门只是限制，不是保护，已连同 `/isCacheRoot`
 * 整个端点一起删掉（前提消失的死代码不留）。
 * ⚠️ 平铺只摊**缓存里已经有的**：没扫过的深层会是空的 —— 那是缓存态，不是 bug。
 */
const isFlatView = ref(false);
/** 除清单屏外（清单不是目录，没有"向下"这回事）都允许切平铺；有没有路径也算判据 */
const canToggleFlat = computed(() => !playlistLevel.value && !!currentPath.value);
/**
 * 面包屑的**渲染布局**（head + tail）。
 *
 * ⚠️ 2026-11-10：**不再折叠**（原 `foldCrumbList(crumbs, max = 4)`，第 5 段起折成
 * `盘符 › … › 当前`）。判据从"段数常量"撤掉的理由写在模板 `.crumbs` 那段；
 * 放不下由 CSS 逐段省略兜底，`foldCrumbList` / `buildCrumbLayout` 的 fold 形参仍在
 * （纯函数、有探针），只是这里不再传。
 *
 * ⚠️ 2026-11-08：原来模板里是 `v-if="crumbFold"` / `v-else` 两棵互斥的树，
 * 阈值一跨整棵子树被销毁重建 ⇒ 观感是"整排地址重新渲染"。
 * 推导逻辑在 `crumbRows.ts`（纯函数，可被 `docs/probes/crumbs/layout.mjs` 直接跑）。
 */
const crumbLayout = computed(() => buildCrumbLayout(crumbs.value));
/**
 * 离场那一格的"幽灵"：把它**钉在最后的屏幕位置上**，再交给 CSS 淡出。
 *
 * 为什么需要它（两条硬约束同时成立，缺一条就变形）：
 * ① **必须脱离文档流** —— 留着占位的话整排在这 180ms 里一动不动、结束时一帧塌回去，
 *    Vue 的 FLIP 也只在 `onUpdated` 量一次位移 ⇒ 一帧都滑不出来（第二轮踩过）。
 * ② **必须位置钉死** —— `position: absolute` 单独撤出时，flex 容器里的绝对定位子项
 *    静态位置按"它是唯一的 flex 项"算 ⇒ 元素会瞬移到内容区最左边（第二轮也踩过）。
 * 所以：在 `before-leave`（此刻元素还在文档流里、rect 是真的）抄一份几何，
 * 再用绝对定位钉回原位。定位祖先 = `el.parentElement` = 内层 `.crumbs`（它有 `position: relative`）；
 * 外层 `.nav-zone` 只是"那块面"并负责装进度画布，别把两者记混。
 *
 * ⚠️ 用 `absolute` + 自己算偏移，不用 `fixed`：fixed 的坐标系会被祖先的
 * transform / filter 改写。
 * ⚠️ 必须显式 `box-sizing: border-box`：本项目**没有**全局 box-sizing reset，
 * 而抄来的 width 是 border-box 尺寸 —— 不声明的话幽灵会胖出一圈 padding。
 */
const pinLeaving = (el: Element) => {
    if (!(el instanceof HTMLElement)) return;
    const zone = el.parentElement;
    if (!zone) return;
    const r = el.getBoundingClientRect();
    const z = zone.getBoundingClientRect();
    /* ⚠️ 2026-11-08：槽有了 1px 边框之后，两个 rect 的**原点不是同一个**——
       绝对定位的坐标系是**padding box**（边框之内），而 `getBoundingClientRect()`
       给的是 border box（边框之外）⇒ 不减这一下，幽灵会整体偏 1px 右 + 1px 下，
       在一段 200ms 的淡出里就是"刚离开就抖了一下"。 */
    const bs = getComputedStyle(zone);
    const bx = parseFloat(bs.borderLeftWidth) || 0;
    const by = parseFloat(bs.borderTopWidth) || 0;
    const s = el.style;
    s.boxSizing = 'border-box';
    s.position = 'absolute';
    s.left = `${r.left - z.left - bx}px`;
    s.top = `${r.top - z.top - by}px`;
    s.width = `${r.width}px`;
    s.height = `${r.height}px`;
    s.margin = '0';
    /* 摘掉角标：新的当前段正在原地淡入一个同款角标，不摘的话会并排出现两个红胶囊
       （探针截图 `shot-leave-90ms.png` 第一版就是这样：`videos 35 35`）。
       ⚠️ 不用 CSS 去盖：`.crumb-current[data-count]::after` 在 **scoped** 块里，
       编译后多挂一个 `[data-v-*]` 属性选择器 ⇒ 非 scoped 块里怎么写都打不过它
       （除非上 `!important`）。摘属性是零特异性纠纷的写法。 */
    el.removeAttribute('data-count');
};
/**
 * 面包屑**当前段**上的条目数角标。
 *
 * 量的是什么与原来挂在工具条上的那个 `n-badge` **逐字相同**（`fileList.length`）——
 * 本次只换位置。返回 `null` 时绑定不渲染该属性，CSS 那边也就不会画角标
 * （等价于原来的 `v-if="fileList.length"`；用属性有没有来选择，就不用再判一次大小）。
 */
const crumbCount = computed(() => fileList.value.length || null);
const loading = ref(false);
/**
 * 正在双击打开的那一条（`keyOf` 的值）。空串 = 没在开。
 * 只在只读层置位——只有它有 API 调用；普通双击是纯 IPC，加了反而是噪声。
 * 存 key 不存 boolean：转的是被点那张卡片，且连点两张时各自转各自的。
 */
const opening = ref('');
/** 打开请求序号。只有「最新那次」有权清 `opening`（否则旧请求回来会关掉新请求的转圈）。 */
let openSeq = 0;
/**
 * 上一次取数失败的**分类**。空串 = 没失败。
 *
 * 为什么要分类：失败原来只有一个「打开失败」的 toast，而它会自己消失 ——
 * 用户对着一片空白，分不清是「盘被拔了」（他能自己解决：插回去）
 * 还是「读不到」（只能等）。分类来自服务端（`kind` → `ApiError.kind`），
 * **不是** match 错误文案，所以文案怎么改都不会让这里判别错。
 */
const failKind = ref('');

/**
 * 上一次取数是不是失败了。**由 `failKind` 派生** —— 两个各自赋值的变量迟早会不一致。
 *
 * 留着它只为了一件事：**别让空状态替失败背锅**。目录真的空、搜索没匹配到、请求失败，
 * 这三种情况在界面上本来长得一模一样（一片空白）。前两种该给文字提示，
 * 第三种已经有错误通知了（见 fetchFolder 的 catch），空白处再写一句"这个目录是空的"
 * 就是**在骗人**。所以失败时必须把它排除掉。
 */
const loadFailed = computed(() => failKind.value !== '');
/**
 * 空状态提示。空串 = 不显示。
 *
 * 顺序即优先级：搜索没匹配到排在最前 —— 那是用户自己敲了字、结果什么都没有，
 * 最容易以为程序坏了的情况。
 */
const emptyTip = computed(() => {
    if (loading.value || loadFailed.value || fileList.value.length) return '';
    if (searchText.value) return '没找到匹配的内容';
    /**
     * "有没有进入浏览"要用**当下事实**（有没有一屏），不能用 `dir`（那只是"曾经选过根"的快照）。
     * ⚠️ 这一条是自查 S-1 的回归防护：从缓存跳转**不再写 `dir`**，
     * 冷启动直接跳进一个空目录时，用 `dir` 判断会让提示不显示 —— 一片空白、什么都不说。
     *
     * ⚠️ 而"一屏都没有" ≠ "空目录"：那种情况当前**压根没有目录**，
     * 沿用下面那句"这个目录是空的"就是骗人（`loadFailed` 那条注释讲的是同一件事）。
     * 但它同样不该什么都不说 —— 2026-10-05 加了「清空」之后，这条路径是**用户主动点出来**的，
     * 落在纯空白页上会像是把程序点坏了 ⇒ 给"下一步做什么"。
     */
    if (!hasAny.value) return '还没选文件夹 —— 点左上角那个图标选一个';
    // 清单屏的空态说的是另一件事：不是"目录里没东西"，是"还没收录过"，
    // 且要告诉用户下一步做什么（照 emptyTip 的既有原则：空态给动作，不给空白）
    if (playlistLevel.value) return '这个收藏夹还是空的 —— 在网格里右键卡片「加入收藏」即可收录';
    // 平铺摊的是**缓存里已有的**子树（纯内存、零读盘）⇒ 深层没扫过时"空"是缓存态，
    // 不是"这个目录空"。不说清就成了"程序把东西弄丢了"，所以要给下一步动作。
    if (isFlatView.value) return '这一层下面还没扫到作品（平铺只摊缓存里已有的）';
    return '这个目录是空的';
});

/**
 * 当前这一层是不是**只读层**（盘不在，看的是缓存）。
 *
 * 判据只是路径前缀 `#` —— 那是服务端给离线盘的「只读锚点」（`#序列号/盘内路径`，
 * 见 `electron/server/index.ts` 的 ANCHOR_PREFIX）。为什么不额外传一个状态字段：
 * 导航栈里流动的只有 `path` 这一个字符串（面包屑、双击下钻、返回全靠它），
 * 锚点自带这个信息 —— 两边就不会出现"状态说在线、地址却是锚点"这种不一致。
 * 渲染层不解析锚点内容，只认这一个前缀。
 */
const isReadOnlyPath = (path: string) => path.startsWith(ANCHOR_PREFIX);

/** 只看栈顶那一层：用户眼下看到的这屏是不是只读的 */
const readOnlyLevel = computed(() => isReadOnlyPath(currentPath.value));

/**
 * 当前这一屏是不是**清单详情屏**（2026-10-21 收藏分类）。
 *
 * 与 `readOnlyLevel` 并列的另一种"静态屏"：没有盘可重读、没有缓存可重取
 * ⇒ 刷新/重读/补封面那一族动作全部禁用（同只读层的处理）。
 * 判据看 `NavEntry.pl`（导航栈里的显式标记）而不是解析 path 前缀 ——
 * 栈里流动的只有 path 一个字符串，清单屏的身份跟着 entry 走，两边不会不一致。
 */
const playlistLevel = computed(() => !!nav.current.value?.pl);

/**
 * 已收录进**任意**清单的卡片 key 集合 —— 网格左上角星标用。
 * 由收录索引（playlist.ts 的模块级单一状态源）派生：插拔盘时索引随
 * `ff-disks-changed` 刷新，星标自动跟着翻，不需要任何同步代码。
 */
const plMember = computed(() => buildMemberMap(playlistIndex().playlists));

/**
 * 失败横幅的内容。`text` 为空 = 不显示。
 *
 * 返回空对象而不是 `null`：模板里的 `v-if` 收窄不了 computed 的类型，
 * 用"有没有文案"当开关既躲开 `banner.type` 可能为 null 的告警，语义也更直白。
 *
 * 顺序 = 优先级：**失败先说**（"该有内容却读不到"比"这是只读视图"更急），
 * 然后是只读说明。只读那条不是失败，别和失败混成一件事。
 *
 * 三句话都**告诉用户下一步做什么**：盘不在他自己能解决（插回去按 F5），
 * 读不到只能等，没缓存过就插上盘重扫。只说一句"失败了"等于没说。
 */
const banner = computed(() => {
    if (failKind.value === 'offline') {
        return { type: 'warning' as const, text: '移动硬盘不在（被拔出或还没就绪）—— 插好后按 F5 重读' };
    }
    if (failKind.value === 'unreadable') {
        return { type: 'error' as const, text: '这个文件夹读不到（可能被占用或权限不足）—— 稍后再试' };
    }
    if (failKind.value === 'notFound') {
        return { type: 'error' as const, text: '文件夹已在磁盘上被删除，已自动清理该缓存记录' };
    }
    // 只读层才会出现：当时没扫到过这一层。只读视图不会为了它去碰盘 —— 那是"只读"的定义
    if (failKind.value === 'notCached') {
        return { type: 'warning' as const, text: '这一层当时没缓存过 —— 只读视图不去读盘。插上盘按 F5 重新扫这一片' };
    }
    if (readOnlyLevel.value) {
        // ⚠️ 文案跟着 openFile 的修复一起改了：原来写"打不开原文件"，那是**修复前**的行为。
        // 现在只读层在盘插回来之后**可以直接双击打开原文件**（服务端会当场把锚点解析成实时路径），
        // 只有"列表变成实时的"才需要从「缓存记录」重开这一行。
        return { type: 'info' as const, text: '只读视图：这一层显示的是缓存内容（缩略图可用）。插上盘会自动切到实时；在那之前也可以直接双击打开原文件' };
    }
    return { type: 'default' as const, text: '' };
});

const notify = useNotify();
/** 取数三个入口（目录 / 清单 / 统一出口）+ 请求序号 —— 见 useScreenData.ts */
const { fetchFolder, fetchPlaylistItems, loadScreen, getFetchSeq } = useScreenData({
    notify, dataSource, loading, failKind, searchText,
    isFlatView,
});
const dialog = useConfirm();

/**
 * 文件大小 → 人类可读。
 *
 * 改成调用 `@/utils` 的 `formatBytes`（**一处实现**）：原来的实现只到 GB，
 * 而上限是它自己算出来的 `bytes / 1G % 1024` —— **取模**，1.83 TB 会显示成 `850.xxGB`、
 * 2 TB 直接变 `0.00GB`（静默说错数字）。`formatBytes` 支持到 PB，并且 0 显示 `—` 而不是 `0`。
 * 函数名保留不变（不改调用点）。
 */
const getSizeRaw = (size: number | undefined) => formatBytes(size);
/**
 * 同上：`getSize` 在模板里每条目每次全量渲染被调**两次**（`:title` 与角标），
 * 而 `formatBytes` 要循环除 1024 + `toFixed`（字符串格式化）⇒ 5000 条 = 1 万次。
 * 按字节数缓存结果；文件大小重复度不低（同一批转码/同一批截图），命中率可观。
 */
const sizeTextCache = new Map<number, string>();
const getSize = (size: number | undefined) => {
    if (!size || size <= 0) return getSizeRaw(size);         // '—' 那条不占缓存
    const hit = sizeTextCache.get(size);
    if (hit) return hit;
    const text = getSizeRaw(size);
    if (sizeTextCache.size > 2048) sizeTextCache.clear();
    sizeTextCache.set(size, text);
    return text;
};

/**
 * 封面底色：把同一张图放大、模糊、压暗铺在下面。
 *
 * 解决的是"`contain` 必然留白"：封面框固定 16:9，而缩略图比例五花八门，
 * 不裁切就一定有边（原来那些边露出的是 `--ff-fill` 的深灰，看着像卡里有个空洞）。
 * 用图片自己的放大模糊版填底 ⇒ **不裁切、也没有空隙**（B 站/YouTube 竖版封面同一手法）。
 *
 * 走 CSS 变量 + `::before`（见样式块）：不新增 DOM 节点，同一张图命中浏览器缓存、**不额外请求**。
 * 没有图的目录不设这个变量 ⇒ 保持原来的底色 + 文件夹图标。
 *
 * ⚠️⚠️ **2026-11-10 的关键修正：这个变量必须在图片本身加载完之后才写，不能预置。**
 * 原来模板里是 `:style="coverBackdrop(item)"` —— 也就是给**每一张**卡都提前写上
 * `--cover-src: url(...)`。而它是 CSS `background-image`，**背景图没有 `loading="lazy"`**：
 * 样式一解析浏览器就发请求 ⇒ 打开一屏 500 张卡 = **瞬间 500 个 `/thumb`**，
 * 不管它们在不在视口里（业主在 DevTools 网络面板里数出来的）。
 * `<img loading="lazy">` 省下的请求被这一行全部抵消，而且它还多占一份解码内存。
 * ⇒ 现在由 `@load` 把**已经下载完的那张**写回去：字节已在 HTTP 缓存里 ⇒ **零额外请求**；
 *    没进视口的卡连 `<img>` 都不加载，自然也就没有模糊底（那片显示卡片底色，正确）。
 * ⚠️ 直接改 DOM（`style.setProperty`）而不是动响应式状态：一屏几百张卡，每张过一次
 *    重渲染毫无必要；这个变量也没有第二个读者。
 */
const onCoverLoad = (e: Event) => {
    const img = e.target as HTMLImageElement | null;
    // 走 closest：目录的脸是 `n-image`，它的 `<img>` 外面还套一层 `.n-image`
    const cover = img?.closest<HTMLElement>('.card-cover');
    if (!img || !cover) return;
    cover.style.setProperty('--cover-src', `url("${img.currentSrc || img.src}")`);
};

/**
 * 扩展名（小写、不带点）。只有多文件弹层用它选 `fiv-icon-*` 的类型图标 ——
 * 服务端下发的 `files[]` 只带 `name` + `size`（`FileInfoFiles`），没有 ext 字段，
 * 而名字里本来就有。取不到就返回空串 ⇒ `fiv-icon-` 不匹配 ⇒ 兜底 `blank.svg`。
 */
const extOf = (name: string) => (name.includes('.') ? name.split('.').pop()!.toLowerCase() : '');


// ── 清单（收藏分类）· 界面接线 ──────────────────────────────────────────────
// 状态与 API 在 ./playlist.ts（模块级单一状态源，清单页 / 选单 / 星标共读）。
// 清单页本身在 `views/Playlists/index.vue`；这里只负责"点它 → 跳到那一页"。

/**
 * 清单屏的入口（页内）。左轨的「清单」进的是**清单总览页**（另一个路由），
 * 而这个函数进的是**某个清单的详情**（主网格里的一种屏）。
 */
const goPlaylists = () => { void router.push('/playlists'); };

/**
 * 网格条目 → 加入清单用的卡片快照。
 * thumb 取 `thumb || avatar`（同一文件的两个名字，目录卡只有 avatar）——
 * 服务端按自己的命名格式逆运算出指纹：`sig` 不在下发白名单里，前端不碰它。
 */
const snapshotOf = (item: WiredFileInfo): CardSnapshot => ({
    dir: item.dir,
    name: item.name,
    ext: item.ext,
    type: item.type,
    size: item.size,
    thumb: item.thumb || item.avatar,
    files: item.files,
});

/**
 * 重取当前屏 —— 走 `loadScreen` 唯一出口（清单屏原样重取，幂等）。
 * 右键菜单的「从收藏夹移除」和扫描收尾都用它：**一份实现**，别各写一遍。
 */
const reloadCurrentScreen = () => {
    const cur = nav.current.value;
    if (cur) loadScreen(cur);
};

const {
    ctxMenu, plPicker,
    onContextMenu, onBlankContextMenu, onCtxMenuKeydown, closeCtxMenu,
    copyNameStem, copyPath, revealInFolder,
    addToFavorite, openPlPicker, onPickerAdded, onPickerFailed,
    removeFromCurrentPlaylist,
} = useContextMenu({
    notify,
    keyOf,
    snapshotOf,
    fileNameOf,
    fullPathOf,
    // 清单屏才有 pl（NavEntry 派生），非清单屏返回空串 ⇒ 菜单里不出「移除」
    currentPlaylistId: () => nav.current.value?.pl?.id ?? '',
    reloadCurrent: reloadCurrentScreen,
});

/**
 * 「补封面」写盘完成后的刷新。与 onRefresh 的区别：**不带 noCache** ——
 * apply 已经把写过的目录缓存删掉了，正常取数会真读一次盘、把新封面收进来再建缓存；
 * 再带 noCache 等于把刚建的缓存又删一遍重读，纯浪费。
 * 盘不在（只读层）时 apply 根本写不了，不用刷。
 */
const refreshAfterApply = () => {
    const cur = nav.current.value;
    // loadScreen 分派：目录屏重取（apply 只可能发生在目录屏），清单屏原样重取（幂等）
    if (cur && !readOnlyLevel.value) loadScreen(cur);
}

/**
 * 卡片在视口里的中心坐标。**键盘路径专用**（鼠标路径有事件坐标）。
 * 拿不到元素时退回视口中心 —— 宁可弹在中间，也不能不弹。
 */
const cardCenterOf = (item: WiredFileInfo) => {
    const el = imageBox.value?.querySelector<HTMLElement>(
        `.image-box-item[data-key="${CSS.escape(keyOf(item))}"]`,
    );
    const r = el?.getBoundingClientRect();
    return { x: r ? r.left + r.width / 2 : window.innerWidth / 2, y: r ? r.top + r.height / 2 : window.innerHeight / 2 };
};

const handleOpen = (e: MouseEvent, item: WiredFileInfo) => {
    if (loading.value) return;
    if (item.missing) {
        notify('warning', '文件已失效', '该文件已不在原路径或已被删除');
        return;
    }
    if (item.type === 'folder') {
        // 目录的完整路径从 item.dir 拼。**不要用 dir.value** —— 它是"当前选中的根"，
        // 进到子目录之后它还是最初那个，用它会拼出 H:/x/子目录名 这种少一层的路径。
        // item.dir 是服务端给的"条目所在目录"，永远是准的。
        openFolderInCover(`${item.dir}/${item.name}`);
    } else {
        // ⚠️ 双击的判据是 `isMultiFileCard`（`> 1`），**不是** `isDirCard`（`> 0`）。
        // 两者回答不同问题，详见 `openDecision.ts` 里那两个函数的注释。
        // 这里的写法是**既有行为，一个字不改**：单文件目录双击直接打开（不弹层）。
        if (isMultiFileCard(item)) {
            openFileList(item, e.clientX, e.clientY);
        } else {
            openFile(item);
        }
    }
};

/**
 * 回车打开文件的最小间隔（误触保护，主人 2026-11-09 定 2s）：播放器进程起来要一两秒，
 * 期间再按回车 = 又起一个进程。只锁 open-item，不锁目录 drill（导航不能被 2s 卡住）。
 */
const ENTER_OPEN_MIN_MS = 2000;
let lastEnterOpenAt = 0;

/**
 * 网格里按 Enter：只负责派发动作，判据在 openDecision.ts（纯函数，探针与产品共用）。
 * ⚠️ open-item 必须传 item，不能传 item.files[0].name：openFile 字符串分支靠 popover.cover 算父目录，这里没开弹层 cover 是上次残留会开错文件；item 分支"双击封面=打开视频"正为此场景而写。
 */
const onCursorConfirm = (item: WiredFileInfo) => {
    if (picking.value) {
        onItemClick(item);
        return;
    }
    if (loading.value) return;
    const action = decideOpen(item, false);
    switch (action?.kind) {
        case 'missing':
            notify('warning', '文件已失效', '该文件已不在原路径或已被删除');
            return;
        case 'drill':
            openFolderInCover(action.path);
            return;
        case 'open-item': {
            // ⚠️ 误触保护（主人 2026-11-09）：回车连按/惯性双击会在播放器还没起来时又发一次。
            // 只锁「打开文件」这条路 —— 目录的 drill 是导航，不节流（连进两层目录不能等 2s）。
            const now = performance.now();
            if (now - lastEnterOpenAt < ENTER_OPEN_MIN_MS) return;
            lastEnterOpenAt = now;
            openFile(item);
            return;
        }
        case 'pick-from-list': {
            const c = cardCenterOf(item);
            openFileList(item, c.x, c.y);
            return;
        }
        case 'preview':
            openPreview(item);
            return;
    }
};
/**
 * 进入某一屏：所有导航动作都必须从这里过（记旧屏 → 压新屏 → 归零视口 → 取数 → 词跟着数据落地）。
 * ⚠️ "记旧屏"已不在本函数里：它和后退/前进共用 `useNavStack` 的 `snapshot`（一份实现，两个方向都适用），
 * 所以这里只剩 `nav.push()` 一句 —— 别再单独写一遍快照，两份必然漂移。
 * ⚠️ 必须显式归零滚动：NavEntry.scrollY=0 只是数字，容器 scrollTop 不会自己归零 ⇒ 进新屏会停在上一屏的偏移（与面包屑矛盾）。
 * ⚠️ 归零要在取数之前（内容没渲染时 scrollTo 会被 clamp 或作用在旧内容上）。
 */
const enterScreen = (path: string, mode: OpenMode = 'cover', pl?: NavEntry['pl'], keepFlat?: boolean) => {
    // 新的一屏**从零开始**：选择器不继承上一屏的（它属于那一屏，不属于这一屏）
    // pl = 清单屏标记（2026-10-21）：与 path 上的 `@pl:<id>` 前缀同进同退
    // ⚠️ `push` 内部会先拍上一屏的快照，再砍掉"前进尾巴"（在中间位置进新屏的浏览器语义）
    const entry = nav.push({ path, mode, pl, searchText: '', scrollY: 0, cursorKey: '' });
    isFlatView.value = !!keepFlat;
    /**
     * 进新的一屏不带上一屏的搜索词（原有行为，不动）。
     *
     * ⚠️⚠️ 但**不许在这里写 `searchText`**（业主 2026-11-10 报：过滤出的几个文件夹，
     * 点进去等待期间"过滤失效、整份数据闪一下"，抽帧完才进新屏）。原因：
     * `fileList = computed(filterByName(dataSource, searchText))`，而此刻 `dataSource`
     * 还是**上一屏**的数据 ⇒ 提前清词 = 立刻渲染"上一屏整份数据 × 空关键词"。
     * 这段窗口的长度就是**接口的耗时**（含视频抽帧时以秒计）⇒ 不是闪一下，是杵在那儿。
     * ⇒ 词的切换与数据的落地**同一拍**发生，唯一写入点是 `useScreenData.commit()`；
     *   这里只声明"这一屏接管自己的词"（`adoptSearch`）。
     *
     * ⚠️ `noteIntent()`（= 「这一屏需要焦点」）仍必须在**任何会改列表的动作之后**才声明
     * —— 那个 watch 是一次性消费 `armed` 的。现在本函数不再改列表，顺序自然满足；
     * 别再把词的写入搬回来。
     */
    noteIntent();
    /**
     * 视口归零 —— **两处，缺一不可**：
     *① 立刻：否则从第 4000px 进新屏，新屏开头那一大截已经滚过去了
     * ② 取完之后：内容替换时容器高度变化会让偏移漂移，得再压一次
     *
     * ⚠️ **不能塞进 `fetchFolder` 内部**：它有 6 个调用点，其中 `onBack`（恢复旧屏的
     * scrollY）、`onRefresh`、`refreshAfterApply`、`swapTop`（换盘/拔盘）**都不该归零** ——
     * 那几处的视口是"这一屏自己的状态"，归零会把用户正在看的位置抹掉。
     * ⇒ 归零是**导航意图**，属于 `enterScreen` 这一个入口。
     */
    imageBox.value?.scrollTo(0, 0);

    // 取数（内部会 `++fetchSeq`）⇒ **之后**才读序号，读到的才是"我这次"的号
    // 经 loadScreen 分派：目录屏 /openFolder，清单屏 /playlistItems（唯一出口，见那边注释）
    // `adoptSearch`：这一屏的词由它自己接管，与数据**同一拍**落地（理由见上面那段）
    const done = loadScreen(entry, {
        flat: isFlatView.value, adoptSearch: true,
    });
    const myFetchSeq = getFetchSeq();

    /**
     * 视口归零的**第二次**（取数落地后再压一次 —— 内容替换会让偏移漂移）。
     *
     * ⚠️ 判据必须问「**我还是不是最新那次请求**」，而不是「当前栈顶是不是我去的那个路径」。
     * `path` 相等只说明"我和别人去了同一个地方"，不等于"我是最新的"：
     * A→B→A 连点两次时，第一个 A 的响应回来时栈顶也是 A ⇒ path 判据会放行
     * ⇒ 归零把第二次 A 的视口抹掉。
     *
     * 序号由 `getFetchSeq()` 给出（写入口在 useScreenData 里）；必须在 `loadScreen()`
     * **之后**才读，读到的才是"我这次"的号。
     */
    void done.then(() => {
        if (getFetchSeq() !== myFetchSeq) return;   // 已被更新的请求接管 ⇒ 不碰别人的视口
        /**
         * ⚠️ `markShown()`：告诉导航模型"这一屏的数据真的画上去了"。
         * 没有它，连按两次返回时中间那屏会被记上**上一屏**的滚动位与过滤词
         *（取数还在飞、画面还停在旧屏）⇒ 以后前进回来停错高度。理由见 `useNavStack.shown`。
         * 失败时**不许**标记：那时画面仍是上一屏的内容，给它拍快照就是记错人。
         */
        if (!failKind.value) nav.markShown();
        void nextTick(() => imageBox.value?.scrollTo(0, 0));
    });
}

/** 网格双击下钻：进子目录 */
const openFolderInCover = (path: string) => {
    enterScreen(path, 'cover');
}

/**
 * 进清单详情屏。复用 enterScreen 这一个入口（多传一个 pl 标记）——
 * 视口归零 / 历史 / 焦点意图 / 取数序号全部走同一套，不另起一套导航。
 */
const enterPlaylist = (id: string, name: string) => {
    enterScreen(`${PL_PREFIX}${id}`, 'cover', { id, name });
}

/**
 * 到某个目录去，但**保留历史** —— 所以「返回」能回到刚才那一屏（"跳转"因此是可撤销的动作）。
 *
 * 与 `setRoot` 只差一个字：那个是"重新开始"（清空历史），这个是"去别处看看"。
 * 这两件事原来被混在同一个 `handleDirChange` 里（对任何入参都清栈），
 * 正是"从缓存跳转后返回体验怪"的根因。
 */
const jumpTo = (path: string) => {
    enterScreen(path, 'cover');
}

/**
 * 点面包屑的某一段 = 到那个目录去。
 *
 * **压历史，不截断**：位置由路径推导之后，"截断到某个祖先"已经没有对应的东西可截
 * —— 历史里未必有这一段（可能刚从另一块盘跳过来）。而且压栈才能保证**点完还能返回**。
 * （现状是 `slice()` 截断：点完就回不到刚才那一层，这是同一个病的第二处症状。）
 */
const onCrumbClick = (c: PathCrumb) => {
    if (c.kind === 'root') {
        // 磁盘屏的首段依旧不可点（点它会打开盘根，而盘根通常没被缓存过 ⇒ 真读一次盘）。
        // 清单屏的「清单」根段例外：点它开货架 —— 那是回总览的捷径，零读盘。
        if (playlistLevel.value) goPlaylists();
        return;
    }
    if (c.path === currentPath.value) return;   // 当前段是纯文本，点了也不动
    jumpTo(c.path);
}

/**
 * 把「只读锚点」交给服务端换成**此刻**的完整路径。换不到（盘确实不在）返回空串。
 *
 * 为什么必须有它：见 openFile 里那段注释 —— 只有"当下问盘在不在"才能修掉
 * "盘插回来也永远打不开"这个缺陷。判据必须是事实，不能是地址形态。
 *
 * 分工照旧，一行都没越界：**懂锚点的只有服务端**（它才有 serial → 盘符 映射，
 * 渲染层刻意不解析锚点内容）；拿到路径之后"交给系统打开"那一步仍然走主进程（shell.openPath）。
 */
const resolveAnchor = async (anchor: string): Promise<string> => {
    try {
        const data = await getAction(`${API_BASE}/resolveAnchor?path=${encodeURIComponent(anchor)}`);
        return data?.path || '';
    } catch {
        // 盘不在 / 解析不出来 —— 一律走同一条出口（空串），调用方只判一次，
        // 不用在每个调用点各区分一遍 kind（那种写法迟早漏一处）。
        return '';
    }
};

/**
 * 打开一个文件，交给系统默认程序。
 *
 * 这里只负责算出**路径**，然后交给主进程的 `shell.openPath` —— 不再自己拼命令行。
 * 原来这里手工给路径补双引号（还按 `/` 切开、给倒数第二段再包一层），那全是在补救
 * "把路径当命令行传"这个错误的抽象层级，补不完也不该补。现在路径是什么就传什么。
 *
 * 用 invoke 是为了拿到失败信息：原来 exec 失败只 console.log，界面上毫无动静 ——
 * 静默失败正是下面那个 popover 路径 bug 藏了这么久的原因。
 */
const openFile = async (item: WiredFileInfo | string) => {
    let target: string;

    if (typeof item === 'string') {
        // popover 里双击的是封面目录下的某个具体文件。
        // 父目录必须取 cover.dir：那个封面是"子目录收敛"出来的，它的真实父目录比
        // **当前屏的路径（`currentPath`）深一层**。原来用"栈顶路径"拼，会拼出
        // `E:/sample/videos/cover/xxx.mp4` 这种不存在的路径（cover 是封面图名，不是目录名）。
        // ⚠️ 走 `closeFileList()` 而不是直接置 false：它顺带**收回焦点**。
        // 直接置 false 的话，焦点仍留在已被 `v-show` 隐藏的那一项上 ⇒
        // `document.activeElement` 既不是 body 也不是可见元素 ⇒
        // 网格方向键被守卫永久挡住（键盘打开后紧接着按方向键就失灵）。
        closeFileList();
        target = `${popover.value.cover?.dir}/${item}`;
    } else {
        // 目录不走这条路（handleOpen 会把目录交给 openFolderInCover）
        if (item.type === 'folder') return;

        let filename: string;
        if (item.type === 'image') {
            // 双击封面 = 打开里面的视频（保持原有行为）。
            // 但原来取 files[0] 依赖"第一个文件恰好是视频"这个巧合：
            // 目录里若有多余图片（files 按 readdir 顺序，未排序），files[0] 会是图片，打开就错了。
            // 改成显式找视频；找不到再退回 files[0]，最后退回封面自己。
            const video = item.files?.find(f => VIDEO_EXT_RE.test(f.name));
            filename = video?.name || item.files?.[0]?.name || fileNameOf(item);
        } else {
            filename = fileNameOf(item);
        }
        target = `${item.dir}/${filename}`;
    }

    if (!target) return;

    // 只读层的地址是锚点（`#序列号/…`）—— 磁盘上不存在这个路径，不能直接交给 shell
    // （它只会回一句看不懂的"找不到文件"）。但**也不能因此就判成"打不开"**：
    // 锚点只说明"当初扫这一层的时候盘不在"，不代表**现在**不在。
    //
    // 原来这里是无条件拦掉的（notify 一句"只读视图打不开原文件"），于是盘插回来了也永远打不开 ——
    // 因为判据用的是**地址形态**（一个历史快照），而不是**盘此刻在不在**（事实）。
    // 这是设计缺陷，不是配置问题，用户实测反馈的就是它。
    //
    // 正确做法：**在这一刻**问服务端"这个锚点对应的盘现在在不在？在就把实时路径给我"。
    // 解析必须放服务端 —— serial → 盘符 这个映射只有它知道（渲染层刻意不解析锚点内容）。
    // 拿到实时路径之后，"交给系统打开"那一步仍然走主进程，分工一行都没变。
    if (isReadOnlyPath(target)) {
        // 只有这条分支有 API 调用（`resolveAnchor`）⇒ 按「有 API 才加反馈」判据挂转圈。
        // popover 分支（item 是字符串）没有卡片可转 ⇒ 不标记。
        // ⚠️ 序号而非 key：连点两张时，第二次会覆盖 `opening`；若无条件清空，
        // 第一次的 await 返回会把**第二张**的转圈也关掉。
        const my = ++openSeq;
        opening.value = typeof item === 'string' ? '' : keyOf(item);
        const real = await resolveAnchor(target);
        if (my === openSeq) opening.value = '';
        if (!real) {
            notify('warning', '这块盘现在不在',
                '插上盘后重新双击就能打开。列表要变成实时的，从「缓存记录」重新打开这一行。');
            return;
        }
        target = real;
    }

    const err = await ipcRenderer.invoke('openFile', target);
    // openPath 成功返回空串，失败返回错误描述。失败必须说出来
    if (err) notify('error', '打开失败', err);
}

/**
 * 后退 / 前进的**唯一实现** —— 两个方向只差 `delta` 的符号，恢复逻辑一份。
 *
 * 原来这里叫 `onBack`，且第一句是 `history.pop()`：**那一屏当场销毁**，
 * 于是它的 scrollY / 选择器 / 过滤词全没了，"前进"无处可去（2026-11-10 双向导航）。
 * 现在 `nav.step(±1)` 只移动游标，且**在移动前**替"离开的那一屏"拍快照
 * ⇒ 后退与前进天然对称，两个方向不必各写一遍。
 *
 * ⚠️ 越界（栈底 / 尾巴尽头）时 `step` 返回 `undefined`：静默，什么都不做。
 *    不许在这里自己算 `index` 边界 —— 那是模型的事。
 */
const goStep = async (delta: 1 | -1) => {
    const to = nav.step(delta);
    if (!to) return;
    // 恢复这一屏的搜索词 —— **不在这里写**。这是同一个病的方向相反那一半：
    // 提前把词写回去 = 拿**子目录的数据** × **父目录的词** 渲染一次，等数据到了再换。
    // 词与列表必须同一拍 ⇒ 交给 `loadScreen(to, { adoptSearch: true })`，由 `useScreenData.commit()`
    // 在数据落地那一刻一起写（与 `enterScreen` 共用一份实现）。
    //
    // 恢复选择器。⚠️ **必须与scrollY 一起恢复** —— 只恢复滚动会让屏幕停在原来那一屏的
    // 中间、选择器却跳回视口第一行（自相矛盾）。见 `NavEntry.cursorKey` 的注释。
    // 那个 key 若不在这一屏里，DOM 里就找不到那一格 ⇒ `data-cursor` 打不上 ⇒ 不画高亮，
    // 且下面那个指纹 watch 会发现"没有有效焦点" ⇒ 自动落一个到视口第一行。
    //
    // ⚠️⚠️ **必须声明"这一屏需要焦点"**（业主 2026-10-04 真机报"回来就不对，没记住"）。
    // `dataSource` 换新会触发 `useGridCursor` 里的指纹 watch，那个 watch 只在
    // `armed` 为真时才落焦点。而 `armed` 是**一次性**的 —— 进子目录那一刻
    // `noteIntent()` 已经把它消费掉了 ⇒ 走到这里 `armed` 已是 false
    // ⇒ 恢复出来的 key 若不在这屏（DOM 里没有那一格 ⇒ 打不上标记），就**没人补一个焦点**
    // ⇒ 键盘用户在这一屏上完全失能（按方向键会激活，但那得先知道要按方向键）。
    //
    // ⇒ 顺序即依赖：必须在**会引起列表变化**的动作**之后**才声明，
    //    否则会被那个 watch 提前消费掉（同 `enterScreen` 里那条纪律）。
    noteIntent();
    setCursorKey(to.cursorKey);
    /**
     * ⚠️ 记下"我这次请求"的序号 —— 后面两处恢复都要用它挡**过期**的那次
     *（手法照抄 `enterScreen` 的 `myFetchSeq`，不新发明）。
     *
     * 为什么必须有：`waitForGridOf` 的判据是"**数据与 DOM 同屏**"，它回答的是
     * "新内容铺上去了没"，**不回答"这还是不是我要回的那一屏"**。
     * 而它最多等 20 帧（≈300ms），这期间用户完全可能再按一次返回、或点进别的目录
     * ⇒ 判据对着**新屏**成立 ⇒ 把**上一个 `to` 的偏移**滚到**另一屏**上。
     * 序号来源同 `enterScreen`：`getFetchSeq()`，写完 `loadScreen()` 才读。
     */
    const done = loadScreen(to, { adoptSearch: true });
    const myFetchSeq = getFetchSeq();
    await done;
    // 同上（enterScreen 里那段）：只有数据真的落到这一屏，它的快照才作数
    if (getFetchSeq() === myFetchSeq && !failKind.value) nav.markShown();
    /**
     * 恢复滚动位置 —— **无条件执行**，包括恢复成 0（goStep 绕过 enterScreen，
     * 容器偏移会一直带着上一屏的）。归零不用等 DOM；恢复非 0 必须先等新屏铺好
     * （判据见 waitForGridOf），否则旧内容上滚成功、回读还一致，新内容一铺上来白搭。
     */
    const box = imageBox.value;
    if (!box) return;
    if (!to.scrollY) {
        // 过期请求不许碰视口（理由见上面 `myFetchSeq` 那段）
        if (getFetchSeq() !== myFetchSeq) return;
        box.scrollTo(0, 0);
        return;
    }
    const ready = await waitForGridOf(to.path);
    /* ⚠️ **再查一次**：`waitForGridOf` 最多等 20 帧，它本身就是第二个窗口。 */
    if (getFetchSeq() !== myFetchSeq) return;
    if (!ready) {
        // ⚠️ 没就位就**不恢复**（宁可不动，也不要恢复到一个错的位置 ——
        //    那是"看起来恢复了一半"，比不恢复更难判断）。
        //    真的会发生吗：目标屏是**空目录**时（`fileList` 为空）——
        //    那种情况下 `to.scrollY` 本来就该是 0，所以正常不会进这里。
        notify('warning', '这一屏没能定位', `记=${to.scrollY} 现=${box.scrollTop}`);
        return;
    }
    box.scrollTo(0, to.scrollY);
    // 回读确认：**clamp 是静默的**（`scrollTo` 不会报错）⇒ 必须回读。
    // ⚠️ 目标超出新屏内容高度时会被 clamp 到更小 —— 那是**正确行为**
    //（新屏本来就短，恢复不上去），此时补一帧再试一次即可。
    if (Math.abs(box.scrollTop - to.scrollY) > 2) {
        await nextTick();
        box.scrollTo(0, to.scrollY);
    }
}

/** 后退一格（顶栏 ← / Backspace） */
const onBack = () => goStep(-1);
/** 前进一格（顶栏 → / Alt+→） */
const onForward = () => goStep(1);

/**
 * 等新屏真的铺到 DOM 上（goStep 恢复滚动的前置条件）。
 *
 * 判据 = **数据第一条 与 DOM 第一条是同一条**：fetchFolder 只保证数据换新，
 * 那一刻量 scrollHeight 还在旧内容上 —— 而旧内容也能滚到那个位置、回读也一致，
 * 回读确认抓不到。这里用 keyOf 比对，要么成立要么不成立，没有"等几帧"的中间态。
 *
 * ⚠️ 别拿 path 判屏身份：cover 模式会把子目录收敛成封面条目，那些条目的 dir
 *    不是本屏路径 ⇒ 条件恒为 false ⇒ 返回到哪都停在上屏位置（业主实测报过）。
 * ⚠️ 空列表不算就位（没得滚）；先 nextTick 再检查，别写在检查之后。
 */
const waitForGridOf = async (path: string, maxFrames = 20) => {
    void path;   // ⚠️ 形参留着是为了调用点可读（"在等哪一屏"），但**判据不能用它** —— 见下
    for (let i = 0; i < maxFrames; i++) {
        // ⚠️⚠️ **必须先让出一帧再检查**（我第一版把它写在检查之后 ⇒ 一帧都没等就返回了）。
        await nextTick();
        const first = fileList.value[0];
        const el = imageBox.value?.querySelector<HTMLElement>('.image-box-item');
        /**
         * 判据 = 「数据里的第一条」与「DOM 里的第一条」**是同一条**。
         *
         * ⚠️ 进入这里时 `dataSource` **一定已经是新屏**了（`await fetchFolder` 的 then 里设的）
         * ⇒ 所以只要 DOM 跟上了数据，就说明新内容真的铺上去了。
         *
         * ⚠️⚠️ **不要再加 `first.dir === path` 这种"屏身份"校验** —— 我加过，它是错的：
         * `cover` 模式下**子目录会收敛成封面条目**，那些条目的 `dir` 是"封面图所在的目录"，
         * 与"这一屏的路径"**不一定相同**（例如整屏都是收敛出来的目录脸时，`dir` 全都对不上）。
         * ⇒ 那个条件会**永远为 false** ⇒ 恢复分支被跳过 ⇒
         * **返回到哪都停在上一屏的滚动位置**（业主报的"A 返回后停在 B 的高度"）。
         *
         * 孤立证据（探针 `docs/probes/onback-real/` 复现）：
         * `NavEntry` 里记的值是对的（800），但诊断报"未就位" ⇒ 说明问题在判据，不在记录。
         */
        if (first && el && el.dataset.key === keyOf(first)) return true;
    }
    return false;
}

/** 切换正常视图 / Flat 平铺视图（单纯摊开全部作品） */
const toggleFlatView = async () => {
    if (!canToggleFlat.value || scanning.value) return;
    isFlatView.value = !isFlatView.value;
    playSfx(isFlatView.value ? 'switch-on' : 'switch-off');
    const cur = nav.current.value;
    if (cur) {
        await fetchFolder(cur.path, cur.mode, { flat: isFlatView.value });
    }
};

const onRefresh = () => {
    // 只读层没有"重读"这回事：它的源就是缓存，盘不在，F5 也读不出新东西。
    // 拦住而不是让服务端静默回一份缓存 —— 静默最坏（用户以为他重读过了）。
    // 清单屏同理：它的源是系统盘上的收录快照，没有"重读硬盘"这个动作。
    // ⚠️ 判据直接问"有没有当前屏"，不再分开写 `!hasAny` —— `hasAny` 是真值判据，
    //    TS 不会用它收窄 `nav.current.value` ⇒ 那会逼出一处 `cur!`（非空断言掩盖真分支）。
    if (loading.value || readOnlyLevel.value || playlistLevel.value) return;
    const cur = nav.current.value;
    if (!cur) return;
    // F5 = 重新扫盘，要带 noCache 让服务端把这条缓存删掉真去读盘，
    // 不然"刷新"只是把同一份缓存又发了一遍。
    // 搜索词不用管：不带 `search` 就是"同一屏重取" ⇒ 词原样不动（见 useScreenData.commit）
    fetchFolder(cur.path, cur.mode, { noCache: true });
}

/**
 * 换根 / 清空根。**这是唯一"重新开始"的入口**，与「跳转」严格分开：
 * 这里清空历史（你真的换了个地方）；跳转保留历史（你只是去看看，返回随时能回来）。
 * 这两件事原来混在同一个 `handleDirChange` 里，是"返回体验怪"的根因之一。
 */
const setRoot = (value: string) => {
    isFlatView.value = false;
    if (!value) {
        dir.value = '';
        nav.reset();
        // 清掉文件夹选择就该把这个文件夹的内容也清掉，
        // 否则界面上留着上一个目录的东西，而选择框已经空了
        // ⚠️ 这两个写**必须留在同一个块里**（与 useScreenData.commit 同一条纪律：
        //    `fileList = filterByName(dataSource, searchText)`，拆开就有一帧"旧数据 × 新词"）。
        dataSource.value = [];
        searchText.value = '';
        /**
         * ⚠️ `failKind` **必须一起清**（2026-10-05 code review 抓到）。
         *
         * 它描述的是"**当前这一屏**取数失败了"，而上面刚把"当前这一屏"整个拿掉
         *（`nav.reset()`）⇒ 留着它就是在陈述一个已经不存在的对象。两处后果：
         *  ① `banner` 继续显示"移动硬盘不在…插好后按 F5 重读"，而 F5 已因"没有当前屏"被拦掉
         *     （见 `onRefresh`）⇒ **文案指向一个不存在的操作**；
         *  ② `emptyTip` 的守卫把 `loadFailed` 排在 `!hasAny` **前面**
         *     ⇒ 那句"还没选文件夹"永远显示不出来 ⇒ 用户落在**纯空白页**上。
         *
         * 缓解面：这条路以前只有 chip 上的 × 走得到；2026-10-05 加了「清空」按钮之后，
         * 它变成"在任意一屏一键可达" ⇒ 必须在这里收口（唯一的状态复位点）。
         */
        failKind.value = '';
        return;
    }
    dir.value = value;
    nav.reset();
    // 首层也用 cover。cover 模式才会对子目录调 handleCover（收敛成封面条目）；
    // 原来首层写的是 folder，而 folder 模式**根本不会调用 handleCover** ——
    // 结果是「封面收敛」只在点进去之后的第二层生效，第一层永远只看到一堆文件夹图标，
    // 而第二层反而显示封面。同一个规则两层表现不一致，所以首层也统一成 cover。
    enterScreen(value, 'cover');
}

/**
 * 清空导航历史，回到"还没选文件夹"的界面。
 * ⚠️ 走既有出口 `setRoot('')`，别自己发明清栈逻辑；代价是当前视图 + 整个历史 + 搜索词一起重置、不可撤销。
 * ⚠️ 入口是**右键菜单末尾**那一条（2026-11-10 双向导航之后搬的家，见模板 `.ctx-menu` 的导航组）。
 *    2026-10-05「栈底也得有出口」那条**没有撤销**：出口还在，只是不再占顶栏那一格 ——
 *    加了「前进」以后，"后退不可用"与"该清空了"是两件事，一颗按钮表达不了。
 * ⚠️ 只挂显式入口，绝不绑 Backspace（门槛 ∝ 不可逆 × 波及面）；只重置导航态，不删缓存 / 缩略图 / 扫描结果。
 */
const clearNav = () => setRoot('');

/**
 * 右键菜单里的「清空导航历史」。
 *
 * ⚠️ **不弹确认**（业主 2026-11-10：又不是删除数据）。
 * 它重置的只是**视图状态**（当前视图 + 前进/后退历史 + 搜索词），缓存、缩略图、
 * 收藏、扫描结果一样都不动；"丢掉的东西"重新点几下就回来了 ⇒ 门槛不配吃一次对话框。
 * （原来那颗 ⨯ 之所以值得谨慎，是怕误触把整屏清掉；现在它在菜单里、要点两次才到，误触概率已经很低。）
 * ⚠️ 必须先关菜单：清空会把菜单背后的整屏一起重置，留着菜单就是"对着一张空页面"。
 *    `closeCtxMenu` 顺带把焦点收回 body（否则方向键还停在已被隐藏的按钮上）。
 */
const onCtxClearNav = () => {
    closeCtxMenu();
    clearNav();
};

/**
 * 从缓存记录打开一个目录。**这是一次「跳转」，不是"以它为根"**。
 *
 * 原来它走 `handleDirChange(path)`，那一句同时干了三件事，于是三个症状一起出现：
 *   · `dir.value = path`（把跳转目标当成新根）+ 清空导航栈 ⇒ **面包屑只剩一段，位置感丢失**
 *   · 「返回」按钮按 `dir` 判断 ⇒ **按钮还在，但点了没反应**（栈里只有一屏）
 *   · 历史被销毁 ⇒ **回不到刚才那一屏**，只能重开面板再找那一行
 * ⇒ 现在走 `jumpTo`：**不换根、保留历史**，于是「返回」能撤销这次跳转。
 *
 * `mode` 仍然不看：那是"这条记录当初怎么被扫出来的"（缓存记录的属性），
 * 不该决定"导航长什么样"。三条入口一律 `'cover'`。
 */
const openHistory = (path: string) => {
    const norm = (p: string) => (p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    // 已经处于该目录：不重复处理/取数，直接保留当前展示
    if (norm(currentPath.value) === norm(path)) {
        return;
    }
    // 若当前为 flat 模式，从缓存记录打开另一根目录时沿用 flat 模式
    const wasFlat = isFlatView.value;
    enterScreen(path, 'cover', undefined, wasFlat);
};

/**
 * 批量扫描「这一片」的全部状态与流程 —— 见 useScanFlow.ts。
 * 这里只留一条"扫完怎么刷当前屏"的实现（页面才知道清单屏与目录屏的差别）。
 */
const { scanning, scanDone, scanPending, cancelling, scanOk, glow, glowKey, scanVerb, startScan, onScanCancel } =
    useScanFlow({
        currentPath,
        notify,
        refreshScreen: reloadCurrentScreen,
        fullPathOf,
    });

/**
 * 扫描动效**扫到顶**的那一刻（淡出开始前）—— 完成音挂这里。
 * 三个更早/更晚的候选都不对：
 *   · `scanning` 变 false：光还没开始往上扫，声音抢在视觉前面；
 *   · `@closed`：已经淡完一整段（≈300ms），听起来是"音在后面追画面"。
 * 取消 / 失败不响（`scanOk` 只在"跑到底且没人按取消"时为真）。
 */
const onScanSwept = () => {
    if (scanOk.value) playSfx('success');
};

/**
 * 「更多」菜单外观：只走 naive-ui 预留的 var(--n-*) 变量，不覆盖选择器。
 * ⚠️ 变量必须放 style（字符串，menu-props 的索引签名要求 string），不能扁平写顶层 —— 会被 dropdownProps.style 同名覆盖而失效。
 * ⚠️ 别写 CSS 选择器覆盖：与 cssr 运行时注入同权重、先后顺序不可控。依据见 docs/probes/menu-look/。
 */
const moreMenuProps = () => ({
    style: [
        '--n-border-radius: 8px',         // 与控件同一档（原 4px，三种圆角并存的老问题）
        '--n-font-size: 13px',            // 对齐字阶，与面包屑/输入框一致
        '--n-option-height: 32px',        // 默认 34px 对 13px 字号偏挤
        // 悬停＝实打实的灰，选中＝高亮淡底。"悬停"和"已选"是两件事，不该同色。
        // ⚠️ 之前是 #f6f7f8 / #eceef1，两者差不到 3% 明度 ⇒ 主人反馈"悬浮背景色过淡"。
        '--n-option-color-hover: var(--ff-menu-hover)',
        '--n-option-color-active: var(--ff-menu-hover)',
    ].join('; '),
});

/**
 * 目录工具动作的**唯一清单**——「更多」下拉与右键菜单（卡片/空白两处）共用这一份。
 * 图标只给右键菜单用；label 允许动态（换封面⇄退出换封面）。
 * 禁用判据与 2026-11-08 的下拉版一致：扫描/挑封面期间、清单屏无历史、只读层。
 */
interface DirAction {
    key: string;
    label: () => string;
    icon: Component;
    disabled: () => boolean;
}
const scanLocked = () => scanning.value || picking.value || !hasAny.value || !!readOnlyLevel.value;
const DIR_ACTIONS: DirAction[] = [
    // ⚠️ 扫描类动作在「挑封面」模式下**也禁用**：它们会把网格重扫一遍，
    // 而状态条那边是 `v-if="scanning || picking"` 且扫描优先 —— 扫描条会把挑选 UI
    // 顶掉（选中的东西还在、但你看不见那个计数和处理按钮了）。
    // 通用读写操作，按"从轻到重"排。三个名字各说一件事，别让它们互相暗示：
    //   刷新     = 只重读**你眼前这一层**（F5 同一个动作）
    //   更新读取 = 整片核对一遍，只重读**变了的**层（每层 1 次 stat；当前层逐条比对）
    //   重新读取 = 整片每层都真读（兜底：改名/换盘/大改之后）
    { key: 'refresh', label: () => '刷新', icon: RefreshOutline, disabled: () => scanning.value || !hasAny.value || !!readOnlyLevel.value },
    { key: 'update', label: () => '更新读取', icon: CloudDownloadOutline, disabled: scanLocked },
    { key: 'reload', label: () => '重新读取', icon: SyncOutline, disabled: scanLocked },
    { key: 'cover', label: () => '补封面', icon: ImageOutline, disabled: () => scanning.value },
    { key: 'avatar-recovery', label: () => '头像回收', icon: PersonOutline, disabled: scanLocked },
    // 「站点规则」= 抓取规则的编辑器（入口 / 动作 / 抽取三段）。它是**系统盘上的配置**，
    // 与移动硬盘无关 ⇒ 离线只读层里也允许打开（不禁用）。
    { key: 'rules', label: () => '站点规则', icon: SettingsOutline, disabled: () => false },
    // 「换封面」= 补封面的**反面**：补封面是让程序找出"没有封面的"，
    // 换封面是让用户自己挑"有封面但要换的"。两者最终复用同一个弹窗、同一条抓取写入链路。
    // 2026-10-21：主人裁定它不是高频动作 ⇒ 从次栏搬回这里，不占常驻位置。
    { key: 'faces', label: () => (picking.value ? '退出换封面' : '换封面'), icon: ImagesOutline, disabled: () => scanning.value || !!readOnlyLevel.value },
];

/**
 * 「更多」下拉的项：disabled 条件与改造前平铺按钮逐条一致，不放宽门槛。
 * 扫描中整组不可用由触发按钮的 :disabled="scanning" 挡住（下拉不弹 = 三项都点不到）。
 *
 * ⚠️ 这里**只有目录工具动作**。「清空导航历史」是**导航动作**且不可撤销 ⇒
 * 2026-11-10 业主裁决放**右键菜单**末尾单独一组，不进这个下拉
 *（下拉回答"这一层能做什么"，右键回答"对现在这个地方动手"）。
 */
const moreOptions = computed(() => DIR_ACTIONS.map((a) => ({
    label: a.label(),
    key: a.key,
    disabled: a.disabled(),
})));

/** 右键菜单的目录工具组：label/disabled 求值成普通值供模板渲染 */
const dirActions = computed(() => DIR_ACTIONS.map((a) => ({
    key: a.key,
    label: a.label(),
    icon: a.icon,
    disabled: a.disabled(),
})));

/** 右键菜单里点目录工具：先收菜单再走与下拉同一个处理器（一份实现） */
const runDirAction = (key: string) => {
    closeCtxMenu();
    onMoreSelect(key);
};

/**
 * 下拉选中。**「重读」的确认放在这里**（唯一不可逆 × 波及面最大的动作）。
 *
 * 为什么是 `dialog` 而不是 `n-popconfirm`：换成下拉后 popconfirm 只能挂在「更多」按钮上
 * （受控 show），于是"点了菜单项、确认框却出现在别处"。DESIGN-UIUX §4.1 选 popconfirm
 * 的理由是"高频动作弹窗会警报疲劳"，而重读是低频 ⇒ 那条理由在这里不成立，门槛没降。
 */
const onMoreSelect = (key: string) => {
    if (key === 'refresh') {
        onRefresh();
    } else if (key === 'update') {
        void startScan('update');
    } else if (key === 'fill') {
        void startScan('fill');
    } else if (key === 'reload') {
        dialog.warning({
            title: '重读这一片？',
            content: '忽略缓存，把这一片重新读一遍硬盘。',
            positiveText: '重读',
            negativeText: '取消',
            onPositiveClick: () => { void startScan('reload'); },
        });
    } else if (key === 'cover') {
        // 带上当前路径：多盘机器上「补封面」能直接把正在看的那块盘选好（离线则留空）
        assistantModal.value?.setShowModal(true, undefined, currentPath.value);
    } else if (key === 'avatar-recovery') {
        showAvatarModal.value = true;
    } else if (key === 'rules') {
        // 站点规则是**长期配置**，从 2026-10-21 起是设置页的一部分（不再全屏弹窗）
        void router.push('/settings');
    } else if (key === 'faces') {
        // 再点一次 = 退出（下拉项的文案会跟着变成「退出换封面」）
        if (picking.value) exitPick();
        else enterPick();
    }
};

// ─────────────────────────────────────────────────────────────────────────
// 「换封面」：在**主界面网格**上叠加一层"可点选"，挑出要换的封面。
//
// 立场（2026-10-02，用户原话「我不要搞出太多的界面和入口，尽可能保持统一」）：
//   · **不新增任何界面** —— 挑就用主界面自己的网格 / 目录树 / 搜索 / 面包屑；
//   · **不动工具条**（铁律：绝不换形、子元素个数恒定）⇒ 入口进「更多」下拉、状态进状态条；
//   · **不改双击**（打开照旧）⇒ 单击只在模式态里变成"选中"；
//   · 模式是**叠加**的：退出即完全恢复，普通浏览体验一个字都不变。
// 选中的"位置"交给既有的补封面弹窗（`AssistantCoverModal.setShowModal(true, picks)`），
// 展开 → 抓取 → 预览 → 写入 整条链路零改动。
// ─────────────────────────────────────────────────────────────────────────

/** 是否处于"挑封面"模式 */
const picking = ref(false);

// ── 视图密度（网格列数）─────────────────────────────────────────────────────
/**
 * 三档：宽松 6 / 标准 8 / 紧凑 12（表在 `./density.ts`，那里是**唯一**的列数真相）。
 *
 * 本文件只做三件事：绑到 `.image-box` 的 `--ff-grid-cols`（CSS 唯一消费点）、
 * 传给 `useGridCursor`（列数变 ⇒ 行结构必须失效）、把选择存住。
 *
 * ⚠️ 切换**只改一个 CSS 变量**：不重新取数、不读盘、无请求 —— 纯重排。
 * ⚠️ 别在任何 CSS 里再写死 6/8/12：列数一变就会漏一处。
 */
const density = ref<Density>(loadDensity());
const gridCols = computed(() => colsOf(density.value));
watch(density, d => saveDensity(d));

/**
 * 整块内容被换掉的那一帧，让网格**溶解进来**（机制与取舍见 `./gridDissolve.ts`）。
 *
 * 只挂两个源，**刻意不含 `searchText`**：筛选是**每个按键**都换一次内容，
 * 在按键频率上做任何过渡都只会变成闪烁 —— 搜索就该是瞬时的。
 * 这里两个源都对应"用户主动跳到一个新地方"：`dataSource` 换 = 换层/首屏铺满，
 * `gridCols` 变 = 切密度档（纯重排，不取数）。
 *
 * `flush: 'post'`：必须在新 DOM 就位、但**还没上屏**的那一帧起跑，
 * 否则先看到一帧硬切再开始淡入，等于没做。
 */
watch([dataSource, gridCols], () => dissolveGrid(imageBox.value), { flush: 'post' });

// ── 网格选择器域接线（方向键 / 回车）───────────────────────────────────────
// ⚠️ **必须排在 `usePreview` 之前**：下面 `usePreview` 要拿本块的两个回调
//（`focusCursor` 与 `syncCursor`）。而本块反过来需要 `previewOpen` ——
//那个用**函数** `() => previewOpen.value` 传（不是 `Ref`），所以它在声明之前
// 写成也没问题：按键一定发生在挂载之后，那时 `previewOpen` 早已初始化。
// ⇒ 这不是"侥幸"，是 `useGridCursor` 的 `isPreviewOpen` 入参**只能**收函数的原因
// （传 `Ref` 会拿到创建那一刻的快照恒为 `false`，于是"预览开着时回车要 bail"
//   静默失效、且没有任何报错）。
const {
    cursorKey,
    focusCursor, setCursorKey, noteIntent, dispose: disposeGridCursor,
} = useGridCursor({
    fileList, keyOf, imageBox,
    isPreviewOpen: () => previewOpen.value,
    // 扫描动效期间连方向键也让出去：遮罩底下那层网格是糊的，
    // 这时候还能用方向键挪光标、滚列表，只会让画面更乱。
    isActive: () => pageActive.value && !glow.value,
    onConfirm: onCursorConfirm,
    // ⚠️ 必须写成箭头函数：`openPreview` 在下面 `usePreview` 那一块才声明
    // （它要拿本块的 `focusCursor`）⇒ 裸引用 `onPreview: openPreview` 会在 setup 期间 TDZ 报错。
    onPreview: (item) => openPreview(item),
    // 列数变 ⇒ 每行装几个变 ⇒ 行结构缓存必须作废（否则切档后方向键按旧列数跳）
    cols: gridCols,
});

// ── 预览域接线 ───────────────────────────────────────────────────────────────
// 整块搬进 ./usePreview.ts：它是本文件里最独立的一个域（只靠几个依赖进来，
// 不反向写任何外部状态），后续给预览加花样有个自己的家。
//
// ⚠️ `syncCursor` / `revealCursor` 指向上面那块：网格选择器归 `useGridCursor` 管，
//    本模块只**单向**同步过去，不持有 `cursorKey`（理由见 usePreview 文件头）。
// ⚠️ 渲染落点仍在组件里：模板里那个空的 `n-image-group`，以及末尾那个**非 scoped** 的
//    style 块（工具条与图都被 naive-ui teleport 到 body，`<style scoped>` 够不到它们）。
// ⚠️ `previewedImgProps` 必须由本组件 provide 进 `imageContextKey` —— 预览层由
//    `n-image-group` 渲染，父链是 `ImagePreview ← ImageGroup ← 本组件`，
//    而 naive-ui 没给 group 留 `previewed-img-props` 这个 prop。
/** 「定位压暗」的计时器：600ms 后自动撤销（见下面的 revealAndFlash） */
let locateTimer = 0;

/**
 * 把选择器落到某一条，并**短暂压暗其余格子**。
 *
 * ⚠️ 这是「把注意力拽到某一张」的**唯一实现 + 唯一入口**：关预览（Esc / ✕ / 遮罩）
 * 和「定位」走的是同一次调用 —— `locateInGrid` 只调 `closePreview`，而 `closePreview`
 * 调 `revealCursor`。两条路径各自实现一份的话，迟早一条有蒙层、一条没有（这正是主人
 * 这次问的 "为什么没有那个特殊效果"：关预览时只 `focusCursor`，漏了蒙层）；
 * 反过来，两条路径都调一次也会让同一格滚两遍、闪两遍。
 *
 * 为什么是「压暗其余」而不是「把选中项做得更花」：满屏几百格里，加深选中项只会让
 * 它和封面抢眼；压暗其余才是游戏机相册那套通用手法。
 */
const revealAndFlash = (key: string) => {
    focusCursor(key);
    const box = imageBox.value;
    if (!box) return;
    box.classList.add('is-locating');
    window.clearTimeout(locateTimer);
    locateTimer = window.setTimeout(() => box.classList.remove('is-locating'), 600);
};

const {
    openPreview, locateInGrid,
    previewSrcList, previewIndex, previewOpen,
    onPreviewShowChange, onPreviewCurrentChange,
    previewToolbar, previewedImgProps, dispose: disposePreview,
} = usePreview({
    fileList, keyOf, displaySrcOf, previewUrlOf, picking,
    syncCursor: setCursorKey,
    // 关预览（Esc / ✕ / 点遮罩）：翻页只同步不滚动 ⇒ 高亮可能在视口外，
    // 所以既要滚回来，也要用同一份蒙层告诉用户"回到这里了"。
    revealCursor: () => { if (cursorKey.value) revealAndFlash(cursorKey.value); },
});

provide(imageContextKey, { previewedImgPropsRef: previewedImgProps });

const {
    pickedCount, isPickable, isPicked, onItemClick,
    clearPicked, enterPick, exitPick, openFaces,
} = usePickMode({
    picking,
    keyOf,
    focusCursor,
    // 选中的位置交给既有的补封面弹窗（展开 → 抓取 → 写入，整条链路零改动）
    openFacesModal: (picks) => assistantModal.value?.setShowModal(true, picks),
});

const onKeyup = (e: KeyboardEvent) => {
    // ⚠️ 本页被 KeepAlive 缓存、退到后台时，window 上的监听仍然挂着。
    // 少了这一行，在清单页按 S / F5 / D 会去改**文件页**的搜索词、甚至重读盘。
    if (!pageActive.value) return;
    // 扫描动效（5 秒）期间不接单键：那时按 F5 / S / D 打的都是遮罩背后那一屏
    if (glow.value) return;

    // ⚠️ 用共用的 `isGridKeyBlocked` 而不是原来那句 `e.target !== document.body`：
    // 它是后者的**超集**（多一条 `contenteditable`）。方向键那边也用同一个函数，
    // 于是"什么键归网格"这件事**只有一处定义**（见 `utils/index.ts` 的完整注释：
    // 那里说明了为什么不能改成 DOM 类名探测）。
    if (isGridKeyBlocked(e)) return;

    /**
     * 预览层（全屏遮罩）开着时：`回车` = 定位，其余单键**全部短路**。
     *
     * 与下面「换封面」那条同族、同理由：预览层是**盖在网格上**的，这时按下 S / D /
     * Backspace / F5 打的是**背后那一屏**（跳搜索框 / 跳文件夹选择器 / 返回 / 重读），
     * 屏幕上却看不出跑偏；F5 还会把列表换掉（预览序列跟着变）。
     * ⚠️ `← / →` 不在这里管 —— 那是 naive-ui 自己监听的 keydown（`ImagePreview.mjs:78-100`），
     * 它只在预览打开时挂上，与这里不重复；`Esc` 同理（它自己关）。
     * ⚠️ **方向键与回车在 keydown 阶段就已被 `useGridCursor` bail 掉了**（它先注册、
     *     且带 `isPreviewOpen()` 判断），所以这里处理 `Enter` 不会"定位 + 打开"一起触发。
     * ⚠️ 这里用 **keyup**，naive-ui 与网格都用 **keydown**，两者不会互相吃掉。
     * ⚠️ **`e.repeat` 也要挡**（与网格那边同一条纪律）：keyup 在长按时**同样重复**
     *     （实测按住回车 1 秒 = 33 次 keyup）⇒ 不挡就是"一次长按定位 33 次"，
     *     而每次定位都会 `scrollIntoView` + 滚一次，视觉上是画面抽搐。
     */
    if (previewOpen.value) {
        if (e.key === 'Enter' && !e.repeat) locateInGrid();
        return;
    }

    /**
     * 有浮层开着时，Esc 与 Backspace 只用来关掉它 —— 分层消费，浮层不在了才轮到导航。
     * 判据是"有没有浮层开着"，不是"按了哪个键"：两个小浮层没有专属键，Backspace 也必须能关。
     * ⛔ 不做 DOM 探测（body 里找 .n-popover）：显隐与类名归 naive 管，探测它等于抄它的实现。
     */
    if (popover.value.visible || ctxMenu.value.visible) {
        if (e.key === 'Escape' || e.key === 'Backspace') {
            e.preventDefault();
            // ⚠️ 两个都要关：它们**互斥**（一个封面弹层、一个右键菜单），
            //    但"哪个开着关哪个"这件事必须**明确写出来**，
            //    否则将来某个时刻两者同时开着就会只关一个、另一个留在屏幕上。
            if (popover.value.visible) closeFileList();
            if (ctxMenu.value.visible) closeCtxMenu();
        }
        return;                     // ★ 其余按键一律不穿透到背后那一屏
    }

    // 「换封面」模式态：Esc 退出，并**短路那几个会跑到别处去的单键**。
    // 理由：模式态下用户手一直放在键盘上（点格子挑），误触 S / D / Backspace
    // 会当场跳到搜索框、文件夹选择器、上一屏 —— 而屏幕上看不出是"跑偏了"。
    // ⚠️ F5 刷新**不短路**：它是"我挑完想看看盘上现在什么样"，模式态里照样有用。
    // ⚠️ `Alt+←/→` 也短路（2026-11-10 双向导航）：它是"跳屏"，与 Backspace 同族 ——
    //    在挑选过程中把屏换掉，选中的那批格子还在、但你看不见它们了。
    if (picking.value) {
        if (e.key === 'Escape') {
            exitPick();
            return;
        }
        if (e.key.toUpperCase() === 'S' || e.key.toUpperCase() === 'D' || e.key === 'Backspace') return;
        if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) return;
    }

    if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        /**
         * `Alt+←` / `Alt+→` = 后退 / 前进（资源管理器、浏览器的通用手势）。
         *
         * ⚠️ 必须在 `useGridCursor` 里挡掉同一组键的 keydown：那边不看修饰键，
         *    `Alt+→` 会先被它吃成"选择器右移一格"；而 keydown 里 `preventDefault`
         *    **挡不住 keyup** ⇒ 不加那条守卫就是"移动一格 + 跳屏"同时发生。
         * ⚠️ 越界由 `goStep` 静默处理（栈底 / 尾巴尽头什么都不做），这里不判。
         */
        e.preventDefault();
        void (e.key === 'ArrowLeft' ? onBack() : onForward());
    } else if (e.key.toUpperCase() === 'S') {
        // 收起态它只是一颗图标 —— 先展开再聚焦（`openSearch` 内部 nextTick 才 focus）
        openSearch();
    } else if (e.key === 'F5') {
        onRefresh();
    } else if (e.key.toUpperCase() === 'D') {
        folderSelector.value!.handleClick();
    } else if (e.key === 'Backspace') {
        // 与 `S` / `D` / `F5` 同一个单键风格。只在**真有上一屏**时生效（onBack 自己会判），
        // 且 `target === body` 的守卫已经在最上面 —— 在搜索框里按退格是删字，不是返回。
        e.preventDefault();
        onBack();
    }
};

/**
 * 鼠标点过任何按钮后，把焦点从它身上摘掉。
 *
 * 不摘的后果（2026-11-07 真机）：焦点残留在按钮上，浏览器会把之后的回车当成
 * "再点一次那个按钮" —— 现象就是「点过 flat 切换后按回车，又切了一次 flat」。
 *
 * 三条限定，只为解决这一个问题、不碰别的：
 *  - `e.detail === 0` 跳过：那是键盘触发的 click（Tab + Enter），焦点必须留着，无障碍还要用；
 *  - 只在目标是 `<button>` 时才摘：输入框、下拉触发器一概不碰；
 *  - `setTimeout 0`：等这次 click 自己的处理跑完再摘，不打断控件逻辑。
 *
 * 成本：一次 `closest('button')` + 一次定时器，只在鼠标点击时发生（用户点击频率极低）。
 */
const onDocClickBlurButton = (e: MouseEvent) => {
    if (e.detail === 0) return;
    const btn = (e.target as HTMLElement | null)?.closest('button');
    if (btn) window.setTimeout(() => (btn as HTMLElement).blur(), 0);
};

onMounted(() => {
    window.addEventListener('keyup', onKeyup);
    document.addEventListener('click', onDocClickBlurButton, true);
    // 收录索引（2026-10-21 清单）：网格星标与「加入清单」选单 ✓ 的数据源。
    // 失败不打扰启动 —— 星标只是不显示，清单功能要等用户点进去才用得上。
    void refreshIndex().catch(() => undefined);
    // 主进程的移动硬盘插拔通知（事件驱动，零轮询 —— 见 electron/main/diskWatch.ts）
    ipcRenderer.on('ff-disks-changed', onDisksChangedIpc);
    ipcRenderer.on('ff-device-change', onDeviceChangeIpc);
});

// 必须写在 setup 顶层。注册在 onMounted 回调**内部**的 onUnmounted 永远不会被调用 ——
// 本次生命周期早过了注册窗口，结果是 keyup 监听永久留在 window 上。
// HistoryTable 那边修过一次，这里是漏网的那处。
onUnmounted(() => {
    window.removeEventListener('keyup', onKeyup);
    document.removeEventListener('click', onDocClickBlurButton, true);
    ipcRenderer.off('ff-disks-changed', onDisksChangedIpc);
    ipcRenderer.off('ff-device-change', onDeviceChangeIpc);
    // 预览层那个"停住 0.3s 才换清晰版"的挂起计时器：组件没了就别再起来
    disposePreview();
    // 网格选择器：摘掉它的 keydown（方向键/回车）与 resize 监听。
    // ⚠️ **必须摘**：留着就是"看不见的全局监听" —— 组件没了还在拦方向键。
    disposeGridCursor();
});

/**
 * 路由切回本页时：恢复键盘 + 消费"跨页跳转"的意图。
 *
 * ⚠️ 为什么不用 props 传：现在两侧是**两条路由**，没有父子关系；
 * 一份模块级的 `pendingTarget` 比"把状态提到 router 的 meta 里"更直白，
 * 也不会在刷新后留下一条过期意图（取一次就清空）。
 */
onActivated(() => {
    pageActive.value = true;
    const t = consumeTarget();
    if (!t) return;
    if (t.kind === 'path') openHistory(t.path);
    else enterPlaylist(t.id, t.name);
});

onDeactivated(() => {
    pageActive.value = false;
});


/**
 * 实时路径的盘符（`E:/x` → `E`）。锚点不会走这里 —— 它开头的 `#` 匹配不上。
 * 解析**实时路径**是渲染层本来的活（面包屑就在做），不违反"不解析锚点"那条约定。
 */
const driveLetterOf = (path: string): string => {
    const m = /^([A-Za-z]):/.exec(path);
    return m ? m[1].toUpperCase() : '';
};

/** 实时路径 → 只读锚点。盘拔掉之后把这一屏降级用（服务端只查一个内存 Map，**零读盘**）。 */
const getAnchor = async (path: string): Promise<string> => {
    try {
        const data = await getAction(`${API_BASE}/anchorOf?path=${encodeURIComponent(path)}`);
        return data?.anchor || '';
    } catch {
        return '';
    }
};

/**
 * 主进程报「盘列表变了」。**插拔是对称的两件事，这里都管**：
 *
 *   【插】正停在只读层、而那块盘回来了 ⇒ **自动切到实时**。
 *   【拔】正停在实时层、而那个盘符没了 ⇒ **自动降级成只读锚点**，继续用缓存看。
 *
 * 【拔】那条不这么做的话：列表靠内存还撑着、看着一切正常，可**一刷新就报 offline、
 * 双击也打不开** —— 用户根本不知道发生了什么。降级之后目录和缩略图都还在，
 * 服务端走 `findCache`，**零读盘**。
 *
 * 另外每次都让「缓存记录」面板重取一次数据 —— 否则它每行的「在线 / 离线」
 * 会一直停在插拔前的状态（面板打开时刻意不重探盘符，见那边的注释）。
 *
 * ⚠️ 两条路都**不解析锚点内容**（那是服务端的活，只有它才有 serial →盘符 映射）：
 * 靠 `/resolveAnchor`（锚点→路径）与 `/anchorOf`（路径→锚点）两个方向相反的接口，
 * 把转换整个交给服务端。渲染层对锚点的认知仍然只有"前缀是不是 `#`"。
 */
const onDisksChanged = async (disks: { serial: string; drive: string }[]) => {
    // 2026-10-21 清单屏：插拔盘只影响"条目在线/离线"与星标 key 的当前形态
    // ⇒ 重取清单 + 刷新收录索引。静默 —— 徽标翻转本身即反馈（不像目录屏那样弹通知，
    // 那一侧是因为"列表内容降级"需要解释，这里没有内容丢失）。
    const topPl = nav.current.value?.pl;
    if (topPl) {
        try { await refreshIndex(); } catch { /* 索引刷新失败不挡着重取清单 */ }
        await fetchPlaylistItems(topPl.id);
        return;
    }

    const top = nav.current.value;
    if (!top) return;

    /** 换掉当前这一屏的地址。**替换**而不是 push —— 用户眼里还是同一层，只是地址变了 */
    const swapTop = async (path: string) => {
        // 替换**当前这一屏**的地址，不新增历史（用户眼里还是同一层）⇒ 走模型的 replaceCurrent，
        // 别在这里手写 splice：游标一旦和数组长度分开，任何"按下标改数组"的代码都会让 index 失步。
        nav.replaceCurrent({ path });
        await fetchFolder(path, top.mode);
    };

    if (!isReadOnlyPath(top.path)) {
        // ── 拔盘：盘符没了就降级成只读 ──────────────────────────────────
        const letter = driveLetterOf(top.path);
        if (!letter) return;                                  // UNC / 网络位置：没有"拔盘"这回事
        if (disks.some((d) => d.drive === letter)) return;     // 这块盘还在，不关我们的事
        const anchor = await getAnchor(top.path);
        if (!anchor) return;                                  // 从没扫到过这个盘符 ⇒ 没缓存可用，保持原样
        await swapTop(anchor);
        notify('warning', '这块盘已拔出', '已切换到缓存内容，缩略图仍可用', { silent: true });
        return;
    }

    // ── 插盘：盘回来了就切实时 ────────────────────────────────────────
    const real = await resolveAnchor(top.path);
    if (!real) return;
    await swapTop(real);
    notify('success', '盘已插回', '列表已切换到实时内容', { silent: true });
};

/** 插拔音走**设备消息**（主进程 `ff-device-change`），不走盘列表差分：
 *  盘列表要等系统挂好卷才变（实测 ~1.2s），拿它触发音效必然比手上的动作晚半拍到一秒多。 */
const onDeviceChangeIpc = (_e: unknown, dir: 'in' | 'out') => {
    playSfx(dir === 'in' ? 'drive-in' : 'drive-out');
};

/** IPC 监听器的**稳定引用**：`off` 必须拿到同一个函数，否则卸不掉、组件重建后会重复响应 */
const onDisksChangedIpc = (_e: unknown, disks: { serial: string; drive: string }[]) => {
    void onDisksChanged(disks || []);
};

</script>

<style lang="less" scoped src="./styles/shell.less"></style>
<style lang="less" scoped src="./styles/header.less"></style>
<style lang="less" scoped src="./styles/grid.less"></style>
<style lang="less" scoped src="./styles/list.less"></style>