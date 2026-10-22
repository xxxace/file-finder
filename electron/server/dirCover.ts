/**
 * 「目录自己的脸」的固定文件名 —— **唯一真相源**。
 *
 * `avatar.jpg` 是这套机制原来的名字，`cover.jpg` 是实际盘上在用的，两个都得认，
 * 否则"机制在、图也在、就是不生效"。
 *
 * **为什么只认固定名字、不取"目录里第一张图"**：目录里第一张图通常是**影片封面**
 * （`ABC-123/ABC-123.jpg`），那是要被 `handleCover` 收敛成封面条目的东西 ——
 * 拿它当目录图标，等于把一个影片目录画成了自己。固定名字是唯一明确表达
 * "我是这个目录的脸"的写法。
 *
 * **为什么不改成列目录找**：`readdir` 要遍历整张目录表，比按名字 `stat` 贵得多
 * （判据见 `server/index.ts` 的 `makeDirCover`）。所以名单每加一个名字，代价是
 * **每个没脸的目录多一次失败的 stat** —— 这笔账要算在"加名字"上，而不是"改成列目录"。
 *
 * **2026-10-22 加 webp 两档**：盘上确实有 `cover.webp` / `avatar.webp`（外部下载器写的），
 * 只认 `.jpg` 时这些目录永远不长脸。顺序上 **jpg 优先** ⇒ 有 `cover.jpg` 的目录
 * 行为与以前**一模一样**。
 *
 * ⚠️ 两处必须共用这一份：`server/index.ts`（扫盘）与 `server/assistant/scan.ts`
 * （找缺封面的深度重扫）。各留副本时，加格式漏改一边的后果不是"少认一张图"，
 * 而是助手认为"这个目录没脸" → 把已有的 webp 封面**再覆盖一遍**。
 */
export const DIR_COVER_FILES = ['avatar.jpg', 'cover.jpg', 'avatar.webp', 'cover.webp'];

/** 这个文件名是不是"目录封面"。大小写不敏感 —— NTFS 本来就不区分大小写 */
export function isDirCover(name: string): boolean {
    return DIR_COVER_FILES.includes(name.toLowerCase());
}
