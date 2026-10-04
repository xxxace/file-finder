<template>
    <div class="file-finder">
        <div class="header-bar">
            <!-- 导航区 = 头部**唯一**的弹性槽位。
                 继续用**裸 flex**、不用 n-space：naive-ui 2.45.3 的 Space 会给每一个子项
                 写死同一个 key（`key: 1`），而这一组的子元素个数是**会变**的
                 （面包屑 v-for + 折叠分支 + 「返回」的条件渲染），一变就会重复 key、错位复用节点。
                 详见 docs/FIX-2026-09-24-nspace-duplicate-keys.md -->
            <div class="nav-zone">
                <FolderSelector ref="folderSelector" v-model="dir" label="请选择文件夹(D)" @change="setRoot" />

                <!-- 面包屑 = 从**盘符 / 离线锚点**到当前的完整链，由 `ancestorsOf(currentPath)` 现算。
                     为什么不按导航栈渲染：跳转到达的目录**不是"栈顶的子级"**，用栈拼会拼出
                     一条物理上不存在的路径（`videos › a › y`）——
                     见 docs/DESIGN-NAV-2026-09-30.md §12.3 的反证推演。
                     折叠规则：保首段 + `…` + 父 + 当前（Apple HIG 与 Fluent 2 两家官方默认行为）。 -->
                <template v-if="crumbFold">
                    <!-- 首段（盘符 / 离线盘）：**不可点**，只作定位。
                         点它会打开盘根，而盘根通常没被缓存过 ⇒ **会真读一次盘**。
                         「回根 / 换根」交给左边那个 chip，不在这里新开一条读盘路径。 -->
                    <n-tag class="crumb crumb-root" :title="crumbFold.head.path">
                        <span class="crumb-text">{{ crumbFold.head.name }}</span>
                    </n-tag>
                    <!-- 被折起来的中间层：**每一层都还能点** —— 折叠只牺牲「常显」，不牺牲任何能力 -->
                    <n-popover trigger="click" placement="bottom-start">
                        <template #trigger>
                            <n-tag class="crumb crumb-more" title="展开被折叠的层级">
                                <span class="crumb-text">…</span>
                            </n-tag>
                        </template>
                        <div class="hstack">
                            <n-button v-for="c in crumbFold.hidden" :key="c.path" size="small" @click="onCrumbClick(c)">
                                {{ c.name }}
                            </n-button>
                        </div>
                    </n-popover>
                    <n-tag v-for="(c, i) in crumbFold.tail" :key="c.path" class="crumb"
                        :class="{ 'crumb-current': i === crumbFold.tail.length - 1 }" :title="c.path"
                        :data-count="i === crumbFold.tail.length - 1 ? crumbCount : null" @click="onCrumbClick(c)">
                        <span class="crumb-text">{{ c.name }}</span>
                        <n-spin v-if="loading && i === crumbFold.tail.length - 1" :size="12"
                            style="margin-left: 8px;" />
                    </n-tag>
                </template>
                <template v-else>
                    <n-tag v-for="(c, i) in crumbs" :key="c.path" class="crumb"
                        :class="{ 'crumb-root': c.kind === 'root', 'crumb-current': i === crumbs.length - 1 }"
                        :title="c.path" :data-count="i === crumbs.length - 1 ? crumbCount : null"
                        @click="onCrumbClick(c)">
                        <span class="crumb-text">{{ c.name }}</span>
                        <n-spin v-if="loading && i === crumbs.length - 1" :size="12" style="margin-left: 8px;" />
                    </n-tag>
                </template>

                <!-- 「返回」的出现条件是 **`history.length > 1`：此刻真有上一屏**（事实），
                     不是 `dir`（"曾经选过根"的快照）—— 后者在「根层」和「跳转后」都会
                     造成"按钮看得见、点不动"的死交互。 -->
                <n-tooltip v-if="history.length > 1">
                    <template #trigger>
                        <n-button size="small" @click="onBack">返回</n-button>
                    </template>
                    返回上一屏（Backspace）
                </n-tooltip>
            </div>
            <!-- <n-space>
                <FolderSelector v-model="dirRoot" label="请选择文件夹2(D)" @change="handleDirRootChange" />
            </n-space> -->
            <div class="toolbar">
                <!-- 工具条 = PC 文件管理器那套：**动作常驻，忙碌时只置灰，绝不消失、绝不换形**。
                     进度和取消在网格下方的状态条（见 .scan-bar），工具条这一组**一个字都不随状态变**。
                     ⚠️ 2026-10-01 变更：三个维护动作**收进「更多」**（用户批准）。原来它们是三个平铺的
                     文字按钮，实测共占 242px —— 工具条 605px 里的 40%，而它们是低频动作。
                     三条必须同时守住：
                     ① **子元素个数仍然恒定**（4 个：更多 / 缓存记录 / 搜索 / 刷新），
                        忙碌时只置灰、不消失、不换形（原来那条铁律没变）。
                        ⚠️ 2026-10-02：原本恒 5 个（多一个角标）。角标挪进面包屑之后这里变 4 个
                        —— 变的是**数量**，不是"恒定"这条性质。
                     ② **文案一个字都不缩**：下拉里有地方，「这一片」表达的是"递归整片"，
                        正是它与「刷新＝只重新读当前这一层」的区分点。收进下拉把
                        "要不要缩短文案"这个取舍**直接消掉了**。
                     ③ 「重读」的确认从 `n-popconfirm` 改成 `n-dialog` —— 这是**有意偏离**
                        `docs/DESIGN-UIUX-2026-09-24.md` §4.1 的"不用 modal"。那条原则的理由是
                        "高频动作弹窗会造成警报疲劳（F5 一天按几十次）"，而重读是**低频**动作
                        （用户原话"并不常用"）；且从下拉里触发的动作再挂一个受控 popconfirm
                        在下拉按钮上，反而更绕。低频 ⇒ 模态的打断成本可以忽略。
                     门槛本身没降：它仍然是唯一带确认的动作（不可逆 × 波及面最大）。 -->
                <n-dropdown trigger="click" :options="moreOptions" :disabled="scanning" @select="onMoreSelect">
                    <n-button size="small" :disabled="scanning">
                        <template #icon>
                            <n-icon>
                                <ChevronDownOutline />
                            </n-icon>
                        </template>
                        更多
                    </n-button>
                </n-dropdown>
                <!-- 缓存记录入口。⚠️ 原来它是一个**只有脚印图标、没有文字、也没有 tooltip** 的按钮 ——
                     面板做得再好，找不到入口等于零。这里补一句说明（一行成本）。 -->
                <n-tooltip>
                    <template #trigger>
                        <n-button size="small" @click="showHistory">
                            <template #icon>
                                <FootstepsOutline />
                            </template>
                        </n-button>
                    </template>
                    缓存记录（读过的目录）
                </n-tooltip>
                <!-- 角标原来站在这里。用户 2026-10-02 裁决：挪到面包屑的**当前段**上。
                     它量的是"这一层有多少条目"，紧挨着「缓存记录」按钮时读起来像那个按钮的角标
                     —— 挂到它真正描述的那一段上，位置本身就是说明，不需要再补 tooltip。 -->
                <n-input ref="searchInput" v-model:value="searchText" placeholder="搜索" size="small" clearable>
                    <template #prefix>
                        <n-icon :component="Search" />
                    </template>
                    <template #suffix>
                        <span class="suffix-icon">S</span>
                    </template>
                </n-input>
                <!-- tooltip 只为说清它和「重读这一片」的分工：它只重读**当前这一层**，
                     那个是整片。名字沿用用户已经在用的"刷新"，不改名（改名有认知成本）。
                     扫描期间禁掉：它带 noCache、会真的再读一次盘，和正在跑的整片扫描
                     叠在一起就是两路并发读盘 —— 那正是"串行、一次一块盘"要挡的事。
                     只读层（盘不在）也禁掉：只读视图的源就是缓存，没有"重读"这回事。 -->
                <n-tooltip>
                    <template #trigger>
                        <n-button size="small" :disabled="scanning || readOnlyLevel" @click="onRefresh">
                            <template #icon>
                                <n-icon>
                                    <Refresh />
                                </n-icon>
                            </template>
                        </n-button>
                    </template>
                    重新读取当前文件夹
                </n-tooltip>
            </div>
        </div>
        <!-- 失败横幅：和"空目录"那行浅灰小字是**两件事**，绝不能混成一件事。
             空 = 这里本来就没有东西；横幅 = 这里应该有东西、但现在读不到。
             不做 closable：它的寿命由取数结果管（下一次成功就自动消失）——
             手动关掉只会让"我读不到"这个事实重新变回一片空白，那是在骗人。
             文案来自服务端给的 kind（ApiError.kind），不是 match 错误文本。 -->
        <n-alert v-if="banner.text" :type="banner.type" style="margin-bottom: 4px">
            {{ banner.text }}
        </n-alert>
        <div class="image-box" ref="imageBox">
            <!-- key 不能只用 item.name：封面条目的 name 取的是**封面图文件名**，
                 同一层的两个文件夹若都叫 cover.jpg，就会生成两个 key="cover"。
                 Vue 遇到重复 key 会复用错的组件实例，封面会串到别的格子里。
                 加上 dir 就唯一了（folder 模式下 dir 是父目录，同样唯一）。 -->
            <div v-for="(item) in fileList" :key="item.dir + '/' + item.name" class="image-box-item"
                :class="{
                    pickable: picking && isPickable(item), picked: isPicked(item),
                    located: locatedKey !== '' && locatedKey === keyOf(item),
                    opening: opening !== '' && opening === keyOf(item),
                }"
                :data-key="keyOf(item)"
                @click="onItemClick(item)" @dblclick="handleOpen($event, item)"
                @contextmenu.prevent="onContextMenu($event, item)"
                :title="item.name + ' ' + getSize(item.size)">
                <!-- `pointer-events:none` 保住连点两张；`v-if` 而非 `v-show`（只转零点几秒，不值得留 DOM） -->
                <div v-if="opening !== '' && opening === keyOf(item)" class="opening-mask">
                    <n-spin :size="20" />
                </div>
                <!-- 「换封面」模式下单击格子 = 选中/取消（见 onItemClick）。
                     同时**关掉图片预览** —— 否则一下点下去既弹放大图、又切换选中，两个动作打架。
                     判断"这张糊不糊"靠格子里的图本身（6 列下也有 200~320px），不靠点开大图。
                     ⚠️ 2026-10-04：预览层改由下面那个 `n-image-group` 统一渲染（它才拿得到
                     prev/next，见组节点的注释）。所以这里**不再传** preview-src /
                     previewed-img-props / render-toolbar，改成 preview-disabled —— 它是
                     srcList 模式下**必须**的（有 n-image 子节点就会 throwError）。
                     "点图才开"的语义靠 `img-props.onClick` 原样保留：n-image 的
                     `onImgClick` 会先 showPreview()（被 preview-disabled 挡住），再转给 imgProps.onClick
                     （naive-ui `Image.mjs:99-102`）⇒ 不会双开、也不是 CSS 藏节点。 -->
                <n-image v-if="item.type === 'image' || item.type === 'video'" class="can-preview"
                    :src="thumbUrl(item.thumb)" :img-props="{ onClick: () => openPreview(item) }" :alt="item.dir"
                    :lazy="true" objectFit="contain" preview-disabled />
                <!-- 目录的脸：只在 70% 显示、且本来就不给点开。挑封面时要看得清，所以模式下放到 100% -->
                <n-image v-else-if="!!item.avatar" :src="thumbUrl(item.avatar)" :alt="item.dir || ''" :lazy="true"
                    objectFit="contain" :style="picking ? 'width:100%;height:100%' : 'width:70%;height:70%'"
                    preview-disabled />
                <img v-else-if="item.type === 'folder'" :src="folderIcon" :alt="item.dir || ''" :style="`width:70%`">
                <div v-else :title="item.dir" :class="`file-cover fiv-cla fiv-icon-${item.ext}`"
                    :style="`width:70%;font-size: .6rem`"></div>
                <span>{{ item.name }}</span>
                <!-- 选中角标。⚠️ 用 `<i>` 而**不是** `<span>` —— `.image-box-item span` 那条
                     （1681 行）里有 `width:100%` + `height:38px !important`，会把角标拉成长条、
                     圆直接变形。换个元素最省事，也不用跟 `!important` 打架。
                     ⚠️ 绝对定位、**不参与布局** —— 网格 6 列的宽度是"margin 撑间距 +
                     `width:100%/6−10px` 补偿"算出来的，任何参与布局的新元素都会带偏它 -->
                <i v-if="isPicked(item)" class="pick-badge" aria-hidden="true"></i>
            </div>
            <!-- 空状态：只有一行浅灰小字。不加边框、不加图标、不加按钮 —— 保持极简观感 -->
            <div v-if="emptyTip" class="empty-tip">{{ emptyTip }}</div>
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
        <div v-if="scanning || picking" class="scan-bar">
            <!-- 「换封面」的挑选中。复用这一条而不动工具条 —— 工具条那条铁律是
                 "绝不消失、绝不换形、一个字都不随状态变"，所以模式态的信号只能住在这里。
                 两者不会同时出现（进模式前会等扫描结束）。 -->
            <template v-if="!scanning">
                <span class="scan-progress">换封面：点有封面的格子选中 · 已选 {{ pickedCount }} 处</span>
                <n-button size="small" :disabled="!pickedCount" @click="clearPicked">清空</n-button>
                <n-button size="small" @click="exitPick">退出</n-button>
                <n-button size="small" type="primary" :disabled="!pickedCount" @click="openFaces">
                    换封面…
                </n-button>
                <span class="scan-hint">没有封面的格子选不了 —— 那是「补封面」管的事</span>
            </template>
            <template v-else>
                <span class="scan-progress">已扫 {{ scanDone }} / 待扫 {{ scanPending }}</span>
                <n-button size="small" :disabled="cancelling" @click="onScanCancel">
                    {{ cancelling ? '正在取消…' : '取消' }}
                </n-button>
                <span v-if="cancelling" class="scan-hint">当前这个目录扫完就停</span>
            </template>
        </div>
        <n-popover :show="popover.visible" :x="popover.x" :y="popover.y" trigger="manual" placement="bottom"
            @clickoutside="popover.visible = false">
            <!-- 同理换掉 n-space：这里 v-for 的是文件列表，个数天生会变 -->
            <div class="hstack">
                <div v-for="(item) in popover.files" class="file-item" :key="item.name" @dblclick="openFile(item.name)"
                    :title="item.name + ` ${getSize(item.size) || ''}`">
                    <div class="file-cover" :title="item.name || ''"></div>
                    <span>{{ item.name }}</span>
                </div>
            </div>
        </n-popover>
        <!-- 右键上下文菜单：极简一条，定位手法和上面的 files popover 完全一致
             （n-popover 手动定位 + clickoutside 关闭），独立状态不串台。
             ⚠️ 2026-10-02 加了第二项「去后缀」而不是**改**原来那一项 ——
             原来那个含扩展名的名字是**刻意的**（资源管理器里要拿它去搜），不能为了新用途把它改掉。
             两个都留着，各有各的场合。 -->
        <n-popover :show="ctxMenu.visible" :x="ctxMenu.x" :y="ctxMenu.y" trigger="manual" placement="bottom-start"
            @clickoutside="ctxMenu.visible = false">
            <div class="hstack">
                <n-button size="small" @click="copyName">复制文件名</n-button>
                <n-button size="small" @click="copyNameStem">复制文件名（去后缀）</n-button>
            </div>
        </n-popover>
        <!-- ── 预览层（上一条 / 下一条 + 定位）────────────────────────────────────────
             ⚠️ 它必须是**空节点**：srcList 模式下任何 `<n-image>` 子节点一注册就 throwError
             （naive-ui `Image.mjs:53-57`）⇒ 它和网格是**并列**关系，不能把网格包进来。

             为什么不用"把网格包进 group"那条更省事的路（那样点击/铺满全都不用管）：
             `Image.mjs:93-98` 每个 `<n-image>` 都会**无条件** registerImageUrl（连
             preview-disabled 的也注册）⇒ 集合会掺进「目录的脸」（cover 模式下 avatar 是活的，
             见 electron/server/index.ts:347-356），而且顺序是 **Map 插入序 = 组件挂载序**，
             不由我们控制。而「定位」要求"预览里这一条 = 网格里那一格"，对应关系**必须是我们给的、
             不是猜的**。srcList + 受控 current 正是为此 —— 索引由 fileList 现算。

             `show/current/src-list` 三个 prop + 两个 update 事件 = 全受控；因此
             「上一条/下一条」的状态只有一个来源：`previewKey`（见脚本里的注释）。
             ← / → 键是 naive-ui 自带的（`ImagePreview.mjs:78-100`），不额外挂监听。 -->
        <n-image-group :src-list="previewSrcList" :current="previewIndex" :show="previewOpen"
            :render-toolbar="previewToolbar" @update:show="onPreviewShowChange"
            @update:current="onPreviewCurrentChange" />
        <HistoryTable ref="historyTable" @openDir="openHistory" />
        <!-- 管理助手 · 补封面（全屏面板：选盘 → 扫描 → 抓取 → 写盘）。
             写盘完成后它会失效对应目录的缓存并发 refresh —— 这里刷新当前这层，
             让新封面立刻出现在网格里（不需要重启、也不需要重新选盘）。 -->
        <AssistantCoverModal ref="assistantModal" @refresh="refreshAfterApply" />
    </div>
</template>

<script setup lang="ts">
import { formatBytes, ancestorsOf, foldCrumbList, ANCHOR_PREFIX } from '@/utils';
import type { PathCrumb } from '@/utils';
import { apiUrl, getAction, ApiError } from '@/utils/request';
import folderIcon from '@/assets/fileTypeIcon/folder.png';
import usePinYin from '@/hooks/usePinYin';
import useNotify from '@/hooks/useNotify';
import { usePreview } from './usePreview';
import { Search, Refresh, FootstepsOutline, ChevronDownOutline } from '@vicons/ionicons5';
import { NButton, NInput, NIcon, NImage, NImageGroup, NTag, NPopover, NSpin, NAlert, NTooltip, NDropdown, useLoadingBar, useDialog } from 'naive-ui';
import FolderSelector from '@/components/FolderSelector/index.vue';
import HistoryTable from '@/components/HistoryTable/index.vue';
import AssistantCoverModal from './AssistantCoverModal.vue';
import { ipcRenderer } from 'electron';
import { computed, nextTick, onMounted, onUnmounted, provide, ref, watch } from 'vue';
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
}

// 与 electron/server/videoExt.ts 的 VIDEO_EXT 保持一致（渲染层不能 import server，保留正则副本）。
// 改了 videoExt.ts 这里要同步改。
const VIDEO_EXT_RE = /\.(mp4|mkv|avi|wmv|flv|mpeg|m4v|mov|mpg|ts|m2ts|mts|webm|ogv|3gp)$/i;

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
    const canBuild = !item.previewReady && item.type === 'image' && !readOnlyLevel.value;
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
const historyTable = ref<typeof HistoryTable | null>(null)
const assistantModal = ref<typeof AssistantCoverModal | null>(null)
// const dirRoot = ref('');
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
}>({
    visible: false,
    x: 0,
    y: 0,
    name: '',
    stem: ''
});
const searchText = ref('');
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
const crumbs = computed(() => ancestorsOf(currentPath.value));
/** 折叠决策（保首尾）。`null` = 全显。规则在 `@/utils` 的 `foldCrumbList` 里，可单独验证。 */
const crumbFold = computed(() => foldCrumbList(crumbs.value));
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
const BANNER_KINDS = ['offline', 'unreadable', 'notCached'];

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
    // "是否已经进入浏览"要用**当下事实**（有没有一屏），不能用 `dir`（那只是"曾经选过根"的快照）。
    // ⚠️ 这一条是自查 S-1 的回归防护：从缓存跳转**不再写 `dir`**，
    // 冷启动直接跳进一个空目录时，用 `dir` 判断会让这句话不显示 —— 一片空白、连"空的"都不说。
    if (!history.value.length) return '';
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
const dialog = useDialog();

/**
 * 文件大小 → 人类可读。
 *
 * 改成调用 `@/utils` 的 `formatBytes`（**一处实现**）：原来的实现只到 GB，
 * 而上限是它自己算出来的 `bytes / 1G % 1024` —— **取模**，1.83 TB 会显示成 `850.xxGB`、
 * 2 TB 直接变 `0.00GB`（静默说错数字）。`formatBytes` 支持到 PB，并且 0 显示 `—` 而不是 `0`。
 * 函数名保留不变（不改调用点）。
 */
const getSize = (size: number | undefined) => formatBytes(size);


const showHistory = () => {
    historyTable.value!.setShowModal(true);
}

/**
 * 「补封面」写盘完成后的刷新。与 onRefresh 的区别：**不带 noCache** ——
 * apply 已经把写过的目录缓存删掉了，正常取数会真读一次盘、把新封面收进来再建缓存；
 * 再带 noCache 等于把刚建的缓存又删一遍重读，纯浪费。
 * 盘不在（只读层）时 apply 根本写不了，不用刷。
 */
const refreshAfterApply = () => {
    const cur = history.value[history.value.length - 1];
    if (cur && !readOnlyLevel.value) fetchFolder(cur.path, cur.mode);
}

const handleOpen = (e: MouseEvent, item: WiredFileInfo) => {
    if (loading.value) return;
    if (item.type === 'folder') {
        // 目录的完整路径从 item.dir 拼。**不要用 dir.value** —— 它是"当前选中的根"，
        // 进到子目录之后它还是最初那个，用它会拼出 H:/x/子目录名 这种少一层的路径。
        // item.dir 是服务端给的"条目所在目录"，永远是准的。
        openFolderInCover(`${item.dir}/${item.name}`);
    } else {
        if (e && item.files && item.files.length > 1) {
            const { x, y } = e;
            popover.value.visible = true;
            popover.value.x = x;
            popover.value.y = y;
            popover.value.files = item.files;
            popover.value.cover = item;
        } else {
            openFile(item);
        }
    }
}
/**
 * 离开当前屏之前，把"这一屏的样子"记在**它自己**身上（滚动位置 + 搜索词）。
 *
 * 原来是"滚动位置写进 `openStack` 的元素、搜索词压进另一个平行的 `searchStack`"，
 * 两处必须同步、长度还得差 1。现在都写在同一个对象上，不可能错位。
 */
const rememberCurrentScreen = () => {
    const cur = history.value[history.value.length - 1];
    if (!cur) return;
    cur.scrollY = imageBox.value?.scrollTop ?? 0;
    cur.searchText = searchText.value;
}

/**
 * 进入某一屏。**所有导航动作都必须从这里过** —— 「记旧屏 → 压新屏 → 取数 → 清搜索词」
 * 这四件事只写一遍；以后新增入口（前进 / 历史列表 / 多标签）也不会漏掉其中一件。
 */
const enterScreen = (path: string, mode: OpenMode = 'cover') => {
    rememberCurrentScreen();
    history.value.push({ path, mode, searchText: '', scrollY: 0 });
    // 进新的一屏不带上一屏的搜索词（原有行为，不动）
    searchText.value = '';
    fetchFolder(path, mode);
}

/** 网格双击下钻：进子目录 */
const openFolderInCover = (path: string) => {
    enterScreen(path, 'cover');
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
    if (c.kind === 'root') return;              // 首段不可点，见模板注释
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
        popover.value.visible = false;
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
 * 右键卡片 → 在光标处弹极简菜单。
 *
 * `.prevent` 必须带上：Electron 默认右键会冒出原生菜单（开发期还带「重新加载 /
 * 检查元素」），不拦掉就和我们自己的菜单叠在一起。
 * 复制的是**磁盘文件名**（含扩展名，见 `fileNameOf`）—— 那是用户看到的那个名字，
 * 也是资源管理器里真能搜到的名字；封面条目还原成封面图文件名，目录还原成目录名。
 *
 * ⚠️ 2026-10-02：同时备好**去后缀**那一份。它不需要自己去找最后一个 `.` ——
 * 服务端本来就是把 `name` 与 `ext` 分开给的（`fileNameOf` 是 `${name}.${ext}`），
 * 所以 `item.name` 拆开之前的样子就是答案。少一次字符串处理，也少一处会算错的地方
 * （`xxx.tar.gz` 这种多后缀的名字，剥点剥不对）。
 */
const onContextMenu = (e: MouseEvent, item: WiredFileInfo) => {
    ctxMenu.value.visible = true;
    ctxMenu.value.x = e.clientX;
    ctxMenu.value.y = e.clientY;
    ctxMenu.value.name = fileNameOf(item);
    ctxMenu.value.stem = item.name;
};

/**
 * 菜单项「复制文件名」：把文件名交给主进程的 `copyText`（沿用 openFile 那条 IPC 通道）。
 * 先关菜单再复制：菜单是手动定位的浮层，留着会挡着后面的操作；
 * 并且复制是用户手势内发的，关掉它不影响 clipboard 写入。
 */
const copyName = async () => {
    const name = ctxMenu.value.name;
    ctxMenu.value.visible = false;
    if (!name) return;
    const err = await ipcRenderer.invoke('copyText', name);
    if (err) notify('error', '复制失败', String(err));
    else notify('success', '已复制文件名', name);
};

/**
 * 菜单项「复制文件名（去后缀）」：贴到搜索框里找片用的 —— 那里带 `.mp4` 是搜不到的。
 *
 * 与上面那条**平行写**，不合并成一个带参数的函数：两条的差别只有"取哪个字段"，
 * 合并省下的是 4 行，换来的是"复制"这件事多一层间接。保持两条直的。
 */
const copyNameStem = async () => {
    const stem = ctxMenu.value.stem;
    ctxMenu.value.visible = false;
    if (!stem) return;
    const err = await ipcRenderer.invoke('copyText', stem);
    if (err) notify('error', '复制失败', String(err));
    else notify('success', '已复制文件名（去后缀）', stem);
};

/**
 * 只做一件事：把服务端给的完整列表取回来放进 dataSource。
 * 原来还会顺手清空搜索框 —— 取数的函数不该同时改别的状态，清空/恢复交给导航动作自己负责。
 *
 * 渲染层**没有**缓存：原来那个 `fetchCache` 按 `path+mode` 存整份列表，而盘符会被复用 ——
 * A 盘挂 H:/x 缓存住 → 拔 A 插 B → 返回时命中缓存、压根不请求服务端，用户看到的是A 的清单、
 * 双击打开的却是 B 盘上的路径。服务端那侧每次 stat 都复核"这个盘符现在的主人是谁"，
 * 渲染层这份缓存正好把那次复核整个绕过，而它换来的那点时间量不出来。
 */
/**
 * 请求序号。只有「最新一次」请求的响应才有资格写进 `dataSource`。
 *
 * 为什么需要：导航有 5 个入口（进目录 / 返回 / 换根目录 / 点面包屑 / 刷新），
 * 而 `loading` 守卫原来只有刷新那一处。两次请求同时在飞时，
 * `dataSource.value = data` 就是**谁后到谁覆盖** —— 慢目录（几十个视频要串行抽帧）
 * 后到，结果就是「面包屑已经切到 B，网格里还是 A 的内容」，两处状态来自不同时刻。
 *
 * 为什么不去给那 4 个入口各补一道 `if (loading.value) return`：那是补丁 ——
 * 防错的责任落在调用方，以后新增第 6 个入口忘了加，同样的错乱立刻复活；
 * 而且 `loading` 是全局粗粒度锁，慢目录加载期间会把整个导航一起冻住。
 * 把判断收到**唯一的写入点**之后，「过期响应写入」在结构上不可能发生。
 */
let fetchSeq = 0;

const fetchFolder = (path: string, mode: OpenMode, noCache?: boolean) => {
    const seq = ++fetchSeq;
    loading.value = true;
    failKind.value = '';
    loadingBar.start();
    // path 必须编码：中文/空格/&/#/+ 会让 query 被截断或误解析
    const url = `${API_BASE}/openFolder?path=${encodeURIComponent(path)}&mode=${mode}`;

    // 必须 return：调用方要等数据真的落地才能做后面的事（恢复滚动位置）
    return getAction(noCache ? url + '&noCache=true' : url).then((data: WiredFileInfo[]) => {
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

// const handleDirRootChange = (value: string) => {
//     if (!value) return
//     const url = `http://localhost:3060/getFileTree?path=${value}`;
//     fetch(url).then(res => {
//         return res.json();
//     }).then(async data => {
//         // printTree(data, 0, 2, ``)
//         // console.log(printTree(data, 0, 2, ``))
//         console.log(encodeURIComponent(printTree(data, 0, 2, ``)))
//         loadingBar.finish();
//     }).catch(err => {
//         loadingBar.error();
//     }).finally(() => {
//         loading.value = false;
//     });
// }

const onBack = async () => {
    if (history.value.length <= 1) return;
    history.value.pop();
    const to = history.value[history.value.length - 1];
    // 恢复这一屏的搜索词。fileList 是 computed，词一变列表自己会重新筛 ——
    // 不需要（也不能）再手动调一次过滤
    searchText.value = to.searchText;
    await fetchFolder(to.path, to.mode);
    // 滚动位置必须等新列表渲染出来再恢复：在旧内容上滚会被 clamp 掉
    if (to.scrollY) {
        await nextTick();
        imageBox.value?.scrollTo(0, to.scrollY)
    }
}

const onRefresh = () => {
    // 只读层没有"重读"这回事：它的源就是缓存，盘不在，F5 也读不出新东西。
    // 拦住而不是让服务端静默回一份缓存 —— 静默最坏（用户以为他重读过了）。
    if (loading.value || !history.value.length || readOnlyLevel.value) return;
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
    if (!value) {
        dir.value = '';
        history.value = [];
        // 清掉文件夹选择就该把这个文件夹的内容也清掉，
        // 否则界面上留着上一个目录的东西，而选择框已经空了
        dataSource.value = [];
        searchText.value = '';
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
    jumpTo(path);
}

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
const fetchScanContext = async () => {
    const disks = await getAction(`${API_BASE}/getDisks`);
    const serialOf: Record<string, string> = {};
    for (const d of disks?.disks ?? []) {
        if (d.drive) serialOf[String(d.drive).toUpperCase()] = d.serial;
    }

    const keys = new Set<string>();
    const PAGE = 200;
    for (let pageNo = 1; ; pageNo++) {
        const res = await getAction(`${API_BASE}/getHistory?pageNo=${pageNo}&pageSize=${PAGE}`);
        for (const r of res?.records ?? []) {
            // 统一转小写：NTFS 不区分大小写，而 relPath 是从用户给的路径里切出来的，
            // 大小写未必和当初写进缓存的那一次一致（relPath 大小写未归一化是已知观察项）
            keys.add(`${r.serial}|${r.relPath}`.toLowerCase());
        }
        if (pageNo * PAGE >= (Number(res?.total) || 0)) break;
    }

    return { serialOf, keys };
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

    try {
        const { serialOf, keys } = await fetchScanContext();
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
            } catch (err) {
                // 单个目录失败不中断整轮 —— 和 readFolder 里"逐项 try/catch"同一个原则
                console.error('[批量扫描] 目录失败:', dir, err);
            }

            scanPending.value = queue.length;

            processed += 1;
            if (processed % SCAN_BATCH === 0) await new Promise(r => setTimeout(r, 0));
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
            if (cur) fetchFolder(cur.path, cur.mode);
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
 * 「更多」下拉的项。
 *
 * ⚠️ `disabled` 的条件与改造前那三个平铺按钮**逐条一致**，一条都没有放宽 ——
 * 搬家不该顺手改门槛。扫描中整组不可用，由触发按钮自己的 `:disabled="scanning"` 挡住
 * （下拉不弹出来 = 三项都点不到），与"忙碌时只置灰、不消失"是同一条铁律。
 */
const moreOptions = computed(() => [
    // ⚠️ 扫描类动作在「挑封面」模式下**也禁用**：它们会把网格重扫一遍，
    // 而状态条那边是 `v-if="scanning || picking"` 且扫描优先 —— 扫描条会把挑选 UI
    // 顶掉（选中的东西还在、但你看不见那个计数和处理按钮了）。
    { label: '补全这一片', key: 'fill', disabled: scanning.value || picking.value || !history.value.length || readOnlyLevel.value },
    { label: '重读这一片', key: 'rescan', disabled: scanning.value || picking.value || !history.value.length || readOnlyLevel.value },
    { label: '补封面', key: 'cover', disabled: scanning.value },
    // 「换封面」= 补封面的**反面**：补封面是让程序找出"没有封面的"，
    // 换封面是让用户自己挑"有封面但要换的"。两者最终复用同一个弹窗、同一条抓取写入链路。
    { label: picking.value ? '退出换封面' : '换封面', key: 'faces', disabled: scanning.value || readOnlyLevel.value },
]);

/**
 * 下拉选中。**「重读」的确认放在这里**（唯一不可逆 × 波及面最大的动作）。
 *
 * 为什么是 `dialog` 而不是原来的 `n-popconfirm`：换成下拉之后，popconfirm 只能挂在
 * 「更多」按钮上（受控 show），于是"点了菜单项、确认框却出现在别处"—— 那个形态比 modal 更绕。
 * 而 `DESIGN-UIUX` §4.1 之所以选 popconfirm，理由是"高频动作弹窗会警报疲劳"，
 * 重读恰恰是低频动作 ⇒ 那条理由在这里不成立。门槛本身一点没降。
 */
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

// ── 预览域接线 ───────────────────────────────────────────────────────────────
// 整块搬进 ./usePreview.ts：它是本文件里最独立的一个域（只靠 6 个依赖进来，
// 不反向写任何外部状态），后续给预览加花样有个自己的家。
//
// ⚠️ **接线必须放在这里**（`picking` 声明之后）：`fileList`(L446) / `picking` / `imageBox`(L434)
// 三个依赖都还没准备好就传进去，composable 拿到的是空壳—— `used before declaration`
// 这类报错就是顺序错了的信号。
// ⚠️ 渲染落点仍在组件里：模板里那个空的 `n-image-group`，以及末尾那个**非 scoped** 的
//    style 块（工具条与图都被 naive-ui teleport 到 body，`<style scoped>` 够不到它们）。
// ⚠️ `previewedImgProps` 必须由本组件 provide 进 `imageContextKey` —— 预览层由
//    `n-image-group` 渲染，父链是 `ImagePreview ← ImageGroup ← 本组件`，
//    而 naive-ui 没给 group 留 `previewed-img-props` 这个 prop。
const {
    openPreview, closePreview, locateInGrid, previewKey, locatedKey,
    previewSrcList, previewIndex, previewOpen, previewFile,
    onPreviewShowChange, onPreviewCurrentChange,
    previewToolbar, previewedImgProps, dispose: disposePreview,
} = usePreview({ fileList, keyOf, displaySrcOf, previewUrlOf, picking, imageBox });

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
 * 模式态下的单击 = 选中 / 取消。**非模式态直接返回**，所以"单击不打开"这条既有习惯没变
 * （双击才打开，那一条一个字没改）。
 */
const onItemClick = (item: any) => {
    if (!picking.value) return;
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
    if (e.target !== document.body) return;

    /**
     * 预览层（全屏遮罩）开着时：`回车` = 定位，其余单键**全部短路**。
     *
     * 与下面「换封面」那条同族、同理由：预览层是**盖在网格上**的，这时按下 S / D /
     * Backspace / F5 打的是**背后那一屏**（跳搜索框 / 跳文件夹选择器 / 返回 / 重读），
     * 屏幕上却看不出跑偏；F5 还会把列表换掉（预览序列跟着变）。
     * ⚠️ `← / →` 不在这里管 —— 那是 naive-ui 自己监听的 keydown（`ImagePreview.mjs:78-100`），
     * 它只在预览打开时挂上，与这里不重复；`Esc` 同理（它自己关）。
     * ⚠️ 这里用 **keyup**，naive-ui 用 **keydown**，两者不会互相吃掉。
     */
    if (previewOpen.value) {
        if (e.key === 'Enter') locateInGrid();
        return;
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
        searchInput.value!.focus();
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

onMounted(() => {
    window.addEventListener('keyup', onKeyup);
    // 主进程的移动硬盘插拔通知（事件驱动，零轮询 —— 见 electron/main/diskWatch.ts）
    ipcRenderer.on('ff-disks-changed', onDisksChangedIpc);
});

// 必须写在 setup 顶层。注册在 onMounted 回调**内部**的 onUnmounted 永远不会被调用 ——
// 本次生命周期早过了注册窗口，结果是 keyup 监听永久留在 window 上。
// HistoryTable 那边修过一次，这里是漏网的那处。
onUnmounted(() => {
    window.removeEventListener('keyup', onKeyup);
    ipcRenderer.off('ff-disks-changed', onDisksChangedIpc);
    // 预览层那个"停住 0.3s 才换清晰版"的挂起计时器：组件没了就别再起来
    disposePreview();
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
    historyTable.value?.refreshIfOpen();

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
const onDisksChangedIpc = (_e: unknown, disks: { serial: string; drive: string }[]) => {
    void onDisksChanged(disks || []);
};

</script>

<style lang="less" scoped>
.file-finder {
    display: flex;
    flex-flow: column;
    padding: 10px 10px 0 10px;
    height: 100vh;
    box-sizing: border-box;

    .header-bar {
        display: flex;
        /* ⚠️ 「头部永远只有一行」的第一道保险。
           不加它，两个子区（导航区 / 动作区）会退化成"谁装不下谁换行"，
           头部高度就成了**用户数据（路径长度、层级数）的函数**。 */
        flex-wrap: nowrap;
        padding: 4px;
        margin-bottom: 4px;
        border-radius: 4px;
        box-shadow: 1px 0 6px rgba(113, 147, 192, 0.25);
        justify-content: space-between;

        .n-input {
            /* ⚠️ 这一行不能删。n-input 天生 `width: 100%`（为表单布局设计的），
               而这里是 flex 行 —— 100% 会把它撑成整行宽、独霸一行，把「刷新」
               挤到下一行，工具条从一行涨到三行（实测 1805px 窗口下头部高 ~150px）。
               原来 n-space 会给每个子项包一层 div，恰好把这个 100% 关在盒子里；
               换成裸容器之后就露出来了（见 docs/FIX-2026-09-24-nspace-duplicate-keys.md）。
               搜索框本来就该是固定宽度 —— 资源管理器里它也是固定的一小段。 */
            width: 200px;

            &:deep(.n-input-wrapper) {
                padding-top: 1px;
                padding-right: 6px;

                .n-input__suffix {
                    .suffix-icon {
                        display: inline-block;
                        box-sizing: border-box;
                        padding: 7px;
                        height: 22px;
                        line-height: 8px;
                        border: 1px solid #dbdbdb;
                        border-radius: 4px;
                        color: #a1a1a1;
                    }
                }
            }
        }

        /* 批量扫描的进度文字。颜色沿用搜索框后缀图标那个灰 */
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
 * `max-width: 50%` 来自 Fluent 2 的宽度预算（面包屑占整体 30–50% 是安全的）：
 * 它保证动作区**永远拿得到 ≥50%**，超出的部分交给折叠规则消化。
 *
 * 实测：`docs/probes/header-width/`（真 Chromium + 真 naive-ui，窗口 640/800/1280/1920 四档）。
 */
.nav-zone {
    /* ⚠️ 分隔符的定位依赖"两个 tag 之间的空隙有多宽"，所以空隙宽度**只能有一个来源**：
       这个变量。gap 与 ::before 的 left/width 共用它，改一处就够。
       原实现写的是 `left: -13px`（魔数），而 gap 是 8px ⇒ 它往左多插了 5px，
       压在**前一个标签的右边框**上（用户 2026-10-01 截图报的就是这个）。 */
    --crumb-gap: 12px;
    flex: 1 1 auto;
    min-width: 0;
    max-width: 50%;
    display: flex;
    flex-wrap: nowrap;
    align-items: center;
    gap: var(--crumb-gap);
    overflow: hidden;

    /* 面包屑每一段：**单个名字有界**（层级深度问题已由折叠解决，这里只管"一段太长"）。
       ⚠️ 中文不能用 Fluent 那条「超过 30 字符就截断」——那是**拉丁文**语境的量级：
       中文一个字约等于拉丁两个字宽，30 个字 ≈ 360px，照抄等于没截断。所以用像素。 */
    .crumb {
        /* ⚠️ `0 1 auto`（**可收缩**）而不是 `0 0 auto`：
           宽度不够时先压历史段，而不是把"当前层"直接挤出屏幕右边缘被裁掉。
           收缩下界交给 `min-width: 0` + 文本省略号 —— 极窄时显示成「…」，与资源管理器一致。 */
        flex: 0 1 auto;
        min-width: 0;
        max-width: 160px;
        cursor: pointer;

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
        }
    }

    /* 层级之间的方向符。
       ⚠️ 用 CSS 生成，**不插 DOM 子元素** —— 这一组的子元素个数在本项目是敏感量
       （n-space 重复 key 事故同族）。
       `position: absolute` 让它不占 tag 内部空间（tag 自带 `position: relative`）；
       **盒子正好等于那个空隙、再在盒子里居中** —— 这样就不依赖"猜一个负偏移量"，
       换字体、换字号都不会再压到边框上。 */
    .crumb:not(.crumb-root)::before {
        content: '›';
        position: absolute;
        left: calc(-1 * var(--crumb-gap));
        width: var(--crumb-gap);
        text-align: center;
        top: 50%;
        transform: translateY(-50%);
        line-height: 1;
        color: #a1a1a1;
        pointer-events: none;
        /* 别挡住上一个 tag / chip 的点击 */
    }

    /* 当前层**永不被压掉**：它是"我在哪"的唯一答案，比任何历史段都重要 */
    .crumb-current {
        flex: 0 0 auto;
        /* 与网格里条目名的字重一致（`.image-box-item span` 也是 bold）：
           一眼看出"哪个是我现在在的地方" */
        font-weight: bold;
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
    .crumb-current[data-count]::after {
        content: attr(data-count);
        flex: 0 0 auto;
        margin-left: 6px;
        padding: 0 6px;
        min-width: 18px;
        box-sizing: border-box;
        border-radius: 9px;
        background: #d03050;
        /* naive-ui 的 error 红，与原 n-badge 同色 */
        color: #fff;
        font-size: 12px;
        line-height: 18px;
        font-weight: normal;
        /* 当前段是 bold，角标不该跟着粗 */
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
    gap: 12px;
}

/* 扫描状态条：贴着网格下方一条，整条随 scanning 出现/消失 */
.scan-bar {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 4px 4px 8px;

    .scan-progress {
        font-size: 12px;
        color: #a1a1a1;
    }

    .scan-hint {
        font-size: 12px;
        color: #a1a1a1;
    }
}

/*
 * 「换封面」模式：可选 / 已选 / 角标。
 *
 * ⚠️ 三条硬约束：
 *   ① 选中态**复用已有的 `border`**（那条 `1px solid transparent` 本来就在）只改颜色 ——
 *      绝不能新增参与布局的属性。网格 6 列的宽度是"margin 撑间距 + `width:100%/6−10px`
 *      补偿回来"算出来的（见 `.image-box-item` 的注释），任何新增的盒模型属性都会带偏它。
 *   ② 角标**绝对定位**（配 `position: relative`，它不脱流、不影响几何）。
 *   ③ 颜色取 naive-ui 默认主色 —— 本项目没有自定义主题（`App.vue` 无 `themeOverrides`）。
 */
.image-box-item {
    position: relative;

    &.pickable {
        cursor: pointer;
    }

    &.picked {
        border-color: #18a058;
    }

    /*
     * 「定位」闪一下（1.2s 后由 locateInGrid 摘掉）。
     * ⚠️ 与上面 `.picked` **同一个手法**：只改那个本来就存在的 border 的颜色 + 加一层
     * 外发光（`box-shadow` 不参与布局）—— 网格 6 列的宽度是"margin 撑间距 + 宽度补偿"
     * 算出来的，任何新增的盒模型属性都会把它带偏。
     * 颜色用 naive-ui 的 info 蓝而**不是**绿：这个网格里绿色的意思已经是"换封面模式下已选中"
     * （`.picked`），两个概念不能共用一个颜色。
     */
    &.located {
        border-color: #2080f0;
        box-shadow: 0 0 0 2px rgba(32, 128, 240, .45);
    }

    /* 与 .located 同手法：只改颜色/外发光，不碰盒模型（网格宽度是 margin 算出来的）。 */
    &.opening {
        border-color: #2080f0;
        box-shadow: 0 0 0 2px rgba(32, 128, 240, .45);
    }

    /* 遮罩与转圈分开两层：`.opening-mask` 负责铺满，`.n-spin` 留在 naive-ui 自己的定位里
       （它的根是 `.n-spin-body`，自带 translate(-50%,-50%)；去戳它就得连 transform 一起清）。
       绝对定位 ⇒ 尺寸跟卡片走、不参与布局（网格宽度是 margin 算出来的）。 */
    .opening-mask {
        position: absolute;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        pointer-events: none;
        background-color: rgba(0, 0, 0, .35);
    }

    .pick-badge {
        position: absolute;
        top: 2px;
        right: 2px;
        display: block;
        width: 16px;
        height: 16px;
        flex-shrink: 0;
        box-sizing: border-box;
        font-style: normal;
        border-radius: 50%;
        background-color: #18a058;
        box-shadow: 0 0 0 1px #fff;

        &::after {
            content: '';
            position: absolute;
            left: 4px;
            top: 3px;
            width: 7px;
            height: 4px;
            border-left: 2px solid #fff;
            border-bottom: 2px solid #fff;
            transform: rotate(-45deg);
        }
    }
}

.image-box {
    flex: 1;
    display: flex;
    flex-flow: row wrap;
    overflow: hidden auto;
    justify-content: flex-start;
    align-content: flex-start;
    /* ── 让网格左右贴边：首格 margin-left / 每行末格 margin-right 归零 ──────────────
       `.image-box-item` 是"**用 margin 撑间距、宽度再把它补偿回来**"的算法：
       每格 `calc(100%/6 − 10px)` 宽 + 左右各 5px margin = **恰好占 100%/6** ⇒ 一行正好 6 个。
       代价是**容器左右边缘也各被吃掉 5px**（首格的 margin-left、每行末格的 margin-right），
       于是整片网格比头部内缩 5px（`.header-bar` 与它同在 `.file-finder` 的 10px padding 里）
       —— 左右不齐，这就是"第一个/最后一个还留着 margin"的来源。

       解法：把容器左右各外扩 5px（= margin 的一半），边缘那 5px 就正好落回容器外。
       首格贴左、末格贴右，与头部对齐。

       ⚠️ 为什么**不用** `:nth-child(6n+1)` / `:nth-child(6n)` 去掉首尾 margin：
       ① 那是补丁（列数一变就失效）；② **在这里还会算错** —— 格子宽度是按"margin 会被
       补偿"设计的，只去掉首尾 margin 而宽度不变 ⇒ 每行右端空出 5px，左右不对称，比现在更糟；
       ③ 下面的断点里列数是**会变的**（6 / 5 / 3 / 2 / 1），任何写死 `6n` 的式子都会在窄窗失效。

       ⚠️ 为什么**不用** `gap`：`gap` 方向是对的（边缘天然为 0），但换过去必须**同步重算**
       `--item-width` 在 5 个断点里的每一个值 —— 因为 `gap` 不占格子宽度、而 `margin` 占，
       等于把"改一个百分比就能改列数"变成"每个断点要改两个数字"。
       这里只加两行，**断点和 item 的算法一个字都不动**。 */
    margin-left: -5px;
    margin-right: -5px;
}

/* 空状态：占满一整行、居中一行小字。颜色沿用搜索框后缀图标那个灰 */
.empty-tip {
    width: 100%;
    padding-top: 48px;
    text-align: center;
    font-size: 14px;
    color: #a1a1a1;
}

.image-box-item,
.file-item {
    --item-gap: 10px;
    --item-width: calc(100% / 6);
    --item-height: 1.5rem;
    display: flex;
    flex-direction: column;
    flex-grow: 0;
    flex-shrink: 0;
    width: calc(var(--item-width) - var(--item-gap));
    min-height: 80px !important;
    height: var(--item-height) !important;
    max-height: var(--item-height) !important;
    padding: 0 2px 10px;
    margin: 10px 5px 0px;
    border: 1px solid transparent;
    justify-content: flex-end;
    align-items: center;
    box-sizing: border-box;
    transition: all .1s ease-in-out;
    user-select: none;
    font-size: 16px;

    .n-image {
        height: calc(100% - 16px - 20px);
        margin: 10px 0;

        &:deep(img) {
            width: 100%;
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

    img {
        display: block;
        margin: 10px 0;
        object-fit: contain;
        overflow: hidden;
    }

    span {
        display: inline-block;
        width: 100%;
        height: 38px !important;
        line-height: 1em;
        font-size: 1em;
        color: #000;
        font-weight: bold;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        text-align: center;
    }

    &:hover {
        border-color: #7a8da9;
        background-color: rgba(110, 123, 173, 0.16);
        box-shadow: 1px 0 10px rgba(122, 141, 169, 0.15);
    }

    &:active {
        border-color: #525e72;
        background-color: rgba(75, 83, 116, 0.16);
    }

    @media screen and (max-width:1100px) {
        font-size: 12px;
    }

    @media screen and (max-width:600px) {
        --item-width: 20%;
    }

    @media screen and (max-width:400px) {
        --item-width: 33.33%;
    }

    @media screen and (max-width:300px) {
        --item-width: 50%;
    }

    @media screen and (max-width:200px) {
        --item-width: 100%;
    }
}

.file-item {
    width: 84px !important;
    height: 84px !important;
    max-height: 84px !important;

    span {
        display: inline-block;
        max-height: 48px;
        line-height: 16px;
        font-size: 14px;
        word-break: break-all;
        text-overflow: ellipsis;
        overflow: hidden;
    }
}

.file-cover {
    display: block;
    margin: 10px 0;
    object-fit: contain;
    overflow: hidden;
    background-image: url(@/assets/fileTypeIcon/blank.svg);
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
body > .n-image-preview-container .n-image-preview-wrapper {
    padding: 16px 16px 64px;
    box-sizing: border-box;
}

/* ② 工具条：从「居中胶囊」改成「贴底通栏」，并且去掉 `transform: translateX(-50%)`
      （那是居中定位的一部分，改成left:0/right:0 之后必须一起去掉，否则整条会左移半屏）。*/
body > .n-image-preview-container .n-image-preview-toolbar {
    left: 0;
    right: 0;
    bottom: 0;
    transform: none;
    height: 48px;
    padding: 0 16px;
    border-radius: 0;
    /* 半透明白字在通栏底板上不够清楚（原来是浮在图上的一小块）⇒ 加实一点，
       再用一条 1px 上边线把「工具条」和「图」分开，不靠阴影（阴影在贴底时会糊成一片）。*/
    background: rgba(0, 0, 0, .62);
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, .08);
}

/* ③ 悬停反馈：通栏之后按钮散开了，"点了才知道点在哪" 不够 —— 加一档透明度变化。
      naive-ui 没给工具条图标写 hover（实测 `cssr/index.cssr.mjs:35-38` 只有
      padding/font-size/cursor + 一个 fade-in transition），所以这里补的是**它没有的东西**。*/
body > .n-image-preview-container .n-image-preview-toolbar .n-base-icon {
    transition: opacity .15s ease;
}

body > .n-image-preview-container .n-image-preview-toolbar .n-base-icon:hover {
    opacity: .65;
}
</style>
