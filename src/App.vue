<template>
  <n-config-provider :locale="locale" :date-locale="dateLocale">
    <n-notification-provider>
      <n-message-provider>
        <n-loading-bar-provider>
          <FileFinder />
        </n-loading-bar-provider>
      </n-message-provider>
    </n-notification-provider>
  </n-config-provider>
</template>

<script setup lang="ts">
// This starter template is using Vue 3 <script setup> SFCs
// Check out https://vuejs.org/api/sfc-script-setup.html#script-setup
import { ref } from 'vue';
import FileFinder from './views/FileFinder/index.vue';
import { NConfigProvider, NLoadingBarProvider, NMessageProvider, NNotificationProvider, zhCN, dateZhCN } from 'naive-ui';
import type { NLocale, NDateLocale } from 'naive-ui';

const locale = ref<NLocale | null>(zhCN);
const dateLocale = ref<NDateLocale | null>(dateZhCN);
</script>

<style>
#app {
  font-family: Avenir, Helvetica, Arial, sans-serif;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  color: #2c3e50;
}
</style>
