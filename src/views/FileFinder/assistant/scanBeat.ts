/**
 * 扫描骨架的「最短一拍」。
 *
 * 本机扫一层目录常常 30ms 就回来，骨架只来得及渲染 1~2 帧就被整屏内容替换 ——
 * 那一帧闪屏比"完全没有动效"更刺眼。两个面板都要同一个节奏，所以抽在这里，
 * 别各写一个魔法数字（2026-11-08 主人连报两次"点了扫描，内容出来很突兀"）。
 *
 * 420ms 的依据：低于 500ms 仍被感知为"立刻"，但足够让骨架的呼吸看出来一帧半，
 * 也够内容行/卡的入场动效接在后面而不重叠。
 */
export const SCAN_MIN_MS = 420;

/** 补齐这一拍。调用点放在 `finally` 里，保证出错也走同一条时间线。 */
export async function holdScanBeat(startedAt: number): Promise<void> {
    const rest = SCAN_MIN_MS - (performance.now() - startedAt);
    if (rest > 0) await new Promise<void>(resolve => setTimeout(resolve, rest));
}
