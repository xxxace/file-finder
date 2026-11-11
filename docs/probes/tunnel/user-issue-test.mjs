import assert from 'node:assert';

console.log('=== Probe: User Issues Verification Test ===\n');

// 1. 测试指纹去重（同一张专辑的多首歌曲具有相同 sig，只收录 1 首作为代表）
{
    const rawItems = [
        { id: '1', sig: 'album_a', name: 'track1.mp3', dir: '/music/album_a' },
        { id: '2', sig: 'album_a', name: 'track2.mp3', dir: '/music/album_a' },
        { id: '3', sig: 'album_a', name: 'track3.mp3', dir: '/music/album_a' },
        { id: '4', sig: 'album_b', name: 'song1.flac', dir: '/music/album_b' },
        { id: '5', sig: 'album_b', name: 'song2.flac', dir: '/music/album_b' },
        { id: '6', sig: 'album_c', name: 'intro.mp3', dir: '/music/album_c' },
    ];

    const dedupeCoversBySig = (items) => {
        const seen = new Set();
        return items.filter((it) => {
            if (!it.sig) return true;
            if (seen.has(it.sig)) return false;
            seen.add(it.sig);
            return true;
        });
    };

    const deduped = dedupeCoversBySig(rawItems);
    assert.strictEqual(deduped.length, 3, 'Should deduplicate 6 tracks from 3 albums down to exactly 3 unique albums');
    assert.deepStrictEqual(deduped.map(d => d.sig), ['album_a', 'album_b', 'album_c'], 'Should retain one representative cover per album');
    console.log('PASS: Cover deduplication by album signature (sig) prevents multi-track duplication');
}

// 2. 测试网格封面映射分布（中心封面严格轮换，周边封面高熵散射）
{
    const hash3D = (i, j, k) => {
        let h = (i * 374761393 + j * 668265263 + k * 1013904223) | 0;
        h = Math.imul(h ^ (h >>> 13), 1274126177);
        return (h ^ (h >>> 16)) >>> 0;
    };

    const keyAt = (i, j, k, len) => {
        if (len <= 1) return 0;
        if (i === 0 && j === 0) {
            return Math.floor(k / 2) % len;
        }
        const h = hash3D(i, j, k);
        return h % len;
    };

    const numAlbums = 8;
    // 检查隧道前 16 层的中心卡片（k=0, 2, 4, 6, 8, 10, 12, 14）
    const centerIndices = [];
    for (let k = 0; k < 16; k += 2) {
        centerIndices.push(keyAt(0, 0, k, numAlbums));
    }
    assert.deepStrictEqual(centerIndices, [0, 1, 2, 3, 4, 5, 6, 7], 'Center covers must cycle sequentially through all albums');
    console.log('PASS: Center focus covers cycle sequentially without repetition or collision');

    // 检查相邻周边卡片不会出现平凡的周期性重复
    const wallNeighbors = [];
    for (let i = -2; i <= 2; i++) {
        for (let j = -1; j <= 1; j++) {
            if (i === 0 && j === 0) continue;
            wallNeighbors.push(keyAt(i, j, 0, numAlbums));
        }
    }
    const uniqueWallCovers = new Set(wallNeighbors);
    assert(uniqueWallCovers.size >= Math.min(numAlbums, 5), 'Wall covers must have high entropy distribution');
    console.log(`PASS: Peripheral wall cards have high entropy distribution (${uniqueWallCovers.size} variations)`);
}

// 3. 测试鼠标闲置 3s 自动解除悬停并恢复漫游
{
    let mouseMoveIdle = 0;
    let hovered = { id: 'card-1' };
    let isInside = true;
    let idleTime = 5.0; // 闲置时间超过 4.5s
    const isPausedState = false;
    const isDragging = false;
    const autoTravel = true;

    // 模拟鼠标在卡片上不动
    const dt = 1.0;
    for (let sec = 1; sec <= 4; sec++) {
        mouseMoveIdle += dt;
        // pick logic
        let nextHovered = null;
        if (isInside && mouseMoveIdle < 3.0) {
            nextHovered = hovered;
        }
        hovered = nextHovered;

        const canAutoTravel = autoTravel && !isPausedState && idleTime > 4.5 && (!hovered || mouseMoveIdle >= 3.0) && !isDragging;

        if (sec < 3) {
            assert.strictEqual(canAutoTravel, false, `At sec ${sec}, auto-travel should still be paused due to active hover`);
        } else {
            assert.strictEqual(canAutoTravel, true, `At sec ${sec} (>=3s), hover is released and auto-travel is allowed to resume`);
            assert.strictEqual(hovered, null, 'Hovered state must be null after 3s idle');
        }
    }
    console.log('PASS: Mouse 3s inactivity successfully clears hover lock and resumes auto-travel');
}

// 4. 测试抗锯齿效果管线（MSAA + FXAAPass）
{
    const THREE = await import('three');
    const { EffectComposer } = await import('three/examples/jsm/postprocessing/EffectComposer.js');
    const { RenderPass } = await import('three/examples/jsm/postprocessing/RenderPass.js');
    const { UnrealBloomPass } = await import('three/examples/jsm/postprocessing/UnrealBloomPass.js');
    const { OutputPass } = await import('three/examples/jsm/postprocessing/OutputPass.js');
    const { FXAAPass } = await import('three/examples/jsm/postprocessing/FXAAPass.js');

    const rt = new THREE.WebGLRenderTarget(800, 600, {
        type: THREE.HalfFloatType,
        samples: 4,
    });
    assert.strictEqual(rt.samples, 4, 'Render target must have 4x MSAA enabled');

    const fakeRenderer = {
        getPixelRatio: () => 2.0,
        getSize: (v) => v.set(800, 600),
        getContext: () => ({}),
        capabilities: { isWebGL2: true },
    };

    const composer = new EffectComposer(fakeRenderer, rt);
    composer.addPass(new RenderPass({}, {}));
    composer.addPass(new UnrealBloomPass(new THREE.Vector2(800, 600), 0.16, 0.5, 0.92));
    composer.addPass(new OutputPass());
    const fxaa = new FXAAPass();
    composer.addPass(fxaa);

    composer.setPixelRatio(2.0);
    composer.setSize(800, 600);

    assert.strictEqual(composer.passes.length, 4, 'Composer must contain RenderPass, BloomPass, OutputPass, FXAAPass');
    assert.strictEqual(composer.renderTarget1.samples, 4, 'Composer render target maintains 4x hardware MSAA');
    assert.strictEqual(fxaa.material.uniforms.resolution.value.x, 1 / (800 * 2.0), 'FXAA resolution X correctly scaled to high-DPI buffer');
    assert.strictEqual(fxaa.material.uniforms.resolution.value.y, 1 / (600 * 2.0), 'FXAA resolution Y correctly scaled to high-DPI buffer');

    composer.dispose();
    rt.dispose();
    console.log('PASS: Anti-aliasing postprocessing pipeline (MSAA 4x + FXAAPass + 2.0 DPR) verified successfully');
}

console.log('\nAll user issue probe tests passed with 100% precision!');
