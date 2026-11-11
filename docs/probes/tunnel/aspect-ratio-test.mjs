import assert from 'node:assert';

console.log('=== Probe: Aspect Ratio Test ===\n');

function getAspectScale(asp) {
    const clampedAspect = Math.max(0.5, Math.min(1.8, asp || 1.0));
    if (clampedAspect <= 1) {
        return { scaleX: clampedAspect, scaleY: 1.0 };
    } else {
        const w = Math.min(1.25, clampedAspect);
        return { scaleX: w, scaleY: w / clampedAspect };
    }
}

// 1. Movie poster 2:3
const poster = getAspectScale(2 / 3);
const posterRatio = poster.scaleX / poster.scaleY;
assert(Math.abs(posterRatio - (2 / 3)) < 0.001, `Poster ratio ${posterRatio} should be 2/3`);
console.log('PASS: Poster 2:3 ratio preserved perfectly:', poster);

// 2. Square 1:1
const square = getAspectScale(1.0);
assert.strictEqual(square.scaleX, 1.0);
assert.strictEqual(square.scaleY, 1.0);
console.log('PASS: Square 1:1 ratio preserved perfectly:', square);

// 3. Widescreen 16:9
const wide = getAspectScale(16 / 9);
const wideRatio = wide.scaleX / wide.scaleY;
assert(Math.abs(wideRatio - (16 / 9)) < 0.001, `Widescreen ratio ${wideRatio} should be 16/9`);
assert(wide.scaleX <= 1.25, `Width ${wide.scaleX} should not exceed 1.25`);
console.log('PASS: Widescreen 16:9 ratio preserved perfectly:', wide);

// 4. DVD 0.71
const dvd = getAspectScale(0.71);
const dvdRatio = dvd.scaleX / dvd.scaleY;
assert(Math.abs(dvdRatio - 0.71) < 0.001, `DVD ratio ${dvdRatio} should be 0.71`);
console.log('PASS: DVD 0.71 ratio preserved perfectly:', dvd);

console.log('\nAll aspect ratio tests passed!');
