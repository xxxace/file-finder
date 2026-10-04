import { defineConfig } from 'vite';
import path from 'node:path';

/** 探针专用构建：把 main.js（真实 import naive-ui 的 ESM 源 + 内部注入键）打成 bundle。 */
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
