<template>
    <!-- ⚠️ 2026-11-08 主人裁决：备份与迁移**整体抽离、暂时不放出来**，
         后续要移进设置页。功能与文案一字未动，挂载时直接用：
         `<BackupPanel @migrated="reloadAfterDataChange" />`（还原/合并成功后会 emit）。 -->
    <n-collapse class="backup-collapse">
        <n-collapse-item title="备份与迁移" name="migrate">
            <div class="backup-row">
                <n-button size="small" :loading="backupLoading" @click="handleBackupToFile">备份到一个文件…</n-button>
                <span class="backup-hint">默认文件名带你今天的日期，位置自己挑 —— 不会被任何东西覆盖</span>
            </div>
            <div class="backup-row">
                <!-- 唯一着色的一条：这一组里只有它是"整份替换"（合并只增不删）。
                     2026-11-08 二轮 Apple 化：`quaternary` = 红字无底 —— macOS 的破坏性
                     动作从来是**红文字**（HIG 原文：用红色的文本来强调具有破坏性的操作），
                     不是一枚红色实心钮。红仍然在，只是不再咄咄逼人。 -->
                <n-button size="small" type="error" quaternary @click="handleRestoreFromFile">从文件还原…</n-button>
                <span class="backup-hint warn">缓存整份替换；收藏夹只增不删</span>
            </div>
            <div class="backup-row">
                <n-button size="small" :loading="bulkLoading" @click="handleMergeCache">合并缓存…</n-button>
                <span class="backup-hint">只增不删（新增 / 覆盖 / 跳过 会报给你）</span>
            </div>
            <!-- 「打开存放文件夹」从顶部挪到这儿（2026-10-04，用户提的）。
                 原来把它留在折叠区外面，理由是"它不碰任何数据，别藏起来"——那个理由站不住：
                 这个折叠区本来就不是纯危险区（备份是安全的、合并只增不删），
                 真正危险的只有「从文件还原」，而它是靠**自己那身红色**标出来的，不是靠分组。
                 而且它和上面三项本就是同一件事的两面：那三项是**自动**搬运整库，
                 这一项是**手动**搬运的入口（缓存库、图片、备份都躺在那个文件夹里）。
                 ⚠️ 代价与补偿：位置原本承担着"这是安全出口"的信号，现在这信号改由 hint 明说。
                 见 docs/DESIGN-DISK-FILTER-2026-10-04.md §11。 -->
            <div class="backup-row">
                <n-button size="small" @click="openDataDir">打开存放文件夹</n-button>
                <span class="backup-hint">只打开文件夹、不动任何数据（缓存库、图片和备份都在这儿）</span>
            </div>
        </n-collapse-item>
    </n-collapse>
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
import { NButton, NCollapse, NCollapseItem } from 'naive-ui';
import useNotify from '@/hooks/useNotify';
import useConfirm from '@/hooks/useConfirm';
import { refreshIndex } from '@/views/FileFinder/playlist';
import { postAction } from '@/utils/request';

// 统一写 127.0.0.1 而不是 localhost，避免个别机器把 localhost 解析到 ::1（服务端只绑 IPv4）
const API_BASE = 'http://127.0.0.1:3060';

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
/* 这些类只服务本组件；宿主页面（缓存页 / 将来的设置页）各自的分隔与留白自己管。 */
.backup-collapse {
    margin-top: 6px;
}

.backup-row {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
    padding: 5px 0;
}

.backup-hint {
    font-size: 12px;
    color: var(--ff-text-2);
}

.backup-hint.warn {
    color: var(--ff-warn);
}
</style>
