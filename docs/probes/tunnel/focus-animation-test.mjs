// docs/probes/tunnel/focus-animation-test.mjs
import assert from 'assert';

console.log('=== Probe: Focus Animation Continuity Test ===\n');

const ease = (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);

function simulateFlight() {
    const dur = 1.15;
    const dt = 1 / 60;
    let heroAmt = 0;
    const history = [];

    const F = { p: 0, dur, side: 1, x0: 5, y0: 3, x1: 0, y1: 0 };
    const dx = F.x1 - F.x0;
    const dy = F.y1 - F.y0;
    const len = Math.hypot(dx, dy) || 1;

    let inFlight = true;

    // Record initial frame at p = 0
    history.push({
        frame: 0,
        inFlight: true,
        p: 0,
        s: 1.0,
        z: 0.0,
        rz: 0,
        ryF: 0
    });

    for (let frame = 1; frame <= 100; frame++) {
        let arcZ = 0;
        let rz = 0;
        let ryF = 0;
        let flightHero = 0;

        if (inFlight) {
            F.p = Math.min(1, F.p + dt / F.dur);
            const e = ease(F.p);
            const bump = Math.sin(Math.PI * e);
            const amp = Math.min(3.2, len * 0.32) * F.side;
            arcZ = bump * 1.0;
            rz = bump * 0.22 * F.side;
            ryF = bump * 0.35 * Math.sign(dx || 1);
            flightHero = e;
            heroAmt = Math.max(heroAmt, e);
            if (F.p >= 1) inFlight = false;
        }

        let heroFactor = inFlight ? flightHero : heroAmt;
        const s = 1 + 0.7 * heroFactor;
        const z = 1.3 * heroFactor + arcZ;

        history.push({
            frame,
            inFlight,
            p: F.p,
            s,
            z,
            rz,
            ryF
        });
    }

    return history;
}

const frames = simulateFlight();

// 1. 验证起飞状态
const first = frames[0];
assert.strictEqual(first.s, 1.0, 'Scale must start at 1.0');
console.log('PASS: Takeoff scale starts cleanly at 1.0');

// 2. 验证飞行中尺度单调递增，绝无“放大后缩回小图再放大”
let prevS = first.s;
for (const f of frames) {
    assert(f.s >= prevS - 1e-6, `Scale dropped at frame ${f.frame}: prev=${prevS}, now=${f.s}`);
    prevS = f.s;
}
console.log('PASS: Hero scale is strictly monotonic non-decreasing (never shrinks back to small during transition)');

// 3. 验证最高空 3D 飞行俯仰与偏航
const mid = frames.find(f => f.p >= 0.5);
assert(mid.z > 1.3, 'Mid-air Z arc gives graceful forward swoop');
assert(Math.abs(mid.rz) > 0.1, '3D roll rotation active during swoop');
assert(Math.abs(mid.ryF) > 0.1, '3D yaw rotation active during swoop');
console.log(`PASS: 3D Swoop arc active in mid-air (z=${mid.z.toFixed(2)}, rz=${mid.rz.toFixed(2)}, ryF=${mid.ryF.toFixed(2)})`);

// 4. 验证着陆与着陆后无缝衔接
const touchdownIndex = frames.findIndex(f => !f.inFlight);
const touchdown = frames[touchdownIndex];
const postTouchdown = frames[touchdownIndex + 1];

assert(Math.abs(touchdown.s - 1.7) < 1e-6, 'Touchdown scale reaches exactly 1.7');
assert(Math.abs(touchdown.z - 1.3) < 1e-6, 'Touchdown elevation reaches exactly 1.3');
assert(Math.abs(postTouchdown.s - 1.7) < 1e-6, 'Post-touchdown scale locked at 1.7 (zero drop)');
assert(Math.abs(postTouchdown.z - 1.3) < 1e-6, 'Post-touchdown elevation locked at 1.3 (zero drop)');
console.log('PASS: Touchdown and resting state perfectly locked at scale 1.7 and depth 1.3 without any double-play glitch');

// 5. 验证自动漫游在 3D 棋盘格隧道中严格向前推进，绝不后退
function simulateAutoTravelSteps() {
    const D = 5.5;
    const NL = 14;
    const FOCUS = 14;
    const CAM0 = FOCUS;
    let travel = 0;

    // 构造三维棋盘格层列表，只有偶数层拥有中心封面
    const layers = [];
    for (let k = 0; k < NL; k++) {
        const hasCenter = k % 2 === 0;
        layers.push({ k, z: -k * D, hasCenter });
    }

    const steps = [];

    for (let step = 0; step < 8; step++) {
        const fz = CAM0 - travel - FOCUS;
        // 循环层包装
        for (const L of layers) {
            while (L.z > -travel + CAM0 - 1) L.z -= NL * D;
            while (L.z < -travel + CAM0 - 1 - NL * D) L.z += NL * D;
        }

        let minAheadDist = 1e9;
        for (const L of layers) {
            if (L.hasCenter) {
                const distAhead = fz - L.z;
                if (distAhead > 1.5 && distAhead < minAheadDist) {
                    minAheadDist = distAhead;
                }
            }
        }

        const prevTravel = travel;
        const advance = minAheadDist < 1e8 ? minAheadDist : 2 * D;
        travel += advance;
        steps.push({ step, prevTravel, advance, travel });
    }

    return steps;
}

const travelSteps = simulateAutoTravelSteps();
for (const step of travelSteps) {
    assert(step.advance > 5.0, `Advance must be positive and span to next center layer, got ${step.advance}`);
    assert(step.travel > step.prevTravel, `Travel must strictly advance forward: prev=${step.prevTravel}, now=${step.travel}`);
}
console.log(`PASS: Auto-travel strictly advances forward across center layers (step advance = ${travelSteps[0].advance.toFixed(1)} units, strictly monotonic)`);

// 6. 验证相机穿梭逼近过程中的物理透视连续聚焦（无停顿后原地突变跳大）
function simulateApproachContinuity() {
    const D = 5.5;
    const smooth = (a, b, x) => {
        const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
        return t * t * (3 - 2 * t);
    };

    let prevScale = 1.0;
    const history = [];

    // 相机从距离 11.0 逼近到 0.0
    for (let dist = 11.0; dist >= 0.0; dist -= 0.1) {
        let isHero = 0;
        if (dist < D) {
            isHero = smooth(D, 0.0, dist);
        }
        const s = 1 + 0.7 * isHero;
        // 每步跨度极小，无突变
        assert(s >= prevScale - 1e-6, `Scale must not decrease during approach at dist=${dist}`);
        assert(s - prevScale < 0.05, `Scale must not jump abruptly (jump = ${s - prevScale}) at dist=${dist}`);
        prevScale = s;
        history.push({ dist, s, isHero });
    }

    assert.strictEqual(history[0].s, 1.0, 'Start of travel at dist 11 must be 1.0');
    assert(Math.abs(history[history.length - 1].s - 1.7) < 1e-6, 'Arrival at dist 0 must reach 1.7');
    return history;
}

simulateApproachContinuity();
console.log('PASS: Continuous optical blooming during travel (smoothly blooms 1.0 -> 1.7 during camera flight, 0 abrupt jump on arrival)');

console.log('\nAll focus animation continuity tests passed successfully!');
