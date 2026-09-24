<template>
    <n-modal v-model:show="showModal" :on-after-leave="onHide">
        <n-card style="width: 900px; margin-top: 10px" title="缓存记录" :bordered="false" size="huge" role="dialog"
            aria-modal="true">
            <template #header-extra>
                <n-space align="center">
                    <n-select v-model:value="model.serial" :options="diskOptions" :loading="diskLoading"
                        style="width: 320px" size="small" :on-update:value="onSearch" />
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

                <n-data-table :columns="columns" :data="tableData"
                    :row-key="(row: RowData) => row._id || row.serial + '/' + row.relPath"
                    @update:checked-row-keys="handleCheck" />
            </n-spin>

            <template #footer>
                <div style="display: flex;justify-content: flex-end;">
                    <n-pagination size="small" v-model:page="model.pageNo" v-model:page-size="model.pageSize"
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
import useNotify from '@/hooks/useNotify';
import {
    NInput, NButton, NCard, NModal, NPagination, NDataTable, NSpin, NSelect, NSpace, NAlert, NTag, useDialog,
} from 'naive-ui'
import type { DataTableColumns, DataTableRowKey } from 'naive-ui'
import type { BrowseHistoryWithPagination, OpenMode } from 'electron/server/nedb';
import { deletAction, getAction } from '@/utils/request';

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
        const letter = row.path ? row.path.slice(0, 2) : '??';
        return h('div', { style: 'display:flex;align-items:center;gap:6px;min-width:0' }, [
            h(NTag, { size: 'small', bordered: false, type: offline ? 'default' : 'success' },
                { default: () => letter }),
            h(NButton,
                {
                    size: 'small',
                    type: 'info',
                    quaternary: true,
                    disabled: offline,
                    ondblclick: () => openDir(row),
                },
                { default: () => row.relPath || '/' }),
            offline
                ? h('span', { style: 'color:#999;font-size:12px;flex-shrink:0' }, '（盘未插入）')
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

const openDir = (item: RowData) => {
    const target = item.path;
    if (!item.online || !target) {
        notify('warning', '盘未插入', `这块盘（序列号 ${item.serial}）现在不在。插上之后重新打开这个面板即可。`)
        return;
    }
    setShowModal(false);
    setTimeout(() => {
        emits('openDir', target, item.mode || 'cover');
    }, 300)
}

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
