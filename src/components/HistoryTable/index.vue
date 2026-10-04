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
                <!-- 总览句**独占一行**（用户要求）。
                     它是面板里最长的一句，和任何东西挤在一行都会被压到换行 —— 小窗口下尤其明显
                     （实测：和按钮同行时 681px 窗口下文本高 40px = 两行）。给它整行就不会再折。 -->
                <div class="g2-row">
                    <!-- 总览句：盘数 / 目录数 / 条目数 / 已读到多少 / 库大小 / 最近扫描。
                         全部来自 /getDisks 的 stats —— **服务端在内存里汇总**，一次盘都不读。
                         「已读到」这个措辞是刻意的：它是缓存里记录到的字节之和（扫描快照），
                         不是"硬盘上有多少"。 -->
                    <span class="overview">{{ overview }}</span>
                </div>

                <!-- 选盘 = 这套缓存的分组维度：先说清"这些缓存属于哪块盘"，再列那块盘缓存过哪些目录。
                     盘符只是当前挂载点，真正的身份是卷序列号。
                     2026-10-04 重设计：**下拉 → 盘条 chips**（见 docs/DESIGN-DISK-FILTER-2026-10-04.md）。
                     原下拉每行写「H: · 43 个目录 / 214 个条目」，盘一多就是一堵字墙；
                     而"条目数"根本不是选盘时的判据。现在一行 chip 扫完、一下点完，
                     完整明细（状态 / 标识 / 目录 / 条目 / 最近扫描）挪进悬浮提示，需要时才出现。 -->
                <div class="g2-disk">
                    <div class="disk-chips" role="group" aria-label="按盘筛选缓存记录">
                        <n-tooltip v-for="chip in diskChips" :key="chip.key" trigger="hover" placement="top"
                            :delay="180">
                            <template #trigger>
                                <!-- 用真实 <button> 而不是 n-tag / span：chip 是"可点选"的控件，
                                     必须是键盘可达的按钮（Tab 到、Enter/Space 触发），
                                     选中态用 aria-pressed 报给读屏。 -->
                                <button type="button" class="disk-chip"
                                    :class="{ 'is-active': model.serial === chip.value }"
                                    :aria-pressed="model.serial === chip.value" :aria-label="chip.ariaLabel"
                                    @click="handleSerialChange(chip.value)">
                                    <span v-if="chip.tipDot" class="disk-dot"
                                        :class="chip.tipDot === 'on' ? 'is-on' : 'is-off'"></span>
                                    <span class="disk-chip-name">{{ chip.name }}</span>
                                    <span v-if="chip.count !== undefined" class="disk-chip-count">{{ chip.count }}</span>
                                </button>
                            </template>
                            <div class="disk-chip-tip">
                                <div class="tip-head">
                                    <span v-if="chip.tipDot" class="disk-dot"
                                        :class="chip.tipDot === 'on' ? 'is-on' : 'is-off'"></span>
                                    {{ chip.tipTitle }}
                                </div>
                                <div class="tip-row" v-for="r in chip.tipRows" :key="r.k">
                                    <span class="tip-k">{{ r.k }}</span><span class="tip-v">{{ r.v }}</span>
                                </div>
                            </div>
                        </n-tooltip>
                    </div>
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
                                    {{ model.serial ? '点上面的「全部」看其它盘' : '在主界面选个文件夹，点「补全这一片」' }}
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
                        <n-button size="small" :loading="backupLoading" @click="handleBackupToFile">备份到一个文件…</n-button>
                        <span class="mi-hint">默认文件名带你今天的日期，位置自己挑 —— 不会被任何东西覆盖</span>
                    </div>
                    <div class="mi-row">
                        <!-- 唯一着色的一条：这一组里只有它是"整份替换"（合并只增不删）。 -->
                        <n-button size="small" type="error" @click="handleRestoreFromFile">从文件还原…</n-button>
                        <span class="mi-hint warn">整份替换当前缓存</span>
                    </div>
                    <div class="mi-row">
                        <n-button size="small" :loading="bulkLoading" @click="handleMergeCache">合并缓存…</n-button>
                        <span class="mi-hint">只增不删（新增 / 覆盖 / 跳过 会报给你）</span>
                    </div>
                    <!-- 「打开存放文件夹」从顶部挪到这儿（2026-10-04，用户提的）。
                         原来把它留在折叠区外面，理由是"它不碰任何数据，别藏起来"——那个理由站不住：
                         这个折叠区本来就不是纯危险区（备份是安全的、合并只增不删），
                         真正危险的只有「从文件还原」，而它是靠**自己那身红色**标出来的，不是靠分组。
                         而且它和上面三项本就是同一件事的两面：那三项是**自动**搬运整库，
                         这一项是**手动**搬运的入口（缓存库、图片、备份都躺在那个文件夹里）。
                         顺带解决一个更实在的：它原来压在盘条右侧，占掉约 110px ——
                         而盘条正是"盘越多越需要横向空间"的那一行。
                         ⚠️ 代价与补偿：位置原本承担着"这是安全出口"的信号，现在这信号改由 hint 明说。
                         见 docs/DESIGN-DISK-FILTER-2026-10-04.md §11。 -->
                    <div class="mi-row">
                        <n-button size="small" @click="openDataDir">打开存放文件夹</n-button>
                        <span class="mi-hint">只打开文件夹、不动任何数据（缓存库、图片和备份都在这儿）</span>
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
                            :loading="bulkLoading" @click="handleRemove">删除记录</n-button>
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
                        :page-sizes="[10, 16, 20, 30, 40, 60, 80, 100]" :on-update:page="handlePageChange"
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
    NInput, NButton, NCard, NModal, NPagination, NDataTable, NSpin, NTooltip, NAlert, NTag, NIcon,
    NCollapse, NCollapseItem, useDialog,
} from 'naive-ui'
import type { DataTableColumns, DataTableRowKey, DataTableSortState, InputInst } from 'naive-ui'
import { formatBytes, serialTail } from '@/utils';
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
    /**
     * 图片（bin/）的张数与占用。2026-10-04 起**图片才是缓存的大头**（库瘦了 200 倍），
     * 只报库的大小会让人严重低估实际占用 ⇒ 必须和「库 X」并列显示。
     */
    binCount?: number;
    binBytes?: number;
    lastScanAt: string;
};

/**
 * 盘条 chips 的一枚（2026-10-04 重设计，见 docs/DESIGN-DISK-FILTER-2026-10-04.md）。
 *
 * 为什么整成"预计算好的展示模型"而不是在模板里边取边拼：
 * chip 面上只留三样东西（状态点 / 名字 / 目录数），**其余明细全在悬浮提示里**。
 * 把"面上"和"提示里"两类内容一次性算好，模板就只剩渲染 —— 盘一多也不会在模板里堆条件。
 */
type DiskChip = {
    /** 传给 `model.serial` 的值；空串 = 「全部」 */
    value: string;
    /**
     * `v-for` 的 key。**不能直接用 `value`**：克隆盘的卷序列号是同一个
     * （整盘 Ghost 会连序列号一起复制，服务端 `findDuplicatedSerials` 专门检测这种），
     * 于是两枚 chip 的 `value` 相同 —— 用 `value` 当 key 会撞 key（Vue 复用错乱 + 控制台告警）。
     * 盘符才是它们之间唯一不同的东西，所以 key 用 `序列号|盘符`。
     */
    key: string;
    /** 名字位：在线 = 盘符（`H:`），离线 = 序列号后 4 位，全部 = `全部` */
    name: string;
    /** 目录数（= 该盘缓存过的目录条数）。`undefined` = 首次加载还没拿到，此时不显示数字 */
    count?: number;
    /** 提示里的标题；`tipDot` 有值才画出那枚状态点（「全部」没有点） */
    tipTitle: string;
    tipDot?: 'on' | 'off';
    /** 提示里的明细行（状态 / 目录 / 条目 / 最近扫描） */
    tipRows: { k: string; v: string }[];
    /** 读屏用的一句话 —— chip 面上的文字对读屏只是「全部 216」，不足以说明它是个什么控件 */
    ariaLabel: string;
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
    // 图片单列而不是并进「库」那一句：两者是完全不同的两样东西（一个可再生、一个是耗时扫出来的），
    // 混成一句会让人以为"把库文件拷走就等于拷走了缓存"（那就错了，图片在 bin/ 里）。
    if (typeof s.binCount === 'number') {
        parts.push(`图片 ${s.binCount} 张 · ${formatBytes(s.binBytes ?? 0)}`);
    }
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
    // 每页 30 条（用户 2026-10-04 调，原 16）。
    // 为什么跟着改：行高先收到了 `2px 12px`（见 style 块），一屏能放下比原来多约七成的行 ——
    // 页还是 16 的话反而要不停翻页，等于白省下的高度不用。
    // ⚠️ `page-sizes`（模板里的分页器）必须有 30，否则"每页条数"下拉表示不出当前这个值。
    pageSize: 30,
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
/** 备份进行中。不复用 `loading`（那个罩表格，而备份不动列表）。见模板上的对照表。 */
const backupLoading = ref(false);
/** 删记录 + 合并缓存共用：两者都改整库，本就不许并发。不复用 `loading`（那个翻页也会置位）。 */
const bulkLoading = ref(false);
/**
 * `/getDisks` 回来的原始盘列表（盘条 chips 的数据源）。
 *
 * 只存**原始行**，chip 的展示模型（名字怎么取、提示里放什么）全在 `diskChips` 里算 ——
 * 这样"服务端给什么"和"界面怎么讲"是两件事，将来服务端加字段（比如卷标）不用回来改这里。
 */
const diskList = ref<DiskRow[]>([]);
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
        // 只存原始行；"怎么讲给用户听"交给 diskChips 算（见那里），这里不再拼文案。
        diskList.value = data.disks || [];
        duplicated.value = data.duplicated || [];
        stats.value = data.stats || null;
    } catch (err) {
        notify('error', '错误', `获取磁盘列表失败！${err}`)
    } finally {
        diskLoading.value = false;
    }
}

/**
 * 盘条 chips 的展示模型（**唯一的拼装点**）。
 *
 * 顺序：`全部` → 在线盘（按盘符）→ 离线盘（按序列号）。
 * 为什么在线在前：在线盘才是"能真的点开"的那批，离线盘主要用于查缓存；
 * 而两者在视觉上只差一个点的颜色，靠排序把同类聚在一起，扫视最省力。
 *
 * ⚠️ chip 名字位的取法（**不是猜的**，见 DESIGN-DISK-FILTER §3.4）：
 * 盘符只在"盘插着"时存在（`d.drive` 离线时是空串，见 `electron/server/index.ts:1031`），
 * 注册表（`DiskRecord`）也只存 label/firstSeenAt/lastSeenAt、**不存盘符** ——
 * 所以离线盘的唯一身份是序列号后 4 位；不靠它，两块离线盘就分不清谁是谁。
 */
const diskChips = computed<DiskChip[]>(() => {
    const s = stats.value;

    // 只留**有缓存**的盘（`folders > 0`）：这个面板讲的就是缓存，
    // C: 这种从没收录过的卷混进来，只会多一枚"点了什么都没有"的 chip（用户 2026-10-04 提的）。
    // ⚠️ 例外：**当前选中的那枚永远留着**。否则走到"选中某块盘 → 把它的记录全删了"这一步，
    // 过滤条件还在、chip 却没了 —— 界面会变成"没有任何 chip 选中、表格却是空的"，无法解释。
    const list = [...diskList.value]
        .filter(d => d.folders > 0 || d.serial === model.value.serial)
        .sort((a, b) => {
            if (a.online !== b.online) return a.online ? -1 : 1;
            const ka = a.online ? a.drive : a.serial;
            const kb = b.online ? b.drive : b.serial;
            return String(ka).localeCompare(String(kb));
        });

    // 「全部」：数字取服务端 stats —— 与各盘是**同一套口径**（服务端也是把各盘 folders 累加），
    // 所以「全部」的数正好等于各盘数字之和，不会出现"两处对不上"。
    const all: DiskChip = {
        value: '',
        key: '__all__',
        name: '全部',
        // stats 还没回来时给 undefined ⇒ chip 上不渲染数字，避免先闪一下「全部 · 0」。
        count: s?.folders,
        tipTitle: '全部盘',
        tipRows: [
            { k: '盘数', v: `${s?.disks ?? list.length}` },
            { k: '目录', v: `${s?.folders ?? 0}` },
            { k: '条目', v: `${s?.entries ?? 0}` },
            ...(s?.lastScanAt ? [{ k: '最近扫描', v: fmtScanTime(s.lastScanAt) }] : []),
        ],
        ariaLabel: '显示全部盘的缓存记录',
    };

    const disks: DiskChip[] = list.map(d => {
        const letter = d.online && d.drive ? `${d.drive}:` : '';
        // 离线盘的名字位用序列号后 4 位；工具提示里给**完整**序列号，核对时能看全。
        const ident = letter || `序列号 ${d.serial}`;
        return {
            value: d.serial,
            // 克隆盘会有两条同 serial 的记录（盘符不同），所以 key 必须带上盘符。
            key: `${d.serial}|${d.drive || ''}`,
            name: letter || serialTail(d.serial),
            count: d.folders,
            tipTitle: ident,
            tipDot: d.online ? 'on' : 'off',
            tipRows: [
                // 「离线」这两个字的正式解释只出现在这里（用户 2026-10-04 明确：chip 上不写，
                // 靠点的颜色就够了，别拿文字占版面）。
                { k: '状态', v: d.online ? '在线' : '未插入（看的是缓存）' },
                { k: '目录', v: `${d.folders}` },
                // `covers` 是历史包袱名：它是**条目数**（服务端把每条记录的 count 累加，index.ts:996）。
                { k: '条目', v: `${d.covers}` },
                ...(d.lastScanAt ? [{ k: '最近扫描', v: fmtScanTime(d.lastScanAt) }] : []),
            ],
            ariaLabel: `${ident} 的缓存记录${d.online ? '' : '（这块盘未插入）'}`,
        };
    });

    return [all, ...disks];
});

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
 * 选盘 / 取消选盘 —— 点 chip 的**唯一入口**。
 *
 * 语义：点一块盘 → 只看那块盘；**再点一次已选中的 chip → 取消过滤、回到「全部」**。
 * 为什么要这个来回：单选过滤器里"怎么回到全部"如果只能点首项，用户就得先去扫「全部」在哪；
 * 让"选中项自己就能取消"是 chip 的通用手感（Material 的 filter chip 也是这么做的）。
 * 而「全部」chip 依然保留 —— 它让"此刻没有过滤"是**看得见**的，而不是靠"没有高亮项"去猜。
 *
 * ⚠️ 沿用一条老教训：**一个 update 事件只挂一个 handler**。
 * 赋值和后续动作必须写在同一个函数里 —— 当年 `v-model` 与 `:on-update` 争同一个 prop、
 * 后写的把前写的整个顶掉，症状是"点了没反应"（见 docs/FIX-2026-09-24-naive-ui-update-prop.md）。
 */
const handleSerialChange = (serial: string) => {
    model.value.serial = model.value.serial === serial ? '' : serial;
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
/**
 * 盘列表变了（主进程热插拔事件推来的）—— **只在面板开着时**重新取数。
 *
 * 走 `reloadAfterDataChange`（**不重探盘符**）：服务端那份盘列表缓存**刚被主进程
 * `getDrives(true)` 刷过**（见 `electron/main/diskWatch.ts`），这里只要重新读一遍就够。
 * 再带 `?refresh=true` 等于拿 26 次 `stat` 去换一次刚做过的事。
 *
 * 关着就不打扰 —— 顺带省掉一次没人看的请求。
 */
const refreshIfOpen = () => {
    if (!showModal.value) return;
    reloadAfterDataChange();
}

const emptyText = computed(() => {
    if (loading.value || tableData.value.length) return '';
    if (model.value.path) return `没有匹配「${model.value.path}」的目录`;
    // 选了某块盘却一条都没有（例：把那块盘的记录删光了）。
    // 不能笼统说"还没读过任何目录" —— 别的盘的记录还在时，那句话是错的。
    if (model.value.serial) return '这块盘还没有缓存记录';
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
    bulkLoading.value = true;

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
    } finally {
        // `finally` 而非裸语句：这里原来是裸的，flag 停在 true 就再也点不动了
        loading.value = false;
        bulkLoading.value = false;
    }
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
 * 「备份到一个文件…」—— 打包在服务端做，这里只挑路径 + 报结果。
 * 2026-10-04 起导出的是**一个 zip 包**（库 + 图片），资源管理器双击就能打开看里面有什么。
 *
 * 为什么复制不放这里：主进程碰不到 nedb 那个模块的状态，硬在这儿复制
 * 等于把"库在哪"再抄一份出来。分工与 `openDirectory` 一致：**需要系统能力的
 * 那一步进主进程，数据本身的操作留服务端**。
 */
const handleBackupToFile = async () => {
    const file = await pickPath('pickCacheSavePath');
    if (!file) return;

    // n-button 的 `loading` 自带禁用 ⇒ 不用另写 `:disabled`，也就不会出现「转着圈还能再点一次」
    backupLoading.value = true;
    try {
        await postAction(API_BASE + '/backupToFile', { path: file });
        notify('success', '成功', `已备份到 ${file}`)
    } catch (err) {
        notify('error', '错误', `备份失败：${err}`)
    } finally {
        backupLoading.value = false;
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
        title: '从文件还原（选那个 .zip 备份包）',
        content: '会用你选中的文件整体替换当前缓存。替换后，本机独有的记录要重新读一遍移动硬盘才能回来。'
            + '还原前会自动留一份快照（数据目录里的 searchCache-before-restore.db），还原后立即生效、不用重启。'
            + '备份包里的图片会**只增不删**地并进来（本地已有的不动）。',
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
    bulkLoading.value = true;
    let result: { added: number; replaced: number; skipped: number } | null = null;
    try {
        result = await postAction(API_BASE + '/mergeCache', { path: file });
    } catch (err) {
        notify('error', '合并失败', `${err}`)
    } finally {
        loading.value = false;
        bulkLoading.value = false;
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
    setShowModal,
    /** 盘插拔后由主界面调用（那条 IPC 见 `electron/main/diskWatch.ts`）—— 只重取数据，不重探盘符 */
    refreshIfOpen
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

/* 总览**独占一行**，不和任何东西争宽度 ⇒ 它不会被迫折行。 */
.cache-panel .g2-row {
    padding-bottom: 8px;
}

.cache-panel .overview {
    display: block;
    font-size: 12.5px;
    color: #666;
}

/* 盘条那一行。
   用**裸 flex**（不用 n-space）：naive-ui 2.45.3 给每个子项写死同一个 key，
   子元素个数一变就会重复 key（先例 docs/FIX-2026-09-24-nspace-duplicate-keys.md）。
   （「打开存放文件夹」2026-10-04 已挪进「备份与迁移」，这一行现在只剩盘条。） */
.cache-panel .g2-disk {
    display: flex;
    align-items: flex-start;
    padding-bottom: 10px;
}

.cache-panel .disk-chips {
    flex: 1 1 auto;
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    min-width: 0;
}

/* 一枚盘条 chip。
   状态 = **圆点颜色**（在线亮绿 / 离线中灰）；名字位 = 盘符（离线用序列号后 4 位）；
   数字 = 该盘的目录数。完整明细在悬浮提示里（见 .disk-chip-tip）。 */
.cache-panel .disk-chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 26px;
    padding: 0 11px;
    font-family: inherit;
    font-size: 12px;
    line-height: 1;
    color: #4a4a46;
    background: #fff;
    border: 1px solid #dcdcd6;
    border-radius: 999px;
    cursor: pointer;
    white-space: nowrap;
    transition: background-color .12s ease, border-color .12s ease, color .12s ease;
}

.cache-panel .disk-chip:hover {
    border-color: #b9b9b2;
    background: #f8f8f6;
}

/* 选中态**只换颜色，不加边框宽度** ——
   悄悄把边框 1px 改成 2px 会让这枚比邻居高 2px、整行跟着错位。 */
.cache-panel .disk-chip.is-active {
    color: #185fa5;
    background: #e6f1fb;
    border-color: #85b7eb;
}

/* 选中态也必须有自己的 hover 反馈。
   `.disk-chip:hover` 与 `.is-active` 的特异性相同，而后者写在后面 ⇒ 选中那枚的 hover
   会被 `.is-active` 顶掉，鼠标压上去**一点反应都没有**。
   偏偏它是唯一一个点下去会「取消过滤」的 chip，最需要让人知道"这里能点"。 */
.cache-panel .disk-chip.is-active:hover {
    background: #d8ebfb;
    border-color: #6aa6e0;
}

.cache-panel .disk-chip:focus-visible {
    outline: 2px solid #2080f0;
    outline-offset: 1px;
}

/* 名字（哪块盘）比数字重一档 —— 主次就在这一处。 */
.cache-panel .disk-chip-name {
    font-weight: 500;
}

/* 数字比名字淡一档：名字（哪块盘）是主信息，数字是辅助。 */
.cache-panel .disk-chip-count {
    color: #a9a9a3;
    font-variant-numeric: tabular-nums;
}

.cache-panel .disk-chip.is-active .disk-chip-count {
    color: #5a92cf;
}

/* 状态点。在线那枚要"亮"到一眼看出设备活着 ——
   亮绿本身就是"设备在线"的通用色；再补一圈 2px 淡绿环（0 模糊，是实心环、不是发光），
   静态就把"在线"讲清楚，不用等动画。 */
.cache-panel .disk-dot {
    flex: 0 0 auto;
    width: 7px;
    height: 7px;
    border-radius: 50%;
}

.cache-panel .disk-dot.is-on {
    background: #22c55e;
    box-shadow: 0 0 0 2px rgba(34, 197, 94, .22);
}

.cache-panel .disk-dot.is-off {
    /* 比在线那枚低一档、但别淡到看不见（#dcdcd6 这种摆在白底上几乎消失）。
       它就是"这块盘现在不在"的全部表达，必须还看得见。 */
    background: #b4b2a9;
}

/* ⚠️ 悬浮提示的内容**不能**加 `.cache-panel` 前缀 ——
   n-tooltip 的弹出层被 teleport 到 body，已经不在卡片内部了，加了前缀一个都命中不了。
   所以下面这几条是全局规则，靠 `disk-chip-tip` 这个专属类名做隔离（不会漏到别处）。
   naive-ui 浅色主题的 tooltip 是**深底白字**，所以这里只调透明度、不写死文字颜色。 */
.disk-chip-tip {
    font-size: 12px;
    line-height: 1.55;
}

.disk-chip-tip .tip-head {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12.5px;
    font-weight: 500;
    margin-bottom: 5px;
}

.disk-chip-tip .disk-dot {
    flex: 0 0 auto;
    width: 7px;
    height: 7px;
    border-radius: 50%;
}

.disk-chip-tip .disk-dot.is-on {
    background: #22c55e;
}

.disk-chip-tip .disk-dot.is-off {
    background: #a8a8a3;
}

.disk-chip-tip .tip-row {
    display: flex;
    gap: 18px;
    justify-content: space-between;
}

/* 键和值都单行：工具提示靠内容自动撑宽（naive-ui 的 popover 不设死宽），
   所以"不换行"只会让它横向长一点，不会把一行拆成两行 —— 而换行会让提示变高、更难扫。 */
.disk-chip-tip .tip-k,
.disk-chip-tip .tip-v {
    white-space: nowrap;
}

.disk-chip-tip .tip-k {
    opacity: .6;
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

/* 表格行高（用户 2026-10-04：`--n-td-padding` 收到 2px，让一屏放得下更多行）。
 *
 * 取 `2px 12px` 而**不是**字面的 `2px` —— 这不是自作主张，是实测出来的：
 * 表头用的是另一个变量 `--n-th-padding`（仍是 12px）。若 td 四周都收成 2px，
 * 左对齐的列（盘 / 目录）**表头文字会比单元格文字右移 10px**。
 * 真 Chromium 实测（同一份内容）：
 *   td 12px → 行高 47px、表头与单元格错位 0px
 *   td 2px  → 行高 27px、错位 −10px
 *   td 2px 12px → 行高 27px、错位 0px   ← 采用
 * 也就是说"垂直 2px"拿满全部行高收益，水平留 12px 才能保住对齐。
 * （要更紧，得连 `--n-th-padding` 一起收，那属于另一个决定，没做。）
 *
 * ⚠️ `!important` 在这里是**必需**的，不是偷懒：
 * naive-ui 的主题变量是**内联**写在表格根节点上的 —— `App.vue` 的 `n-config-provider`
 * 没开 `inline-theme-disabled`，于是 `node_modules/naive-ui/es/data-table/src/DataTable.mjs:439`
 * 把 `--n-td-padding` 等作为 element style 挂到 `.n-data-table` 上，普通 CSS 规则赢不了它。
 * 实测：带 `!important` 算出 2px、不带算出 12px（naive-ui medium 默认值，见 `styles/_common.mjs`）。
 *
 * 变量写在根节点上、td 是继承来的，所以一条就够，不用逐层写。 */
.cache-panel .n-data-table {
    --n-td-padding: 2px 12px !important;
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
    /* 小窗口下"批量区 + 分页器"一行装不下 —— 允许整块换行，
       而不是让两边互相挤压（挤的后果就是分页器把「共 106 项」压成一列竖排的字）。 */
    flex-wrap: wrap;
    gap: 8px 12px;
}

.cache-panel .foot-left {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
    min-width: 0;
}

.cache-panel .sel-hint {
    font-size: 12.5px;
    color: #999;
}

/* 分页器**不许被压缩**：它内部是 `flex-wrap: nowrap`，一被压就把页码和"共 N 项"叠在一起。
   两招一起上：① 容器 `flex: 0 0 auto` —— 装不下时**整块换行**，而不是缩小；
   ② 自身改成 `flex-wrap: wrap` —— 极窄时页码换行，而不是溢出被卡片裁掉（卡片内容是 overflow:hidden）。 */
.cache-panel .foot-row .n-pagination {
    flex: 0 0 auto;
    flex-wrap: wrap;
    row-gap: 4px;
}

/* 「共 N 项」被压成竖排（一个字一行）的根因就是它是 flex 子项、默认允许收缩到内容宽 ——
   必须是整块不折。 */
.cache-panel .foot-row .n-pagination-prefix {
    flex: 0 0 auto;
    white-space: nowrap;
}
</style>
