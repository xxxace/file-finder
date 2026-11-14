/**
 * 一株花**长什么样**：形状数据结构、尺寸策略、色板、种子随机。
 * 只产数据，一笔都不画 —— 怎么画在 `draw.ts`。
 *
 * 形状规则照 LeiBox `selection-flower` 的种子生成器：
 * 同一个种子必然长出同一株（跨帧稳定），不同字符必然不同（不重复）。
 */

export interface Palette {
    petals: string[];
    centres: string[];
    ink: string;
    stem: string;
    stemHi: string;
    leaf: string;
    leafLine: string;
}

export interface Flower {
    /** 出生点：行盒的上边缘或下边缘（不由字符中心长出来，见 plantFor） */
    x: number;
    y: number;
    /** 茎的二次贝塞尔控制点 */
    cx: number;
    cy: number;
    /** 茎的终点（花头位置） */
    ex: number;
    ey: number;
    direction: 1 | -1;
    /** 0 = 只有花苞不张开 */
    petals: number;
    /** 顶端长什么。草（none）只有茎叶 —— 花头小到一定程度就是一颗看不清的色点 */
    head: 'flower' | 'bud' | 'none';
    radius: number;
    petalWidth: number;
    leaf: number;
    leaves: [boolean, boolean];
    side: 1 | -1;
    rotation: number;
    colour: string;
    centre: string;
    /** 0 收 → 1 张 */
    progress: number;
    target: boolean;
}

/** 一屏最多几株：既是绘制预算，也是"超出的字符不种"的上限 */
export const MAX_FLOWERS = 160;

/** 每个被采样到的字符开花的概率。采样率由调用方按选区大小反推，两者相乘才是实际密度 */
export const DENSITY = 0.35;

/**
 * 花的尺寸 = 行盒高度 / 28。
 * ⚠️ **不夹上下限**：小字就该长小草、大字就该长大花 —— 夹了之后 11px 的路径文字
 * 和 24px 的标题会长出一样大的花，那就不叫"跟着文字大小长"。
 * 小到看不清的问题由 `MIN_HEAD_RADIUS` 兜底（退化成草），不是靠夹 scale。
 * ⚠️ 分母 28 是"整体偏大/偏小"的**唯一旋钮**（原版 demo 是 21.5px 字 / 36px 行高）。
 *    觉得花小就减它，觉得糊就加它；不要去动 `radius` 的系数，那是花头与茎的比例。
 */
export const scaleFor = (lineHeight: number) => lineHeight / 28;

/**
 * 花头半径小于这个值（px）就退化成草：那个尺寸下几个花瓣叠在 8px 里，
 * 只是一颗抖动的色点，不如把茎叶画完整当草看。
 * ⚠️ 判据用**每朵花自己的最终半径**，不是整体 scale —— 同一丛里本来就有大有小。
 */
const MIN_HEAD_RADIUS = 4;

const readVar = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** 每次开新一批花时重读：主题切换（浅/深）会换掉 ink 与主茎色 */
export function readPalette(): Palette {
    const pick = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => readVar(`${prefix}-${i + 1}`)).filter(Boolean);
    const palette: Palette = {
        petals: pick('--ff-flower-petal', 7),
        centres: pick('--ff-flower-centre', 3),
        ink: readVar('--ff-flower-ink'),
        stem: readVar('--ff-flower-stem'),
        stemHi: readVar('--ff-flower-stem-hi'),
        leaf: readVar('--ff-flower-leaf'),
        leafLine: readVar('--ff-flower-leaf-line'),
    };
    // 读不到就是 tokens.css 漏了名字：开发期喊一声，别让整层静默画成黑的
    if (!palette.petals.length && import.meta.env.DEV) console.warn('[selection-flower] token 缺失：--ff-flower-petal-*');
    return palette;
}

/** xorshift32 —— 同一个种子永远给同一串数 */
export function seededRandom(value: number): () => number {
    let x = value || 1;
    return () => {
        x ^= x << 13;
        x ^= x >>> 17;
        x ^= x << 5;
        return (x >>> 0) / 4294967296;
    };
}

/** 字符键（`节点号:偏移`）→ 32 位种子，保证同一个字每次都是同一株花 */
export function hashKey(key: string): number {
    let h = 2166136261;
    for (let i = 0; i < key.length; i++) {
        h ^= key.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
}

/**
 * 一个字符上长什么。采样已经由调用方（`bloom.ts` 的 stride）做过一轮，这里再掷一次骰子。
 * @param seed 本次选择会话的种子，换一次选择就换一批形状
 * @param scale 尺寸倍率，= 行盒高度 / 28
 */
export function plantFor(
    key: string,
    spot: { x: number; top: number; bottom: number },
    seed: number,
    palette: Palette,
    scale = 1,
): Flower | null {
    const rng = seededRandom(seed ^ hashKey(key));
    if (rng() > 1 - DENSITY) return null;

    /* 上下都长，但**两边都朝字外**：向上那株从行盒上边缘出生、向下那株从下边缘出生。
       所以"往上"不会再穿过字（原版能随意上下，是因为它的画布在文字下面，穿过也看不见）。 */
    const up = rng() < 0.45;
    const direction: 1 | -1 = up ? -1 : 1;
    const originY = up ? spot.top : spot.bottom;

    const length = (10 + rng() * 16) * scale;
    const bend = (rng() - 0.5) * 46 * scale;
    /* 花苞（只有一颗不张开的圆点）从 1/5 降到 1/10：它和草一起构成"没开成花"的观感，
       原来两者相加四成，看着像花都没开。 */
    const isBud = rng() < 0.1;
    const family = isBud ? 4 : Math.floor(rng() * 4);
    const petals = isBud ? 0 : [5, 6, 8, 4][family];
    const size = rng();
    // 花头与茎的比例：0.9 —— 花头再小就认不出是花，茎再短就贴不住字
    const radius = (isBud ? 4 + rng() * 2 : size < 0.35 ? 5 + rng() * 5 : size < 0.8 ? 10 + rng() * 7 : 18 + rng() * 5) * scale * 0.9;
    const curve = (rng() - 0.5) * 20 * scale;
    // 花苞本来就"小"，门槛要单独放宽，否则它会被当成草一起吞掉（那这个花型就白设了）
    const visible = radius >= (isBud ? 2.5 : MIN_HEAD_RADIUS);
    const head: Flower['head'] = visible ? (isBud ? 'bud' : 'flower') : 'none';

    return {
        x: spot.x,
        y: originY,
        cx: spot.x + bend * 0.35 + curve,
        cy: originY + direction * length * 0.42,
        ex: spot.x + bend,
        ey: originY + direction * length,
        direction,
        petals,
        radius,
        head,
        petalWidth: family === 2 ? 0.28 : 0.46,
        leaf: (7 + rng() * 8) * scale,
        leaves: [rng() < 0.65, rng() < 0.35],
        side: rng() < 0.5 ? -1 : 1,
        rotation: rng() * Math.PI * 2,
        colour: palette.petals[Math.floor(rng() * palette.petals.length)] ?? '',
        centre: palette.centres[Math.floor(rng() * palette.centres.length)] ?? '',
        progress: 0,
        target: true,
    };
}
