<template>
    <!--
      抽帧缓存（设置 → 通用 → 备份与迁移 下方）
      补封面抽出来的关键帧住在系统盘，是**可重建的中间产物**。作品已经补上正式封面、
      或者改名/换盘之后，那些帧就再也没人引用了 —— 这块负责把它们找出来、让人看过再清掉。
      ⚠️ 不自动删、不弹二次确认：列表本身就是审阅（同「回收站」的语义）。
    -->
    <div class="fc">
        <div class="fc__head">
            <span class="fc__stat">
                <b>{{ inv.total }}</b> 张 · {{ mb(inv.bytes) }}
            </span>
            <span v-if="inv.orphans.length" class="fc__warn">{{ inv.orphans.length }} 张无引用</span>
            <span v-else-if="inv.total" class="fc__hint">都在用</span>
            <span v-else class="fc__hint">还没抽过帧</span>
            <span v-if="inv.offlineSkipped" class="fc__hint">· {{ inv.offlineSkipped }} 张因盘离线未核实</span>

            <span class="fc__ops">
                <n-select
                    v-if="diskOptions.length > 1"
                    class="fc__disk"
                    size="small"
                    :value="disk"
                    :options="diskOptions"
                    @update:value="v => (disk = v)"
                />
                <button type="button" class="fc__btn" :disabled="loading" @click="load(false)">重新统计</button>
                <button
                    type="button"
                    class="fc__btn"
                    :disabled="loading || !onlineAny"
                    :title="onlineAny ? '对仍判在用的帧按盘上真实路径核实一次（只 stat 有帧的那几项）' : '插上盘才能核实'"
                    @click="load(true)"
                >
                    用实时清单核实
                </button>
            </span>
        </div>

        <details v-if="inv.orphans.length" class="fc__box" open>
            <summary class="fc__sum">查看无引用的 {{ shown.length }} 张</summary>
            <div class="fc__grid">
                <label v-for="o in shown" :key="o.file" class="fc__item" :class="{ 'is-sel': sel.has(o.file) }">
                    <input type="checkbox" :checked="sel.has(o.file)" @change="toggle(o.file)" />
                    <img class="fc__img" :src="srcOf(o)" alt="" loading="lazy" />
                    <span class="fc__meta">{{ o.pct }}% · {{ day(o.mtime) }} · {{ mb(o.bytes) }}</span>
                </label>
            </div>
            <div class="fc__foot">
                <button type="button" class="fc__btn fc__btn--danger" :disabled="!sel.size || loading" @click="purge">
                    清除选中 {{ sel.size }} 张（释放 {{ mb(selBytes) }}）
                </button>
                <span class="fc__hint">只删系统盘的缓存，盘上的文件一个不动</span>
            </div>
        </details>
    </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { NSelect } from 'naive-ui';
import { API_BASE, apiUrl, getAction, postAction } from '@/utils/request';
import useNotify from '@/hooks/useNotify';

interface Item { file: string; serial: string; bytes: number; mtime: number; pct: number; attempt: number }
interface Inv { total: number; bytes: number; orphans: Item[]; live: number; offlineSkipped: number }

const notify = useNotify();

const inv = ref<Inv>({ total: 0, bytes: 0, orphans: [], live: 0, offlineSkipped: 0 });
const loading = ref(false);
const sel = ref(new Set<string>());
const disk = ref('');
const disks = ref<{ serial: string; label: string; online: boolean }[]>([]);

const mb = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const day = (t: number) => {
    const d = new Date(t);
    return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** 盘只是过滤维度（缓存是整机一件事），默认全部 */
const shown = computed(() => (disk.value ? inv.value.orphans.filter(o => o.serial === disk.value) : inv.value.orphans));

const diskOptions = computed(() => {
    const used = [...new Set(inv.value.orphans.map(o => o.serial))];
    return [
        { label: '全部', value: '' },
        ...used.map(s => ({ label: disks.value.find(d => d.serial === s)?.label || s.slice(0, 6), value: s })),
    ];
});

const onlineAny = computed(() => disks.value.some(d => d.online));

/** 帧预览走本地端点；文件名里的 nonce 保证每次重抽都是新 URL */
const srcOf = (o: Item) =>
    apiUrl(`${API_BASE}/assistant/frame?serial=${encodeURIComponent(o.serial)}&f=${encodeURIComponent(o.file)}`);

const selBytes = computed(() =>
    inv.value.orphans.filter(o => sel.value.has(o.file)).reduce((n, o) => n + o.bytes, 0));

const toggle = (file: string) => {
    const next = new Set(sel.value);
    if (next.has(file)) next.delete(file);
    else next.add(file);
    sel.value = next;
};

async function load(verify: boolean) {
    loading.value = true;
    try {
        const res = await postAction(`${API_BASE}/assistant/frames/${verify ? 'verify' : 'inventory'}`, {});
        inv.value = {
            total: res.total ?? 0, bytes: res.bytes ?? 0, orphans: (res.orphans ?? []) as Item[],
            live: res.live ?? 0, offlineSkipped: res.offlineSkipped ?? 0,
        };
        // 无引用的全选：判据已经限定死了，用户只需确认清单
        sel.value = new Set(inv.value.orphans.map(o => o.file));
    } catch (e) {
        notify('error', '统计抽帧缓存失败', String(e));
    } finally {
        loading.value = false;
    }
}

async function purge() {
    const files = [...sel.value];
    if (!files.length) return;
    loading.value = true;
    try {
        const res = await postAction(`${API_BASE}/assistant/frames/purge`, { files });
        notify('success', `已清理 ${res.removed ?? 0} 张`, `释放 ${mb(res.freed ?? 0)}`);
        await load(false);
    } catch (e) {
        notify('error', '清理失败', String(e));
    } finally {
        loading.value = false;
    }
}

onMounted(async () => {
    try {
        const res = await getAction(`${API_BASE}/getDisks`);
        disks.value = (res.disks ?? []).map((d: { serial: string; label?: string; drive?: string; online?: boolean }) => ({
            serial: d.serial, label: d.label || d.drive || d.serial.slice(0, 6), online: d.online !== false,
        }));
    } catch {
        disks.value = [];
    }
    await load(false);
});
</script>

<style lang="less" scoped>
.fc {
    padding: 0 12px 12px;
    display: flex;
    flex-direction: column;
    gap: 10px;
}

.fc__head {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
    font-size: 12px;
    color: var(--ff-text-2);
}

.fc__stat b {
    color: var(--ff-text-1);
    font-weight: 500;
}

.fc__warn {
    color: var(--ff-warn);
}

.fc__hint {
    color: var(--ff-text-3);
}

.fc__ops {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: 6px;
}

.fc__disk {
    width: 132px;
}

.fc__btn {
    height: 26px;
    padding: 0 10px;
    font-size: 12px;
    border-radius: var(--ff-r-ctl);
    border: 1px solid var(--ff-line-strong);
    background: transparent;
    color: var(--ff-text-2);
    cursor: pointer;
}

.fc__btn:hover:not(:disabled) {
    background: var(--ff-ctl-on);
    color: var(--ff-text-1);
}

.fc__btn:disabled {
    opacity: 0.45;
    cursor: default;
}

.fc__btn--danger:hover:not(:disabled) {
    border-color: var(--ff-danger);
    color: var(--ff-danger);
}

.fc__box {
    border-top: 1px solid var(--ff-line);
    padding-top: 10px;
}

.fc__sum {
    font-size: 12px;
    color: var(--ff-text-2);
    cursor: pointer;
    margin-bottom: 8px;
}

.fc__grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(112px, 1fr));
    gap: 8px;
}

.fc__item {
    position: relative;
    border: 1px solid var(--ff-line);
    border-radius: var(--ff-r-ctl);
    overflow: hidden;
    cursor: pointer;
}

.fc__item.is-sel {
    border-color: var(--ff-highlight);
}

.fc__item input {
    position: absolute;
    left: 6px;
    top: 6px;
    accent-color: var(--ff-highlight);
}

.fc__img {
    display: block;
    width: 100%;
    aspect-ratio: 3 / 2;
    object-fit: cover;
    background: var(--ff-field);
}

.fc__meta {
    display: block;
    padding: 4px 6px;
    font-size: 11px;
    color: var(--ff-text-3);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.fc__foot {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-top: 10px;
}
</style>
