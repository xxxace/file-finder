<template>
    <div>
        <n-space>
            <n-button v-if="!modelValue" @click="handleClick" size="small">{{label}}</n-button>
            <n-tag v-else>
                <div>
                    <span>{{modelValue}}</span>
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
import { defineComponent } from 'vue';
import { NButton, NTag, NAvatar, NSpace } from 'naive-ui';
import { ipcRenderer } from 'electron';

export interface ItemFrameProps {
    modelValue?: string;
    label?: string | number;
}

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
        const handleClick = () => {
            ipcRenderer.send('openDirectory');
        };

        const onClear = () => {
            setValue('');
        }

        const setValue = (value: string) => {
            emit('update:modelValue', value);
            emit('change', value);
        }

        const folderPng: string = FolderPng;

        ipcRenderer.on('directory-changed', function (e, value) {
            setValue(value ? value[0] : '');
        });

        return {
            onClear,
            handleClick,
            folderPng
        }
    }
})
</script>

<style>

</style>