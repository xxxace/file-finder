<template>
    <div class="tunnel-page">
        <!-- 加载中状态 -->
        <div v-if="loading" class="tunnel-loading">
            <n-spin size="large" />
            <div class="loading-text">正在汇聚全库已缓存封面...</div>
        </div>

        <!-- 封面空状态 -->
        <div v-else-if="covers.length === 0" class="tunnel-empty">
            <div class="empty-card">
                <div class="empty-icon">
                    <svg viewBox="0 0 24 24" width="48" height="48">
                        <path fill="currentColor" d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H5V5h14v14zm-5-7l-3 3.72L9 13l-3 4h12l-4-5z" />
                    </svg>
                </div>
                <div class="empty-title">暂无已缓存的封面</div>
                <div class="empty-desc">请先在「文件」中浏览移动硬盘或本地磁盘，扫描包含作品封面的目录。</div>
                <button type="button" class="empty-btn" @click="goHome">
                    前往文件浏览
                </button>
            </div>
        </div>

        <!-- 3D 封面漫游画廊主体 -->
        <AlbumCoverTunnel
            v-else
            :items="covers"
            :theme="isDark ? 'dark' : 'light'"
            :show-back="true"
            :disks="disks"
            :selected-serial="selectedSerial"
            @select="handleSelect"
            @navigate-dir="handleNavigateDir"
            @change-serial="handleSerialChange"
            @back="goHome"
        />
    </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { NSpin } from 'naive-ui';
import { ipcRenderer } from 'electron';
import AlbumCoverTunnel from '@/components/AlbumCoverTunnel/AlbumCoverTunnel.vue';
import type { TunnelCover } from '@/components/AlbumCoverTunnel/types';
import { API_BASE, getAction, apiUrl } from '@/utils/request';
import { openInFiles } from '@/views/FileFinder/target';
import useNotify from '@/hooks/useNotify';
import { useTheme } from '@/hooks/useTheme';

const router = useRouter();
const notify = useNotify();
const { isDark } = useTheme();

const loading = ref(true);
const covers = ref<TunnelCover[]>([]);
const disks = ref<Array<{ serial: string; name: string }>>([]);
const selectedSerial = ref('');

const VIDEO_EXT_RE = /\.(mp4|mkv|avi|wmv|mov|flv|webm|ts|m4v)$/i;

function shuffle<T>(arr: T[]): T[] {
    const res = [...arr];
    for (let i = res.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [res[i], res[j]] = [res[j], res[i]];
    }
    return res;
}

async function loadDisks() {
    try {
        const res = await getAction(`${API_BASE}/getDisks`);
        if (res && res.code === 200 && Array.isArray(res.data?.disks)) {
            disks.value = res.data.disks.map((d: any) => ({
                serial: d.serial,
                name: d.letter ? `${d.letter}盘 (${d.name || d.serial})` : `${d.name || d.serial} (离线)`,
            }));
        }
    } catch {
        // ignore
    }
}

async function loadAllCovers(serial?: string) {
    loading.value = true;
    try {
        const url = `${API_BASE}/getAllCovers${serial ? `?serial=${encodeURIComponent(serial)}` : ''}`;
        const res = await getAction(url);
        if (res && res.code === 200 && Array.isArray(res.data?.items)) {
            const rawItems = res.data.items as Array<{
                id: string;
                name: string;
                dir: string;
                serial: string;
                sig: string;
                type: string;
                ext?: string;
                size?: number;
                files?: Array<{ name: string; size: number }>;
            }>;

            const list = rawItems.map((item) => ({
                id: item.id,
                title: item.name,
                src: apiUrl(`${API_BASE}/thumb?k=${encodeURIComponent(`t-${item.sig}.enc`)}`),
                raw: item,
            }));
            covers.value = shuffle(list);
        } else {
            covers.value = [];
        }
    } catch (e) {
        console.error('[TunnelPage] Failed to load covers:', e);
        notify('error', '获取全库封面失败', String(e));
        covers.value = [];
    } finally {
        loading.value = false;
    }
}

function handleSerialChange(serial: string) {
    selectedSerial.value = serial;
    void loadAllCovers(serial);
}

async function handleSelect(cover: TunnelCover) {
    const raw = cover.raw;
    if (!raw) return;

    // 寻找视频文件或首个文件
    const video = raw.files?.find((f: { name: string }) => VIDEO_EXT_RE.test(f.name));
    const filename = video?.name || raw.files?.[0]?.name || (raw.ext ? `${raw.name}.${raw.ext}` : raw.name);
    const target = `#${raw.serial}/${raw.dir ? `${raw.dir}/` : ''}${filename}`;

    try {
        const res = await getAction(`${API_BASE}/resolveAnchor?path=${encodeURIComponent(target)}`);
        if (res?.path) {
            const err = await ipcRenderer.invoke('openFile', res.path);
            if (err) {
                notify('error', '打开失败', err);
            }
        } else {
            notify('warning', '磁盘未在线', `文件所在磁盘（序列号 ${raw.serial}）当前未连接。`);
        }
    } catch (e: any) {
        if (e?.kind === 'offline' || e?.message?.includes('不在') || String(e).includes('offline')) {
            notify('warning', '磁盘未在线', `文件所在磁盘（序列号 ${raw.serial}）当前未连接。`);
        } else {
            notify('error', '打开出错', String(e));
        }
    }
}

function handleNavigateDir(cover: TunnelCover) {
    const raw = cover.raw;
    if (!raw) return;

    const targetPath = `#${raw.serial}${raw.dir ? `/${raw.dir}` : ''}`;
    openInFiles({ kind: 'path', path: targetPath });
    void router.push('/');
}

function goHome() {
    void router.push('/');
}

onMounted(() => {
    void loadDisks();
    void loadAllCovers();
});
</script>

<style scoped>
.tunnel-page {
    position: relative;
    width: 100%;
    height: 100%;
    overflow: hidden;
    background: #05060f;
}

.tunnel-loading {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    width: 100%;
    height: 100%;
    gap: 20px;
    background: #05060f;
    color: rgba(255, 255, 255, 0.7);
    font-size: 14px;
}

.loading-text {
    letter-spacing: 0.05em;
    color: #c084fc;
}

.tunnel-empty {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    height: 100%;
    background: #05060f;
}

.empty-card {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    max-width: 420px;
    padding: 40px 32px;
    background: rgba(18, 20, 36, 0.75);
    backdrop-filter: blur(20px);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 20px;
    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.5);
}

.empty-icon {
    width: 72px;
    height: 72px;
    display: grid;
    place-items: center;
    border-radius: 50%;
    background: rgba(168, 85, 247, 0.12);
    color: #c084fc;
    margin-bottom: 20px;
}

.empty-title {
    font-size: 18px;
    font-weight: 600;
    color: #f1f5f9;
    margin-bottom: 8px;
}

.empty-desc {
    font-size: 13px;
    line-height: 1.6;
    color: rgba(255, 255, 255, 0.55);
    margin-bottom: 24px;
}

.empty-btn {
    padding: 10px 24px;
    border: 1px solid rgba(255, 255, 255, 0.2);
    border-radius: 999px;
    background: linear-gradient(135deg, #9333ea, #6366f1);
    color: #ffffff;
    font-size: 14px;
    font-weight: 500;
    cursor: pointer;
    box-shadow: 0 4px 16px rgba(147, 51, 234, 0.4);
    transition: all 0.2s cubic-bezier(0.2, 0, 0, 1);
}

.empty-btn:hover {
    filter: brightness(1.15);
    transform: translateY(-1px);
}
</style>
