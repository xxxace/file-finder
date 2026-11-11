/**
 * 「同一部片的多个文件」的显示顺序。
 *
 * ## 为什么需要它（2026-11-11 业主：「为什么 TST-003-2.mp4 会排在 TST-003.mp4 前面？」）
 *
 * `handleCover` 里的 `files[]` **从来没有排过序**，它就是 `fs.readdir` 的原始顺序。
 * NTFS 的 readdir 近似 UTF-16 码位序，于是：
 *
 *   `TST-003` 之后，`-` = U+002D(45) 而 `.` = U+002E(46) ⇒ `-` 小 ⇒ `…-2.mp4` 排在前面。
 *
 * 这是**扩展名的点**在和分隔符比大小，纯属巧合，没有任何人的意图在里面。
 *
 * ## 为什么先剥掉扩展名再比
 *
 * 实测（`node` 上跑过）：`Intl.Collator` 即使开了 `numeric`，`'TST-003.mp4'` 与
 * `'TST-003-2.mp4'` 仍然是后者在前 —— 因为它先撞上 `.` vs `-` 那一对。
 * 剥掉扩展名后比 `'TST-003'` / `'TST-003-2'`：共同前缀走完，前者**用完**了
 * ⇒ 前缀短的在前。这正是人期望的「母文件在分片前面」。
 *
 * 于是同时满足两件事：
 *   `TST-003.mp4` < `TST-003-2.mp4` < `TST-003-3.mkv` < `TST-003-10.mp4`
 *   `TST-001.mp4`   < `TST-001A.mp4`   < `TST-001B.mp4`
 *
 * ## 为什么不放在服务端
 *
 * `files` 已经随缓存（nedb）落到 `searchCache.db` 里了。在服务端排，**旧缓存不会变**，
 * 得等用户按 ↻ 重扫才生效 —— 而重扫要**读盘**（项目最高优先级是"尽可能少读盘"）。
 * 放在展示层排：2~5 项、`O(n log n)` 可忽略，且**立刻生效**，不碰一次盘。
 *
 * ⚠️ 与 `electron/server/assistant/frame.ts` 的 `natural` 不是同一个判据，别合并：
 * 那边排的是**我自己生成的帧文件名**（扩展名恒定、格式受控），剥不剥扩展名结果一样；
 * 这边排的是**用户盘上的任意文件名**，扩展名可能不同（`…2.mp4` / `…3.mkv`），
 * 剥离是这条规则的关键一步。
 */

/** 自然序：数字段按数值比（`-2` 在 `-10` 前）；大小写不敏感（对齐 Windows 语义）。 */
const natural = (a: string, b: string) =>
    a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

/** 不含扩展名的部分。`dot <= 0` 时（无扩展名 / `.mp4` 这类隐藏文件）原样返回。 */
const stemOf = (name: string) => {
    const dot = name.lastIndexOf('.');
    return dot > 0 ? name.slice(0, dot) : name;
};

/**
 * 文件名排序比较器（喂给 `Array.prototype.sort`，升序）。
 *
 * 先比 stem、stem 相同再整名比 —— 后者只在 `a.mp4` / `a.mkv` 这种同 stem 不同扩展名时
 * 起作用，保证顺序稳定（`sort` 在比较器返回 0 时依赖引擎的稳定性，别指望它）。
 */
export function compareFileName(a: string, b: string): number {
    return natural(stemOf(a), stemOf(b)) || natural(a, b);
}
