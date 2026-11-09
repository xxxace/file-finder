<template>
    <div class="file-finder">
        <div class="header-bar">
            <!-- 顶栏三段（2026-11-08 定稿）：
                 `[▤ 起点][← 返回/⨯ 清空][↻ 刷新] │ [ 盘: › 段 › 当前段 ⑫ ] │ [⌕][▦][⊞] | [⋯]`
                 中间那条槽是头部**唯一的弹性槽位**（`flex: 1`）—— 它吃掉剩余宽度，
                 所以面包屑右边永远是空的：一次 append / remove 里，排在变动点右边的东西
                 必然被推着走；右边没东西，变化就只剩"多一段 / 少一段"。
                 继续用**裸 flex**、不用 n-space：naive-ui 2.45.3 的 Space 会给每个子项写死
                 同一个 key（`key: 1`），而这一组的子元素个数是**会变**的（v-for + 折叠占位），
                 一变就会重复 key、错位复用节点（docs/FIX-2026-09-24-nspace-duplicate-keys.md）。
                 ⚠️ 槽里每个子项都必须有 key（TransitionGroup 的进出场按 key 认人）。 -->
            <!-- 左侧三颗：起点 / 返回·清空 / 刷新（2026-11-08 顶栏升级）。
                 ⚠️ 它们**刻意不放进 TransitionGroup** —— 本版最重要的一条结构决定：
                 面包屑"零位移"的前提是「排在变动点右边的东西必然被推着走」；
                 把常驻按钮挪出槽之后，槽里只剩面包屑，这条约束就退化成"只多一段 / 只少一段"，
                 干扰源被直接删掉。顺序抄 Windows 资源管理器 / Chrome：`[←][→][↻][地址栏]`。

                 ⚠️ 返回/清空 = **一颗按钮，只换图标**（原来是"两个同宽的中文词"）。
                 换成图标反而更稳：28px 方格定宽 ⇒ 换字形连 1px 都不动。
                 栈底（history === 1）画 `⨯` 走 `clearNav`（业主 2026-10-05：栈底也得有出口）；
                 history === 0（还没选根）**置灰常驻**，不再 `v-if` 消失 ——
                 它一出现/消失就会把整条面包屑推走 ~60px，正是这次要修的那类跳动。 -->
            <div class="nav-btns">
                <FolderSelector ref="folderSelector" v-model="dir" label="请选择文件夹" keys="D" @change="setRoot" />
                <n-button size="small" :disabled="!history.length" :aria-label="navBtnText"
                    v-tip="navBtnTip"
                    @click="onNavBtn">
                    <template #icon>
                        <n-icon :component="navBtnIcon" />
                    </template>
                </n-button>
                <!-- 刷新住在导航区、不搬去动作区：它重读的是**当前这个位置**，
                     与「返回」同属位置动作。tooltip 只为说清它和「重读这一片」的分工。
                     扫描期间禁掉：它带 noCache、会真的再读一次盘，与整片扫描并发就是两路读盘。
                     只读层 / 清单屏也禁掉：那两种屏的源就是缓存，没有"重读"这回事。 -->
                <n-button size="small" :disabled="scanning || readOnlyLevel || playlistLevel"
                    aria-label="重新读取当前文件夹" v-tip="'重新读取当前文件夹'" @click="onRefresh">
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
                     折叠规则：保首段 + `…` + 父 + 当前（Apple HIG 与 Fluent 2 两家官方默认行为）。 -->
                <!-- ⚠️ 2026-11-08 重构：原来是 `v-if="crumbFold"` / `v-else` **两棵互斥的树**。
                     层级跨过 4 的那一下，Vue 会销毁整棵子树、再重建另一棵 ⇒ 视觉上是
                     "整排地址重新渲染一次"（主人原话）。折叠只是"列表里多一项 `…`"，
                     **不是换一套模板** ⇒ 现在统一由 `crumbRows` 这一个数组驱动。
                     首段 / 折叠占位 / 其余段拆成三段渲染，是为了避开
                     `<template v-for>` + `v-if` 混用（TransitionGroup 的 FLIP 拿不到 fragment）。 -->
                <TransitionGroup name="fx" tag="div" class="crumbs" @before-leave="pinLeaving">
                <n-tag v-if="crumbLayout.head" :key="crumbLayout.head.key" class="crumb"
                    :class="{ 'crumb-root': crumbLayout.head.kind === 'root', 'crumb-current': crumbLayout.headCurrent }"
                    :title="crumbLayout.head.path" :data-count="crumbLayout.headCurrent ? crumbCount : null"
                    @click="onCrumbClick(crumbLayout.head)">
                    <!-- ⚠️ 首段必须绑 `@click`（2026-11-08 code review 找回的回归）：
                         `onCrumbClick` 里 `kind === 'root'` 那支是**清单屏点根段回货架**的捷径。
                         统一成三段渲染后首段独立成 `head`，当时没绑 ⇒ 那支变死代码。
                         磁盘根不必担心：`onCrumbClick` 自己会 return（点它不读盘）。 -->
                    <span class="crumb-text">{{ crumbLayout.head.name }}</span>
                </n-tag>
                <!-- 被折起来的中间层：**每一层都还能点** —— 折叠只牺牲「常显」，不牺牲任何能力 -->
                <n-popover v-if="crumbLayout.fold" key="fold" trigger="click" placement="bottom-start">
                    <template #trigger>
                        <n-tag class="crumb crumb-more" title="展开被折叠的层级">
                            <span class="crumb-text">…</span>
                        </n-tag>
                    </template>
                    <div class="hstack">
                        <n-button v-for="c in crumbHidden" :key="c.path" size="small" @click="onCrumbClick(c)">
                            {{ c.name }}
                        </n-button>
                    </div>
                </n-popover>
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
                     为什么敢挤：折叠判据 `foldCrumbList(crumbs, max = 4)` 是**按段数**的、不看宽度；
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
                <!-- 平铺视图切换：仅在根缓存目录可用，跳过女优/父文件夹直接平铺全部作品 -->
                <!-- 激活态见样式 `.toolbar :deep(.is-on)`（灰底 + text-1）。
                     **不用 `type="primary"`**：那会让一个视图开关变成整条工具栏最响的东西
                     （2026-11-07 截图里那块白方块就是它）。 -->
                <n-button class="icon-lg" size="small" :class="{ 'is-on': isFlatView }"
                    :disabled="scanning || !canToggleFlat" @click="toggleFlatView"
                    v-tip="isFlatView ? '当前为平铺视图（点击切回正常视图）' : (canToggleFlat ? '切换为平铺视图（摊开所有子目录作品）' : '仅在根缓存目录可开启平铺视图')">
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
                     ⚠️ 漏依赖的后果是"某处 UI 不跟着变" —— 以后给卡片加新状态时，必须同步加进这个数组。 -->
                <div v-for="(item) in fileList" :key="item.dir + '/' + item.name" v-memo="[
                    item, picking && isPickable(item), isPicked(item),
                    cursorKey === keyOf(item), opening === keyOf(item), plMember.has(keyOf(item)),
                ]" class="image-box-item" :class="{
                        pickable: picking && isPickable(item), picked: isPicked(item),
                        // 焦点（选择器）= 灰白；定位闪烁 = 蓝。三套颜色互不重叠，
                        // 理由与手法见 `docs/DESIGN-GRID-CURSOR-2026-10-04.md` §五。
                        // ⚠️ 判据读 `cursorItem`（派生）而不是 `cursorKey` —— `fileList` 一变
                        // key 就成了野值，读派生量自动不画高亮，不需要任何同步代码去清它。
                        cursor: cursorItem !== undefined && cursorKey === keyOf(item),
                        opening: opening !== '' && opening === keyOf(item),
                    }" :data-key="keyOf(item)" @click="onItemClick(item)" @dblclick="handleOpen($event, item)"
                    @contextmenu.prevent="onContextMenu($event, item)" :title="item.name + ' ' + getSize(item.size)">
                    <!-- `pointer-events:none` 保住连点两张；`v-if` 而非 `v-show`（只转零点几秒，不值得留 DOM） -->
                    <div v-if="opening !== '' && opening === keyOf(item)" class="opening-mask">
                        <n-spin :size="20" />
                    </div>
                    <!-- 「换封面」模式下单击格子 = 选中/取消（见 onItemClick）。
                         同时**关掉图片预览** —— 否则一下点下去既弹放大图、又切换选中，两个动作打架。
                         判断"这张糊不糊"靠格子里的图本身（宽松档 310px、紧凑档 147px），不靠点开大图。
                         ⚠️ 2026-10-04：预览层改由下面那个 `n-image-group` 统一渲染（它才拿得到
                         prev/next，见组节点的注释）。所以这里**不再传** preview-src /
                         previewed-img-props / render-toolbar，改成 preview-disabled —— 它是
                         srcList 模式下**必须**的（有 n-image 子节点就会 throwError）。
                         "点图才开"的语义靠 `img-props.onClick` 原样保留：n-image 的
                         `onImgClick` 会先 showPreview()（被 preview-disabled 挡住），再转给 imgProps.onClick
                         （naive-ui `Image.mjs:99-102`）⇒ 不会双开、也不是 CSS 藏节点。 -->
                    <!-- 封面块：16:9 定比例、圆角走 `--ff-radius-card`（换回直角只改 token）。
                         比例定死 ⇒ 同一行所有格子等高 —— 这是 `gridGeometry` 分行算法的前提，
                         ⚠️ 绝不能换成"由内容撑高"。 -->
                    <div class="card-cover" :style="coverBackdrop(item)">
                        <!-- ⚠️ 必须同时判 `thumb`：`thumbUrl(undefined)` 是空串，而 `<img src="">`
                             会被浏览器当成"当前页面地址"去加载 HTML ⇒ 失败 ⇒ **裂开的图标**。
                             这正是 webp / 抽帧失败的视频在界面上暴露出来的样子，
                             缺图不是这张卡的问题，它应该退到下面的类型图标。 -->
                        <n-image v-if="(item.type === 'image' || item.type === 'video') && !!item.thumb" class="can-preview"
                            :src="thumbUrl(item.thumb)" :img-props="{ onClick: () => openPreview(item) }" :alt="item.dir"
                            :lazy="true" objectFit="contain" preview-disabled />
                        <!-- 目录的脸：不挑封面时缩到 70%（密网格里 100% 太抢眼），
                             「换封面」模式下放到 100% 才看得清。缩放走 `.card-avatar` 的
                             `transform`（不是内联宽高）—— 理由见样式里那段注释：
                             这是**布局动画 vs 合成动画**的区别，一屏几百个目录时差一整条街。 -->
                        <n-image v-else-if="!!item.avatar" class="card-avatar" :src="thumbUrl(item.avatar)"
                            :alt="item.dir || ''" :lazy="true" objectFit="contain" preview-disabled />
                        <img v-else-if="item.type === 'folder'" :src="folderIcon" :alt="item.dir || ''" class="folder-face">
                        <!-- 类名必须小写：`fiv-icon-*` 是**大小写敏感**的 CSS 类，
                             而盘上有大写扩展名的文件（实测库里有 `.MOV`）⇒ `fiv-icon-MOV` 匹配不到任何图标。 -->
                        <div v-else :title="item.dir"
                            :class="`file-cover fiv-cla fiv-icon-${(item.ext || '').toLowerCase()}`" class="file-face">
                        </div>
                        <!-- 角标（B 站封面下沿那一排）：数量在左、大小在右。
                             `pointer-events:none` —— 它盖在封面上，但点它应该等于点封面。 -->
                        <div v-if="(item.files && item.files.length) || (item.size || 0) > 0" class="card-badges">
                            <span v-if="item.files && item.files.length" class="badge">{{ item.files.length }} 个文件</span>
                            <span v-if="(item.size || 0) > 0" class="badge">{{ getSize(item.size) }}</span>
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
                        <span class="scan-progress">已扫 {{ scanDone }} / 待扫 {{ scanPending }}</span>
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
            </div>
        </n-popover>
        <!-- 「加入收藏夹…」选单：右键菜单的第二级，原地展开在同一坐标（同 submenu 手势） -->
        <n-popover :show="plPicker.visible" :x="plPicker.x" :y="plPicker.y" trigger="manual" placement="bottom-start"
            @clickoutside="plPicker.visible = false">
            <PlaylistPicker v-if="plPicker.card" :card="plPicker.card" :item-key="plPicker.key" @added="onPickerAdded"
                @failed="onPickerFailed" />
        </n-popover>
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
import { formatBytes, ancestorsOf, foldCrumbList, isGridKeyBlocked, ANCHOR_PREFIX } from '@/utils';
import type { PathCrumb } from '@/utils';
import type { Component } from 'vue';
import { apiUrl, getAction, postAction, ApiError } from '@/utils/request';
import {
    addToPlaylist, buildMemberMap, defaultPlaylist, getPlaylistItems, playlistIndex,
    refreshIndex, removeFromPlaylist,
} from './playlist';
import type { PlaylistDetail } from './playlist';
import type { CardSnapshot } from '../../../electron/server/playlist';
import folderIcon from '@/assets/fileTypeIcon/folder.png';
import usePinYin from '@/hooks/usePinYin';
import useNotify from '@/hooks/useNotify';
import useConfirm from '@/hooks/useConfirm';
import Banner from '@/components/Overlay/Banner.vue';
import { usePreview } from './usePreview';
import { useGridCursor } from './useGridCursor';
import GridDensityMenu from './GridDensityMenu.vue';
import GalaxyLoadingBar from '@/components/GalaxyLoadingBar/index.vue';
import { colsOf, loadDensity, saveDensity } from './density';
import type { Density } from './density';
import { buildCrumbLayout } from './crumbRows';
import { dissolveGrid } from './gridDissolve';
import { decideOpen, isMultiFileCard } from './openDecision';
import { SearchOutline, RefreshOutline, ArrowBackOutline, CloseOutline, CopyOutline, StarOutline, ChevronForwardOutline, LinkOutline, FolderOpenOutline, CloudDownloadOutline, ImageOutline, PersonOutline, SettingsOutline, ImagesOutline } from '@vicons/ionicons5';
import { MoreVertical28Filled } from '@/components/icons/fluent';
import { FlatCards24 } from '@/components/icons/grid';
import { playSfx } from '@/utils/sfx';
import { NButton, NInput, NIcon, NImage, NImageGroup, NTag, NPopover, NSpin, NDropdown, useLoadingBar } from 'naive-ui';
import FolderSelector from '@/components/FolderSelector/index.vue';
import ScanGlow from './ScanGlow.vue';
import AssistantCoverModal from './AssistantCoverModal.vue';
import AssistantAvatarModal from './AssistantAvatarModal.vue';
import PlaylistPicker from './PlaylistPicker.vue';
import { consumeTarget } from './target';
import { useRouter } from 'vue-router';
import { ipcRenderer } from 'electron';
import { computed, nextTick, onActivated, onDeactivated, onMounted, onUnmounted, provide, ref, watch } from 'vue';
import type { FileInfoFiles, WiredFileInfo } from '../../../electron/server/index';
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

/**
 * 一屏的历史条目。
 *
 * ⚠️ 这三样原来分散在**三个地方**：`openStack` 的元素（`name`/`mode`/`scrollY`）、
 * `searchStack` 数组（搜索词），以及"两个数组长度必须差 1"这个**没有任何类型约束的隐式不变量**。
 * 合并成一个对象之后，"索引对齐错"在结构上不可能发生。
 *
 * **位置不进这里** —— 面包屑由 `ancestorsOf(currentPath)` 现算（纯函数）。
 * 这是本轮的核心：位置可推导、历史不可推导，两者共用一个数组时，
 * 逐层下钻看不出问题，**一旦跳转就必然分叉**（详见 `docs/DESIGN-NAV-2026-09-30.md` §2）。
 */
export interface NavEntry {
    path: string;
    /**
     * 三层入口（选根 / 网格下钻 / 缓存跳转）**一律用 `'cover'`**。
     * 保留这个字段是为了不动 `fetchFolder` 的签名 —— 服务端的 `folder`（无封面收敛）模式
     * 是真实存在的能力，删它是删能力，不是删死代码。
     */
    mode: OpenMode;
    /** 坐在这一屏时搜索框里的词 —— 返回时恢复（原来的 `searchStack`） */
    searchText: string;
    /** 离开这一屏时的滚动位置 —— 返回时恢复（原来是挂在 `openStack` 元素上的可选字段） */
    scrollY: number;
    /**
     * 离开这一屏时选择器停在哪一格（keyOf 值）—— 返回时恢复。
     * ⚠️ 存 key 不存坐标：坐标随布局 / 列数变，存坐标得跟着窗口宽度同步（会漏）。
     * ⚠️ key 不在这一屏里 ⇒ cursorItem 为 undefined、不画高亮，
     * 下一��方向键自动重新激活 —— 这条派生链已经在了（`useGridCursor` 文件头）。
     */
    cursorKey: string;
    /**
     * 清单屏标识（2026-10-21 收藏分类）。非空 = 这一屏是某个清单的详情。
     *
     * 为什么不复用 `mode`：`OpenMode` 是**服务端缓存模式**的枚举（'cover' | 'folder'），
     * 清单不是一种缓存模式，混进去会污染那个类型、也会让 `fetchFolder` 的签名说谎。
     * path 同时写成 `@pl:<id>` —— 两者**同进同退**：取数按 `pl` 分派，
     * 面包屑/返回只认 path（nav 栈里流动的只有 path 一个字符串的既有纪律不变）。
     */
    pl?: { id: string; name: string };
}

// 与 electron/server/videoExt.ts 的 VIDEO_EXT 保持一致（渲染层不能 import server，保留正则副本）。
// 改了 videoExt.ts 这里要同步改。
const VIDEO_EXT_RE = /\.(mp4|mkv|avi|wmv|flv|mpeg|m4v|mov|mpg|ts|m2ts|mts|webm|ogv|3gp)$/i;

/**
 * 清单详情屏的路径前缀（2026-10-21 收藏分类）。与 `#`（只读锚点）同族：
 * 都不是磁盘上的真实路径。身份信息在 `NavEntry.pl` 上，path 只作寻址与面包屑显示。
 */
const PL_PREFIX = '@pl:';

// 统一写 127.0.0.1 而不是 localhost：个别机器会把 localhost 解析到 ::1，
// 而服务端只绑了 IPv4，那样每个请求都要先失败一次再回落
const API_BASE = 'http://127.0.0.1:3060';

/**
 * 缩略图按需取，不再内嵌进 /openFolder 的响应里。
 * 渲染层拿到的是个短 key，图走 /thumb —— 一个目录的响应体因此从几百 KB 降到几十 KB，
 * 而且浏览器会并发拉图、缓存图，只请求真正进入视口的那些（:lazy 现在是真的懒加载了）。
 */
const thumbUrl = (key?: string) => (key ? apiUrl(`${API_BASE}/thumb?k=${encodeURIComponent(key)}`) : '');

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
const popover = ref<{
    visible: boolean;
    x: number;
    y: number;
    files: FileInfoFiles[];
    cover: WiredFileInfo | undefined;
}>({
    visible: false,
    x: 0,
    y: 0,
    files: [],
    cover: undefined
});
/** 文件列表弹层里高亮的那一项（键盘用）。-1 = 没高亮 */
const fileCursor = ref(-1);
/** 弹层里那个可聚焦的容器。`tabindex="-1"` 让它能被 `.focus()`，但**不进Tab 序**。 */
const fileListBox = ref<HTMLDivElement | null>(null);

/**
 * 关掉文件列表弹层，并把焦点**还给 body**。
 *
 * ⚠️ 收回焦点是**必做项**，不是优化：焦点若留在已被 `v-show` 隐藏的元素上，
 * `document.activeElement` 就既不是 body 也不是可见元素 ⇒ 网格的方向键被守卫挡住
 * （`isGridKeyBlocked` 的 `target !== body`）⇒ **方向键永久失灵**，且看不出原因。
 * 同款风险在 `usePreview` 里已经吃过一次（那个 `<img src=undefined>` 的教训）。
 */
const closeFileList = () => {
    popover.value.visible = false;
    fileCursor.value = -1;
    (document.activeElement as HTMLElement | null)?.blur?.();
};

/**
 * 右键上下文菜单的状态。**独立一份**，不和上面那个 `popover`（多文件封面弹层）混用 ——
 * 两者触发方式、内容、定位都不同，共用一个 ref 会在"先右击再双击"这类操作里串台。
 * 复用 n-popover 的手动定位手法（`:x/:y/:show` + `trigger="manual"`），
 * 和 `popover` 是同一套渲染结构，不新增机制。
 */
const ctxMenu = ref<{
    visible: boolean;
    x: number;
    y: number;
    name: string;
    stem: string;
    /** 2026-11-09 双模式：card = 卡片右键（全部组）；blank = 空白右键（只有目录工具组） */
    mode: 'card' | 'blank';
    /** 2026-10-21 清单功能：右击的那张卡。「加入收藏/加入清单」要的快照来源 */
    item: WiredFileInfo | null;
}>({
    visible: false,
    x: 0,
    y: 0,
    name: '',
    stem: '',
    mode: 'card',
    item: null,
});
const searchText = ref('');

/**
 * 搜索框的**展开态**（2026-11-08 顶栏升级）。
 *
 * 收起 = 28px 一颗图标；展开 = 220px 输入框。宽度是从**地址槽**里挤出来的
 * （主人裁决，不要浮层）—— 安全性论证见 docs/DESIGN-HEADER-UPGRADE-2026-11-08.md §三。
 */
const searchOpen = ref(false);
const searchSlot = ref<HTMLDivElement | null>(null);

const openSearch = () => {
    searchOpen.value = true;
    // 等宽度先挂上去再聚焦：给一个 width:28 的框聚焦，光标会落在被裁掉的那一侧
    void nextTick(() => searchInput.value?.focus());
};

/** 收起态被 Tab 命中时自动展开 —— 否则焦点会落在一个 opacity:0 的框里，打字直接过滤网格 */
const onSearchFocus = () => { searchOpen.value = true; };

/**
 * ⚠️ **本组件唯一的不变量：收起 ⇒ 一定没有过滤词。**
 *
 * 光靠 `onSearchBlur` 守不住：`onBack()` 会把上一屏的 `searchText` 还原回来
 * （`history[].searchText`），而它**不碰 `searchOpen`** ⇒ 一个收起的、却带着词的框，
 * 网格悄悄被过滤、界面上只有一颗图标，没有任何线索。
 * 所以反过来也守一道：**词一出现就强制展开**（`watch` 是同步派生的，不依赖任何调用方）。
 */
watch(searchText, v => { if (v) searchOpen.value = true; });

/**
 * 失焦即收起 —— 但**必须先看焦点去了哪**，而且**有词时不许收**。
 *
 * ① 看焦点：点「清空 ×」是先 blur 再 click，直接收起会让那次点击落在已经消失的框上。
 * ② 有词不许收：收起的框里还留着过滤词 = 网格莫名其妙少了一半东西，界面上却没有任何
 *    线索。**"看不见的过滤条件"是最坏的一种陷阱**（比多占 190px 糟得多）——
 *    所以收起的前提是**空**：要么用户自己点 ×，要么按 Esc 后再 clear。
 */
const onSearchBlur = () => {
    window.setTimeout(() => {
        if (searchSlot.value?.contains(document.activeElement)) return;
        if (searchText.value) return;
        searchOpen.value = false;
    }, 0);
};

/** 搜索框按 Esc：把焦点交还给网格（否则打字框会一直吃着方向键）。收起交给 blur 那条路判。 */
const blurSearch = (e: KeyboardEvent) => {
    (e.target as HTMLElement | null)?.blur();
};
const imageBox = ref<HTMLDivElement | null>(null)
const folderSelector = ref<typeof FolderSelector | null>(null);
const searchInput = ref<typeof NInput | null>(null);
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
 * 导航的**唯一状态**：历史（去过哪些屏）。每屏一个对象。
 * 为什么不留 `name`：面包屑的文字由 `ancestorsOf(currentPath)` 给（见 utils），
 * 一份数据只留一个来源。
 */
const history = ref<NavEntry[]>([]);
/**
 * 当前这一屏的路径 —— 「位置」的一切都从它派生。
 * 因为它就是路径本身，所以**不可能**和界面显示的位置不一致（不存状态 ⇒ 不会不一致）。
 */
const currentPath = computed(() => history.value[history.value.length - 1]?.path ?? '');
/** 面包屑：从起点到当前的完整链。**纯推导** ⇒ 跳转后自动正确，不需要任何同步代码。 */
const crumbs = computed(() => {
    // 清单屏：面包屑是「清单 / 名称」两段，不是磁盘路径 —— ancestorsOf 会把
    // `@pl:` 当 UNC 拆成物理上不存在的层级。根段不可点（点它开货架，见 onCrumbClick）。
    const top = history.value[history.value.length - 1];
    if (top?.pl) {
        return [
            { name: '收藏', path: '', kind: 'root' as const },
            { name: top.pl.name, path: top.path, kind: 'dir' as const },
        ];
    }
    return ancestorsOf(currentPath.value);
});
/** 平铺视图（Flat 模式）：跳过中间女优/父文件夹，单纯摊开所有子目录作品。限定根缓存目录开启。 */
const isFlatView = ref(false);
/** 当前路径是否为缓存采集源头（顶层根目录） */
const isCurrentCacheRoot = ref(false);
/** 仅在导航处于根缓存目录（是采集源头、非清单屏、且有有效路径）时允许开启 Flat 视图 */
const canToggleFlat = computed(() => isCurrentCacheRoot.value && !playlistLevel.value && !!currentPath.value);
/** 折叠决策（保首尾）。`null` = 全显。规则在 `@/utils` 的 `foldCrumbList` 里，可单独验证。 */
const crumbFold = computed(() => foldCrumbList(crumbs.value));
/**
 * 面包屑的**渲染布局**（head / `…` / tail）—— 折叠与不折叠都走这一份。
 *
 * ⚠️ 2026-11-08：原来模板里是 `v-if="crumbFold"` / `v-else` 两棵互斥的树，
 * 层级跨过 `max=4` 的那一下整棵子树被销毁重建 ⇒ 观感是"整排地址重新渲染"。
 * 推导逻辑在 `crumbRows.ts`（纯函数，可被 `docs/probes/crumbs/layout.mjs` 直接跑）。
 */
const crumbLayout = computed(() => buildCrumbLayout(crumbs.value, crumbFold.value));
/** 被折掉的中间层（给 `…` 的弹层用） */
const crumbHidden = computed(() => crumbFold.value?.hidden ?? []);
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
/**
 * 能被横幅接住的失败分类。**新增一种失败时只改这一处** ——
 * 原来那个 `err.kind === 'offline' || err.kind === 'unreadable'` 的条件写在 fetchFolder 里，
 * 多一种分类就要在那儿再加一个 `||`（漏了就是"失败了却什么都不说"）。
 */
const BANNER_KINDS = ['offline', 'unreadable', 'notCached', 'notFound'];

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
    if (!history.value.length) return '还没选文件夹 —— 点左上角那个图标选一个';
    // 清单屏的空态说的是另一件事：不是"目录里没东西"，是"还没收录过"，
    // 且要告诉用户下一步做什么（照 emptyTip 的既有原则：空态给动作，不给空白）
    if (playlistLevel.value) return '这个收藏夹还是空的 —— 在网格里右键卡片「加入收藏」即可收录';
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
const playlistLevel = computed(() => !!history.value[history.value.length - 1]?.pl);

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

const loadingBar = useLoadingBar();
const notify = useNotify();
const dialog = useConfirm();

/**
 * 文件大小 → 人类可读。
 *
 * 改成调用 `@/utils` 的 `formatBytes`（**一处实现**）：原来的实现只到 GB，
 * 而上限是它自己算出来的 `bytes / 1G % 1024` —— **取模**，1.83 TB 会显示成 `850.xxGB`、
 * 2 TB 直接变 `0.00GB`（静默说错数字）。`formatBytes` 支持到 PB，并且 0 显示 `—` 而不是 `0`。
 * 函数名保留不变（不改调用点）。
 */
const getSize = (size: number | undefined) => formatBytes(size);

/**
 * 封面底色：把同一张图放大、模糊、压暗铺在下面。
 *
 * 解决的是"`contain` 必然留白"：封面框固定 16:9，而缩略图比例五花八门，
 * 不裁切就一定有边（原来那些边露出的是 `--ff-fill` 的深灰，看着像卡里有个空洞）。
 * 用图片自己的放大模糊版填底 ⇒ **不裁切、也没有空隙**（B 站/YouTube 竖版封面同一手法）。
 *
 * 走 CSS 变量 + `::before`（见样式块）：不新增 DOM 节点，同一张图命中浏览器缓存、**不额外请求**。
 * 没有图的目录不设这个变量 ⇒ 保持原来的底色 + 文件夹图标。
 */
const coverBackdrop = (item: WiredFileInfo) => {
    const key = item.thumb || item.avatar;
    return key ? `--cover-src: url("${thumbUrl(key)}")` : undefined;
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

/** 右键 → 「加入收藏」：一键入默认清单。高频路径，不为它多弹一层 */
const addToFavorite = async () => {
    const item = ctxMenu.value.item;
    closeCtxMenu();
    if (!item) return;
    const pl = defaultPlaylist(playlistIndex().playlists);
    if (!pl) {
        notify('warning', '默认收藏夹还没就绪', '稍等一下再试');
        return;
    }
    // 已经在里面就别再发请求（服务端也会去重，这里只是省一次往返 + 给准确的话）
    if (pl.keys.includes(keyOf(item))) {
        notify('info', `已经在「${pl.name}」里了`, item.name);
        return;
    }
    try {
        await addToPlaylist(pl.id, snapshotOf(item));
        notify('success', `已加入「${pl.name}」`, item.name);
    } catch (e) {
        notify('error', '加入失败', String(e));
    }
};

/** 「加入收藏夹…」选单（右键菜单的第二级，原地展开在同一坐标） */
const plPicker = ref<{ visible: boolean; x: number; y: number; card: CardSnapshot | null; key: string }>(
    { visible: false, x: 0, y: 0, card: null, key: '' },
);

const openPlPicker = () => {
    const item = ctxMenu.value.item;
    if (!item) return;
    plPicker.value = {
        visible: true,
        x: ctxMenu.value.x,
        y: ctxMenu.value.y,
        card: snapshotOf(item),
        key: keyOf(item),
    };
    closeCtxMenu();
};

const onPickerAdded = (name: string) => {
    plPicker.value.visible = false;
    notify('success', `已加入「${name}」`);
};

const onPickerFailed = (msg: string) => {
    plPicker.value.visible = false;
    notify('error', '加入失败', msg);
};

/** 清单屏右键 → 「从收藏夹移除」。只动清单（系统盘 JSON），不碰盘、不碰文件 */
const removeFromCurrentPlaylist = async () => {
    const item = ctxMenu.value.item;
    const top = history.value[history.value.length - 1];
    closeCtxMenu();
    if (!item || !top?.pl) return;
    try {
        await removeFromPlaylist(top.pl.id, keyOf(item));
        // 重取这一屏 —— 走 loadScreen 唯一出口，不本地摘条目：
        // dataSource 的写入口保持只有一个（fetch 那条路），不新开第二种写语义
        loadScreen(top);
    } catch (e) {
        notify('error', '移除失败', String(e));
    }
};

/**
 * 「补封面」写盘完成后的刷新。与 onRefresh 的区别：**不带 noCache** ——
 * apply 已经把写过的目录缓存删掉了，正常取数会真读一次盘、把新封面收进来再建缓存；
 * 再带 noCache 等于把刚建的缓存又删一遍重读，纯浪费。
 * 盘不在（只读层）时 apply 根本写不了，不用刷。
 */
const refreshAfterApply = () => {
    const cur = history.value[history.value.length - 1];
    // loadScreen 分派：目录屏重取（apply 只可能发生在目录屏），清单屏原样重取（幂等）
    if (cur && !readOnlyLevel.value) loadScreen(cur);
}

/**
 * 弹「这个封面下有哪几个文件」那一层。**双击与回车共用这一个出口。**
 *
 * 为什么要抽出来：原来这段写在 `handleOpen` 里，坐标取自 `e.clientX/Y`。
 * 键盘 `Enter` **没有事件对象** ⇒ 不抽的话，键盘打开多文件封面会**毫无反应**
 * （静默失败：按了回车，屏幕上什么也没发生）。
 *
 * @param x,y 弹层左上角的视口坐标。鼠标路径传事件坐标，键盘路径传卡片中心。
 */

/**
 * 弹「这个封面下有哪几个文件」那一层。**双击与回车共用这一个出口。**
 *
 * 为什么要抽出来：原来这段写在 `handleOpen` 里，坐标取自 `e.clientX/Y`。
 * 键盘 `Enter` **没有事件对象** ⇒ 不抽的话，键盘打开多文件封面会**毫无反应**
 * （静默失败：按了回车，屏幕上什么也没发生）。
 *
 * @param x,y 弹层左上角的视口坐标。鼠标路径传事件坐标，键盘路径传卡片中心。
 */
const openFileList = (item: WiredFileInfo, x: number, y: number) => {
    if (!isMultiFileCard(item)) return;
    popover.value.visible = true;
    popover.value.x = x;
    popover.value.y = y;
    popover.value.files = item.files;
    popover.value.cover = item;
    fileCursor.value = 0;
    // ⚠️ `nextTick` 是必需的：这一层是 `:show` 驱动的，此刻 DOM 还没渲染出来，
    // 直接 focus 落空（`null`）⇒ 方向键就穿透到网格去了。
    void nextTick(() => fileListBox.value?.focus());
};

/**
 * 弹层内的键盘。**只管这一层，不碰网格。**
 *
 * 隔离靠两件事，都是结构性的、不靠额外判断：
 * ① 监听挂在弹层容器上并 `.stop` ⇒ 事件不会冒泡到 window，网格的监听**收不到**
 * ② 焦点在这一层里 ⇒ 即使事件漏过去，`isGridKeyBlocked` 的 `target !== body` 也会挡住
 *
 * ↑↓ 到头**停住**（不环绕）：这是一份"选哪个文件"的短列表，环绕会让人点错文件。
 */
const onFileListKeydown = (e: KeyboardEvent) => {
    const n = popover.value.files.length;
    if (!n) return;
    /**
     * ⚠️⚠️ **主轴是「左右」**（业主 2026-10-05 八次报：「这个弹出层的方向键应该用左右而不是上下」）。
     *
     * 判据很简单：**键要跟着布局走**。这一层的内容容器是 `.hstack`
     * （`display:flex; flex-wrap:wrap`）⇒ **横向排布，主轴是左右**。
     * 而原来只绑了 `ArrowUp` / `ArrowDown` —— **上下键在一行横排里按"上下"移动**，
     * 方向与视觉完全不符（按 ↓ 却往右跳一格）。
     *
     * ⚠️ 为什么上下**也保留**（不删）：它是**别名**，不是第二个方向。
     * 这一层装的是"同一部作品的多个文件"，通常**只有一行**
     * ⇒ 此时"前一个/后一个"与"上/下"是**同一件事**，两种键都该有效（列表控件的通行做法）。
     * ⚠️ 真换行了（文件特别多）时上下会失去意义 —— 但那种情况下**左右也只在行内移动**，
     *   两个都不完美；不值得为这个罕见场景引入"按行高判断该用哪组键"的复杂度。
     */
    const prev = () => { fileCursor.value = Math.max(fileCursor.value - 1, 0); e.preventDefault(); };
    const next = () => { fileCursor.value = Math.min(fileCursor.value + 1, n - 1); e.preventDefault(); };
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        next();
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        prev();
    } else if (e.key === 'Enter') {
        // ⚠️ `e.repeat` 必须挡：长按回车会**重复打开同一个文件**
        // （实测按住 1 秒 = 33 次 keydown）⇒ 33 个播放器进程。
        // ← → 相反，**要** repeat（长按连续选是想要的）。
        if (e.repeat) return;
        const f = popover.value.files[fileCursor.value];
        if (f) openFile(f.name);
        e.preventDefault();
    } else if (e.key === 'Escape') {
        closeFileList();
        e.preventDefault();
    }
};

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
 * 网格里按 Enter：只负责派发动作，判据在 openDecision.ts（纯函数，探针与产品共用）。
 * ⚠️ open-item 必须传 item，不能传 item.files[0].name：openFile 字符串分支靠 popover.cover 算父目录，这里没开弹层 cover 是上次残留会开错文件；item 分支"双击封面=打开视频"正为此场景而写。
 */
/** 回车打开文件的最小间隔（误触保护，主人 2026-11-09 定 2s）：播放器进程起来要一两秒，
 *  期间再按回车 = 又起一个进程。只锁 open-item，不锁目录 drill（导航不能被 2s 卡住）。 */
const ENTER_OPEN_MIN_MS = 2000;
let lastEnterOpenAt = 0;

const onCursorConfirm = (item: WiredFileInfo) => {    if (picking.value) {
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
 * 离开当前屏之前，把"这一屏的样子"记在**它自己**身上。
 *
 * 记三样：**滚动位置 + 搜索词 + 选择器停在哪**。
 * 原来是"滚动位置写进 `openStack` 的元素、搜索词压进另一个平行的 `searchStack`"，
 * 两处必须同步、长度还得差 1。现在都写在同一个对象上，不可能错位。
 *
 * ⚠️ 2026-10-04 补 `cursorKey`：只恢复滚动、不恢复选择器时，返回后屏幕停在
 * 原来那一屏的中间、选择器却跳回视口第一行 ⇒ **自相矛盾**，比"丢失"更糟
 * （用户会以为程序随机跳格）。见 `NavEntry.cursorKey` 的注释。
 */
const rememberCurrentScreen = () => {
    const cur = history.value[history.value.length - 1];
    if (!cur) return;
    cur.scrollY = imageBox.value?.scrollTop ?? 0;
    cur.searchText = searchText.value;
    cur.cursorKey = cursorKey.value;
}

/**
 * 进入某一屏：所有导航动作都必须从这里过（记旧屏 → 压新屏 → 归零视口 → 取数 → 清搜索词只写一遍）。
 * ⚠️ 必须显式归零滚动：NavEntry.scrollY=0 只是数字，容器 scrollTop 不会自己归零 ⇒ 进新屏会停在上一屏的偏移（与面包屑矛盾）。
 * ⚠️ 归零要在取数之前（内容没渲染时 scrollTo 会被 clamp 或作用在旧内容上）。
 */
const enterScreen = (path: string, mode: OpenMode = 'cover', pl?: NavEntry['pl'], keepFlat?: boolean) => {
    rememberCurrentScreen();
    // 新的一屏**从零开始**：选择器不继承上一屏的（它属于那一屏，不属于这一屏）
    // pl = 清单屏标记（2026-10-21）：与 path 上的 `@pl:<id>` 前缀同进同退
    history.value.push({ path, mode, pl, searchText: '', scrollY: 0, cursorKey: '' });
    isFlatView.value = !!keepFlat;
    isCurrentCacheRoot.value = false;
    // 进新的一屏不带上一屏的搜索词（原有行为，不动）
    searchText.value = '';
    /**
     * 声明"用户在这一屏需要焦点" ⇒ 加载完自动落焦点。
     *
     * ⚠️⚠️ **必须放在 `searchText.value = ''` 之后**（业主 2026-10-04 二次报"还是要点一下"）。
     * 原因：`fileList` 是 `computed(… filterByName(dataSource, searchText))` ——
     * 清空搜索词**本身就会让列表变一次**（从"筛过的 N 条"变成"全部 M 条"）⇒ 指纹变了
     * ⇒ `useGridCursor` 里那个 watch 触发 ⇒ **`takeIntent()` 把 armed 消费掉了**。
     * 于是等真正的 `dataSource` 换新（fetchFolder 成功）时 armed 已是 false
     * ⇒ **焦点永远不落**。而"点一下"能用，是因为 `onItemClick → focusCursor` 直写 `cursorKey`。
     *
     * ⇒ 顺序即依赖：任何**会引起列表变化**的动作做完之后，才声明意图。
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
    const done = loadScreen(history.value[history.value.length - 1], isFlatView.value);
    const myFetchSeq = fetchSeq;

    /**
     * 视口归零的**第二次**（取数落地后再压一次 —— 内容替换会让偏移漂移）。
     *
     * ⚠️ 判据必须问「**我还是不是最新那次请求**」，而不是「当前栈顶是不是我去的那个路径」。
     * `path` 相等只说明"我和别人去了同一个地方"，不等于"我是最新的"：
     * A→B→A 连点两次时，第一个 A 的响应回来时栈顶也是 A ⇒ path 判据会放行
     * ⇒ 归零把第二次 A 的视口抹掉。
     *
     * `fetchFolder` 自己用 `seq !== fetchSeq` 挡了"过期响应写 dataSource"，
     * 但它**不把序号告诉调用方** ⇒ 这里自己取一次比。
     * ⚠️ `fetchSeq` 声明在本文件下方（模块顶层先声明后赋值）—— 读它发生在 `enterScreen` 体内，
     * 而 `enterScreen` 只能被 setup 之后的事件调用 ⇒ 运行时已初始化，**不是 TDZ**。
     *（这个顺序是刻意的：别把 `const myFetchSeq` 提到 `fetchFolder` 之前。）
     */
    void done.then(() => {
        if (fetchSeq !== myFetchSeq) return;   // 已被更新的请求接管 ⇒ 不碰别人的视口
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
 * 右键卡片 → 光标处弹极简菜单。复制磁盘文件名（含扩展名，见 fileNameOf）。
 * ⚠️ .prevent 必须带，否则 Electron 原生右键菜单会叠加；去后缀那份用 item.name（服务端 name/ext 分开给），别自己找最后一个 . —— 多后缀 xxx.tar.gz 会剥错。
 */
/**
 * 关掉右键菜单，并把焦点收回 body。
 * ⚠️ 必须主动 blur：菜单 :show / v-show 关掉后按钮 display:none，但 activeElement 仍停在它上面 ⇒ 方向键失效且难排查。
 */
const closeCtxMenu = () => {
    ctxMenu.value.visible = false;
    (document.activeElement as HTMLElement | null)?.blur?.();
};

/**
 * 右键菜单内的按键。**只有 Esc 有用**，其余一律吞掉。
 *
 * 为什么需要它（不能只靠 `@keydown.stop`）：`stop` 只保证事件不到 window，
 * 但**方向键/回车在这个容器里按下去仍然什么也不该发生** —— 显式吞掉是给未来留的
 * 护栏（将来给这个菜单加键盘导航时，这里就是入口）。
 *
 * ⚠️ `Esc` 关掉菜单时**顺手收回焦点**（与 `closeCtxMenu` 同一个理由）。
 */
const onCtxMenuKeydown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
        closeCtxMenu();
        e.preventDefault();
    }
    // 其余键：不处理，但也不让它们到网格（`@keydown.stop` 已经拦了冒泡）
};

const onContextMenu = (e: MouseEvent, item: WiredFileInfo) => {
    ctxMenu.value.visible = true;
    ctxMenu.value.x = e.clientX;
    ctxMenu.value.y = e.clientY;
    ctxMenu.value.name = fileNameOf(item);
    ctxMenu.value.stem = item.name;
    ctxMenu.value.mode = 'card';
    // 2026-10-21 清单功能：连带记住这张卡 —— 「加入收藏 / 加入收藏夹…」的快照来源
    ctxMenu.value.item = item;
};

/**
 * 空白处的右键：只有**目录工具组**（补全/重读/补封面/头像回收/站点规则/换封面）——
 * 文件组与收录组都依赖"这一张"，空白处没有这一张。
 * 卡片自己的右键会冒泡上来，用 closest 判掉：卡片由 onContextMenu 处理，这里只管空白。
 */
const onBlankContextMenu = (e: MouseEvent) => {
    if ((e.target as HTMLElement).closest('.image-box-item')) return;
    ctxMenu.value.visible = true;
    ctxMenu.value.x = e.clientX;
    ctxMenu.value.y = e.clientY;
    ctxMenu.value.mode = 'blank';
    ctxMenu.value.item = null;
};

/**
 * 菜单项「复制文件名」：把文件名交给主进程的 `copyText`（沿用 openFile 那条 IPC 通道）。
 * 先关菜单再复制：菜单是手动定位的浮层，留着会挡着后面的操作；
 * 并且复制是用户手势内发的，关掉它不影响 clipboard 写入。
 *
 * ⚠️ 2026-11-09 主人裁定：只留**去后缀**这一种（贴到搜索框找片用的 —— 那里带 `.mp4`
 *    搜不到），名字就叫「复制文件名」；带后缀的那种删除。
 */
const copyNameStem = async () => {
    const stem = ctxMenu.value.stem;
    closeCtxMenu();          // 同上：收回焦点
    if (!stem) return;
    const err = await ipcRenderer.invoke('copyText', stem);
    if (err) notify('error', '复制失败', String(err));
    else notify('success', '已复制文件名', stem);
};

/** 菜单项「复制文件地址」：完整磁盘路径（fullPathOf，含当前盘符）。只读层是锚点、没有真路径 ⇒ 禁用。 */
const copyPath = async () => {
    const item = ctxMenu.value.item;
    closeCtxMenu();
    if (!item) return;
    const full = fullPathOf(item);
    const err = await ipcRenderer.invoke('copyText', full);
    if (err) notify('error', '复制失败', String(err));
    else notify('success', '已复制文件地址', full);
};

/** 菜单项「打开所在文件夹」：资源管理器里定位这个文件（showItemInFolder 会选中它）。 */
const revealInFolder = async () => {
    const item = ctxMenu.value.item;
    closeCtxMenu();
    if (!item) return;
    const err = await ipcRenderer.invoke('ff-reveal-item', fullPathOf(item));
    if (err) notify('error', '打开失败', String(err));
};

/**
 * 只取数放进 dataSource，不改别的状态（清空 / 恢复搜索词交给导航动作）。
 * ⚠️ 渲染层别按 path+mode 缓存列表：盘符会复用，缓存会绕过服务端每次 stat 对"盘符现在主人"的复核。
 */
/**
 * 请求序号：只有最新一次请求的响应能写进 dataSource。
 * ⚠️ 判断放在唯一写入点，别在各导航入口各补 loading 守卫 —— 新增入口会漏、全局锁还会冻住整个导航。
 */
let fetchSeq = 0;

const fetchFolder = (path: string, mode: OpenMode, noCache?: boolean, flat?: boolean) => {
    const seq = ++fetchSeq;
    loading.value = true;
    failKind.value = '';
    loadingBar.start();

    // 纯内存异步查询当前目录是否为缓存采集源头（顶层根目录），非根目录自动复位 Flat 状态
    getAction(`${API_BASE}/isCacheRoot?path=${encodeURIComponent(path)}`).then((res: { isRoot?: boolean }) => {
        if (seq !== fetchSeq) return;
        isCurrentCacheRoot.value = !!res?.isRoot;
        if (!isCurrentCacheRoot.value && isFlatView.value) {
            isFlatView.value = false;
        }
    }).catch(() => {
        if (seq !== fetchSeq) return;
        isCurrentCacheRoot.value = false;
    });

    // path 必须编码：中文/空格/&/#/+ 会让 query 被截断或误解析
    let url = `${API_BASE}/openFolder?path=${encodeURIComponent(path)}&mode=${mode}`;
    if (noCache) url += '&noCache=true';
    const useFlat = flat ?? (canToggleFlat.value && isFlatView.value);
    if (useFlat) url += '&flat=true';

    // 必须 return：调用方要等数据真的落地才能做后面的事（恢复滚动位置）
    return getAction(url).then((data: WiredFileInfo[]) => {
        // 过期响应：已经不是最新那次请求了 —— 什么都不做。
        // `loadingBar` 的收尾也要跳过，否则它会替最新那次提前收尾
        if (seq !== fetchSeq) return;
        dataSource.value = data;
        loadingBar.finish();
    }).catch(err => {
        if (seq !== fetchSeq) return;
        console.error('[openFolder] 请求失败:', err);
        // 只认服务端在 `BANNER_KINDS` 里明确给的那几种分类；其余（网络断、服务没起来、
        // 路径非法）统一算「其他失败」—— 不显示横幅，靠那条 toast 就够了
        failKind.value = err instanceof ApiError && BANNER_KINDS.includes(err.kind)
            ? err.kind
            : 'other';
        loadingBar.error();
        if (failKind.value === 'notFound') {
            dataSource.value = [];
        }
        // 取数失败**必须说出来**：原来只有顶部进度条闪一下红，而 dataSource 会保留
        // 上一个目录的列表 —— 面包屑已经切到新目录、格子里却是旧内容，
        // 用户没有任何线索。这里不清空 dataSource（网络抖一下不该丢掉整个列表），
        // 所以那条提示是用户区分「这是新内容」和「这还是旧内容」的唯一依据。
        notify('error', '打开失败', String(err));
    }).finally(() => {
        // 同理：过期请求不许关 loading，否则最新那次还在飞、转圈却停了
        if (seq === fetchSeq) loading.value = false;
    });
}

/**
 * 清单屏取数（2026-10-21 收藏分类）。
 *
 * 与 `fetchFolder` **共用 `fetchSeq`**（模块级序号）⇒「目录 → 清单 → 目录」
 * 连点切换时，过期响应写不进来 —— 防的是"面包屑已切到清单、网格里还是目录"。
 * 数据来自系统盘的 playlists.json（服务端逐条判盘在不在，在线给实时路径、
 * 离线给锚点）⇒ **零读盘**。错误形状与 fetchFolder 逐字同构（failKind + 同一条 toast）。
 */
const fetchPlaylistItems = (id: string) => {
    const seq = ++fetchSeq;
    loading.value = true;
    failKind.value = '';
    loadingBar.start();

    return getPlaylistItems(id).then((data: PlaylistDetail) => {
        if (seq !== fetchSeq) return;
        dataSource.value = data.items ?? [];
        loadingBar.finish();
    }).catch(err => {
        if (seq !== fetchSeq) return;
        console.error('[playlistItems] 请求失败:', err);
        failKind.value = 'other';
        loadingBar.error();
        notify('error', '打开失败', String(err));
    }).finally(() => {
        if (seq === fetchSeq) loading.value = false;
    });
};

/**
 * 加载某一屏的**唯一出口**：目录屏走 `fetchFolder`，清单屏走 `fetchPlaylistItems`。
 *
 * 为什么必须收成一个口：取数调用点原有 6 个（进入 / 返回 / 刷新 / apply 后 /
 * 扫描收尾 / 换盘降级），逐点加 `if (entry.pl)` 就是 6 处分支 —— 漏一处的症状是
 * "面包屑显示清单、网格里还是目录内容"，而那正是项目明令禁止的**补丁形态**。
 * 责任收在唯一出口之后，第 7 个入口也忘不掉。
 * （onRefresh 有 playlistLevel 守卫、永不到清单屏；onDisksChanged 自己已按屏型分派。）
 */
const loadScreen = (entry: NavEntry, flat?: boolean) => {
    if (entry.pl) return fetchPlaylistItems(entry.pl.id);
    return fetchFolder(entry.path, entry.mode, false, flat);
};


const onBack = async () => {
    if (history.value.length <= 1) return;
    history.value.pop();
    const to = history.value[history.value.length - 1];
    // 恢复这一屏的搜索词。fileList 是 computed，词一变列表自己会重新筛——
    // 不需要（也不能）再手动调一次过滤
    searchText.value = to.searchText;
    // 恢复选择器。⚠️ **必须与scrollY 一起恢复** —— 只恢复滚动会让屏幕停在原来那一屏的
    // 中间、选择器却跳回视口第一行（自相矛盾）。见 `NavEntry.cursorKey` 的注释。
    // 那个 key 若不在这一屏里，`cursorItem` 是 undefined ⇒ 不画高亮，
    // 且下面那个指纹 watch 会发现"没有有效焦点" ⇒ 自动落一个到视口第一行。
    //
    // ⚠️⚠️ **必须声明"这一屏需要焦点"**（业主 2026-10-04 真机报"回来就不对，没记住"）。
    // `dataSource` 换新会触发 `useGridCursor` 里的指纹 watch，那个 watch 只在
    // `armed` 为真时才落焦点。而 `armed` 是**一次性**的 —— 进子目录时 `enterScreen`
    // 调过一次 `noteIntent()`，**返回时没有人再调** ⇒ `armed` 已是 false
    // ⇒ 恢复出来的 key 若不在这屏（`cursorItem` 为 undefined），就**没人补一个焦点**
    // ⇒ 键盘用户在这一屏上完全失能（按方向键会激活，但那得先知道要按方向键）。
    //
    // ⇒ 顺序即依赖：必须在**会引起列表变化**的动作（`searchText` 赋值）**之后**才声明，
    // 否则会被那个 watch 提前消费掉（同 `enterScreen` 里那条纪律）。
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
     * `fetchFolder` 自己用 `seq !== fetchSeq` 挡住了过期响应写 `dataSource`，
     * 但它**不把序号告诉调用方** ⇒ 这里自己取一次比（同 `enterScreen` 的理由）。
     */
    const done = loadScreen(to);
    const myFetchSeq = fetchSeq;
    await done;
    /**
     * 恢复滚动位置：必须等 DOM 真的换成新屏再 scrollTo。
     * ⚠️ "回读确认"只证明滚到位置、不证明滚在正确内容上；只等 fileList 不够（dataSource 在 then 里就换、一帧没等 ⇒ 打在旧屏 DOM）。判据用列表指纹：数据第一条 === DOM 第一条时，才说明新内容铺好了。
     */
    /**
     * 恢复必须无条件执行，包括"恢复成 0"（onBack 绕过 enterScreen，容器偏移会一直带着上一屏的）。
     * ⚠️ 归零不用等 DOM（scrollTop=0 任何内容都成立）；恢复非 0 才必须等 DOM，否则旧屏上滚成功、回读一致，新内容铺上来白搭。
     */
    const box = imageBox.value;
    if (!box) return;
    if (!to.scrollY) {
        // 过期请求不许碰视口（理由见上面 `myFetchSeq` 那段）
        if (fetchSeq !== myFetchSeq) return;
        box.scrollTo(0, 0);
        return;
    }
    const ready = await waitForGridOf(to.path);
    /* ⚠️ **再查一次**：`waitForGridOf` 最多等 20 帧，它本身就是第二个窗口。 */
    if (fetchSeq !== myFetchSeq) return;
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

/**
 * 等到「DOM 里的第一条」已经是目标屏为止（数据与 DOM **两者对上**才算）。
 *
 * ## 为什么需要它（`onBack` 恢复 scroll 的前置条件）
 *
 * `fetchFolder` 只保证**数据**换新（`dataSource.value = data`），
 * **不保证 DOM 已 patch** ⇒ 那一刻量 `scrollHeight` / `scrollTo` 都是在**旧内容**上做的。
 * ⚠️ 而"旧内容也能滚到那个位置、回读也一致" ⇒ **回读确认抓不到这个问题**。
 *
 * ## 判据：**列表里第一条的 `dir`**（不是"等几帧"）
 *
 * `keyOf` = `${item.dir}/${item.name}` ⇒ 条目自带它属于哪个目录。
 * `fileList` 是 `computed(dataSource 过滤后)`，它一换新屏，`fileList[0].dir` 就换成新屏的目录。
 * ⇒ **"第一条的 dir 等于目标 path"= 新屏内容已就位** —— 这是**事实**，不是碰运气。
 *
 * ⚠️ 为什么不能"等固定几帧"：新屏内容够不够长、渲染耗时都不确定，
 *   固定帧数要么不够（白等）、要么多余（白等）；而这个判据**要么成立要么不成立**，没有中间态。
 * ⚠️ 空列表**不能**判"已就位"（`fileList[0]` 不存在）—— 那时列表是空的，
 *   滚动位置无从谈起，也不该在这里等（空目录本来就没得滚）。
 *
 * @param path 目标屏路径
 * @param maxFrames 最多等几帧（兜底防死循环；正常情况 1 帧内成立）
 * @returns 是否在 maxFrames 内就位
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
         * `history` 里记的值是对的（800），但诊断报"未就位" ⇒ 说明问题在判据，不在记录。
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
    const cur = history.value[history.value.length - 1];
    if (cur) {
        await fetchFolder(cur.path, cur.mode, false, isFlatView.value);
    }
};

const onRefresh = () => {
    // 只读层没有"重读"这回事：它的源就是缓存，盘不在，F5 也读不出新东西。
    // 拦住而不是让服务端静默回一份缓存 —— 静默最坏（用户以为他重读过了）。
    // 清单屏同理：它的源是系统盘上的收录快照，没有"重读硬盘"这个动作。
    if (loading.value || !history.value.length || readOnlyLevel.value || playlistLevel.value) return;
    const cur = history.value[history.value.length - 1];
    // F5 = 重新扫盘，要带 noCache 让服务端把这条缓存删掉真去读盘，
    // 不然"刷新"只是把同一份缓存又发了一遍。
    // 搜索词不用管：fetchFolder 已经不碰它了
    fetchFolder(cur.path, cur.mode, true);
}

/**
 * 换根 / 清空根。**这是唯一"重新开始"的入口**，与「跳转」严格分开：
 * 这里清空历史（你真的换了个地方）；跳转保留历史（你只是去看看，返回随时能回来）。
 * 这两件事原来混在同一个 `handleDirChange` 里，是"返回体验怪"的根因之一。
 */
const setRoot = (value: string) => {
    isFlatView.value = false;
    isCurrentCacheRoot.value = false;
    if (!value) {
        dir.value = '';
        history.value = [];
        // 清掉文件夹选择就该把这个文件夹的内容也清掉，
        // 否则界面上留着上一个目录的东西，而选择框已经空了
        dataSource.value = [];
        searchText.value = '';
        /**
         * ⚠️ `failKind` **必须一起清**（2026-10-05 code review 抓到）。
         *
         * 它描述的是"**当前这一屏**取数失败了"，而上面刚把"当前这一屏"整个拿掉
         *（`history = []`）⇒ 留着它就是在陈述一个已经不存在的对象。两处后果：
         *  ① `banner` 继续显示"移动硬盘不在…插好后按 F5 重读"，而 F5 已因
         *     `!history.value.length` 被拦掉（见 `onRefresh`）⇒ **文案指向一个不存在的操作**；
         *  ② `emptyTip` 的守卫把 `loadFailed` 排在 `!history.length` **前面**
         *     ⇒ 那句"还没选文件夹"永远显示不出来 ⇒ 用户落在**纯空白页**上。
         *
         * 缓解面：这条路以前只有 chip 上的 × 走得到；2026-10-05 加了「清空」按钮之后，
         * 它变成"在任意一屏一键可达" ⇒ 必须在这里收口（唯一的状态复位点）。
         */
        failKind.value = '';
        return;
    }
    dir.value = value;
    history.value = [];
    // 首层也用 cover。cover 模式才会对子目录调 handleCover（收敛成封面条目）；
    // 原来首层写的是 folder，而 folder 模式**根本不会调用 handleCover** ——
    // 结果是「封面收敛」只在点进去之后的第二层生效，第一层永远只看到一堆文件夹图标，
    // 而第二层反而显示封面。同一个规则两层表现不一致，所以首层也统一成 cover。
    enterScreen(value, 'cover');
}

/**
 * 栈底按钮：清空导航历史，回到"还没选文件夹"的界面。
 * ⚠️ 走既有出口 setRoot('')，别自己发明清栈逻辑；代价是当前视图 + 整个历史 + 搜索词一起重置、不可撤销。
 * ⚠️ 只挂这个显式按钮，绝不绑 Backspace（门槛 ∝ 不可逆 × 波及面）；只重置导航态，不删缓存 / 缩略图 / 扫描结果。
 */
const clearNav = () => setRoot('');

/* ── 「返回 / 清空」= 同一颗按钮，只换**图标**（2026-11-08 顶栏升级）────────────
 * 原来是"两个同宽的中文词"（`返回` / `清空`），靠字数相同保证宽度不变。
 * 换成 28px 固定方格的图标按钮之后这条约束**更强**：换字形连 1px 都不动，
 * 而 `←` / `⨯` 的形状差异比两个汉字更容易在余光里分辨。
 *
 * 三态（判据是 `history.length` 这个**事实**，不是 `dir` 那个"曾经选过根"的快照）：
 *   >1 → `←` 返回上一屏（`onBack`）
 *   =1 → `⨯` 清空导航历史（`clearNav`）—— 栈底也得有出口（业主 2026-10-05）
 *   =0 → `←` **置灰常驻**：还没选根，无屏可谈。不再 `v-if` 消失 ——
 *        它一出现/消失就把整条面包屑推走 ~60px，正是本版要修掉的那类跳动。
 * ⚠️ Backspace **仍然只走 `onBack`**（栈底是空操作）——
 *    不把清空挂上去，就不会出现"在根层误按退格把视图清掉"。
 */
const navBtnText = computed(() => (history.value.length > 1 ? '返回' : history.value.length === 1 ? '清空' : '返回'));
const navBtnIcon = computed(() => (history.value.length === 1 ? CloseOutline : ArrowBackOutline));
const navBtnTip = computed(() => (history.value.length > 1
    ? '返回上一屏（Backspace）'
    : history.value.length === 1
        ? '清空导航历史，回到选文件夹的界面（缓存不动）'
        : '还没选文件夹'));
const onNavBtn = () => (history.value.length > 1 ? onBack() : clearNav());

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
 * 批量扫描「这一片」（P1）。两个入口共用它，`rescan` 是唯一差别：
 *   · 「补全这一片」→ 只扫还没缓存的目录
 *   · 「重读这一片」→ 忽略缓存，整片重读一遍
 *
 * 一句话：把「还没缓存的目录」排队扫完 —— 串行、可取消、带进度、每批让一次。
 *
 * 为什么要有它：目标树是「80+ 子目录、还嵌套、合计 500–1000 部片子」，一个个点开不现实。
 * 但"主动读"必须**串行 + 分批** —— 这不是性能优化，是硬件保护：2.5″ 移动盘铭牌
 * 5V/1A，而 USB 3.0 口只有 0.9A，长时间连续读最容易掉压掉盘
 * （见 docs/UPGRADE-PLAN-2026-09-24.md §1.3）。
 *
 * ⚠️ 下面这一整块**绝不碰** `dataSource` / `loading` / `loadingBar`。那三个是
 * "用户眼下正在看的这一层"的状态；后台扫到哪个目录就往那里写一次，用户眼前的网格
 * 会被扫过的目录反复顶掉（方案 §16.1 第 1 条点名的坑）。
 */

/** 扫描一律用 cover 模式：界面三条入口（选文件夹 / 缓存记录 / 网格下钻）全都用 cover */
const SCAN_MODE: OpenMode = 'cover';

/**
 * 每扫这么多个目录，主动让出一次事件循环。
 * 挡住 USB 供电峰值的主力是**串行**（一次一个目录）；让出是为了别让主进程长时间
 * 不给界面机会 —— 也才有响应"取消"的窗口。
 */
const SCAN_BATCH = 20;

const scanning = ref(false);
/** 已真扫的目录数。**缓存命中的不算** —— 那种没有碰盘 */
const scanDone = ref(0);
/** 待扫的目录数。**动态的**：每展开一层，新发现的子目录就加进来 */
const scanPending = ref(0);

/**
 * 「已经按过取消，正在等当前这个目录扫完」。
 *
 * 取消是**软取消**：只在目录边界生效（`scanCancelled` 那条注释解释了为什么不做硬中断），
 * 而一个目录在冷态移动硬盘上可能要好几个 10 秒 —— 点击之后界面上毫无动静，
 * 用户只会得出"这个按钮没用"的结论。这个状态就是用来把那段时间**说出来**的：
 * 按钮当场变「正在取消…」并置灰（防重复点），旁边补一句"当前这个目录扫完就停"。
 *
 * 它是**渲染态**（要显示），所以是 ref —— 和纯循环标志 `scanCancelled` 分工不同。
 */
const cancelling = ref(false);

/**
 * 取消标志。
 * 用普通变量而不是 ref：它只在这个组件的扫描循环里读写，不参与渲染，
 * 而每个目录边界都要重新读一次 —— 用 ref 只是多一层解包。
 */
let scanCancelled = false;

/**
 * 批量扫描专用的取数：**只往返，不写任何界面状态**。
 *
 * 为什么不复用 `fetchFolder`（方案 §16.1 第 1 条）：那个函数会写
 * `dataSource` / `loading` / `loadingBar`。后台每扫一个目录就写一次，
 * 用户正在看的网格会被那个目录的内容顶掉，进度条也会跟着乱闪。
 */
const requestFolder = (path: string, noCache: boolean) =>
    getAction(`${API_BASE}/openFolder?path=${encodeURIComponent(path)}&mode=${SCAN_MODE}${noCache ? '&noCache=true' : ''}`) as Promise<WiredFileInfo[]>;

/**
 * 把 `盘符:路径` 拆成「盘符 + 盘内相对路径」。
 *
 * 渲染层不能从 `electron/utils/driveIdentity` 导入 `splitPath` —— 那会把 `node:fs`
 * 拖进渲染层（和上面 `VIDEO_EXT_RE` 不能从 server 导入值是同一个原因），所以这里重写一份。
 */
const splitDrive = (fullPath: string) => {
    const m = /^([A-Za-z]):[\\/]?(.*)$/.exec(fullPath);
    return m ? { drive: m[1].toUpperCase(), relPath: (m[2] || '').replace(/\\/g, '/') } : null;
};

/**
 * 开扫之前先取两样东西：
 *   · 已缓存集合 —— `/getHistory` 分页取全，键是 `(serial, relPath)`
 *   · 盘符 → 卷序列号 —— 缓存键里存的是序列号，盘符只是"当前挂载点"
 *
 * 拼不出序列号（UNC / 网络位置 / 虚拟盘）的目录一律当"没缓存"处理，见下面 `keyOf`。
 */
const fetchScanContext = async (targetDrive?: string, targetRootRel?: string) => {
    const disks = await getAction(`${API_BASE}/getDisks`);
    const serialOf: Record<string, string> = {};
    for (const d of disks?.disks ?? []) {
        if (d.drive) serialOf[String(d.drive).toUpperCase()] = d.serial;
    }

    const keys = new Set<string>();
    const subtreeRecords: { id: string; relPath: string }[] = [];
    const targetSerial = targetDrive ? serialOf[targetDrive.toUpperCase()] : null;
    const normRoot = (targetRootRel ?? '').toLowerCase();

    const PAGE = 200;
    for (let pageNo = 1; ; pageNo++) {
        const res = await getAction(`${API_BASE}/getHistory?pageNo=${pageNo}&pageSize=${PAGE}`);
        for (const r of res?.records ?? []) {
            const normRel = (r.relPath || '').toLowerCase();
            keys.add(`${r.serial}|${r.relPath}`.toLowerCase());

            if (targetSerial && r.serial === targetSerial && r._id) {
                const inSubtree = normRoot === ''
                    ? true
                    : (normRel === normRoot || normRel.startsWith(normRoot + '/'));
                if (inSubtree) {
                    subtreeRecords.push({ id: r._id, relPath: r.relPath });
                }
            }
        }
        if (!res?.records?.length || pageNo * PAGE >= (Number(res?.total) || 0)) break;
    }

    return { serialOf, keys, subtreeRecords };
};

/**
 * 跑一轮扫描。`rescan` 就是两个模式的**全部**差别（方案 §16.1：同一套队列多一个 flag）。
 *   · false →「补全这一片」：不带 noCache，服务端命中有缓存就只回缓存、不碰盘
 *   · true  →「重读这一片」：每层都带 noCache=true，忽略缓存重新读一遍
 *     —— 这就是"目录增删改之后"的答案，不需要去做变更检测
 *
 * ⚠️ **"跳过已缓存"这件事由服务端那一个出口保证**（`openFolder` 里的 `findCache`），
 * 上面那份集合只用来把"已扫 n"数准。不在前端"看到已缓存就跳过整个子树"是有意的：
 * 已缓存的目录下面**仍然可能有没缓存的子目录**，把子树剪掉就永远补不全。
 * （实测：`E:/sample/videos/示例演员E` 已缓存，而它自己下面还有 2 个子目录从未被扫过。）
 */
const startScan = async (rescan: boolean) => {
    const root = currentPath.value;
    if (!root || scanning.value) return;

    scanning.value = true;
    scanCancelled = false;
    cancelling.value = false;
    scanDone.value = 0;
    glow.value = rescan ? 'rescan' : 'fill';
    glowKey.value += 1;

    // 深度优先。队列里放**完整路径** —— 服务端要的就是这个（它自己会拆成盘内相对路径）
    const queue: string[] = [root];
    /**
     * 已入过队的目录（小写归一化）。
     *
     * 防的是**目录软链 / 联接点成环**：Windows 上 `stat` 会跟进重解析点，一个指回祖先的
     * junction 会让队列无限增长。手动点时最多是用户自己点晕，批量扫就变成**永不停机**。
     * 同一目录被两条路径指到也只会扫一次 —— 这正是想要的。
     */
    const visited = new Set<string>([root.toLowerCase()]);
    /**
     * 「补全」为"缺大图"的层补一手时用：已经为它真扫过的层不再扫第二次
     * （否则"就是生成不出大图"的那些条目会让它被反复重扫）。
     */
    const retried = new Set<string>();
    /**
     * 本轮有没有"因为缺大图而真扫过"某一层 —— 有的话当前屏要重新取一次（走缓存，不碰盘）。
     */
    let retouched = false;
    scanPending.value = 1;
    let processed = 0;

    const rootParts = splitDrive(root);
    const rootDrive = rootParts?.drive;
    const rootRel = rootParts?.relPath ?? '';
    const visitedRel = new Set<string>();
    const failedPrefixes: string[] = [];

    try {
        const { serialOf, keys, subtreeRecords } = await fetchScanContext(rootDrive, rootRel);
        const keyOf = (dir: string) => {
            const parts = splitDrive(dir);
            if (!parts) return null;
            const serial = serialOf[parts.drive];
            return serial ? `${serial}|${parts.relPath}`.toLowerCase() : null;
        };

        while (queue.length) {
            // 取消只在**目录边界**检查：一个目录已经开始扫就让它扫完，
            // 半途中断只会留下一个写了一半的缓存
            if (scanCancelled) break;

            const dir = queue.shift()!;
            // +1：正在扫的这个也算"待扫"，否则会短暂显示成"待扫 0"
            scanPending.value = queue.length + 1;

            try {
                // 补全模式不带 noCache：命中缓存时服务端只回缓存，不碰盘
                let items = await requestFolder(dir, rescan);
                const dirParts = splitDrive(dir);
                if (dirParts) {
                    visitedRel.add(dirParts.relPath);
                }

                // 「补全」现在还欠一样东西：**预览大图**。
                // 2026-10-04 图片出库那次迁移只搬得走库里已有的**缩略图**，所以迁移来的那些层
                // 是"缩略图在、大图不在"。而补全不碰已缓存的层（那正是它省读盘的地方）⇒
                // 不在这里补一手的话，那几层的离线大图就永远是缺的（主人 2026-10-04 实测撞上）。
                //
                // 所以：**这一层里有"有图但还没大图"的条目，就为它真扫一次**（带 noCache）。
                // 代价是一次读盘，换来这一层的大图齐全；扫过之后 `previewReady` 就是 true，
                // 下一轮补全不会再盯上它（而服务端那道闸门也会因此不再重出）。
                // ⚠️ 每层只补一次：否则"就是生成不出大图"的那些条目会让它被反复重扫。
                if (!rescan && !retried.has(dir.toLowerCase())
                    && items.some(it => (it.thumb || it.avatar) && !it.previewReady)) {
                    retried.add(dir.toLowerCase());
                    items = await requestFolder(dir, true);
                    retouched = true;
                }

                const key = keyOf(dir);
                if (rescan || key === null || !keys.has(key)) scanDone.value += 1;

                for (const item of items) {
                    // 只认 `type`：是不是目录由服务端用 stat 判定过，不靠名字里有没有点猜
                    if (item.type !== 'folder') continue;

                    // 成环保护：见过的不再入队（见上面 visited）
                    const child = fullPathOf(item);
                    const norm = child.toLowerCase();
                    if (visited.has(norm)) continue;
                    visited.add(norm);
                    queue.push(child);
                }
            } catch (err: any) {
                // 单个目录失败不中断整轮 —— 和 readFolder 里"逐项 try/catch"同一个原则
                console.error('[批量扫描] 目录失败:', dir, err);
                const dirParts = splitDrive(dir);
                if (dirParts && err?.kind !== 'notFound') {
                    failedPrefixes.push(dirParts.relPath.toLowerCase());
                }
            }

            scanPending.value = queue.length;

            processed += 1;
            if (processed % SCAN_BATCH === 0) await new Promise(r => setTimeout(r, 0));
        }

        if (rescan && !scanCancelled && queue.length === 0) {
            const visitedRelNorm = new Set<string>();
            for (const r of visitedRel) {
                visitedRelNorm.add(r.toLowerCase());
            }

            const orphanIds = subtreeRecords
                .filter(rec => {
                    const normRel = (rec.relPath || '').toLowerCase();
                    if (visitedRelNorm.has(normRel)) return false;
                    if (failedPrefixes.some(fp => normRel === fp || normRel.startsWith(fp + '/'))) {
                        return false;
                    }
                    return true;
                })
                .map(rec => rec.id);

            if (orphanIds.length > 0) {
                console.log(`[重读这一片] 清理已在磁盘上删除的孤儿缓存: ${orphanIds.length} 条`);
                await postAction(`${API_BASE}/removeHistoryBatch`, { ids: orphanIds }).catch((e: unknown) => {
                    console.error('[重读这一片] 清理孤儿缓存失败:', e);
                });
            }
        }
    } catch (err) {
        // 连已缓存集合/盘列表都取不到（服务没起来）—— 再往下扫也没意义，直接报错收工
        console.error('[批量扫描] 准备失败:', err);
        notify('error', rescan ? '重读失败' : '补全失败', String(err));
    } finally {
        scanning.value = false;
        // 退场时把"正在取消"一起清掉：否则下次开扫前那几百毫秒里，
        // 状态条会先按"正在取消"的样子闪一下
        cancelling.value = false;
        scanPending.value = 0;

        // 「重读这一片」扫的恰好包含**你正在看的这一层** —— 不刷一下的话网格还是旧的，
        // 看起来像"这个按钮没生效"。
        // ⚠️ 这里**不带 noCache**：刚写好的新缓存就在库里，再真读一次盘是纯浪费，
        // 而"少碰移动硬盘"是这一整批的硬要求。补全模式下当前层本来就有缓存、不会变，所以不刷。
        // 「为了补大图而真扫过」也算内容变了 —— 当前屏不刷一下就看不到新的大图
        if (rescan || retouched) {
            const cur = history.value[history.value.length - 1];
            // loadScreen 分派：正在看清单屏时也原样重取一次（扫描动的是目录缓存，
            // 清单条目是快照不受影响，但保持同一出口，不新开一条 if 分支）
            if (cur) loadScreen(cur);
        }
    }
};

/**
 * 取消这一轮扫描。
 *
 * 只置两个标志，不做硬中断：`scanCancelled` 给循环读（目录边界），`cancelling` 给界面读
 * （按钮当场变「正在取消…」）。真正的收尾在 `startScan` 的 finally 里统一做。
 * 只置标志的另一个原因：中途掐断一个正在写的目录会留下写了一半的缓存。
 */
const onScanCancel = () => {
    cancelling.value = true;
    scanCancelled = true;
}

/**
 * 「更多」下拉的项：disabled 条件与改造前平铺按钮逐条一致，不放宽门槛。
 * 扫描中整组不可用由触发按钮的 :disabled="scanning" 挡住（下拉不弹 = 三项都点不到）。
 */
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
const scanLocked = () => scanning.value || picking.value || !history.value.length || !!readOnlyLevel.value;
const DIR_ACTIONS: DirAction[] = [
    // ⚠️ 扫描类动作在「挑封面」模式下**也禁用**：它们会把网格重扫一遍，
    // 而状态条那边是 `v-if="scanning || picking"` 且扫描优先 —— 扫描条会把挑选 UI
    // 顶掉（选中的东西还在、但你看不见那个计数和处理按钮了）。
    { key: 'fill', label: () => '补全这一片', icon: CloudDownloadOutline, disabled: scanLocked },
    { key: 'rescan', label: () => '重读这一片', icon: RefreshOutline, disabled: scanLocked },
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
 * 为什么是 `dialog` 而不是原来的 `n-popconfirm`：换成下拉之后，popconfirm 只能挂在
 * 「更多」按钮上（受控 show），于是"点了菜单项、确认框却出现在别处"—— 那个形态比 modal 更绕。
 * 而 `DESIGN-UIUX` §4.1 之所以选 popconfirm，理由是"高频动作弹窗会警报疲劳"，
 * 重读恰恰是低频动作 ⇒ 那条理由在这里不成立。门槛本身一点没降。
 */
/**
 * 扫描动效（移植自 LeiBox `transfer-glow`）。**它跟随真实扫描**：
 * `startScan` 一开就把 `glow` 置成模式名，扫描结束（scanning 变 false）后
 * 由组件自己播完退场并回调 `closed` 清掉。
 * `glowKey` 每次扫描 +1 ⇒ 上一次的退场还没播完就又点了，也是重新起一个实例。
 */
const glow = ref<'' | 'fill' | 'rescan'>('');
const glowKey = ref(0);

const onMoreSelect = (key: string) => {
    if (key === 'fill') {
        startScan(false);
    } else if (key === 'rescan') {
        dialog.warning({
            title: '重读这一片？',
            content: '忽略缓存，把这一片重新读一遍硬盘。',
            positiveText: '重读',
            negativeText: '取消',
            onPositiveClick: () => { startScan(true); },
        });
    } else if (key === 'cover') {
        assistantModal.value?.setShowModal(true);
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
    cursorKey, cursorItem,
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

/**
 * 已选的位置。key 与网格的 `:key` 同口径（`dir + '/' + name`）。
 *
 * ⚠️ 存的是**位置**（dir/name/ext/kind），不是条目对象 —— 刷新一次、换个目录，
 * `fileList` 里的对象就换了新的，但位置没变，所以选择能活下来（切目录、按 ↻ 都不会丢）。
 */
const picked = ref(new Map<string, { dir: string; name: string; ext?: string; kind: 'dir' | 'item' }>());
const pickedCount = computed(() => picked.value.size);

/**
 * 这个格子能不能被选。
 *
 * 只有**已经有脸**的才算：「封面卡」（`type:'image'`）或「有脸的目录」（folder 且带 avatar）。
 * 裸视频、没脸的目录都**不属于**换封面的范围 —— 它们归「补封面」管。
 * 两边互补、不重叠，所以这里不让它们被误选。
 */
const isPickable = (item: any) =>
    item.type === 'image' || (item.type === 'folder' && !!item.avatar);

const isPicked = (item: any) => picked.value.has(`${item.dir}/${item.name}`);

/**
 * 切换某一格的选中状态（换封面模式）。**鼠标点击与键盘 Enter 共用这一个实现。**
 *
 * ## 为什么抽出来（业主 2026-10-04 四次报连带发现）
 *
 * 原来这段逻辑**内嵌在 `onItemClick` 里**，而 `picking` 分支的第一句是 `if (!isPickable) return`
 * —— 也就是说**键盘 Enter 走的 `onCursorConfirm → onItemClick` 与鼠标走的是同一个函数**，
 * 这部分本来是对的。真正缺的是：**`picking` 分支从不调 `focusCursor`**
 * ⇒ 单击格子时焦点没落上去 ⇒ 方向键一动就"跑到别处"，
 * 用户以为是自己点的那格被选中。
 *
 * ⇒ 修法是让 `picking` 分支**也落焦点**（见 `onItemClick`），
 * 本函数则保持"只管 `picked` 这一个状态"，**不碰焦点**——
 * 焦点归`useGridCursor` 管（它是唯一的焦点真相），选中归这里管，两件事不混。
 */
const togglePick = (item: any) => {
    if (!isPickable(item)) return;
    const key = `${item.dir}/${item.name}`;
    const next = new Map(picked.value);
    if (next.has(key)) next.delete(key);
    else next.set(key, {
        dir: item.dir,
        name: item.name,
        ext: item.ext,
        // `kind:'dir'` = 展开它下面所有有封面的（"按演员 / 按文件夹"批量）；
        // `kind:'item'` = 只换这一个
        kind: item.type === 'folder' ? 'dir' : 'item',
    });
    picked.value = next;
};

/**
 * 模式态下的单击 = 选中 / 取消。**非模式态**把选择器移过去。
 *
 * ⚠️ 常态这一句是**新增**的：单击卡片只落焦点，**不开预览** ——
 * 开预览仍然只由单击图片触发（既有行为，见模板里 `img-props.onClick`），
 * 双击也一个字没改。选择器与"打开"是**两件事**，不合并。
 */
const onItemClick = (item: any) => {
    if (!picking.value) {
        focusCursor(keyOf(item));
        return;
    }
    /**
     * ⚠️ 必须先落焦点：`picking` 分支原来**直接 return**，
     * 而 `focusCursor` 只在非 picking 分支里调
     * ⇒ 焦点与选中各说各话（详见 `togglePick` 的注释）。
     */
    focusCursor(keyOf(item), { scroll: true });
    togglePick(item);
};

const clearPicked = () => { picked.value = new Map(); };

const enterPick = () => {
    picked.value = new Map();
    picking.value = true;
};

/** 退出即**清空选择** —— 留着的话，下次进来会看到一堆"不知道什么时候选的"东西 */
const exitPick = () => {
    picking.value = false;
    picked.value = new Map();
};

/** 把选中的位置交给既有的补封面弹窗（它去展开成目标、抓取、确认、写入） */
const openFaces = () => {
    const picks = [...picked.value.values()];
    if (!picks.length) return;
    assistantModal.value?.setShowModal(true, picks);
};

/**
 * 按关键词过滤。
 *
 * 拼音首字母那套逻辑原样保留，只改一处：`usePinYin()` 返回的是 `string[]`
 * （一个字有多个读音就给多个），当字符串参与 `+` 会被隐式 `join(',')` ——
 * 匹配串里凭空多一个逗号，就再也搜不到了。取第一个读音。
 * 平时看不出来是因为不含多音字时数组只有一个元素（20902 个汉字里只有 375 个多音字）。
 */
function filterByName(list: WiredFileInfo[], value: string) {
    let index = -1;
    if (/^[a-z|A-Z]/.test(value)) {
        for (let i = 0; i < value.length; i++) {
            if (/^[a-z|A-Z]/.test(value[i])) {
                index = i;
            } else {
                break;
            }
        }
    }

    return list.filter(item => {
        let endIndex = index + 1;
        let startWithPinYinStr = item.name;

        if (index !== -1 && !(/^[a-z|A-Z]/.test(startWithPinYinStr))) {
            startWithPinYinStr = usePinYin(item.name.substring(0, endIndex))[0] + item.name.substring(endIndex, item.name.length);
        }

        startWithPinYinStr = startWithPinYinStr.toUpperCase();

        if (startWithPinYinStr.indexOf(value.toUpperCase()) !== -1) {
            return true;
        } else {
            return false;
        }
    });
}

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
     *⚠️⚠️ **有浮层开着时，`Esc` 与 `Backspace` 都只用来"关掉它"**（业主 2026-10-04 五次报）。
     *
     * 原症状：「多步/更多」浮层开着时按 Backspace ⇒ **直接退回上一层文件夹**，
     * 而那个浮层**还留在屏幕上** ⇒ 状态自相矛盾（人已经走了，菜单还挂着）。
     *
     * ## 为什么这是**真缺陷**而不是"顺手加的体验"
     *
     * 浮层是**盖在当前屏之上的**，Backspace 的语义是"回到**上一屏**"——
     * 也就是说它操作的是**被遮住的那一屏**，而屏幕上可见的却是浮层。
     * ⇒ 用户的直觉是"先把这个东西弄掉"。
     * ⇒ 正确顺序是**分层消费**：`Esc` / `Backspace` 先交给浮层，浮层不在了才轮到导航。
     *
     *## 为什么判据是「有没有浮层开着」而不是"按Esc 还是 Backspace"
     *
     * 两者**都**应该先关浮层 —— 浮层开着时它们**不该**穿透到背后那一屏，
     * 与 `previewOpen` / `picking` 那两条短路是**完全同一条纪律**。
     *（`previewOpen` 与 `picking` 各有专属键：回车定位 / Esc 退出；
     *  但这两个小浮层**没有专属键**，所以 `Backspace` 必须也能关它们。）
     *
     * ⛔ 不做 DOM 探测（去body 里找`.n-popover` 之类）：浮层由 naive-ui teleport，
     *    类名与显隐都由它自己管，探测它等于把它的实现细节抄一遍。
     *    **状态在 `popover.visible` / `ctxMenu.visible` 里，那才是判据。**
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
    if (picking.value) {
        if (e.key === 'Escape') {
            exitPick();
            return;
        }
        if (e.key.toUpperCase() === 'S' || e.key.toUpperCase() === 'D' || e.key === 'Backspace') return;
    }

    if (e.key.toUpperCase() === 'S') {
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
});

// 必须写在 setup 顶层。注册在 onMounted 回调**内部**的 onUnmounted 永远不会被调用 ——
// 本次生命周期早过了注册窗口，结果是 keyup 监听永久留在 window 上。
// HistoryTable 那边修过一次，这里是漏网的那处。
onUnmounted(() => {
    window.removeEventListener('keyup', onKeyup);
    document.removeEventListener('click', onDocClickBlurButton, true);
    ipcRenderer.off('ff-disks-changed', onDisksChangedIpc);
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
    const topPl = history.value[history.value.length - 1]?.pl;
    if (topPl) {
        try { await refreshIndex(); } catch { /* 索引刷新失败不挡着重取清单 */ }
        await fetchPlaylistItems(topPl.id);
        return;
    }

    const top = history.value[history.value.length - 1];
    if (!top) return;

    /** 换掉栈顶那一屏。**替换**而不是 push —— 用户眼里还是同一层，只是它的地址变了 */
    const swapTop = async (path: string) => {
        history.value.splice(history.value.length - 1, 1, { ...top, path });
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
        notify('warning', '这块盘已拔出', '已切换到缓存内容，缩略图仍可用');
        return;
    }

    // ── 插盘：盘回来了就切实时 ────────────────────────────────────────
    const real = await resolveAnchor(top.path);
    if (!real) return;
    await swapTop(real);
    notify('success', '盘已插回', '列表已切换到实时内容');
};

/** IPC 监听器的**稳定引用**：`off` 必须拿到同一个函数，否则卸不掉、组件重建后会重复响应 */
let prevSerials: Set<string> | null = null; // null = 首次事件（只建基线，不响 —— 启动不是"接入"）
const onDisksChangedIpc = (_e: unknown, disks: { serial: string; drive: string }[]) => {
    const list = disks || [];
    // 插拔音：payload 只有"现在的盘列表"，插/拔靠与上一次的差分。KeepAlive 住 ⇒ 全会话有效。
    const now = new Set(list.map((d) => d.serial));
    if (prevSerials) {
        const added = list.some((d) => !prevSerials!.has(d.serial));
        const removed = [...prevSerials].some((s) => !now.has(s));
        if (added) playSfx('drive-in');
        else if (removed) playSfx('drive-out');
    }
    prevSerials = now;
    void onDisksChanged(list);
};

</script>

<style lang="less" scoped>
.file-finder {
    display: flex;
    flex-flow: column;
    /* ⚠️ 这一层**不带内边距**：顶栏要通栏贴边（Windows 那套方正的框），
       而"内容缩进"是顶栏与网格**各自**的事 —— 凭一个共享算式算出来，见 `--ff-content-inset`。
       2026-11-08 之前顶栏是 absolute、网格靠 `padding-top: 44+10px` 让位、顶栏再手写
       `padding: 0 18px` 补容器的 12px —— 同一件事在三个地方各写一遍，
       改一个页边距要同步三处，且高度成了"魔法补偿数"而不是布局自己算出来的。 */
    padding: 0;
    height: 100%;
    flex: 1 1 auto;
    min-height: 0;
    box-sizing: border-box;
    /* 内容左/右边缘 = 页边距 12 + 焦点环让位 6 = 18。
       ⚠️ 必须提到这一层：环让位原本是 `.image-box` 的局部变量，顶栏读不到就只能再写一个
       18px 的魔法数 —— 那正是"顶栏和第一列封面对不齐"复发的方式。 */
    --ff-grid-ring-room: 6px;
    --ff-content-inset: calc(var(--ff-sp-3) + var(--ff-grid-ring-room));

    .header-bar {
        display: flex;
        /* ⚠️ 头部定高，两个子区谁装不下都不能换行 ——
           换行就等于"头部高度成了路径长度/层级数的函数"（2026-09-24 事故的形态）。 */
        flex-wrap: nowrap;
        align-items: center;
        height: var(--ff-header-h);
        /* 横向 padding 不影响 44 这个高度，但显式写 border-box 是给"哪天补回 1px 底边线"
           留的保险：不写的话总高会变成 45、与 `--ff-header-h` 名不副实（踩过）。 */
        box-sizing: border-box;
        /* 8px：左侧三颗图标与地址槽之间的呼吸。
           原来是 12（那时左中右只有两块、中间靠 `justify-content` 撑开）；
           现在三段都是实体控件，12 会把"一组工具"读成"三个互不相干的东西"。 */
        gap: 8px;
        /* 顶栏是**文档流里的第一行**，与网格同级（2026-11-08 主人要求）：
           高度由布局分给它的 `height` 决定，不再需要 `position: absolute` 脱离文档流、
           也不再需要网格用 `padding-top` 替它让位。
           代价只有一条：内容不会再从它背后滚过去 —— 而毛玻璃已于 2026-11-08 裁决
           改回纯色（"工具类界面的顶栏是固定的框，不是浮在内容上的层"），所以零损失。 */
        flex: 0 0 auto;
        /* **通栏直角**，不做悬浮胶囊（2026-11-08 主人："用回 windows 方方正正的那种效果"）。
           通栏贴边才让它"仍是页面的一部分"；悬浮胶囊反而像一块贴上去的板。
           纯色就够，**不画底边线**（2026-11-08 裁决）：chrome 底色比画布亮一档，
           明度差已经把它和网格分开了，再补一条线只是多一个要同步维护的值。 */
        background: var(--ff-chrome-bg);
        /* 与网格共用同一个左边缘算式（容器不带内边距了，这里自己给） */
        padding: 0 var(--ff-content-inset);
        margin: 0;
        justify-content: space-between;

        /* 图标与文字统一取 chrome 的图标色（#ebebeb / #171717）：
           naive 的按钮默认吃 `--n-text-color`（次要灰），在深色里会显得没上电。
           ⚠️ 同时把按钮压成 **28×28 方格**：naive `size="small"` 是
           `--n-padding: 0 10px` + `--n-icon-margin: 6px` + 18px 图标 ⇒ 纯图标按钮
           实际约 **44×28**（查 `button/styles/_common.mjs`），不是方格。
           不压的话：① 搜索那颗被子容器锁死在 28，邻居却是 44 ⇒ 一排里两种宽度；
           ② 设计文档 §三的宽度账（右区 ~137px）整个不成立。
           这两个变量是 Button 组件**内联写上去**的 ⇒ 覆盖必须 `!important`（既有结论）。
           ⚠️ 用 `:deep()`：`GridDensityMenu` 那颗按钮是**子组件内部**节点，拿不到本文件的
           `data-v-*`，普通后代选择器匹配不到它 ⇒ 会变成"一排里唯一一颗 44 宽"。 */
        :deep(.n-button) {
            --n-padding: 0 !important;
            --n-icon-margin: 0 !important;
            --n-text-color: var(--ff-chrome-icon) !important;
            --n-text-color-hover: var(--ff-chrome-icon) !important;
            --n-text-color-pressed: var(--ff-chrome-icon) !important;
            --n-text-color-focus: var(--ff-chrome-icon) !important;
            width: 28px;
            justify-content: center;
        }

        /* 平铺、密度、更多这三颗单独放到 20px（2026-11-08）。
           为什么同样 18px 盒子它们看着比邻居小：这三颗的墨迹只占 viewBox 的 75~77%
           （自绘方块阵 / Fluent 竖三点），而**同一排的搜索、刷新、返回**是 ionicons 的
           1.1px 空心描边、外轮廓吃到 81.25% —— 差的是"锐度 + 感知面积"，不是尺寸。
           ⚠️ 必须 `:deep()`：密度那颗的按钮在 `GridDensityMenu` 内部，拿不到本文件的 data-v。
           ⚠️ `--n-icon-size` 是 Button 内联写在根节点上的，必须 `!important` 才盖得住。
           嫌小/嫌大就改这一个数，三颗一起变。 */
        :deep(.icon-lg) {
            --n-icon-size: 20px !important;
        }

        /* 搜索槽：一颗 28px 图标 ⇄ 一个 220px 输入框（2026-11-08 顶栏升级）。
           ⚠️ `width` 仍然**必须显式给**，不能删：n-input 天生 `width: 100%`，
              一旦直系父级不是定宽盒，它就会撑满整行、把工具条顶到多行
              （2026-09-24 事故：1805px 窗口下头部高 ~150px）。
              现在这个 100% 被外层 `.search-slot` 的定宽关住，规则从"给像素值"
              变成"给 100%"，但**不能缺席**。 */
        .n-input {
            width: 100%;

            &:deep(.n-input-wrapper) {
                /* 只为把 1px 字形的光学中心压回行盒中线（原值；与键帽无关，别一起删） */
                padding-top: 1px;
            }
        }
    }

    /* 左侧三颗：起点 / 返回·清空 / 刷新（2026-11-08 顶栏升级）。
       28px 定宽 + gap 4 —— 图标按钮靠"字形"分组就行，不需要竖线；
       竖线只留一道、给动作区最右那颗「更多」（见 `.toolbar-sep`）。 */
    .nav-btns {
        flex: 0 0 auto;
        display: flex;
        align-items: center;
        gap: 4px;
    }

}

/**
 * 横向单行容器 —— 顶替 naive-ui 的 `n-space`。
 *
 * 不是审美选择，是**避开一个真 bug**：naive-ui 2.45.3 的 Space 给每个子项硬编码
 * 同一个 key（`key: 1`），子元素个数变化时 Vue 的 keyed diff 会让两个旧节点认领
 * 同一个新槽位，界面上就多出重复节点。用裸 flex + `gap` 之后子元素按位置 patch，
 * 根本没有 key 可比 —— 这类错位在结构上不可能发生。
 *
 * 12px 就是 n-space 默认 size（medium）的间距，所以观感与原来一致。
 * 见 docs/FIX-2026-09-24-nspace-duplicate-keys.md
 */
.hstack {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 12px;
}

/**
 * 导航区 —— 头部**唯一**的弹性槽位（现在只用在头部；两个 popover 仍用 `.hstack`）。
 *
 * `min-width: 0` 是这整套的地基：flex 子项默认 `min-width: auto`（≈ 内容宽），
 * 不给 0 的话，**哪怕写了 `overflow` 也不会真的收窄**，头部照样被长路径撑开。
 * 宽度上限来自 Fluent 2 的预算（面包屑占整体 30–50% 是安全的）：
 * 它保证动作区**永远拿得到 ≥50%**，超出的部分交给折叠规则消化。
 * ⚠️ 实际写的是 `calc(50% + 槽宽)` 而不是 `50%`，原因见下面 `--crumb-badge-slot`
 * 那段：内容预算仍是 50%，多出来的槽宽 只是让角标住进 padding 里。
 *
 * 实测：`docs/probes/header-width/`（真 Chromium + 真 naive-ui，窗口 640/800/1280/1920 四档）。
 */
.nav-zone {
    /* ⚠️ 分隔符的定位依赖"两个 tag 之间的空隙有多宽"，所以空隙宽度**只能有一个来源**：
       这个变量。gap 与 ::before 的 left/width 共用它，改一处就够。
       原实现写的是 `left: -13px`（魔数），而 gap 是 8px ⇒ 它往左多插了 5px，
       压在**前一个标签的右边框**上（用户 2026-10-01 截图报的就是这个）。 */
    --crumb-gap: 8px;
    /* `›` 的光学补偿（负 = 往上顶）。**它不是一个审美值，是字体度量差**：
       `›` 的墨迹画在字身框偏下，把行盒居中之后墨迹仍低 1.5 物理 px（DPR 1.25 ⇒ 1.2 逻辑）。
       依据与复核方式写在 `::before` 那段注释里；这个数只在这一处、只服务一个字形。 */
    --crumb-sep-dy: -1.2px;
    /* 角标槽 = **常驻**的 56px，长在导航区自己的右 padding 上。
       ⚠️ 2026-11-08 code review：原来是 48px。角标起点在 `left:100% + 6px`，
       可用只剩 42px；`104` 三位数没问题，但平铺视图/大目录出现 5 位数时
       胶囊（padding 0 6 + tabular-nums 12px）会被 `.crumbs` 的裁剪框切掉右边。
       56 − 6 = 50px 装得下 5 位。这个数只影响"槽里留白"，不影响换层零位移。

       ⚠️ 2026-11-08 结构性返工（探针 `docs/probes/crumb-motion/` 实测）：
       原来这个 42px 槽挂在 `.crumb-current` 身上 —— 而"当前段"是最后一格，
       换层时它**换人**（`F:` → `videos`），于是 40px 空槽在一帧里从上一格搬到下一格，
       中间那格被迫横移 40px。实测：`F:` 的 `padding-right` t0 就是 `42px→2px`，
       全程唯一一次瞬时几何变化，位置正在"F: 与 videos 之间"（主人报的"F 到 videos 会跳"）。
       ⇒ 槽改成**行级常量**（谁当当前段都占同一块），当前段就只剩换色/换字重，
       零布局事件；多一段就是**只多一段**。
       ⚠️ 这个 56px 现在写在**内层 `.crumbs` 的 `padding-right`** 里（不是 `.nav-zone`），
       并且必须配 `box-sizing: border-box`：角标画在当前段盒子外面，
       而 `.crumbs` 有 `overflow: hidden`（裁剪边界 = padding box）⇒ 只有落在它自己的
       padding 里才不会被切掉。
       ⚠️ 原来还有一条 `max-width: calc(50% + 槽宽)` 守"内容预算 50%"，2026-11-08 顶栏升级
       已**取消**（理由见下面 flex 那段的注释）—— 那个槽宽不再影响任何百分比预算。 */
    --crumb-badge-slot: 56px;
    flex: 1 1 auto;
    min-width: 0;
    box-sizing: border-box;
    /* ⚠️ 2026-11-08 顶栏升级：**取消** `max-width: calc(50% + 槽宽)`。
       那个 50% 预算是按"右侧动作区 ~420px"算的（见 docs/probes/header-width/）；
       右侧已经降到 ~137px（搜索收成图标、刷新搬去左边、更多挪到末端），
       再留 50% 只会让右半条空着 —— `justify-content: space-between` 会把槽和工具条
       硬推开，中间出现一段死白。
       现在它就是"吃掉所有剩余宽度"的那一格，与资源管理器地址栏同构。
       ⚠️ 槽里还住着那个**常驻 56px 角标位**（padding-right 占着），换层时它不换人。 */
    min-height: 30px;
    padding: 0 0 0 8px;
    /* 连续槽 = **一块面**，不是一条线。
       用 `--ff-field`（"一眼看出这是一块可操作的底"那一档，明暗两个主题都调过：
       浅 #eef0f2 贴白 chrome 差 17、深 #313131 贴 #1f1f1f 差 18）。
       ⚠️ 不画边框：顶栏里六颗图标按钮都是无框的，这里再多一个描边矩形，
          就会被读成"一块贴歪的框"而不是"一整条地址"（Chrome / 资源管理器也都没有线）。 */
    background: var(--ff-field);
    border-radius: var(--ff-r-ctl);
    display: flex;
    align-items: center;
    overflow: hidden;
    /* 离场的"幽灵"用 `position: absolute` 钉在这里（见 `.fx-leave-active`）——
       它需要一个**定位祖先**，否则会以整页为坐标系飞出去。
       ⚠️ 2026-11-08 第二轮：幽灵的定位祖先现在是内层 `.crumbs`（`pinLeaving` 取
       `el.parentElement`）。这里保留 `position: relative` 只是给 galaxy 画布当坐标原点。 */
    position: relative;

    /* 内层：真正的面包屑列表（`TransitionGroup` 本体）。
       为什么要单拆一层：galaxy 像素层要铺满整条槽，而 `TransitionGroup` 的子节点必须带 key
       且会被 FLIP 挪动 ⇒ 画布不能挂在它下面。拆开之后"面"和"列表"各归各的，
       而 `.nav-zone .fx-*` 那些非 scoped 规则靠**后代**关系依旧命中。 */
    .crumbs {
        flex: 1 1 auto;
        min-width: 0;
        box-sizing: border-box;
        display: flex;
        flex-wrap: nowrap;
        align-items: center;
        gap: var(--crumb-gap);
        /* ⚠️ 角标槽（56px）**必须留在这一层**，不能留在 `.nav-zone` 上。
           角标是 `::after` + `left: 100%` ⇒ 它画在当前段的**盒子外面**；
           而这一层有 `overflow: hidden`（裁剪边界是 padding box）。
           拆两层时如果 56px 还挂在外层，角标就落到这一层的裁剪框外面 ⇒ 长路径时被切掉。
           放在这里的 padding 里，它才是"在本层内部、但不在内容区"。 */
        padding-right: var(--crumb-badge-slot);
        overflow: hidden;
        /* 画布在 z-index 0，列表必须压上去，否则文字会被星光盖住 */
        position: relative;
        z-index: 1;
    }

    /* 面包屑每一段：**单个名字有界**（层级深度问题已由折叠解决，这里只管"一段太长"）。
       ⚠️ 中文不能用 Fluent 那条「超过 30 字符就截断」——那是**拉丁文**语境的量级：
       中文一个字约等于拉丁两个字宽，30 个字 ≈ 360px，照抄等于没截断。所以用像素。 */
    .crumb {
        /* ⚠️ `0 1 auto`（**可收缩**）而不是 `0 0 auto`：
           宽度不够时先压历史段，而不是把"当前层"直接挤出屏幕右边缘被裁掉。
           收缩下界交给 `min-width: 0` + 文本省略号 —— 极窄时显示成「…」，与资源管理器一致。
           ⚠️ 不设 max-width（2026-11-09 主人："空间这么充足居然缩略？"）：槽里有富余时
           面包屑按内容自然伸展；压力只来自真实的宽度不足，届时再走上面的收缩纪律。 */
        flex: 0 1 auto;
        min-width: 0;
        cursor: pointer;

        /* ⚠️ 2026-11-08 重设计：**去掉方块，只留文字**。
           它原来是 n-tag 的默认描边胶囊 —— 一排方框挤在一起，既像按钮又像标签，
           而它本质是"路径文字"（Windows 资源管理器 / GitHub / Linear 都是纯文字 + 分隔符）。
           去边框写 `transparent` 而不是 `none`：保留 1px 占位，hover 时不会跳 2px。
           naive 的颜色变量是运行时注入的，覆盖必须 `!important`。 */
        --n-color: transparent !important;
        /* ⚠️ 2026-11-08 顶栏升级：悬停从**下划线**改成**圆角底色**。
           理由：外层已经是"一块面"，段再画下划线就是两套语言；
           而"悬停给一条圆角底"正是 Chrome 地址栏的做法 —— 还顺带回答了
           "这一段到底能不能点"（当前段没有底色 = 不可点），比下划线更清楚。
           ⚠️ 底色用 `--ff-ctl-on` 而**不是** `--ff-ctl-hover`：槽本身已经是 `--ff-field`
           （浅 #eef0f2 / 深 #313131），而 `--ff-ctl-hover` 在深色下**正好等于** `--ff-field`
           ⇒ 悬停一点变化都没有；`--ff-ctl-on` 两档都比它再远一步（浅 #e3e5e8 / 深 #3a3a3a）。 */
        --n-color-hover: var(--ff-ctl-on) !important;
        --n-border: 1px solid transparent !important;
        --n-border-hover: 1px solid transparent !important;
        --n-text-color: var(--ff-text-2) !important;
        --n-text-color-hover: var(--ff-text-1) !important;
        /* 6px：槽里没有分隔线，段与段之间只靠留白 + `›`，太窄就"文字粘在一起" */
        padding: 0 6px;
        border-radius: var(--ff-r-pill);
        /* 文字贴左，**不居中**：当前段右侧有一个角标槽（见 `.crumb-current`），
           若居中，文字会随槽宽左右横移；贴左则槽怎么变、文字都不动。
           非当前段左右 padding 相等，两者本来没差别 ⇒ 这条只为当前段存在。 */
        justify-content: flex-start;

        /* 文本真的收窄之后 `text-overflow` 才会出现 —— 同理，这一层也要 `min-width: 0` */
        :deep(.n-tag__content) {
            min-width: 0;
            overflow: hidden;
        }

        .crumb-text {
            display: block;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            /* ⚠️ 不能少：n-tag 的 `line-height:1` 会继承进来 ⇒ 上面的 `overflow:hidden`
               （省略号的前置条件）裁剪盒只有 1em=14px，比字体内容区（实测 16~20px）还矮，
               字形顶/底被切 —— 实测换主字体即复现"顶行被裁"（docs/probes/crumb-clip/）。
               取 tag 自己的内高 ⇒ 盒 28px、墨迹余量 7.5px；tag 高是定值、行盒居中 ⇒ 零布局影响。 */
            line-height: var(--n-height, 1.4);
            /* 2026-11-08：当前段换人时**只换颜色**（尺寸与字重都不动，见 `.crumb-current`）。
               只过渡颜色 —— `font-weight` 已经在第七轮整个去掉，不要加回来。 */
            transition: color var(--ff-dur-hover) var(--ff-ease-move);
        }
    }

    /* 层级之间的方向符。
       ⚠️ 用 CSS 生成，**不插 DOM 子元素** —— 这一组的子元素个数在本项目是敏感量
       （n-space 重复 key 事故同族）。
       `position: absolute` 让它不占 tag 内部空间（tag 自带 `position: relative`）；
       **盒子正好等于那个空隙、再在盒子里居中** —— 这样就不依赖"猜一个负偏移量"，
       换字体、换字号都不会再压到边框上。

       ⚠️⚠️ `--crumb-sep-dy` = **光学补偿**，不是布局补丁。原因很具体：
       `›` 这个字形由字体自己决定画在**字身框偏下**的位置（不是居中）。所以"把它的行盒
       居中"得到的只是**盒**居中，墨迹仍然偏低 —— 中线上看过去就是一串分隔符"往下坠"。
       实测（截图 314×63，DPR 1.25，暗色，`docs/probes/header-optical/`）：
         槽中线 32.00 · 汉字重心 31.68 · `›` 墨迹 31..36（中心 33.50）⇒ 低 1.5 物理 = 1.2 逻辑。
       ⇒ 所以这里往上顶 1.2px，让**墨迹**回到中线（边距仍是"盒居中 + 这一档补偿"两件事分开写）。
       ⚠️ 换主字体 / 改 `--crumb-gap` 之外的任何字号相关的值时，这个数要重量：
          `node docs/probes/header-optical/measure.mjs <截图>` 会直接打每块墨迹与中线的差。 */
    .crumb:not(.crumb-root)::before {
        content: '›';
        position: absolute;
        left: calc(-1 * var(--crumb-gap));
        width: var(--crumb-gap);
        text-align: center;
        top: 50%;
        transform: translateY(calc(-50% + var(--crumb-sep-dy)));
        line-height: 1;
        color: var(--ff-text-muted);
        pointer-events: none;
        /* 别挡住上一个 tag / chip 的点击 */
    }

    /* 当前层**永不被压掉**：它是"我在哪"的唯一答案，比任何历史段都重要。
       ⚠️ 这里**只换颜色**，一个像素的尺寸、一条笔画都不换 —— 角标槽已经搬到
       `.nav-zone`（见那边注释），所以连宽度都不变。
       ⚠️⚠️ 2026-11-08（第七轮）：**去掉 `font-weight: 500`**。
       主人原话：「高亮的 videos 会跳一下…它根本就不需要重新渲染，最多就是从灰色变成高亮不可点」。
       加粗是这里**唯一会让字形整体重画**的东西（颜色只是重新上色）：
       可变字体的 500 档要重新栅格化一遍字形，观感就是"这一格闪/动了一下"。
       灰色 → 高亮的信息量本来就够（浅色 #61666d → #18191c，深色 #8f8f8f → #ededed），
       不需要再加一层字重。⇒ 当前段的差别只剩：**亮一档 + 光标变 default**。 */
    .crumb-current {
        flex: 0 0 auto;
        --n-text-color: var(--ff-text-1) !important;
        position: relative;
    }

    /* 当前段的条目数角标 —— 原来是工具条里那个飘着的 `n-badge`，
       用户 2026-10-02 裁决挪到这一段上（它本来就是"这一层有多少东西"的答案）。
       ⚠️ 为什么用 `::after` + `attr()`、而不是真塞一个 `<span>`：
       ① 这一组的**子元素个数在本项目是敏感量**（见文件顶部那段 n-space 重复 key 的教训），
          伪元素不进 DOM，个数一个都不变；
       ② tag 内部的 `.n-tag__content` 是 `overflow: hidden` 的，真塞进去的 span 会被裁掉，
          而 `::after` 挂在**根元素**上（n-tag 是 inline-flex），是 content 的**兄弟**，
          不在那个裁剪盒里。
       属性为空时不画：`:data-count="null"` 时 Vue 根本不渲染这个属性，整条选择器不命中 ——
       等价于原来的 `v-if="fileList.length"`，不需要再写判空。 */
    /* 计数徽章 —— 恢复为红底白字胶囊（2026-11-08 主人："要原来的 badge"）。
       ⚠️ 为什么不是 `align-self: baseline`：它给不了"与路径文字共基线"，
       而是**自成 baseline 组** —— 容器里没有第二个 baseline 项时，它会贴到内容区顶部
       （实测就是这样飞到右上角的）。共基线必须容器 `align-items: baseline`，
       而 n-tag 是 `inline-flex` + `center`，改它会影响 tag 内所有子项。
       ⇒ 保留 `center`，用一次**实测偏移**补掉"块按行盒居中、文字墨迹偏低"的差。
       实测（截图 151×55 @DPR1.25）：胶囊中心 27.5、文字 x-height 带中心 31 ⇒ 差 3.5 物理
       = **2.8 逻辑px**。这个数不是估的；它约等于半个下伸部（descender 空白）。
       标记为"仅视觉位移"：`transform` 不改布局，tag 高度仍由 `.crumb-text` 的行盒决定。 */
    .crumb-current[data-count]::after {
        content: attr(data-count);
        /* 画在**盒子外侧**（左边缘 = 当前段右边缘 + 6px），落在 `.nav-zone` 的常驻角标槽里。
           两个必然结果，正是本轮要的：
           ① 当前段的宽度不随角标有无 / 位数变化；
           ② 槽是行级常量 ⇒ "当前段换人"不再搬运 40px 空槽 ⇒ 前面的段一个像素都不动。
           ⚠️ 不能改回 `right: 2px` + 段内 padding：那就是上一版"F 到 videos 会跳"的根因。 */
        position: absolute;
        left: 100%;
        margin-left: 6px;
        top: 50%;
        /* ⚠️ 2026-11-08 **删掉了原来那个 `+ 2.8px`**。
           它当初是补"块按行盒居中、文字墨迹偏低"的差 —— 那个判据是**拉丁 x-height 带**
           的（字母小写的主体偏下）。可这个界面里地址永远是中文：汉字墨迹几乎填满字身框，
           重心就在**行盒中心**。于是在中文上，那个补偿把胶囊整个压低了。
           实测（槽截图 314×63，DPR 1.25，暗色）：
             槽 14..50，中心 32.0；文字墨迹**重心 31.7**；胶囊**重心 35.7** ⇒ 低 3.7 物理 ≈ 3 逻辑。
           去掉之后两者都对在 32 —— 记着：判据要落在"这段文字的实际重心"，不是某个字族的字体度量。 */
        transform: translateY(-50%);
        /* 伪元素是"命中选择器那一刻才创建"的，没有上一帧可过渡 ⇒ 只能用 keyframes
           ⚠️ 那个延迟不是装饰，是**必须**：角标的落点恰好是"上一格"消失的位置
           （角标挂在当前段右边缘 +6px，而下一段的起点是 +12px）⇒ 上一段退场期间
           会被新角标整个盖住，淡出等于没做（实测 `shot-leave-zoom.png`：只剩一个 `›` 压在角标边上）。
           让角标晚一步出现，两件事就串起来了：**先看到那段走、再看到数字来**。
           2026-11-08 第八轮：延迟改成引用 `--ff-dur-exit`（退场带走完再出现），
           不再写死 120ms —— 以后调拍子只改一个数。 */
        animation: fx-badge-in var(--ff-dur-badge) var(--ff-ease-move) var(--ff-dur-exit) both;
        height: 18px;
        min-width: 18px;
        padding: 0 6px;
        box-sizing: border-box;
        border-radius: 9px;
        /* 2026-11-08 主人要求用回红色（那是"这一层有多少东西"的信号，值得被看见）。
           ⚠️ 这是**唯一**允许的彩色非交互元素：它不参与"能点哪"，只报数字。 */
        background: var(--ff-danger-badge);
        color: var(--ff-on-danger);
        font-size: 12px;
        line-height: 18px;
        font-weight: 500;
        /* 数字等宽：35 → 128 时这一行不跟着抖 */
        font-variant-numeric: tabular-nums;
        /* 当前段是 500，角标不该比它更粗 */
        text-align: center;
    }

    .crumb-more {
        flex: 0 0 auto;
        padding: 0 8px;
    }

    /* 两种**不可点**的段：首段（盘符 / 离线盘）与当前段。
       必须与可点的段**视觉可分** —— 现状是"所有 tag 都 cursor:pointer"，
       于是当前层看着能点、点了没反应（死交互）。 */
    .crumb-root,
    .crumb-current {
        cursor: default;
    }
}

/**
 * 头部右侧那一组：**单行 + 不参与压缩**。
 *
 * `flex: 0 0 auto` 是「动作区永远拿得到自己需要的宽度」的保证：
 * 默认的 `flex-shrink: 1` 会让它在窄窗口里被压到内容宽以下（按钮文字被挤），
 * 而那正是"换行 / 溢出"的起点。宽度不够时该被裁的是**导航区**（那里有折叠规则兜底）。
 */
.toolbar {
    flex: 0 0 auto;
    display: flex;
    flex-wrap: nowrap;
    align-items: center;
    /* 4px：图标按钮靠**间距**读成"一组"，不靠竖线（竖线只留一道给「更多」）。 */
    gap: 4px;

    /* 开关类按钮的激活态：**灰底 + text-1**，与左轨同一套语言（不带颜色）。
       ⚠️ 用 `:deep()`：`GridDensityMenu` 里那颗按钮是**子组件内部**的节点，
          拿不到本文件的 `data-v-*` 作用域属性 ⇒ 普通后代选择器匹配不到它。
          （「平铺」那颗在本文件里，用同一条规则也能命中，所以只留这一条。）
       ⚠️ naive 的颜色变量是运行时注入的，覆盖必须 `!important`（项目既有结论）。
       为什么不用实心主按钮：一个"视图开关"不该比主操作还响。
       ⚠️ 底色用 `--ff-ctl-on` 而不是 `--ff-fill-strong`(=raised-hover)：那一档在深色下
       比悬停更**暗**，"选中"反而更不起眼。`--ff-ctl-on` 两个主题方向一致
       —— 浅色更深（#e3e5e8）、深色更亮（#3a3a3a），都比"悬停"再离底色远一档。 */
    :deep(.is-on) {
        --n-color: var(--ff-ctl-on) !important;
        --n-color-hover: var(--ff-ctl-on) !important;
        --n-color-pressed: var(--ff-ctl-on) !important;
        --n-text-color: var(--ff-text-1) !important;
        --n-text-color-hover: var(--ff-text-1) !important;
        --n-text-color-pressed: var(--ff-text-1) !important;
    }

    /* 搜索槽：收起 28px（一颗图标）⇄ 展开 220px（输入框）。
       宽度的目的不是动画本身，而是**让位**：地址槽是 `flex: 1`，它一收/一放，
       面包屑那边自动跟着变 —— 所以 `.nav-zone` 一个 transition 都不用写。
       节奏和面包屑同一拍 200ms，但**展开方向不走「拍内分带」**（2026-11-08 修）：
         展开 → 宽度满拍 + 输入框同起跑（内容 0→100ms 显形）。
                别套"先落位、后显形"：宽度不是位移，它的"落位"就是一块**空白**，
                内容一推迟，眼睛看到的就只是空格子猛然撑开。
         收起 → 保留"先消失、后收摊"：内容前 45% 淡出，宽度延迟到之后才收 ——
                这个方向空白是在**变小**，不刺眼，且收窄时不该看到内容被挤。
       ⚠️ 两个方向必须分别写在两端：`.is-open` 里的规则只在"去往 is-open"时生效，
          基础规则只在"回到基础态"时生效。写在一处就只有一个方向有曲线。 */
    .search-slot {
        position: relative;
        flex: 0 0 auto;
        width: 28px;
        height: 28px;
        /* 曲线用 `--ff-ease-size` 而不是 `--ff-ease-move`（2026-11-08）：
           后者初始斜率 5.26，在 192px 的宽度上等于"空白猛弹开"（峰值 6733px/s，
           面包屑只有 1578px/s）。详见 tokens.css 那条注释。 */
        transition: width calc(var(--ff-dur-move) * 0.55) var(--ff-ease-size) var(--ff-dur-exit);

        &.is-open {
            width: 220px;
            /* 展开**拉满一拍**，不再用 0.75 拍。
               原来那 25% 是留给"先落位、后显形"的，但宽度不是位移 ——
               它的"落位"就是一块**空白**，内容被推迟到落位之后 ⇒ 眼睛看到的是
               "空格子先弹开、输入框才浮现"。内容已改成同起跑，这一拍就该用满。 */
            transition: width var(--ff-dur-move) var(--ff-ease-size);
        }

        /* 收起态的输入框**留在 DOM 里**（只关可见与命中）：`v-if` 会让它没有"上一帧"，
           宽度动画就只能从 0 开始 —— 那正是"瞬间弹出"而不是"长出来"。 */
        .n-input {
            opacity: 0;
            pointer-events: none;
            transition: opacity var(--ff-dur-exit) linear;
        }

        &.is-open .n-input {
            opacity: 1;
            pointer-events: auto;
            /* ⚠️ **不带** `--ff-fade-in-delay`（2026-11-08）：那个 25% 拍 = 50ms，
               恰是旧宽度曲线冲完 92% 的时间 ⇒ 前 50ms 观众只看得到空白在撑开。
               现在宽度同拍走 200ms，内容 0→100ms 同步显形，边在长的过程里内容一直在。 */
            transition: opacity var(--ff-fade-in) linear;
        }
    }

    /* 收起态那颗图标：绝对铺在 28px 槽上，与输入框共用同一个位置。
       不参与布局 ⇒ 展开/收起时不会因为它再算一次几何。
       ⚠️ 展开态的规则**必须另起一条**写全路径：Less 里 `.is-open &` 展开的是
          **累计选择器**（`.toolbar .search-btn`）⇒ 会编译成 `.is-open .toolbar .search-btn`，
          祖先顺序反了，规则静默失效（第一版就是这么错的，靠翻编译产物抓到）。 */
    .search-btn {
        position: absolute;
        inset: 0;
        width: 28px;
        transition: opacity var(--ff-fade-in) linear var(--ff-fade-in-delay);
    }

    .search-slot.is-open .search-btn {
        opacity: 0;
        pointer-events: none;
        transition: opacity var(--ff-dur-exit) linear;
    }

    /* 「更多」与视图组之间那道竖线：它是兜底入口，不属于视图组。 */
    .toolbar-sep {
        flex: 0 0 auto;
        width: 1px;
        height: 16px;
        background: var(--ff-line-strong);
        margin: 0 4px;
    }
}

/* ── 状态条「挂上 / 摘掉」的动画（2026-11-08）───────────────────────────────
   这条状态条**在文档流里**（`.file-finder` 是 flex 列），所以只做淡入是假动画：
   卸载那一帧网格就跳 50px，然后条自己再淡出去。**高度必须一起过渡**。
   `height: auto` 不可过渡，`max-height` 要写魔数（内容一变就剪错高度）⇒
   用 grid 轨道 `minmax(0,1fr) ↔ minmax(0,0fr)`：零魔数、内容多高都收得干净。
   Chromium 152 实测可插值：`docs/probes/bar-collapse/`（200ms 一拍下采到 12 帧中间高度，槽 50→0，
   网格顶边同步上移）。
   ⚠️ 两个前提**缺一不可**，少一个就"收不起来"（探针第一版就是这么失败的）：
     ① 轨道写 `minmax(0, …)` —— 裸写 `0fr` 等于 `minmax(auto, 0fr)`，轨道的自动最小尺寸
        取内容的 min-content，`.scan-bar` 的 `min-height: 40px` 会把它顶死；
     ② 里层 `.scan-bar` 有 `overflow: hidden` —— 网格项的自动最小尺寸只有非 visible 才归 0。
   ⚠️ 透明度用 linear、时长走**拍内分带**（2026-11-08 第八轮，同面包屑）：
   这条曲线是给位移的（前重后轻），拿 `--ff-ease-exit` 淡出会中途就掉到 0.1，
   肉眼等于"闪一下"（面包屑那边踩过）。进 = 延迟 25% 拍、后用 50% 拍显形；
   退 = 前 45% 拍内消失，然后才让空间塌下去。 */
.scan-bar-slot {
    display: grid;
    grid-template-rows: minmax(0, 1fr);
    /* 收起过程中内容仍按自身高度渲染，不裁就会盖到网格上 */
    overflow: hidden;
    /* 不参与压缩：该被挤的是网格（`flex: 1`），不是这条 */
    flex: 0 0 auto;
}

.fx-bar-enter-active {
    transition: grid-template-rows var(--ff-dur-move) var(--ff-ease-move),
        opacity var(--ff-fade-in) linear var(--ff-fade-in-delay);
}

.fx-bar-leave-active {
    transition: grid-template-rows var(--ff-dur-move) var(--ff-ease-exit),
        opacity var(--ff-dur-exit) linear;
}

.fx-bar-enter-from,
.fx-bar-leave-to {
    grid-template-rows: minmax(0, 0fr);
    opacity: 0;
}

/* 减少动态效果：直接切终态。轨道过渡必须整体关掉 —— 留个 0ms 的过渡在
   `grid-template-rows` 上只会让"挂上/摘掉"多算一帧，没有意义。 */
@media (prefers-reduced-motion: reduce) {

    .fx-bar-enter-active,
    .fx-bar-leave-active {
        transition: none;
    }
}

/* 扫描状态条：贴着网格下方一条，整条随 scanning 出现/消失 */
.scan-bar {
    display: flex;
    align-items: center;
    /* ⚠️ 2026-11-08：这条不是可有可无的 —— 它是 `.scan-bar-slot` 能把高度收到 0 的
       **第二个前提**（网格项的自动最小尺寸只有非 visible 才归 0）。
       顺带保证内容不被裁：收起时轨道已经 0，这里裁不裁都看不见。 */
    overflow: hidden;
    /* 元素间距统一 8（§4.4）；组的切分交给 `.pick-acts` 内部再分一档 */
    gap: 8px;
    /* 定高：挑选条 / 扫描条**两种内容**高度一致 —— 扫描过程中途切换文案
       （`取消` → `正在取消…` 多一行提示）不会让条自己长高、把网格顶一下。
       ⚠️ 它**管不到**"整条挂上/摘掉"，那件事现在由 `.scan-bar-slot` 的轨道动画负责。 */
    min-height: 40px;
    padding: 2px var(--ff-content-inset) 8px;

    .scan-progress,
    .scan-hint {
        font-size: 12px;
        color: var(--ff-text-2);
    }

    /* 模式标签：只用一处淡高亮，说明"你现在在一个模式里"。
       不给整条加深色底 —— 它贴在网格上方，加深底会和封面抢注意力。 */
    .pick-badge {
        flex: none;
        font-size: 11px;
        font-weight: 500;
        line-height: 18px;
        padding: 0 8px;
        border-radius: var(--ff-r-pill);
        /* 中性胶囊，不占高亮色 —— 高亮色只留给「卡片选中 / 悬浮 / 输入框焦点」三处。
           模式的存在感由这条状态条本身 + 右端那颗实心主按钮承担。
           ⚠️ 底色用 `--ff-chrome-active`（左轨选中同一个灰）：原来是 `--ff-raised`，
           它贴白面板只差 5 级，一块"我在某个模式里"的标签淡到看不出边界。 */
        color: var(--ff-text-1);
        background: var(--ff-chrome-active);
    }

    /* 计数是**状态**不是句子：数字单独加亮，单位退后 */
    .pick-count {
        flex: none;
        font-size: 13px;
        color: var(--ff-text-2);

        b {
            font-weight: 500;
            color: var(--ff-text-1);
            /* 数字等宽：选到 10 个时行宽不跳 */
            font-variant-numeric: tabular-nums;
        }
    }

    /* 把动作整体推到右端：主操作要落在**手习惯去的那一头** */
    .pick-spacer {
        flex: 1 1 auto;
    }

    /* 动作组：组内 8，主操作再让 8（合计 16）—— 间距分级就是这里唯一的"层级"手段，
       颜色那边不许再造一套（高亮色只有三处用途，见 tokens.css）。 */
    .pick-acts {
        flex: none;
        display: flex;
        align-items: center;
        gap: 8px;

        .pick-go {
            margin-left: 8px;
        }
    }
}

/* 定位后短暂压暗其余格子（600ms）：满屏几百张时，「只剩一张亮」比「给那张加框」好认得多。
   ⚠️ 动效（2026-11-09）：透明度过渡写在**基类**上 —— 只写在 .is-locating 里的话，
   撤销蒙层那一下是硬切（opacity .3 → 1 瞬间跳回）。进出不对称：压暗快（.12s，
   注意力要立刻抓）、恢复慢（.2s 一拍，视线 softly 放回全屏）。 */
.image-box.is-locating .image-box-item:not(.cursor) {
    opacity: .3;
}

.image-box.is-locating .image-box-item.cursor {
    /* 蒙层期间把光标卡再抬一档（1.012 → 1.02）：压暗语言下的「就是这张」，
       同一族 scale 动作，不引入第二种颜色（2026-10-04 撤橙框时的结论）。 */
    transform: scale(1.02);
}

/*
 * 卡片状态：可选 / 已选 / 焦点。
 *
 * ⚠️ 约束没变：**状态一律不许新增参与布局的属性** —— 宽度由 grid 的 `1fr` 给，而高度必须同行等高
 * （`groupRows` 按 `offsetTop` 分行，差一像素就劈行）。所以只用 `outline` / `box-shadow` / `transform`。
 *
 * 圆角：2026-10-21 主人裁定改用 B 站那套 6px，值在 `--ff-radius-card`（想改回直角只改 token）。
 */
.image-box-item {
    position: relative;

    /* 定位蒙层的透明度过渡写在基类：压暗（.is-locating）与恢复（撤 class）两个方向都要动。
       进出不对称——压暗 .12s（立刻抓注意力）、恢复 .2s 一拍（视线 softly 放回全屏）；
       transform 用过冲曲线（--ff-ease-enter）：cursor 卡 1.012↔1.02 的抬升带一点 Q 弹，
       与预览进场同一族手感。 */
    transition: opacity 0.12s ease, transform 0.18s var(--ff-ease-enter);

    /* 卡片内层序契约（唯一真相源）——"谁盖住谁"只在这里定，别在别处补 z-index 数字。
     * ⚠️ 封面图 z-index:1 会盖住没给层级的浮层；别逐个元素打补丁（换元素就复发），统一按下面 --z-* 变量定契约。 */
    --z-cover-img: 1;
    --z-cover-tag: 2;
    --z-cover-mark: 3;
    --z-card-mark: 2;
    --z-card-mask: 3;

    /* 卡片自成层叠上下文：内部层级不与兄弟卡片、外层 UI 互相比较。
     * ⚠️ 不加的话，焦点卡放大 1.012 溢出到邻居上时，邻居的角标会盖住它。 */
    isolation: isolate;

    &.pickable {
        cursor: pointer;
    }

    /* 已选（换封面时点中的格子）：绿圈画在封面**内侧**，与焦点的外圈各占一层，不打架。
     * ⚠️ 必须画成 `.card-cover::after`（封面内部的第 3 层）—— 原来挂在
     * `.card-cover` 自己的 `inset box-shadow` 上，那是**封面背景层**，
     * 会被封面图（层级 1）盖住 ⇒ 绿圈只剩左右两截、上下边看不见。 */
    &.picked .card-cover::after {
        content: '';
        position: absolute;
        inset: 0;
        border-radius: inherit;
        box-shadow: inset 0 0 0 2px var(--ff-status-ok);
        z-index: var(--z-cover-mark);
        /* 纯装饰，不该拦点击（盒子贴在图片上，不加就吃掉图片的点击） */
        pointer-events: none;
    }

    &.cursor {
        /* 极轻抬升：1.012 而不是 1.02 —— 后者在密网格里很显眼，显眼=吵。
           ⚠️ `transform` 会污染 `getBoundingClientRect`，`gridGeometry` 分行必须用 `offsetTop`。 */
        transform: scale(1.012);
        z-index: 1;

        .card-cover {
            /* ⚠️ 2026-11-08 关键改动：**环必须离开照片 2px**（`outline-offset: 2`）。
               为什么：封面的颜色是不可控输入。环贴在图像边缘时，它是在跟"照片"比对比度 ——
               碰上同色系（蓝调 / 大面积高亮）封面就瞎了，而**加粗不解决对比度问题，只放大噪音**。
               留出 2px 间隙后，环的内侧和外侧**都只面对网格底色**（深 #141414 / 浅 #f1f2f3），
               它于是站在"背景"上，而不是站在"照片"上 ⇒ 任何封面下都稳定可读。
               业界同款：Figma 的选择框、VS Code 的文件焦点、macOS 焦点环都是"留缝"派；
               Photoshop 更进一步用黑白交替的蚂蚁线 —— 本质都是"别让环和内容直接接触"。
               2px 是下限：再细会被封面边缘的像素噪声吃掉。
               ⚠️ 环仍画在格子外面，由容器的 `--ff-grid-ring-room`（6px）承接，
                  `3 + 2 = 5px < 6px` ⇒ 最左/最右两列不会被 `overflow:hidden` 裁掉。
               ⚠️ 3px 是主人定的（2026-11-08）：留缝之后环可以放心加粗，因为它已经不跟照片抢对比度了。 */
            outline: 3px solid var(--ff-highlight);
            outline-offset: 2px;
            /* 抬升阴影走 token：深色下大而虚（只为"这张在最前"），浅色下小而淡
               —— 浅底上那圈 4px 扩散的深阴影会变成一圈脏灰，主人 2026-11-07 的原话是"好丑"。 */
            box-shadow: var(--ff-shadow-lift);
            /* 进场 60ms（= 长按方向键两次移动之间的最小间隔），退场走基类的退场带。
               ⚠️ 60ms 这个数的来源是 `useGridCursor.MOVE_REPEAT_MIN_MS`，**不是**节奏 token：
               这一格必须在"下一次移动到来之前"画完，否则长按时光标一路跑、环一路追。
               60ms 短到几乎瞬时，但足以让环"长出来"而不是"啪一下贴上"。 */
            transition: outline-color 60ms var(--ff-ease-move),
                outline-width 60ms var(--ff-ease-move),
                outline-offset 60ms var(--ff-ease-move),
                box-shadow 60ms var(--ff-ease-move);
        }

        /* 标题也跟着变蓝：光有封面上那圈框，几十张里还是要"找一下"——
           文字变色是最容易被扫到的第二信号。
           ⚠️ 这里**不再改字重**：500 已经是默认（见 `.card-title`），焦点态若再加就
           得靠 600 才看得出变化，而全站禁 600/700。状态只靠"颜色 + 环"两层表达。 */
        .card-title {
            color: var(--ff-highlight);
        }
    }

    /* 焦点 + hover 不需要专门的权重守卫了：hover 只改标题色与图片缩放，碰不到焦点环 */

    /*
     * 「正在双击打开」—— 只读层解析锚点那一瞬。
     * ⚠️ 与 `.cursor` **不冲突**：`opening` 要点鼠标双击才会置位，方向键移动不会置位它，
     *   而 `opening` 那一格盖着深色遮罩 + 转圈，识别靠的是遮罩不是边框。
     * 只改颜色/外发光，不碰盒模型（盒模型一变，同行就不等高，分行算法会劈行）。
     */
    &.opening .card-cover {
        // 中性灰：这一态只出现在"只读层点开文件、等盘回来"的那一瞬，
        // 那一格已盖着深色遮罩 + 转圈（识别靠遮罩）⇒ 不需要抢颜色。
        outline: 2px solid var(--ff-text-3);
        /* 同 `.cursor`：靠容器的 `--ff-grid-ring-room` 承接，不用再往内画 */
        outline-offset: 0;
    }

    /* 遮罩与转圈分开两层：`.opening-mask` 负责铺满，`.n-spin` 留在 naive-ui 自己的定位里
       （它的根是 `.n-spin-body`，自带 translate(-50%,-50%)；去戳它就得连 transform 一起清）。
       绝对定位 ⇒ 尺寸跟卡片走、不参与布局（参与布局会改变行高，分行算法会劈行）。
       ⚠️ `z-index` 走契约的"临时遮罩"层：它要盖住封面图 + 角标 + 卡片标记
       （"正在双击打开"时整张卡都是这层画面），不给 z-index 就会被封面图盖住。 */
    .opening-mask {
        position: absolute;
        inset: 0;
        z-index: var(--z-card-mask);
        display: flex;
        align-items: center;
        justify-content: center;
        pointer-events: none;
        background-color: var(--ff-mask);
    }

    .pick-badge {
        position: absolute;
        top: 2px;
        right: 2px;
        /* ⚠️ 契约的"卡片标记"层：必须压过封面图（否则换封面时勾选圈看不见，
           2026-10-22 主人报）。 */
        z-index: var(--z-card-mark);
        display: block;
        width: 16px;
        height: 16px;
        flex-shrink: 0;
        box-sizing: border-box;
        font-style: normal;
        border-radius: 50%;
        background-color: var(--ff-status-ok);
        box-shadow: 0 0 0 1px var(--ff-on-highlight);

        &::after {
            content: '';
            position: absolute;
            left: 4px;
            top: 3px;
            width: 7px;
            height: 4px;
            border-left: 2px solid var(--ff-on-highlight);
            border-bottom: 2px solid var(--ff-on-highlight);
            transform: rotate(-45deg);
        }
    }

    /* 收录星标（2026-10-21 清单）：这张卡已进某个清单。
       纪律同 pick-badge：**绝对定位、不参与布局**（网格宽度是算出来的），
       换到左上角与 pick-badge（右上）错开。★ 用 CSS 生成，不插 DOM 子节点。
       ⚠️ `z-index` 走契约的"卡片标记"层（同 pick-badge）：压过封面图。 */
    .pl-badge {
        position: absolute;
        top: 2px;
        left: 2px;
        z-index: var(--z-card-mark);
        display: block;
        width: 16px;
        height: 16px;
        flex-shrink: 0;
        box-sizing: border-box;
        font-style: normal;
        font-size: 11px;
        line-height: 16px;
        text-align: center;
        border-radius: 50%;
        color: var(--ff-on-highlight);
        background-color: var(--ff-status-warn);
        box-shadow: 0 0 0 1px var(--ff-mask);

        &::before {
            content: '★';
        }
    }

    /* 已失效徽标（2026-11-06）：收藏夹内所属盘在线但确认丢失的条目。
       绝对定位右上角，深红底色白字，小圆角胶囊形，不参与布局。 */
    .pl-missing-badge {
        position: absolute;
        top: 3px;
        right: 3px;
        z-index: var(--z-card-mark);
        display: block;
        padding: 0 4px;
        height: 16px;
        line-height: 16px;
        font-style: normal;
        font-size: 10px;
        font-weight: 500;
        text-align: center;
        border-radius: 3px;
        color: var(--ff-on-highlight);
        background-color: var(--ff-danger-badge);
        box-shadow: 0 0 0 1px var(--ff-mask);
        pointer-events: none;
    }
}

/* 只为给 ScanGlow 一个定位祖先：动效覆盖的是"网格可视区"，不是整窗。
   这一层不参与任何其它职责 —— 里面那层仍是原来的滚动容器。 */
.image-box-wrap {
    position: relative;
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
}

/* 扫描动效期间网格整体失焦（transfer-glow 的第一步：内容先退到后面去）。
   ⚠️ `filter: blur()` 会整层重新栅格化，面积大就有掉帧风险（STUDY-MOTION §五 的警告）——
   这里刻意把半径压到 7px、时长 420ms，且只在动效期间存在，动效结束立刻移除。 */
.image-box.is-glowing {
    filter: blur(7px) saturate(0.92);
    opacity: 0.72;
    pointer-events: none;
}

@media (prefers-reduced-motion: reduce) {
    .image-box.is-glowing {
        filter: none;
        opacity: 0.5;
    }
}

.image-box {
    flex: 1;
    /* 列数**必须精确等于密度档给的 N**，一个都不能少。
       理由不是观感 —— `useGridCursor` 的 `deps.cols` 用"列数变了"来判定行结构缓存失效；
       实际渲染 7 列而配置是 8 时，这个判据永远不触发，方向键会一直用旧的行结构 ⇒ 错位。
       ⚠️ 不要用 `auto-fill` + `minmax(min-cell, 1fr)` 那套"窄窗少放几列"的写法：
       它既是"某些宽度下右边留白"的来源，又会让实际列数 ≠ N。
       窗口窄就格子小（12 列在 1024 窗下约 63px），这是固定列数的代价，不是 bug。
       ⚠️ 行距 6px 来自原来 margin-top 的值，列距仍是 `--ff-grid-gap` —— 别把两者并成一个值。 */
    display: grid;
    grid-template-columns: repeat(var(--ff-grid-cols, 6), minmax(0, 1fr));
    gap: 6px var(--ff-grid-gap);
    align-content: start;
    /* 焦点环让位量（6）定义在 `.file-finder`：顶栏也要用它算左边缘，放这里顶栏读不到。
       环画在格子**外面**，横向靠这里的 padding 兜住；
       纵向的 padding 滚动后就跑到视口外了 ⇒ 还要靠 `.image-box-item` 的 `scroll-margin-block`。
       上 / 左 / 右三边共用 `--ff-content-inset`（= 页边距 12 + 环让位 6 = 18）：顶栏、状态条、
       网格的缩进必须是**同一个算式**，否则"顶栏和第一列封面对不齐"会复发。
       ⚠️ 底边那 6px **单独给**，不是同一个算式：它是环让位而不是页边距 ——
       环 3 + 缝 2 = 5px 画在格子外面，滚到底时最后一行贴着 `overflow` 的裁剪边
       ⇒ 少这 6px 就会把环切掉半圈。 */
    padding: var(--ff-content-inset) var(--ff-content-inset) var(--ff-grid-ring-room);
    box-sizing: border-box;
    overflow: hidden auto;
    transition: filter 420ms ease, opacity 420ms ease;
    /* ── 卡片尺寸变量：**按密度档位在这里改，子元素只读** ──────────────────────────
       为什么做成变量而不是给紧凑档另写一套 `.card-title` 规则：
       标题高/字号/行高必须**一起**换（高换了字号没换 = 两行塞不下成省略号；
       字号换了高没换 = 下方留一块空）。写成一组变量，档位就是一处覆盖。
       ⚠️ 这一组值只允许在这里出现一次 —— 别在 `.card-title` 里再写死 40px。 */
    --item-pad-b: 6px;
    --item-title-h: 40px;
    /* 15 / 20：字高比 1.33。原来是 14 —— 换字体后 MiSans 的中宫比雅黑略收，
       同样 14px 看起来更小，所以抬到 15。行高不动 ⇒ 两行仍是 40，网格行高零变化。 */
    --item-title-fs: 15px;
    --item-title-lh: 20px;
    --item-badge-h: 18px;
    --item-badge-fs: 12px;

    /* 紧凑档（12 列，格宽 147px）：标题占封面的比例从 30% 降到 26%，
       字号收到 12px —— 14px 在 147px 宽里一行只剩 10 个字，两行就是"半截标题"。 */
    &[data-density='tight'] {
        --item-pad-b: 4px;
        --item-title-h: 34px;
        --item-title-fs: 12px;
        --item-title-lh: 17px;
        --item-badge-h: 16px;
        --item-badge-fs: 11px;
    }

    /* 2026-11-07 起改成 `grid` + `gap`（见上面 `grid-template-columns`）——
       原来那套「`calc(100%/N − gap)` + 左右各 gap/2 margin + 容器外扩 gap/2」的补偿算法
       已整段删除：它在 `min-width` 触发换行时会少放一格，而剩下的空间没人接
       （现象就是"标准 8 / 紧凑 12 在某些宽度下右边留白"）。grid 下边缘天然为 0，不需要补偿。
       ⚠️ `probes/grid-cursor/` 的几何数据是**旧布局**的，下次动列宽/贴边必须重跑那两个探针。 */
}

/* 空状态：一行小字，落在网格区的**视觉中间**。
   ⚠️ 不用 `margin:auto`：`.image-box` 是 `align-content:start`，行始终贴顶，
   纵向 auto margin 吸不到余量（实测会停在顶部）。给它自己一个视口比例的高度 + flex 居中，
   就不依赖父容器的对齐规则。 */
.empty-tip {
    /* grid 下 `width:100%` 只是一列宽 ⟹ 必须跨满整行 */
    grid-column: 1 / -1;
    width: 100%;
    min-height: 52vh;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 14px;
    color: var(--ff-text-3);
}

/**
 * 卡片底座：网格格子与弹层条目**共用**的那一点东西（盒模型 + 边框 + 过渡）。
 *
 * ⚠️⚠️ **只放两者真的共用的属性。** 原来这个选择器里还塞着网格的整套尺寸算法
 *（`--item-height` 的 `!important` 高度、`white-space:nowrap`…），于是它们**原样漏进了弹层**：
 * 弹层的 `.file-cover` 被压成 0 高（等于从来没画出来）、文件名被压成单行 + 尾部省略
 *（业主 2026-10-05：「多个文件弹出层好丑」，4 个文件显示成一模一样的 `[TST-59…`）。
 * ⇒ 按"谁的属性谁持有"拆开：网格那半在下面 `.image-box-item`，弹层那半在 `.file-item`。
 *
 * ⚠️ 2026-10-21 再拆一次：网格卡片现在是"封面 + 标题 + 角标"，**没有边框也没有悬停底色**
 *（B 站那套）。所以这条只留给弹层 —— 之前忘了拆，网格 hover 时冒出一圈灰边框，
 * 正是主人截图里"悬浮难看"的那一条。
 */
.file-item {
    display: flex;
    flex-direction: column;
    align-items: center;
    box-sizing: border-box;
    border: 1px solid transparent;
    transition: border-color .1s ease-in-out, box-shadow .1s ease-in-out,
        background-color .1s ease-in-out, transform .18s cubic-bezier(.2, .9, .3, 1.1);
    user-select: none;

    &:hover {
        border-color: var(--ff-highlight-line);
        background-color: var(--ff-highlight-weak);
    }

    &:active {
        border-color: var(--ff-highlight);
        background-color: var(--ff-highlight-weak);
    }
}

/**
 * 网格卡片（B 站视频卡的骨架）。
 *
 * 高度**只由宽度决定**：封面定比例 + 标题两行定高。
 * ⚠️ 这是 `gridGeometry.groupRows()` 的前提 —— 同行必须等高（它按 `offsetTop` 分行，
 *    一行里混进一个矮格子就会被劈成两行，方向键从此横着跳）。所以标题区按档位定高
 *    （`--item-title-h`），绝不由内容撑。
 *
 * 列数**不在这里写死**：`--ff-grid-cols` 由密度档位给（`density.ts` → `.image-box` 的 style），
 * 默认 6 兜底（`var(--ff-grid-cols, 6)`）只防"变量没绑上"这一种情况。
 */
.image-box-item {
    /* 宽度全部交给 grid 的 `1fr`（见 `.image-box`）。
       `min-width: 0` 是 grid item 的必要项 —— 默认 `auto` 会被内容撑破列宽。 */
    min-width: 0;
    /* ⚠️ 别删：`scrollIntoView({ block: 'nearest' })` 只保证**边框盒**可见，而焦点环画在格子外。
       容器横向 `overflow: hidden` 靠 padding 兜住，纵向的 padding 一滚动就出了视口
       ⇒ 顶行/底行的环会被削掉。`scroll-margin` 让浏览器在判"看得见"时就把这圈余量算进去。
       值来自 `.image-box`，与那边的 padding 共用 —— 改一处即可，别在这里写死数字。 */
    scroll-margin-block: var(--ff-grid-ring-room);
    padding: 0 0 var(--item-pad-b);
    display: flex;
    flex-direction: column;
    align-items: stretch;
    box-sizing: border-box;
    border: 0;
    user-select: none;
    /* ⚠️ 必须短于方向键连发间隔。真正管这件事的是 `useGridCursor.MOVE_REPEAT_MIN_MS = 60ms`
       （长按只节流 `e.repeat`，单击零延迟），不是 `usePreview.KEY_REPEAT_MIN_MS = 100ms`
       —— 那个是**预览层**翻页的节流，2026-11-08 核对时发现原注释引错了对象。
       原来是 .18s，比间隔还长 ⇒ 每次过渡都跑不完就被下一次打断，快移时等于没有反馈。 */
    transition: transform .08s ease-out;

    /* 封面：16:9 定比例 + 圆角 token。裁切交给这一层，图片自己只负责填满。
       `overflow:hidden` 在这里是**必须**的（圆角要裁图）；焦点环画在 `outline` 上，
       不会被自己的 overflow 裁掉 —— 这也是不用 box-shadow 画环的原因。 */
    .card-cover {
        position: relative;
        /* ⚠️ 封面块自己是层叠上下文（契约里的"封面内部"三层的容器）——
           内部的模糊底/图/角标/绿圈只在封面内排序，不与卡片外的浮层纠缠。 */
        isolation: isolate;
        width: 100%;
        /* 比例是 token：实测本库缩略图多在 1.6 左右（16:10），16:9 会左右留边。
           想再调只改 `--ff-cover-ratio` 一个值。 */
        aspect-ratio: var(--ff-cover-ratio);
        display: flex;
        align-items: center;
        justify-content: center;
        overflow: hidden;
        border-radius: var(--ff-radius-card);
        background: var(--ff-fill);
        /* 浅色下白封面贴在白卡片上没有边界，靠一圈发丝线定形；
           深色下 `--ff-card-outline` 是 transparent（靠明度差就够，加线只会脏）。
           `outline` 不参与布局、也不会被自己的 `overflow:hidden` 裁掉。 */
        outline: 1px solid var(--ff-card-outline);
        outline-offset: -1px;

        /* 焦点环的**退场**（进场在 `&.cursor` 里被覆盖成 60ms，见那里）：
           3px 的高亮环缩回 1px 发丝、2px 的留缝收回 0、抬升阴影淡掉 —— 都用"退场带"。
       ⚠️ 为什么只在这边写：环是"光标在哪一格"的**位置信号**，进场迟到就会出现
       "环追不上光标"（长按方向键每 60ms 走一格）。退场没有这个义务 ——
       让它慢一拍缩回去，两张卡之间就变成**交接**而不是硬切。
       ⚠️ 三个属性都能插值（`outline-width` / `outline-offset` 是长度，`outline-color` 是颜色）；
       `box-shadow` 从 `none` 到实体阴影 Chromium 也按"全 0 透明"插值，不会跳。 */
        transition: outline-color var(--ff-dur-exit) var(--ff-ease-move),
            outline-width var(--ff-dur-exit) var(--ff-ease-move),
            outline-offset var(--ff-dur-exit) var(--ff-ease-move),
            box-shadow var(--ff-dur-exit) var(--ff-ease-move);

        /* 模糊底（见 `coverBackdrop()` 的注释）：把同一张图放大、模糊、压暗铺满整框。
           `inset:0` + `scale(1.15)`：blur 会吃掉边缘像素，放大一点才不会有透明边。
           ⚠️ 没有图（`--cover-src` 未设）时背景是 `none`，这一层等于不存在。 */
        &::before {
            content: '';
            position: absolute;
            inset: 0;
            background-image: var(--cover-src, none);
            background-size: cover;
            background-position: center;
            filter: blur(18px);
            transform: scale(1.15);
            opacity: 0.5;
            pointer-events: none;
        }

        /* ⚠️ 必须 `:deep()`：`<img>` 是 naive-ui 的 `n-image` 内部节点，**拿不到本组件的
           scoped 属性** ⇒ 写成 `.card-cover img` 会编译成 `img[data-v-x]`，一条都命中不了，
           图片就按原始尺寸贴在左上角（主人 2026-10-21 截图报的"图片没居中"就是这个）。
           旧代码用的是 `&:deep(img)`，我重写时丢了这层。 */
        :deep(.n-image) {
            position: relative;
            z-index: var(--z-cover-img);
            width: 100%;
            height: 100%;
        }

        /* 宽高都撑满 + `contain` + `object-position:center`：
           比例不一致时**上下或左右留白，但图始终居中**（留白由封面底色兜住）。 */
        :deep(.n-image img) {
            display: block;
            width: 100%;
            height: 100%;
            object-fit: contain;
            object-position: center;
            transition: transform .25s ease;
        }

        /* 目录/未知类型：图标按封面的比例缩，不撑满（70% 在密网格里太抢眼）
           `position/z-index` 是为了压在模糊底之上（绝对定位的 `::before` 会盖住静态子元素） */
        .folder-face {
            position: relative;
            z-index: var(--z-cover-img);
            width: 56%;
            height: auto;
            object-fit: contain;
        }

        .file-face {
            position: relative;
            z-index: var(--z-cover-img);
            width: 56%;
            font-size: 40px;
        }
    }

    /* 角标（B 站封面下沿那一排）：数量在左、大小在右。
       `pointer-events:none` —— 它盖在封面上，点它应该等于点封面。 */
    .card-badges {
        position: absolute;
        left: 6px;
        right: 6px;
        bottom: 6px;
        /* ⚠️ 必须压过图片（契约的"封面角标"层）：图片那层为了盖住模糊底设了
           `z-index`，不写这一行角标会被图片**盖住**（2026-10-21 主人截图报的"大小被遮挡"）。 */
        z-index: var(--z-cover-tag);
        display: flex;
        justify-content: space-between;
        pointer-events: none;

        .badge {
            max-width: 62%;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            padding: 0 6px;
            /* 尺寸随密度档位走（见 `.image-box` 的 `--item-badge-*`）：
               `line-height` 必须同 `height` 一起换，否则文字会偏上/偏下。 */
            height: var(--item-badge-h);
            line-height: var(--item-badge-h);
            border-radius: var(--ff-radius-pill);
            background: var(--ff-mask);
            color: var(--ff-on-highlight);
            font-size: var(--item-badge-fs);
        }
    }

    /* 标题：永远两行高度（单行也留白）—— 见块头那条"同行等高"的约束。
       ⚠️ 三个值（高/字号/行高）由密度档位给，成组变化；14px 是"宽松档 310px 卡片里
       放得下 8 个汉字"的那一档，紧凑档另有一套（见 `.image-box[data-density='tight']`）。 */
    .card-title {
        margin-top: 6px;
        height: var(--item-title-h);
        display: -webkit-box;
        -webkit-box-orient: vertical;
        -webkit-line-clamp: 2;
        overflow: hidden;
        word-break: break-all;
        font-size: var(--item-title-fs);
        line-height: var(--item-title-lh);
        /* 标题默认 500（2026-11-08 主人定）。全站只有 400 / 500 两档，**禁 600/700**：
           700 的中文在 13~14px 会发糊，而 500 在深色底上已经足够从正文里"跳出来"。
           加粗不改行高 ⇒ 两行截断的高度仍是 `--item-title-h`，不影响下方留白。 */
        font-weight: 500;
        color: var(--ff-text-1);
        transition: color .15s ease;
    }

    /* hover：图轻微放大 + 标题变蓝，**不加边框不加底色** */
    &:hover {
        :deep(.n-image img) {
            transform: scale(1.03);
        }

        .card-title {
            color: var(--ff-highlight);
        }
    }

    /* 目录的脸：70%（常态）↔ 100%（换封面，要看得清）。
       ⚠️ 2026-11-08：原来是模板里的内联 `width/height: 70% ↔ 100%` —— 那是**布局动画**：
       进/出「换封面」会让一屏几百个目录同时改宽高，每帧重排几百张卡片，必然发涩。
       改成「盒子恒 100% + `transform: scale()`」：视觉结果**完全一样**
       （`object-fit: contain` 在 100% 的盒子里按比例缩满，再整体乘 0.7 = 原来的 70% 盒子），
       但 `transform` 不触发布局，只重绘自己那一层。
       ⚠️ 曲线与时长直接用"一拍"：它和面包屑、底部条是同一个节奏，不是另开一套。
       ⚠️ 别改回内联宽高 —— 那样连过渡都没法写（内联值是字符串拼接，每次切换都是硬跳）。 */
    .card-avatar {
        transform: scale(0.7);
        transition: transform var(--ff-dur-move) var(--ff-ease-move);
    }

    &.pickable .card-avatar {
        transform: scale(1);
    }

    @media (prefers-reduced-motion: reduce) {
        .card-avatar {
            transition: none;
        }
    }

    /*
     * 可预览的图（模板里挂 `class="can-preview"`）要保留"能点"的手势提示。
     * 为什么得补这一行：预览层改由 `n-image-group` 渲染后，网格里的 n-image 一律
     * `preview-disabled`，而 naive-ui 的 `.n-image` 只在**没** disabled 时给 `cursor: pointer`
     * （`image/src/styles/index.cssr.mjs` 的 `cNotM("preview-disabled", "cursor: pointer")`）。
     * 点开预览的行为本身由 `img-props.onClick` 接走（见模板注释），这里只补回视觉。
     * 目录的脸不该有这行 —— 它本来就不给点开，所以靠 `can-preview` 这个类区分，不是全靠 disabled。
     */
    .n-image.can-preview {
        cursor: pointer;
    }

    /* ⚠️ 旧的「文件名」规则（`height:38px !important` + 单行省略）整段删了：
       它对 `span` 全局生效，会把角标里的 `span` 一起拉成 38px 高。
       名字现在由 `.card-title` 管（两行定高），角标由 `.card-badges` 管。 */
}

/**
 * 弹层里的文件列表容器（与 `.hstack` 同一个节点）。
 *
 * `.hstack` 本身已经会换行，这里只补一条**宽度上限**：4 个 150px 的条目
 * 加间距正好 636px，所以 660px 恰好「一行 4 个」；再多就换行，
 * 而不是把弹层横向撑到屏幕外。
 */
.file-list {
    max-width: min(660px, 88vw);

    /**
     * ⚠️ 抑制**浏览器默认焦点环**（业主 2026-10-05：「弹出层是橙色边框」）。
     *
     * 那个橙色不是项目里的颜色 —— 全仓 grep 没有任何橙色字面量，naive-ui 的 popover
     * 样式里也没有 `outline`。它是 UA 的 `:focus-visible { outline: auto }`，
     * 而 `outline: auto` 的色值取自**系统强调色**（这台机器的强调色是橙的）
     * ⇒ 换个系统主题它就换颜色，属于"界面里冒出一个谁也解释不了的框"。
     *
     * 为什么该抑制：这个容器 `tabindex="-1"` 的意义就是**接住方向键**
     *（`openFileList` 里那句 `focus()`，见它上面的注释），它不是一个"控件"；
     * 这一层的"我在哪"由 `.file-cursor` 的蓝色边框表达 ⇒ 焦点环纯属噪音。
     * 声明放在**元素自己**身上，而不是给将来每个 focus 调用点加守卫。
     */
    &:focus,
    &:focus-visible {
        outline: none;
    }
}

/**
 * 弹层条目：「同一作品的多个文件」，双击封面时问打开哪一个。
 * ⚠️ 文件名往往同前缀、尾部才是区分点 ⇒ 必须可换行（最多 3 行）+ 类型图标 + 灰色大小，别用 nowrap / 定高截断。
 * ⚠️ 这里不该出现 !important：若需要靠它压过网格样式，说明拆分没拆对。 */
.file-item {
    width: 150px;
    height: 116px;
    padding: 10px 8px;
    margin: 0; // 间距只由 `.hstack` 的 gap 提供 → 一处来源
    justify-content: flex-start; // 图标统一贴顶 ⇒ 一排卡片的图标对齐，好扫
    gap: 4px;

    /**
     * 类型图标。`fiv-cla` 的尺寸就是 `1em`（`line-height:1em; width:.72em`）
     * ⇒ 用 `font-size` 定大小。`.file-cover` 自带的 `blank.svg` 是**未知扩展名的兜底**
     *（`fiv-icon-*` 有匹配时按注入顺序覆盖它）。
     */
    .file-cover {
        font-size: 26px;
        margin: 0;
        flex: 0 0 auto;
    }

    /**
     * 文件名。**必须换行** —— 这一层几个文件名的前缀往往一样，
     * 尾部省略等于把**唯一的区分点**藏起来。最多 3 行，装不下就截断
     *（完整名字在整格的 `title` 里）。
     */
    span {
        /* 多行"..."：**只有 `-webkit-box` 这一种 display 能让 `-webkit-line-clamp` 生效**
           （`block` / `-webkit-box` 之外都不吃这个属性 —— 设了也静默无效）。
           业主 2026-10-05：「标题过长没有省略号」—— 上一版只 `overflow:hidden`，
           长名字是被**硬切**的，看不出"后面还有"。 */
        display: -webkit-box;
        -webkit-box-orient: vertical;
        -webkit-line-clamp: 3; // 与下面 `max-height` 同一个预算：3 行 × 15px
        width: 100%;
        max-height: 45px; // ⚠️ 兜底：万一哪个版本不认 line-clamp，也不许把卡片撑破
        line-height: 15px;
        font-size: 13px;
        color: var(--ff-text-1);
        font-weight: 400;
        text-align: center;
        white-space: normal;
        /* ⚠️ 不能写 `word-break: break-all`（那会**逐字符**断，把 `[TST-593]`、`CD1.mp4`
           这种拉丁串也从中间劈开 —— 第一版就是，读起来很碎）。
           `overflow-wrap: break-word` 只在"整词放不下"时才断，中日韩本来就能逐字折行。 */
        overflow-wrap: break-word;
        overflow: hidden;
    }

    /**
     * 大小。⚠️ 用 `<i>` 而**不是** `<span>` —— 否则会被上面那条 `span` 规则
     * （`max-height: 45px` / `font-size: 13px`）一起吃掉。
     * 与网格里那个选中角标用 `<i>` 同一个理由。
     */
    .file-size {
        flex: 0 0 auto;
        /* 钉在卡片底部：名字 1～3 行都能变 ⇒ 让多出来的空白落在**名字和大小之间**，
           而不是整块吊在卡片下方（`align-items/justify-content` 都做不到这一条 ——
           它们的作用对象是整组子元素，不是"最后一个"). */
        margin-top: auto;
        font-style: normal;
        font-size: 12px;
        line-height: 14px;
        color: var(--ff-text-2);
    }

    /*
     * 键盘高亮的那一项（`Enter` 打开多文件封面后，←→ 走的就是它）。
     * ⚠️ 沿用网格那条"只改边框色"的手法：`.file-item` 从上面那个**共用底座**
     * 继承了 `border: 1px solid transparent` 与 `transition`，
     * 所以**不需要**新增任何盒模型属性，只改颜色即可。
     *
     * ## ⚠️⚠️ 原来是 `0 0 0 2px 黑, 0 0 0 4px 蓝` 的**双环**（业主 2026-10-04 六次报"丑死了"）
     *
     * 实测（`docs/probes/cursor-visual-weight/`，真 Chromium 量`getComputedStyle`）：
     * 那一版可见环总厚 **5px**，而网格的 `.cursor` 只有 **1px** ——
     * **同一屏里两种焦点粗细差 5 倍**。弹层是**盖在网格上**的，
     * 两者会**同时出现在一个视野里** ⇒ 那个突兀是设计出来的，不是错觉。
     *
     * ⚠️ 而且这**与它自己的注释矛盾**：注释写着"与网格的 `.cursor` 同一套焦点语言
     *（不透明主色环 + 内层深线）"，而网格那条**从来没有**"内层深线"。
     * ⇒ 那是 v2 方案（被否掉的那版）的残留，注释没跟着改。
     *
     * ⇒ 现在与网格**真的**同一套：1px 主色边框 + 同一份淡蓝灰底 + 同一份柔和阴影。
     * 这一层与网格不共处一屏，但"我在哪"的手感必须一致 —— 一致靠**同一份值**，不靠注释。
     */
    &.file-cursor {
        border-color: var(--ff-highlight);
        // 与 `.image-box-item.cursor` **逐条相同**（边框 + 淡底，不碰盒模型、不加阴影）
        background-color: var(--ff-highlight-weak);
    }
}

.file-cover {
    display: block;
    margin: 10px 0;
    object-fit: contain;
    overflow: hidden;
    background-image: url(@/assets/fileTypeIcon/blank.svg);
}

/**
 * 计数角标的入场 —— 必须用 `@keyframes` 而不是 `transition`：
 * 它是 `::after` 伪元素，**选择器命中那一刻才被创建**，没有"上一帧"可以过渡，
 * 不加动画就是"啪"地冒出来。
 *
 * ⚠️ 2026-11-08 第七轮：**只淡入，不要 scale**。
 * 原来带 `scale(0.7) → scale(1)`，等于让眼睛在一个 18px 的小胶囊上
 * 看一次"从中间胀出来"的运动。主人已经明确"换层时不许有别的东西在动"，
 * 而角标是纯信息 —— 只留透明度。
 */
@keyframes fx-badge-in {
    from {
        opacity: 0;
    }

    to {
        opacity: 1;
    }
}
</style>

<!--
  预览层的**布局**（2026-10-04）。刻意**不带scoped**，理由与 `HistoryTable` 那个
  非 scoped 块同源：工具条与图都被 naive-ui teleport 到 body，`<style scoped>`
  的 data-v属性只打在本组件模板里的元素上，够不到它们。

  隔离靠 `.n-image-preview-container` 前缀 + **多一层祖先**提高特异性 ——
  naive-ui 的规则是 cssr 运行时注入的单类选择器（`.n-image-preview-toolbar`），
  同特异性的先后顺序不可控（运行时注入可能排在我的静态样式之后）。加上祖先层之后
  变成 (0,2,1) 对 (0,1,0)，**稳定赢过顺序**，因此不必写 `!important`。

  ⚠️ 这不是"改naive-ui 的样式值"，是**用它在 CSS 里预留的变量/结构表达布局**：
  `.n-image-preview-wrapper` 是 `position:absolute; inset:0` 的 flex 容器，
  我们只给它加padding —— 图的`height:100%` / `width:100%` 是相对**内容盒**解析的，
  所以 padding 一加，图的可得区域就跟着缩，**不需要碰图本身**（图上有 inline style，
  碰它要先和 `previewedImgProps` 打架）。
-->
<style>
/* ① 图：上/左/右各留 16px（和改之前一致），底部留 64px = 工具条 48 + 间隙 16。 */
body>.n-image-preview-container .n-image-preview-wrapper {
    padding: 16px 16px 64px;
    box-sizing: border-box;
}

/* ③ 开合过渡 token 化（2026-11-09）。naive 原装：进出场都是 .2s、进场 scale .9 弹得太大、
      退场还缩尺（元素都在消失了不该再变形）。改按动效预算：
      进场 = 260ms + --ff-ease-enter（过冲 1.28 的 Q 弹曲线，LeiBox 弹簧的 CSS 近似：
      弹簧积分器只在「动画可打断」时必要，预览开合是一次性动作，Bezier 过冲拿到 80% 手感）；
      起始 scale .9（行程够长，过冲才看得见：峰值 ≈1.014 再回落）；
      退场 = 140ms 只淡出（退出永远比进入短，且不缩放）。
      ⚠️ 只影响开/关那一瞬：transition 类在动画结束后被 Vue 摘掉，
      之后的缩放/拖动（naive 每次重写整段内联 cssText）完全不受影响。 */
body>.n-image-preview-container.fade-in-transition-enter-active {
    transition: opacity .26s var(--ff-ease-enter) !important;
}

body>.n-image-preview-container.fade-in-transition-leave-active {
    transition: opacity .14s ease-out !important;
}

body>.n-image-preview-container .n-image-preview.fade-in-scale-up-transition-enter-active {
    transition: opacity .26s var(--ff-ease-enter), transform .26s var(--ff-ease-enter) !important;
}

body>.n-image-preview-container .n-image-preview.fade-in-scale-up-transition-enter-from {
    opacity: 0;
    transform: scale(.9);
}

body>.n-image-preview-container .n-image-preview.fade-in-scale-up-transition-enter-to {
    opacity: 1;
    transform: none;
}

body>.n-image-preview-container .n-image-preview.fade-in-scale-up-transition-leave-active {
    transition: opacity .14s ease-out !important;
}

body>.n-image-preview-container .n-image-preview.fade-in-scale-up-transition-leave-to {
    opacity: 0;
    transform: none;
}

/* ④ 切图溶解（View Transitions，usePreview 的 onPreviewCurrentChange 触发）：
      压短到 .18s；工具条排除在快照外（它有自己的 WAAPI 宽度动效，别让 VT 快照盖住）；
      VT 层不拦指针（否则溶解的 0.18s 里点 ✕ / 遮罩会失灵）。 */
::view-transition {
    pointer-events: none;
}

::view-transition-old(root),
::view-transition-new(root) {
    animation-duration: .18s;
}

body>.n-image-preview-container .n-image-preview-toolbar {
    view-transition-name: none;
}

/* ════ 右键菜单（2026-11-09 重构：横排小按钮 → Apple 式纵向菜单）══════
   内容被 n-popover teleport 到 body，scoped 够不到 ⇒ 非 scoped + .ctx- 前缀兜作用域。
   比例对齐 Apple PC 菜单（Big Sur+ 实测量级）：行高 24 紧凑档、图标-文字 8px、
   菜单内衬 4px、分隔线短且细、圆角 6 —— 密度上去"设计感"才出得来。 */
.ctx-menu {
    display: flex;
    flex-direction: column;
    gap: 1px;
    min-width: 188px;
    padding: 3px;
    box-sizing: border-box;
    outline: none;
}

/* n-popover 自带的内衬 padding 对菜单是多余的，:has 精准只打这一个 popover */
body>.n-popover:has(>.ctx-menu) {
    padding: 3px;
}

.ctx-item {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 26px;
    padding: 0 7px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--ff-text-1);
    font: inherit;
    font-size: 13px;
    text-align: left;
    cursor: pointer;
    transition: background-color var(--ff-dur-hover) ease;
}

.ctx-item:hover {
    /* 菜单悬停走 --ff-menu-hover（语义正确的既有 token，白底上 0.10 太耳语已提一档） */
    background: var(--ff-menu-hover);
}

.ctx-item:disabled {
    opacity: .4;
    cursor: default;
}

.ctx-item:active {
    background: var(--ff-ctl-on);
}

.ctx-label {
    flex: 1 1 auto;
    white-space: nowrap;
}

.ctx-arrow {
    margin-left: auto;
    color: var(--ff-text-2);
}

.ctx-sep {
    height: 1px;
    margin: 3px 8px;
    background: var(--ff-line);
}

/* ② 工具条（2026-11-09 重构）：回归 naive 原生的「居中胶囊」—— 通栏是旧裁定
      （"别浪费两侧空间"），但 9 颗图标摊在 2048px 上视觉重量全失（主人不满意）。
      现在：居中 bar + 玻璃底 + 三组结构（分组与选框见 .ptb-*）。 */
body>.n-image-preview-container .n-image-preview-toolbar {
    left: 50%;
    right: auto;
    bottom: 8px;
    transform: translateX(-50%);
    /* ⚠️ 必须显式 border-box：宽度 FLIP 用 GBCR/offsetWidth（border-box）量、用 WAAPI width
       （默认 content-box）写 —— 差的正好是左右 padding 20px，表现为主人看到的
       「先胀 20px 再缩回」的假过冲。同一个值两个盒模型，量与写必须同框。 */
    box-sizing: border-box;
    max-width: min(92vw, 980px);
    height: 48px;
    padding: 0 10px;
    border-radius: 999px;
    /* 宽度 FLIP 期间内容（已是新尺寸）会比动画中的 bar 宽——裁掉，别让图标戳出胶囊外 */
    overflow: hidden;
    /* ⚠️ 内容锚定右缘（flex-end）：bar 宽度动画时按钮群永远「骑在移动的边上」一起滑，
       空白只出现在最左（信息侧被揭示/收回）—— 否则收缩时 ✕ 旁边会凭空多出一段死玻璃
       （真机：变宽丝滑、变窄难受的根源）。 */
    justify-content: flex-end;
    /* 预览层的底色永远是"照片"，所以这组值**不随主题**，见 tokens 里的 `--ff-media-*`。 */
    background: var(--ff-media-bar-bg);
    backdrop-filter: blur(20px) saturate(140%);
    box-shadow: var(--ff-media-bar-shadow);
    /* ⚠️ 图标与文字必须显式给浅色：naive 的 `--n-icon-color` 会继承 `common.iconColor`
       （我们把它设成了次要灰 text-2），直接落到这条工具条上就成了"灰图标压在暗底"。 */
    color: var(--ff-media-icon);
    --n-icon-color: var(--ff-media-icon);
    --n-icon-color-hover: var(--ff-media-icon-hover);
}

/* ── .ptb-* 工具条内部结构（usePreview.ts 的 previewToolbar 渲染）────────── */

.ptb-info {
    display: flex;
    align-items: center;
    min-width: 0;
    padding: 0 12px 0 8px;
}

.ptb-name {
    max-width: min(40vw, 560px);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 13px;
    font-weight: 500;
    color: var(--ff-media-icon);
}

.ptb-count {
    margin-left: 10px;
    font-size: 12px;
    color: var(--ff-media-icon);
    opacity: .55;
    white-space: nowrap;
}

.ptb-tools {
    position: relative;
    display: flex;
    align-items: center;
}

/* 滑动选框：同一颗节点在图标间滑（LeiBox live-selection-box；曲线照抄 builder 源码）。
   left/width 由 JS 写（pointerenter 时量 cell），opacity 管进出。 */
.ptb-sel {
    position: absolute;
    /* ⚠️ 相对 .ptb-tools（36px 高，被 flex 夹在 48px 条中间居中），不是整条工具条
       —— top:6px 会整体下沉 6px（真机截图：图标偏上、框偏下）。0 = 与 cell 完全对齐。 */
    top: 0;
    height: 36px;
    left: 0;
    width: 0;
    border-radius: var(--ff-r-ctl);
    background: var(--ff-media-bar-sel);
    opacity: 0;
    pointer-events: none;
    transition:
        left .35s cubic-bezier(.2, .8, .2, 1),
        width .35s cubic-bezier(.2, .8, .2, 1),
        opacity .18s ease-out;
}

.ptb-sel.is-on {
    opacity: 1;
}

/* 首现纪律（RailTip 同款）：藏着的选框不做位移补间 —— 第一次出现直接落在
   当前图标上只做淡入；之后在图标之间移动才滑。否则截图里那种
   "从 0 滑过来的一瞬"会被看成"没对齐"。 */
.ptb-sel:not(.is-on) {
    transition: opacity .18s ease-out;
}

.ptb-cell {
    position: relative;
    z-index: 1;
    width: 36px;
    height: 36px;
    display: grid;
    place-items: center;
    border-radius: var(--ff-r-ctl);
    cursor: pointer;
    /* 按下回弹：过冲曲线同族（主人 2026-11-09 "不够Q弹"） */
    transition: transform .18s var(--ff-ease-enter);
}

.ptb-cell:active {
    transform: scale(.94);
}

/* naive 的图标 span 自带 padding 0 8px / font-size 28px —— 塞进 36px 格子前拍平 */
/* ⚠️ 图标元素必须**填满整个 cell**：naive 的点击处理器挂在图标 span 自己身上，
   图标只有 20px ⇒ cell 其余 16px 点了没反应（主人：滑块多大，点击区就得多大）。
   撑满后点击区 = 选框 = 36px，三个面积重合。 */
body>.n-image-preview-container .ptb-cell > * {
    width: 100%;
    height: 100%;
    display: grid;
    place-items: center;
    padding: 0;
    font-size: 20px;
    line-height: 1;
}

.ptb-sep {
    width: 1px;
    height: 22px;
    margin: 0 8px;
    background: var(--ff-media-bar-line);
}

/* ✕ 与变换组之间额外加大间距（「下载紧邻 ✕ 造成误触」的教训） */
.ptb-sep-wide {
    margin: 0 8px 0 18px;
}

/* ══════════════════════════════════════════════════════════════════
   导航区（面包屑）的过渡 —— 非 scoped 块：这些类由 Vue 运行时**动态**加到
   `n-tag` / `n-tooltip` / 组件根节点上，scoped 块的属性选择器够不到它们
   （与上面工具条同因）。用 `.nav-zone` 前缀兜住作用域。

   ⚠️ 三类必须分开写，**不能合成一条 `transition: all`**：
     · `-move`   FLIP：只有"路径长到要挤压"时才命中（正常增删**没有一个邻居会动**，
                 所以它平时是静默的空转）。留着是因为它顺便兜住宽度上限
                 触发整排收缩那种情况，不留就会硬挤。
     · `-enter`  进入：位移归位 + **延迟显形**（拍内分带，见下）
     · `-leave`  脱离文档流后**当场淡出**（前 45% 的一拍内消失，见下）
   ══════════════════════════════════════════════════════════════════ */
.nav-zone .fx-move {
    transition: transform var(--ff-dur-move) var(--ff-ease-move);
}

/* 进入 = **先落位、后显形**（2026-11-08 第八轮，照搬 Torph 的拍内分带）。
   `opacity` 延迟 25% 拍、只用后 50% 拍显形 —— 前 50ms 里这一格已经在最终位置上
   但几乎全透明，所以 6px 的归位只在最后一小段露出来，读起来是"从上一段里长出来"
   而不是"从左边滑进来"。位移本身仍是完整一拍，不跟着透明度缩水。 */
.nav-zone .fx-enter-active {
    transition: transform var(--ff-dur-move) var(--ff-ease-move),
        opacity var(--ff-fade-in) linear var(--ff-fade-in-delay);
}

.nav-zone .fx-enter-from {
    opacity: 0;
    transform: translateX(-6px);
}

/* 退出 = **先由 JS 钉死在最后的位置上、再淡出**（`@before-leave="pinLeaving"`）。
   ⚠️ 2026-11-08 第四轮：上一版写的是 `display: none`（同步塌掉）。主人反馈
   「进正常、退会跳」—— 因为 **enter 有 300ms、leave 是 0ms**，不对称得看得见。
   ⚠️ 但不能只把 `display: none` 换成淡出：留着占位 ⇒ 整排这 180ms 里不动、
   结束时一帧塌回去，Vue 的 FLIP 也全程量到位移差 0（它只在 `onUpdated` 量一次）
   ⇒ 一帧都没滑（第二轮就踩过这个）。
   ⇒ 两头都要：**脱离文档流**（行立刻塌、FLIP 量到的是真位移）+ **位置钉死**。
   `position: absolute` 单独用不行 —— flex 容器里的绝对定位子项，静态位置按
   "它是唯一的 flex 项"算 ⇒ 会被丢到内容区最左边、整段瞬移。所以 left/top/width/height
   在 `before-leave` 里从 `getBoundingClientRect()` 抄一份。
   ⚠️ 用 `absolute`（相对 `.nav-zone`）而不是 `fixed`：fixed 的坐标系会被祖先的
   transform / filter 改写，absolute + 自己算偏移不吃这个亏。
   ⚠️ 本块在非 scoped `<style>` 里，`.nav-zone` 前缀负责兜住作用域。 */
.nav-zone .fx-leave-active {
    /* ⚠️ 透明度必须 **linear**，不能跟位移共用 `--ff-ease-exit`：
       那条曲线是给位移用的（前重后轻），拿它淡出时 180ms 的 **90ms 处就已经掉到 0.1**
       ⇒ 肉眼看就是"闪一下没了"，等于没做动画（探针截图 `shot-leave-90ms.png` 抓到的就是这个）。
       ⚠️ 2026-11-08 第八轮：总时长从 180ms 收到 **90ms**（= 一拍的前 45%，参考件的退场带）。
       这和上一坑**不矛盾**：那时是"曲线前重后轻 + 总长 180"⇒ 90ms 到 0.1 之后还在爬
       剩下的 90ms，读作"卡住了"；现在是 linear 90ms 直接到 0 —— 短而干净，不是停住。
       ⚠️ 幽灵在绝对定位里，`pointer-events: none` 免得它挡 200ms 的点击。 */
    pointer-events: none;
    transition: opacity var(--ff-dur-exit) linear,
        transform var(--ff-dur-move) var(--ff-ease-exit);
}

/* 退场**不位移**、只缩小 5%（参考件同款：`scale(0.95)`，不是"飘走"）。
   位置已经在 `pinLeaving` 里钉死了，再叠一层横移只会读成"被挤出去"。 */
.nav-zone .fx-leave-to {
    opacity: 0;
    transform: scale(0.95);
}

/* 减少动态效果：**直接切到终态**，不能只把时长设 0 ——
   设 0 会让 `-enter-from` 的位移和最终位置落在同一帧、闪一下。 */
@media (prefers-reduced-motion: reduce) {
    .nav-zone .fx-move,
    .nav-zone .fx-enter-active,
    .nav-zone .fx-leave-active {
        transition: none !important;
    }

    .nav-zone .fx-enter-from {
        opacity: 1;
        transform: none;
    }

    /* 角标挂出去了，不需要槽；减少动态效果下直接不出入场动画即可 */
    .nav-zone .crumb-current[data-count]::after {
        animation: none;
    }
}
</style>
