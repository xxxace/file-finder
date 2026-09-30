<template>
    <div class="fs-root">
        <n-space>
            <n-button v-if="!modelValue" @click="handleClick" size="small">{{ label }}</n-button>
            <!-- 选中的根路径 = 一个**有界**的字符串。
                 层级深不会把它撑长：`foldPath()` 把它压成「首段 + … + 末 2 段」，
                 与"单个名字过长"是两回事，后者由下面的 max-width + 省略号兜（全名进 title）。
                 ⚠️ 不用 CSS 的 `direction: rtl` 做反向截断：那会把 `E:/` 里的 `/` 排到错位置。 -->
            <n-tag v-else class="fs-tag" :title="modelValue">
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
import { NButton, NTag, NAvatar, NSpace } from 'naive-ui';
import { ipcRenderer } from 'electron';

export default defineComponent({
    components: { NButton, NTag, NAvatar, NSpace },
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
            if (isFocus.value) setValue(value ? value[0] : '');
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
    max-width: 220px;
}

.fs-path {
    display: flex;
    align-items: center;
    min-width: 0;
}

.fs-text {
    display: inline-block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
</style>