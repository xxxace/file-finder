<template>
    <div class="fs-root">
        <n-space>
            <!-- 还没选根时：**只放一个文件夹图标**，不占一行字。
                 （不是表单，那句「请选择文件夹(D)」白占了 ~160px —— 而它在
                 "冷启动→从缓存记录跳进来"这条路上会和面包屑**同时出现**，真的抢地方。）
                 ⚠️ 图标按钮**必须**带 tooltip：本项目在「缓存记录」那个脚印图标上吃过亏 ——
                 只有图标、没有文字也没有 tooltip ⇒ 功能做得再好也找不到入口。
                 提示文案就是原来那个 `label`（`请选择文件夹(D)`）⇒ 快捷键提示也没丢。 -->
            <n-tooltip v-if="!modelValue">
                <template #trigger>
                    <n-button class="fs-pick" size="small" @click="handleClick">
                        <template #icon>
                            <img class="fs-pick-icon" :src="folderPng" alt="" />
                        </template>
                    </n-button>
                </template>
                {{ label }}
            </n-tooltip>
            <!-- 选中的根路径 = 一个**有界**的字符串。
                 层级深不会把它撑长：`foldPath()` 把它压成「首段 + … + 末 2 段」，
                 与"单个名字过长"是两回事，后者由下面的 max-width + 省略号兜。
                 `title` 里给**完整路径**并说明它的身份 —— 跳转之后这块 chip 可能指向
                 另一块盘（它只是"起点"，不是"你当前位置"），悬停一句话把它讲清楚，
                 不额外引一个 tooltip 去和这个 title 抢。 -->
            <n-tag v-else class="fs-tag" :title="`${modelValue}\n（这是你的起点；点 × 可清除）`">
                <div class="fs-path">
                    <span class="fs-text">{{ shownPath }}</span>
                    <n-button size="tiny" style="margin-left:6px" @click="onClear">x</n-button>
                </div>
                <template #avatar>
                    <n-avatar :src="(folderPng as string)" color="transparent" />
                </template>
            </n-tag>
        </n-space>
    </div>
</template>

<script lang="ts">
import FolderPng from '@/assets/folder.png';
import { foldPath } from '@/utils';
import { computed, defineComponent, ref } from 'vue';
import { NButton, NTag, NAvatar, NSpace, NTooltip } from 'naive-ui';
import { ipcRenderer } from 'electron';

export default defineComponent({
    components: { NButton, NTag, NAvatar, NSpace, NTooltip },
    emits: ['change', 'update:modelValue'],
    props: {
        modelValue: String,
        label: {
            type: [String, Number],
            default: '请选择文件夹'
        }
    },
    setup(props, { emit }) {
        const isFocus = ref(false);
        const handleClick = () => {
            isFocus.value = true;
            ipcRenderer.send('openDirectory');
        };

        const onClear = () => {
            setValue('');
        }

        const setValue = (value: string) => {
            isFocus.value = false;
            emit('update:modelValue', value);
            emit('change', value);
        }

        const folderPng: string = FolderPng;

        /** 显示用：层级深度被 `foldPath` 收成有界字符串（全路径仍在 `title` 里） */
        const shownPath = computed(() => foldPath(props.modelValue || ''));

        ipcRenderer.on('directory-changed', function (e, value) {
            if (!isFocus.value) return;

            // ⚠️ 取消 = **一个都没选** ⇒ 那是「算了，不改」，**不是「清空」**。
            // 原来这里写的是 `setValue(value ? value[0] : '')` —— 把"取消"当成了"清空"，
            // 一路传到主界面的 `setRoot('')` ⇒ 清掉当前视图 + **整个导航历史** + 搜索词。
            // 代价大、**不可逆**（要回去得重新选根、重新逐层下钻），而且没有确认、没有撤销 ——
            // 正好撞上项目自己的原则「门槛 ∝ 不可逆 × 波及面」：一个"取消"造成最大范围的
            // 不可逆后果，是这个原则是反的。
            // 「清空」只归 chip 上那个 × —— 用户**主动点它**才是清空。
            if (!value || !value.length) {
                isFocus.value = false;   // 对话框已经关了，别让后面的事件误命中
                return;
            }
            setValue(value[0]);
        });

        return {
            onClear,
            handleClick,
            folderPng,
            shownPath
        }
    }
})
</script>

<style scoped>
/* 单个名字过长时截断（深度问题已由 foldPath 从字符串层面解决，这里只管"一段太长"）。
   `min-width: 0` 是必需的：flex 子项默认 `min-width: auto`，不给 0 的话
   内层文本不会收窄，省略号也就不会出现。 */
.fs-tag {
    /* 初值 220px 在 820px 窗口下实测把导航区吃掉了 61%（220/362），面包屑被压成 14px 碎片；
       降到 150px。全路径永远在 `title` 里，折叠后的形状（首段 + … + 末段）也还在 ——
       它只是"起点书签"，不需要在窄窗口里霸占大半条导航区。真机可再调。 */
    max-width: 150px;
}

/* ⚠️ 这一条是收缩链的**最外一环**，漏了它整条链就断在这儿：
   `.n-tag__content` 是 n-tag 内部的 flex 子项，默认 `min-width: auto`（≈ 内容宽）
   ⇒ 它不收窄，下面 `.fs-path` / `.fs-text` 再怎么设 `min-width: 0` 都没用。
   症状：路径文本**画到盒子外面**、盖在后面几个面包屑标签上（整条头部上肉眼看不出来，
   是探针的局部放大截图抓到的；实测 文本宽 211px vs 外框 150px）。

   ⚠️ **必须写成"扁平"规则，不能把它嵌套进 `.fs-tag { ... }` 里**：
   本 style 块是**纯 CSS**（没有 `lang="less"`），嵌套的 `:deep()` 会被 CSS Nesting 搅坏 ——
   实测编译产物变成 `[data-v-x] .n-tag__content`（**`.fs-tag` 前缀整个丢了**）外加一个游离的 `}`。
   探针里"打印编译后选择器"这一步就是为了抓这种东西。 */
.fs-tag :deep(.n-tag__content) {
    min-width: 0;
    overflow: hidden;
}

.fs-path {
    display: flex;
    align-items: center;
    min-width: 0;
}

.fs-text {
    display: inline-block;
    /* ⚠️ 这一行不能少：它是 flex 子项，而 flex 子项默认 `min-width: auto`（≈ 内容宽）
       ⇒ 少了它，长路径**收缩不了**、`text-overflow` 永远不触发，
       文字会**溢出盒子盖到后面几个面包屑标签上**。
       （2026-10-01 由探针的局部放大截图抓到：溢出的字画在邻居身上，肉眼在整条头部上看不出来。） */
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

/* 图标本身就是文件夹图（用户认的就是它），不要再套一层图标容器给它留白 */
.fs-pick-icon {
    display: block;
    width: 14px;
    height: 14px;
    object-fit: contain;
}
</style>