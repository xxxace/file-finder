/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent, ComponentInternalInstance } from 'vue'
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/ban-types
  const component: DefineComponent<{}, {}, any>
  // export interface ComponentInternalInstance {
  //   ...ComponentInternalInstance 
  // }
  export default component
}

declare module '@ffprobe-installer/ffprobe' {
  export const path: string;
  export const version: string;
  export const url: string;
}

/**
 * naive-ui 的**内部**注入键（只用这一个符号）。
 *
 * 为什么非要深导入一个内部模块：预览层改由 `n-image-group` 渲染之后，`previewedImgProps`
 * （"铺满视口" + "双击穿透"两件已实测的特性）**只能从 provide/inject 的 `imageContextKey` 走**
 * —— naive-ui 没给 group 留对应 prop，预览那张 img 是从 context 读它的
 * （`es/image/src/ImagePreview.mjs`）。详见 `src/views/FileFinder/index.vue` 组节点那段说明。
 *
 * 为什么还要手写声明（TS7016）：包里的类型文件是 `interface.d.ts`，而 import 必须写 `.mjs`
 * —— 本项目 `vite.config.ts` 的 `resolve.extensions` 是 `['.ts','.vue','.js']`，
 * 不带扩展名连 dev/构建都解析不了（实测构建报 "Rollup failed to resolve"）；
 * 而 TS 的 node 解析对 `.mjs` 只找 `.d.mts` ⇒ 不声明就报错。
 * 处理手法与上面 `@ffprobe-installer/ffprobe` 一致（同一个文件里的先例）。
 */
declare module 'naive-ui/es/image/src/interface.mjs' {
  import type { ImgHTMLAttributes, InjectionKey, Ref } from 'vue';
  export const imageContextKey: InjectionKey<{ previewedImgPropsRef: Ref<ImgHTMLAttributes | undefined> }>;
}
