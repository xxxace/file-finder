<template>
    <n-modal
        :show="show"
        preset="card"
        title="女优头像回收（基于 Gfriends）"
        style="width: 90vw; max-width: 1080px; height: 85vh"
        content-style="display: flex; flex-direction: column; overflow: hidden; padding: 16px 20px"
        @update:show="onClose"
    >
        <!-- 离线提示 -->
        <div v-if="!activeIsOnline" style="margin-bottom: 14px">
            <n-alert type="warning" title="磁盘处于离线状态" :bordered="false">
                当前目录所在磁盘处于离线（未挂载）状态，仅可查看缓存。如需写入头像及更新缓存，请先将移动硬盘连接至电脑。
            </n-alert>
        </div>

        <!-- 顶部信息与操作栏 -->
        <div class="avatar-modal-header">
            <div class="avatar-modal-path">
                <span class="avatar-label">目标范围：</span>
                <span class="avatar-path-text">{{ currentPathDisplay }}</span>
                <span class="avatar-hint">（仅扫描该目录下一级的直属子文件夹）</span>
            </div>
            <div class="avatar-modal-actions">
                <n-button
                    size="small"
                    tertiary
                    :loading="updatingIndex"
                    @click="updateIndex"
                >
                    更新索引
                </n-button>
                <n-button
                    size="small"
                    type="primary"
                    :loading="scanning"
                    :disabled="!activeIsOnline || applying"
                    @click="runScan"
                >
                    扫描直属目录
                </n-button>
            </div>
        </div>

        <!-- 主体区域：表格或空态 -->
        <div class="avatar-modal-body">
            <div v-if="scanning" class="avatar-modal-center">
                <n-spin size="medium" description="正在读取目录并匹配 Gfriends 索引..." />
            </div>

            <div v-else-if="!candidates.length && hasScanned" class="avatar-modal-center avatar-empty">
                <p>当前目录下没有找到缺少头像的女优子目录</p>
                <span class="avatar-hint">（已自动排除已有头像的文件夹及影片番号目录）</span>
            </div>

            <div v-else-if="!hasScanned" class="avatar-modal-center avatar-empty">
                <p>请点击右上角「扫描直属目录」开始检索缺少头像的女优文件夹</p>
            </div>

            <!-- 候选表格 -->
            <div v-else class="avatar-table-wrap">
                <div class="avatar-toolbar">
                    <div class="avatar-toolbar-left">
                        <n-button size="tiny" tertiary @click="selectAll(true)">全选</n-button>
                        <n-button size="tiny" tertiary @click="selectAll(false)">取消全选</n-button>
                        <n-button size="tiny" tertiary @click="selectMatchedOnly">仅选已匹配</n-button>
                        <span class="avatar-count-info">
                            共发现 {{ candidates.length }} 个待处理目录 · 已匹配 {{ matchedCount }} · 选中 {{ selectedCount }}
                        </span>
                    </div>
                </div>

                <div class="avatar-list-scroll">
                    <table class="avatar-custom-table">
                        <thead>
                            <tr>
                                <th style="width: 44px; text-align: center">
                                    <input
                                        type="checkbox"
                                        :checked="isAllSelected"
                                        :indeterminate="isIndeterminate"
                                        @change="toggleSelectAll"
                                    />
                                </th>
                                <th style="width: 64px; text-align: center">头像</th>
                                <th style="width: 240px">原始文件夹名</th>
                                <th style="width: 180px">识别女优名</th>
                                <th style="width: 140px">状态</th>
                                <th>操作</th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr v-for="row in candidates" :key="row.relDir">
                                <td style="text-align: center">
                                    <input type="checkbox" v-model="row.selected" />
                                </td>
                                <td style="text-align: center">
                                    <div class="avatar-preview-box">
                                        <n-image
                                            v-if="row.avatarUrl"
                                            :src="previewSrc(row.avatarUrl)"
                                            width="44"
                                            height="44"
                                            object-fit="cover"
                                            style="border-radius: 4px; display: block"
                                            preview-disabled
                                        />
                                        <div v-else class="avatar-no-img">无图</div>
                                    </div>
                                </td>
                                <td>
                                    <div class="avatar-name-cell" :title="row.folderName">
                                        {{ row.folderName }}
                                    </div>
                                </td>
                                <td>
                                    <n-input
                                        v-model:value="row.cleanName"
                                        size="small"
                                        placeholder="女优名"
                                        style="max-width: 150px"
                                        @blur="recheckName(row)"
                                        @keydown.enter="recheckName(row)"
                                    />
                                </td>
                                <td>
                                    <n-tag v-if="row.status === 'matched'" size="small" type="success" :bordered="false">
                                        {{ row.matchedName || '已匹配' }}
                                    </n-tag>
                                    <n-tag v-else size="small" type="warning" :bordered="false">
                                        未找到
                                    </n-tag>
                                </td>
                                <td>
                                    <n-popover trigger="click" placement="bottom">
                                        <template #trigger>
                                            <n-button size="tiny" tertiary>手动填 URL</n-button>
                                        </template>
                                        <div style="padding: 6px; width: 280px">
                                            <div style="font-size: 12px; margin-bottom: 6px; color: var(--n-text-color)">
                                                输入图片直接下载链接：
                                            </div>
                                            <n-input
                                                v-model:value="row.manualUrl"
                                                size="small"
                                                placeholder="https://..."
                                                style="margin-bottom: 8px"
                                            />
                                            <div style="display: flex; justify-content: flex-end; gap: 8px">
                                                <n-button size="tiny" type="primary" @click="applyManualUrl(row)">
                                                    应用此链接
                                                </n-button>
                                            </div>
                                        </div>
                                    </n-popover>
                                </td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            </div>
        </div>

        <!-- 底部状态与应用确认栏 -->
        <div class="avatar-modal-footer">
            <div class="avatar-footer-status">
                <span v-if="applyResult" class="avatar-result-text">
                    处理完毕：成功 {{ applyResult.succeeded }} 个 · 失败 {{ applyResult.failed }} 个
                </span>
            </div>
            <div class="avatar-footer-btns">
                <n-button size="small" :disabled="applying" @click="onClose">
                    {{ applyResult ? '关闭' : '取消' }}
                </n-button>
                <n-popconfirm
                    positive-text="确定写入"
                    negative-text="取消"
                    @positive-click="runApply"
                >
                    <template #trigger>
                        <n-button
                            size="small"
                            type="primary"
                            :loading="applying"
                            :disabled="!activeIsOnline || selectedCount === 0 || applying"
                        >
                            写入选中头像 ({{ selectedCount }})
                        </n-button>
                    </template>
                    即将为选中的 {{ selectedCount }} 个女优目录下载并写入头像（avatar.jpg），已有旧头像会自动备份。确定执行吗？
                </n-popconfirm>
            </div>
        </div>
    </n-modal>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import {
    NModal, NAlert, NButton, NSpin, NImage, NTag, NInput, NPopover, NPopconfirm, useMessage
} from 'naive-ui';
import { apiUrl, getAction, postAction } from '@/utils/request';

const API_BASE = 'http://127.0.0.1:3060';
const previewSrc = (url?: string | null) =>
    url ? apiUrl(`${API_BASE}/assistant/preview?url=${encodeURIComponent(url)}`) : '';

const props = withDefaults(
    defineProps<{
        show: boolean;
        currentPath?: string;
        serial?: string;
        relPath?: string;
        isOnline?: boolean;
    }>(),
    {
        currentPath: '',
        serial: '',
        relPath: '',
        isOnline: true,
    }
);

const emit = defineEmits<{
    (e: 'update:show', val: boolean): void;
    (e: 'applied'): void;
}>();

const message = useMessage();

interface AvatarRow {
    relDir: string;
    folderName: string;
    cleanName: string;
    matchedName: string | null;
    avatarUrl: string | null;
    status: 'matched' | 'unmatched';
    selected: boolean;
    manualUrl?: string;
}

const scanning = ref(false);
const applying = ref(false);
const updatingIndex = ref(false);
const hasScanned = ref(false);
const candidates = ref<AvatarRow[]>([]);
const applyResult = ref<{ succeeded: number; failed: number } | null>(null);

const activeSerial = ref('');
const activeRelPath = ref('');
const activeIsOnline = ref(true);

const currentPathDisplay = computed(() => {
    return props.currentPath || (activeRelPath.value ? `${activeSerial.value}/${activeRelPath.value}` : '当前目录');
});

const matchedCount = computed(() => {
    return candidates.value.filter(c => c.status === 'matched').length;
});

const selectedCount = computed(() => {
    return candidates.value.filter(c => c.selected).length;
});

const isAllSelected = computed(() => {
    return candidates.value.length > 0 && candidates.value.every(c => c.selected);
});

const isIndeterminate = computed(() => {
    const sel = selectedCount.value;
    return sel > 0 && sel < candidates.value.length;
});

function onClose() {
    emit('update:show', false);
}

function selectAll(val: boolean) {
    candidates.value.forEach(c => (c.selected = val));
}

function selectMatchedOnly() {
    candidates.value.forEach(c => {
        c.selected = c.status === 'matched';
    });
}

function toggleSelectAll(e: Event) {
    const checked = (e.target as HTMLInputElement).checked;
    selectAll(checked);
}

async function resolveDriveContext() {
    if (props.serial) {
        activeSerial.value = props.serial;
        activeRelPath.value = props.relPath || '';
        activeIsOnline.value = props.isOnline ?? true;
        return;
    }
    const pathStr = props.currentPath || '';
    if (!pathStr) {
        activeSerial.value = '';
        activeRelPath.value = '';
        activeIsOnline.value = false;
        return;
    }

    if (pathStr.startsWith('#')) {
        // 离线只读锚点: #SERIAL/rel/path
        const rest = pathStr.slice(1);
        const cut = rest.indexOf('/');
        activeSerial.value = cut === -1 ? rest : rest.slice(0, cut);
        activeRelPath.value = cut === -1 ? '' : rest.slice(cut + 1);
        activeIsOnline.value = false;
        return;
    }

    // 在线盘符: H:/...
    const match = pathStr.match(/^([A-Za-z]):[\\/]?/);
    if (match) {
        const letter = match[1].toUpperCase();
        activeRelPath.value = pathStr
            .replace(/^[A-Za-z]:[\\/]?/, '')
            .replace(/\\/g, '/')
            .replace(/^\/+/, '')
            .replace(/\/+$/, '');
        try {
            let res = (await getAction(`${API_BASE}/getDisks`)) as {
                disks?: { serial: string; drive: string; online?: boolean }[];
            };
            let disk = (res.disks || []).find(d => d.drive?.toUpperCase() === letter);
            // 若内存缓存盘表中未找到，加 refresh=true 重新探测系统挂载盘符
            if (!disk || !disk.serial) {
                res = (await getAction(`${API_BASE}/getDisks?refresh=true`)) as {
                    disks?: { serial: string; drive: string; online?: boolean }[];
                };
                disk = (res.disks || []).find(d => d.drive?.toUpperCase() === letter);
            }
            if (disk && disk.serial) {
                activeSerial.value = disk.serial;
                activeIsOnline.value = disk.online !== false;
            } else {
                activeIsOnline.value = false;
            }
        } catch {
            activeIsOnline.value = false;
        }
    }
}

async function runScan() {
    if (!activeSerial.value || !activeIsOnline.value) return;
    scanning.value = true;
    hasScanned.value = true;
    applyResult.value = null;

    try {
        const res = (await postAction(`${API_BASE}/assistant/avatar/scan`, {
            serial: activeSerial.value,
            relPath: activeRelPath.value,
        })) as {
            code: number;
            candidates: {
                relDir: string;
                folderName: string;
                cleanName: string;
                matchedName: string | null;
                avatarUrl: string | null;
                status: 'matched' | 'unmatched';
            }[];
            error?: string;
        };

        if (res.code === 200 && Array.isArray(res.candidates)) {
            candidates.value = res.candidates.map((c) => ({
                ...c,
                selected: c.status === 'matched', // 默认全选已匹配的
                manualUrl: '',
            }));
            if (candidates.value.length === 0) {
                message.info('当前目录下未发现缺少头像的女优子目录');
            }
        } else {
            message.error(res.error || '扫描失败');
        }
    } catch (e) {
        message.error(`扫描请求出错: ${e instanceof Error ? e.message : e}`);
    } finally {
        scanning.value = false;
    }
}

async function recheckName(row: AvatarRow) {
    const name = row.cleanName.trim();
    if (!name) return;

    try {
        const res = (await postAction(`${API_BASE}/assistant/avatar/match`, { name })) as {
            code: number;
            matched: boolean;
            matchedName?: string;
            avatarUrl?: string;
        };

        if (res.code === 200 && res.matched && res.avatarUrl) {
            row.status = 'matched';
            row.matchedName = res.matchedName || name;
            row.avatarUrl = res.avatarUrl;
            row.selected = true;
        } else {
            row.status = 'unmatched';
            row.matchedName = null;
            row.avatarUrl = null;
        }
    } catch {
        // 静默处理单条匹配错误
    }
}

function applyManualUrl(row: AvatarRow) {
    const url = row.manualUrl?.trim();
    if (!url) {
        message.warning('请输入有效的图片链接');
        return;
    }
    row.avatarUrl = url;
    row.status = 'matched';
    row.matchedName = row.cleanName || '自定义头像';
    row.selected = true;
    message.success('已指定头像图片地址');
}

async function runApply() {
    const selectedItems = candidates.value
        .filter(c => c.selected && c.avatarUrl)
        .map(c => ({
            relDir: c.relDir,
            avatarUrl: c.avatarUrl!,
        }));

    if (!selectedItems.length) {
        message.warning('没有可写入的有效条目');
        return;
    }

    applying.value = true;
    try {
        const res = (await postAction(`${API_BASE}/assistant/avatar/apply`, {
            serial: activeSerial.value,
            items: selectedItems,
        })) as {
            code: number;
            result: {
                total: number;
                succeeded: number;
                failed: number;
                logs: { relDir: string; status: 'ok' | 'error'; message?: string }[];
            };
            error?: string;
        };

        if (res.code === 200 && res.result) {
            applyResult.value = {
                succeeded: res.result.succeeded,
                failed: res.result.failed,
            };
            if (res.result.succeeded > 0) {
                message.success(`成功写入 ${res.result.succeeded} 个目录头像${res.result.failed > 0 ? `，${res.result.failed} 个失败` : ''}`);
                emit('applied'); // 触发主网格刷新
            } else {
                message.error(`所有 ${res.result.failed} 个头像写入均失败，请检查网络或日志`);
            }
        } else {
            message.error(res.error || '写入失败');
        }
    } catch (e) {
        message.error(`写入请求失败: ${e instanceof Error ? e.message : e}`);
    } finally {
        applying.value = false;
    }
}

async function updateIndex() {
    updatingIndex.value = true;
    try {
        const res = (await postAction(`${API_BASE}/assistant/avatar/index-update`, {})) as {
            code: number;
            actorCount?: number;
            error?: string;
        };
        if (res.code === 200) {
            message.success(`Gfriends 索引已更新，收录女优 ${res.actorCount || 0} 位`);
            if (candidates.value.length > 0) {
                runScan();
            }
        } else {
            message.error(res.error || '更新索引失败');
        }
    } catch (e) {
        message.error(`更新索引出错: ${e instanceof Error ? e.message : e}`);
    } finally {
        updatingIndex.value = false;
    }
}

// 弹窗打开时自动解析盘符并尝试扫描
watch(
    () => props.show,
    async (showVal) => {
        if (showVal) {
            hasScanned.value = false;
            candidates.value = [];
            applyResult.value = null;
            await resolveDriveContext();
            if (activeIsOnline.value && activeSerial.value) {
                runScan();
            }
        }
    }
);
</script>

<style scoped>
.avatar-modal-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding-bottom: 12px;
    border-bottom: 1px solid var(--n-border-color);
    margin-bottom: 12px;
}
.avatar-modal-path {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
}
.avatar-label {
    color: var(--n-text-color-3);
}
.avatar-path-text {
    font-weight: 500;
    color: var(--n-text-color);
}
.avatar-hint {
    color: var(--n-text-color-3);
    font-size: 12px;
}
.avatar-modal-body {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    position: relative;
}
.avatar-modal-center {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
}
.avatar-empty p {
    font-size: 14px;
    color: var(--n-text-color-2);
    margin-bottom: 6px;
}
.avatar-table-wrap {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
}
.avatar-toolbar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 8px;
}
.avatar-toolbar-left {
    display: flex;
    align-items: center;
    gap: 8px;
}
.avatar-count-info {
    font-size: 12px;
    color: var(--n-text-color-3);
    margin-left: 8px;
}
.avatar-list-scroll {
    flex: 1;
    overflow-y: auto;
    border: 1px solid var(--n-border-color);
    border-radius: 4px;
}
.avatar-custom-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
}
.avatar-custom-table th {
    background-color: var(--n-card-color);
    padding: 8px 12px;
    font-weight: 500;
    text-align: left;
    border-bottom: 1px solid var(--n-border-color);
    position: sticky;
    top: 0;
    z-index: 2;
}
.avatar-custom-table td {
    padding: 8px 12px;
    border-bottom: 1px solid var(--n-border-color);
    vertical-align: middle;
}
.avatar-custom-table tr:hover {
    background-color: var(--n-hover-color);
}
.avatar-preview-box {
    width: 44px;
    height: 44px;
    display: flex;
    align-items: center;
    justify-content: center;
    background-color: var(--n-color-embedded);
    border-radius: 4px;
    overflow: hidden;
}
.avatar-no-img {
    font-size: 11px;
    color: var(--n-text-color-3);
}
.avatar-name-cell {
    max-width: 220px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.avatar-modal-footer {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding-top: 14px;
    border-top: 1px solid var(--n-border-color);
    margin-top: 12px;
}
.avatar-result-text {
    font-size: 13px;
    color: var(--n-primary-color);
    font-weight: 500;
}
.avatar-footer-btns {
    display: flex;
    gap: 10px;
    align-items: center;
}
</style>
