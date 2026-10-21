<template>
  <n-config-provider :locale="locale" :date-locale="dateLocale" :theme="isDark ? darkTheme : undefined"
    :theme-overrides="isDark ? darkOverrides : lightOverrides">
    <n-dialog-provider>
      <n-notification-provider>
        <n-message-provider>
          <n-loading-bar-provider>
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
import { darkOverrides, lightOverrides } from './styles/naive-theme';

const locale = ref<NLocale | null>(zhCN);
const dateLocale = ref<NDateLocale | null>(dateZhCN);

const { isDark } = useTheme();
</script>

<style>
#app {
  font-family: -apple-system, 'Segoe UI', 'Microsoft YaHei', 'PingFang SC', system-ui, sans-serif;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  color: var(--ff-text-1);
  background: var(--ff-bg);
}
</style>
