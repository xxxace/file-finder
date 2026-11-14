<template>
    <!-- 通用面板 —— 真正的「偏好」住这里（Microsoft 准则：低频、影响行为、不需要频繁调整）。 -->
    <div class="general-panel">
        <!-- 卡 · 界面音效：标题+说明在左，控件在右（SettingsCard 模式） -->
        <section class="set-card">
            <div class="set-row">
                <div class="set-text">
                    <span class="set-title">界面音效</span>
                    <span class="set-desc">切换 / 完成 / 提示时轻响一声；悬停与方向键刻意不配声</span>
                </div>
                <n-switch :value="sfxPrefs.on" @update:value="setSfxEnabled" />
            </div>
            <div class="set-row">
                <div class="set-text">
                    <span class="set-title">音量</span>
                </div>
                <n-slider class="sfx-vol" :value="sfxPrefs.vol" :min="0" :max="1" :step="0.05"
                    :disabled="!sfxPrefs.on" @update:value="setSfxVolume" />
                <n-button size="small" :disabled="!sfxPrefs.on" @click="playSfx('success')">试听</n-button>
            </div>
        </section>

        <!-- 卡 · 彩蛋：纯装饰，默认开启。关掉即连那层全屏画布一起撤走 -->
        <section class="set-card">
            <div class="set-row">
                <div class="set-text">
                    <span class="set-title">文字选区开花</span>
                    <span class="set-desc">选中文字时沿字边长出小花小草，松手缩回；不影响复制和拖拽</span>
                </div>
                <n-switch :value="bloomPrefs.on" @update:value="setBloomEnabled" />
            </div>
        </section>

        <!-- 卡 · 备份与迁移：整块复用 BackupPanel（2026-11-08 抽离时就预留了"移进设置页"）。
             还原/合并成功后的 migrated 事件在设置页没有列表要刷，通知音已由 notify 承担。 -->
        <section class="set-card">
            <div class="set-row set-row-head">
                <div class="set-text">
                    <span class="set-title">备份与迁移</span>
                    <span class="set-desc">把缓存和收藏搬出去 / 搬回来 —— 每个动作下面写明了后果</span>
                </div>
            </div>
            <BackupPanel />
        </section>

        <!-- 卡 · 抽帧缓存：补封面抽出来的关键帧是可重建的中间产物。
             作品补上正式封面 / 改名 / 换盘之后它们就没人引用了 ⇒ 这里负责找出来、看过再清。
             ⚠️ 不自动删：删之前一定有一个列表给用户看（回收站语义）。 -->
        <section class="set-card">
            <div class="set-row set-row-head">
                <div class="set-text">
                    <span class="set-title">抽帧缓存</span>
                    <span class="set-desc">抽帧封面的原件，放在系统盘；已补上正式封面的那些可以清掉</span>
                </div>
            </div>
            <FrameCacheBlock />
        </section>

        <!-- 卡 · 关于：设置页的固定收尾（Microsoft 指南建议）。
             「打开数据目录」不在这里 —— BackupPanel 里已有同一动作，不复制第二个入口。 -->
        <section class="set-card">
            <div class="set-row">
                <div class="set-text">
                    <span class="set-title">file-finder</span>
                    <span class="set-desc">v{{ version }} · 本地缓存库与图片存放在用户数据目录</span>
                </div>
            </div>
        </section>
    </div>
</template>

<script setup lang="ts">
import { NSwitch, NSlider } from 'naive-ui';
import { playSfx, sfxPrefs, setSfxEnabled, setSfxVolume } from '@/utils/sfx';
import { bloomPrefs, setBloomEnabled } from '@/components/SelectionFlower/pref';
import BackupPanel from '@/views/Cache/BackupPanel.vue';
import FrameCacheBlock from './FrameCacheBlock.vue';
import pkg from '../../../package.json';

const version = pkg.version;
</script>

<style lang="less" scoped>
.general-panel {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    width: 100%;
    max-width: 900px;
    /* 窗口宽时居中（Windows 11 设置同款），窄窗自动贴满 */
    margin-inline: auto;
    padding-right: 6px;
    box-sizing: border-box;
}

/* SettingsCard 模式：panel 底 + 10px 圆角 + 浅色发丝描边（深色靠明度差） */
.set-card {
    background: var(--ff-panel);
    border-radius: var(--ff-r-card);
    box-shadow: inset 0 0 0 1px var(--ff-card-outline);
    padding: 6px 16px;
    margin-bottom: 16px;
}

.set-row {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 0;
    min-height: 44px;
    box-sizing: border-box;
}

.set-row + .set-row {
    border-top: 1px solid var(--ff-line);
}

.set-row-head {
    padding-bottom: 2px;
}

.set-text {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
}

.set-title {
    font-size: 13px;
    font-weight: 500;
    color: var(--ff-text-1);
}

.set-desc {
    font-size: 12px;
    color: var(--ff-text-2);
}

.sfx-vol {
    width: 200px;
}
</style>
