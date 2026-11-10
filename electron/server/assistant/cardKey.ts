/**
 * 「一部作品」的唯一标识（卡键）—— 全项目**一份**定义。
 *
 * 四个地方要用同一个键：扫描产出目标、补封面的卡片分组、抽帧缓存的文件名、写盘分组的
 * `ApplyGroup.key`。各自写一遍的结果是"界面上是一张卡、写盘时是两组"这种最难受的 bug，
 * 所以收到这里，谁需要谁 import。
 *
 * ⚠️ 裸文件形态的层目录**必须由 `writeRel` 反推**（`file|层目录|番号`），不取调用方传的
 *    `dir` —— apply 的 `buildGroups` 一直是这么算的（`apply.ts` 里 `dirOf(r.writeRel)`），
 *    两边必须逐字同源。`writeRel` 是 `<dir>/<name>.jpg`，反推出来的就是 `dir`。
 * ⚠️ 目录 / 覆盖形态带 `kind` 前缀：同一层可能有多个待写目标，只用 `writeRel` 当键会把
 *    同层的第二个静默吞掉（`apply.ts:141` 的注释记着这个坑）。
 */
import { createHash } from 'node:crypto';

export type CardKind = 'file' | 'dir' | 'cover';

export interface CardKeyInput {
    kind: CardKind;
    /** 将要写入的封面（盘内相对路径）。裸文件是 `层/名字.jpg`，目录是 `层/目录名.jpg` */
    writeRel: string;
    /** 番号。只有 `kind:'file'` 有 */
    query?: string;
}

/** 取路径的最后一段（本地实现，避免与 server/index.ts 形成循环依赖） */
function dirOf(rel: string): string {
    const i = rel.lastIndexOf('/');
    return i === -1 ? '' : rel.slice(0, i);
}

export function cardKeyOf(x: CardKeyInput): string {
    if (x.kind === 'file') return `file|${dirOf(x.writeRel)}|${x.query ?? ''}`;
    return `${x.kind}|${x.writeRel}`;
}

/**
 * 卡键 → 文件名安全的 16 位十六进制。卡键里有中文、斜杠、竖线，进不了文件名。
 * 只做 sha1 前 16 位：碰撞概率在这个量级（每盘几百到几千张卡）可以忽略，
 * 真的撞上也只会让两张卡共用一份帧缓存，不会写坏盘。
 */
export function key16Of(key: string): string {
    return createHash('sha1').update(key, 'utf8').digest('hex').slice(0, 16);
}
