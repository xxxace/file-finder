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
                <template v-if="inv.total"><b>{{ inv.total }}</b> 张 · {{ mb(inv.bytes) }}</template>
                <template v-else>还没有抽过帧</template>
            </span>
            <span v-if="inv.orphans.length" class="fc__warn">{{ inv.orphans.length }} 张无引用</span>
            <span v-else-if="inv.total" class="fc__hint">都在用</span>
            <span v-if="inv.offlineSkipped" class="fc__hint">· {{ inv.offlineSkipped }} 张因盘离线未核实</span>
            <!-- 「刚才到底跑了没」必须有落点：一个时间戳比任何动画都直接 -->
            <span v-if="atText" class="fc__hint">· {{ atText }}</span>

            <span class="fc__ops">
                <n-select
                    v-if="diskOptions.length > 1"
                    class="fc__disk"
                    size="small"
                    :value="disk"
                    :options="diskOptions"
                    @update:value="v => (disk = v)"
                />
                <button
                    type="button"
                    class="fc__btn"
                    :disabled="!!busy"
                    title="只重算系统盘上的缓存与记录，不碰移动硬盘"
                    @click="load(false)"
                >
                    {{ busy === 'inv' ? '刷新中…' : '刷新' }}
                </button>
                <button
                    type="button"
                    class="fc__btn"
                    :disabled="!!busy || !inv.total"
                    :title="!inv.total
                        ? '还没有帧可核实'
                        : (onlineAny ? '对仍判在用的帧按盘上真实路径各 stat 一次（会碰一下移动硬盘）' : '这些盘都不在线，插上盘再核实')"
                    @click="load(true)"
                >
                    {{ busy === 'ver' ? '核实中…' : '用实时清单核实' }}
                </button>
            </span>
        </div>

        <!-- 在途说明：一句话讲清"在干什么、要多久、会不会动我的文件" -->
        <p v-if="busy" class="fc__running">
            {{ busy === 'ver'
                ? '正在核对盘上是否还有这些作品（只 stat 有帧的那几项，通常一两秒）…'
                : busy === 'purge' ? '正在清除选中的缓存文件…' : '正在统计系统盘上的帧缓存…' }}
            <em class="fc__safe">可以随时离开，不会写坏或丢失任何东西</em>
        </p>

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
                <button type="button" class="fc__btn fc__btn--danger" :disabled="!selShown.length || !!busy" @click="purge">
                    清除选中 {{ selShown.length }} 张（释放 {{ mb(selBytes) }}）
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
interface Inv { total: number; bytes: number; orphans: Item[]; live: number; offlineSkipped: number; checked: number }

const notify = useNotify();

const inv = ref<Inv>({ total: 0, bytes: 0, orphans: [], live: 0, offlineSkipped: 0, checked: 0 });
/** 在途状态：'' = 空闲。两个按钮共用这一个 —— 谁在跑，谁的文案就变成"…中" */
const busy = ref<'' | 'inv' | 'ver' | 'purge'>('');
/** 上次跑完的时刻。用户点了按钮却看不到任何数字变化时，这是唯一的"我确实跑过" */
const at = ref<number | null>(null);
/**
 * 现在这份列表是「核实」得来的还是「刷新」得来的。
 * 清理必须与它**同口径重算**：级二（核实）发现的孤儿，在只读缓存的重算里会变回"在用"⇒
 * 用户看到"新发现 4 项"，点清理却提示"已清理 0 张"。
 */
const lastVerify = ref(false);
const sel = ref(new Set<string>());
const disk = ref('');
const disks = ref<{ serial: string; label: string; online: boolean }[]>([]);

/** 0 张就说 0 B —— 原来 `Math.max(1, …)` 会把 0 说成 1 KB，等于在说谎 */
const mb = (n: number) => {
    if (!n) return '0 B';
    if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
    return `${Math.max(1, Math.round(n / 1024))} KB`;
};
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

const atText = computed(() => {
    if (!at.value) return '';
    const d = new Date(at.value);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${hh}:${mm} 跑过一遍`;
});

/** 帧预览走本地端点；文件名里的 nonce 保证每次重抽都是新 URL */
const srcOf = (o: Item) =>
    apiUrl(`${API_BASE}/assistant/frame?serial=${encodeURIComponent(o.serial)}&f=${encodeURIComponent(o.file)}`);

const selBytes = computed(() =>
    shown.value.filter(o => sel.value.has(o.file)).reduce((n, o) => n + o.bytes, 0));

/** 真正会被删的 = 勾选 ∩ **当前筛选后看得见的**。按盘筛过之后不许删掉看不见的那些 */
const selShown = computed(() => shown.value.filter(o => sel.value.has(o.file)).map(o => o.file));

const toggle = (file: string) => {
    const next = new Set(sel.value);
    if (next.has(file)) next.delete(file);
    else next.add(file);
    sel.value = next;
};

async function load(verify: boolean) {
    if (busy.value) return;
    busy.value = verify ? 'ver' : 'inv';
    const before = inv.value.orphans.length;
    try {
        const res = await postAction(`${API_BASE}/assistant/frames/${verify ? 'verify' : 'inventory'}`, {});
        inv.value = {
            total: res.total ?? 0, bytes: res.bytes ?? 0, orphans: (res.orphans ?? []) as Item[],
            live: res.live ?? 0, offlineSkipped: res.offlineSkipped ?? 0, checked: res.checked ?? 0,
        };
        at.value = Date.now();
        lastVerify.value = verify;
        // 无引用的全选：判据已经限定死了，用户只需确认清单
        sel.value = new Set(inv.value.orphans.map(o => o.file));

        // 核实必须有回音：光数字不变的话，用户无法区分"没执行"和"执行了没变化"
        if (verify) {
            const found = Math.max(0, inv.value.orphans.length - before);
            const skip = inv.value.offlineSkipped;
            notify('success', '核实完成',
                inv.value.checked
                    ? `核对了 ${inv.value.checked} 项${found ? `，新发现 ${found} 项盘上已不存在` : '，没有发现过期'}${skip ? `；${skip} 项因盘离线跳过` : ''}`
                    : (skip ? `${skip} 项因盘离线跳过（插上盘再核实）` : '没有需要核实的项'));
        }
    } catch (e) {
        notify('error', '统计抽帧缓存失败', String(e));
    } finally {
        busy.value = '';
    }
}

async function purge() {
    const files = selShown.value;
    if (!files.length) return;
    busy.value = 'purge';
    try {
        const res = await postAction(`${API_BASE}/assistant/frames/purge`, { files, verify: lastVerify.value });
        notify('success', `已清理 ${res.removed ?? 0} 张`, `释放 ${mb(res.freed ?? 0)}`);
        await load(false);
    } catch (e) {
        notify('error', '清理失败', String(e));
    } finally {
        busy.value = '';
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

/** 在途说明那一行：它回答"在干什么 / 会不会动我的文件"，不是装饰 */
.fc__running {
    margin: -4px 0 0;
    font-size: 12px;
    color: var(--ff-text-3);
}

/** "可以随时离开"这句必须比正文更轻：它是让人放心的，不是要读的重点 */
.fc__safe {
    margin-left: 8px;
    font-style: normal;
    opacity: 0.75;
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
