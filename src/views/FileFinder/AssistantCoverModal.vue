<template>
    <n-modal :show="visible" preset="card" title="补封面" style="width: 100vw; height: 100vh"
        content-style="display:flex; flex-direction:column; overflow:hidden" @update:show="onModalShowChange">
        <!-- 全屏面板：选盘 → 扫描（零读盘）→ 勾选 → 抓取 → 写入。
             布局全用裸 flex 容器（.ffassist-*），**不用 n-space** ——
             naive-ui 2.45.3 的 Space 给每个子项硬编码同一个 key，子元素个数一变就重复节点
             （docs/FIX-2026-09-24-nspace-duplicate-keys.md）。这里的列表天生会增减。 -->
        <div class="ffassist">
            <!-- 选盘行 -->
            <div class="ffassist-row">
                <span class="ffassist-label">盘：</span>
                <!-- ⚠️ 「换封面」时禁用：盘由服务端从你挑的那些位置**反推**出来
                     （挑的是哪块盘的东西就查哪块盘），用户改选没有意义，
                     而且改完会被下一次展开"弹回去"，看着像坏掉了 -->
                <n-select v-if="diskOptions.length" v-model:value="selectedSerial" :options="diskOptions"
                    size="small" style="width: 380px" :disabled="busy || faceMode" @update:value="runScan" />
                <n-spin v-if="disksLoading" :size="16" />
                <n-button size="small" :disabled="busy || !selectedSerial" @click="runScan">
                    重新扫描
                </n-button>
                <!-- 深度重扫：扫描是零读盘、只认缓存的。用户在盘上手动删过图/动过文件后，
                     缓存不知道 —— 这个按钮把"写入过"的目录用实时清单（纯 readdir+stat，
                     不抽帧不写缓存）复核一遍再出清单。
                     ⚠️ 它出的是「缺封面」那一套（走 /assistant/rebuild），所以**换封面模式下
                     必须禁用** —— 否则一点就把用户刚挑的那批清单整个顶掉。 -->
                <n-popconfirm positive-text="深度重扫" negative-text="取消" @positive-click="deepRescan">
                    <template #trigger>
                        <n-button size="small" :disabled="busy || !selectedSerial || faceMode" :loading="deepLoading">
                            深度重扫
                        </n-button>
                    </template>
                    把这块盘上写入过的目录用实时清单复核一遍（只读文件名，不抽帧，很快）。确定吗？
                </n-popconfirm>
                <span v-if="scan" class="ffassist-hint">
                    <template v-if="faceMode">待换 {{ scan.targets.length }}</template>
                    <template v-else>
                        待补 {{ scan.targets.length }} · 认不出番号 {{ scan.unmatched.length }} ·
                        分类目录跳过 {{ scan.skippedCategory }}
                    </template>
                </span>
            </div>

            <!-- 目标清单（默认全选，可单条取消） -->
            <div class="ffassist-list">
                <n-spin v-if="scanLoading" style="margin-top: 48px" />
                <template v-if="scan">
                    <div v-if="!scan.targets.length" class="ffassist-hint" style="padding-top: 48px; text-align: center">
                        <template v-if="faceMode">
                            缓存里**找不到你刚在主界面选的那些位置**<br>
                            <span style="font-size: 12px">
                                这一批的情况：收到 {{ scan.received ?? 0 }} 个选中位置 ·
                                查了 {{ scan.probed ?? 1 }} 块盘的缓存<br>
                                把这些数字告诉助手就能定位（收到 0 个 = 选择没传过来；收到 N 个 = 位置没匹配上）
                            </span>
                        </template>
                        <template v-else>
                            这块盘的缓存里没有发现缺封面的视频<br>
                            <span style="font-size: 12px">刚在盘上手动删过图 / 动过文件的话，点上面的「深度重扫」用实时清单复核</span>
                        </template>
                    </div>
                    <div v-for="t in scan.targets" :key="t.writeRel" class="ffassist-item">
                        <n-checkbox size="small" :checked="checked.has(t.writeRel)" :disabled="busy"
                            @update:checked="v => toggleTarget(t.writeRel, v)" />
                        <div class="ffassist-item-main">
                            <div class="ffassist-item-name">{{ t.name }}</div>
                            <div class="ffassist-item-path">{{ t.writeRel }}</div>
                        </div>
                        <n-tag size="small" :bordered="false">{{
                            t.kind === 'cover' ? '已有封面 · 覆盖'
                                : t.kind === 'dir' ? '目录封面 · 新建'
                                    : '单独文件 · 新建'
                        }}</n-tag>
                    </div>

                    <!-- 认不出番号：只报个数 + 可折叠明细，不做逐条操作（已锁决策） -->
                    <details v-if="scan.unmatched.length" class="ffassist-unmatched">
                        <summary>认不出番号 {{ scan.unmatched.length }} 条（已跳过，不会去搜，也不会写任何东西）</summary>
                        <div v-for="u in scan.unmatched" :key="u.dir + '/' + u.name" class="ffassist-unmatched-row">
                            {{ u.dir ? u.dir + ' / ' : '' }}{{ u.name }}
                        </div>
                    </details>
                </template>
            </div>

            <!-- 底部动作区：随阶段变化，但每一段内部都是静态结构 -->
            <div class="ffassist-footer">
                <!-- 抓取中 -->
                <template v-if="grabJob && grabJob.status === 'running'">
                    <span class="ffassist-progress">
                        抓取中 {{ grabJob.progress.processed }} / {{ grabJob.progress.total }}
                        （命中 {{ grabJob.progress.hits }}，被拦 {{ grabJob.progress.blocked }}）
                    </span>
                    <span v-if="grabJob.progress.current" class="ffassist-hint">{{ grabJob.progress.current }}</span>
                    <n-button size="small" @click="cancelJob(grabJob.id)">取消</n-button>
                </template>

                <!-- 抓完 -->
                <template v-else-if="grabDone">
                    <span class="ffassist-progress">{{ grabJob!.message || '抓取结束' }}</span>
                    <n-button v-if="blockedRows.length" size="small" type="warning" :disabled="challengeRunning"
                        @click="passChallenge">
                        {{ challengeRunning ? '等待人工过验证…' : `人工过验证并重抓（${blockedRows.length} 条被拦）` }}
                    </n-button>
                    <n-button v-if="applyHits > 0" size="small" type="primary" :disabled="applying || challengeRunning"
                        @click="openConfirm">
                        确认写入…（{{ applyHits }} 张）
                    </n-button>
                    <n-button size="small" :disabled="busy" @click="runScan">重扫</n-button>
                </template>

                <!-- 写盘中 -->
                <template v-else-if="applying">
                    <span class="ffassist-progress">
                        写入中 {{ applyJob?.progress.processed ?? 0 }} / {{ applyJob?.progress.total ?? 0 }}
                    </span>
                    <span v-if="applyJob?.progress.current" class="ffassist-hint">{{ applyJob.progress.current }}</span>
                    <n-button size="small" @click="cancelJob(applyJob!.id)">取消</n-button>
                </template>

                <!-- 待抓取 -->
                <template v-else>
                    <span class="ffassist-hint">{{ faceMode
                        ? '这些是你刚在主界面挑的；抓到后还要点「写入」才会真的换掉。翻新封面会**先备份原图**'
                        : '勾选要补封面的片子，抓到后还需要点「写入」才会进盘' }}</span>
                    <n-button size="small" type="primary" :disabled="!checkedCount || scanLoading" @click="startGrab()">
                        {{ faceMode ? `开始抓取新封面（${checkedCount} 条）` : `开始抓取（${checkedCount} 条）` }}
                    </n-button>
                </template>
            </div>

            <!-- 抓取/写入的结果明细：命中的行带封面预览图 —— 写入前看一眼再点「写入」，
                 这就是"确认内容对不对"的那一环（用户 2026-09-25 明确要的）。
                 no-referrer：部分封面 CDN 检测 Referer 防外链，不带更稳。 -->
            <div v-if="resultRows.length" class="ffassist-results">
                <div v-for="r in resultRows" :key="r.writeRel + r.status" class="ffassist-result-row">
                    <img v-if="r.coverUrl" :src="previewSrc(r.coverUrl)" class="ffassist-thumb" loading="lazy"
                        referrerpolicy="no-referrer" alt="">
                    <n-tag size="small" :bordered="false" :type="rowTagType(r)">{{ rowTagText(r) }}</n-tag>
                    <span class="ffassist-result-path">{{ r.writeRel }}</span>
                    <span class="ffassist-result-msg">{{ r.message || r.title || '' }}</span>
                </div>
            </div>
        </div>
    </n-modal>

    <!-- 写入确认弹窗：grid 一部片一张卡，默认全勾、可反选。
         不勾的**不会写也不会搬** —— 这层确认过完才真正碰盘（用户 2026-09-25 要求）。 -->
    <n-modal :show="showConfirm" preset="card" title="确认写入" style="width: 82vw"
        content-style="display:flex; flex-direction:column; gap:8px" @update:show="v => showConfirm = v">
        <div class="ffassist-hint">
            <!-- 两种模式的后果完全不同，文案必须分开写（旧版只有一套"搬分卷"的说法，
                 套到「换封面」上会告诉用户一件根本不会发生的事） -->
            <template v-if="faceMode">
                勾选的会**换掉它现在那张封面**：有封面文件的**覆盖**它（文件名不变，
                **原图会先备份到数据目录**）；只有头像的目录则写一张新封面上去，旧头像自动让位。
                不勾的完全不碰，也**不会搬动任何视频**。
            </template>
            <template v-else>
                勾选的会**新建番号文件夹**、把这一部的全部分卷搬进去、封面写进文件夹里；
                不勾的完全不碰。搬动只用改名（同盘瞬时，不复制数据），同名冲突会跳过并说明。
            </template>
        </div>
        <div class="pick-grid">
            <div v-for="c in pickCards" :key="c.key" class="pick-card" :class="{ off: !pickChecked.has(c.key) }"
                :title="c.path">
                <n-checkbox size="small" :checked="pickChecked.has(c.key)"
                    @update:checked="v => togglePick(c.key, v)" />
                <img :src="previewSrc(c.coverUrl)" loading="lazy" referrerpolicy="no-referrer" alt="">
                <div class="pick-name">{{ c.title }}</div>
                <div class="pick-tag">{{ c.kind === 'cover' ? '覆盖原封面 · 先备份'
                    : c.kind === 'dir' ? '写新封面 · 旧头像自动让位'
                        : (c.volumes > 1 ? `${c.volumes} 个分卷搬入` : '单文件搬入') }}</div>
            </div>
        </div>
        <div class="ffassist-row">
            <n-button size="small" @click="toggleAllPick(true)">全选</n-button>
            <n-button size="small" @click="toggleAllPick(false)">全不选</n-button>
            <span style="flex: 1"></span>
            <n-button size="small" @click="showConfirm = false">取消</n-button>
            <n-button size="small" type="primary" :disabled="!pickChecked.size || applying"
                @click="confirmApply">
                确认写入（{{ pickChecked.size }} 部）
            </n-button>
        </div>
    </n-modal>
</template>

<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue';
import { NModal, NButton, NTag, NSpin, NSelect, NCheckbox, NPopconfirm } from 'naive-ui';
import { apiUrl, getAction, postAction, deletAction } from '@/utils/request';
import useNotify from '@/hooks/useNotify';

// 统一写 127.0.0.1（同 FileFinder：localhost 可能解析到 ::1，服务端只绑 IPv4）
const API_BASE = 'http://127.0.0.1:3060';

/**
 * 预览走本地代理（/assistant/preview）：渲染层直接 <img> 外站图会被防盗链拦，
 * 代理用和写盘**同一条**下载通道 —— 预览能显示的就一定能写入，所见即所得。
 */
const previewSrc = (url: string) =>
    apiUrl(`${API_BASE}/assistant/preview?url=${encodeURIComponent(url)}`);

interface DiskRow {
    serial: string; drive: string; label: string; online: boolean;
    folders: number; covers: number;
}
interface ScanTarget {
    /** `dir` = 写新封面到影片目录；`cover` = 覆盖它自己那张现有封面；`file` = 裸视频（建文件夹并搬） */
    kind: 'file' | 'dir' | 'cover';
    dir: string; name: string; writeRel: string; hasVideo?: boolean;
}
interface ScanUnmatched { dir: string; name: string; }
interface ScanResult {
    serial: string; scope: string;
    targets: ScanTarget[]; unmatched: ScanUnmatched[];
    skippedCategory: number; scannedDocs: number;
    /** 只对「换封面」有意义：服务端一共查了几块盘的缓存（空态里要如实说"找过了"） */
    probed?: number;
    /** 只对「换封面」有意义：服务端**实际收到**几个选中位置（0 = 前端根本没传过去） */
    received?: number;
}
interface GrabRow {
    writeRel: string; query: string; hitSite: string | null; coverUrl: string | null;
    title: string | null; status: 'ok' | 'no-id' | 'no-match' | 'blocked' | 'error';
    message: string; blockedSite?: string; srcRel?: string; kind?: 'file' | 'dir' | 'cover';
    /** 目标显示名（后端透传）—— 确认弹窗拿它当卡片标题 */
    name?: string;
}
interface ApplyRow { writeRel: string; ok: boolean; message: string; }
/**
 * 确认弹窗里的一张卡 = **一部片**（不是一行抓取结果）。
 * 同番号的分卷（`AAA-123-A`/`TST-014-01…08`）在这里收拢成一张卡 ——
 * 勾/不勾的是整部，写入时它们一起进同一个番号文件夹。
 */
interface PickCard {
    key: string; kind: 'file' | 'dir' | 'cover';
    /** 卡片标题：文件形态 = `番号/`（将新建的文件夹）；目录形态 = `已有文件夹名/` */
    title: string;
    /** 这部片所在的层（盘内相对路径） */
    path: string;
    coverUrl: string;
    /** 封面将写入的盘内相对路径（后端 ApplyRow.writeRel 与它对齐，结果对图用） */
    coverWriteRel: string;
    /** 这组覆盖的 grab 行（勾选后作为 picks 发回后端） */
    writeRels: string[];
    /** 分卷数（目录形态 = 0，显示"已有文件夹"） */
    volumes: number;
}
interface JobSnapshot {
    id: string; kind: string; status: 'running' | 'done' | 'cancelled' | 'error';
    progress: { total: number; processed: number; hits: number; misses: number; blocked: number; current: string };
    rows: (GrabRow | ApplyRow)[];
    message: string;
}
/**
 * 主界面「换封面」传进来的一个选中位置（与后端 `FacePick` 同形）。
 * `kind:'dir'` = 展开这个目录（含子树）下所有有封面的；`kind:'item'` = 只换这一个。
 */
interface FacePick { dir: string; name: string; ext?: string; kind: 'dir' | 'item'; }

const emit = defineEmits<{ refresh: [] }>();
const notify = useNotify();

const visible = ref(false);

/**
 * 「换封面」入口带来的选中位置。
 * **为空 = 走原来的「补封面」流程**（扫描找"没有封面的"）；非空 = 只处理这些（"有但要换的"）。
 * 关闭面板时清空 —— 否则下次从「补封面」进来会莫名其妙地沿用上一次的挑选。
 */
const facePicks = ref<FacePick[]>([]);
const faceMode = computed(() => facePicks.value.length > 0);
const disksLoading = ref(false);
const scanLoading = ref(false);
const disks = ref<DiskRow[]>([]);
const selectedSerial = ref<string | null>(null);
const scan = ref<ScanResult | null>(null);
/** 勾选集合，键 = writeRel（盘内唯一） */
const checked = ref(new Set<string>());
const grabJob = ref<JobSnapshot | null>(null);
const applyJob = ref<JobSnapshot | null>(null);
const challengeRunning = ref(false);
const challengeMsg = ref('');

const busy = computed(() => scanLoading.value || !!runningJob.value || challengeRunning.value);
const runningJob = computed(() =>
    (grabJob.value?.status === 'running' && grabJob.value) ||
    (applyJob.value?.status === 'running' && applyJob.value) ||
    null,
);
const grabDone = computed(() => !!grabJob.value && grabJob.value.status !== 'running' && !applyJob.value);
const applying = computed(() => applyJob.value?.status === 'running' || false);
const checkedCount = computed(() => checked.value.size);
const applyHits = computed(() => grabJob.value?.progress.hits ?? 0);
const blockedRows = computed(() => {
    const seen = new Set<string>();
    return (grabJob.value?.rows as GrabRow[] | undefined ?? [])
        .filter(r => r.status === 'blocked' && r.blockedSite && !seen.has(r.writeRel) && seen.add(r.writeRel));
});
/** 结果明细：写盘结果优先（最终事实），没有就展示抓取结果（命中/未命中/被拦） */
const resultRows = computed(() => {
    const apply = applyJob.value?.rows as ApplyRow[] | undefined;
    if (apply?.length) {
        // 写盘结果也带上封面图：按「封面将写入的位置」找回 coverUrl，
        // 让用户"写入之后"仍能对图核对
        const urlOf = new Map(pickCards.value.map(c => [c.coverWriteRel, c.coverUrl]));
        return apply.map(r => ({
            writeRel: r.writeRel, ok: r.ok, status: r.ok ? 'ok' : 'error',
            message: r.message, title: null as string | null,
            coverUrl: urlOf.get(r.writeRel) ?? null,
        }));
    }
    return (grabJob.value?.rows as GrabRow[] | undefined ?? []);
});

/**
 * 抓取命中结果 → 确认弹窗的卡片（一部片一张卡）。分组口径与后端 apply 一致：
 * 文件形态按 `(所在层, 番号)` 收拢分卷；目录形态（写 cover.jpg 的）一张卡、不搬动。
 */
const pickCards = computed<PickCard[]>(() => {
    const rows = (grabJob.value?.rows as GrabRow[] | undefined ?? [])
        .filter(r => r.status === 'ok' && r.coverUrl);
    const map = new Map<string, PickCard>();
    for (const r of rows) {
        const i = r.writeRel.lastIndexOf('/');
        const layerDir = i === -1 ? '' : r.writeRel.slice(0, i);
        if (r.kind === 'dir' || r.kind === 'cover') {
            // 「只写封面、不搬动」的两类：dir = 写新封面到影片目录；cover = 覆盖它自己那张。
            // ⚠️ 分组键必须与后端 `buildGroups` **同一口径**（`kind|writeRel`）：
            // 原来这里和后端都用 `layerDir` 作键，同一层的第二个目标会被吞掉、静默丢失。
            const key = `${r.kind}|${r.writeRel}`;
            if (!map.has(key)) {
                map.set(key, {
                    key, kind: r.kind,
                    // 卡片标题：`cover` 形态优先用**番号**（`query`）—— 它的 `name` 是
                    // 封面图文件名（可能是 `cover`/`1` 这种），拿去当标题没有信息量
                    title: r.kind === 'cover' ? (r.query || r.name || layerDir.split('/').pop() || '') : `${layerDir.split('/').pop()}/`,
                    path: r.kind === 'cover' ? layerDir : layerDir.split('/').slice(0, -1).join('/'),
                    coverUrl: r.coverUrl!,
                    coverWriteRel: r.writeRel,
                    writeRels: [r.writeRel], volumes: 0,
                });
            }
            continue;
        }
        // 文件形态：同层同番号 = 一部片（分卷收拢），封面与新建文件夹同名
        const key = `file|${layerDir}|${r.query}`;
        const card = map.get(key);
        if (card) {
            card.writeRels.push(r.writeRel);
            card.volumes += 1;
        } else {
            map.set(key, {
                key, kind: 'file',
                title: `${r.query}/`,
                path: layerDir,
                coverUrl: r.coverUrl!,
                coverWriteRel: `${layerDir}/${r.query}/${r.query}.jpg`,
                writeRels: [r.writeRel], volumes: 1,
            });
        }
    }
    return [...map.values()];
});

// ── 写入确认弹窗（grid，默认全勾，可反选；不勾的不写也不搬） ──
const showConfirm = ref(false);
const pickChecked = ref(new Set<string>());

const openConfirm = () => {
    pickChecked.value = new Set(pickCards.value.map(c => c.key));
    showConfirm.value = true;
};

const togglePick = (key: string, v: boolean) => {
    const next = new Set(pickChecked.value);
    if (v) next.add(key); else next.delete(key);
    pickChecked.value = next;
};

const toggleAllPick = (v: boolean) => {
    pickChecked.value = v ? new Set(pickCards.value.map(c => c.key)) : new Set();
};

const diskOptions = computed(() => disks.value.map(d => ({
    value: d.serial,
    label: `${d.label || d.drive || '(离线)'}　${d.online ? '在线' : '离线'}　${d.folders} 个目录缓存`,
})));

/** 被拦的行 → 对应的 scan targets（重抓用）。面板重开过就没有 targets 了，重抓按钮自然不出现 */
const blockedTargets = computed(() => {
    const rels = new Set(blockedRows.value.map(r => r.writeRel));
    return (scan.value?.targets ?? []).filter(t => rels.has(t.writeRel));
});

// ── 轮询（同一时刻只有一个任务在跑，一个 poller 够了） ──
let pollTimer: ReturnType<typeof setInterval> | null = null;
const stopPoll = () => {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
};
const poll = (id: string, onJob: (job: JobSnapshot) => boolean | void) => {
    stopPoll();
    pollTimer = setInterval(async () => {
        try {
            const res = await getAction(`${API_BASE}/assistant/jobs?id=${encodeURIComponent(id)}`);
            const done = onJob(res.job as JobSnapshot);
            if (done) stopPoll();
        } catch {
            // 服务忙/网络抖一下：下一轮再试。任务在主进程内存里，不会丢
        }
    }, 1200);
};
onUnmounted(stopPoll);

/**
 * ⚠️ `n-modal` 的 `@update:show` 回声 —— **只处理关闭**。
 *
 * 为什么不能像原来那样直接接 `setShowModal`：打开时 modal 会把 `visible = true`
 * 这个变化**回声**出来（`update:show(true)`），而事件只带一个 boolean ——
 * `setShowModal(true)` 的第二个参数 `picks` **变成了 undefined**，
 * 于是刚设好的「换封面」选择被 `facePicks.value = picks ?? []` **当场清空**，
 * 后端收到的 picks 是空数组 ⇒ 弹窗里一条都没有（用户真机实测的原话：
 * "出现弹窗，但是什么都没得操作"）。
 *
 * 打开永远是**程序主动调的**（带 picks），所以这里只管关闭。
 */
const onModalShowChange = (v: boolean) => {
    if (!v) setShowModal(false);
};

/**
 * 打开 / 关闭面板。
 *
 * ⚠️ 第二个参数是「换封面」的入口：**主界面里选中的位置**（见 `FacePick`）。
 * 不传 = 原来的「补封面」（扫描找"没有封面的"）；传了 = 只处理这批"有封面但要换的"。
 *
 * 两者共用**这一个面板、这一条链路**（抓取 → 预览确认 → 写入），只是"清单从哪来"不同 ——
 * 这是刻意的：用户 2026-10-02 明确「不要搞出太多的界面和入口，尽可能保持统一」。
 */
const setShowModal = async (v: boolean, picks?: FacePick[]) => {
    visible.value = v;
    if (!v) {
        stopPoll();
        // 关面板就清掉挑选 —— 否则下次从「补封面」进来会沿用上一次的挑选
        facePicks.value = [];
        return;
    }
    // ⚠️ **只有显式传了才覆盖**：不传时保留已有的（防"回声调用"把选择清掉，
    // 与上面的 `onModalShowChange` 是双保险）
    if (picks) facePicks.value = picks;
    await loadDisks();
    // 面板关了任务还在跑（job 活在主进程内存里）。重开时挂回正在跑的那个，
    // 不然用户以为取消/关闭就等于任务没了
    let attached = false;
    try {
        const res = await getAction(`${API_BASE}/assistant/jobs`);
        const running = (res.jobs as JobSnapshot[]).find(j => j.status === 'running');
        if (running?.kind === 'grab') {
            grabJob.value = running;
            poll(running.id, job => { grabJob.value = job; return job.status !== 'running'; });
            attached = true;
        } else if (running?.kind === 'apply') {
            applyJob.value = running;
            poll(running.id, job => { applyJob.value = job; return job.status !== 'running'; });
            attached = true;
        }
    } catch { /* 没有任务/服务没起来都无所谓，走正常流程 */ }

    // ⚠️ 没有在跑的任务时**必须重算清单**。
    // 原来只在"从没选过盘"时才自动扫（那段逻辑在 `loadDisks` 里），于是
    // **第二次打开面板永远显示上一次的清单** —— 从「补封面」切到「换封面」时，
    // 用户看到的还是"缺封面的"那一批，自然会以为"换封面不过是弹出补封面界面"
    // （用户真机实测）。跨模式、换盘重开，都必须重新算。
    if (!attached) await runScan();
};

const loadDisks = async () => {
    disksLoading.value = true;
    try {
        const res = await getAction(`${API_BASE}/getDisks`);
        disks.value = (res.disks ?? []).filter((d: DiskRow) => d.serial);
        // 只有一块盘就自动选上（多盘必须用户自己选，不替他做主）。
        // ⚠️ **不在这里顺手扫描** —— 扫码的时机由 `setShowModal` 统一管
        //（否则会和它重复扫一次，而且"第二次打开不重算"那个坑就是这段引起的）。
        if (!selectedSerial.value && disks.value.length === 1) {
            selectedSerial.value = disks.value[0].serial;
        }
    } catch (e) {
        notify('error', '取盘列表失败', String(e));
    } finally {
        disksLoading.value = false;
    }
};

const runScan = async () => {
    if (runningJob.value) return;
    // ⚠️ 「换封面」**不需要先选盘**：picks 里带的是完整路径（或只读锚点），
    // 服务端据此反推这块盘的序列号，再把结果回来告诉你（多盘机器上这一步关键 ——
    // 你挑的是哪块盘的东西，就该查哪块盘的缓存）。
    if (!faceMode.value && !selectedSerial.value) return;
    scanLoading.value = true;
    try {
        if (faceMode.value) {
            // 把主界面选中的**位置**展开成目标清单（零读盘，只读缓存）。
            // ⚠️ 返回的 `targets` 与「补封面」的**同形** ⇒ 下游（勾选/抓取/确认/写入）零改动。
            const res = await postAction(`${API_BASE}/assistant/faces`, { picks: facePicks.value });
            if (res.serial) selectedSerial.value = res.serial as string;
            scan.value = {
                serial: (res.serial ?? '') as string,
                scope: '',
                targets: (res.targets ?? []) as ScanTarget[],
                unmatched: [],
                skippedCategory: 0,
                scannedDocs: 0,
                probed: (res.probed as number | undefined) ?? 1,
                received: (res.received as number | undefined) ?? facePicks.value.length,
            };
        } else {
            const res = await postAction(`${API_BASE}/assistant/scan`, { serial: selectedSerial.value, relPath: '' });
            scan.value = res as ScanResult;
        }
        // 默认全选（已锁决策）；重新扫描也重置勾选
        checked.value = new Set(scan.value.targets.map(t => t.writeRel));
        grabJob.value = null;
        applyJob.value = null;
        stopPoll();
    } catch (e) {
        notify('error', faceMode.value ? '展开选中项失败' : '扫描失败', String(e));
    } finally {
        scanLoading.value = false;
    }
};

/**
 * 深度重扫（零抽帧）：后端把「写入过」的层用实时清单（纯 readdir+stat，不抽帧、
 * 不写缓存）替换掉缓存旧貌后，直接按同一套规则出清单 —— 一次请求搞定，不用再扫描。
 */
const deepLoading = ref(false);
const deepRescan = async () => {
    if (!selectedSerial.value || busy.value) return;
    deepLoading.value = true;
    try {
        const res = await postAction(`${API_BASE}/assistant/rebuild`, {
            serial: selectedSerial.value, relPath: '',
        });
        scan.value = res as ScanResult;
        checked.value = new Set(scan.value.targets.map(t => t.writeRel));
        grabJob.value = null;
        applyJob.value = null;
        stopPoll();
        if (res.refreshed) {
            notify('success', '深度重扫完成', `实时复核了 ${res.refreshed} 个目录`);
        } else if (scan.value.targets.length) {
            notify('info', '深度重扫完成', '盘不在线或没有写入记录，结果来自缓存');
        }
    } catch (e) {
        notify('error', '深度重扫失败', String(e));
    } finally {
        deepLoading.value = false;
    }
};

const toggleTarget = (writeRel: string, v: boolean) => {
    const next = new Set(checked.value);
    if (v) next.add(writeRel); else next.delete(writeRel);
    checked.value = next;
};

const startGrab = async (targets?: ScanTarget[]) => {
    const list = targets ?? (scan.value?.targets ?? []).filter(t => checked.value.has(t.writeRel));
    if (!list.length || runningJob.value) return;
    applyJob.value = null;
    try {
        const res = await postAction(`${API_BASE}/assistant/jobs`, {
            kind: 'grab', serial: selectedSerial.value, targets: list,
            // 「换封面」必须**绕开命中缓存**：否则助手以前抓到过的番号会秒回同一张 URL
            // ⇒ 下载到逐字节相同的图，"已替换"就成了假话（详见 grab.ts 的 runGrab 注释）。
            ...(faceMode.value ? { force: true } : {}),
        });
        if (!res.jobId) {
            notify('info', '没有可抓的目标', res.message || '');
            return;
        }
        grabJob.value = null;
        poll(res.jobId, job => { grabJob.value = job; return job.status !== 'running'; });
    } catch (e) {
        notify('error', '抓取启动失败', String(e));
    }
};

const cancelJob = async (id: string) => {
    try {
        await deletAction(`${API_BASE}/assistant/jobs?id=${encodeURIComponent(id)}`);
    } catch (e) {
        // 任务已经自己结束了也走这里 —— 提示一句就行，不算错误
        notify('info', '取消', String(e));
    }
};

/** 被拦 → 人工过验证 → 过完自动重抓被拦的那批 */
const passChallenge = async () => {
    const siteIds = [...new Set(blockedRows.value.map(r => r.blockedSite).filter(Boolean))] as string[];
    if (!siteIds.length || challengeRunning.value) return;
    challengeRunning.value = true;
    try {
        for (const siteId of siteIds) {
            challengeMsg.value = `等待人工过验证：${siteId}`;
            const res = await postAction(`${API_BASE}/assistant/jobs`, { kind: 'challenge', siteId });
            const ok = await new Promise<boolean>(resolve =>
                poll(res.jobId, job => {
                    challengeMsg.value = job.message;
                    if (job.status !== 'running') resolve(job.status === 'done');
                }),
            );
            if (!ok) {
                notify('warning', '人工过验证', challengeMsg.value || '验证没通过，可以再试一次');
                return;
            }
        }
        challengeMsg.value = '';
        if (blockedTargets.value.length) {
            await startGrab(blockedTargets.value);
        } else {
            // 面板重开过、没有 targets 上下文：让用户重扫一遍再抓
            notify('info', '验证已通过', '重新扫描后再抓一次即可');
            await runScan();
        }
    } catch (e) {
        notify('error', '人工过验证失败', String(e));
    } finally {
        challengeRunning.value = false;
    }
};

const startApply = async (picks?: string[]) => {
    if (!grabJob.value || applying.value) return;
    try {
        const res = await postAction(`${API_BASE}/assistant/apply`, {
            serial: selectedSerial.value, jobId: grabJob.value.id, picks,
        });
        if (!res.jobId) {
            notify('info', '没有可写入的封面', res.message || '');
            return;
        }
        poll(res.jobId, job => {
            applyJob.value = job;
            if (job.status !== 'running') {
                // 写完立即失效了对应目录缓存 —— 当前若正看着那块盘，刷新一下就能看到新脸
                emit('refresh');
                if (job.status === 'error') notify('error', '写入失败', job.message);
                else notify('success', '写入完成', job.message);
            }
            return job.status !== 'running';
        });
    } catch (e) {
        notify('error', '写入启动失败', String(e));
    }
};

/** 确认弹窗点「确认写入」：把勾选卡覆盖的 grab 行作为 picks 发给后端 */
const confirmApply = async () => {
    const picks = pickCards.value
        .filter(c => pickChecked.value.has(c.key))
        .flatMap(c => c.writeRels);
    showConfirm.value = false;
    await startApply(picks);
};

const rowTagType = (r: { status: string; ok?: boolean }) => {
    if (r.ok !== undefined) return r.ok ? 'success' : 'error'; // 写盘结果行
    if (r.status === 'ok') return 'success';
    if (r.status === 'blocked') return 'warning';
    if (r.status === 'error') return 'error';
    return 'default';
};
const rowTagText = (r: { status: string; ok?: boolean }) => {
    if (r.ok !== undefined) return r.ok ? '已写入' : '写入失败'; // 写盘结果行
    return ({
        ok: '命中', blocked: '被拦', 'no-match': '未命中', 'no-id': '认不出番号',
        error: '失败', cancelled: '已取消',
    }[r.status] ?? r.status);
};

defineExpose({ setShowModal });
</script>

<style lang="less" scoped>
.ffassist {
    display: flex;
    flex-flow: column;
    height: 100%;
    gap: 8px;
    overflow: hidden;
}

.ffassist-row {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: nowrap;
}

.ffassist-label {
    font-size: 13px;
    color: #666;
}

.ffassist-hint {
    font-size: 12px;
    color: #a1a1a1;
}

.ffassist-list {
    flex: 1;
    overflow: hidden auto;
    border: 1px solid #efefef;
    border-radius: 4px;
    padding: 4px;
}

.ffassist-item {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 4px 8px;
    border-radius: 4px;

    &:hover {
        background-color: rgba(110, 123, 173, 0.08);
    }
}

.ffassist-item-main {
    flex: 1;
    min-width: 0;
}

.ffassist-item-name {
    font-size: 14px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.ffassist-item-path {
    font-size: 12px;
    color: #a1a1a1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.ffassist-unmatched {
    margin: 8px;
    font-size: 12px;
    color: #a1a1a1;

    summary {
        cursor: pointer;
    }
}

.ffassist-unmatched-row {
    padding: 2px 0 2px 16px;
}

.ffassist-footer {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: nowrap;
    padding: 4px 0;
}

.ffassist-progress {
    font-size: 13px;
    font-weight: bold;
}

.ffassist-results {
    max-height: 160px;
    overflow: hidden auto;
    border-top: 1px solid #efefef;
    padding-top: 4px;
}

.ffassist-result-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 2px 4px;
    font-size: 12px;
}

.ffassist-thumb {
    height: 44px;
    width: auto;
    max-width: 64px;
    object-fit: cover;
    border-radius: 2px;
    border: 1px solid #efefef;
    flex-shrink: 0;
}

.ffassist-result-path {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.ffassist-result-msg {
    color: #a1a1a1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    margin-left: auto;
}

/* 写入确认弹窗：一部片一张卡，grid 自适应列数 */
.pick-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
    gap: 8px;
    overflow: hidden auto;
    max-height: 60vh;
    padding: 4px;
}

.pick-card {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    padding: 8px 6px;
    border: 1px solid #e5e5e5;
    border-radius: 6px;

    &.off {
        opacity: 0.45;
    }

    img {
        width: 100%;
        height: 96px;
        object-fit: contain;
    }
}

.pick-name {
    font-size: 13px;
    font-weight: 500;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.pick-tag {
    font-size: 12px;
    color: #a1a1a1;
}
</style>
