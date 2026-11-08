<template>
    <!-- 起点选择器（2026-11-08 顶栏升级）：一个 28px 的**彩色**文件夹图标。

         ⚠️ 为什么留彩色图：整条 chrome 是无彩的（中性灰），这枚彩色文件夹 + 当前段的
         红角标是顶栏**仅有的两处颜色** —— 那是"这是起点"的记忆点，换成灰图标就没了。
         主人原话："我用彩色图标是想让界面丰富些"。

         ⚠️ 为什么不再是带路径文字的 tag（原来 ≤150px）：
         起点信息其实**已经重复**在地址槽第一段（盘符）里，同一件事留两遍，
         正是"三种画法并排（彩色 chip / 文字按钮 / 面包屑）"的来源。
         全路径仍在 tooltip 里 ⇒ 一个信息都没丢。

         ⚠️ 「清除起点」仍然是**这颗图标上的 ×**：悬停才出现、绝对定位（不占宽度、
         不推面包屑）。`directory-changed` 里那条"取消 ≠ 清空"的历史坑没变。 -->
    <n-tooltip>
        <template #trigger>
            <div class="fs-root">
                <button type="button" class="fs-icon-btn" :aria-label="String(label)" @click="handleClick">
                    <img class="fs-pick-icon" :src="folderPng" alt="" />
                </button>
                <button v-if="modelValue" type="button" class="fs-clear" aria-label="清除起点"
                    @click.stop="onClear">×</button>
            </div>
        </template>
        <span class="fs-tip">{{ modelValue || label }}</span>
    </n-tooltip>
</template>

<script lang="ts">
import { computed, defineComponent, ref } from 'vue';
import FolderPng from '@/assets/folder.png';
import { NTooltip } from 'naive-ui';
import { ipcRenderer } from 'electron';

export default defineComponent({
    components: { NTooltip },
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

        ipcRenderer.on('directory-changed', function (e, value) {
            if (!isFocus.value) return;

            // ⚠️ 取消 = **一个都没选** ⇒ 那是「算了，不改」，**不是「清空」**。
            // 原来这里写的是 `setValue(value ? value[0] : '')` —— 把"取消"当成了"清空"，
            // 一路传到主界面的 `setRoot('')` ⇒ 清掉当前视图 + **整个导航历史** + 搜索词。
            // 代价大、**不可逆**（要回去得重新选根、重新逐层下钻），而且没有确认、没有撤销 ——
            // 正好撞上项目自己的原则「门槛 ∝ 不可逆 × 波及面」：一个"取消"造成最大范围的
            // 不可逆后果，是这个原则是反的。
            // 「清空」只归这颗图标上的 × —— 用户**主动点它**才是清空。
            if (!value || !value.length) {
                isFocus.value = false;   // 对话框已经关了，别让后面的事件误命中
                return;
            }
            setValue(value[0]);
        });

        /* ⚠️ 原来 tag 里用 `foldPath` 把长路径折成"首段 + … + 末段"；tag 已经没有了，
           `foldPath` 的消费点随之消失。tooltip 给的是**全路径**、不做折叠 ——
           提示里再省略一次没有任何意义（`.fs-tip` 负责换行）。 */
        const folderPng = computed(() => FolderPng as string);

        return {
            onClear,
            handleClick,
            folderPng
        }
    }
})
</script>

<style scoped>
/* 28px 的方块：与顶栏其余图标按钮**同尺寸、同圆角、同悬停色**。
   不画边框 —— 顶栏里只有"可输入 / 可选值"的面才画框（地址槽、搜索框）。 */
.fs-root {
    position: relative;
    display: inline-flex;
    flex: 0 0 auto;
}

.fs-icon-btn {
    width: 28px;
    height: 28px;
    display: grid;
    place-items: center;
    padding: 0;
    border: 0;
    border-radius: var(--ff-r-ctl);
    background: transparent;
    cursor: pointer;
    transition: background-color var(--ff-dur-hover) linear;
}

.fs-icon-btn:hover {
    background: var(--ff-ctl-hover);
}

/* 图标本身就是文件夹（用户认的就是它），不要再套一层容器给它留白 */
.fs-pick-icon {
    display: block;
    width: 16px;
    height: 16px;
    object-fit: contain;
}

/* 清除起点：悬停才出现。
   ⚠️ `position: absolute` 是硬要求 —— 若排进文档流，它一出现就把右边的
   返回 / 刷新 / 面包屑整体推 18px（hover 引起布局位移，是本项目最忌讳的一类）。
   ⚠️ 底色必须是实心 `--ff-panel`：它压在彩色图标上，透明底会读不清。 */
.fs-clear {
    position: absolute;
    top: -5px;
    right: -5px;
    /* 16 而不是 14：它触发的是**不可逆**的清空起点（清导航历史 + 视图 + 搜索词），
       命中区不能比一颗图标按钮的角还小 —— 门槛 ∝ 不可逆 × 波及面。 */
    width: 16px;
    height: 16px;
    display: grid;
    place-items: center;
    padding: 0;
    border: 1px solid var(--ff-line-strong);
    border-radius: 50%;
    background: var(--ff-panel);
    color: var(--ff-text-2);
    font-size: 10px;
    line-height: 1;
    cursor: pointer;
    opacity: 0;
    transition: opacity var(--ff-dur-hover) linear;
}

.fs-root:hover .fs-clear,
.fs-clear:focus-visible {
    opacity: 1;
}

/* 全路径可能很长：让 tooltip 自己换行，别把它撑成一条横线 */
.fs-tip {
    display: inline-block;
    max-width: 420px;
    word-break: break-all;
}
</style>
