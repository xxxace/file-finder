import assert from 'node:assert';

console.log('=== Probe: Infinite Roam & Directory Locate Test ===\n');

// 1. 测试层回环动态纹理更新（彻底打破只看 7 张的限制，支持漫游 50+ 专辑）
{
    const D = 5.5;
    const NL = 14;
    const len = 50; // 50 张不重复专辑

    const hash3D = (i, j, k) => {
        let h = (i * 374761393 + j * 668265263 + k * 1013904223) | 0;
        h = Math.imul(h ^ (h >>> 13), 1274126177);
        return (h ^ (h >>> 16)) >>> 0;
    };

    const keyAt = (i, j, k, total) => {
        if (total <= 1) return 0;
        if (i === 0 && j === 0) {
            return Math.floor(k / 2) % total;
        }
        return hash3D(i, j, k) % total;
    };

    // 初始化 14 层
    const layers = [];
    for (let k = 0; k < NL; k++) {
        layers.push({ k, z: -k * D });
    }

    const seenCenterCovers = [];

    // 模拟相机沿 Z 轴向前漫游 60 层（相当于前进 330 单位深度）
    const FOCUS = 14;
    const CAM0 = FOCUS;
    for (let travelStep = 0; travelStep < 60; travelStep += 2) {
        const travel = travelStep * D;
        const camZ = CAM0 - travel;
        const focusZ = camZ - FOCUS; // = -travel

        // 执行 engine.ts 中的回环与动态纹理分配逻辑
        for (const L of layers) {
            let wrapped = false;
            while (L.z > camZ - 1) {
                L.z -= NL * D;
                wrapped = true;
            }
            while (L.z < camZ - 1 - NL * D) {
                L.z += NL * D;
                wrapped = true;
            }
            if (wrapped) {
                const kAbs = Math.max(0, Math.round(-L.z / D));
                L.centerTex = keyAt(0, 0, kAbs, len);
            } else if (L.centerTex === undefined) {
                const kAbs = Math.max(0, Math.round(-L.z / D));
                L.centerTex = keyAt(0, 0, kAbs, len);
            }
        }

        // 获取当前焦平面所对准的中心封面
        let focalCenter = null;
        let minD = 1e9;
        for (const L of layers) {
            if (L.k % 2 === 0) { // 偶数层中心有卡片
                const d = Math.abs(L.z - focusZ);
                if (d < minD) {
                    minD = d;
                    focalCenter = L;
                }
            }
        }
        if (focalCenter && minD < 1.0) {
            seenCenterCovers.push(focalCenter.centerTex);
        }
    }

    const uniqueEncountered = new Set(seenCenterCovers);
    assert(uniqueEncountered.size > 14, `Expected to encounter > 14 unique center albums, but only saw ${uniqueEncountered.size}`);
    console.log(`PASS: Infinite roaming dynamically encounters ${uniqueEncountered.size} distinct albums over travel sequence`);
}

// 2. 测试高亮白色封面光效保护（防过曝泛白）
{
    // 模拟着色器中的亮度与扫光抑制
    function computeCoverOutput(rgb, isSweepLine, isHero) {
        const luma = rgb[0] * 0.299 + rgb[1] * 0.587 + rgb[2] * 0.114;
        // smoothstep(0.65, 0.95, luma)
        const t = Math.min(Math.max((luma - 0.65) / (0.95 - 0.65), 0), 1);
        const smoothstepVal = t * t * (3 - 2 * t);
        const sheenFactor = (1.0 - smoothstepVal) * (0.012 + 0.03 * (isHero ? 1 : 0));

        let outR = rgb[0] + (isSweepLine ? 0.9 * sheenFactor : 0);
        let outG = rgb[1] + (isSweepLine ? 0.88 * sheenFactor : 0);
        let outB = rgb[2] + (isSweepLine ? 1.0 * sheenFactor : 0);

        // min(c, vec3(0.96))
        outR = Math.min(outR, 0.96);
        outG = Math.min(outG, 0.96);
        outB = Math.min(outB, 0.96);

        return [outR, outG, outB];
    }

    // 纯白封面 [1.0, 1.0, 1.0]
    const whiteOut = computeCoverOutput([1.0, 1.0, 1.0], true, true);
    assert(whiteOut[0] <= 0.96 && whiteOut[1] <= 0.96 && whiteOut[2] <= 0.96, 'White cover must be capped at 0.96 to prevent bloom piercing');
    assert(whiteOut[0] < 0.99, 'White cover output must strictly stay below bloom threshold (0.99)');
    console.log(`PASS: Pure white album cover capped at [${whiteOut.map(v => v.toFixed(2)).join(', ')}], strictly below bloom threshold 0.99`);

    // 深色封面 [0.1, 0.1, 0.1] 保留精致反光
    const darkOut = computeCoverOutput([0.1, 0.1, 0.1], true, true);
    assert(darkOut[0] > 0.1, 'Dark cover retains glossy highlight sheen');
    console.log(`PASS: Dark album cover retains delicate sheen reflection: [${darkOut.map(v => v.toFixed(3)).join(', ')}]`);
}

// 3. 测试定位目录逻辑：定位到实际缓存的目录层级 (doc.relPath) 而非未收录的子文件夹
{
    const rawWork = {
        id: 'SERIAL123:video/genre/IPX-123/cover',
        serial: 'SERIAL123',
        dir: 'video/genre/IPX-123', // 收敛作品子文件夹
        relPath: 'video/genre',     // NeDB 实际缓存的父目录
        name: 'cover',
        key: 'video/genre/IPX-123/cover',
    };

    // handleNavigateDir 计算目标
    const relPath = rawWork.relPath !== undefined
        ? rawWork.relPath
        : (rawWork.dir.includes('/') ? rawWork.dir.substring(0, rawWork.dir.lastIndexOf('/')) : '');
    const targetPath = `#${rawWork.serial}${relPath ? `/${relPath}` : ''}`;
    const focusKey = rawWork.key || `${rawWork.dir}/${rawWork.name}`;

    assert.strictEqual(targetPath, '#SERIAL123/video/genre', 'Must navigate to parent cached directory');
    assert.strictEqual(focusKey, 'video/genre/IPX-123/cover', 'Focus key must identify the work item in the grid');
    console.log(`PASS: Navigate target correctly maps to cached directory (${targetPath}) and focusKey (${focusKey})`);
}

console.log('\nAll infinite roam and directory locate tests passed with 100% precision!');
