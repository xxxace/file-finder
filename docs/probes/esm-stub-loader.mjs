/**
 * ESM loader：把 `electron` 这个裸模块名重定向到同目录的 `electron-stub.mjs`。
 * 由 `ffprobe-timeout-fix.mjs` 通过 `module.register()` 装上，只影响该探针进程。
 */
export async function resolve(specifier, context, nextResolve) {
    if (specifier === 'electron') {
        return { url: new URL('./electron-stub.mjs', import.meta.url).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
}
