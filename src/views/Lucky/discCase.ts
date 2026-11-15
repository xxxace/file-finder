/**
 * 抽卡的几何与物理 —— 纯函数，零 DOM、零 Vue。
 *
 * 与 `drawModel.ts` 分开的理由：那个文件管"抽到哪 5 部"，这个文件管"它们摆在哪儿、
 * 怎么倾斜"。两件事的验证方式完全不同（前者探针跑断言，后者只能目视 + 数值自检）。
 */

/** 指针位置（-1~1）换算出的渲染参数。全部是"直接写进 CSS 变量"的量。 */
export interface Tilt {
    /** 0~100，眩光与箔的百分比坐标 */
    px: number;
    py: number;
    /** 0~1，离中心多远 —— 驱动反光强度（越斜越亮，符合物理） */
    hyp: number;
    /** rotateX / rotateY 的角度 */
    rx: number;
    ry: number;
}

/** 最大倾斜角。7° 是"能看出来但还没变形"的位置；再大封面的字会开始糊 */
export const MAX_TILT_DEG = 7;

/**
 * 指针 → 倾斜。
 *
 * `hyp` 多乘了一个 1.6：参考站那条曲线在卡片中段几乎不亮（只有很靠边才有箔），
 * 而这五张卡是用来"挑"的，反光要能提示"鼠标在这张上"。乘完再 clamp 到 1。
 */
export function tiltOf(nx: number, ny: number): Tilt {
    const cx = Math.max(-1, Math.min(1, nx));
    const cy = Math.max(-1, Math.min(1, ny));
    return {
        px: (cx + 1) * 50,
        py: (cy + 1) * 50,
        hyp: Math.min(1, (Math.hypot(cx, cy) / Math.SQRT2) * 1.6),
        rx: -cy * MAX_TILT_DEG,
        ry: cx * MAX_TILT_DEG,
    };
}

/** 一张卡在扇形里的落点 */
export interface FanSpot {
    /** rotateZ（deg）：中间那张 0，向两侧对称外旋 */
    rot: number;
    /** 向下的位移（px）：中间最高、两侧依次下沉 */
    dy: number;
    /** 叠放层级：中间最大，向外递减（中间那张压在邻居上面） */
    z: number;
}

/** 相邻两张的旋转差。5 张跨度 -9°~+9°；9 张就压到 -6.75°~+6.75°（仍互不重叠） */
export function fanOf(index: number, count: number): FanSpot {
    if (count <= 1) return { rot: 0, dy: 0, z: 1 };
    const mid = (count - 1) / 2;
    const offset = index - mid;
    const step = 9 * Math.min(1, 4 / Math.max(1, mid * 2));
    return {
        rot: offset * step,
        dy: Math.abs(offset) * 14,
        z: count - Math.round(Math.abs(offset)),
    };
}
