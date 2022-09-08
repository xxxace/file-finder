<template>
    <div class="file-finder">
        <div class="header-bar">
            <n-space>
                <FolderSelector v-model="dir" />
                <n-button v-if="dir" size="small" @click="onBack">返回</n-button>
            </n-space>

            <n-space style="align-self: flex-end;" align="center">
                <n-badge :value="fileList.length" />
                <n-input ref="searchInput" v-model:value="searchText" placeholder="搜索" size="small" clearable
                    @input="handleFilter">
                    <template #prefix>
                        <n-icon :component="Search" />
                    </template>
                    <template #suffix>
                        <span class="suffix-icon">S</span>
                    </template>
                </n-input>
            </n-space>
        </div>
        <div class="image-box">
            <div v-for="(item) in fileList" :key="item.name" class="image-box-item" @dblclick="handleOpen($event,item)">
                <n-image v-if="item.type === 'image'" :src="(item.base64 as string)" :alt="item.dir" :lazy="true"
                    object-fit="contain" />
                <img v-else :src="(item.base64 as string)" :alt="item.dir"
                    :style="`width:${item.type === 'image'?'98%':'70%'}`">
                <span :title="item.name">{{item.name}}</span>
            </div>
        </div>
        <n-popover :show="popover.visible" :x="popover.x" :y="popover.y" trigger="manual" placement="bottom"
            @clickoutside="popover.visible = false">
            <n-space>
                <div v-for="(item) in popover.files" class="file-item" :key="item" @dblclick="openFile(item)"
                    :title="item">
                    <img :src="blankIcon" :alt="item" width="64">
                    <span>{{item}}</span>
                </div>
            </n-space>
        </n-popover>
    </div>
</template>

<script setup lang="ts">
import blankIcon from '@/assets/fileTypeIcon/blank.svg';
import useFileTypeIcon from '@/hooks/useFileTypeIcon';
import usePinYin from '@/hooks/usePinYin';
import { Search } from '@vicons/ionicons5';
import { NButton, NBadge, NInput, NIcon, NImage, NPopover, NSpace, useLoadingBar } from 'naive-ui';
import FolderSelector from '@/components/FolderSelector/index.vue';
import { ipcRenderer, shell } from 'electron';
import { onMounted, ref } from 'vue';
import { FileInfo } from '../../../electron/server/index';

const dir = ref('');
const popover = ref<{
    visible: boolean;
    x: number;
    y: number;
    files: string[];
    cover: FileInfo | undefined;
}>({
    visible: false,
    x: 0,
    y: 0,
    files: [],
    cover: undefined
});
const searchText = ref('');
const searchInput = ref<typeof NInput | null>(null);
const dataSource = ref<FileInfo[]>([]);
const fileList = ref<FileInfo[]>([]);
const fetchCache: { [key: string]: FileInfo[] } = {};
const searchStack = ref<string[]>([]);
const openStack = ref<{ path: string; mode: 'folder' | 'cover' }[]>([]);
const loading = useLoadingBar();

const handleOpen = (e: MouseEvent, item: FileInfo) => {
    if (item.type === 'folder') {
        const path = `${dir.value}/${item.name}`
        openStack.value.push({ path, mode: 'cover' });
        searchStack.value.push(searchText.value);
        fetchFolder(path, 'cover');
    } else {
        if (e && item.files && item.files.length > 1) {
            const { x, y } = e;
            popover.value.visible = true;
            popover.value.x = x;
            popover.value.y = y;
            popover.value.files = item.files;
            popover.value.cover = item;
        } else {
            openFile(item);
        }
    }
}
const openFile = (item: FileInfo | string) => {
    let fullpath
    if (typeof item === 'string') {
        const dir = openStack.value[openStack.value.length - 1].path;
        fullpath = `${dir}/${popover.value.cover?.name}/"${item}"`;
    } else {
        let filename
        if (item.type !== 'image') {
            filename = item.name + '.' + item.ext;
        } else if (item.type === 'image') {
            filename = item.files![0];
        } else {
            return
        }
        fullpath = `${item.dir}/"${filename}"`
    }

    // files加双引号是为了防止文件名出现空格导致cmd执行报错
    ipcRenderer.send('execFile', fullpath);
}

const fetchFolder = (path: string, mode: 'cover' | 'folder') => {
    loading.start();
    const url = `http://localhost:3060/openFolder?path=${path}&mode=${mode}`;

    searchText.value = '';

    if (fetchCache[url]) {
        dataSource.value = fetchCache[url];
        fileList.value = fetchCache[url];
        setTimeout(() => loading.finish(), 50);
    } else {
        fetch(url).then(res => {
            return res.json();
        }).then(async data => {
            await setFileTypeIcon(data);
            fetchCache[url] = data;
            dataSource.value = data;
            fileList.value = data;
            loading.finish();
        }).catch(err => {
            loading.error();
        });
    }
}

const setFileTypeIcon = async (data: FileInfo[]) => {
    for (let i = 0; i < data.length; i++) {
        const item = data[i];
        if (!item.base64) {
            item.base64 = await useFileTypeIcon(`${item.ext}`);
        }
    }
}

const onBack = () => {
    if (openStack.value.length === 1) return;
    openStack.value.pop();
    fetchFolder(openStack.value[openStack.value.length - 1].path, 'folder');
    searchText.value = searchStack.value.pop() || '';
    handleFilter(searchText.value);
}

const handleFilter = (value: string) => {
    let index = -1;
    if (/^[a-z|A-Z]/.test(value)) {
        for (let i = 0; i < value.length; i++) {
            if (/^[a-z|A-Z]/.test(value[i])) {
                index = i;
            } else {
                break;
            }
        }
    }

    const result = dataSource.value.filter(item => {
        let endIndex = index + 1;
        let startWithPinYinStr = item.name;

        if (index !== -1 && !(/^[a-z|A-Z]/.test(startWithPinYinStr))) {
            startWithPinYinStr = usePinYin(item.name.substring(0, endIndex)) + item.name.substring(endIndex, item.name.length);
        }

        startWithPinYinStr = startWithPinYinStr.toUpperCase();

        if (startWithPinYinStr.indexOf(value.toUpperCase()) !== -1) {
            return true;
        } else {
            return false;
        }
    });

    fileList.value = result;
}

ipcRenderer.on('directory-changed', function (e, value) {
    dir.value = value[0];
    openStack.value.push({ path: value[0], mode: 'folder' });
    fetchFolder(value[0], 'folder');
});

onMounted(() => {
    window.addEventListener('keyup', (e) => {
        if (e.key === 's' || e.key === 'S') {
            searchInput.value!.focus();
        }
    })
});
</script>

<style lang="less" scoped>
.file-finder {
    display: flex;
    flex-flow: column;
    padding: 10px 10px 0 10px;
    height: 100vh;
    box-sizing: border-box;

    .header-bar {
        display: flex;
        padding: 4px;
        margin-bottom: 4px;
        border-radius: 4px;
        box-shadow: 1px 0 6px rgba(113, 147, 192, 0.25);
        justify-content: space-between;

        .n-input {
            &:deep(.n-input-wrapper) {
                padding-right: 6px;

                .n-input__suffix {
                    .suffix-icon {
                        display: inline-block;
                        box-sizing: border-box;
                        padding: 7px;
                        height: 22px;
                        line-height: 8px;
                        border: 1px solid #dbdbdb;
                        border-radius: 4px;
                        color: #a1a1a1;
                    }
                }
            }
        }
    }
}

.image-box {
    flex: 1;
    display: flex;
    flex-flow: row wrap;
    overflow: hidden auto;
}

.image-box-item,
.file-item {
    --item-width: calc(100% / 6);
    display: flex;
    flex-direction: column;
    flex-grow: 0;
    flex-shrink: 0;
    width: calc(var(--item-width) - 4px);
    height: 25vh !important;
    max-height: 25vh !important;
    padding: 0 2px 10px;
    margin: 10px 2px 50px;
    border: 1px solid transparent;
    justify-content: flex-end;
    align-items: center;
    box-sizing: border-box;
    transition: all .1s ease-in-out;
    user-select: none;

    .n-image {
        height: calc(100% - 16px - 20px);
        margin: 10px 0;

        &:deep(img) {
            width: 100%;

        }
    }

    img {
        display: block;
        margin: 10px 0;
        object-fit: contain;
        overflow: hidden;
    }

    span {
        display: inline-block;
        max-height: 16px;
        line-height: 16px;
        font-size: 16px;
        word-break: break-all;
        color: #000;
        font-weight: bold;
    }

    &:hover {
        border-color: #7a8da9;
        background-color: rgba(110, 123, 173, 0.16);
        box-shadow: 1px 0 10px rgba(122, 141, 169, 0.15);
    }

    &:active {
        border-color: #525e72;
        background-color: rgba(75, 83, 116, 0.16);
    }

    // @media screen and (max-width:1200px) {
    //     --item-width: 25%;
    // }

    // @media screen and (max-width:800px) {
    //     --item-width: 50%;
    // }

    @media screen and (max-width:600px) {
        --item-width: 20%;
    }

    @media screen and (max-width:400px) {
        --item-width: 33.33%;
    }

    @media screen and (max-width:300px) {
        --item-width: 50%;
    }

    @media screen and (max-width:200px) {
        --item-width: 100%;
    }
}

.file-item {
    width: 84px !important;
    height: 84px !important;
    max-height: 84px !important;

    span {
        display: inline-block;
        max-height: 48px;
        line-height: 16px;
        font-size: 14px;
        word-break: break-all;
        text-overflow: ellipsis;
        overflow: hidden;
    }
}
</style>