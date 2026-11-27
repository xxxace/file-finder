<template>
    <!-- 通用面板 —— 真正的「偏好」住这里（Microsoft 准则：低频、影响行为、不需要频繁调整）。 -->
    <div class="general-panel">
        <!-- 卡 · 界面音效：标题+说明在左，控件在右（SettingsCard 模式） -->
        <section class="set-card">
            <div class="set-row">
                <div class="set-text">
                    <span class="set-title">界面音效</span>
                    <span class="set-desc">切换 / 完成 / 提示时轻响一声；悬停与方向键刻意不配声</span>
                </div>
                <n-switch :value="sfxPrefs.on" @update:value="setSfxEnabled" />
            </div>
            <div class="set-row">
                <div class="set-text">
                    <span class="set-title">音量</span>
                </div>
                <n-slider class="sfx-vol" :value="sfxPrefs.vol" :min="0" :max="1" :step="0.05"
                    :disabled="!sfxPrefs.on" @update:value="setSfxVolume" />
                <n-button size="small" :disabled="!sfxPrefs.on" @click="playSfx('success')">试听</n-button>
            </div>
        </section>

        <!-- 卡 · 彩蛋：纯装饰，默认开启。关掉即连那层全屏画布一起撤走 -->
        <section class="set-card">
            <div class="set-row">
                <div class="set-text">
                    <span class="set-title">文字选区开花</span>
                    <span class="set-desc">选中文字时沿字边长出小花小草，松手缩回；不影响复制和拖拽</span>
                </div>
                <n-switch :value="bloomPrefs.on" @update:value="setBloomEnabled" />
            </div>
        </section>

        <!-- 卡 · 备份与迁移：整块复用 BackupPanel（2026-11-08 抽离时就预留了"移进设置页"）。
             还原/合并成功后的 migrated 事件在设置页没有列表要刷，通知音已由 notify 承担。 -->
        <section class="set-card">
            <div class="set-row set-row-head">
                <div class="set-text">
                    <span class="set-title">备份与迁移</span>
                    <span class="set-desc">把缓存和收藏搬出去 / 搬回来 —— 每个动作下面写明了后果</span>
                </div>
            </div>
            <BackupPanel />
        </section>

        <!-- 卡 · 缓存与冗余清理：抽帧原件、无引用图片仓孤儿、旧封面备份与迁移残留均可在此预览后按需清除。 -->
        <section class="set-card">
            <div class="set-row set-row-head">
                <div class="set-text">
                    <span class="set-title">缓存与冗余清理</span>
                    <span class="set-desc">抽帧原件、无引用图片仓孤儿、旧封面备份与迁移残留均可在此预览后按需清除</span>
                </div>
            </div>
            <FrameCacheBlock />
        </section>

        <!-- 卡 · 数据与缓存目录：支持将缓存库、缩略图仓与抽帧缓存迁出 C 盘 -->
        <section class="set-card">
            <div class="set-row">
                <div class="set-text">
                    <span class="set-title">数据与缓存目录位置</span>
                    <span class="set-desc data-dir-path" :title="dataDir">
                        {{ dataDir || '加载中…' }}
                        <template v-if="!isDefaultDataDir">（已自定义）</template>
                    </span>
                </div>
                <n-button v-if="!isDefaultDataDir" size="small" quaternary :loading="dirMigrating"
                    @click="resetDefaultDataDir">
                    恢复默认
                </n-button>
                <n-button size="small" :loading="dirMigrating" @click="pickAndMigrateDataDir">
                    更改位置…
                </n-button>
            </div>
        </section>

        <!-- 卡 · 本地服务端口：默认自动分配空闲端口，也允许手动指定（下次启动生效） -->
        <section class="set-card">
            <div class="set-row">
                <div class="set-text">
                    <span class="set-title">本地服务端口</span>
                    <span class="set-desc">
                        当前运行在 127.0.0.1:{{ activePort }}
                        <template v-if="fallbackFrom">（原配置 {{ fallbackFrom }} 被占用，已自动换用空闲端口）</template>
                        <template v-else-if="restartNeeded">（已保存，重启应用后生效）</template>
                    </span>
                </div>
                <n-button v-if="restartNeeded" size="small" secondary @click="relaunchApp">立即重启</n-button>
                <span class="port-mode-label">自动空闲</span>
                <n-switch :value="autoPort" :disabled="portSaving" @update:value="onToggleAutoPort" />
            </div>
            <div v-if="!autoPort" class="set-row">
                <div class="set-text">
                    <span class="set-title">指定端口号</span>
                    <span class="set-desc">1024 ~ 65535；若启动时被占用会自动回退到空闲端口</span>
                </div>
                <n-input-number v-model:value="customPort" class="port-input" size="small" :min="1024" :max="65535"
                    :precision="0" :show-button="false" placeholder="如 3060" />
                <n-button size="small" :loading="portSaving" :disabled="!canSaveCustomPort" @click="saveCustomPort">
                    保存
                </n-button>
            </div>
        </section>

        <!-- 卡 · 关于：设置页的固定收尾（Microsoft 指南建议）。
             「打开数据目录」不在这里 —— BackupPanel 里已有同一动作，不复制第二个入口。 -->
        <section class="set-card">
            <div class="set-row">
                <div class="set-text">
                    <span class="set-title">file-finder</span>
                    <span class="set-desc">v{{ version }} · 本地缓存库与图片存放在用户数据目录</span>
                </div>
            </div>
        </section>
    </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ipcRenderer } from 'electron';
import { NButton, NInputNumber, NSwitch, NSlider } from 'naive-ui';
import { playSfx, sfxPrefs, setSfxEnabled, setSfxVolume } from '@/utils/sfx';
import { bloomPrefs, setBloomEnabled } from '@/components/SelectionFlower/pref';
import BackupPanel from '@/views/Cache/BackupPanel.vue';
import FrameCacheBlock from './FrameCacheBlock.vue';
import { API_BASE, getAction, postAction } from '@/utils/request';
import useNotify from '@/hooks/useNotify';
import useConfirm from '@/hooks/useConfirm';
import pkg from '../../../package.json';

const version = pkg.version;
const notify = useNotify();
const dialog = useConfirm();

const dataDir = ref('');
const defaultDataDir = ref('');
const isDefaultDataDir = ref(true);
const dirMigrating = ref(false);

async function loadDataDir() {
    try {
        const res = await getAction(`${API_BASE}/dataDir`) as {
            currentDir?: string;
            defaultDir?: string;
            isDefault?: boolean;
        };
        dataDir.value = res.currentDir || '';
        defaultDataDir.value = res.defaultDir || '';
        isDefaultDataDir.value = res.isDefault !== false;
    } catch {
        // 读取失败保留空展示
    }
}

function confirmAndMigrateDir(targetDir: string, title: string, content: string) {
    dialog.warning({
        title,
        content,
        positiveText: '开始迁移并重启',
        negativeText: '取消',
        maskClosable: false,
        async onPositiveClick() {
            dirMigrating.value = true;
            try {
                const res = await postAction(`${API_BASE}/migrateDataDir`, { path: targetDir }) as {
                    targetDir?: string;
                    cleanupWarnings?: number;
                };
                if (res.cleanupWarnings) {
                    notify('warning', '迁移完成（部分旧文件未清理）', '新目录已生效，正在重启应用…');
                } else {
                    notify('success', '数据迁移完成', '正在重启应用以切换目录…');
                }
                setTimeout(() => { void ipcRenderer.invoke('ff-relaunch'); }, 600);
            } catch (e) {
                notify('error', '迁移数据目录失败', String(e));
            } finally {
                dirMigrating.value = false;
            }
        },
    });
}

async function pickAndMigrateDataDir() {
    const picked = await ipcRenderer.invoke('pickDataDir') as { canceled: boolean; filePath: string };
    if (picked?.canceled || !picked?.filePath) return;
    confirmAndMigrateDir(
        picked.filePath,
        '迁移数据与缓存目录？',
        `将把当前目录中的缓存库、图片仓、收藏夹、站点规则与抽帧缓存完整复制到「${picked.filePath}」并清理原目录，完成后自动重启应用。`,
    );
}

function resetDefaultDataDir() {
    if (!defaultDataDir.value) return;
    confirmAndMigrateDir(
        defaultDataDir.value,
        '恢复默认数据目录？',
        `将把数据与缓存迁回默认位置「${defaultDataDir.value}」，完成后自动重启应用。`,
    );
}

const activePort = ref<number>(3060);
const configuredPort = ref<number | null>(null);
const fallbackFrom = ref<number | null>(null);
const autoPort = ref(true);
const customPort = ref<number | null>(3060);
const portSaving = ref(false);

const restartNeeded = computed(() =>
    configuredPort.value !== null && configuredPort.value !== activePort.value,
);

const canSaveCustomPort = computed(() =>
    typeof customPort.value === 'number'
    && Number.isInteger(customPort.value)
    && customPort.value >= 1024
    && customPort.value <= 65535
    && customPort.value !== configuredPort.value,
);

async function loadPortConfig() {
    try {
        const res = await getAction(`${API_BASE}/serverPort`) as {
            configuredPort?: number | null;
            activePort?: number;
            fallbackFrom?: number | null;
        };
        activePort.value = res.activePort || 3060;
        configuredPort.value = res.configuredPort ?? null;
        fallbackFrom.value = res.fallbackFrom ?? null;
        autoPort.value = configuredPort.value === null;
        if (configuredPort.value !== null) {
            customPort.value = configuredPort.value;
        } else if (!customPort.value) {
            customPort.value = activePort.value;
        }
    } catch {
        // 读取失败保留默认展示
    }
}

async function submitPort(port: number | null) {
    portSaving.value = true;
    try {
        const res = await postAction(`${API_BASE}/serverPort`, { port }) as {
            configuredPort?: number | null;
            activePort?: number;
            fallbackFrom?: number | null;
        };
        configuredPort.value = res.configuredPort ?? null;
        activePort.value = res.activePort || activePort.value;
        fallbackFrom.value = res.fallbackFrom ?? null;
        autoPort.value = configuredPort.value === null;
        notify('success', '端口设置已保存', port === null ? '已设为自动寻找空闲端口（下次启动生效）' : `已设为 ${port}（重启应用后生效）`);
    } catch (e) {
        notify('error', '保存端口失败', String(e));
    } finally {
        portSaving.value = false;
    }
}

function onToggleAutoPort(val: boolean) {
    autoPort.value = val;
    if (val) {
        if (configuredPort.value !== null) {
            void submitPort(null);
        }
    } else if (!customPort.value) {
        customPort.value = activePort.value;
    }
}

function saveCustomPort() {
    if (!canSaveCustomPort.value || customPort.value === null) return;
    void submitPort(customPort.value);
}

function relaunchApp() {
    void ipcRenderer.invoke('ff-relaunch');
}

onMounted(() => {
    void loadDataDir();
    void loadPortConfig();
});
</script>

<style lang="less" scoped>
.general-panel {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    width: 100%;
    max-width: 900px;
    /* 窗口宽时居中（Windows 11 设置同款），窄窗自动贴满 */
    margin-inline: auto;
    padding-right: 6px;
    box-sizing: border-box;
}

/* SettingsCard 模式：玻璃板（半透明 + 顶亮底暗渐变 + 发丝边）。
   ⚠️ 不挂 backdrop-filter：卡背后是纯色画布，模糊纯色零变化，白付合成成本。见 tokens 的 --ff-glass-* */
.set-card {
    background: var(--ff-glass-bg);
    border-radius: var(--ff-r-card);
    box-shadow: var(--ff-glass-shadow);
    padding: 6px 16px;
    margin-bottom: 16px;
}

.set-row {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 0;
    min-height: 44px;
    box-sizing: border-box;
}

.set-row + .set-row {
    border-top: 1px solid var(--ff-line);
}

.set-row-head {
    padding-bottom: 2px;
}

.set-text {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
}

.set-title {
    font-size: 13px;
    font-weight: 500;
    color: var(--ff-text-1);
}

.set-desc {
    font-size: 12px;
    color: var(--ff-text-2);
}

.sfx-vol {
    width: 200px;
}

.port-mode-label {
    font-size: 12px;
    color: var(--ff-text-2);
    white-space: nowrap;
}

.port-input {
    width: 120px;
}

.data-dir-path {
    word-break: break-all;
}
</style>
