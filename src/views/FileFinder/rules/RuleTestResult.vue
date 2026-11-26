<template>
    <div v-if="last && last.kind === 'error'" class="result err">
        <div class="result-head">
            <span>{{ last.message }}</span>
            <n-button size="tiny" quaternary title="关闭结果" @click="emit('close')">
                <template #icon><n-icon><CloseOutline /></n-icon></template>
            </n-button>
        </div>
    </div>
    <div v-else-if="last" class="result">
        <div class="result-head">
            <span class="result-title">试跑结果</span>
            <n-button size="tiny" quaternary title="收起试跑结果" @click="emit('close')">
                <template #icon><n-icon><CloseOutline /></n-icon></template>
            </n-button>
        </div>
        <div class="seg">
            <span class="seg-title">页面</span>
            <!-- ⚠️ 旧文案让人「先去补封面过一次验证」—— 但补封面面板的验证按钮只在抓到
                 被拦结果之后才出现，照做会扑空。正解就在旁边：同一个 partition，
                 在那个窗口里过完验证，cookie 就落下来了。 -->
            <span v-if="last.cf" class="bad">
                被站点验证拦住了
                <n-button size="tiny" type="primary" style="margin-left: 8px" :loading="challenging"
                    @click="emit('challenge')">过验证并重试</n-button>
                <n-button size="tiny" quaternary style="margin-left: 4px"
                    @click="emit('clearSession')">清 Cookie</n-button>
            </span>
            <span v-else-if="!last.ok && last.httpStatus >= 400" class="bad">
                打不开（HTTP {{ last.httpStatus }}）—— 这个番号在该站可能不存在
            </span>
            <!-- 失败时也要报"当前页面标题"：挑战页的标题是 Just a moment...，
                 正常页面的标题里带着番号 —— 一眼就能分清是真被拦还是选择器问题 -->
            <span v-else-if="!last.ok" class="bad">
                取不到<template v-if="last.pageTitle">，当前页面是「{{ last.pageTitle }}」</template>
            </span>
            <span v-else class="good">取到了{{ last.pageTitle ? '：' + last.pageTitle : '' }}</span>
        </div>

        <div v-for="s in last.steps" :key="s.index" class="seg">
            <span class="seg-title">第 {{ s.index + 1 }} 步</span>
            <span :class="s.ok ? 'good' : 'bad'">
                {{ s.ok ? '完成' : s.why === 'not-found' ? '没找到这个元素 —— 选择器可能变了' : '超时' }}
            </span>
        </div>

        <div class="seg">
            <span class="seg-title">封面</span>
            <div class="cover-box">
                <span :class="last.cover ? 'good' : 'bad'">{{ last.cover || '没有命中任何候选' }}</span>
                <img v-if="last.cover" :src="last.cover" class="cover-thumb" alt="封面预览" />
            </div>
        </div>
        <!-- 排错证据：页面上一张图都没有 = 页面根本没到（被拦 / 走错页），
             不是选择器写错。有图但地址是占位图 = 真地址在别的属性里（用 | 回退）。 -->
        <details v-if="last.imgCount !== undefined" class="imgs">
            <summary>
                页面上的图：<b>{{ last.imgCount }}</b> 张
                <span v-if="!last.imgCount" class="bad">（一张都没有 ⇒ 页面没到，先解决验证/地址，别改选择器）</span>
            </summary>
            <div v-for="(src, i) in last.sampleSrcs" :key="i" class="src-row">
                <img :src="src" class="sample-thumb" alt="" />
                <span class="src">{{ src }}</span>
            </div>
        </details>
        <!-- 抓不到就留证据：这份 HTML 能直接判"真被拦"还是"选择器不在页面上" -->
        <div v-if="last.snapFile" class="seg snap">
            <span class="seg-title">现场</span>
            <span class="dim">
                当时的页面已存成 <span class="path">{{ last.snapFile }}</span>
                <template v-if="last.snapUrl"><br>停在：{{ last.snapUrl }}</template>
            </span>
        </div>
        <div class="seg">
            <span class="seg-title">标题</span>
            <span class="dim">{{ last.title || '（没抓到，不影响封面）' }}</span>
        </div>
        <div v-if="last.actress" class="seg">
            <span class="seg-title">演员</span>
            <span class="dim">{{ last.actress }}<template v-if="last.actressLink">（{{ last.actressLink }}）</template></span>
        </div>
    </div>
</template>

<script setup lang="ts">
import { NButton, NIcon } from 'naive-ui';
import { CloseOutline } from '@vicons/ionicons5';
import type { TestRun } from './ruleDraft';

/**
 * 试跑三段式回显：**页面 → 每步动作 → 各字段命中值**。
 * 分段的唯一目的：让用户知道"卡在哪一段"，而不是只看到一句"失败了"。
 */
defineProps<{ last: TestRun | null; challenging?: boolean }>();
const emit = defineEmits<{
    challenge: [];
    clearSession: [];
    close: [];
}>();
</script>

<style lang="less" scoped>
.result {
    padding: 12px 14px;
    border-radius: 10px;
    background: var(--ff-panel);
    border: 1px solid var(--ff-line-strong);
    font-size: 13px;
    line-height: 1.5;
}

.result-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 6px;
}

.result-title {
    font-size: 13px;
    font-weight: 600;
    color: var(--ff-text-1);
}

.result.err { color: var(--ff-danger); }

.seg {
    display: flex;
    gap: 10px;
    padding: 4px 0;
}

.seg-title {
    flex: 0 0 64px;
    color: var(--ff-text-2);
}

.good { color: var(--ff-ok); }
.bad { color: var(--ff-danger); }
.dim { color: var(--ff-text-2); word-break: break-all; }

.imgs {
    margin-top: 6px;
    font-size: 12px;
    opacity: .85;

    summary {
        cursor: pointer;
        opacity: .8;
    }
}

.src-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 3px 0 3px 14px;
}

.sample-thumb {
    width: 36px;
    height: 36px;
    object-fit: cover;
    border-radius: 4px;
    border: 1px solid var(--ff-line-strong);
    flex: 0 0 auto;
}

.cover-box {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
}

.cover-thumb {
    max-width: 180px;
    max-height: 140px;
    object-fit: contain;
    border-radius: 6px;
    border: 1px solid var(--ff-line-strong);
    background: var(--ff-panel);
}

.src {
    font-family: ui-monospace, monospace;
    word-break: break-all;
    opacity: .7;
}

.snap .path {
    font-family: ui-monospace, monospace;
    word-break: break-all;
}
</style>
