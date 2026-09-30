/**
 * 视频扩展名「单一真相源」（single source of truth）。
 *
 * 为什么独立成文件：视频扩展名名单历史上散落在 4 处 ——
 *   ① `server/index.ts` 的 `isVideo()`（决定扫描时 `type:'video'`，以及要不要跑 ffmpeg 抽帧）
 *   ② `server/index.ts` 的 `MIME` 表（`/raw` 的 Content-Type）
 *   ③ `server/assistant/scan.ts` 的 `liveList()`（缺封面深度重扫的实时分类）
 *   ④ `src/views/FileFinder/index.vue` 的 `VIDEO_EXT_RE`（双击打开视频文件）
 * 每加一个格式要改 4 个地方、漏一处就复发 —— 这正是「在每个调用方各加一道守卫」式的补丁。
 * 把名单收成一处，未来加格式只动这里。
 *
 * 渲染层（④）**不能** import 本文件：会拖 `node:fs` / `http` / `nedb` 进渲染 bundle。
 * 它保留自己的正则副本，约定：以本文件的 `VIDEO_EXT` 为准，改了这里要同步改那边的正则。
 *
 * 选入集合的标准：ffmpeg（内置 2018 版）能**解码并抽帧**的常见视频容器，且真实盘上常见。
 * 不收过于冷门/已淘汰的格式（rm/rmvb、vob、asf 等），避免名单膨胀却用不上。
 */
export const VIDEO_EXT: string[] = [
    // —— 原有 6 个（保持不动，避免任何既有行为变化）——
    'mp4', 'mkv', 'avi', 'wmv', 'flv', 'mpeg',
    // —— 2026-09-25 扩充：覆盖常见视频容器，避免反复返工 ——
    'm4v',   // Apple iTunes 的 MP4 变体（用户实测漏扫，本次触发修复）
    'mov',   // QuickTime
    'mpg',   // MPEG-1/2；`.mpg` 比 `.mpeg` 更常见
    'ts',    // MPEG-TS（流媒体 / 卫星）
    'm2ts',  // AVCHD / Blu-ray 封装
    'mts',   // AVCHD 摄像机
    'webm',  // WebM
    'ogv',   // Ogg 视频
    '3gp',   // 移动端 3GPP
];

/** 扩展名是不是视频。空 / 无扩展名返回 false。大小写不敏感。 */
export function isVideo(ext: string): boolean {
    return ext ? VIDEO_EXT.includes(ext.toLowerCase()) : false;
}

/** `/raw` 返回的 Content-Type。只列视频类，图片走另外的表。 */
export const VIDEO_MIME: Record<string, string> = {
    mp4: 'video/mp4', mkv: 'video/x-matroska', avi: 'video/x-msvideo',
    wmv: 'video/x-ms-wmv', flv: 'video/x-flv', mpeg: 'video/mpeg',
    m4v: 'video/mp4', mov: 'video/quicktime', mpg: 'video/mpeg',
    ts: 'video/mp2t', m2ts: 'video/mp2t', mts: 'video/mp2t',
    webm: 'video/webm', ogv: 'video/ogg', '3gp': 'video/3gpp',
};
