<template>
    <!--
        主界面首页（空白区）——「这台电脑」式盘列表。

        业主 2026-11-11 的原话：主界面没加载缓存 / 没打开文件夹时是一片空白，
        每次都要先去点缓存记录或者打开文件夹。这里把那一步省掉：
        **点一块盘 = 直接进它缓存记录里最上层的那一屏**（子层不进候选，见服务端 `diskTops`）。

        ⚠️ 这是**首页**，不是内容网格。两个东西绝对不能混：
           ① 类名不要用 `.image-box-item` —— 那是内容网格的卡片，
              `useGridCursor` 会按它的 `offsetTop` 分行、把盘卡片当成"可选择条目"；
           ② 右键：首页没有"当前这一层"，空白右键（补封面 / 补全这一片 …）在这里全是空的
              ⇒ 根节点直接把 contextmenu 吞掉，别让它冒泡到 `.image-box`。
    -->
    <div class="home-disks" @contextmenu.prevent.stop @click="onBlankClick">
        <div class="hd-grid">
            <button v-for="d in disks" :key="d.key" type="button" class="hd-card"
                :class="{ 'is-off': !d.online, 'has-multi': d.tops.length > 1, 'is-selected': selectedKey === d.key }"
                :disabled="!d.tops.length"
                :aria-label="ariaOf(d)" :title="d.online ? d.name : `序列号 ${d.serial}`"
                @click="onCardClick($event, d)"
                @dblclick="onCardDblClick($event, d)"
                @keydown="onCardKeydown($event, d)">
                <img class="hd-icon" :src="diskIcon" alt="" draggable="false" />
                <span class="hd-text">
                    <!-- 状态点 + 名字同一行：**在线绿 / 离线灰**，与缓存记录页那排盘 chip 同一个语言。
                         第 1 颗点比"整张卡变灰"安静得多 —— 盘不在是当下的物理状态，
                         不是"这块内容不可用"（业主 2026-11-11：「不需要搞得像 disabled」）。 -->
                    <span class="hd-name">
                        <i class="hd-dot" :class="{ 'is-off': !d.online }" aria-hidden="true"></i>
                        <span class="hd-name-text">{{ d.name }}</span>
                    </span>
                    <span class="hd-meta">{{ d.folders }} 个目录 · {{ d.entries }} 条目</span>
                    <!-- 第三行由数据层拼好（在线=上次扫描 / 离线=上次插入），模板里不再分支 -->
                    <span v-if="d.timeLine" class="hd-meta hd-time">{{ d.timeLine }}</span>
                </span>
                <!-- 多个顶层 = 折角提示；点击折角可直接展开菜单，双击整卡同样可展开 -->
                <span v-if="d.tops.length > 1" class="hd-caret-btn" title="选择顶层目录"
                    @click.stop="onCaretClick($event, d)" @dblclick.stop>
                    <n-icon class="hd-caret" :size="14" :component="ChevronDownOutline" />
                </span>
            </button>
        </div>
    </div>

    <!-- 一块盘有**多个**顶层缓存目录时弹这个（业主 2026-11-11 裁决：不替他猜）。
         形制照「一个封面下有几个文件」那一层（Apple 纵向菜单、走 `ctx-menu.css`）——
         同一个界面里两套浮层语言只会让人多学一遍。 -->
    <n-popover :show="menu.visible" :x="menu.x" :y="menu.y" trigger="manual" placement="bottom-start"
        :show-arrow="false" @clickoutside="onOutside">
        <div class="ctx-menu ctx-menu--tops" tabindex="-1" ref="menuBox" @keydown.stop="onMenuKeydown">
            <button v-for="(t, i) in menu.tops" :key="t.relPath || '__root__'" type="button" class="ctx-item"
                :class="{ 'is-cursor': cursorOn && i === cursor }"
                @mouseenter="hoverItem(i)" @click="pick(t)">
                <n-icon :size="16" :component="FolderOutline" />
                <span class="ctx-label">{{ t.relPath || '盘根' }}</span>
                <span class="ctx-count">{{ t.count }}</span>
            </button>
        </div>
    </n-popover>
</template>

<script setup lang="ts">
/**
 * 首页盘列表（纯展示 + 本地浮层状态）。
 *
 * 数据由 `useHomeDisks` 取好之后通过 `disks` 传进来 —— 这个组件**不发请求**，
 * 它只负责"长什么样、点了去哪"。这样首页刷新时机（挂载 / 插拔盘 / 回到首页）
 * 只在页面里有一处决定，组件不需要知道。
 */
import { nextTick, ref } from 'vue';
import { NIcon, NPopover } from 'naive-ui';
import { FolderOutline, ChevronDownOutline } from '@vicons/ionicons5';
import diskIcon from '@/assets/disk-hdd.svg';
import type { DiskTop, HomeDisk } from './useHomeDisks';
// 浮层内容被 n-popover teleport 到 body，scoped 够不到 ⇒ 复用右键菜单那份非 scoped 样式
import './ctx-menu.css';

defineProps<{ disks: HomeDisk[] }>();
const emit = defineEmits<{ (e: 'open', path: string): void }>();

const ariaOf = (d: HomeDisk) =>
    `${d.name}：${d.folders} 个缓存目录、${d.entries} 个条目${d.online ? '' : '（这块盘未插入）'}`;

const selectedKey = ref<string | null>(null);

const menu = ref<{ visible: boolean; x: number; y: number; tops: DiskTop[]; key: string }>({
    visible: false, x: 0, y: 0, tops: [], key: '',
});
const cursor = ref(0);
/**
 * 高亮**只在实际交互之后出现**（业主 2026-11-11：浅色下这层的配色不对，参考右键菜单）。
 *
 * 右键菜单打开时**任何一行都不高亮**，而这一层原来一打开就把第 0 行涂上
 * `--ff-menu-hover` —— 浅色下那是 14% 黑压出来的**深灰块**，压在灰面上像"这项已被选中"，
 * 与右键菜单的观感差着一档。现在：鼠标移入 / 按方向键才亮，打开时干干净净。
 * `cursor` 仍从 0 起，所以**回车**照样能直接开第一项（看不见但可预期）。
 */
const cursorOn = ref(false);
const hoverItem = (i: number) => {
    cursor.value = i;
    cursorOn.value = true;
};
const menuBox = ref<HTMLDivElement | null>(null);

const closeMenu = () => {
    menu.value.visible = false;
    // ⚠️ 焦点必须还给 body：留在一个已隐藏的节点上时，`activeElement` 既不是 body
    // 也不是可见元素 ⇒ 网格方向键会被 `isGridKeyBlocked` 静默挡死（fileList 那层踩过）。
    (document.activeElement as HTMLElement | null)?.blur?.();
};

/**
 * 把弹层收进视口。
 * `:x/:y` 是**固定坐标**，manual 定位下 naive 不做翻转 ⇒ 靠窗口底部的那张卡
 * 从指针位置往下展开会顶出视口，最后一项被截掉。
 * ⚠️ 必须等 naive 自己写完定位再量（rAF 落在同一帧绘制前），所以不用 nextTick 代替。
 */
const clampIntoViewport = () => {
    const box = menuBox.value;
    if (!box) return;
    const r = box.getBoundingClientRect();
    const GAP = 8;
    const dy = r.bottom - (window.innerHeight - GAP);
    const dx = r.right - (window.innerWidth - GAP);
    const dTop = GAP - r.top;
    if (dy > 0) menu.value.y = Math.max(GAP, menu.value.y - dy);
    else if (dTop > 0) menu.value.y += dTop;
    if (dx > 0) menu.value.x = Math.max(GAP, menu.value.x - dx);
};

const openMenu = (e: MouseEvent | KeyboardEvent, d: HomeDisk) => {
    /**
     * 键盘触发的 click（Tab 到卡片后按回车/空格）或 keydown **没有指针坐标**：`clientX/Y` 都是 0，
     * 菜单会跑到窗口左上角（clamp 之后是 8,8）。
     * 改用卡片本身的矩形做锚点（贴着它下沿展开）。
     */
    const cardEl = (e.target as HTMLElement | null)?.closest<HTMLElement>('.hd-card')
        ?? (e.currentTarget as HTMLElement | null);
    const rect = cardEl?.getBoundingClientRect?.();
    const isMouse = 'clientX' in e && typeof (e as MouseEvent).clientX === 'number'
        && ('detail' in e ? (e as MouseEvent).detail > 0 : true);
    const useRect = !isMouse && !!rect;
    const me = e as MouseEvent;

    menu.value = {
        visible: true,
        x: useRect ? Math.round(rect!.left) : (me.clientX ?? Math.round(rect?.left ?? 0)),
        y: useRect ? Math.round(rect!.bottom + 4) : (me.clientY ?? Math.round(rect?.bottom ?? 0) + 4),
        tops: d.tops,
        key: d.key,
    };
    cursor.value = 0;
    cursorOn.value = false;          // 打开时不高亮任何一行（见 `cursorOn` 的注释）
    void nextTick(() => {
        menuBox.value?.focus();
        requestAnimationFrame(clampIntoViewport);
    });
};

const pick = (t: DiskTop) => {
    closeMenu();
    emit('open', t.path);
};

/** 打开一块盘：唯一顶层直接进；多顶层弹菜单选目录 */
const openDisk = (e: MouseEvent | KeyboardEvent, d: HomeDisk) => {
    if (!d.tops.length) return;
    if (d.tops.length === 1) {
        pick(d.tops[0]);
        return;
    }
    if (menu.value.visible && menu.value.key === d.key) {
        closeMenu();
        return;
    }
    openMenu(e, d);
};

/** 单击空白处：清掉选中态，收起菜单 */
const onBlankClick = (e: MouseEvent) => {
    const t = e.target as HTMLElement | null;
    if (!t?.closest('.hd-card')) {
        selectedKey.value = null;
        closeMenu();
    }
};

/**
 * 单击卡片：只选中、不高亮进入。
 * 遵循 Windows 资源管理器「此电脑」交互规范：单击选中，双击打开。
 */
const onCardClick = (e: MouseEvent, d: HomeDisk) => {
    selectedKey.value = d.key;
    // 键盘辅助驱动的 click（e.detail === 0）依然视为用户 Enter 打开
    if (e.detail === 0) {
        openDisk(e, d);
        return;
    }
    if (menu.value.visible && menu.value.key !== d.key) {
        closeMenu();
    }
};

/** 双击卡片：真正打开（唯一顶层直达，多顶层弹菜单） */
const onCardDblClick = (e: MouseEvent, d: HomeDisk) => {
    selectedKey.value = d.key;
    openDisk(e, d);
};

/** 键盘回车：打开选中的盘 */
const onCardKeydown = (e: KeyboardEvent, d: HomeDisk) => {
    if (e.key === 'Enter') {
        e.preventDefault();
        selectedKey.value = d.key;
        openDisk(e, d);
    }
};

/** 点击多顶层的折角按钮：直接展开/收起菜单 */
const onCaretClick = (e: MouseEvent, d: HomeDisk) => {
    selectedKey.value = d.key;
    if (!d.tops.length) return;
    if (menu.value.visible && menu.value.key === d.key) {
        closeMenu();
        return;
    }
    openMenu(e, d);
};

/**
 * 点外面收起菜单 —— 但**点卡片本身不算"外面"**：那张卡自己会 toggle（见 `onCardClick`）。
 * ⚠️ 少了这一条，capture 先关、click 又开，菜单永远关不掉。
 */
const onOutside = (e?: MouseEvent) => {
    const t = e?.target as HTMLElement | null;
    if (t?.closest?.('.hd-card')) return;
    closeMenu();
};

/**
 * 弹层内键盘。
 * 监听挂在容器上并 `.stop`（不进 window），焦点又在这一层里 ⇒ 与网格的方向键不打架。
 * ⚠️ 四个方向都收：这一层是纵向的，但用户手上的肌肉记忆来自网格（←→），
 *    只收 ↑↓ 等于让他在最熟的方向上按不动（fileList 那层同一条裁决）。
 * ⚠️ 到头不环绕 —— 这是"选哪个目录"的短列表，环绕会点错。
 */
const onMenuKeydown = (e: KeyboardEvent) => {
    const n = menu.value.tops.length;
    if (!n) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
        e.preventDefault();
        cursor.value = Math.min(cursor.value + 1, n - 1);
        cursorOn.value = true;
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
        e.preventDefault();
        cursor.value = Math.max(cursor.value - 1, 0);
        cursorOn.value = true;
    } else if (e.key === 'Enter') {
        // 长按回车会连开同一个目录（fileList 那边实测 1 秒 33 次）
        if (e.repeat) return;
        const t = menu.value.tops[cursor.value];
        if (t) pick(t);
        e.preventDefault();
    } else if (e.key === 'Escape') {
        closeMenu();
        e.preventDefault();
    }
};
</script>

<style scoped>
/* 首页根节点：父级 `.image-box` 是 grid（列数 = 密度档），这里必须跨满整行。
   ⚠️ 不设 `min-height`：首页是**内容**不是空态，居中留白会把盘推到屏幕中间。 */
.home-disks {
    grid-column: 1 / -1;
    width: 100%;
    padding-top: 2px;
}

.hd-grid {
    display: grid;
    /**
     * 卡宽 228 起；再窄「218 个目录 · 1471 条目」就要折行，两行 meta 会把卡片拉高、
     * 和旁边不等高 —— 探针量过的观感下限。
     *
     * ⚠️ 外层**不许**再设 `max-width`（2026-11-11 业主：「有空间为什么不用？应该和
     * 文件管理器一样吧」）。第一版给了个 1080px 上限，窗口一宽右边就空一大块 ——
     * 那不是"克制的留白"，那是没排满。资源管理器也是把内容铺满可视区，
     * 列数随宽度涨：`auto-fill` + `1fr` 自己就会算，不需要任何上限值。
     */
    grid-template-columns: repeat(auto-fill, minmax(228px, 1fr));
    gap: 12px;
}

.hd-card {
    position: relative;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 11px 13px;
    border: 1px solid var(--ff-line);
    border-radius: var(--ff-radius-card);
    background: var(--ff-panel);
    color: var(--ff-text-1);
    font: inherit;
    text-align: left;
    cursor: pointer;
    user-select: none;
    -webkit-user-select: none;
    /* 只动底色：位移/缩放会让一排卡片在悬停时互相推挤 */
    transition: background-color var(--ff-dur-hover) linear, border-color var(--ff-dur-hover) linear;
}

.hd-card:hover {
    background: var(--ff-raised);
    border-color: var(--ff-line-strong);
}

.hd-card:active {
    background: var(--ff-ctl-on);
}

/* 选中状态：模拟文件管理器中点击选中的视觉高亮 */
.hd-card.is-selected {
    background: var(--ff-highlight-weak);
    border-color: var(--ff-highlight-line);
}

.hd-card.is-selected:hover {
    background: var(--ff-highlight-weak);
    border-color: var(--ff-highlight);
}

.hd-card:focus-visible {
    outline: 2px solid var(--ff-line-strong);
    outline-offset: 2px;
}

.hd-card.is-selected:focus-visible {
    outline: 2px solid var(--ff-highlight);
    outline-offset: 2px;
}

.hd-card:disabled {
    cursor: default;
}

/* 离线盘：**不降级成 disabled**（业主 2026-11-11）。
   只做一件事 —— 图标去彩（灯灭）。卡片底色、描边、文字、悬停全部与在线相同：
   "这块盘此刻不在"是物理状态，不是"这块内容不可用"。
   ⚠️ 仍然**只给一枚图标资产** + 滤镜：两枚资产迟早画得不一样。 */
.hd-card.is-off .hd-icon {
    filter: grayscale(1);
}

/* 有折角的卡多留 17px 右边距：折角是绝对定位、不占位，不留出来它就会压在
   meta 行最后几个字上（"上次扫描 11-08" 的日期正好在那） */
.hd-card.has-multi {
    padding-right: 30px;
}

.hd-icon {
    flex: 0 0 auto;
    /* 44×33：比正文那一摞（≈45px）矮，所以**不会撑高卡片** ——
       但它决定了这张卡"像不像一块硬盘"，40px 时指示灯和凹槽都开始糊。
       宽高比必须跟 viewBox（48×36）一致，否则硬盘会被拉扁。 */
    width: 44px;
    height: 33px;
    /* 拟物图自带描边，别再加投影：卡片本身是平的，一个投影就把语言拆成两套 */
    display: block;
}

.hd-text {
    display: flex;
    flex-direction: column;
    min-width: 0;
    gap: 2px;
}

.hd-name {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    font-size: 13px;
    font-weight: 500;
    line-height: 1.3;
}

/* 盘符 / 序列号都可能很长：只截这一行，meta 行不动（所以省略号挂在文字那一段上，
   不能挂在这个 flex 容器上 —— 挂了连状态点一起截掉） */
.hd-name-text {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

/* 状态点 6px：够看清颜色，又不抢标题。`flex: 0 0 auto` 保证长盘名不会把它压扁。 */
.hd-dot {
    flex: 0 0 auto;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--ff-status-ok);
}

.hd-dot.is-off {
    /* 灰而不是空：离线也要看得出"这块盘有身份，只是没插" */
    background: var(--ff-text-2);
    opacity: 0.8;
}

.hd-meta {
    font-size: 12px;
    color: var(--ff-text-2);
    line-height: 1.35;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.hd-time {
    color: var(--ff-text-3);
}

/* 「点下去会弹菜单」的折角按钮。绝对定位在右下角，不挤占第三行文本宽度 */
.hd-caret-btn {
    position: absolute;
    right: 4px;
    bottom: 4px;
    width: 24px;
    height: 24px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: var(--ff-radius-ctl, 4px);
    color: var(--ff-text-3);
    cursor: pointer;
    transition: background-color var(--ff-dur-hover) linear, color var(--ff-dur-hover) linear;
}

.hd-caret-btn:hover {
    background: var(--ff-ctl-on);
    color: var(--ff-text-1);
}

.hd-caret {
    pointer-events: none;
}

</style>
