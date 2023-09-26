<template>
    <n-modal v-model:show="showModal">
        <n-card style="width: 800px; margin-top: 100px" title="历史记录" :bordered="false" size="huge" role="dialog"
            aria-modal="true">
            <template #header-extra>
                <n-form inline ref="formRef" :model="model" label-placement="left" label-width="auto"
                    require-mark-placement="right-hanging" size="small" :disabled="loading">
                    <n-form-item path="path">
                        <n-input v-model:value="model.path" placeholder="输入路径过滤" clearable />
                    </n-form-item>
                    <n-form-item>
                        <n-button size="small" @click="onSearch">查询</n-button>
                    </n-form-item>
                    <n-form-item>
                        <n-button size="small" @click="onRefresh">刷新</n-button>
                    </n-form-item>
                </n-form>
            </template>
            <n-spin :show="loading">
                <template #description>
                    数据加载中...
                </template>
                <n-button v-if="checkedRowKeysRef.length > 0" type="error" size="small"
                    style="margin-bottom: 10px;margin-right: 10px;" @click="handleRemove">删除({{ checkedRowKeysRef.length
                    }})</n-button>
                <n-button size="small" style="margin-bottom: 10px;" @click="handleDriveChangerShow">盘符变更</n-button>
                <!-- <n-table :single-line="false" size="small">
                    <thead>
                        <tr>
                            <th>路径</th>
                            <th>创建日期</th>
                        </tr>
                    </thead>
                    <tbody>
                        <template v-for="(item) in historyList" :key="item.path">
                            <tr>
                                <td>
                                    <n-button quaternary type="info" @dblclick="openDir(item)">
                                        {{ item.path }}
                                    </n-button>
                                </td>
                                <td>{{ item.create_at }}</td>
                            </tr>
                        </template>
                    </tbody>
                </n-table> -->
                <n-data-table :columns="columns" :data="tableData" :row-key="(row: RowData) => row._id"
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
    <drive-changer ref="driveChanger" />
</template>
<script lang="ts" setup>
import { onMounted, ref, toRaw, watch } from 'vue';
import useNotify from '@/hooks/useNotify';
import { NInput, NForm, NButton, NFormItem, FormInst, NCard, NModal, NPagination, NDataTable, NSpin } from 'naive-ui'
import type { DataTableColumns, DataTableRowKey } from 'naive-ui'
import type { SearchCache, BrowseHistoryWithPagination, OpenMode } from 'electron/server/nedb';
import DriveChanger from "@/components/DriveChanger/index.vue";
import { deletAction } from '@/utils/request';

export type HistoryQuery = {
    path: string;
    pageNo: number;
    pageSize: number;
    total: number;
}
type RowData = { key: number; _id: string; path: string; create_at: string; }
const columns = ref<DataTableColumns<RowData>>([{
    type: 'selection'
}, {
    title: '路径',
    key: 'path'
}, {
    title: '日期',
    key: 'create_at'
}])
const tableData = ref<Partial<SearchCache>[]>([])
const emits = defineEmits<{
    (e: 'openDir', path: string, mode: OpenMode): void
}>();
const notify = useNotify();
const formRef = ref<FormInst | null>(null);
const model = ref<HistoryQuery>({
    path: '',
    pageNo: 1,
    pageSize: 10,
    total: 0
})
const showModal = ref(false);
const loading = ref(false);
const isFirstRender = ref(false);
const setShowModal = function (val: boolean) {
    showModal.value = val;
}

function toQueryStr(val: Record<string, any>) {
    if (typeof val !== 'object' || null) return `?_t=${+new Date()}`

    let queryStr = Object.keys(val).map(key => {
        const value = String(val[key] !== undefined ? val[key] : '');
        if (value) {
            return `${key}=${value}`
        } else {
            return
        }
    }).filter(f => f).join('&')

    return queryStr ? `?${queryStr}&_t=${+new Date()}` : `?_t=${+new Date()}`
}

const getHistrotyList = () => {
    if (loading.value) return
    loading.value = true;
    fetch(`http://127.0.0.1:3060/getHistory${toQueryStr(model.value)}`).then(res => {
        return res.json();
    }).then(async (data: BrowseHistoryWithPagination) => {
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
    getHistrotyList();
}

const openDir = (item: Partial<SearchCache>) => {
    setShowModal(false);
    setTimeout(() => {
        if (item.path) {
            emits('openDir', item.path, item.mode || 'cover');
        }
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

const driveChanger = ref<typeof DriveChanger>()
const handleDriveChangerShow = () => {
    driveChanger.value?.setShowModal(true)
}

const checkedRowKeysRef = ref<DataTableRowKey[]>([])
const handleCheck = (rowKeys: DataTableRowKey[]) => {
    checkedRowKeysRef.value = rowKeys

}

const handleRemove = async () => {
    loading.value = true;

    try {
        const ids = toRaw(checkedRowKeysRef.value)
        await deletAction('http://localhost:3060/removeHistoryBatch?ids=' + ids.join(','))
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

onMounted(() => {
    const unwatch = watch(showModal, (val) => {
        if (val && !isFirstRender.value) {
            unwatch();
            getHistrotyList();
            isFirstRender.value = true;
        }
    })
});

defineExpose({
    setShowModal
})
</script>