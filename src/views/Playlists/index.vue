<template>
    <!-- 清单页：全部清单的卡片网格（**不是 table**）。左键进详情，右键出重命名/删除。
         2026-10-21 从弹窗改成**路由页** —— 它是"目的地"，不是当前屏的一个动作。
         判据见 docs/DESIGN-BILIBILI-2026-10-21.md：关掉后要不要回到刚才那一屏。 -->
    <div class="page">
        <header class="page-head">
            <h1>我的收藏</h1>
            <span class="page-sub">{{ index.playlists.length }} 个 · 点卡片进入</span>
        </header>

        <div class="pl-shelf">
            <div v-for="pl in index.playlists" :key="pl.id" class="pl-card" @click="open(pl)"
                @contextmenu.prevent="openMenu($event, pl)">
                <!-- 封面拼格：前 4 个有条目的缩略图（bin 仓取，零读盘）。
                     按张数换版式（1 张铺满 / 2 张并排 / 3 张左大右二 / 4 张田字），
                     空清单给虚线占位 —— 不留一块白板。 -->
                <div class="pl-cover" :class="`c${Math.min(pl.covers.length, 4)}`">
                    <img v-for="c in pl.covers.slice(0, 4)" :key="c" :src="thumbUrl(c)" alt="" />
                    <n-icon v-if="!pl.covers.length" :component="BookmarkOutline" :size="26" class="pl-cover-empty" />
                </div>
                <n-input v-if="editing && editing.id === pl.id" v-model:value="editing.name" size="small" autofocus
                    class="pl-name-input" @keyup.enter="commitEdit(pl.id)" @keyup.esc="editing = null" @click.stop
                    @blur="commitEdit(pl.id)" />
                <div v-else class="pl-name" :title="pl.name">{{ pl.name }}</div>
                <div class="pl-count">{{ pl.count }} 个条目<span v-if="pl.system" class="pl-sys">默认</span></div>
            </div>
            <!-- 末位：新建。点它 = **原地**变成输入框，回车即建（不弹 dialog）。
                 ⚠️ 输入框必须长在这张卡里：以前只在 `v-for` 的已有清单上渲染
                 （`editing.id === pl.id`），而新建的 id 是 `'new'` —— 永远匹配不到，
                 点了什么都没发生（2026-10-21 主人报的"新建没反应"）。 -->
            <div class="pl-card pl-card-new" @click="startCreate">
                <div class="pl-cover pl-cover-new">
                    <n-icon :component="AddOutline" :size="24" />
                </div>
                <n-input v-if="editing && editing.id === 'new'" v-model:value="editing.name" size="small" autofocus
                    class="pl-name-input" placeholder="名称" @keyup.enter="commitEdit('new')" @keyup.esc="editing = null"
                    @click.stop @blur="commitEdit('new')" />
                <template v-else>
                    <div class="pl-name">新建收藏夹</div>
                    <div class="pl-count">收集一类文件</div>
                </template>
            </div>
            <div v-if="!index.playlists.length && !editing" class="pl-empty">还没有收藏夹 —— 点右边「新建收藏夹」开始</div>
        </div>

        <!-- 右键菜单（复刻主网格那套手动定位浮层：:x/:y/:show + trigger="manual"） -->
        <n-popover :show="menu.visible" :x="menu.x" :y="menu.y" trigger="manual" placement="bottom-start"
            @clickoutside="closeMenu">
            <div class="pl-menu-row">
                <n-button size="small" @click="startRename">重命名</n-button>
                <n-button size="small" @click="confirmDelete">删除…</n-button>
            </div>
        </n-popover>
    </div>
</template>

<script setup lang="ts">
import { onActivated, onMounted, ref } from 'vue';
import { NButton, NIcon, NInput, NPopover, useDialog } from 'naive-ui';
import { useRouter } from 'vue-router';
import { AddOutline, BookmarkOutline } from '@vicons/ionicons5';
import { apiUrl } from '@/utils/request';
import useNotify from '@/hooks/useNotify';
import {
    createPlaylist, deletePlaylist, playlistIndex, refreshIndex, renamePlaylist,
} from '@/views/FileFinder/playlist';
import { openInFiles } from '@/views/FileFinder/target';

const router = useRouter();
const notify = useNotify();

const index = playlistIndex();
const dialog = useDialog();

const API_BASE = 'http://127.0.0.1:3060';
const thumbUrl = (k: string) => apiUrl(`${API_BASE}/thumb?k=${encodeURIComponent(k)}`);

/** 行内编辑：id = 'new' 表示新建，否则是清单 id */
const editing = ref<{ id: string; name: string } | null>(null);
const menu = ref<{ visible: boolean; x: number; y: number; id: string; name: string; count: number }>(
    { visible: false, x: 0, y: 0, id: '', name: '', count: 0 },
);

// 索引还没取过（冷启动第一次进这页）就取一次 —— 之后共享模块级状态，不再重复取。
// ⚠️ 首次挂载与"从别的页切回来"各调一次：`index.loaded` 是幂等闸门。
const ensureIndex = () => {
    if (!index.loaded) void refreshIndex().catch(() => undefined);
};
onMounted(ensureIndex);
onActivated(ensureIndex);

const open = (pl: { id: string; name: string }) => {
    if (editing.value) return;    // 正在改名/新建时不触发进入
    // 详情是**文件页里的一种屏**（主网格 + 面包屑 + 返回），所以跳回文件页再开
    openInFiles({ kind: 'playlist', id: pl.id, name: pl.name });
    void router.push('/');
};

// ── 右键菜单 ────────────────────────────────────────────────────────────────
const openMenu = (e: MouseEvent, pl: { id: string; name: string; system: boolean; count: number }) => {
    if (pl.system) return;        // 默认清单不可删不可改，不出菜单（通过才改）
    menu.value = { visible: true, x: e.clientX, y: e.clientY, id: pl.id, name: pl.name, count: pl.count };
};
const closeMenu = () => { menu.value.visible = false; };

const startRename = () => {
    const m = menu.value;
    closeMenu();
    editing.value = { id: m.id, name: m.name };
};

const confirmDelete = () => {
    const m = menu.value;
    closeMenu();
    dialog.warning({
        title: '删除这个收藏夹？',
        content: `「${m.name}」里的 ${m.count} 个条目会一起移除（硬盘上的文件不动）`,
        positiveText: '删除',
        negativeText: '取消',
        onPositiveClick: async () => {
            try {
                await deletePlaylist(m.id);
            } catch (e) {
                notify('error', '收藏夹操作失败', String(e));
            }
        },
    });
};

// ── 行内编辑（新建 / 重命名共用） ───────────────────────────────────────────
const startCreate = () => {
    if (editing.value?.id === 'new') return;   // 已经在输入了，别把用户刚打的字清掉
    editing.value = { id: 'new', name: '' };
};

/**
 * 提交行内编辑。
 * ⚠️ 必须带 `id`：失焦与回车都可能来自**上一张卡**（点了「新建」后旧输入框被卸载时会补一次 blur）
 * ⇒ 只按"当前 editing"判断，会把刚打开的新建输入框当场关掉。id 对不上就什么都不做。
 */
const commitEdit = async (id: string) => {
    const ed = editing.value;
    if (!ed || ed.id !== id) return;
    editing.value = null;
    const name = ed.name.trim();
    if (!name) return;
    try {
        if (ed.id === 'new') await createPlaylist(name);
        else await renamePlaylist(ed.id, name);
    } catch (e) {
        notify('error', '收藏夹操作失败', String(e));
    }
};
</script>

<style lang="less" scoped>
/* 页容器：整页自己滚（清单多起来不用把布局撑破） */
.page {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    padding: 20px 24px 24px;
    box-sizing: border-box;
}

.page-head {
    display: flex;
    align-items: baseline;
    gap: 10px;
    margin-bottom: 16px;

    h1 {
        margin: 0;
        font-size: 16px;
        font-weight: 500;
        color: var(--ff-text-1);
    }

    .page-sub {
        font-size: 12px;
        color: var(--ff-text-3);
    }
}

.pl-shelf {
    /* 收在 1200px：再多列也保持"卡片"而不是"色板"。 */
    max-width: 1200px;
    padding: 2px 2px 20px;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(164px, 1fr));
    gap: 20px 16px;
    align-content: start;
}

/*
 * 卡片：本身不带底色/边框，**封面就是卡片**（B 站收藏夹那套）。
 * 2026-10-21：原来 hover 铺一层 `#f6f7f9` 白底 + 阴影 —— 深色主题下就是一块白板，
 * 上面的标题也跟着看不清。改成"封面浮起 + 标题变蓝"，靠阴影与颜色表达，不靠底色。
 */
.pl-card {
    display: flex;
    flex-direction: column;
    min-width: 0;
    padding: 0;
    cursor: pointer;

    &:hover .pl-cover {
        box-shadow: 0 8px 20px rgba(0, 0, 0, .35);
    }

    &:hover .pl-name {
        color: var(--ff-blue);
    }
}

.pl-cover {
    position: relative;
    aspect-ratio: 1 / 1;
    display: grid;
    gap: 2px;
    border-radius: var(--ff-radius-card);
    overflow: hidden;
    background: var(--ff-fill);
    transition: box-shadow .18s ease;

    img {
        width: 100%;
        height: 100%;
        object-fit: cover;
        display: block;
    }
}

/* 拼格按张数换版式 —— 张数不足时不留白格（1 张铺满 / 2 张并排 / 3 张左大右二 / 4 张田字） */
.pl-cover.c1 { grid-template-columns: 1fr; }
.pl-cover.c2 { grid-template-columns: 1fr 1fr; }
.pl-cover.c3 {
    grid-template-columns: 2fr 1fr;
    grid-template-rows: 1fr 1fr;
    img:first-child { grid-row: span 2; }
}
.pl-cover.c4 {
    grid-template-columns: 1fr 1fr;
    grid-template-rows: 1fr 1fr;
}

/* 空收藏夹：一块安静的底板 + 淡图标。
   ⚠️ **不再用虚线** —— 虚线是"可新建"的语义，两个都画成虚线，用户分不清
   "这是个空夹子"和"这里能新建"。 */
.pl-cover.c0 {
    background: var(--ff-fill);
    border: 0;
}

.pl-cover-empty,
.pl-cover-new {
    :deep(.n-icon) {
        position: absolute;
        inset: 0;
        margin: auto;
        color: var(--ff-text-3);
    }
}

.pl-cover-empty {
    opacity: .55;
}

/* 新建：虚线 = 可添加；悬停变粉（与左轨选中同一套语义） */
.pl-card-new .pl-cover-new {
    background: transparent;
    border: 1.5px dashed var(--ff-line);
    transition: border-color .16s ease;

    :deep(.n-icon) {
        opacity: .7;
    }
}

.pl-card-new:hover .pl-cover-new {
    border-color: var(--ff-pink);
}

.pl-card-new:hover .pl-name {
    color: var(--ff-pink);
}

.pl-name {
    margin-top: 8px;
    font-size: 14px;
    font-weight: 400;
    line-height: 20px;
    color: var(--ff-text-1);
    transition: color .15s ease;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.pl-name-input {
    width: 100%;
    margin-top: 8px;
}

.pl-count {
    margin-top: 2px;
    font-size: 12px;
    color: var(--ff-text-3);
    display: flex;
    align-items: center;
    gap: 6px;
}

/* 「默认」标签：弱粉底 + 粉字（原来是一块白底，深色主题里像贴了张便签） */
.pl-sys {
    font-size: 11px;
    line-height: 16px;
    padding: 0 5px;
    border-radius: 4px;
    background: var(--ff-pink-weak);
    color: var(--ff-pink);
}

.pl-empty {
    grid-column: 1 / -1;
    color: var(--ff-text-3);
    font-size: 13px;
    padding: 24px 0;
    text-align: center;
}

.pl-menu-row {
    display: flex;
    gap: 6px;
}
</style>
