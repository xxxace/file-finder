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

console.log('\nAll focus animation continuity tests passed successfully!');
