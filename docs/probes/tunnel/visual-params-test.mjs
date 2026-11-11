import assert from 'node:assert';

console.log('=== Probe: Visual Params & Depth Test ===\n');

const D = 5.5;
const NL = 14;

function smooth(a, b, x) {
    const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
    return t * t * (3 - 2 * t);
}

function computeVisuals(dz) {
    // 景深虚化
    const distFromFocus = Math.max(0, Math.abs(dz) - 8);
    const blur = Math.min(1.8, Math.pow(distFromFocus / 24, 1.2) * 1.8);

    // 雾化
    const fogDist = Math.max(0, -dz - 2.5 * D);
    const fog = Math.min(0.88, 1 - Math.exp(-fogDist / (8.5 * D)));

    // 深度明度
    const depth = dz < 0 ? 1 - 0.4 * smooth(D, 11 * D, -dz) : 1;

    return { blur, fog, depth };
}

// 1. Focus plane (dz = 0)
const focus = computeVisuals(0);
assert.strictEqual(focus.blur, 0, 'Focus plane must have 0 blur');
assert.strictEqual(focus.fog, 0, 'Focus plane must have 0 fog');
assert.strictEqual(focus.depth, 1, 'Focus plane must have 1.0 depth brightness');
console.log('PASS: Focus layer is 100% sharp and unhazed:', focus);

// 2. Layer 1 behind focus (-dz = 5.5)
const layer1 = computeVisuals(-5.5);
assert.strictEqual(layer1.blur, 0, 'Layer 1 must be within crisp zone (0 blur)');
assert.strictEqual(layer1.fog, 0, 'Layer 1 must have 0 fog');
console.log('PASS: Layer 1 is completely crisp and clear:', layer1);

// 3. Layer 3 behind focus (-dz = 16.5)
const layer3 = computeVisuals(-16.5);
assert(layer3.blur < 0.6, `Layer 3 blur (${layer3.blur}) must be gentle (<0.6), not pixelated`);
assert(layer3.fog < 0.1, `Layer 3 fog (${layer3.fog}) must be minimal (<0.1)`);
console.log('PASS: Layer 3 remains sharp and recognizable:', layer3);

// 4. Layer 5 behind focus (-dz = 27.5)
const layer5 = computeVisuals(-27.5);
assert(layer5.blur <= 1.5, `Layer 5 blur (${layer5.blur}) must be soft`);
assert(layer5.fog < 0.35, `Layer 5 fog (${layer5.fog}) must have moderate haze`);
console.log('PASS: Layer 5 recedes naturally into mid-ground:', layer5);

// 5. Far layer 11 (-dz = 60.5)
const layer11 = computeVisuals(-60.5);
assert(layer11.fog <= 0.88, 'Fog must not exceed 0.88 (prevent discard)');
assert(layer11.depth >= 0.58, 'Distant cards must remain illuminated');
console.log('PASS: Far layer 11 has beautiful horizon depth without disappearing:', layer11);

console.log('\nAll visual params tests passed successfully!');
