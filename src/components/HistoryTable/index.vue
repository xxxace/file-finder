<template>
    <n-modal v-model:show="showModal" :on-after-leave="onHide">
        <n-card style="width: 900px; margin-top: 10px" title="缓存记录" :bordered="false" size="huge" role="dialog"
            aria-modal="true">
            <template #header-extra>
                <n-space align="center">
                    <n-select :value="model.serial" :options="diskOptions" :loading="diskLoading"
                        style="width: 320px" size="small" :on-update:value="handleSerialChange" />
                    <n-input v-model:value="model.path" placeholder="路径关键词过滤" clearable size="small"
                        style="width: 170px" @keyup.enter="onSearch" />
                    <n-button size="small" @click="onSearch">查询</n-button>
                    <n-button size="small" @click="onRefresh">刷新</n-button>
                </n-space>
            </template>
            <n-spin :show="loading">
                <template #description>
                    数据加载中...
                </template>

                <n-alert v-if="duplicated.length" type="warning" :show-icon="true" style="margin-bottom: 10px">
                    <template #header>检测到克隆盘</template>
                    有 {{ duplicated.length }} 组移动硬盘的卷序列号完全一样（用 Ghost 之类整盘克隆会这样）。
                    序列号是这套缓存区分硬盘的唯一依据，两者会互相串 —— 建议重新格式化其中一块。
                </n-alert>

                <n-button v-if="checkedRowKeysRef.length > 0" type="error" size="small"
                    style="margin-bottom: 10px;margin-right: 10px;" @click="handleRemove">删除({{ checkedRowKeysRef.length
                    }})</n-button>
                <n-button size="small" style="margin-bottom: 10px;" @click="handleDriveBackup">备份</n-button>
                <!-- 三个新按钮对应三种不同的动作，标签里把"去哪 / 怎么和现有数据相处"都说清楚：
                     「备份到文件…」= 自己挑位置存一份，不会被任何东西覆盖；
                     「从文件还原…」= **整体替换**（本机独有的记录会消失）；
                     「合并缓存…」= 两边都留，按主键并起来（不是替换）。
                     这几个动作都必须能一眼看出区别 —— 混起来用会真的丢数据。 -->
                <n-button size="small" style="margin-bottom: 10px;margin-left: 8px;"
                    @click="handleBackupToFile">备份到文件…</n-button>
                <n-button size="small" style="margin-bottom: 10px;margin-left: 8px;"
                    @click="handleRestoreFromFile">从文件还原…</n-button>
                <n-button size="small" style="margin-bottom: 10px;margin-left: 8px;"
                    @click="handleMergeCache">合并缓存…</n-button>
                <!-- 「打开存放文件夹」保留：它是唯一能自己去翻/手工整理文件的入口，
                     系统文件管理器自带回收站和撤销，比在应用里多做一个"覆盖全库"的按钮安全。
                     理由见 docs/DESIGN-CONVERGED-2026-09-24.md §三。 -->
                <n-button text size="small" style="margin-bottom: 10px;margin-left: 12px;" @click="openDataDir">
                    打开存放文件夹
                </n-button>

                <n-data-table :columns="columns" :data="tableData"
                    :row-key="(row: RowData) => row._id || row.serial + '/' + row.relPath"
                    @update:checked-row-keys="handleCheck" />
            </n-spin>

            <template #footer>
                <div style="display: flex;justify-content: flex-end;">
                    <n-pagination size="small" :page="model.pageNo" :page-size="model.pageSize"
                        :disabled="loading" :item-count="model.total" show-size-picker show-quick-jumper :page-slot="7"
                        :page-sizes="[10, 20, 40, 60, 80, 100]" :on-update:page="handlePageChange"
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
import { h, ref, toRaw, watch } from 'vue';
import { ipcRenderer } from 'electron';
import useNotify from '@/hooks/useNotify';
import {
    NInput, NButton, NCard, NModal, NPagination, NDataTable, NSpin, NSelect, NSpace, NAlert, NTag, useDialog,
} from 'naive-ui'
import type { DataTableColumns, DataTableRowKey } from 'naive-ui'
import type { BrowseHistoryWithPagination, OpenMode } from 'electron/server/nedb';
import { deletAction, getAction, postAction } from '@/utils/request';

// 统一写 127.0.0.1 而不是 localhost，避免个别机器把 localhost 解析到 ::1（服务端只绑 IPv4）
const API_BASE = 'http://127.0.0.1:3060';

type HistoryQuery = {
    serial: string;
    path: string;
    pageNo: number;
    pageSize: number;
    total: number;
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

/** /getHistory 回来的一行：缓存元数据 + 这块盘此刻在不在线 */
type RowData = BrowseHistoryWithPagination['records'][number];

const columns = ref<DataTableColumns<RowData>>([{
    type: 'selection'
}, {
    title: '盘 / 路径',
    key: 'path',
    render(row) {
        const offline = !row.online;
        // 盘符标签只在盘在线时才有意义。离线那行给的是**只读锚点**（`#序列号/路径`），
        // 直接 slice(0,2) 会切出 `#F` 这种东西 —— 那是序列号的头两个字符，不是盘符。
        const letter = row.online && row.path ? row.path.slice(0, 2) : '??';
        return h('div', { style: 'display:flex;align-items:center;gap:6px;min-width:0' }, [
            h(NTag, { size: 'small', bordered: false, type: offline ? 'default' : 'success' },
                { default: () => letter }),
            h(NButton,
                {
                    size: 'small',
                    type: 'info',
                    quaternary: true,
                    // 离线也可以进 —— 走只读锚点看缓存（不碰盘）。见 openDir 的注释。
                    ondblclick: () => openDir(row),
                },
                { default: () => row.relPath || '/' }),
            offline
                ? h('span', { style: 'color:#999;font-size:12px;flex-shrink:0' }, '（盘未插入 · 只读）')
                : null,
        ]);
    }
}, {
    title: '封面',
    key: 'count',
    width: 80,
}, {
    title: '日期',
    key: 'create_at',
    width: 170,
}])

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
    pageSize: 10,
    total: 0
})
const showModal = ref(false);
const loading = ref(false);
const diskLoading = ref(false);
const diskOptions = ref<{ label: string; value: string }[]>([{ label: '全部盘', value: '' }]);
const duplicated = ref<string[]>([]);

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
    const where = d.online ? `${d.drive}:` : '未插入';
    const name = d.label ? ` ${d.label}` : '';
    return `${where}${name} · ${d.folders} 个目录 / ${d.covers} 张封面`;
}

/**
 * 拉一次盘列表。
 *
 * 这是这套缓存的分组维度：先说清楚"这些缓存属于哪块盘"，再去列那块盘缓存过哪些目录。
 * 盘符只是当前挂载点，所以列表里显示的是盘符和卷标，真正的身份是序列号。
 */
const loadDisks = async () => {
    diskLoading.value = true;
    try {
        // 走 getAction 而不是裸 fetch：响应检查只在 request.ts 里做一次就够了。
        // 原来这里是 `fetch(...).then(res => res.json())`，不判 res.ok 也不判 body 里的 code，
        // 于是 `{code:500}` 会被当成正常数据一路用下去。
        const data = await getAction(`${API_BASE}/getDisks`);
        const disks: DiskRow[] = data.disks || [];
        diskOptions.value = [
            { label: `全部盘 · ${disks.reduce((n, d) => n + d.folders, 0)} 个目录`, value: '' },
            ...disks.map(d => ({ label: diskLabel(d), value: d.serial })),
        ];
        duplicated.value = data.duplicated || [];
    } catch (err) {
        notify('error', '错误', `获取磁盘列表失败！${err}`)
    } finally {
        diskLoading.value = false;
    }
}

const getHistrotyList = () => {
    if (loading.value) return
    loading.value = true;
    // 同上：走统一出口。这里尤其要紧 —— 服务端出错时返回的是 **HTTP 200 + {code:500}**，
    // 裸 fetch 时 promise 是 resolve 的，进不了 catch，于是没有提示、还把 undefined 写进了表格
    getAction(`${API_BASE}/getHistory${toQueryStr(model.value)}`).then(async (data: BrowseHistoryWithPagination) => {
        tableData.value = data.records
        model.value.total = data.total
    }).catch(err => {
        notify('error', '错误', `获取历史数据列表错误！${err}`)
    }).finally(() => {
        loading.value = false;
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
    if (loading.value) return
    model.value.pageNo = 1;
    getHistrotyList();
}

const onRefresh = () => {
    if (loading.value) return
    loadDisks();
    getHistrotyList();
}

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
    getHistrotyList();
}

const checkedRowKeysRef = ref<DataTableRowKey[]>([])
const handleCheck = (rowKeys: DataTableRowKey[]) => {
    checkedRowKeysRef.value = rowKeys

}

const handleRemove = async () => {
    dialog.info({
        title: '删除',
        content: '你确定要删除选中数据吗？',
        positiveText: '确定',
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
        await deletAction(API_BASE + '/removeHistoryBatch?ids=' + ids.join(','))
        notify('success', '成功', `删除成功`)
        setTimeout(() => {
            handleCheck([])
            onRefresh()
        }, 500)
    } catch (err) {
        notify('error', '错误', `删除失败:${err}`)
    }

    loading.value = false;
}
const handleDriveBackup = async () => {
    dialog.info({
        title: '备份',
        content: '你确定要备份吗？',
        positiveText: '确定',
        negativeText: '取消',
        maskClosable: false,
        onPositiveClick() {
            onDriveBackup()
        }
    })
}

const onDriveBackup = async () => {
    loading.value = true;

    try {
        await deletAction(API_BASE + '/backup')
        notify('success', '成功', `备份成功`)
    } catch (err) {
        notify('error', '错误', `备份失败:${err}`)
    }

    loading.value = false;
}

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
 *
 * 必须先弹确认：这是这一组动作里唯一"会让记录消失"的操作。
 * 文案要把三件事说清楚 —— 会覆盖、会先留快照、不用重启。
 */
const handleRestoreFromFile = () => {
    dialog.warning({
        title: '从文件还原',
        content: '会用你选中的文件整体覆盖当前缓存，现在这些记录会不见（还原前会自动留一份快照，放在数据目录的 searchCache-before-restore.db）。还原后立即生效，不用重启。确定继续吗？',
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
    // 必须放在 loading 复位之后：onRefresh 里有 `if (loading.value) return` 的守卫，
    // 提前调用会被它自己挡掉，界面看起来就是"还原了但列表没变"
    onRefresh();
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
    onRefresh();
}

// 每次打开都刷新。原来是"只在第一次打开时查一次"（isFirstRender 守卫），
// 结果第二次打开看到的是上一次的旧列表。
// 顺带把 watch 从 onMounted 里挪出来 —— 写在 onMounted 内部注册的 watcher，
// 组件卸载时不会被回收
watch(showModal, (val) => {
    if (val) {
        loadDisks();
        getHistrotyList();
    }
});

defineExpose({
    setShowModal
})
</script>
