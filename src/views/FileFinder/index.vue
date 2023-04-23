<template>
    <div class="file-finder">
        <div class="header-bar">
            <n-space>
                <FolderSelector ref="folderSelector" v-model="dir" label="请选择文件夹(D)" @change="handleDirChange" />
                <template v-for="(folder, index) in openStack">
                    <n-tag v-if="!!folder.name" :key="folder.name" @click="handleJump(folder, index)"
                        style="cursor:pointer">
                        <span>{{ folder.name }}</span>
                        <n-spin v-if="loading" :size="12" style="margin-left: 8px;" />
                    </n-tag>
                </template>
                <n-button v-if="dir" size="small" @click="onBack">返回</n-button>
            </n-space>
            <n-space>
                <FolderSelector v-model="dirRoot" label="请选择文件夹2(D)" @change="handleDirRootChange" />
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
                <n-button size="small" @click="onRefresh">
                    <template #icon>
                        <n-icon>
                            <Refresh />
                        </n-icon>
                    </template>
                </n-button>
            </n-space>
        </div>
        <div class="image-box" ref="imageBox">
            <div v-for="(item) in fileList" :key="item.name" class="image-box-item" @dblclick="handleOpen($event, item)"
                :title="item.name + ' ' + getSize(item.size) || ''">
                <n-image v-if="item.type === 'image' || item.type === 'video'" :src="(item.base64 as string)"
                    :alt="item.dir" :lazy="true" objectFit="contain" />
                <img v-else-if="item.type === 'folder'" :src="folderIcon" :alt="item.dir" :style="`width:70%`">
                <div v-else :alt="item.dir" :class="`file-cover fiv-cla fiv-icon-${item.ext}`"
                    :style="`width:70%;font-size: .6rem`"></div>
                <span>{{ item.name }}</span>
            </div>
        </div>
        <n-popover :show="popover.visible" :x="popover.x" :y="popover.y" trigger="manual" placement="bottom"
            @clickoutside="popover.visible = false">
            <n-space>
                <div v-for="(item) in popover.files" class="file-item" :key="item" @dblclick="openFile(item)"
                    :title="item">
                    <div class="file-cover" :alt="item" width="64"></div>
                    <span>{{ item }}</span>
                </div>
            </n-space>
        </n-popover>
    </div>
</template>

<script setup lang="ts">
import { parseSize, printTree } from '@/utils';
import folderIcon from '@/assets/fileTypeIcon/folder.png';
// import useFileTypeIcon from '@/hooks/useFileTypeIcon';
import usePinYin from '@/hooks/usePinYin';
import { Search, Refresh } from '@vicons/ionicons5';
import { NButton, NBadge, NInput, NIcon, NImage, NTag, NPopover, NSpin, NSpace, useLoadingBar } from 'naive-ui';
import FolderSelector from '@/components/FolderSelector/index.vue';
import { ipcRenderer } from 'electron';
import { onMounted, onUnmounted, ref } from 'vue';
import { FileInfo } from '../../../electron/server/index';

export interface IOpenInfo { name?: string; path: string; mode: 'folder' | 'cover', scrollY?: number }

const dir = ref('');
const dirRoot = ref('');
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
const imageBox = ref<HTMLDivElement | null>(null)
const folderSelector = ref<typeof FolderSelector | null>(null);
const searchInput = ref<typeof NInput | null>(null);
const dataSource = ref<FileInfo[]>([]);
const fileList = ref<FileInfo[]>([]);
const fetchCache: { [key: string]: FileInfo[] } = {};
const searchStack = ref<string[]>([]);
const openStack = ref<IOpenInfo[]>([]);
const loading = ref(false);
const loadingBar = useLoadingBar();

const getSize = (size: number | undefined) => {
    if (size) {
        const s = parseSize(size);
        if (s.gb) return `${s.gb.toFixed(2)}GB`;
        if (s.mb) return `${s.mb.toFixed(2)}MB`;
        if (s.kb) return `${s.kb.toFixed(2)}KB`;
    }
}

const handleOpen = (e: MouseEvent, item: FileInfo) => {
    if (loading.value) return;
    if (item.type === 'folder') {
        const path = `${dir.value}/${item.name}`
        if (openStack.value.length) {
            openStack.value[openStack.value.length - 1].scrollY = imageBox.value?.scrollTop
        }

        openStack.value.push({ path, mode: 'cover', name: item.name });
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
        fullpath = `${dir}/"${popover.value.cover?.name}"/"${item}"`;
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
    const formatPath = fullpath.split('/');
    if (formatPath.length > 2) formatPath[formatPath.length - 2] = `"${formatPath[formatPath.length - 2]}"`;
    fullpath = formatPath.join("/");
    ipcRenderer.send('execFile', fullpath);
}

const fetchFolder = (path: string, mode: 'cover' | 'folder') => {
    loading.value = true;
    loadingBar.start();
    const url = `http://localhost:3060/openFolder?path=${path}&mode=${mode}`;

    searchText.value = '';

    if (fetchCache[url]) {
        dataSource.value = fetchCache[url];
        fileList.value = fetchCache[url];
        setTimeout(() => {
            loadingBar.finish()
            loading.value = false;
        }, 50);
    } else {
        fetch(url).then(res => {
            return res.json();
        }).then(async data => {
            // await setFileTypeIcon(data);
            fetchCache[url] = data;
            dataSource.value = data;
            fileList.value = data;
            loadingBar.finish();
        }).catch(err => {
            loadingBar.error();
        }).finally(() => {
            loading.value = false;
        });
    }
}

const handleDirRootChange = (value: string) => {
    if (!value) return
    const url = `http://localhost:3060/getFileTree?path=${value}`;
    fetch(url).then(res => {
        return res.json();
    }).then(async data => {
        // printTree(data, 0, 2, ``)
        // console.log(printTree(data, 0, 2, ``))
        console.log(encodeURIComponent(printTree(data, 0, 2, ``)))
        loadingBar.finish();
    }).catch(err => {
        loadingBar.error();
    }).finally(() => {
        loading.value = false;
    });
}

// const setFileTypeIcon = async (data: FileInfo[]) => {
//     for (let i = 0; i < data.length; i++) {
//         const item = data[i];
//         if (!item.base64) {
//             item.base64 = await useFileTypeIcon(`${item.ext}`);
//         }
//     }
// }

const onBack = () => {
    if (openStack.value.length === 1) return;
    openStack.value.pop();
    const to = openStack.value[openStack.value.length - 1];
    fetchFolder(to.path, to.mode);
    searchText.value = searchStack.value.pop() || '';
    handleFilter(searchText.value);
    if (to.scrollY) {
        setTimeout(() => imageBox.value?.scrollTo(0, to.scrollY || 0), 10)
    }
}

const onRefresh = () => {
    if (!loading.value && openStack.value.length) {
        const to = openStack.value[openStack.value.length - 1];
        const query = searchText.value;
        const url = `http://localhost:3060/openFolder?path=${to!.path}&mode=${to!.mode}`;
        if (fetchCache[url]) delete fetchCache[url];
        fetchFolder(to!.path, to!.mode);
        searchText.value = query;
        handleFilter(searchText.value);
    }
}

const handleDirChange = (value: string) => {
    // 切换主目录时清空所有栈
    if (!value) {
        openStack.value = [];
        searchStack.value = []
    } else {
        dir.value = value;
        openStack.value = [];
        searchStack.value = [];
        openStack.value.push({ path: value, mode: 'folder' });
        fetchFolder(value, 'folder');
    }
}

const handleJump = (to: IOpenInfo, index: number) => {
    if (index === openStack.value.length - 1) return;
    openStack.value = openStack.value.slice(0, index + 1);
    searchStack.value = searchStack.value.slice(0, index + 1);

    fetchFolder(to.path, to.mode);
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

onMounted(() => {
    const handler = (e: KeyboardEvent) => {
        if (e.target === document.body) {
            if (e.key.toUpperCase() === 'S') {
                searchInput.value!.focus();
            } else if (e.key === 'F5') {
                onRefresh();
            } else if (e.key.toUpperCase() === 'D') {
                folderSelector.value!.handleClick();
            }
        }
    };

    window.addEventListener('keyup', handler);

    onUnmounted(() => {
        window.removeEventListener('keyup', handler);
    });
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
                padding-top: 1px;
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
    justify-content: flex-start;
    align-content: flex-start;
}

.image-box-item,
.file-item {
    --item-gap: 10px;
    --item-width: calc(100% / 6);
    --item-height: 1.5rem;
    display: flex;
    flex-direction: column;
    flex-grow: 0;
    flex-shrink: 0;
    width: calc(var(--item-width) - var(--item-gap));
    min-height: 80px !important;
    height: var(--item-height) !important;
    max-height: var(--item-height) !important;
    padding: 0 2px 10px;
    margin: 10px 5px 0px;
    border: 1px solid transparent;
    justify-content: flex-end;
    align-items: center;
    box-sizing: border-box;
    transition: all .1s ease-in-out;
    user-select: none;
    font-size: 16px;

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
        width: 100%;
        height: 38px !important;
        line-height: 1em;
        font-size: 1em;
        color: #000;
        font-weight: bold;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        text-align: center;
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

    @media screen and (max-width:1100px) {
        font-size: 12px;
    }

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

.file-cover {
    display: block;
    margin: 10px 0;
    object-fit: contain;
    overflow: hidden;
    background-image: url(@/assets/fileTypeIcon/blank.svg);
}
</style>