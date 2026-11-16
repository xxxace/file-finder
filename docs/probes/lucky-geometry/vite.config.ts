import path from 'node:path';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// 只给本探针用：不带 electron 插件、不删 dist、端口固定
export default defineConfig({
    root: process.cwd(),
    plugins: [vue()],
    resolve: {
        alias: {
            '@': path.resolve(process.cwd(), 'src'),
            // 浏览器里没有 electron；`utils/request` 顶层要 ipcRenderer
            electron: path.resolve(process.cwd(), 'docs/probes/lucky-geometry/electron-stub.ts'),
        },
    },
    server: { port: 5188, strictPort: true },
});
