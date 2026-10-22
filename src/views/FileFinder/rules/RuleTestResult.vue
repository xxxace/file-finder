<template>
    <div v-if="last && last.kind === 'error'" class="result err">{{ last.message }}</div>
    <div v-else-if="last" class="result">
        <div class="seg">
            <span class="seg-title">页面</span>
            <!-- ⚠️ 旧文案让人「先去补封面过一次验证」—— 但补封面面板的验证按钮只在抓到
                 被拦结果之后才出现，照做会扑空。正解就在旁边：同一个 partition，
                 在那个窗口里过完验证，cookie 就落下来了。 -->
            <span v-if="last.cf" class="bad">
                被站点验证拦住了 —— 点右边「打开页面看看」，在那个窗口里完成验证，回来再试跑
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
            <span :class="last.cover ? 'good' : 'bad'">{{ last.cover || '没有命中任何候选' }}</span>
        </div>
        <!-- 排错证据：页面上一张图都没有 = 页面根本没到（被拦 / 走错页），
             不是选择器写错。有图但地址是占位图 = 真地址在别的属性里（用 | 回退）。 -->
        <details v-if="last.imgCount !== undefined" class="imgs">
            <summary>
                页面上的图：<b>{{ last.imgCount }}</b> 张
                <span v-if="!last.imgCount" class="bad">（一张都没有 ⇒ 页面没到，先解决验证/地址，别改选择器）</span>
            </summary>
            <div v-for="(src, i) in last.sampleSrcs" :key="i" class="src">{{ src }}</div>
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
    </div>
</template>

<script setup lang="ts">
import type { TestRun } from './ruleDraft';

/**
 * 试跑三段式回显：**页面 → 每步动作 → 各字段命中值**。
 * 分段的唯一目的：让用户知道"卡在哪一段"，而不是只看到一句"失败了"。
 */
defineProps<{ last: TestRun | null }>();
</script>

<style lang="less" scoped>
.result {
    margin-top: 12px;
    padding: 10px 12px;
    border-radius: 8px;
    background: rgba(128, 128, 128, .08);
    font-size: 13px;
}

.result.err { color: #d03050; }

.seg {
    display: flex;
    gap: 8px;
    padding: 3px 0;
}

.seg-title {
    flex: 0 0 64px;
    opacity: .7;
}

.good { color: #18a058; }
.bad { color: #d03050; }
.dim { opacity: .75; word-break: break-all; }

.imgs {
    margin-top: 6px;
    font-size: 12px;
    opacity: .85;

    summary {
        cursor: pointer;
        opacity: .8;
    }
}

.src {
    padding: 2px 0 2px 14px;
    font-family: ui-monospace, monospace;
    word-break: break-all;
    opacity: .7;
}

.snap .path {
    font-family: ui-monospace, monospace;
    word-break: break-all;
}
</style>
