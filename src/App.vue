<template>
  <n-loading-bar-provider>
    <FileFinder />
  </n-loading-bar-provider>
</template>

<script setup lang="ts">
// This starter template is using Vue 3 <script setup> SFCs
// Check out https://vuejs.org/api/sfc-script-setup.html#script-setup
import FileFinder from './views/FileFinder/index.vue';
import { NLoadingBarProvider } from 'naive-ui';

</script>

<style>
#app {
  font-family: Avenir, Helvetica, Arial, sans-serif;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  color: #2c3e50;
}
</style>
