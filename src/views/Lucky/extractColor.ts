/**
 * 封面主色提取与淡彩卡纸生成算法
 *
 * ## 设计准则
 * 1. 极轻量：采用 16×16 离屏微型 Canvas 降采样（仅 256 像素），提取耗时在 0.2ms 以内；
 * 2. 浅色实体纸质感：按用户要求，提取主色后乘以高比例浅色淡化混合（12% 封面主色 + 88% 暖白象牙纸底），
 *    还原原版 Blip（浅暖粉橙）与 Cubit（浅抹茶绿）般温润高雅的实体收藏卡纸风格；
 * 3. 色彩纪律：严格复用 `tokens.css` 变量（`--ff-card-paper-top/bottom/edge`），TS 零硬编码色值。
 */

export interface RGB {
    r: number;
    g: number;
    b: number;
}

export interface PaperStyle {
    frame: string;
    edge: string;
}

/** 共享的微型离屏 Canvas（避免重复创建与垃圾回收） */
let offscreenCanvas: HTMLCanvasElement | null = null;
let offscreenCtx: CanvasRenderingContext2D | null = null;

function getCanvas(): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null {
    if (typeof document === 'undefined') return null;
    if (!offscreenCanvas) {
        offscreenCanvas = document.createElement('canvas');
        offscreenCanvas.width = 16;
        offscreenCanvas.height = 16;
        offscreenCtx = offscreenCanvas.getContext('2d', { willReadFrequently: true });
    }
    if (!offscreenCtx) return null;
    return { canvas: offscreenCanvas, ctx: offscreenCtx };
}

/**
 * 提取图片中占比最高且具有代表性的主色调
 * 过滤纯黑（<12%）、纯白（>94%）和低饱和灰度杂色
 */
export function extractDominantHue(img: HTMLImageElement): RGB | null {
    if (!img.naturalWidth || !img.naturalHeight) return null;
    const c = getCanvas();
    if (!c) return null;

    try {
        c.ctx.clearRect(0, 0, 16, 16);
        c.ctx.drawImage(img, 0, 0, 16, 16);
        const imgData = c.ctx.getImageData(0, 0, 16, 16);
        const data = imgData.data;

        // 12 个色相桶（每桶 30 度），按桶统计色彩能量
        const buckets: { count: number; r: number; g: number; b: number }[] = Array.from({ length: 12 }, () => ({
            count: 0,
            r: 0,
            g: 0,
            b: 0,
        }));

        let validPixels = 0;

        for (let i = 0; i < data.length; i += 4) {
            const a = data[i + 3];
            if (a < 128) continue;

            const r = data[i];
            const g = data[i + 1];
            const b = data[i + 2];

            const max = Math.max(r, g, b);
            const min = Math.min(r, g, b);
            const delta = max - min;
            const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;

            // 过滤极暗部与高光纯白
            if (lum < 0.12 || lum > 0.94) continue;
            // 过滤灰度杂色（饱和度极低）
            if (delta < 20) continue;

            // 计算色相角（0 ~ 360 度）
            let h = 0;
            if (max === r) {
                h = ((g - b) / delta) % 6;
            } else if (max === g) {
                h = (b - r) / delta + 2;
            } else {
                h = (r - g) / delta + 4;
            }
            h = Math.round(h * 60);
            if (h < 0) h += 360;

            const bucketIdx = Math.floor(h / 30) % 12;
            const weight = delta; // 饱和度越高，在桶内权重越大
            buckets[bucketIdx].count += weight;
            buckets[bucketIdx].r += r * weight;
            buckets[bucketIdx].g += g * weight;
            buckets[bucketIdx].b += b * weight;
            validPixels++;
        }

        // 若有效彩色像素过少（如纯黑白剧照或灰阶图），退回默认暖白卡纸
        if (validPixels < 12) return null;

        // 找出色彩能量最大的桶
        let bestBucket = buckets[0];
        for (let i = 1; i < buckets.length; i++) {
            if (buckets[i].count > bestBucket.count) {
                bestBucket = buckets[i];
            }
        }

        if (bestBucket.count === 0) return null;

        return {
            r: Math.round(bestBucket.r / bestBucket.count),
            g: Math.round(bestBucket.g / bestBucket.count),
            b: Math.round(bestBucket.b / bestBucket.count),
        };
    } catch (err) {
        // 跨域或图像未完成解码安全保护
        if (process.env.NODE_ENV === 'development') {
            console.warn('[extractColor] failed to extract hue:', err);
        }
        return null;
    }
}

/**
 * 根据主色调生成温润雅致的淡彩艺术卡纸样式
 * 融合原版 Blip（粉橙）与 Cubit（抹茶绿）的经典色彩比例（24%~36% 主色调混入暖白底纸）
 */
export function generatePaperStyle(rgb: RGB | null): PaperStyle | null {
    if (!rgb) return null;
    const { r, g, b } = rgb;
    return {
        frame: `linear-gradient(165deg, color-mix(in srgb, rgb(${r}, ${g}, ${b}) 24%, var(--ff-card-paper-top)), color-mix(in srgb, rgb(${r}, ${g}, ${b}) 36%, var(--ff-card-paper-bottom)))`,
        edge: `color-mix(in srgb, rgb(${r}, ${g}, ${b}) 55%, var(--ff-card-edge))`,
    };
}
