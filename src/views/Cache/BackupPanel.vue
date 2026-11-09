<template>
    <!-- ⚠️ 2026-11-09 重设计（主人："感觉都是文本"）：
         对齐 1Password / Telegram / Bitwarden 的备份动作范式——
         每动作一整行（图标+动词+后果说明在第二行），整行可点，危险动作红色标题，
         ≤5 个动作不折叠（折叠是"高级区"的工种，原来折叠还让标题出现了两次）。
         逻辑与文案（后果说明）一字未动；对外接口仍是 `migrated` 事件。 -->
    <div class="mi-list" role="group" aria-label="备份与迁移">
        <button type="button" class="mi-row" :disabled="backupLoading" @click="handleBackupToFile">
            <span class="mi-icon" aria-hidden="true">
                <n-spin v-if="backupLoading" :size="14" />
                <n-icon v-else :size="16" :component="ArchiveOutline" />
            </span>
            <span class="mi-text">
                <span class="mi-title">备份到一个文件…</span>
                <span class="mi-desc">默认文件名带你今天的日期，位置自己挑 —— 不会被任何东西覆盖</span>
            </span>
        </button>

        <button type="button" class="mi-row mi-row-danger" :disabled="busy" @click="handleRestoreFromFile">
            <span class="mi-icon" aria-hidden="true">
                <n-spin v-if="busy" :size="14" />
                <n-icon v-else :size="16" :component="CloudDownloadOutline" />
            </span>
            <span class="mi-text">
                <span class="mi-title">从文件还原…</span>
                <span class="mi-desc">缓存整份替换；收藏夹只增不删</span>
            </span>
        </button>

        <button type="button" class="mi-row" :disabled="bulkLoading" @click="handleMergeCache">
            <span class="mi-icon" aria-hidden="true">
                <n-spin v-if="bulkLoading" :size="14" />
                <n-icon v-else :size="16" :component="GitMergeOutline" />
            </span>
            <span class="mi-text">
                <span class="mi-title">合并缓存…</span>
                <span class="mi-desc">只增不删（新增 / 覆盖 / 跳过 会报给你）</span>
            </span>
        </button>

        <button type="button" class="mi-row" @click="openDataDir">
            <span class="mi-icon" aria-hidden="true">
                <n-icon :size="16" :component="FolderOpenOutline" />
            </span>
            <span class="mi-text">
                <span class="mi-title">打开存放文件夹</span>
                <span class="mi-desc">只打开文件夹、不动任何数据（缓存库、图片和备份都在这儿）</span>
            </span>
        </button>
    </div>
</template>

<script setup lang="ts">
/**
 * 备份与迁移面板（自 Cache/index.vue 原样搬出，2026-11-08）。
 *
 * 依赖自持：notify / dialog / ipc 选路径都是全局能力，不依赖宿主页面的任何状态；
 * 唯一的对外接口是 `migrated` 事件 —— 还原/合并动了库内容之后宿主需要重取列表
 * （原页面的做法是直接调 reloadAfterDataChange，抽离后改成事件，宿主自己决定刷什么）。
 * 宿主的整页 spin 不再被这些动作点亮：按钮自己的 loading 转圈已经足够表达"在做"，
 * 且防止了「转着圈还能再点一次」。
 */
import { ref } from 'vue';
import { ipcRenderer } from 'electron';
import { NIcon, NSpin } from 'naive-ui';
import { ArchiveOutline, CloudDownloadOutline, FolderOpenOutline, GitMergeOutline } from '@vicons/ionicons5';
import useNotify from '@/hooks/useNotify';
import useConfirm from '@/hooks/useConfirm';
import { refreshIndex } from '@/views/FileFinder/playlist';
import { API_BASE, postAction } from '@/utils/request';

const emit = defineEmits<{ migrated: [] }>();

const notify = useNotify();
const dialog = useConfirm();

const backupLoading = ref(false);
const bulkLoading = ref(false);
/** 还原/合并期间的本地忙碌位（原来点亮宿主页的整页 spin，抽离后自己管自己） */
const busy = ref(false);

/** 主进程两个「选路径」通道的返回约定（见 electron/main/index.ts） */
type PickResult = { canceled: boolean; filePath: string };

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

    busy.value = true;
    let ok = false;
    let merged = '';
    try {
        const r = await postAction(API_BASE + '/restoreFromFile', { path: file }) as {
            playlists?: number; playlistItems?: number;
        };
        merged = r?.playlists || r?.playlistItems ? `；并入 ${r.playlists ?? 0} 个收藏夹 / ${r.playlistItems ?? 0} 个条目` : '';
        ok = true;
    } catch (err) {
        // 服务端在还原失败时已经尽力回滚过了，错误文案里会写明"已回滚"还是"回滚也失败"
        notify('error', '还原失败', `${err}`)
    } finally {
        busy.value = false;
    }

    if (!ok) return;
    notify('success', '已还原', `缓存已整份替换${merged}`)
    // 还原换的是库内容，没换"插着哪些盘" ⇒ 宿主重取列表时**不重探盘符**。
    // 收藏夹也可能被并进来了 ⇒ 重取索引（星标 / 货架的数字都读它）
    void refreshIndex().catch(() => undefined);
    emit('migrated');
}

/**
 * 「合并缓存…」—— 两边都留，按主键并起来。
 * 不做二次确认：它只增不删（同主键冲突时取 `create_at` 新的），没有可撤销性可言。
 */
const handleMergeCache = async () => {
    const file = await pickPath('pickCacheOpenPath');
    if (!file) return;

    busy.value = true;
    bulkLoading.value = true;
    let result: { added: number; replaced: number; skipped: number } | null = null;
    try {
        result = await postAction(API_BASE + '/mergeCache', { path: file });
    } catch (err) {
        notify('error', '合并失败', `${err}`)
    } finally {
        busy.value = false;
        bulkLoading.value = false;
    }

    if (!result) return;
    notify('success', '合并完成',
        `新增 ${result.added} 条、覆盖 ${result.replaced} 条、跳过 ${result.skipped} 条`)
    emit('migrated');
}

const openDataDir = async () => {
    const err = await ipcRenderer.invoke('openDataDir');
    if (err) notify('error', '打开失败', err);
}
</script>

<style scoped>
/* 动作行：图标+标题+说明两层，整行可点；激活态与全站同族（圆角 8 灰底）。
   ⚠️ 还原这行的红 = 标题级红文字（--ff-danger），HIG 的破坏性动作模型。 */
.mi-list {
    display: flex;
    flex-direction: column;
    margin-top: 4px;
}

.mi-row {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 9px 10px;
    border: 0;
    border-radius: var(--ff-r-ctl);
    background: transparent;
    font: inherit;
    text-align: left;
    cursor: pointer;
    transition: background-color var(--ff-dur-hover) ease;
}

.mi-row:hover:not(:disabled) { background: var(--ff-ctl-hover); }
.mi-row:disabled { opacity: .55; cursor: default; }

.mi-icon {
    flex: 0 0 auto;
    display: grid;
    place-items: center;
    width: 28px;
    height: 28px;
    border-radius: var(--ff-r-pill);
    background: var(--ff-field);
    color: var(--ff-text-1);
}

.mi-text {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
}

.mi-title {
    font-size: 13px;
    font-weight: 500;
    color: var(--ff-text-1);
}

.mi-row-danger .mi-title { color: var(--ff-danger); }

.mi-desc {
    font-size: 12px;
    color: var(--ff-text-2);
}
</style>
