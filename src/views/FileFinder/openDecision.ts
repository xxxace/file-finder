/**
 * 「这一格代表什么」—— 决定 `Enter` / 双击**打开什么**。
 *
 * ## 为什么独立成文件（而不是写在 `index.vue` 里）
 *
 * 1. **它是被真机报过 bug 的判据**（2026-10-04：「回车打开的是预览图不是文件」）。
 *    判据必须能被夹具直接断言 ⇒ 不能埋在 SFC 里。
 * 2. 探针 `docs/probes/grid-cursor-focus/` 要**跑同一份代码**。
 *    写在 SFC 里就只能让探针**手抄**⇒ 改探针不改真代码，回退真源码时探针依然全绿
 *    （这个错已经犯过一次，见该探针 README）。
 * 3. 它是**纯逻辑、零 DOM、零状态** —— 与 `gridGeometry.ts` 同族，天然该独立。
 *
 * ## ⚠️ 判据为什么不能看 `type`（这里曾是真 bug）
 *
 * `type` 描述的是**这一格显示的那张图**，不是"这一格代表什么"。
 * 服务端 `handleCover` 收敛一个目录时写的是 `type: getFileType(ext)`，
 * 而那个 `ext` 取的是**封面图**的扩展名（`electron/server/index.ts`）
 * ⇒ **收敛卡片的 `type` 恒为 `'image'`**。
 *
 * 所以一张 `type === 'image'` 的卡片，可能是一张真图片，**也可能**是一整个目录。
 * 只看 `type` 就会把"一个只含 1 个视频的目录"错判成图片 ⇒ 回车弹出封面大图，
 * 而用户要的是打开那个视频。**这就是业主真机看到的现象。**
 *
 * ##⚠️ 也不能写 `files.length > 1`
 *
 * `handleCover` 把**除封面图以外**的所有文件塞进 `files`（封面图自己被 `continue` 掉），
 * 而"一部片子 = 一个视频 + 若干图片"是常态 ⇒ `length === 1` **最常见**。
 * 用 `> 1` 会把最常见的那种漏判成图片。
 */

/** `files` 那一项的形状（与服务端 `FileInfoFiles` 一致；只用到这两个字段）。 */
export interface FileEntry {
    name: string;
    size: number;
}

/** 判据只需要这几个字段 ⇒ 用窄接口而不是 `WiredFileInfo`，探针才好造夹具。 */
export interface CardLike {
    type: string;
    files?: FileEntry[];
}

/** 收敛卡片：`files` 非空 ⟺ 还有一个类型是 FileEntry[] 的东西。类型谓词，调用处能窄化。 */
export type DirCard = CardLike & { files: FileEntry[] };

/**
 * 这一格是不是**在替一个目录代言**（服务端把它收敛成了一张卡片）。
 *
 * 长度是几都算 —— 见文件头那两条⚠️。
 */
export function isDirCard(item: CardLike): item is DirCard {
    return !!item.files && item.files.length > 0;
}

/**
 * 这一格背后有**不止一个**文件可选（双击要不要弹层）。
 *
 * ## 为什么它与 `isDirCard` 是两件事，不能合并成一个
 *
 * 两者回答的是**不同问题**：
 * - `isDirCard` 回答"这一格**代表什么**" ⇒ 决定 `Enter` 走"打开文件"还是"开预览"。
 * - `isMultiFileCard` 回答"要不要问用户选哪个" ⇒ 决定**双击**弹不弹层，
 *   而那是**既有行为，一个字都不改**。
 *
 * 合成一个（`length > 1`）会让 `Enter` 在"目录里只有一个文件"时错判成图片
 * —— 就是2026-10-04 那个 bug。合成另一个（`length > 0`）又会让**双击**在
 * 单文件目录上多弹一层只有一项的弹层，属于擅改既有行为。
 */
export function isMultiFileCard(item: CardLike): item is DirCard {
    return !!item.files && item.files.length > 1;
}

/** `Enter` / 双击要做的动作。**纯描述、无副作用** —— 界面层照它派发就行。 */
export type OpenAction =
    | { kind: 'drill'; path: string }        // 下钻目录
    | { kind: 'open-item' }                  // 打开这一格自己（系统程序）
    | { kind: 'open-inner'; name: string }   // 打开目录代言卡片里的某一个文件
    | { kind: 'pick-from-list' }             // 弹文件列表让用户选
    | { kind: 'preview' };                   // 开内置预览

/** `onCursorConfirm` 需要的额外信息（拼路径要用 `dir`）。 */
export interface OpenTarget extends CardLike {
    dir: string;
    name: string;
}

/**
 * 「回车」打开什么 —— **主界面那条规则的唯一实现**。
 *
 * | 条目 | 动作 | 为什么 |
 * |---|---|---|
 * | 换封面模式中 | （不在这判：调用方先处理）| 模式态里"打开"不是用户想要的 |
 * | 目录 | 下钻 | |
 * | **目录代言**·只有 1 个文件 | 打开它 | 弹层的前提是"有得选"；一个文件时弹层纯属多一步 |
 * | **目录代言**·2 个以上 | 弹文件列表 | 一部片子有多部时必须问"哪一部" |
 * | **真图片** | **开内置预览** | 裁决：图片用内置的（翻页/缩放/定位都在）|
 * | 视频 / 其他文件 | 系统打开 | 它们的"打开"就是播放 / 交给系统 |
 *
 * ⚠️ **判据顺序不能换**：先问 `isDirCard` 再问 `type`。
 * 先判 `type` 会把"目录只含 1 个视频"的卡片错当成图片（业主真机报的那个现象）。
 *
 * @param item   当前格
 * @param picking 换封面模式中？那时返回 `null`（调用方去走"选中"，不是"打开"）
 */
export function decideOpen(item: OpenTarget, picking: boolean): OpenAction | null {
    if (picking) return null;
    if (item.type === 'folder') return { kind: 'drill', path: `${item.dir}/${item.name}` };
    if (isDirCard(item)) {
        // ⚠️ 这里**不自己取** `files[0]`：只含 1 个文件时也可能是图片而不是视频，
        // 而"在 files 里找视频"那条逻辑（连同"找不到就退回第一个"的兜底）
        // 已经在 `openFile` 的 item 分支里写好了（它的注释就叫"双击封面 = 打开里面的视频"）。
        // 重复实现一遍只会两处走偏。`name: ''` = 由调用方交给 `openFile(item)` 决定。
        return item.files.length === 1
            ? { kind: 'open-item' }
            : { kind: 'pick-from-list' };
    }
    // 到这里 `files` 为空 ⇒ 这一格就是它自己
    if (item.type === 'image') return { kind: 'preview' };
    return { kind: 'open-item' };
}
