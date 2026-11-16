/**
 * 抽卡视觉探针（**不是产品页**）。
 *
 * 目的：把「撕开 + 彩虹高度 + 卡片扇形缩放 + 卡片等级」在真浏览器里画一次。
 * 数据是假的（真数据要主进程，占 3060 端口，会和业主运行中的实例打架），
 * 但用到的**组件、CSS、几何函数全是产品代码本体** —— 量的是几何，不是行为。
 *
 * 跑法：
 *   npx vite --config docs/probes/lucky-geometry/vite.config.ts
 *   msedge --headless=new --window-size=1440,900 --virtual-time-budget=3000 \
 *          --screenshot=out.png "http://localhost:5188/docs/probes/lucky-geometry/lucky.html?state=fan"
 *   state: sealed | tear | fan        frames: 手动泵的帧数（tear 用）
 */
import { createApp, h, onMounted, ref } from 'vue';
import '@/styles/tokens.css';
import LuckyPack from '@/components/LuckyPack/index.vue';
import LuckyDiscCard from '@/components/LuckyDiscCard/index.vue';
import { CardShow } from '@/views/Lucky/cardShow';
import type { PackPose } from '@/views/Lucky/cardShow';
import { burst } from '@/views/Lucky/confetti';
import type { ConfettiPose } from '@/views/Lucky/confetti';
import { rollRarities } from '@/views/Lucky/drawModel';
import type { DrawCard } from '@/views/Lucky/drawModel';

const params = new URLSearchParams(location.search);
/** `tear`（默认，撕开看彩虹）/ `fan`（直接落成扇形看卡片）/ `sealed`（只看包） */
const STATE = params.get('state') || 'tear';
/** 量真实帧时间（含绘制）：不接管 rAF，跑一段固定剧本把每帧间隔记下来，POST 给 collect.cjs */
const MEASURE = params.get('measure') === '1';
/** 逐项关掉某一层来定位开销：?kill=flow,blur,flap,lips,pack（只影响探针，不动产品代码） */
const KILL = (params.get('kill') || '').split(',').filter(Boolean);
/** 手动推进多少帧（≈16.7ms/帧）。无头模式里 rAF 基本不跑，只能自己泵 */
const FRAMES = Number(params.get('frames') || 150);
/**
 * 带上彩带（`?fx=1`）。
 *
 * ⚠️ 彩带恰好和"卡片飞出/螺旋"同一段时间跑，而之前那版量分**没开彩带** ——
 *    所以"cards 阶段 6.1ms 到地板"这个结论对真机是不完整的。
 */
const FX = params.get('fx') === '1';
const H = window.innerHeight;

/**
 * 拿掉 rAF，换成可手动泵的队列。
 *
 * ⚠️ 无头 Chrome/Edge 的 `--virtual-time-budget` 会把 `setTimeout` 快进到底，
 *    但 rAF 仍然受真实渲染节拍约束 ⇒ 截到的永远是动画开头那几帧。
 *    把回调攒起来自己按 16.7ms 推，弹簧就走在确定的帧数上（可复现）。
 */
let queue: FrameRequestCallback[] = [];
let clock = 0;
if (!MEASURE) {
    window.requestAnimationFrame = (cb: FrameRequestCallback): number => {
        queue.push(cb);
        return queue.length;
    };
    window.cancelAnimationFrame = () => undefined;
}
function pump(frames: number, step = 16.7): void {
    for (let i = 0; i < frames; i += 1) {
        const batch = queue;
        queue = [];
        clock += step;
        for (const cb of batch) {
            try { cb(clock); } catch (e) {
                const b = document.getElementById('err');
                if (b) b.textContent += `pump err: ${String(e)}\n`;
            }
        }
    }
}

const TITLES = ['ABP-123 某部作品', 'SSIS-456 另一个标题', 'STARS-789 长一点的标题', 'FC2-1234567', 'MIDE-001 短名'];

function fake(i: number, gb: number, r: ReturnType<typeof rollRarities>[number]): DrawCard {
    return {
        key: `k${i}`,
        title: TITLES[i],
        sig: '',
        serial: 'X',
        letter: 'C',
        online: true,
        sizeText: `${gb.toFixed(1)} GB`,
        ...r,
        src: null as unknown as DrawCard['src'],
    };
}

// 等级走产品同一套洗牌（一包 2 Common / 1 Rare / 1 Holo / 1 Ultra）
const MIX = rollRarities(5);
const cards: DrawCard[] = [
    fake(0, 0.6, MIX[0]),
    fake(1, 2.1, MIX[1]),
    fake(2, 5.4, MIX[2]),
    fake(3, 12.6, MIX[3]),
    fake(4, 1.6, MIX[4]),
];

const phase = ref<'sealed' | 'opening' | 'open'>(STATE === 'fan' ? 'open' : 'sealed');
/** 卡包组件挂出来的四个接口（`pose` 同时满足卡片编排与彩带投影两边的形状） */
type PackApi = { pose: () => PackPose & ConfettiPose; tearYAt: (x: number) => number; tearAll: () => void };
const packRef = ref<PackApi | null>(null);
const fxEl = ref<HTMLCanvasElement | null>(null);
const sceneEl = ref<HTMLElement | null>(null);
const show = new CardShow();
let stopFx: (() => void) | null = null;
const slots: (HTMLElement | null)[] = [];

/** 与产品页 `fireConfetti()` 同一条：从包里出来、越过撕口才散开 */
function fireFx(): void {
    const canvas = fxEl.value;
    const packer = packRef.value;
    if (!FX || !canvas || !packer) return;
    stopFx?.();
    stopFx = burst(canvas, {
        vw: window.innerWidth,
        vh: window.innerHeight,
        getPose: () => packer.pose(),
        tearYAt: packer.tearYAt,
        count: 240,
    });
}

function setSlot(i: number, el: unknown) {
    slots[i] = el instanceof HTMLElement ? el : null;
    show.setSlot(i, slots[i]);
}

function cardSize() {
    const ph = Math.min(400, H * 0.52);
    const cw = ph * 0.69 * 0.84;
    return { cw, ch: cw * 1.4 };
}

function syncBox() {
    const el = sceneEl.value;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const { cw, ch } = cardSize();
    show.setBox({
        w: r.width, h: r.height,
        ox: r.left + r.width / 2,
        oy: r.top + r.height / 2,
        p0y: r.top + r.height * 0.4,
        cw, ch,
    });
}

let t = 0;
let last = 0;
let pending = false;

function frame(now: number) {
    const dt = last ? Math.min(0.05, (now - last) / 1000) : 0;
    last = now;
    t += dt;
    const pose = packRef.value?.pose();
    if (pose) {
        if (pending) {
            pending = false;
            show.start(t);
        }
        show.tick(t, dt, pose);
    }
    requestAnimationFrame(frame);
}

/** 给"直接落位"用的空姿态（这时包已经不在了） */
const dummyPose = {
    rx: 0, ry: 0, rz: 0, px: 0, py: 0,
    pw: Math.min(400, H * 0.52) * 0.69,
    ph: Math.min(400, H * 0.52),
    fallY: 0,
    mouth: 0,
};

function bench(): void {
    const box = document.getElementById('err');
    const say = (k: string, v: number) => {
        if (box) box.textContent += `${k}: ${v.toFixed(2)} ms/frame\n`;
    };
    const t0 = performance.now();
    pump(60);
    say('sealed (包在呼吸)', (performance.now() - t0) / 60);
    packRef.value?.tearAll();
    pump(40);
    const t1 = performance.now();
    pump(60);
    say('tearing (撕+光流)', (performance.now() - t1) / 60);
    pump(200);
    const t2 = performance.now();
    pump(60);
    say('spread (五张卡静置)', (performance.now() - t2) / 60);
}

/** 五段剧本各量一段：静置包 / 撕（含光流+彩带）/ 卡片飞出与螺旋 / 落位 / 静置卡片 */
function measure(): void {
    const rec: Record<string, number[]> = { sealed: [], tear: [], cards: [], land: [], idle: [] };
    const t0 = performance.now();
    let last = 0;
    let torn = false;
    const phaseAt = (ms: number): string => (ms < 1200 ? 'sealed' : ms < 3000 ? 'tear' : ms < 4400 ? 'cards' : ms < 5600 ? 'land' : 'idle');

    const loop = (now: number) => {
        const dt = last ? now - last : 0;
        last = now;
        const ms = performance.now() - t0;
        if (!torn && ms >= 1200) {
            torn = true;
            packRef.value?.tearAll();
            fireFx();
        }
        if (dt > 0 && dt < 600) rec[phaseAt(ms)].push(dt);
        if (ms < 6800) requestAnimationFrame(loop);
        else void report(rec);
    };
    requestAnimationFrame(loop);
}

async function report(rec: Record<string, number[]>): Promise<void> {
    const stat = (a: number[]) => {
        if (!a.length) return { n: 0 };
        const b = [...a].sort((x, y) => x - y);
        const q = (p: number) => b[Math.min(b.length - 1, Math.floor(p * b.length))];
        return {
            n: b.length,
            avg: +(b.reduce((s, v) => s + v, 0) / b.length).toFixed(1),
            p50: +q(0.5).toFixed(1),
            p95: +q(0.95).toFixed(1),
            max: +b[b.length - 1].toFixed(1),
            over20: a.filter(v => v > 20).length,
            over33: a.filter(v => v > 33).length,
        };
    };
    const out: Record<string, unknown> = { ua: navigator.userAgent, dpr: devicePixelRatio, size: [innerWidth, innerHeight] };
    for (const k of Object.keys(rec)) out[k] = stat(rec[k]);
    try {
        await fetch('http://127.0.0.1:5189/collect', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(out, null, 2),
        });
    } catch (e) {
        const box = document.getElementById('err');
        if (box) box.textContent += `POST failed: ${String(e)}\n`;
    }
    const box = document.getElementById('err');
    if (box) box.textContent += JSON.stringify(out);
}

function applyKill(): void {
    const css: string[] = [];
    if (KILL.includes('flow')) css.push('.rays { display: none !important; }');
    if (KILL.includes('blur')) css.push('#ff-bloom { filter: none !important; }');
    if (KILL.includes('flap')) css.push('.flap { display: none !important; }');
    if (KILL.includes('lips')) css.push('.lips { filter: none !important; }');
    if (KILL.includes('pack')) css.push('.pack { visibility: hidden !important; }');
    if (KILL.includes('edges')) css.push('.ff-edge { display: none !important; }');
    if (KILL.includes('motes')) css.push('.ff-mote { display: none !important; }');
    if (KILL.includes('rays2d')) css.push('.rays { transform: none !important; }');
    if (KILL.includes('nomask')) css.push('.rays g[mask] { mask: none !important; }');
    if (css.length) {
        const st = document.createElement('style');
        st.textContent = css.join('\n');
        document.head.append(st);
    }
}

const app = createApp({
    setup() {
        applyKill();
        onMounted(() => {
            if (MEASURE) {
                show.reset(cards.length);
                syncBox();
                requestAnimationFrame(frame);
                measure();
                return;
            }
            show.reset(cards.length);
            syncBox();
            if (STATE === 'fan') {
                // 跳过整段编排，直接落到扇形（走的是"减少动态效果"那条分支）
                show.start(0, true);
                show.tick(1, 0.016, dummyPose);
            } else {
                requestAnimationFrame(frame);
                if (params.get('bench')) {
                    bench();
                } else if (STATE === 'sealed') {
                    pump(FRAMES);
                } else if (STATE === 'tear') {
                    // 先让包飞进来落定（0.7s），再撕，撕完让卡片落位
                    pump(90);
                    packRef.value?.tearAll();
                    // 彩带也走同一个被替换掉的 rAF，所以它跟着 `pump` 一起推进，截图能拍到
                    fireFx();
                    pump(Math.max(1, FRAMES));
                }
            }
            window.addEventListener('resize', syncBox);
        });
        return () => h('div', { class: 'page' }, [
            h('header', { class: 'bar' }, '顶栏 44px'),
            h('div', { class: 'stage' }, [
                h('canvas', { class: 'fx', ref: fxEl }),
                phase.value !== 'open'
                    ? h(LuckyPack, {
                        ref: packRef,
                        phase: phase.value,
                        skin: 'bubblegum',
                        // 探针里**不**把包摘掉：彩虹的收尾也在包身上，摘了就看不到
                        onOpened: () => {
                            phase.value = 'opening';
                            pending = true;
                        },
                    })
                    : null,
                h('div', { class: 'scene', 'data-phase': phase.value, ref: sceneEl },
                    cards.map((c, i) => h('div', {
                        class: 'slot',
                        ref: (el: unknown) => setSlot(i, el),
                    }, [h(LuckyDiscCard, { card: c, index: i, count: cards.length })])),
                ),
            ]),
            h('footer', { class: 'bar bar--bottom' }, '底栏 56px'),
        ]);
    },
});

app.config.errorHandler = (e) => {
    const box = document.getElementById('err');
    if (box) box.textContent += `${String(e)}\n`;
};

const errBox = document.getElementById('err');
window.addEventListener('error', (e) => {
    if (errBox) errBox.textContent += `${e.message} @ ${e.filename}:${e.lineno}\n`;
});
try {
    app.mount('#app');
} catch (e) {
    if (errBox) errBox.textContent += `mount failed: ${String(e && (e as Error).stack || e)}\n`;
}
