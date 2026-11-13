<template>
    <article
        v-tip="tipOf"
        class="ffw-card"
        :class="{ 'is-sel': selected }"
        :data-state="item.state"
        :style="{ animationDelay: `${Math.min(index, 14) * 24}ms` }"
    >
        <div class="ffw-card__media">
            <div class="ffw-card__ph">{{ item.title }}</div>
            <img
                v-if="coverSrc"
                class="ffw-card__art"
                :src="coverSrc"
                referrerpolicy="no-referrer"
                alt=""
                loading="lazy"
                @error="emit('broken')"
            />
            <DotField v-if="item.state === 'pending' || extracting" :active="true" />
            <!-- 左下 = 状态（待写入 / 已写入 / 排队 / 失败），右下 = 来源（javbus / 抽帧 1%）。
                 两个维度都常驻：来源只在悬停里看太不方便（2026-11-14 主人）-->
            <span v-if="item.badge" class="ffw-card__badge" :data-tone="tone">{{ item.badge }}</span>
            <span v-if="item.site" class="ffw-card__src">{{ item.site }}</span>
            <button
                v-if="action !== 'none'"
                type="button"
                class="ffw-card__act"
                :disabled="actionDisabled"
                :title="actionDisabled
                    ? '已经到中段了，再往后信息量不比这里高'
                    : (action === 'reframe' ? '换一帧（往后走一档）' : '抽一帧当封面')"
                @click.stop="emit('frame')"
            >
                <n-icon :component="action === 'reframe' ? RepeatOutline : CameraOutline" :size="13" />
            </button>
            <button
                type="button"
                class="ffw-card__check"
                :disabled="locked"
                :title="locked ? '任务进行中，先暂停或终止' : selected ? '取消选择' : '选择'"
                @click="emit('toggle')"
            >
                <n-icon :component="CheckmarkOutline" :size="12" />
            </button>
        </div>

        <div class="ffw-card__cap">
            <span class="ffw-card__name" :title="item.title">{{ item.title }}</span>
            <span class="ffw-card__kind">{{ item.kindText }}</span>
        </div>
        <div class="ffw-card__path" :title="item.path">{{ item.path || '盘根' }}</div>
    </article>
</template>

<script setup lang="ts">
import { computed, h } from 'vue';
import { NIcon } from 'naive-ui';
import { CameraOutline, CheckmarkOutline, RepeatOutline } from '@vicons/ionicons5';
import DotField from '@/components/DotField/DotField.vue';
import type { TipPayload } from '@/components/FluidTip/fluidTip';
import type { CoverAction, CoverItem } from './coverModel';

/**
 * 一张封面卡 = 一部片（同番号的分卷收在一张卡里）。
 * 封面图落地用「同节点」：占位块留着，图从 blur 8px 长出来 ——
 * 不做两块交叉淡入，那会丢掉"同一张卡在变"的连续感。
 */
/**
 * `locked` = 任务在跑/暂停：这时**禁止改勾选**。
 * 抓取队列在发起时就已经定好，此时点勾选既不会让它停下、也不影响它抓谁，
 * 只会让"选中数"变来变去 —— 点了有反馈却没效果，比禁用更糟（2026-11-08 主人裁决）。
 *
 * `broken` = 预览图在浏览器里加载失败。抓取时验证过 ≠ 渲染时还能取到（网络会变），
 * 这是**唯一**能观测到"这张图此刻显示不出来"的地方 ⇒ 交给父层把卡标成不可写。
 */
const props = defineProps<{
    item: CoverItem;
    coverSrc: string;
    selected: boolean;
    locked: boolean;
    index: number;
    /** 右上动作位（抽帧 / 换一帧 / 无）。判据在 coverModel.actionOf */
    action: CoverAction;
    /** 这一张正在抽帧（点阵 + 动作位不出现），与整批 job 的 pending 不同：它是单卡的 */
    extracting?: boolean;
    /** 动作位禁用（已到阶梯末档）—— 禁用而不是消失，用户才知道为什么点不动 */
    actionDisabled?: boolean;
}>();
const emit = defineEmits<{ toggle: []; broken: []; frame: [] }>();

/**
 * 角标的语义色 —— **只染字，不换材质**。
 *
 * 底仍然是那块半透明黑（`--ff-badge-bg` + 模糊），一排卡扫过去材质是齐的；
 * 颜色只负责回答"成功 / 要注意 / 失败"。这样既符合项目「无彩」的裁决
 * （状态色仅作语义，不做装饰），也不会让网格变成一排彩色标签。
 */
const tone = computed<'ok' | 'warn' | 'err' | 'mute' | ''>(() => {
    switch (props.item.state) {
        case 'written': return 'ok';
        case 'writefail':
        case 'error': return 'err';
        case 'blocked':
        case 'miss':
        case 'noid': return 'warn';
        // 「排队」= 还没发生的事，用最弱的一档
        case 'idle': return props.item.badge ? 'mute' : '';
        default: return '';
    }
});

/**
 * 悬停详情：番号 / 类型 / 站点 / **完整原因** / 目标。
 *
 * 为什么不用原生 `title`：原生提示约 1 秒才出、不能分行排版、不跟主题。
 * 项目里所有功能页提示都走同一个 `v-tip`（Teleport + 磨砂材质 + 跟随主题），这里走同一条通道。
 *
 * 为什么没有内容就返回空串：一张"排队中"的卡弹一个空壳，比不弹更让人困惑
 * （`v-tip` 的约定就是空 = 不显示）。
 */
const tipOf = computed<TipPayload | ''>(() => {
    const it = props.item;
    if (!it.note && !it.site) return '';

    const rows: [string, string][] = [['类型', it.kindText]];
    if (it.site) rows.push([it.state === 'blocked' ? '拦在' : '来源', it.site]);
    if (it.note) rows.push(['原因', it.note]);
    rows.push(['目标', it.path || '盘根']);

    return {
        text: `${it.title} · ${it.badge || '待处理'}`,
        /**
         * ⚠️ 每个 k / v **必须是 grid 的直接子元素**。
         * 曾经把它们包进一层 `<div class="row">` —— 那层 div 自己变成一个 grid 单元，
         * 于是两条记录被排到同一行的左右两列（"类型裸文件" 后面紧跟 "来源本地抽帧 1%"），
         * label 和值粘在一起（2026-11-14 主人截图）。
         */
        body: () => h('div', { class: 'ffw-ctip' }, [
            h('div', { class: 'ffw-ctip__head' }, [
                h('span', { class: 'ffw-ctip__title' }, it.title),
                h('span', { class: 'ffw-ctip__badge', 'data-tone': tone.value }, it.badge || '待处理'),
            ]),
            ...rows.flatMap(([k, v]) => [
                h('span', { class: 'ffw-ctip__k' }, k),
                h('span', { class: 'ffw-ctip__v' }, v),
            ]),
        ]),
    };
});
</script>
