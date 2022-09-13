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