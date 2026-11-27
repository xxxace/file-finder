export { default as DistortionWaveOverlay } from './DistortionWaveOverlay.vue';
export { useWaveOverlay } from './useWaveOverlay';
export type { UseWaveOverlayOptions } from './useWaveOverlay';
export { captureViewportSnapshot } from './capture';
export type { ViewportSnapshotOptions } from './capture';
export { readThemeWavePalette, readElementBackground, cssColorToRgb } from './theme';
export {
    defaultStyle,
    duration,
    waveFront,
    rimLumps,
    makeParticles,
    particleAt,
    oklab,
    newFront,
} from './model';
export type { WaveType, WaveStyle, Palette, RGB, Front, Particle, Rect, Point, Spot } from './model';
export { WaveRenderer } from './renderer';
export type { DotBuffer, FrameOptions, RendererOptions, ScreenSlot } from './renderer';
