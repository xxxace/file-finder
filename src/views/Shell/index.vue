<template>
    <div class="shell">
        <RailNav :active="active" :is-dark="isDark" @select="go" @toggle-theme="toggleTheme" />
        <div class="shell-body">
            <!-- KeepAlive：切页不销毁页面 ⇒ 文件页的导航栈 / 滚动位置 / 搜索词 / 焦点
                 在「去清单看一眼再回来」之后原样还在（这是本次改造的硬要求）。 -->
            <RouterView v-slot="{ Component }">
                <KeepAlive>
                    <component :is="Component" />
                </KeepAlive>
            </RouterView>
        </div>
    </div>
</template>

<script setup lang="ts">
/**
 * 外壳：左轨 + 路由出口。
 *
 * 页级切换交给 vue-router（hash 模式，file:// 下也能刷新）；
 * **页内**的位置（目录、滚动、焦点）仍由各页自己记 —— 两者不互相接管。
 */
import { computed } from 'vue';
import { RouterView, useRoute, useRouter } from 'vue-router';
import RailNav from './RailNav.vue';
import { RAIL_PATHS } from './nav';
import type { RailKey } from './nav';
import { useTheme } from '@/hooks/useTheme';
import { playSfx } from '@/utils/sfx';

const route = useRoute();
const router = useRouter();
const { isDark, toggleTheme } = useTheme();

const active = computed<RailKey>(() => {
    const name = String(route.name || 'files');
    return name === 'playlists' || name === 'cache' || name === 'settings' ? name : 'files';
});

const go = (key: RailKey) => {
    // 已在当前页 = 空点击，不响（路由也不推）。这里是全部菜单点击的唯一出口。
    if (active.value === key) return;
    playSfx('menu-click');
    void router.push(RAIL_PATHS[key]);
};
</script>

<style scoped lang="less">
.shell {
    display: flex;
    /* ⚠️ 用 100vh 而不是 100%：百分比要一路从 html→body→#app 都有定高才成立，
       实际截图里这条链断了一环 ⇒ 左轨只画到内容高度（约 216px），
       下面一截是页底色，看起来像"左轨断了"。100vh 与父链无关，一次解决。 */
    height: 100vh;
    overflow: hidden;
    background: var(--ff-bg);
    color: var(--ff-text-1);
    /* 启动入场：与 preload 覆盖层的淡出（320ms）交叉成一次溶解。
       .shell 是 App 根、只挂载一次 ⇒ 天然只跑一次，KeepAlive 切页不触发。
       ⚠️ transform 只在动画期间存在，结束帧是 none —— 不给子元素留下
       fixed 定位的 containing block（浮层都 teleport 到 body，本就够不着，双保险）。 */
    animation: shell-enter 420ms cubic-bezier(0.19, 1, 0.22, 1) both;
}

@keyframes shell-enter {
    /* ⚠️ 只能从上方落下（-8px）：transform 后的元素仍参与可滚动溢出计算，
       且溢出只向正方向（下/右）累积 —— .shell 恰好 100vh，向下位移 8px
       会让 body 短暂多出可滚区 ⇒ 载入时滚动条一闪而过。向上不算溢出。 */
    from {
        opacity: 0;
        transform: translateY(-8px) scale(0.985);
    }
    to {
        opacity: 1;
        transform: none;
    }
}

@media (prefers-reduced-motion: reduce) {
    .shell {
        animation: none;
    }
}

.shell-body {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
}
</style>
