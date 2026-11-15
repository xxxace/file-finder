/**
 * 渲染层的视频扩展名副本。
 *
 * ⚠️ **唯一真相源是 `electron/server/videoExt.ts`** —— 但渲染层**不能** import 它：
 * 那个文件所在目录会拖进 `node:fs` / `http` / `nedb`，整包进渲染 bundle。
 * 所以这里保留一份副本，约定：改服务端那份必须同步改这里（`isVideo` 的名单以它为准）。
 *
 * 2026-11-15 建立：抽卡页要判「这一格里的哪个文件是视频」，而这件事原本在
 * `Tunnel/index.vue` 里有一份正则、`FileFinder/index.vue` 里还有一份。
 * 抽卡页不再新增第三份 —— 新代码一律从这里取。
 */
export const RENDER_VIDEO_EXT: readonly string[] = [
    'mp4', 'mkv', 'avi', 'wmv', 'flv', 'mpeg',
    'm4v', 'mov', 'mpg', 'ts', 'm2ts', 'mts', 'webm', 'ogv', '3gp',
];

/** 作用在**文件名**（带扩展名）上，大小写不敏感 */
export const RENDER_VIDEO_EXT_RE = new RegExp(`\\.(${RENDER_VIDEO_EXT.join('|')})$`, 'i');
