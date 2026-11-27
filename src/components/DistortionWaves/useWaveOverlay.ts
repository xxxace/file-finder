import { onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue';
import { AuroraWaiting } from './aurora';
import { captureViewportSnapshot } from './capture';
import {
    defaultStyle,
    duration,
    makeParticles,
    newFront,
    particleAt,
    rimLumps,
    smooth,
    waveFront,
    type Front,
    type Particle,
    type Rect,
    type Spot,
    type WaveStyle,
    type WaveType,
} from './model';
import { WaveRenderer, type DotBuffer } from './renderer';
import { readElementBackground, readThemeWavePalette } from './theme';

export interface UseWaveOverlayOptions {
    rootEl: Ref<HTMLElement | null>;
    canvasEl: Ref<HTMLCanvasElement | null>;
    waitingCanvasEl?: Ref<HTMLCanvasElement | null>;
    /** Optional underlying DOM container to snapshot for WebGL lens refraction & chromatic aberration. */
    captureTarget?: Ref<HTMLElement | null>;
    /** Whether the async operation is still running (holds wave in breathing anticipation). */
    running: Ref<boolean>;
    type?: WaveType;
    /** Minimum display time in ms so fast cache hits don't flicker. */
    minDurationMs?: number;
    /** Lead time in ms before the wave front clears the top edge to trigger `onSwept`. */
    sweptLeadMs?: number;
    onSwept?: () => void;
    onClosed?: () => void;
}

const ENTER_MS = 260;
const EXIT_MS = 280;
const LENS_IN_MS = 180;
const PHONE_AREA = 393 * 852;
const MAX_PIXELS = 9_000_000;

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

function findClearAt(src: Rect, vw: number, vh: number, style: WaveStyle, launchAt: number): number {
    const probe = newFront();
    const cleared = (p: number) => waveFront(p, src, vw, vh, style, null, probe).hasCleared;
    if (!cleared(1)) return 1;
    let lo = launchAt;
    let hi = 1;
    for (let i = 0; i < 20; i++) {
        const mid = (lo + hi) / 2;
        if (cleared(mid)) hi = mid;
        else lo = mid;
    }
    return hi;
}

function defaultSourceFor(type: WaveType, vw: number, vh: number): Rect {
    if (type === 'center') {
        return { x: vw / 2 - 29, y: vh / 2 - 29, w: 58, h: 58 };
    }
    if (type === 'horizontal') {
        const len = Math.min(vh * 0.5, 240);
        return { x: -20, y: (vh - len) / 2, w: 40, h: len };
    }
    const len = Math.min(vw - 48, 345);
    return { x: (vw - len) / 2, y: vh - 62, w: len, h: 58 };
}

/**
 * Drives a WebGL 2 DistortionWave overlay with a two-phase timeline:
 *   1. Waiting (`running === true` or `< minDurationMs`): gentle breathing anticipation + rim pulse + gathering dots
 *   2. Sweeping (`running === false` and `>= minDurationMs`): full distortion wave sweep-out, then `onSwept` & `onClosed`.
 */
export function useWaveOverlay(opts: UseWaveOverlayOptions) {
    const veilOpacity = ref(0);
    const lightsOpacity = ref(0);
    const waitingOpacity = ref(0);
    const elapsedSec = ref(0);
    const isSweeping = ref(false);

    let raf = 0;
    let observer: ResizeObserver | null = null;
    let renderer: WaveRenderer | null = null;
    const aurora = new AuroraWaiting();
    let destroyed = false;
    let done = false;
    let swept = false;

    let mountedAt = 0;
    let sweepStartedAt = 0;
    let lensArrivedAt = 0;
    let hasLens = false;

    let vw = 1;
    let vh = 1;
    let k = 1;
    let cornerRadius = 0;
    let style: WaveStyle = defaultStyle(opts.type ?? 'vertical', readThemeWavePalette());
    let totalSec = duration(style);
    let launchAt = style.anticipation / totalSec;
    let clearAt = 1;
    let sourceRect: Rect = { x: 0, y: 0, w: 58, h: 58 };

    let particles: Particle[] = [];
    const dots: DotBuffer = { data: new Float32Array(0), count: 0 };
    const front: Front = newFront();
    const spot: Spot = { x: 0, y: 0, a: 0 };
    const frameOpts = { floor: 0, gain: 0, round: true, same: true };

    const minMs = opts.minDurationMs ?? 2000;
    const sweptLeadMs = opts.sweptLeadMs ?? 350;
    const waveType = opts.type ?? 'vertical';
    const isReduced = () =>
        typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    function rebuildStyleAndGeometry() {
        const root = opts.rootEl.value;
        const canvas = opts.canvasEl.value;
        if (!root || !canvas) return;

        const rect = root.getBoundingClientRect();
        const w = Math.max(rect.width, 1);
        const h = Math.max(rect.height, 1);

        const cs = getComputedStyle(root);
        const rad = parseFloat(cs.borderTopLeftRadius) || 0;
        k = clamp(Math.sqrt((w * h) / PHONE_AREA), 0.6, 2.2);
        vw = w / k;
        vh = h / k;
        cornerRadius = rad / k;

        const dpr = window.devicePixelRatio || 1;
        const maxTex = renderer?.maxTextureSize || 4096;
        const bs = Math.min(dpr, Math.sqrt(MAX_PIXELS / (w * h)), maxTex / w, maxTex / h);
        const pw = Math.max(1, Math.round(w * bs));
        const ph = Math.max(1, Math.round(h * bs));
        if (canvas.width !== pw || canvas.height !== ph) {
            canvas.width = pw;
            canvas.height = ph;
        }

        const palette = readThemeWavePalette();
        style = defaultStyle(waveType, palette);
        style.cornerRadius = cornerRadius;
        // Disable static center-pinch suction since there is no physical button press source
        style.pull = 0;
        const thin = Math.sqrt(k);
        style.hairlineWidth /= thin;
        style.particleSize /= thin;

        if (opts.waitingCanvasEl?.value) {
            aurora.refreshColors();
            aurora.resize(opts.waitingCanvasEl.value);
        }

        totalSec = duration(style);
        launchAt = style.anticipation / totalSec;
        sourceRect = defaultSourceFor(waveType, vw, vh);
        clearAt = findClearAt(sourceRect, vw, vh, style, launchAt);

        particles = makeParticles(style);
        if (dots.data.length < particles.length * 3) {
            dots.data = new Float32Array(particles.length * 3);
        }
    }

    async function tryCaptureLens() {
        const target = opts.captureTarget?.value;
        const root = opts.rootEl.value;
        if (!target || !root || !renderer || renderer.lost || destroyed) return;

        const rect = target.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return;

        const dpr = window.devicePixelRatio || 1;
        const scale = Math.min(dpr, 1.5, Math.sqrt(MAX_PIXELS / (rect.width * rect.height)));
        try {
            const snap = await captureViewportSnapshot(target, {
                width: rect.width,
                height: rect.height,
                scale,
                background: readElementBackground(target),
                skip: (el) => el.hasAttribute('data-dw-skip'),
            });
            if (!snap || destroyed || !renderer || renderer.lost) return;
            renderer.setScreen(snap, vw, vh, style.blur, 'content');
            hasLens = true;
            lensArrivedAt = performance.now();
        } catch {
            // Degrade gracefully to lens-free colorful wave
        }
    }

    function finish() {
        if (done) return;
        done = true;
        if (raf) cancelAnimationFrame(raf);
        raf = 0;
        renderer?.clear();
        opts.onClosed?.();
    }

    function tick(now: number) {
        if (done || destroyed) return;
        raf = requestAnimationFrame(tick);

        const ms = now - mountedAt;
        const sec = ms / 1000;
        elapsedSec.value = sec;
        const fadeIn = smooth(0, ENTER_MS, ms);

        // Transition from waiting to sweeping once task stops and minMs is satisfied
        if (!sweepStartedAt && !opts.running.value && ms >= minMs) {
            sweepStartedAt = now;
            isSweeping.value = true;
        }

        if (!sweepStartedAt) {
            // Phase 1: Waiting — calm flowing aurora & rising motes (no frozen lens pinch)
            veilOpacity.value = fadeIn * 0.62;
            waitingOpacity.value = fadeIn;
            lightsOpacity.value = 0;
            const wCanvas = opts.waitingCanvasEl?.value;
            if (wCanvas) aurora.draw(wCanvas, sec, fadeIn);
            return;
        }

        // Phase 2: Sweeping — fade out waiting aurora smoothly and launch DistortionWave
        const sweepDurMs = Math.max((1 - launchAt) * totalSec * 1000, 1);
        const raw = (now - sweepStartedAt) / sweepDurMs;
        const p = launchAt + (1 - launchAt) * clamp(raw, 0, 1);
        waveFront(p, sourceRect, vw, vh, style, null, front);

        const auroraFadeOut = smooth(0, 220, now - sweepStartedAt);
        waitingOpacity.value = 1 - auroraFadeOut;
        const wCanvas = opts.waitingCanvasEl?.value;
        if (wCanvas && auroraFadeOut < 0.99) {
            aurora.draw(wCanvas, sec, 1 - auroraFadeOut);
        }

        const veilFadeOut = smooth(launchAt, Math.max(clearAt, launchAt + 0.05), p);
        veilOpacity.value = fadeIn * (1 - veilFadeOut) * 0.62;
        lightsOpacity.value = fadeIn;

        // Trigger completion sound right before the wave crest reaches the top edge
        const remainingToClearMs = (clearAt - p) * totalSec * 1000;
        if (!swept && remainingToClearMs <= sweptLeadMs) {
            swept = true;
            opts.onSwept?.();
        }

        if (raw >= 1) {
            finish();
            return;
        }

        if (!renderer || renderer.lost) return;

        // Pack active particles
        let count = 0;
        if (front.time > 0) {
            for (let i = 0; i < particles.length; i++) {
                const part = particles[i];
                particleAt(part, front, sourceRect, style, spot);
                if (spot.a <= 0.002) continue;
                dots.data[count * 3] = spot.x;
                dots.data[count * 3 + 1] = spot.y;
                dots.data[count * 3 + 2] = Math.floor(part.size * 10) + Math.min(spot.a, 0.999);
                count++;
            }
        }
        dots.count = count;

        renderer.setSize(vw, vh);
        renderer.setBlur(style.blur);
        frameOpts.gain = hasLens ? smooth(0, LENS_IN_MS, now - lensArrivedAt) : 0;
        const lumps = rimLumps(front.time, vw, vh, style.cornerRadius, style.rimPulse);
        renderer.render(front, style, lumps, dots, frameOpts);
    }

    onMounted(() => {
        mountedAt = performance.now();
        const canvas = opts.canvasEl.value;
        const root = opts.rootEl.value;
        if (!root || !canvas) return;

        if (isReduced()) {
            veilOpacity.value = 0.58;
            lightsOpacity.value = 1;
            const triggerReducedExit = () => {
                const wait = Math.max(0, mountedAt + minMs - performance.now());
                setTimeout(() => {
                    if (destroyed) return;
                    if (!swept) {
                        swept = true;
                        opts.onSwept?.();
                    }
                    veilOpacity.value = 0;
                    lightsOpacity.value = 0;
                    setTimeout(() => finish(), EXIT_MS);
                }, wait);
            };
            if (!opts.running.value) triggerReducedExit();
            else {
                const stop = watch(opts.running, (on) => {
                    if (!on) {
                        stop();
                        triggerReducedExit();
                    }
                });
            }
            return;
        }

        renderer = new WaveRenderer(canvas, { alpha: true });
        if (!renderer.ok) {
            renderer = null;
        }

        rebuildStyleAndGeometry();
        void tryCaptureLens();

        observer = new ResizeObserver(() => rebuildStyleAndGeometry());
        observer.observe(root);

        raf = requestAnimationFrame(tick);
    });

    onBeforeUnmount(() => {
        destroyed = true;
        done = true;
        if (raf) cancelAnimationFrame(raf);
        raf = 0;
        observer?.disconnect();
        observer = null;
        if (renderer && !renderer.lost) {
            renderer.dispose();
            opts.canvasEl.value?.getContext('webgl2')?.getExtension('WEBGL_lose_context')?.loseContext();
        }
        renderer = null;
    });

    return {
        veilOpacity,
        lightsOpacity,
        waitingOpacity,
        elapsedSec,
        isSweeping,
    };
}
