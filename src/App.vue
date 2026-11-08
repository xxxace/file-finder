<template>
  <n-config-provider :locale="locale" :date-locale="dateLocale" :theme="isDark ? darkTheme : undefined"
    :theme-overrides="overrides">
    <n-dialog-provider>
      <n-notification-provider>
        <n-message-provider>
          <!-- 顶部进度条的容器高度必须在这里给：naive 把它写死 `height: 2px`，
               而它的样式是**运行时**注入 head 的、比我方 CSS 更晚 ⇒ 同权重下它赢。
               走 inline style 就与加载顺序无关。（像素层见 `components/GalaxyLoadingBar`） -->
          <n-loading-bar-provider :container-style="{ height: 'var(--ff-bar-h)' }">
            <AppShell />
          </n-loading-bar-provider>
          <!-- 进度条的 galaxy 像素层：只画 naive 画不出来的那层（逐格相位 + 密度梯度 + 前缘辉光） -->
          <GalaxyLoadingBar />
        </n-message-provider>
      </n-notification-provider>
    </n-dialog-provider>
  </n-config-provider>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import AppShell from './views/Shell/index.vue';
import GalaxyLoadingBar from './components/GalaxyLoadingBar/index.vue';
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
