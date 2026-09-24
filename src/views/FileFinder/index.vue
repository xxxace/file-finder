<template>
    <div class="file-finder">
        <div class="header-bar">
            <!-- 裸 flex 容器，**故意不用 n-space**。
                 naive-ui 2.45.3 的 Space 会给**每一个**子项写死同一个 key（`key: 1`），
                 子元素个数一变，Vue 的 keyed diff 就会让两个旧节点认领同一个新槽位：
                 界面上凭空多出重复节点、按钮点了没反应。这一组的子元素是**会增减**的
                 （openStack 的 v-for + 「返回」的 v-if），所以必须换掉。
                 详见 docs/FIX-2026-09-24-nspace-duplicate-keys.md -->
            <div class="hstack">
                <FolderSelector ref="folderSelector" v-model="dir" label="请选择文件夹(D)" @change="handleDirChange" />
                <template v-for="(folder, index) in openStack">
                    <n-tag v-if="!!folder.name" :key="folder.path" @click="handleJump(folder, index)"
                        style="cursor:pointer">
                        <span>{{ folder.name }}</span>
                        <n-spin v-if="loading" :size="12" style="margin-left: 8px;" />
                    </n-tag>
                </template>
                <n-button v-if="dir" size="small" @click="onBack">返回</n-button>
            </div>
            <!-- <n-space>
                <FolderSelector v-model="dirRoot" label="请选择文件夹2(D)" @change="handleDirRootChange" />
            </n-space> -->
            <div class="toolbar" style="align-self: flex-end">
                <!-- 工具条 = PC 文件管理器那套：**动作常驻，忙碌时只置灰，绝不消失、绝不换形**。
                     原来扫描中把两个入口"就地换成"进度+取消，于是工具条的子元素个数随
                     `scanning` 变化 —— 叠加 n-space 的重复 key 问题，界面上会多出重复按钮，
                     点着还没反应。现在进度和取消都搬到网格下方的状态条（见 .scan-bar），
                     工具条这一组**一个字都不随状态变**（子元素个数恒定）。
                     两个入口仍然**平铺**，不拿下拉藏（这条特性没动）。
                     顺序上「补全」在前（命中缓存就不碰盘，是默认动作），
                     「重读」在后且带确认（唯一会整片真读一遍的主动作）。 -->
                <n-button size="small" :disabled="scanning || !openStack.length || readOnlyLevel" @click="startScan(false)">
                    补全这一片
                </n-button>
                <!-- 只有「重读」带确认：它会忽略缓存、把整片真读一遍，是本组里唯一
                     大面积碰盘的主动作。而「补全」命中缓存就不碰盘，「刷新」只影响一层 ——
                     门槛 ∝ 不可逆 × 范围，那两个再弹窗只会烦人（对高频操作尤甚）。
                     扫描中靠**按钮自身 disabled** 挡住：disabled 的 <button> 不派发 click，
                     确认框自然弹不出来，不需要再给 popconfirm 加一层 v-if。 -->
                <n-popconfirm positive-text="重读" negative-text="取消" @positive-click="startScan(true)">
                    <template #trigger>
                        <n-button size="small" :disabled="scanning || !openStack.length || readOnlyLevel">重读这一片</n-button>
                    </template>
                    忽略缓存，把这一片重新读一遍硬盘。确定吗？
                </n-popconfirm>
                <n-button size="small" @click="showHistory">
                    <template #icon>
                        <FootstepsOutline />
                    </template>
                </n-button>
                <n-badge v-if="fileList.length" :value="fileList.length" />
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
            <div v-for="(item) in fileList" :key="item.dir + '/' + item.name" class="image-box-item" @dblclick="handleOpen($event, item)"
                :title="item.name + ' ' + getSize(item.size)">
                <n-image v-if="item.type === 'image' || item.type === 'video'" :src="thumbUrl(item.thumb)"
                    :preview-src="previewUrl(item)" :alt="item.dir" :lazy="true" objectFit="contain" />
                <n-image v-else-if="!!item.avatar" :src="thumbUrl(item.avatar)" :alt="item.dir || ''" :lazy="true"
                    objectFit="contain" :style="`width:70%;height:70%`" preview-disabled />
                <img v-else-if="item.type === 'folder'" :src="folderIcon" :alt="item.dir || ''" :style="`width:70%`">
                <div v-else :title="item.dir" :class="`file-cover fiv-cla fiv-icon-${item.ext}`"
                    :style="`width:70%;font-size: .6rem`"></div>
                <span>{{ item.name }}</span>
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
        <div v-if="scanning" class="scan-bar">
            <span class="scan-progress">已扫 {{ scanDone }} / 待扫 {{ scanPending }}</span>
            <n-button size="small" :disabled="cancelling" @click="onScanCancel">
                {{ cancelling ? '正在取消…' : '取消' }}
            </n-button>
            <span v-if="cancelling" class="scan-hint">当前这个目录扫完就停</span>
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
        <HistoryTable ref="historyTable" @openDir="openHistory" />
    </div>
</template>

<script setup lang="ts">
import { parseSize } from '@/utils';
import { apiUrl, getAction, ApiError } from '@/utils/request';
import folderIcon from '@/assets/fileTypeIcon/folder.png';
import usePinYin from '@/hooks/usePinYin';
import useNotify from '@/hooks/useNotify';
import { Search, Refresh, FootstepsOutline } from '@vicons/ionicons5';
import { NButton, NBadge, NInput, NIcon, NImage, NTag, NPopover, NSpin, NAlert, NPopconfirm, NTooltip, useLoadingBar } from 'naive-ui';
import FolderSelector from '@/components/FolderSelector/index.vue';
import HistoryTable from '@/components/HistoryTable/index.vue';
import { ipcRenderer } from 'electron';
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue';
import type { FileInfo, FileInfoFiles } from '../../../electron/server/index';
import type { OpenMode } from 'electron/server/nedb';

/**
 * 打开栈里的一层。
 *
 * `name` **不是可选的** —— 它就是面包屑上那个标签的文字。原来写成可选，
 * 结果只有"从网格下钻"那条路会传，另外两条入口（选择文件夹、缓存记录）都没传，
 * 而模板里的 `v-if="!!folder.name"` 会把没名字的层级**整个吃掉**：
 * 表现就是"从这两条入口进来没有面包屑"。名字能由 `path` 算出来，所以由
 * `pushLevel()` 统一派生（见那边注释），这里要求必填。
 */
export interface IOpenInfo { name: string; path: string; mode: 'folder' | 'cover', scrollY?: number }

// 与 electron/server/index.ts 的 VIDEO_EXT 保持一致。
// 这里不能从 server 导入值：server 会带进 node:fs / http / nedb，渲染层会被整包拖进来
const VIDEO_EXT_RE = /\.(mp4|mkv|avi|wmv|flv|mpeg)$/i;

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
const fileNameOf = (item: FileInfo) => (item.ext ? `${item.name}.${item.ext}` : item.name);

/** 条目在磁盘上的完整路径。dir 是服务端补过当前盘符的完整目录 */
const fullPathOf = (item: FileInfo) => `${item.dir}/${fileNameOf(item)}`;

/**
 * 点开放大时用原图。
 * 网格里看图用 480px 缩略图就够，但放大到全屏那个尺寸会明显糊，所以预览单走 /raw。
 * 只有用户真的点开某一 张时才读一次移动硬盘。
 */
const rawUrl = (item: FileInfo) => apiUrl(`${API_BASE}/raw?p=${encodeURIComponent(fullPathOf(item))}`);

/**
 * 点开预览时加载哪张图。
 *
 * 图片走 /raw 原图。**视频绝不能走 /raw**：那条路返回的是 mp4，`<img>` 渲染不了，
 * 预览必然失败；更糟的是这些片子单个 5–7 GB，浏览器会真的朝它发一个 GET，
 * 白白读一遍移动硬盘 —— 直接违背"少碰移动硬盘"这个第一目标。
 *
 * 视频的"预览"就复用它的缩略图：那本来就是 ffmpeg 抽出来的静止帧（JPEG）。
 * 要真播放，双击那条路会交给系统播放器。
 */
const previewUrl = (item: FileInfo) => {
    // 只读层（盘不在，看的是缓存）没有原图可读：`/raw` 走的是磁盘路径，
    // 而只读层的地址是锚点（`#序列号/…`），服务端会直接拒掉它。
    // 降级成缩略图 —— 和视频同一个姿态：宁可看小图，不报错、也不去碰一块不在的盘。
    if (item.type === 'video' || readOnlyLevel.value) return thumbUrl(item.thumb);
    return rawUrl(item);
};

const dir = ref('');
const historyTable = ref<typeof HistoryTable | null>(null)
// const dirRoot = ref('');
const popover = ref<{
    visible: boolean;
    x: number;
    y: number;
    files: FileInfoFiles[];
    cover: FileInfo | undefined;
}>({
    visible: false,
    x: 0,
    y: 0,
    files: [],
    cover: undefined
});
const searchText = ref('');
const imageBox = ref<HTMLDivElement | null>(null)
const folderSelector = ref<typeof FolderSelector | null>(null);
const searchInput = ref<typeof NInput | null>(null);
const dataSource = ref<FileInfo[]>([]);
/**
 * 过滤视图。**派生**出来，不给任何人写权限。
 *
 * 原来 `fileList` 是个 ref，由两处分别写：`fetchFolder`（异步，写整份数据）和
 * `handleFilter`（同步，写过滤结果）。导航时的顺序是"先 handleFilter 再等响应"，
 * 响应回来 `fileList = data` 会把过滤结果冲掉 —— 搜索框里还留着词，列表已经变成全部了。
 * 改成 computed 之后它没有任何写入口，这类时序 bug 在结构上就不可能存在。
 */
const fileList = computed(() => filterByName(dataSource.value, searchText.value));
const searchStack = ref<string[]>([]);
const openStack = ref<IOpenInfo[]>([]);
const loading = ref(false);
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
    // 还没选目录，什么都还没开始，这时候提示是噪音
    if (!dir.value) return '';
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
const isReadOnlyPath = (path: string) => path.startsWith('#');

/** 只看栈顶那一层：用户眼下看到的这屏是不是只读的 */
const readOnlyLevel = computed(() => isReadOnlyPath(openStack.value[openStack.value.length - 1]?.path ?? ''));

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
        return { type: 'info' as const, text: '只读视图：这块盘现在不在，显示的是缓存内容（缩略图可用，打不开原文件）。要看实时的，插上盘后从「缓存记录」重新打开' };
    }
    return { type: 'default' as const, text: '' };
});

const loadingBar = useLoadingBar();
const notify = useNotify();

const getSize = (size: number | undefined) => {
    if (size) {
        const s = parseSize(size);
        if (s.gb) return `${s.gb.toFixed(2)}GB`;
        if (s.mb) return `${s.mb.toFixed(2)}MB`;
        if (s.kb) return `${s.kb.toFixed(2)}KB`;
    } else {
        return size
    }
}

const showHistory = () => {
    historyTable.value!.setShowModal(true);
}

const handleOpen = (e: MouseEvent, item: FileInfo) => {
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
 * 一层的显示名 = 路径的最后一段。
 *
 * 面包屑上的文字本来就能从路径算出来，所以它**不该**是调用方传的可选参数：
 * 三条件入口里有两条件忘了传，而模板 `v-if="!!folder.name"` 一旦拿不到名字就不画那一层 ——
 * 「选择文件夹」和「缓存记录」两条入口的面包屑因此整层消失。
 * 收成这条纯函数之后，"某一层没名字"在结构上不可能出现。
 */
const levelName = (path: string) => {
    const segs = path.replace(/[/\\]+$/, '').split(/[/\\]/).filter(Boolean);
    return segs[segs.length - 1] || path;
}

/**
 * 往打开栈里压一层。**所有层级都必须从这里过。**
 *
 * 原来建栈有两处：`handleDirChange` 和 `openFolderInCover`，一处传名字一处不传，
 * 于是同一个面包屑在两条入口下长得不一样。收成一个出口之后，
 * 「名字」和「进入这一层时记住滚动位置」这两件事都只写一遍。
 * 这和 `fileList` 从 ref 改 computed 是同一个思路：让不一致在结构上不可能。
 */
const pushLevel = (path: string, mode: OpenMode) => {
    // 进入新的一层之前，先把当前层的滚动位置记在**当前层**上，供 onBack 恢复
    if (openStack.value.length) {
        openStack.value[openStack.value.length - 1].scrollY = imageBox.value?.scrollTop
    }
    openStack.value.push({ path, mode, name: levelName(path) });
}

const openFolderInCover = (path: string) => {
    pushLevel(path, 'cover');
    searchStack.value.push(searchText.value);
    // 进新目录不带上一层的搜索词。这句原来在 fetchFolder 里 —— 取数的函数顺手改了
    // 别的状态，结果 onRefresh 得自己"先存后还原"来抵消它。现在归导航动作管。
    searchText.value = '';
    fetchFolder(path, 'cover');
}

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
const openFile = async (item: FileInfo | string) => {
    let target: string;

    if (typeof item === 'string') {
        // popover 里双击的是封面目录下的某个具体文件。
        // 父目录必须取 cover.dir：那个封面是"子目录收敛"出来的，它的真实父目录比
        // openStack 顶层的 path **深一层**。原来用 openStack 顶层拼，会拼出
        // `E:/sample/videos/"TST-131"/"xxx.mp4"` 这种不存在的路径（TST-131 是封面图名，不是目录名）。
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

    // 只读层的地址是锚点（`#序列号/…`）—— 磁盘上不存在这个路径，交给 shell 只会回一句
    // 看不懂的"找不到文件"。这里直接说清楚，也**不去碰盘**（盘根本不在）。
    if (isReadOnlyPath(target)) {
        notify('warning', '只读视图', '这块盘现在不在，打不开原文件。插上盘后从「缓存记录」重新打开。');
        return;
    }

    const err = await ipcRenderer.invoke('openFile', target);
    // openPath 成功返回空串，失败返回错误描述。失败必须说出来
    if (err) notify('error', '打开失败', err);
}

/**
 * 只做一件事：把服务端给的完整列表取回来放进 dataSource。
 *
 * 这里**不再**顺手清空搜索框（原来会清）—— 取数的函数不该同时改别的状态。
 * 清空/恢复交给导航动作自己负责，于是 onRefresh 那套"先存 query 再还原"的仪式也不需要了。
 *
 * 渲染层**没有**缓存了。原来那个 `fetchCache` 按 `path+mode` 存整份列表，而盘符会被复用：
 * A 盘挂 H:/x 缓存住 → 拔 A 插 B → 返回时命中缓存，压根不请求服务端 ——
 * 用户看到的是 A 的清单，双击打开的却是 B 盘上的路径。服务端那侧每次 stat 都复核
 * "这个盘符现在的主人是谁"，渲染层这份缓存正好把那次复核整个绕过。
 * 服务端热读实测 1–2 ms、响应体 1.6 KB，这份缓存换来的那点时间量不出来。
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
 * 把判断收到**唯一的写入点**之后，「过期响应写入」在结构上不可能发生 ——
 * 这和上面 `fileList` 从 ref 改成 computed 是同一个思路，
 * 那边的注释写的也是「让这类时序 bug 在结构上就不可能存在」。
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
    return getAction(noCache ? url + '&noCache=true' : url).then((data: FileInfo[]) => {
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
    if (openStack.value.length === 1) return;
    openStack.value.pop();
    const to = openStack.value[openStack.value.length - 1];
    // 恢复这一层的搜索词。fileList 是 computed，词一变列表自己会重新筛 ——
    // 不需要（也不能）再手动调一次过滤
    searchText.value = searchStack.value.pop() || '';
    await fetchFolder(to.path, to.mode);
    // 滚动位置必须等新列表渲染出来再恢复：在旧内容上滚会被 clamp 掉。
    // 原来这里写死 10ms，是因为缓存命中那条路是同步赋值的；现在没有缓存了，只能等
    if (to.scrollY) {
        await nextTick();
        imageBox.value?.scrollTo(0, to.scrollY || 0)
    }
}

const onRefresh = () => {
    // 只读层没有"重读"这回事：它的源就是缓存，盘不在，F5 也读不出新东西。
    // 拦住而不是让服务端静默回一份缓存 —— 静默最坏（用户以为他重读过了）。
    if (loading.value || !openStack.value.length || readOnlyLevel.value) return;
    const to = openStack.value[openStack.value.length - 1];
    // F5 = 重新扫盘，要带 noCache 让服务端把这条缓存删掉真去读盘，
    // 不然"刷新"只是把同一份缓存又发了一遍。
    // 搜索词不用管：fetchFolder 已经不碰它了
    fetchFolder(to.path, to.mode, true);
}

const handleDirChange = (value: string) => {
    // 切换主目录时清空所有栈
    if (!value) {
        openStack.value = [];
        searchStack.value = []
        // 清掉文件夹选择就该把这个文件夹的内容也清掉，
        // 否则界面上留着上一个目录的东西，而选择框已经空了
        dataSource.value = [];
        searchText.value = '';
    } else {
        dir.value = value;
        openStack.value = [];
        searchStack.value = [];
        // 首层也用 cover。cover 模式才会对子目录调 handleCover（收敛成封面条目）；
        // 原来首层写的是 folder，而 folder 模式**根本不会调用 handleCover** ——
        // 结果是「封面收敛」只在点进去之后的第二层生效，第一层永远只看到一堆文件夹图标，
        // 而第二层反而显示封面。同一个规则两层表现不一致，所以首层也统一成 cover。
        searchText.value = '';
        pushLevel(value, 'cover');
        fetchFolder(value, 'cover');
    }
}

const handleJump = (to: IOpenInfo, index: number) => {
    if (index === openStack.value.length - 1) return;
    openStack.value = openStack.value.slice(0, index + 1);
    searchStack.value = searchStack.value.slice(0, index + 1);

    fetchFolder(to.path, to.mode);
    searchText.value = searchStack.value.pop() || '';
}

/**
 * 从缓存记录打开一个目录。
 *
 * **不再按记录的 `mode` 分叉。** `mode` 说的是"这条记录当初是怎么被扫出来的" ——
 * 它是**缓存记录的属性**，不该决定"导航长什么样"。而 `handleDirChange` 本来就已经
 * 把首层统一成 `cover`（见那边的注释），所以这里只看 path 就够。
 *
 * 原来 `mode === 'cover'` 那条走的是 `openFolderInCover(path)`，它只往栈里压一层、
 * **不设 `dir`、也不给这层名字**，于是：
 *   · 返回按钮那句 `v-if="dir"` 不成立 → 从缓存记录进来没有「返回」
 *   · 模板里 `v-if="!!folder.name"` 不成立 → 这一层在面包屑上被整个吃掉
 * 表现就是"从缓存记录打开既没有多层级面包屑、也没有返回"。
 * 两条入口现在合成同一条 —— 打开一个目录 = 以它为根开始一次浏览。
 */
const openHistory = (path: string) => {
    handleDirChange(path);
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
    getAction(`${API_BASE}/openFolder?path=${encodeURIComponent(path)}&mode=${SCAN_MODE}${noCache ? '&noCache=true' : ''}`) as Promise<FileInfo[]>;

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
    const root = openStack.value[openStack.value.length - 1]?.path;
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
                const items = await requestFolder(dir, rescan);

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
        if (rescan) {
            const top = openStack.value[openStack.value.length - 1];
            if (top) fetchFolder(top.path, top.mode);
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
};

/**
 * 按关键词过滤。
 *
 * 拼音首字母那套逻辑原样保留，只改一处：`usePinYin()` 返回的是 `string[]`
 * （一个字有多个读音就给多个），当字符串参与 `+` 会被隐式 `join(',')` ——
 * 匹配串里凭空多一个逗号，就再也搜不到了。取第一个读音。
 * 平时看不出来是因为不含多音字时数组只有一个元素（20902 个汉字里只有 375 个多音字）。
 */
function filterByName(list: FileInfo[], value: string) {
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
    if (e.key.toUpperCase() === 'S') {
        searchInput.value!.focus();
    } else if (e.key === 'F5') {
        onRefresh();
    } else if (e.key.toUpperCase() === 'D') {
        folderSelector.value!.handleClick();
    }
};

onMounted(() => {
    window.addEventListener('keyup', onKeyup);
});

// 必须写在 setup 顶层。注册在 onMounted 回调**内部**的 onUnmounted 永远不会被调用 ——
// 本次生命周期早过了注册窗口，结果是 keyup 监听永久留在 window 上。
// HistoryTable 那边修过一次，这里是漏网的那处。
onUnmounted(() => {
    window.removeEventListener('keyup', onKeyup);
});


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
 * 头部右侧那一组：**单行，永不换行**。
 *
 * 它和 `.hstack` 只差一个 `flex-wrap` —— 但这一条就是"工具条有几行高"的全部答案。
 * 里面的搜索框是 `width: 100%`（见下面 `.header-bar .n-input` 的注释），
 * 在会换行的容器里它必然独霸一行。`nowrap` 把"工具条永远只有一行"变成结构保证，
 * 以后往这一组里加东西也不会再长高。
 */
.toolbar {
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

.image-box {
    flex: 1;
    display: flex;
    flex-flow: row wrap;
    overflow: hidden auto;
    justify-content: flex-start;
    align-content: flex-start;
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