<template>
    <n-modal v-model:show="showModal" :on-after-leave="onHide">
        <!-- 卡片：装得下 + 关得掉。
             原来的 `width:900px; margin-top:10px` 配一个没有 max-height 的表格，
             每页选 100 条时 100 行 ≈ 3200px 会**直接顶出屏幕**（分页条都够不着）。
             现在卡片自己撑成"头 + 可滚动主体 + 底"的纵向 flex：
             `content-style` 把溢出收进卡片内部，分页条永远在视野里。
             `closable` 补上那个一直缺的 ✕ —— 桌面应用里只能点遮罩/Esc 关是明确的不良设计。 -->
        <n-card class="cache-panel" title="缓存记录" closable :bordered="false" size="huge" role="dialog"
            aria-modal="true"
            :content-style="{ display: 'flex', flexDirection: 'column', overflow: 'hidden', flex: '1 1 auto', minHeight: '0' }"
            style="width: min(1040px, 92vw); height: 86vh; display: flex; flex-direction: column"
            @close="setShowModal(false)">
            <!-- G1「找」= 搜索 + 刷新。
                 用户原话是「方便查看，搜索」—— 搜索是第一诉求，所以它占满一行，不再挤在 170px 里。
                 主界面早就是"输入即过滤"（index.vue 的 fileList computed），这里对齐，去掉「查询」按钮。
                 容器用**裸 flex** 而不是 n-space：naive-ui 2.45.3 给每个子项写死同一个 key，
                 子元素个数一变就会重复 key / 错位复用节点（先例 docs/FIX-2026-09-24-nspace-duplicate-keys.md）。
                 本面板下面几组的子元素个数确实会变（盘选项、批量区），统一用裸容器。 -->
            <template #header-extra>
                <div class="g1-row">
                    <!-- ⚠️ 搜索框外面**必须**套这一层普通 div，用来接输入法的 composition 事件。
                         理由（已核过 node_modules，不是猜的）：naive-ui 的 NInput 在**它自己的 render 里**
                         把 `onCompositionstart/onCompositionend` 显式绑到内部 input 上（Input.mjs:928-929），
                         外面再传同名 prop 会被它整个顶掉 —— 我们收不到。
                         而 composition 事件**会冒泡**，所以在外面套一层接就行了。 -->
                    <div class="g1-search" @compositionstart="onCompositionStart"
                        @compositionend="onCompositionEnd">
                        <n-input ref="searchRef" v-model:value="model.path" placeholder="搜索目录名（也可以直接输盘符）"
                            clearable size="small" @keyup.enter="onSearch">
                            <template #prefix>
                                <n-icon :component="Search" />
                            </template>
                        </n-input>
                    </div>
                    <n-button size="small" :loading="diskLoading || loading" @click="onRefresh">刷新</n-button>
                </div>
            </template>
            <!-- ⚠️ 只有**表格那一块**滚动，不是整个弹窗 body 滚动。
                 上一版把 overflow 放在卡片内容上，结果滚动条出现在整个面板右侧 ——
                 搜索框、总览、盘筛选会跟着一起滚走，表格自己的表头也不吸顶。
                 现在：卡片内容 = 纵向 flex + overflow:hidden；n-spin 的 content 也撑成纵向 flex；
                 只有包住表格的 `.table-wrap` 是 flex:1 + overflow:auto —— 于是滚动条落在表格上，
                 表头靠 CSS sticky 吸顶（见 style 块）。
                 n-spin 的 contentStyle 就是为这个用的（naive-ui 的 Spin 有这个 prop，不用去戳它内部类名）。 -->
            <n-spin :show="loading"
                :content-style="{ display: 'flex', flexDirection: 'column', flex: '1 1 auto', minHeight: '0' }">
                <template #description>
                    数据加载中...
                </template>

                <n-alert v-if="duplicated.length" type="warning" :show-icon="true" style="margin-bottom: 10px">
                    <template #header>检测到克隆盘</template>
                    有 {{ duplicated.length }} 组移动硬盘的卷序列号完全一样（用 Ghost 之类整盘克隆会这样）。
                    序列号是这套缓存区分硬盘的唯一依据，两者会互相串 —— 建议重新格式化其中一块。
                </n-alert>

                <!-- G2「逛」= 总览 + 唯一的安全出口；下一行才是盘筛选。
                     这一行左边留给总览句（盘数 / 目录数 / 条目数 / 已读到多少 / 库大小 / 最近扫描）——
                     它的数据来自阶段 B 给 /getDisks 加的只读 stats；**先把结构占好**，B 阶段只往里填内容，
                     不再动布局（避免同一块地方改两次）。
                     右边是「打开存放文件夹」：它是**唯一一个不碰任何数据**的出口
                     （系统文件管理器自带回收站和撤销，比在应用里自建一个没有撤销的版本安全），
                     所以它**不进**下面的折叠区 —— 折叠区收的是会动数据的动作。
                     理由见 docs/DESIGN-CONVERGED-2026-09-24.md §三。 -->
                <div class="g2-row">
                    <!-- 总览句：盘数 / 目录数 / 条目数 / 已读到多少 / 库大小 / 最近扫描。
                         全部来自 /getDisks 的 stats —— **服务端在内存里汇总**，一次盘都不读。
                         「已读到」这个措辞是刻意的：它是缓存里记录到的字节之和（扫描快照），
                         不是"硬盘上有多少"。 -->
                    <span class="overview">{{ overview }}</span>
                    <n-button text size="small" @click="openDataDir">打开存放文件夹</n-button>
                </div>

                <div class="g2-disk">
                    <!-- 选盘 = 这套缓存的分组维度：先说清"这些缓存属于哪块盘"，再列那块盘缓存过哪些目录。
                         盘符只是当前挂载点，真正的身份是卷序列号。
                         ⚠️ 不能用 `v-model:value` 再配 `:on-update:value`（两者编译成同一个 prop 名，
                         后者会把前者的 setter 整个顶掉）。规则：**一个 update 事件只挂一个 handler**。
                         详见 docs/FIX-2026-09-24-naive-ui-update-prop.md -->
                    <n-select :value="model.serial" :options="diskOptions" :loading="diskLoading"
                        style="width: 320px" size="small" :on-update:value="handleSerialChange" />
                </div>

                <div class="table-wrap">
                    <!-- `flex-height` 是这个"表头不跟着滚"的**关键**：给了它，DataTable 会把表头渲染成
                         独立的一块（`.n-data-table-base-table-header`），滚动只发生在它自己的 body 里。
                         不给它的话，表格高度由内容决定（实测 60 行 = 4235px），
                         外面那层 div 就成了"整张表"的滚动容器 —— 表头必然跟着滚。
                         前提是外层有**确定高度**（见卡片上的 `height: 86vh` 与 style 块里的注释）。 -->
                    <!-- ⚠️ `:checked-row-keys` **必须给**（受控）。naive-ui 的 DataTableInst 里
                        没有 clearCheckedRowKeys 这类 API，勾选是表格**内部态** ——
                         不给受控 prop 的话，外面的 `checkedRowKeysRef = []` 只是改了我自己的变量，
                         表格上的勾**原封不动**："清空选择"、关闭面板、删除后复位全都不生效，
                         界面会出现"提示说未选中、勾还打着"（自己 review 时抓到的）。 -->
                    <n-data-table :columns="columns" :data="tableData" :row-key="rowKey" flex-height
                        :sorter="tableSorter" :checked-row-keys="checkedRowKeysRef"
                        @update:sorter="handleSorterChange"
                        @update:checked-row-keys="handleCheck">
                        <!-- 空态渲染在**表格自己的空槽**里（naive-ui 的 #empty 会替换它内置的"暂无数据"），
                             而不是另起一个 div 挂在表格下面 —— 挂下面会同时出现两句"没数据"，
                             位置也不对（应该长在表格本该有内容的那块地方）。
                             三件事必须分得开：真的一层都没有 / 搜索没匹配 / 读不到。
                             最后一种由服务端 kind 走主界面横幅，这里只管前两种。
                             判据全在 emptyText 这个 computed 里（含"先排除 loading"和"有没有数据"）。 -->
                        <template #empty>
                            <div class="empty-tip">
                                <div>{{ loading ? '' : (emptyText || '暂无数据') }}</div>
                                <div v-if="emptyText && !model.path" class="empty-sub">
                                    在主界面选个文件夹，点「补全这一片」
                                </div>
                            </div>
                        </template>
                    </n-data-table>
                </div>
            </n-spin>

            <!-- G4「管理」= 低频 + 会动数据的动作，全部收进折叠区（默认收起）。
                 分组本身就是第一道危险分级：外面那几行是查 / 逛 / 安全出口，这里面才是会改数据的。
                 ⚠️ 两个「备份」已合一：原来那个「备份」把库默默写进你看不见的数据目录，
                 而且**按天同名覆盖**（同一天备份第二次会把第一次盖掉）——
                 那给的是"我以为备份了"的**假安全感**，是备份功能最坏的失败模式。
                 `/backup` 接口保留不删（零成本，将来"退出时自动快照"可直接复用）。
                 见 docs/DESIGN-BACKUP-2026-09-24.md §7.8 —— 那里本来就挂着"是否收掉，等你一句话"。 -->
            <n-collapse class="migrate-collapse">
                <n-collapse-item title="备份与迁移" name="migrate">
                    <div class="mi-row">
                        <n-button size="small" @click="handleBackupToFile">备份到文件…</n-button>
                        <span class="mi-hint">默认文件名带你今天的日期，位置自己挑 —— 不会被任何东西覆盖</span>
                    </div>
                    <div class="mi-row">
                        <!-- 唯一着色的一条：这一组里只有它是"整份替换"（合并只增不删）。 -->
                        <n-button size="small" type="error" @click="handleRestoreFromFile">从文件还原…</n-button>
                        <span class="mi-hint warn">整份替换当前缓存</span>
                    </div>
                    <div class="mi-row">
                        <n-button size="small" @click="handleMergeCache">合并缓存…</n-button>
                        <span class="mi-hint">只增不删（新增 / 覆盖 / 跳过 会报给你）</span>
                    </div>
                </n-collapse-item>
            </n-collapse>

            <template #footer>
                <!-- 批量区固定在底部、**高度恒定**：没选中时按钮置灰而不是消失 ——
                     用 v-if 的话它一出现就把整行推走（原来正是这样）。
                     勾选是**受控**的（`:checked-row-keys`）—— 这既让"清空选择"和关闭面板复位真的生效，
                     也让跨页勾选后"要删哪些"不再是黑箱：几项不在本页直接写在提示里。
                     （原先我担心"受控要自己管清理时机"就没做受控，结果"清空选择"点了没反应 ——
                     见表格上那条注释。） -->
                <div class="foot-row">
                    <div class="foot-left">
                        <n-button size="small" type="error" :disabled="!checkedRowKeysRef.length"
                            @click="handleRemove">删除记录</n-button>
                        <span class="sel-hint">
                            {{ checkedRowKeysRef.length
                                ? `已选 ${checkedRowKeysRef.length} 项（其中 ${checkedOnOtherPages} 项不在本页）`
                                : '未选中任何记录' }}
                        </span>
                        <n-button v-if="checkedRowKeysRef.length" text size="small"
                            @click="handleCheck([])">清空选择</n-button>
                    </div>
                    <n-pagination size="small" :page="model.pageNo" :page-size="model.pageSize"
                        :disabled="loading" :item-count="model.total" show-size-picker show-quick-jumper :page-slot="7"
                        :page-sizes="[10, 16, 20, 40, 60, 80, 100]" :on-update:page="handlePageChange"
                        :on-update:page-size="handlePageSizeChange">
                        <template #prefix="{ itemCount }">
                            共 {{ itemCount }} 项
                        </template>
                    </n-pagination>
                </div>
            </template>
        </n-card>
    </n-modal>
</template>

<script lang="ts" setup>
import { computed, h, nextTick, ref, toRaw, watch } from 'vue';
import { ipcRenderer } from 'electron';
import useNotify from '@/hooks/useNotify';
import { Search } from '@vicons/ionicons5';
import {
    NInput, NButton, NCard, NModal, NPagination, NDataTable, NSpin, NSelect, NAlert, NTag, NIcon,
    NCollapse, NCollapseItem, useDialog,
} from 'naive-ui'
import type { DataTableColumns, DataTableRowKey, DataTableSortState, InputInst } from 'naive-ui'
import { formatBytes } from '@/utils';
import type { BrowseHistoryWithPagination, OpenMode } from 'electron/server/nedb';
import { getAction, postAction } from '@/utils/request';

// 统一写 127.0.0.1 而不是 localhost，避免个别机器把 localhost 解析到 ::1（服务端只绑 IPv4）
const API_BASE = 'http://127.0.0.1:3060';

type HistoryQuery = {
    serial: string;
    path: string;
    pageNo: number;
    pageSize: number;
    total: number;
    /** 排序键，与 /getHistory 的 sort 参数同名：'path' | 'count' | 'bytes' | 'create_at' */
    sort: string;
    /** 'asc' | 'desc' */
    dir: string;
}

/** /getDisks 回来的一行 */
type DiskRow = {
    serial: string;
    drive: string;
    label: string;
    online: boolean;
    folders: number;
    covers: number;
    lastScanAt: string;
};

/**
 * `/getDisks` 的只读汇总（面板顶部「总览」用）。
 * **全是服务端在内存里算出来的** + 一次本地库文件的 `stat` —— 没有任何一项碰移动硬盘。
 */
type DiskStats = {
    disks: number;
    folders: number;
    entries: number;
    /** 「缓存里记录到的字节之和」——是**扫描快照**，不是硬盘上的实时占用（措辞必须这么写） */
    bytes: number;
    /** 库文件大小（本地文件）。拿不到就是 undefined，那种情况不显示这一项 */
    dbBytes?: number;
    lastScanAt: string;
};

/** /getHistory 回来的一行：缓存元数据 + 这块盘此刻在不在线 */
type RowData = BrowseHistoryWithPagination['records'][number];

/**
 * 时间显示：`YYYY-MM-DD HH:mm`（去掉秒）。
 *
 * 列头原来写「日期」，值其实 = `create_at` = **写入这条缓存的时刻**（"上次扫描"）。
 * ⚠️ 我曾经省略掉同年份的年份（只显示 `09-24 14:32`）——那是自作聪明：
 * 用户第一眼就问"为什么没有年月"。**时间就要写全**，省这点宽度不值当。
 */
function fmtScanTime(t?: string) {
    if (!t) return '—';
    return t.slice(0, 16);
}

const columns = ref<DataTableColumns<RowData>>([{
    type: 'selection'
}, {
    /**
     * 盘。
     *
     * 原来盘符是混在「盘 / 路径」列里的一个小标签，而离线时渲染成 `'??'` —— 纯噪音：
     * 看不出是"盘符未知"还是"出错了"（离线行的 `path` 是只读锚点 `#序列号/…`，
     * 直接 slice(0,2) 会切出 `#F` 那种东西，所以当初才写成 `??`）。
     * 拆成独立一列：在线给当前盘符，离线直接写「离线」。
     */
    title: '盘', key: 'disk', width: 88,
    render(row) {
        // 离线那枚标签带一句说明 —— 行里不再单独挂"离线 · 只读"（那是重复信息，用户要求去掉）。
        // 但"只读"这件事本身要有个地方说得清，所以挂在标签的 title 上，不占视觉空间。
        return h(NTag, {
            size: 'small', bordered: false, type: row.online ? 'success' : 'default',
            title: row.online ? '' : '这块盘没插 —— 打开看到的是缓存，缩略图可用',
        }, { default: () => (row.online && row.path ? row.path.slice(0, 2) : '离线') });
    },
}, {
    /**
     * 目录 = **打开这一行的唯一入口，仍然是双击**（用户明确要求：不要操作列）。
     *
     * 蓝色字体（用户要求"和之前一样"）—— 它本来就是一个链接的样子：
     * 之前那版是 `NButton quaternary`（蓝字），我一度改成纯黑文本 + 悬停提示"双击打开"，
     * 用户的反馈是：**蓝色要留着，悬停提示多余**。所以这里回到蓝字，去掉悬停提示。
     * 链接的样子本身就是可发现性，不需要再用一句话去解释。
     *
     * 离线**照旧可进**：服务端给的是只读锚点，读缓存、不碰盘（见 openDir 注释）。
     */
    title: '目录', key: 'path', minWidth: 240, sorter: true,
    render(row) {
        return h('div', { class: 'dir-cell' }, [
            h('span', { class: 'dir-name', ondblclick: () => openDir(row) }, row.relPath || '/'),
            // count === 0 不能只给一个 0：它要么是空目录，要么是当初没读到。
            // 库里实测有 2 条这种记录，**从数据本身分不出是哪一种** —— 所以只指路，
            // 处理动作走主界面既有功能（双击打开它 → 按 ↻ 重读），**不新增读盘入口**。
            !row.count
                ? h('span', {
                    class: 'dir-note',
                    title: '这条记录 0 个条目：可能是空目录，也可能当初没读到。双击打开它，在主界面按 ↻ 重读一次即可。',
                }, '空目录或未读到')
                : null,
        ]);
    },
}, {
    // 「封面」→「条目」：它本来就是这一层的**条目数**（scanAndCache 写的是 `count: data.length`，
    // 即收敛之后的卡片数），不是"封面图有多少张"。实测 AAAA1111 = 106 个目录 / 644 个条目。
    title: '条目', key: 'count', width: 88, align: 'right', sorter: true,
}, {
    /**
     * 大小 = 这一层的内容字节总量。
     *
     * ⚠️ 语义要说准（列头 tooltip 也这么写）：它是"**上次扫到的那一刻**，这一层里所有文件加起来多大"，
     * 不是"硬盘上此刻有多少"——之后删/移文件不会更新它，缓存本来就是一快照。
     * 数值来自服务端 `loadMeta({ withBytes: true })` 的**纯内存求和**（实测 0.07 ms），**不读盘**。
     * 0 / 算不出时 `formatBytes` 给 `—`（反例：有一层 104 个条目全是子目录，合计 0 字节 ——
     * 写 "0 B" 会被读成"这 104 个东西没内容"）。
     */
    title: '大小', key: 'bytes', width: 96, align: 'right', sorter: true,
    render: row => formatBytes(row.bytes),
}, {
    title: '上次扫描', key: 'create_at', width: 150, align: 'right', sorter: true,
    render: row => fmtScanTime(row.create_at),
}])

/**
 * 表头箭头**受控** —— 让界面如实反映"现在按什么排的"（默认按盘→路径）。
 * naive-ui 的 order 取值是 'ascend' / 'descend'；`sorter` 给一个**恒等比较器**：
 * 排序是服务端做的（只有它知道全量），这里若给真正的比较函数，
 * naive-ui 会在**当前页**再排一次 —— 那会和服务端给的顺序打架
 * （最典型的是 'path'：服务端按 (盘, 路径) 排，前端只会按路径排 → 同页里盘会被打散）。
 */
const tableSorter = computed<DataTableSortState[]>(() => [
    {
        columnKey: model.value.sort,
        order: model.value.dir === 'asc' ? 'ascend' : 'descend',
        sorter: () => 0,
    },
]);

/**
 * 表头排序 → **重新向服务端要数据**。
 *
 * 为什么必须服务端排：只有服务端知道全量（213 条）。前端排只能排**当前这一页** ——
 * 那是**假排序**：看着"第 1 页最大的在最上面"，翻到第 2 页又是另一批，用户会以为数据错了。
 *
 * 列 key 与 `/getHistory` 的 `sort` 参数**同名**（path / count / bytes / create_at），
 * 所以这里直接把 columnKey 当排序键 —— 不维护映射表，就少一处会漂移的对应关系。
 */
const handleSorterChange = (sorter: DataTableSortState | DataTableSortState[] | null) => {
    const s = Array.isArray(sorter) ? sorter[0] : sorter;
    let nextSort = 'path';
    let nextDir = 'asc';
    if (s && s.order) {
        nextSort = String(s.columnKey);
        nextDir = s.order === 'ascend' ? 'asc' : 'desc';
    }

    // **幂等守卫**：目标排序和当前一模一样就直接返回。
    // 两个作用：① 受控 `:sorter` 万一因为 prop 同步再回调一次，这里直接吞掉 ——
    // 死循环在结构上不可能发生（不是赌它不回调）；② 顺带省掉一次无意义的请求。
    if (nextSort === model.value.sort && nextDir === model.value.dir) return;

    model.value.sort = nextSort;
    model.value.dir = nextDir;
    model.value.pageNo = 1;
    getHistrotyList();
};

/**
 * 顶部「总览」那一句。数据来自 `/getDisks` 的 `stats`（服务端内存汇总，零读盘）。
 * 拿不到 stats 时返回空串（不显示）—— 首次加载前那一下不该闪出一个半截句子。
 */
const overview = computed(() => {
    const s = stats.value;
    if (!s) return '';
    const parts = [
        `${s.disks} 块盘`,
        `${s.folders} 个目录`,
        `${s.entries} 个条目`,
        // ⚠️「已读到」这三个字不能省、也不能改成"当前"或"硬盘上"：
        // 它是"缓存里记录到的字节之和"，是**扫描快照**，不是硬盘上的实时占用。
        `已读到 ${formatBytes(s.bytes)}`,
    ];
    if (typeof s.dbBytes === 'number') parts.push(`库 ${formatBytes(s.dbBytes)}`);
    if (s.lastScanAt) parts.push(`最近扫描 ${fmtScanTime(s.lastScanAt)}`);
    return parts.join(' · ');
});

const tableData = ref<RowData[]>([])
const emits = defineEmits<{
    (e: 'openDir', path: string, mode: OpenMode): void
}>();
const notify = useNotify();
const dialog = useDialog();
const model = ref<HistoryQuery>({
    serial: '',
    path: '',
    pageNo: 1,
    // 每页 16 条（用户定的）。注意 `page-sizes` 里也要有 16，
    // 否则分页器的"每页条数"下拉表示不出当前这个值。
    pageSize: 16,
    total: 0,
    // 默认排序 = **盘 → 路径**（服务端按 (serial, relPath) 排）。
    // 为什么不是"最近扫描在前"：这个面板被当成黄页/导航用，同盘相邻才好找；
    // 而按时间倒序会把**扫得早那块盘的记录永远冲到底部** —— 直接伤"盘不在也能看有哪些"。
    // 想按时间看：点「上次扫描」表头即可（一次点击，能力没丢）。
    sort: 'path',
    dir: 'asc'
})
const showModal = ref(false);
const loading = ref(false);
const diskLoading = ref(false);
const diskOptions = ref<{ label: string; value: string }[]>([{ label: '全部盘', value: '' }]);
const duplicated = ref<string[]>([]);
/** 搜索框 ref —— 打开面板时把焦点放进去（键盘路径的第一个落点） */
const searchRef = ref<InputInst | null>(null);

/** 顶部「总览」的数据源（/getDisks 的 stats）。没拿到前不显示那一行 */
const stats = ref<DiskStats | null>(null);

const setShowModal = function (val: boolean) {
    showModal.value = val;
}

function toQueryStr(val: Record<string, any>) {
    if (!val || typeof val !== 'object') return `?_t=${+new Date()}`

    let queryStr = Object.keys(val).map(key => {
        const value = String(val[key] !== undefined ? val[key] : '');
        if (value) {
            // 必须编码：路径里的 & 会被当成参数分隔符，# 会被当成 fragment
            return `${key}=${encodeURIComponent(value)}`
        } else {
            return
        }
    }).filter(f => f).join('&')

    return queryStr ? `?${queryStr}&_t=${+new Date()}` : `?_t=${+new Date()}`
}

function diskLabel(d: DiskRow) {
    // 离线盘**必须能区分是哪一块**：卷标从来没被赋值（见下面注释），所以拿序列号后 4 位当标识。
    // 不这么做的话，两块盘都不在时下拉里会出现两行只差数字的「未插入」，只能靠目录数猜。
    const where = d.online ? `${d.drive}:` : `离线(${d.serial.slice(-4)})`;
    // `label` 目前**永远是空串** —— 服务端 driveIdentity.ts 的 probe() 把它写死成 `''`
    // （注释却写着"用户起的名字"，从来没实现过）。实测 disks.json 里 6 块盘全空，
    // 所以这个分支恒不命中；留着是为了以后补上"给盘起名"时显示层不用再改。
    const name = d.label ? ` ${d.label}` : '';
    // `covers` 是 /getDisks 里把每条记录的 `count` 累加出来的数 —— 它是**条目数**，
    // 不是"封面图有多少张"（原来这里写"张封面"，和数据的含义对不上）。
    return `${where}${name} · ${d.folders} 个目录 / ${d.covers} 个条目`;
}

/**
 * 拉一次盘列表。
 *
 * 这是这套缓存的分组维度：先说清楚"这些缓存属于哪块盘"，再去列那块盘缓存过哪些目录。
 * 盘符只是当前挂载点，所以列表里显示的是盘符和卷标，真正的身份是序列号。
 *
 * `refresh = true` 才让服务端真去重探一遍盘符（26 次 `stat`）。
 * 打开面板时**不探** —— 那会让"每次打开"都碰一遍所有盘根，
 * 而"插上盘列表不自动更新"这个代价用户已经接受（按一下「刷新」就好）。
 */
const loadDisks = async (refresh = false) => {
    diskLoading.value = true;
    try {
        // 走 getAction 而不是裸 fetch：响应检查只在 request.ts 里做一次就够了。
        // 原来这里是 `fetch(...).then(res => res.json())`，不判 res.ok 也不判 body 里的 code，
        // 于是 `{code:500}` 会被当成正常数据一路用下去。
        const data = await getAction(`${API_BASE}/getDisks${refresh ? '?refresh=true' : ''}`);
        const disks: DiskRow[] = data.disks || [];
        diskOptions.value = [
            { label: `全部盘 · ${disks.reduce((n, d) => n + d.folders, 0)} 个目录`, value: '' },
            ...disks.map(d => ({ label: diskLabel(d), value: d.serial })),
        ];
        duplicated.value = data.duplicated || [];
        stats.value = data.stats || null;
    } catch (err) {
        notify('error', '错误', `获取磁盘列表失败！${err}`)
    } finally {
        diskLoading.value = false;
    }
}

/**
 * 请求序号 —— 只让**最后一次发出的请求**写表格。
 *
 * 为什么不用 `if (loading.value) return` 那个守卫：搜索变即时之后（输入即过滤，debounce 250ms），
 * 守卫会把用户**最新那次输入直接丢掉**（正在 loading 时这轮搜索被 return 掉），
 * 界面就停在上一轮结果上 —— "输了词但列表没变"，而且没有任何提示。
 *
 * 序号法在**结构上**保证"旧的响应永远覆盖不了新的"，不依赖每个调用方记得加守卫 ——
 * 和 `queueCacheWrite` 是唯一写入点、`wire()` 是唯一下发出口是同一个思路。
 */
let listReqSeq = 0;

const getHistrotyList = () => {
    const my = ++listReqSeq;
    loading.value = true;
    // 走统一出口而不是裸 fetch。这里尤其要紧 —— 服务端出错时返回的是 **HTTP 200 + {code:500}**，
    // 裸 fetch 时 promise 是 resolve 的，进不了 catch，于是没有提示、还把 undefined 写进了表格
    getAction(`${API_BASE}/getHistory${toQueryStr(model.value)}`).then(async (data: BrowseHistoryWithPagination) => {
        if (my !== listReqSeq) return;      // 过期响应：丢弃，绝不覆盖新结果
        tableData.value = data.records
        model.value.total = data.total
    }).catch(err => {
        if (my !== listReqSeq) return;
        notify('error', '错误', `获取历史数据列表错误！${err}`)
    }).finally(() => {
        if (my === listReqSeq) loading.value = false;
    });
}

/**
 * 选盘。
 *
 * ⚠️ 这里**不能**用 `v-model:value="model.serial"` 再配一个 `:on-update:value`：
 * 两者编译出来的 prop 名是同一个 —— `camelize('on-update:value')` 和
 * `camelize('onUpdate:value')` 都等于 `onUpdate:value`，而 naive-ui 的 Select 只认这一个 prop，
 * 后写的 handler 会把 v-model 的 setter **整个顶掉**（编译产物里就是相邻的两个 key）。
 * 症状：下拉能展开、能点，但选完值不变、列表也不动 —— 因为查询发出去时 `serial` 还是空串。
 *
 * 规则：**一个 update 事件只挂一个 handler**，赋值和后续动作都写在它里面。
 */
const handleSerialChange = (serial: string) => {
    model.value.serial = serial;
    onSearch();
}

const onSearch = () => {
    // 去掉了原来的 `if (loading.value) return`：那是重入守卫，会连带把**用户刚敲的那个词**丢掉。
    // 并发正确性交给 getHistrotyList 的请求序号 —— 谁最后发谁说话，不需要调用方记得守卫。
    model.value.pageNo = 1;
    getHistrotyList();
}

/**
 * 输入即过滤（debounce 300ms）。
 *
 * 为什么改成即时：主界面早就是"输入即过滤"（`index.vue` 的 `fileList` computed），
 * 这个面板却要按回车或点「查询」才算数 —— 同一个应用两套手感。
 * 而"方便查看、搜索"正是用户对这个面板的第一诉求。
 * 回车仍然保留（想立刻查就按），两者不冲突。
 *
 * ⚠️ 中文输入法要单独挡一道：naive-ui 的 NInput 在 composition 期间**照样**会发 `update:value`
 * （`handleInput` 只在 `!e.isComposing` 时才清 isComposing，值本身一路照发），
 * 于是打一个"张"字可能已经排出三四条请求 —— 列表在拼字中途乱跳，白读一遍服务端。
 * 处理：composition 期间只更新输入框、**不发请求**；等 `compositionend`（上屏）后再查一次。
 * 光靠 debounce 不够稳（用户打字中途停顿一下就会漏出一条半成品的查询），
 * 所以两个一起用：debounce 管"打字的节奏"，composition 管"输入法的边界"。
 */
let searchTimer: number | undefined;
let composing = false;

const scheduleSearch = () => {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => onSearch(), 300);
};

const onCompositionStart = () => {
    composing = true;
};

const onCompositionEnd = () => {
    composing = false;
    // 上屏后立刻查一次（不用再等 debounce —— 用户已经"打完了"）
    scheduleSearch();
};

watch(() => model.value.path, () => {
    if (composing) return;
    scheduleSearch();
});

/**
 * 「刷新」= **真的重探一遍盘符** + 重取列表。这是面板里唯一会碰盘根探测的入口。
 *
 * ⚠️ **必须串行**：`/getDisks?refresh=true` 才会让服务端重探，而 `/getHistory` 用的是
 * **进程内缓存的盘列表**（阶段 C 起不再每次重探）。两个并发发出去的话，
 * 列表请求很可能在重探完成**之前**读到旧列表 —— 表现就是"下拉里盘已经在线了，表格里还是离线/只读"。
 * 所以：先等盘列表回来，再取列表。
 *
 * 也不再需要重入守卫：请求序号已经保证并发安全，守卫只会表现成"点了没反应"。
 */
const onRefresh = async () => {
    await loadDisks(true);
    getHistrotyList();
}

/**
 * 「列表数据变了但盘没变」时用的刷新 —— 删除 / 还原 / 合并之后走它。
 *
 * 和 `onRefresh` 的区别只有一点：**不重探盘符**。那三个动作都不会改变"插着哪些盘"，
 * 让它们顺带做 26 次 `stat` 纯属浪费（用户的第一优先级就是少碰盘）。
 * 但仍要重取盘列表 —— 每条记录的目录数/条目数变了，下拉里的统计得跟上。
 */
const reloadAfterDataChange = () => {
    loadDisks();
    getHistrotyList();
}

/**
 * 空态文案。**空态的全部判据都在这里** —— 模板只写 `v-if="emptyText"`。
 *
 * ⚠️ 判据必须先排除 loading（照抄主界面 `emptyTip` 的写法：
 * `if (loading.value || loadFailed.value || fileList.length) return ''`）——
 * 否则首次打开时 `tableData` 还是空数组，界面上会先闪一下"还没读过任何目录"，然后才出数据。
 *
 * ⚠️ `tableData.length` 这一条**不能只写在模板的 v-if 里**（我第一版就是这么写的，是个真 BUG）：
 * `emptyText` 在"没搜词 + 不在加载"时恒等于"还没读过任何目录"，
 * 于是**列表里有 213 行时，表格下面照样挂着那句空态**。
 * 把"有没有数据"收进这个 computed，判据就只有一处，不会再出现"模板忘了带条件"。
 *
 * 三件事必须分得开：真的一层都没有 / 搜索没匹配 / 读不到。
 * 最后一种由服务端 `kind` 走主界面横幅，这里只管前两种。
 */
const emptyText = computed(() => {
    if (loading.value || tableData.value.length) return '';
    if (model.value.path) return `没有匹配「${model.value.path}」的目录`;
    return '还没读过任何目录';
});

/**
 * 打开一行对应的目录。
 *
 * 盘不在**不再拦**（原来这里是 `if (!item.online) 提示"盘未插入" + return`）：
 * 服务端给离线行的是**只读锚点**（`#序列号/盘内路径`），照着它打开读的是缓存 ——
 * 不碰盘、不写缓存，所以"盘不在"不再是"点不开"的理由。
 * 只读视图能干什么由视图那边说（只读横幅 + 禁用三个要读盘的入口），不在这里拦。
 */
const openDir = (item: RowData) => {
    const target = item.path;
    if (!target) {
        notify('warning', '打开失败', `这条记录（序列号 ${item.serial}）没有可用的地址。`)
        return;
    }
    setShowModal(false);
    setTimeout(() => {
        emits('openDir', target, item.mode || 'cover');
    }, 300)
}

// 同 handleSerialChange：`:on-update:page` / `:on-update:page-size` 与 `v-model:page` / `v-model:page-size`
// 争的是同一个 prop（camelize 后分别等于 `onUpdate:page` / `onUpdate:pageSize`），
// 所以分页状态只由下面这两个 handler 写。
const handlePageChange = (page: number) => {
    model.value.pageNo = page;
    getHistrotyList();
}

const handlePageSizeChange = (pageSize: number) => {
    model.value.pageSize = pageSize;
    // ⚠️ 必须同时把页码拉回第 1 页。
    // 原来只改 pageSize 不动 pageNo：在 213 条、每页 10 条时停在第 10 页，
    // 把每页改成 100 → 请求 `pageNo=10&pageSize=100` → `slice(900, 1000)` = **空数组**，
    // 而分页器还写着"共 213 项" —— 用户看到的是"一片空白 + 数字又是对的"，只会以为程序坏了。
    model.value.pageNo = 1;
    getHistrotyList();
}

/**
 * 行主键。**只有这一处定义** —— 表格的 `:row-key` 和下面的"跨页统计"必须用同一个键，
 * 写在两个地方迟早漂移。
 */
function rowKey(row: RowData) {
    return row._id || row.serial + '/' + row.relPath;
}

const checkedRowKeysRef = ref<DataTableRowKey[]>([])

/**
 * 选中的行里有多少**不在当前这一页**。
 *
 * 为什么需要：跨页勾选时，表格**受控**的 checked-row-keys 会保留不在本页的键，
 * naive-ui 会让跨页选中的行保持选中 → 底部那行"删除记录"实际会删掉**当前页看不见的记录**，
 * 而用户无从知道。这里不剥夺"跨页多选"的能力，只把状态说明白。
 */
const checkedOnOtherPages = computed(() => {
    const onPage = new Set(tableData.value.map(r => rowKey(r)));
    return checkedRowKeysRef.value.filter(k => !onPage.has(k as string)).length;
});

/**
 * 勾选变化的唯一入口。表格是**受控**的（`:checked-row-keys="checkedRowKeysRef"`），
 * 所以这里写进去的值就是表格显示的值 —— 清空、复位都靠它，不需要（也没有）
 * 什么"清空表格勾选"的实例 API（`DataTableInst` 里确实没有，查过）。
 */
const handleCheck = (rowKeys: DataTableRowKey[]) => {
    checkedRowKeysRef.value = rowKeys
}

/**
 * 「删除记录」的确认框。
 *
 * 原来的文案是「你确定要删除选中数据吗？」—— "数据"两个字埋了两个坑：
 *   1. 删的到底是**硬盘上的文件**还是**这条记录**？用户不敢点，也不想点；
 *   2. 删了之后会怎样 —— 而这才是他真正需要知道的。
 *
 * 实测的后果链是：删掉记录 → 下次打开那个目录 `findCache` 未命中 →
 * `scanAndCache` 重新读盘再写缓存（`server/index.ts` 的 scanAndCache）。
 * 也就是说：**代价不是"丢数据"，是"要重新读一遍移动硬盘"**；
 * 而离线盘上的记录删了就再也看不到了（除非把盘插回来重扫）。
 * 把这个代价说清楚，比加十个"确定吗"都有用。
 */
const handleRemove = async () => {
    const n = checkedRowKeysRef.value.length;
    const off = checkedOnOtherPages.value;                     // 有几条选中不在本页
    const selected = new Set(checkedRowKeysRef.value.map(String));
    const offlineOnPage = tableData.value.filter(r => selected.has(rowKey(r)) && !r.online).length;

    // ⚠️ 这里以前写的是 `tableData.filter(r => !r.online).length` —— **那是"本页有多少离线行"，
    // 不是"选中的里面有多少条离线"**，跨页选中时会报一个和删除范围无关的数字（自己 review 时抓到的）。
    // 选中的记录如果不在本页，它此刻在不在线**这里查不到** ⇒ 那种情况就不报数字，只把风险说清楚，
    // 而不是给一个看起来精确、其实错的数。
    const offlineClause = off === 0
        ? (offlineOnPage ? `其中 ${offlineOnPage} 条在没插的盘上 —— 删了就看不到了，除非把盘插回来重扫。` : '')
        : `如果有记录属于没插的那块盘，删了就看不到了，除非把盘插回来重扫。`;

    dialog.warning({
        title: `删除 ${n} 条记录？`,
        content: `只删掉这 ${n} 条**记录**，硬盘上的文件一个都不动。`
            + `删掉后，下次打开这些目录会重新读一遍硬盘（要碰移动硬盘）。`
            + offlineClause
            + (off ? `（另有 ${off} 条选中的记录不在当前页。）` : ''),
        positiveText: '删除记录',
        negativeText: '取消',
        maskClosable: false,
        onPositiveClick() {
            onRemove()
        }
    })
}

const onRemove = async () => {
    loading.value = true;

    try {
        const ids = toRaw(checkedRowKeysRef.value)
        // POST + JSON body（原来是 DELETE + 查询串 —— 拿 DELETE 做"带参数查询"是语义错位）。
        // 服务端接口和这里同步改了，见 removeHistoryBatch 的注释。
        await postAction(API_BASE + '/removeHistoryBatch', { ids })
        notify('success', '成功', `删除成功`)
        setTimeout(() => {
            handleCheck([])
            // 删除只改了数据、没改"插着哪些盘" ⇒ 走 reloadAfterDataChange（不重探盘符）
            reloadAfterDataChange()
        }, 500)
    } catch (err) {
        notify('error', '错误', `删除失败:${err}`)
    }

    loading.value = false;
}

// ⚠️ 这里原来还有一个「备份」按钮（`handleDriveBackup` / `onDriveBackup` → DELETE `/backup`）：
// 它把库默默复制成 `searchCache-YYYYMMDD.db` 放进**用户看不见的数据目录**，
// 而且**按天同名覆盖** —— 同一天备份第二次会把第一次盖掉。
// 它给的是"我以为备份了"的**假安全感**，而这正是备份功能最坏的失败模式
// （真出事时你以为有得退，其实那份早被后来的自己盖掉了）。
// 它的能力被「备份到文件…」完整覆盖且更可靠（位置自己挑、不会被覆盖），所以**按钮收掉**。
// `/backup` 接口**保留不删**（零成本，将来做"退出时自动快照"可以直接复用）。
// 见 docs/DESIGN-BACKUP-2026-09-24.md §7.8 —— 那里本来就挂着"是否收掉，等你一句话"。

const onHide = () => {
    checkedRowKeysRef.value = []
}

/**
 * 打开缓存数据目录 —— 手工处理文件时的入口（应用内的三个动作已经覆盖常态）。
 *
 * 走 IPC 而不是本地服务：`shell.openPath` 只有主进程能做，而 `openFile` 已经在用
 * 同一条通道（同 `shell.openPath`、同"成功空串/失败描述"的返回约定），不新增机制。
 * 失败必须说出来 —— 静默失败正是当初 `双击没反应` 藏那么久的原因。
 */
const openDataDir = async () => {
    const err = await ipcRenderer.invoke('openDataDir');
    if (err) notify('error', '打开失败', err);
}

/** 主进程两个「选路径」通道的返回约定（见 electron/main/index.ts） */
type PickResult = { canceled: boolean; filePath: string };

/**
 * 选一个文件路径。**取消一律走同一条出口**（空串）——
 * 三个动作各自的"用户改主意了"都靠它，不用每个调用方各判一次 `canceled`。
 */
const pickPath = async (channel: 'pickCacheSavePath' | 'pickCacheOpenPath') => {
    const res = await ipcRenderer.invoke(channel) as PickResult;
    return res?.canceled ? '' : (res?.filePath || '');
}

/**
 * 「备份到文件…」—— 复制在服务端做，这里只挑路径 + 报结果。
 *
 * 为什么复制不放这里：主进程碰不到 nedb 那个模块的状态，硬在这儿复制
 * 等于把"库在哪"再抄一份出来。分工与 `openDirectory` 一致：**需要系统能力的
 * 那一步进主进程，数据本身的操作留服务端**。
 */
const handleBackupToFile = async () => {
    const file = await pickPath('pickCacheSavePath');
    if (!file) return;

    try {
        await postAction(API_BASE + '/backupToFile', { path: file });
        notify('success', '成功', `已备份到 ${file}`)
    } catch (err) {
        notify('error', '错误', `备份失败：${err}`)
    }
}

/**
 * 「从文件还原…」—— **整份顶掉**当前缓存，和「合并」是两件事。
 * （合并只增不删，所以它不弹确认；这一条是唯一会让记录消失的，必须问。）
 *
 * ⚠️ 文案的语气在这一版改了 —— 这是整份方案里最该改的一处：
 * 原来写的是"现在这些记录会不见"，那是**数据安全**的语言，会让人以为要丢东西。
 * 但缓存是**可重建的派生物**：丢了重扫一遍就回来了（苏格拉底那一问："缓存丢了会怎样？"）。
 * 所以真正的代价不是"丢数据"，是**你花在读移动硬盘上的时间**。
 * 把代价说成"要重新读多少"，用户才能判断"值不值得点"，
 * 也才和他最在意的最高优先级（减少对移动硬盘的读写）接得上。
 */
const handleRestoreFromFile = () => {
    dialog.warning({
        title: '从文件还原',
        content: '会用你选中的文件整体替换当前缓存。替换后，本机独有的记录要重新读一遍移动硬盘才能回来。'
            + '还原前会自动留一份快照（数据目录的 searchCache-before-restore.db），还原后立即生效，不用重启。',
        positiveText: '选择文件并还原',
        negativeText: '取消',
        maskClosable: false,
        // 返回 Promise 让 naive-ui 把按钮切成 loading 状态 ——
        // 还原要复制一份十几 MB 的库再整库重读，一两秒是常态，
        // 不返回的话按钮点完就像没反应，用户会再点一次
        onPositiveClick() {
            return onRestoreFromFile()
        }
    })
}

const onRestoreFromFile = async () => {
    const file = await pickPath('pickCacheOpenPath');
    if (!file) return;

    loading.value = true;
    let ok = false;
    try {
        await postAction(API_BASE + '/restoreFromFile', { path: file });
        ok = true;
    } catch (err) {
        // 服务端在还原失败时已经尽力回滚过了，错误文案里会写明"已回滚"还是"回滚也失败"
        notify('error', '还原失败', `${err}`)
    } finally {
        loading.value = false;
    }

    if (!ok) return;
    notify('success', '成功', '已还原')
    // 放在 loading 复位之后：取数里有 `loading` 相关的时序，提前调用界面会像"还原了但列表没变"。
    // 还原换的是库内容，没换"插着哪些盘" ⇒ 不重探盘符。
    reloadAfterDataChange();
}

/**
 * 「合并缓存…」—— 两边都留，按主键并起来。
 * 不做二次确认：它只增不删（同主键冲突时取 `create_at` 新的），没有可撤销性可言。
 */
const handleMergeCache = async () => {
    const file = await pickPath('pickCacheOpenPath');
    if (!file) return;

    loading.value = true;
    let result: { added: number; replaced: number; skipped: number } | null = null;
    try {
        result = await postAction(API_BASE + '/mergeCache', { path: file });
    } catch (err) {
        notify('error', '合并失败', `${err}`)
    } finally {
        loading.value = false;
    }

    if (!result) return;
    notify('success', '合并完成',
        `新增 ${result.added} 条、覆盖 ${result.replaced} 条、跳过 ${result.skipped} 条`)
    reloadAfterDataChange();
}

// 每次打开都刷新。原来是"只在第一次打开时查一次"（isFirstRender 守卫），
// 结果第二次打开看到的是上一次的旧列表。
// 顺带把 watch 从 onMounted 里挪出来 —— 写在 onMounted 内部注册的 watcher，
// 组件卸载时不会被回收。
//
// ⚠️ 这里故意**不重探盘符**（`loadDisks()` 不带 refresh）：那会让"每次打开"都 stat 一遍 C–Z。
// 想看"现在插着什么"就点「刷新」。
watch(showModal, (val) => {
    if (val) {
        loadDisks();
        getHistrotyList();
        // 键盘路径的第一落点：打开就把光标放进搜索框，直接打字就能筛。
        // 放在 nextTick 之后 —— n-modal 的内容是这一轮才挂上去的，早于它拿不到实例。
        nextTick(() => searchRef.value?.focus());
    }
});

defineExpose({
    setShowModal
})
</script>

<style>
/* 全部规则都挂在 `.cache-panel` 下面 —— 刻意**不用 scoped**：
   表格的 `render` 回调是在 naive-ui DataTable **自己的渲染上下文**里执行的，
   那些节点拿到的是 DataTable 的 scope id，用 `scoped` 选择器**匹配不到它们**
   （`.dir-cell` / `.dir-name` / `.dir-note` 正好全都长在 render 里）。
   靠外层类名前缀做隔离，比 scoped 在这里更可靠、也不会漏到别处。 */
.cache-panel .g1-row {
    display: flex;
    align-items: center;
    gap: 8px;
    width: min(420px, 46vw);
}

/* 搜索框外面那层：为了接输入法的 composition 事件（见模板注释），顺带负责占满剩余宽度 */
.cache-panel .g1-search {
    flex: 1 1 auto;
    display: flex;
    min-width: 0;
}

.cache-panel .g1-search .n-input {
    flex: 1 1 auto;
}

.cache-panel .g2-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding-bottom: 8px;
}

.cache-panel .overview {
    font-size: 12.5px;
    color: #666;
}

.cache-panel .g2-disk {
    padding-bottom: 10px;
}

/* ⚠️ 这一条不能省：n-spin 的根是 `.n-spin-container`，它是卡片内容的直接子节点。
   不把它也变成"会长大的纵向 flex"，里面的 `.n-spin-content`（拿到了 contentStyle 的 flex:1）
   就撑不开 —— 表格就拿不到剩余高度，滚动条又跑回整个弹窗上。
   结构与类名已在 node_modules/naive-ui/es/spin/src/Spin.mjs 里核对过（不是猜的）：
   `.n-spin-container > .n-spin-content > slot`。 */
.cache-panel .n-spin-container {
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
    flex-direction: column;
}

/* 表格这块的滚动交给 DataTable 自己（`:flex-height="true"`），**不是**这里 overflow:auto。
   ⚠️ 这里踩过两次，实测数据在 docs/probes/table-scroll/out.log：
   第一版把 `overflow:auto` 加在这一层 + 给 thead 加 `position:sticky` —— 没用。实测（真 Chromium 布局）：
     卡片 `max-height:86vh` 时，**表格根本没被高度约束**（量到 4235px），
     于是这一层变成了"整张表"的滚动容器，滚到底表头跑到了表格顶部之外 3562px（表头照样滚走）。
   第二版（现在）：① 卡片给**确定高度** `height:86vh` —— 只有确定高度，下面的 `flex:1` 才有"剩余空间"可分，
     `max-height` 只是封顶、容器仍是内容高度；② 这一层只做 `display:flex`，把高度让给 DataTable；
     ③ `flex-height` 让 DataTable 把表头渲染成独立的一块，滚动只发生在它自己的 body 里。
   实测结果：表格高 672（被约束住）、滚的是 DataTable 的 body、滚到底**表头仍在可视区内**。 */
.cache-panel .table-wrap {
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
}

.cache-panel .table-wrap > .n-data-table {
    flex: 1 1 auto;
    min-height: 0;
}

/* 目录 = 双击打开的入口。**保持蓝色**（用户要求"和之前一样"）——
   它本来就是一个链接的样子，而链接的外观本身就是可发现性，
   不需要再挂一句"双击打开"当解释（那句已被用户判为多余，去掉了）。 */
.cache-panel .dir-cell {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
}

.cache-panel .dir-name {
    cursor: pointer;
    color: #2080f0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.cache-panel .dir-name:hover {
    color: #4098fc;
}

/* count = 0 的记录：这不是错误，是"需要你去确认一下"，所以用琥珀色而不是危险色。 */
.cache-panel .dir-note {
    flex-shrink: 0;
    font-size: 11.5px;
    color: #a06a00;
    background: #fdf3e2;
    padding: 0 6px;
    border-radius: 3px;
}

/* 空态：保持"一行浅灰小字"，和主界面 emptyTip 一致（不加图标、不加按钮）。 */
.cache-panel .empty-tip {
    padding: 18px 4px;
    font-size: 12.5px;
    color: #999;
}

.cache-panel .empty-sub {
    margin-top: 4px;
    font-size: 12px;
    color: #b5b5bd;
}

.cache-panel .migrate-collapse {
    border-top: 1px solid #efeff5;
    margin-top: 6px;
}

.cache-panel .mi-row {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
    padding: 5px 0;
}

.cache-panel .mi-hint {
    font-size: 12px;
    color: #999;
}

.cache-panel .mi-hint.warn {
    color: #a06a00;
}

/* 底部：批量区**高度恒定**（没选中时按钮置灰、位置不动，不用 v-if 让它顶掉布局） */
.cache-panel .foot-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
}

.cache-panel .foot-left {
    display: flex;
    align-items: center;
    gap: 8px;
}

.cache-panel .sel-hint {
    font-size: 12.5px;
    color: #999;
}
</style>
