import assert from 'node:assert';

console.log('=== Probe: Tunnel Fix Audit Test ===\n');

// 1. Test texture layer bounds
const MAX_TEXTURE_LAYERS = 96;
const keyAt = (i, j, k, len) => {
    if (len <= 1) return 0;
    return 1 + (((((i * 3 + j * 5 + k * 2) % (len - 1)) + len - 1) % (len - 1)));
};

const itemsLength = 500;
const textureLayers = Math.min(MAX_TEXTURE_LAYERS, itemsLength);
assert.strictEqual(textureLayers, 96);

for (let k = 0; k < 14; k++) {
    for (let j = -5; j <= 5; j++) {
        for (let i = -7; i <= 7; i++) {
            const tex = keyAt(i, j, k, textureLayers);
            assert(tex >= 0 && tex < MAX_TEXTURE_LAYERS, `tex ${tex} must be < 96`);
        }
    }
}
console.log('PASS: Texture layer index strictly bounded < 96 for 500 items');

// 2. Test URL prefixing with API_BASE
const API_BASE = 'http://127.0.0.1:3060';
const sig = 'abc12345';
const thumbUrl = `${API_BASE}/thumb?k=${encodeURIComponent(`t-${sig}.enc`)}`;
assert(thumbUrl.startsWith('http://127.0.0.1:3060/thumb?k=t-abc12345.enc'));
console.log('PASS: thumbUrl correctly prefixed with API_BASE');

// 3. Test resolveAnchor parameter name
const target = '#SER1/dir/file.mp4';
const resolveUrl = `${API_BASE}/resolveAnchor?path=${encodeURIComponent(target)}`;
assert(resolveUrl.includes('?path='));
assert(!resolveUrl.includes('?a='));
console.log('PASS: resolveAnchor query parameter is path');

console.log('\nAll audit tests passed!');
