/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent, ComponentInternalInstance } from 'vue'
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/ban-types
  const component: DefineComponent<{}, {}, any>
  export default component
}

declare module '@ffprobe-installer/ffprobe' {
  export const path: string;
  export const version: string;
  export const url: string;
}

/**
 * naive-ui 的内部注入键（只用这一个符号）。
 * ⚠️ 必须深导入内部模块：n-image-group 的预览 img 只从 provide/inject 的 imageContextKey 读 previewedImgProps，naive-ui 没留对应 prop。
 * ⚠️ 必须手写声明（TS7016）：import 要写 .mjs（resolve.extensions 不含它），而 TS 对 .mjs 只找 .d.mts ⇒ 不声明就报错。
 */
declare module 'naive-ui/es/image/src/interface.mjs' {
  import type { ImgHTMLAttributes, InjectionKey, Ref } from 'vue';
  export const imageContextKey: InjectionKey<{ previewedImgPropsRef: Ref<ImgHTMLAttributes | undefined> }>;
}
