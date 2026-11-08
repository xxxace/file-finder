<template>
  <n-config-provider :locale="locale" :date-locale="dateLocale" :theme="isDark ? darkTheme : undefined"
    :theme-overrides="overrides">
    <n-dialog-provider>
      <n-notification-provider>
        <n-message-provider>
          <!-- 顶部进度条：**保留，但先关掉**（2026-11-08 主人："先隐藏，不移除"）。
               效果已经搬到地址槽里（`views/FileFinder/index.vue` 的 `.nav-zone` 内），
               这条留在原地当"退路"：去掉 `visibility`，并把像素层重新挂回这里
               （`<GalaxyLoadingBar />` 放在 provider 之后）、把 `index.vue` 那一处摘掉即可。

               ⚠️ 为什么是 `visibility: hidden` 而不是 `display: none` / `height: 0`：
               地址槽那一层仍以它的**实际宽度**当进度真相源（宽度 ÷ 容器宽 = 比例），
               而 `display:none` 会让 `getBoundingClientRect()` 全归零 ⇒ 进度永远 0。
               `visibility` 不改布局，尺寸照常读得到 —— 这就是"只是看不见"的准确含义。

               容器高度必须在这里给：naive 把它写死 `height: 2px`，且样式是**运行时**注入 head 的、
               比我方 CSS 更晚 ⇒ 同权重下它赢；走 inline style 就与加载顺序无关。 -->
          <n-loading-bar-provider :container-style="{ height: 'var(--ff-bar-h)', visibility: 'hidden' }">
            <AppShell />
          </n-loading-bar-provider>
        </n-message-provider>
      </n-notification-provider>
    </n-dialog-provider>
  </n-config-provider>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import AppShell from './views/Shell/index.vue';
import {
  NConfigProvider, NLoadingBarProvider, NMessageProvider, NNotificationProvider, NDialogProvider,
  zhCN, dateZhCN, darkTheme,
} from 'naive-ui';
import type { NLocale, NDateLocale } from 'naive-ui';
import { useTheme } from './hooks/useTheme';
import { useNaiveOverrides } from './styles/naive-theme';

const locale = ref<NLocale | null>(zhCN);
const dateLocale = ref<NDateLocale | null>(dateZhCN);

const { isDark } = useTheme();
// naive 的配色从 tokens.css 的 L2 变量读，随 isDark 重算（见 naive-theme.ts 顶部说明）
const overrides = useNaiveOverrides();
</script>
