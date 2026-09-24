import { rmSync } from 'fs'
import path from 'path'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import electronSimple from 'vite-plugin-electron/simple'
import { notBundle } from 'vite-plugin-electron/plugin'
import pkg from './package.json'

rmSync('dist', { recursive: true, force: true }) // v14.14.0

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    vue(),
    /**
     * v1 起 `vite-plugin-electron` 拆成了三块：`vite-plugin-electron`（low-level）
     * + `vite-plugin-electron/simple`（"main/preload/renderer" 糖）
     * + `vite-plugin-electron-renderer`（渲染层用 node 能力）。
     * 这里用 `simple`，形状与旧版一致；唯一的语义变化是 `onstart`：旧版是一个**插件**，
     * 新版是一个**回调**（传了它，插件就不再自动拉起 Electron）。
     */
    electronSimple({
      main: {
        entry: 'electron/main/index.ts',
        // 旧版把 `onstart()` 塞进 `vite.plugins` 来阻止自动启动；
        // 新版传了这个回调就不自动启动，交给 VS Code 调试器。
        onstart: process.env.VSCODE_DEBUG ? () => {} : undefined,
        vite: {
          build: {
            // For Debug
            sourcemap: true,
            outDir: 'dist/electron/main',
          },
          /**
           * vpe 0.x 默认把 package.json 的依赖外置；v1 改成「只外置 node 内置模块」，
           * 依赖会被**打进** bundle。这对本项目是致命的：`@ffmpeg-installer/ffmpeg` 与
           * `fluent-ffmpeg` 都靠 `__dirname` 定位自己包内的文件（ffmpeg.exe / presets），
           * 一旦被内联，`__dirname` 变成 `dist/electron/main`，`indexOf('node_modules')`
           * 返回 -1 → 抽帧时报「找不到 ffmpeg 可执行文件」。打包版（files 只含 dist，
           * 但 electron-builder 会把 dependencies 一并装进 asar）本来就依赖这套外置契约。
           * `notBundle()` 就是官方用来恢复该行为的开关。
           */
          plugins: [notBundle()],
        },
      },
      preload: {
        input: {
          // You can configure multiple preload here
          index: path.join(__dirname, 'electron/preload/index.ts'),
        },
        vite: {
          build: {
            // For Debug
            sourcemap: 'inline',
            outDir: 'dist/electron/preload',
          },
          // 与主进程同一条契约：预加载脚本也不许把运行期依赖内联进来。
          // （今天 preload 没 import 任何依赖，加它是为了让以后新增时不会踩同一个坑。）
          plugins: [notBundle()],
        },
      },
      /**
       * Enables use of Node.js API in the Renderer-process
       * https://github.com/electron-vite/vite-plugin-electron/tree/main/packages/electron-renderer#electron-renderervite-serve
       *
       * 这里必须传一个对象：只有给了 `renderer`，`simple` 才会去 import
       * `vite-plugin-electron-renderer` —— 渲染层里 `import { ipcRenderer } from 'electron'`
       * 靠它把 `electron` 换成 `require("electron")` 的虚拟模块（页面开了 nodeIntegration）。
       *
       * 旧版在这写过 `resolve() { return ['iconv-lite', 'fluent-ffmpeg', ...] }`，已删除：
       * ① 渲染层从未 import 过这几个包（零引用）；② 新版该选项的类型已从「字符串数组」
       * 变成「{ 模块名: { type } } 映射」，那个数组从来没生效过。留着只会骗后来的人。
       */
      renderer: {},
    }),
  ],
  resolve: {
    alias: [
      { find: '@', replacement: path.resolve(__dirname, './src') },
      { find: 'vue', replacement: 'vue/dist/vue.esm-bundler.js' }
    ],
    extensions: ['.ts', '.vue', '.js']
  },
  server: process.env.VSCODE_DEBUG ? {
    host: pkg.debug.env.VITE_DEV_SERVER_HOST,
    port: pkg.debug.env.VITE_DEV_SERVER_PORT,
  } : undefined,
})
