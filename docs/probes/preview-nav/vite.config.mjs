import { defineConfig } from 'vite';
import path from 'node:path';

/**
 * 探针专用构建：把 main.js（真实 import 了 naive-ui 的 ESM 源 + 内部注入键）
 * 打成一个 bundle，给 file:// 下的 Electron 页面用。
 *
 * 为什么不能像 preview-fill 那样直接 <script src="node_modules/naive-ui/dist/index.prod.js">：
 * 那条路只拿得到 window.naive 上的公开组件，**拿不到 imageContextKey**（naive-ui 不导出它），
 * 而本轮最需要验的就是"provide 这个内部键能不能喂到 group 渲染出的预览 img"。
 */
export default defineConfig({
    root: __dirname,
    base: './',
    logLevel: 'warn',
    build: {
        outDir: path.join(__dirname, 'dist'),
        emptyOutDir: true,
        target: 'chrome120',
        rollupOptions: { input: path.join(__dirname, 'index.html') },
    },
});
