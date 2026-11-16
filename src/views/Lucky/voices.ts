/**
 * 抽卡音效 —— 逐行移植自 `holo-reverse/src/app.js` 的 `note()` / `voices()` / `wake()`（560~671 行）。
 *
 * ## 为什么不用 `@/utils/sfx` 的配方引擎
 *
 * 那套是"一次性渲染成 AudioBuffer 再重放"，只适合**离散事件**。参考站最要紧的一层是
 * **连续、随手的快慢变化的撕裂声**：一个常驻的噪声源（`foil` 缓冲，900 个随机小脆响），
 * 音量 `rip(v)` 每帧按手的角速度写 `setTargetAtTime`，慢拉是零星脆响、快拉是一声长撕。
 * 这是"配方"表达不了的 —— 所以这里保留源码的实时合成写法，**不要改写成本仓引擎的调用**。
 *
 * ## 与参考站的两处差异（都是"接进本应用"，不是改效果）
 *
 * 1. 静音/音量跟随应用设置 `sfxPrefs`（`ff.sfx`），不另起一套开关；
 * 2. `AudioContext` 由 `wakeVoices()` 在首次用户手势里建，符合浏览器自动播放策略。
 */
import { watch } from 'vue';
import { sfxPrefs } from '@/utils/sfx';

/** 总音量。要整体调大调小改这一个数 */
const VOLUME = 0.8;
/** 五声音阶：i 步进 C 大调五声（从 C5 起） */
const note = (i: number): number => 440 * 2 ** ((72 + 12 * ((i / 5) | 0) + [0, 2, 4, 7, 9][i % 5] - 69) / 12);

type Pan = number[] | Float32Array;

interface AirOptions {
    at?: number;
    buffer?: AudioBuffer;
    type?: BiquadFilterType;
    from: number;
    to: number;
    Q?: number;
    gain: number;
    attack?: number;
    dur: number;
    send?: number;
    pan?: Pan;
    /** 钟形包络：淡入淡出、两头没有硬边 */
    bell?: boolean;
}

interface ChimeOptions {
    at?: number;
    gain?: number;
    dur?: number;
    send?: number;
    pan?: number;
}

interface CooOptions {
    at?: number;
    gain?: number;
    attack?: number;
    wobble?: number;
    send?: number;
    pan?: number;
    wave?: OscillatorType;
}

export interface Voices {
    ctx: AudioContext;
    mute(off: boolean, at?: number): void;
    /** 撕裂声。`v` 0~1，由"这一帧撕了多少 / dt"算出 —— 慢拉是脆响，快拉是长撕 */
    rip(v: number, at?: number): void;
    grab(at?: number): void;
    eep(at?: number): void;
    phew(at?: number): void;
    boing(at?: number): void;
    pop(flies?: boolean, at?: number): void;
    swirl(len: number, at?: number): void;
    land(name: string, slot: number, at?: number): void;
    lift(slot: number, at?: number): void;
    tick(at?: number): void;
    arrive(at?: number): void;
}

function build(ctx: AudioContext): Voices {
    const sr = ctx.sampleRate;
    const now = () => ctx.currentTime;
    const handheld = matchMedia('(pointer: coarse)').matches;

    const master = ctx.createGain();
    const limit = ctx.createDynamicsCompressor();
    const room = ctx.createConvolver();
    const wet = ctx.createGain();
    limit.threshold.value = -9;
    limit.knee.value = 6;
    limit.ratio.value = 8;
    limit.attack.value = 0.002;
    limit.release.value = 0.1;
    master.gain.value = 0;
    wet.gain.value = 0.3;
    master.connect(limit).connect(ctx.destination);
    room.connect(wet).connect(master);

    const sheet = (channels: number, seconds: number, fill: (d: Float32Array) => void): AudioBuffer => {
        const b = ctx.createBuffer(channels, (seconds * sr) | 0, sr);
        for (let c = 0; c < channels; c += 1) fill(b.getChannelData(c));
        return b;
    };

    const hiss = sheet(1, 2, (d) => {
        for (let i = 0; i < d.length; i += 1) d[i] = Math.random() * 2 - 1;
    });

    // 几百个随机小脆响，几个响、多数极轻：每一下都是铝箔的一处折缝崩开。
    // 音量压得很低时只有响的那几个能听见 —— "嘶"的颗粒感就来自这里
    const foil = sheet(1, 2, (d) => {
        for (let n = 0; n < 900; n += 1) {
            const start = (Math.random() * (d.length - 400)) | 0;
            const amp = Math.random() ** 3 * (Math.random() < 0.5 ? -1 : 1);
            const len = (30 + Math.random() * 260) | 0;
            for (let i = 0; i < len; i += 1) {
                d[start + i] += amp * (Math.random() * 2 - 1) * Math.exp(-i / len * 5);
            }
        }
    });

    // 一间小而亮的房间，随着衰减变暗
    room.buffer = sheet(2, handheld ? 0.5 : 0.9, (d) => {
        let soft = 0;
        for (let i = 0; i < d.length; i += 1) {
            const k = i / d.length;
            soft += (Math.random() * 2 - 1 - soft) * (0.5 - 0.42 * k);
            d[i] = soft * (1 - k) ** 3;
        }
    });

    const env = (param: AudioParam, at: number, peak: number, attack: number, dur: number): void => {
        param.setValueAtTime(0.0001, at);
        param.exponentialRampToValueAtTime(peak, at + attack);
        param.exponentialRampToValueAtTime(0.0001, at + dur);
    };

    const out = (node: AudioNode, send?: number): void => {
        node.connect(master);
        if (!send) return;
        const s = ctx.createGain();
        s.gain.value = send;
        node.connect(s).connect(room);
    };

    /** 一团被塑形的噪声 */
    function air(o: AirOptions): void {
        const {
            at = now(), buffer = hiss, type = 'bandpass', from, to,
            Q = 1, gain, attack = 0.004, dur, send = 0, pan = [0, 0], bell = false,
        } = o;
        const s = ctx.createBufferSource();
        const f = ctx.createBiquadFilter();
        const g = ctx.createGain();
        const p = ctx.createStereoPanner();
        s.buffer = buffer;
        s.loop = true;
        f.type = type;
        f.Q.value = Q;
        f.frequency.setValueAtTime(from, at);
        f.frequency.exponentialRampToValueAtTime(to, at + dur);
        if (bell) {
            g.gain.setValueCurveAtTime(
                Float32Array.from({ length: 48 }, (_, i) => gain * Math.sin(Math.PI * i / 47) ** 2), at, dur,
            );
        } else env(g.gain, at, gain, attack, dur);
        if (pan.length > 2) {
            p.pan.setValueCurveAtTime(pan as Float32Array, at, dur);
        } else {
            p.pan.setValueAtTime((pan as number[])[0], at);
            p.pan.linearRampToValueAtTime((pan as number[])[1], at + dur);
        }
        s.connect(f).connect(g).connect(p);
        out(p, send);
        s.start(at, Math.random() * 1.8);
        s.stop(at + dur + 0.02);
    }

    /** 玩具木琴：基音 + 两根会先死的泛音 */
    function chime(freq: number, o: ChimeOptions = {}): void {
        const { at = now(), gain = 0.1, dur = 0.5, send = 0.5, pan = 0 } = o;
        const g = ctx.createGain();
        const p = ctx.createStereoPanner();
        g.gain.value = gain;
        p.pan.value = pan;
        g.connect(p);
        out(p, send);
        for (const [ratio, level, life] of [[1, 1, 1], [3.9, 0.18, 0.22], [9.2, 0.05, 0.08]]) {
            const f = freq * ratio;
            // 奈奎斯特极限截断：超出采样率一半（44.1kHz 下为 22050Hz）的高次泛音人耳无法感知且会导致 Web Audio 报错
            if (f >= ctx.sampleRate / 2) continue;
            const osc = ctx.createOscillator();
            const a = ctx.createGain();
            const d = Math.max(0.03, dur * life);
            osc.frequency.value = f;
            env(a.gain, at, level, 0.002, d);
            osc.connect(a).connect(g);
            osc.start(at);
            osc.stop(at + d + 0.02);
        }
    }

    /** 一张小嘴：圆润的音色按 `[秒, 音高倍数]` 的轮廓走，`wobble` 让它打颤 */
    function coo(freq: number, shape: Array<[number, number]>, o: CooOptions = {}): void {
        const { at = now(), gain = 0.06, attack = 0.008, wobble = 0, send = 0.25, pan = 0, wave = 'triangle' } = o;
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        const p = ctx.createStereoPanner();
        const dur = shape[shape.length - 1][0] + 0.05;
        osc.type = wave;
        p.pan.value = pan;
        for (const [s, m] of shape) {
            if (s) osc.frequency.exponentialRampToValueAtTime(freq * m, at + s);
            else osc.frequency.setValueAtTime(freq * m, at);
        }
        env(g.gain, at, gain, attack, dur);
        if (wobble) {
            const l = ctx.createOscillator();
            const d = ctx.createGain();
            l.frequency.value = 24;
            d.gain.value = freq * wobble;
            l.connect(d).connect(osc.frequency);
            l.start(at);
            l.stop(at + dur + 0.02);
        }
        osc.connect(g).connect(p);
        out(p, send);
        osc.start(at);
        osc.stop(at + dur + 0.02);
    }

    const sparkle = (n: number, at: number, spread: number, level: number): void => {
        for (let i = 0; i < n; i += 1) {
            chime(note((8 + Math.random() * 5) | 0), {
                at: at + Math.random() ** 1.4 * spread,
                gain: level * (0.6 + Math.random() * 0.8),
                dur: 0.35,
                send: 0.9,
                pan: Math.random() * 1.4 - 0.7,
            });
        }
    };

    // 撕裂声从不停止播放，只是静音待着手动起来
    const ripBody = ctx.createBufferSource();
    const ripShape = ctx.createBiquadFilter();
    const ripTop = ctx.createBiquadFilter();
    const ripGain = ctx.createGain();
    ripBody.buffer = foil;
    ripBody.loop = true;
    ripShape.type = 'bandpass';
    ripShape.Q.value = 0.6;
    ripTop.type = 'lowpass';
    ripTop.frequency.value = 6000;
    ripGain.gain.value = 0;
    ripBody.connect(ripShape).connect(ripTop).connect(ripGain);
    out(ripGain, 0.12);
    ripBody.start();

    let level = 0;

    return {
        ctx,
        mute(off: boolean, at: number = now()): void {
            const target = off ? 0 : VOLUME * sfxPrefs.vol;
            master.gain.setTargetAtTime(target, at, 0.015);
        },
        rip(v: number, at: number = now()): void {
            const k = Math.min(1, Math.max(0, v));
            if (Math.abs(k - level) < 0.01 && (k || !level)) return;
            const rising = k > level;
            level = k;
            ripGain.gain.setTargetAtTime(k ** 0.8 * 0.15, at, rising ? 0.008 : 0.05);
            ripShape.frequency.setTargetAtTime(1800 + 2000 * k, at, 0.02);
            ripBody.playbackRate.setTargetAtTime(0.7 + 0.8 * k, at, 0.02);
        },
        grab(at: number = now()): void {
            air({ at, buffer: foil, from: 3000, to: 2200, Q: 0.7, gain: 0.3, attack: 0.003, dur: 0.09 });
        },
        eep(at: number = now()): void {
            coo(1250, [[0, 0.82], [0.05, 1.25], [0.13, 1.02]], { at, gain: 0.05, wobble: 0.04 });
        },
        phew(at: number = now()): void {
            coo(900, [[0, 1.1], [0.24, 0.6]], { at, gain: 0.05, send: 0.45 });
            air({ at, from: 1500, to: 700, Q: 0.6, gain: 0.03, attack: 0.02, dur: 0.26 });
        },
        boing(at: number = now()): void {
            coo(340, [[0, 0.8], [0.05, 1.6], [0.12, 0.85], [0.2, 1.25], [0.3, 1]], { at, gain: 0.12, send: 0.2 });
        },
        pop(flies = true, at: number = now()): void {
            air({ at, from: 5000, to: 1800, Q: 0.9, gain: 0.14, attack: 0.002, dur: 0.1 });
            coo(300, [[0, 0.8], [0.05, 3.4]], { at, gain: 0.3, send: 0.15 });
            if (!flies) return;
            air({ at: at + 0.01, from: 500, to: 3200, Q: 0.8, gain: 0.09, attack: 0.2, dur: 0.7, send: 0.6 });
            coo(540, [[0, 1], [0.6, 3]], { at: at + 0.02, gain: 0.03, attack: 0.22, wobble: 0.012, send: 0.6 });
            sparkle(3, at + 0.12, 0.5, 0.018);
        },
        swirl(len: number, at: number = now()): void {
            air({
                at, from: 700, to: 1800, Q: 0.9, gain: 0.12, attack: len * 0.4, dur: len, send: 0.4,
                pan: Float32Array.from({ length: 64 }, (_, i) => {
                    const u = i / 63;
                    return Math.cos((1 - (1 - u) ** 2) * Math.PI * 2.5) * (1 - u) * 0.8;
                }),
            });
        },
        land(name: string, slot: number, at: number = now()): void {
            air({ at, from: 2600, to: 1300, Q: 0.6, gain: 0.07, attack: 0.002, dur: 0.05 });
            if (name === 'nova') {
                coo(659, [[0, 0.94], [0.035, 1]], { at: at + 0.06, gain: 0.04, attack: 0.006, send: 0.06, pan: (slot - 2) * 0.18, wave: 'sine' });
            }
        },
        lift(slot: number, at: number = now()): void {
            const side = (slot - 2) * 0.18;
            air({ at, type: 'lowpass', from: 760, to: 480, Q: 0.3, gain: 0.0449, bell: true, dur: 0.22, pan: [side, side] });
        },
        tick(at: number = now()): void {
            coo(880, [[0, 0.9], [0.05, 1.12]], { at, gain: 0.04, send: 0 });
        },
        arrive(at: number = now()): void {
            air({ at, from: 900, to: 2600, gain: 0.06, attack: 0.3, dur: 0.75, send: 0.4, pan: [0.7, 0] });
            air({ at: at + 0.72, buffer: foil, from: 3000, to: 2200, Q: 0.7, gain: 0.16, attack: 0.003, dur: 0.09 });
            coo(note(3), [[0, 0.9], [0.05, 1.03]], { at: at + 0.78, gain: 0.05 });
            coo(note(5), [[0, 0.9], [0.06, 1.03]], { at: at + 0.87, gain: 0.05 });
        },
    };
}

let current: Voices | null = null;
let prefStop: (() => void) | null = null;

/**
 * 首次用户手势里建 AudioContext（浏览器规则），之后每次调用只是 `resume`。
 * 任何一步失败都当作"这台机器没有声音"—— 动效照常，不许因此报错。
 */
export function wakeVoices(): Voices | null {
    if (current) {
        // 没有手势时 resume() 会被拒（自动播放策略），拒了就当静音，别冒泡成未处理异常
        if (current.ctx.state === 'suspended') current.ctx.resume().catch(() => undefined);
        return current;
    }
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    try {
        const raw = build(new AC({ latencyHint: 'interactive' }));
        // 源码同样把每个声部包在 try 里：某一个声部炸了，别的照常响
        const safe = {} as Record<string, unknown>;
        for (const [k, f] of Object.entries(raw)) {
            safe[k] = typeof f === 'function'
                ? (...a: unknown[]) => { try { return (f as (...x: unknown[]) => unknown)(...a); } catch { return undefined; } }
                : f;
        }
        current = safe as unknown as Voices;
        current.mute(!sfxPrefs.on);
        current.ctx.resume().catch(() => undefined);
        prefStop = watch(
            () => [sfxPrefs.on, sfxPrefs.vol] as const,
            () => current?.mute(!sfxPrefs.on),
        );
        return current;
    } catch {
        current = null;
        return null;
    }
}

/** 当前实例（还没醒就是 `null`，调用方写 `voices()?.grab()`） */
export function voices(): Voices | null {
    return current;
}

/** 离开抽卡页时丢掉实例：AudioContext 不可复用，下次进页重新建 */
export function sleepVoices(): void {
    prefStop?.();
    prefStop = null;
    try { void current?.ctx.close(); } catch { /* 已经关了 */ }
    current = null;
}
