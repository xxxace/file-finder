import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { FXAAPass } from 'three/examples/jsm/postprocessing/FXAAPass.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { TunnelCover, TunnelOptions, TunnelController } from './types';

const TS = 384; // 纹理数组单层分辨率 (384x384 RGBA，256层约150MB显存，极致平衡画质与显存)
const MAX_TEXTURE_LAYERS = 256;

/**
 * 根据图像的原始宽高比，计算 3D 空间的 instance 缩放矩阵比例 (scaleX, scaleY)
 * 使得 384x384 方形纹理被贴在按原图宽高比缩放后的几何体上时，
 * 横向或纵向拉伸与纹理压缩 1:1 精确抵消，消除任何变形失真。
 */
function getAspectScale(asp: number): { scaleX: number; scaleY: number } {
    const clampedAspect = Math.max(0.45, Math.min(2.0, asp || 1.0));
    if (clampedAspect <= 1) {
        // 竖版海报/照片：高度维持标准 1.0，宽度按比例收窄
        return { scaleX: clampedAspect, scaleY: 1.0 };
    } else {
        // 横版图片/宽屏视频：宽度限制在 1.25 以内，高度等比收缩，确保 scaleX / scaleY === clampedAspect
        const w = Math.min(1.25, clampedAspect);
        return { scaleX: w, scaleY: w / clampedAspect };
    }
}

function createPlaceholderCanvas(index: number, text: string): HTMLCanvasElement {
    const cv = document.createElement('canvas');
    cv.width = cv.height = TS;
    const ctx = cv.getContext('2d')!;

    // 随机但确定的深邃渐变
    const hue = (index * 47) % 360;
    const g = ctx.createLinearGradient(0, 0, TS, TS);
    g.addColorStop(0, `hsl(${hue}, 45%, 22%)`);
    g.addColorStop(1, `hsl(${(hue + 40) % 360}, 55%, 10%)`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, TS, TS);

    // 装饰圆环与几何
    ctx.strokeStyle = `hsla(${hue}, 80%, 75%, 0.25)`;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(TS / 2, TS / 2, TS * 0.35, 0, Math.PI * 2);
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(TS / 2, TS / 2, TS * 0.2, 0, Math.PI * 2);
    ctx.stroke();

    // 文字
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 24px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text.slice(0, 16) || `Cover ${index + 1}`, TS / 2, TS / 2);

    return cv;
}

export function createAlbumCoverTunnel(
    container: HTMLElement,
    initialOptions: TunnelOptions = {},
): TunnelController {
    let options: TunnelOptions = {
        theme: 'dark',
        autoTravel: true,
        ...initialOptions,
    };

    let coversList: TunnelCover[] = [];
    let isDead = false;
    let isLoaded = false;
    let isPausedState = false;
    let raf = 0;
    let isVisible = true;
    let isInView = true;
    let loadVersion = 0;
    const layerAspects = new Float32Array(MAX_TEXTURE_LAYERS).fill(1.0);

    const win = container.ownerDocument.defaultView || window;
    const doc = container.ownerDocument;
    const dpr = win.devicePixelRatio || 1;

    let PR = Math.min(dpr, 2.0);

    let renderer: THREE.WebGLRenderer;
    try {
        renderer = new THREE.WebGLRenderer({
            antialias: true,
            powerPreference: 'high-performance',
            preserveDrawingBuffer: false,
        });
    } catch (e) {
        console.error('[TunnelEngine] WebGL context failed:', e);
        throw e;
    }

    renderer.setPixelRatio(PR);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;

    const el = renderer.domElement;
    el.style.width = '100%';
    el.style.height = '100%';
    el.style.display = 'block';
    el.tabIndex = 0;
    container.appendChild(el);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(32, 16 / 9, 0.5, 200);
    scene.add(camera);

    /* ---------------- 背景：深邃优雅的宇宙深空，无刺眼高光 ---------------- */
    const BGF = `vec3 bgCol(vec2 p, float tt){
        vec3 c = mix(vec3(.012, .015, .032), vec3(.035, .038, .095), smoothstep(.85, .25, p.y + (p.x - .5) * .2));
        c = mix(c, vec3(.065, .05, .13), smoothstep(.55, .15, p.y) * .25);
        vec2 q = (p - .5) / .382 + .5;
        vec2 cq = (q - vec2(.52, .5)) * vec2(1.6, 1.);
        float r2 = dot(cq, cq);
        c += vec3(.15, .12, .28) * exp(-r2 * 4.5) * .28;
        c += vec3(.25, .20, .42) * exp(-r2 * 20.) * .15;
        return c; }`;

    const bgMat = new THREE.ShaderMaterial({
        depthWrite: false,
        uniforms: { uTime: { value: 0 } },
        vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }`,
        fragmentShader: `varying vec2 vUv; uniform float uTime;
            ${BGF}
            void main(){ gl_FragColor=vec4(bgCol(vUv,uTime),1.); }`,
    });
    const bg = new THREE.Mesh(new THREE.PlaneGeometry(160, 90), bgMat);
    bg.renderOrder = -1;
    camera.add(bg);
    bg.position.z = -60;

    /* ---------------- 粒子尘埃 ---------------- */
    let dust: THREE.Points;
    {
        const c = document.createElement('canvas');
        c.width = c.height = 32;
        const g = c.getContext('2d')!;
        const gr = g.createRadialGradient(16, 16, 0, 16, 16, 16);
        gr.addColorStop(0, '#fff');
        gr.addColorStop(0.35, 'rgba(255,240,255,.5)');
        gr.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = gr;
        g.fillRect(0, 0, 32, 32);

        const n = 1200;
        const pos = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) {
            pos[i * 3] = (Math.random() - 0.5) * 60;
            pos[i * 3 + 1] = (Math.random() - 0.5) * 36;
            pos[i * 3 + 2] = -2 - Math.pow(Math.random(), 0.7) * 80;
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        dust = new THREE.Points(
            geo,
            new THREE.PointsMaterial({
                map: new THREE.CanvasTexture(c),
                size: 0.05,
                color: 0xe0d4fc,
                transparent: true,
                opacity: 0.25,
                depthWrite: false,
                blending: THREE.AdditiveBlending,
            }),
        );
        camera.add(dust);
    }

    /* ---------------- 封面三维网格构造 ---------------- */
    const S = 2.9;
    const G = 4.4;
    const D = 5.5;
    const NL = 14;
    const FOCUS = 14;

    interface CoverItem {
        L: { k: number; z: number; items: CoverItem[] };
        gridX: number;
        gridY: number;
        slotIndex: number;
        tex: number;
        hx: number;
        hy: number;
        x: number;
        y: number;
        z: number;
        zo: number;
        s: number;
        b: number;
        o: number;
        fog: number;
        lift: number;
        rx: number;
        ry: number;
        ph: number;
        fl: { x0: number; y0: number; x1: number; y1: number; p: number; dur: number; side: number } | null;
    }

    const covers: CoverItem[] = [];
    const layers: { k: number; z: number; items: CoverItem[] }[] = [];

    for (let k = 0; k < NL; k++) {
        const L = { k, z: -k * D, items: [] as CoverItem[] };
        layers.push(L);
        const isEven = k % 2 === 0;
        let wallSlot = isEven ? 1 : 0;
        for (let j = -5; j <= 5; j++) {
            for (let i = -7; i <= 7; i++) {
                if ((((i + j + k) % 2) + 2) % 2) continue; // 三维棋盘格
                const hh = Math.abs(Math.sin(i * 12.9898 + j * 78.233 + k * 37.719) * 43758.5453) % 1;
                if (Math.max(Math.abs(i), Math.abs(j)) > 1 && hh < 0.42) continue; // 随机镂空

                const isCenter = i === 0 && j === 0;
                const slotIndex = isCenter ? 0 : wallSlot++;

                const c: CoverItem = {
                    L,
                    gridX: i,
                    gridY: j,
                    slotIndex,
                    tex: 0,
                    hx: i * G,
                    hy: j * G,
                    x: i * G,
                    y: j * G,
                    z: 0,
                    zo: 0,
                    s: 1,
                    b: 0.5,
                    o: 1,
                    fog: 0,
                    lift: 0,
                    rx: 0,
                    ry: 0,
                    ph: Math.random() * 6.28,
                    fl: null,
                };
                covers.push(c);
                L.items.push(c);
            }
        }
    }

    const layerSizes = layers.map((L) => L.items.length);
    const totalCardsPerCycle = layerSizes.reduce((a, b) => a + b, 0);
    const cumLayerOffsets: number[] = [0];
    for (let i = 0; i < NL; i++) {
        cumLayerOffsets.push(cumLayerOffsets[i] + layerSizes[i]);
    }

    function layerStart(kAbs: number): number {
        const cycle = Math.floor(kAbs / NL);
        const rem = kAbs % NL;
        return cycle * totalCardsPerCycle + cumLayerOffsets[rem];
    }

    const keyAt = (kAbs: number, slotIndex: number, len: number) => {
        if (len <= 1) return 0;
        return (layerStart(kAbs) + slotIndex) % len;
    };

    const N = covers.length;
    const TH = S * 0.045; // 超薄精致卡片厚度，消除粗厚积木边框感

    // 几何合并：软阴影面 + 盒子
    const shadowG = new THREE.PlaneGeometry(S * 1.6, S * 1.6);
    shadowG.translate(0.28, -0.42, -TH * 0.5 - 0.2);
    const boxG = new THREE.BoxGeometry(S, S, TH, 1, 1, 1);

    const partOf = (g: THREE.BufferGeometry, v: number) => {
        g.setAttribute('aPart', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count).fill(v), 1));
    };
    partOf(shadowG, 0);
    partOf(boxG, 1);

    const geo = mergeGeometries([shadowG, boxG]);
    shadowG.dispose();
    boxG.dispose();

    const aTex = new THREE.InstancedBufferAttribute(new Float32Array(N), 1);
    const aLook = new THREE.InstancedBufferAttribute(new Float32Array(N * 4), 4);
    const aPh = new THREE.InstancedBufferAttribute(new Float32Array(N), 1);
    const aFog = new THREE.InstancedBufferAttribute(new Float32Array(N), 1);

    aTex.setUsage(THREE.DynamicDrawUsage);
    aLook.setUsage(THREE.DynamicDrawUsage);
    aPh.setUsage(THREE.DynamicDrawUsage);
    aFog.setUsage(THREE.DynamicDrawUsage);

    geo.setAttribute('aTex', aTex);
    geo.setAttribute('aLook', aLook);
    geo.setAttribute('aPh', aPh);
    geo.setAttribute('aFog', aFog);

    const emptyHeroCv = doc.createElement('canvas');
    emptyHeroCv.width = emptyHeroCv.height = 1;
    const emptyHeroCtx = emptyHeroCv.getContext('2d')!;
    emptyHeroCtx.fillStyle = '#000000';
    emptyHeroCtx.fillRect(0, 0, 1, 1);
    const emptyHeroTexture = new THREE.CanvasTexture(emptyHeroCv);
    emptyHeroTexture.minFilter = THREE.NearestFilter;
    emptyHeroTexture.magFilter = THREE.NearestFilter;
    emptyHeroTexture.generateMipmaps = false;

    const mat = new THREE.ShaderMaterial({
        transparent: true,
        uniforms: {
            map: { value: null as THREE.DataArrayTexture | null },
            uHeroMap: { value: emptyHeroTexture as THREE.Texture },
            uHeroBlend: { value: 0 },
            uHeroTexId: { value: -1 },
            uRim: { value: new THREE.Color(0xb4acf0) },
            uTime: { value: 0 },
            uRes: { value: new THREE.Vector2(1, 1) },
        },
        vertexShader: `
            attribute float aTex, aPart, aPh, aFog;
            attribute vec4 aLook;
            varying vec2 vUv;
            varying float vTex, vPart, vPh;
            varying vec4 vLook;
            varying vec3 vN, vVN, vVP;
            varying float vFog;
            void main(){
                vFog = aFog; vUv = uv; vTex = aTex; vLook = aLook; vPart = aPart; vPh = aPh; vN = normal;
                vec4 mv = modelViewMatrix * instanceMatrix * vec4(position, 1.);
                vVP = mv.xyz;
                vVN = normalize(normalMatrix * mat3(instanceMatrix) * normal);
                gl_Position = projectionMatrix * mv;
            }`,
        fragmentShader: `
            precision highp sampler2DArray;
            uniform sampler2DArray map;
            uniform sampler2D uHeroMap;
            uniform float uHeroBlend;
            uniform float uHeroTexId;
            uniform vec3 uRim;
            uniform float uTime;
            uniform vec2 uRes;
            varying vec2 vUv;
            varying float vTex, vPart, vPh;
            varying vec4 vLook;
            varying vec3 vN, vVN, vVP;
            varying float vFog;
            ${BGF}
            float h21(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
            vec3 cover(vec2 uv, float bias){ return texture(map, vec3(uv.x, 1. - uv.y, vTex), bias).rgb; }
            void main(){
                if (vLook.y < .01 || vFog > .99) discard;
                // 软投影
                if (vPart < .5) {
                    vec2 q = abs(vUv - .5) - .5 / 1.6 * .92;
                    float d = length(max(q, 0.)) + min(max(q.x, q.y), 0.);
                    if (vLook.y < .99) discard;
                    float a = (1. - smoothstep(-.02, .16, d)) * .55 * (1. - vFog);
                    if (a < .004) discard;
                    gl_FragColor = vec4(vec3(.01, .0, .03), a);
                    return;
                }
                if (vLook.y < .99 && abs(vN.z) < .5) discard;
                if (vLook.y < .99 && vN.z < -.5) discard;
                vec3 V = normalize(-vVP), N = normalize(vVN);
                float fres = pow(1. - abs(dot(N, V)), 3.);
                vec3 L = normalize(vec3(-.45, .75, .5));
                vec3 c;
                if (vN.z > .5) {
                    // 正面：原画纯净呈现，对高亮度封面进行保护，防止过曝
                    vec3 baseCol = cover(vUv, vLook.z);
                    // 仅当卡片为焦点卡片（vTex 匹配 uHeroTexId 且处于焦点状态 vLook.w > 0.4）时平滑混合 1600px 高清贴图
                    if (abs(vTex - uHeroTexId) < 0.5 && vLook.w > 0.4 && uHeroBlend > 0.001) {
                        vec3 heroCol = texture(uHeroMap, vUv).rgb;
                        c = mix(baseCol, heroCol, uHeroBlend);
                    } else {
                        c = baseCol;
                    }
                    float luma = dot(c, vec3(0.299, 0.587, 0.114));
                    // 扫光高光仅在暗部或中等亮度区域呈现细腻反光；若封面本身为亮白区域，大幅减弱扫光，避免泛白刺眼
                    float sweep = fract(uTime * .07 + vPh) * 2.6 - .8;
                    float band = exp(-pow((vUv.x * .7 + (1. - vUv.y) * .3) - sweep, 2.) * 90.);
                    float sheenFactor = (1.0 - smoothstep(0.65, 0.95, luma)) * (0.012 + 0.03 * vLook.w);
                    c += vec3(0.9, 0.88, 1.0) * band * sheenFactor;
                    // 将正面原色峰值限制在 0.96 以内，确保绝不会击穿 Bloom 阈值导致整张封面亮瞎白屏
                    c = min(c, vec3(0.96));
                } else if (vN.z < -.5) {
                    c = vec3(.025, .022, .045);
                } else {
                    // 侧面：超薄沉浸暗色侧壁，不添加抢眼的亮色边框条纹
                    c = vec3(.045, .04, .07) * (.65 + .35 * max(dot(vN, L), 0.));
                }
                c *= vLook.x;
                vec2 sp = .5 + (gl_FragCoord.xy / uRes - .5) * .382;
                c = mix(c, bgCol(sp, uTime) * .92, vFog);
                gl_FragColor = vec4(c, vLook.y);
            }`,
    });

    const mesh = new THREE.InstancedMesh(geo, mat, N);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;

    const world = new THREE.Group();
    world.rotation.z = 0.2;
    world.add(mesh);
    scene.add(world);

    /* ---------------- 后期合成与全管线抗锯齿（MSAA 4x + FXAA + 柔和Bloom） ---------------- */
    const initialW = Math.max(1, container.clientWidth);
    const initialH = Math.max(1, container.clientHeight);
    const renderTarget = new THREE.WebGLRenderTarget(initialW, initialH, {
        type: THREE.HalfFloatType,
        samples: 4,
    });
    const composer = new EffectComposer(renderer, renderTarget);
    composer.addPass(new RenderPass(scene, camera));

    const bloom = new UnrealBloomPass(new THREE.Vector2(960, 540), 0.12, 0.4, 0.99);
    const origSetSize = bloom.setSize.bind(bloom);
    bloom.setSize = (w: number, h: number) => origSetSize(w / 2, h / 2);
    composer.addPass(bloom);
    composer.addPass(new OutputPass());

    const fxaaPass = new FXAAPass();
    composer.addPass(fxaaPass);

    function resize() {
        const w = Math.max(1, container.clientWidth);
        const h = Math.max(1, container.clientHeight);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        mat.uniforms.uRes.value.set(w * PR, h * PR);
        renderer.setPixelRatio(PR);
        renderer.setSize(w, h, false);
        composer.setPixelRatio(PR);
        composer.setSize(w, h);
    }

    const ro = new win.ResizeObserver(() => {
        if (!isDead) {
            resize();
            wake();
        }
    });
    ro.observe(container);
    resize();

    /* ---------------- 交互物理与控制 ---------------- */
    const pointer = new THREE.Vector2();
    const look = new THREE.Vector2();
    let isInside = false;
    let isDragging = false;
    let mouseMoveIdle = 0;
    let lastY = 0;
    let movedDist = 0;
    let dragV = 0;
    let wheelDelta = 0;

    const onPointerMove = (e: PointerEvent) => {
        const r = el.getBoundingClientRect();
        isInside = true;
        mouseMoveIdle = 0;
        pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
        if (isDragging) {
            dragV += e.clientY - lastY;
            movedDist += Math.abs(e.clientY - lastY);
            lastY = e.clientY;
        }
        wake();
    };

    const onPointerDown = (e: PointerEvent) => {
        isDragging = true;
        mouseMoveIdle = 0;
        lastY = e.clientY;
        movedDist = 0;
        el.focus({ preventScroll: true });
        try {
            el.setPointerCapture(e.pointerId);
        } catch {
            // ignore
        }
        wake();
    };

    const onPointerUp = () => {
        isDragging = false;
        if (movedDist < 6) {
            pick();
            if (hovered && hovered !== heroC) {
                select(hovered);
            }
        }
        wake();
    };

    const onPointerLeave = () => {
        isInside = false;
        mouseMoveIdle = 0;
        if (hovered) {
            hovered = null;
            options.onHover?.(null);
        }
        wake();
    };

    const onWheel = (e: WheelEvent) => {
        e.preventDefault();
        wheelDelta += e.deltaY;
        wake();
    };

    const onKeyDown = (e: KeyboardEvent) => {
        if (isDead || !isVisible || !isInView) return;
        const target = e.target as HTMLElement | null;
        if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
            return;
        }
        if (e.key === ' ') {
            e.preventDefault();
            togglePause();
            wake();
            return;
        }
        const dir = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] }[e.key];
        if (!dir || !heroC) return;
        e.preventDefault();
        let best: CoverItem | null = null;
        let bd = 1e9;
        for (const c of heroC.L.items) {
            if (c === heroC) continue;
            const dx = c.hx;
            const dy = c.hy;
            const along = dx * dir[0] + dy * dir[1];
            if (along <= 0.1) continue;
            const d = along + Math.abs(dx * dir[1] - dy * dir[0]) * 1.5;
            if (d < bd) {
                bd = d;
                best = c;
            }
        }
        if (best) {
            select(best);
            wake();
        }
    };

    el.addEventListener('pointermove', onPointerMove);
    el.addEventListener('pointerdown', onPointerDown);
    el.addEventListener('pointerup', onPointerUp);
    el.addEventListener('pointerleave', onPointerLeave);
    el.addEventListener('wheel', onWheel, { passive: false });
    win.addEventListener('keydown', onKeyDown);

    /* ---------------- 运动状态机 ---------------- */
    const CAM0 = FOCUS;
    let travel = 0;
    let vel = 0;
    let idleTime = 0;
    let goTo: number | null = null;
    let heroAmt = 0;
    let hovered: CoverItem | null = null;
    let heroC: CoverItem | null = covers[0];

    /* ---------------- 高清焦点纹理与节能控制 ---------------- */
    let currentHeroTexture: THREE.Texture | null = null;
    let preloadedHeroTexture: THREE.Texture | null = null;
    let currentHeroCoverId: string | null = null;
    let preloadedCoverId: string | null = null;
    let heroBlendVal = 0.0;
    let heroBlendTarget = 0.0;
    let isPreloading = false;

    async function loadHighResTexture(url: string): Promise<THREE.Texture | null> {
        try {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.src = url;
            await img.decode();
            const tex = new THREE.Texture(img);
            tex.colorSpace = THREE.SRGBColorSpace;
            tex.minFilter = THREE.LinearFilter;
            tex.magFilter = THREE.LinearFilter;
            tex.generateMipmaps = false; // 高清图单卡直显，无需耗费显存生成 Mipmap
            tex.flipY = true;
            tex.needsUpdate = true;
            return tex;
        } catch {
            return null;
        }
    }

    async function setHeroCoverHighRes(cover: TunnelCover | null) {
        if (!cover || isDead) {
            heroBlendTarget = 0.0;
            return;
        }
        if (cover.id === currentHeroCoverId && currentHeroTexture) {
            heroBlendTarget = 1.0;
            wake();
            return;
        }

        currentHeroCoverId = cover.id;
        const targetUrl = cover.previewSrc || cover.src;
        if (!targetUrl) return;

        // 若已经在闲置期间提前预加载好了，直接毫秒级秒切
        if (preloadedHeroTexture && preloadedCoverId === cover.id) {
            if (currentHeroTexture && currentHeroTexture !== preloadedHeroTexture) {
                currentHeroTexture.dispose();
            }
            currentHeroTexture = preloadedHeroTexture;
            preloadedHeroTexture = null;
            preloadedCoverId = null;

            mat.uniforms.uHeroMap.value = currentHeroTexture;
            mat.uniforms.uHeroTexId.value = heroC ? heroC.tex : -1;
            heroBlendTarget = 1.0;
            wake();
            return;
        }

        // 尚未预载完成，从当前 384px 缩略图开始平滑拉取
        heroBlendTarget = 0.0;
        let tex = await loadHighResTexture(targetUrl);
        if (!tex && cover.previewSrc && cover.src) {
            tex = await loadHighResTexture(cover.src);
        }
        if (isDead || currentHeroCoverId !== cover.id) {
            tex?.dispose();
            return;
        }

        if (tex) {
            if (currentHeroTexture && currentHeroTexture !== tex) {
                currentHeroTexture.dispose();
            }
            currentHeroTexture = tex;
            mat.uniforms.uHeroMap.value = currentHeroTexture;
            mat.uniforms.uHeroTexId.value = heroC ? heroC.tex : -1;
            heroBlendTarget = 1.0;
            wake();
        }
    }

    async function preloadNextHeroCover(cover: TunnelCover | null) {
        if (!cover || isDead || isPausedState || isPreloading) return;
        if (preloadedCoverId === cover.id || currentHeroCoverId === cover.id) return;

        const targetUrl = cover.previewSrc || cover.src;
        if (!targetUrl) return;

        isPreloading = true;
        const targetId = cover.id;
        let tex = await loadHighResTexture(targetUrl);
        if (!tex && cover.previewSrc && cover.src) {
            tex = await loadHighResTexture(cover.src);
        }
        isPreloading = false;

        if (isDead || isPausedState) {
            tex?.dispose();
            return;
        }

        if (tex) {
            if (preloadedHeroTexture && preloadedHeroTexture !== tex) {
                preloadedHeroTexture.dispose();
            }
            preloadedHeroTexture = tex;
            preloadedCoverId = targetId;
        }
    }

    const smooth = (a: number, b: number, x: number) => {
        const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
        return t * t * (3 - 2 * t);
    };

    const damp = (a: number, b: number, k: number, dt: number) => {
        return isPausedState ? b : a + (b - a) * (1 - Math.exp(-k * dt));
    };

    const centerOf = (L: { items: CoverItem[] }) => L.items.find((c) => c.hx === 0 && c.hy === 0);

    function fly(c: CoverItem, x1: number, y1: number, side: number) {
        c.fl = {
            x0: c.x,
            y0: c.y,
            x1,
            y1,
            p: 0,
            dur: 1.15,
            side: side * (Math.random() < 0.5 ? 1 : -1),
        };
        c.hx = x1;
        c.hy = y1;
    }

    const ease = (p: number) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);

    function select(t: CoverItem, notify = true) {
        const L = t.L;
        const occ = centerOf(L);
        if (occ && occ !== t) {
            fly(occ, t.hx, t.hy, -1);
        }
        fly(t, 0, 0, 1);
        heroC = t;
        heroAmt = 0;
        goTo = travel + (camera.position.z - FOCUS - L.z);
        vel = 0;
        idleTime = 0;
        if (notify && coversList[t.tex]) {
            const active = coversList[t.tex];
            options.onSelect?.(active);
            void setHeroCoverHighRes(active);
        }
        wake();
    }

    const tanHalf = Math.tan(THREE.MathUtils.degToRad(16));
    const tmp = new THREE.Vector3();

    function pick() {
        let nextHovered: CoverItem | null = null;
        if (isInside && mouseMoveIdle < 3.0) {
            let bestZ = -1e9;
            for (const c of covers) {
                if (c.o < 0.5 || c.fog > 0.6) continue;
                tmp.set(c.x, c.y, c.z).applyMatrix4(world.matrixWorld);
                const dist = camera.position.z - tmp.z;
                if (dist < 1) continue;
                tmp.project(camera);
                const asp = getAspectScale(layerAspects[c.tex]);
                const halfX = (S * c.s * asp.scaleX * 0.5) / (dist * tanHalf);
                const halfY = (S * c.s * asp.scaleY * 0.5) / (dist * tanHalf);
                if (
                    Math.abs(tmp.x - pointer.x) * camera.aspect < halfX &&
                    Math.abs(tmp.y - pointer.y) < halfY &&
                    c.z > bestZ
                ) {
                    bestZ = c.z;
                    nextHovered = c;
                }
            }
        }
        if (nextHovered !== hovered) {
            hovered = nextHovered;
            if (options.onHover) {
                const hCover = hovered && coversList[hovered.tex] ? coversList[hovered.tex] : null;
                options.onHover(hCover);
            }
        }
    }

    const M = new THREE.Matrix4();
    const Q = new THREE.Quaternion();
    const E = new THREE.Euler();
    const P = new THREE.Vector3();
    const SC = new THREE.Vector3();

    function update(dt: number, t: number) {
        mouseMoveIdle += dt;

        const input = wheelDelta * 0.004 + dragV * 0.02;
        wheelDelta = 0;
        dragV = 0;
        if (Math.abs(input) > 1e-4) {
            vel += input;
            idleTime = 0;
            goTo = null;
        } else {
            idleTime += dt;
        }

        vel *= Math.pow(0.06, dt);
        travel += vel * (isPausedState ? 0.12 : dt) * 6;

        if (options.autoTravel && !isPausedState && idleTime > 2.0 && goTo === null && (!hovered || mouseMoveIdle >= 3.0) && !isDragging) {
            // 在当前焦点停留满 2.0 秒后（距离下次启程还有 2.5 秒），静默预拉取下一个中心专辑的高清大图
            if (!preloadedHeroTexture && !isPreloading) {
                const fz = CAM0 - travel - FOCUS;
                let minAheadDist = 1e9;
                let nextCenterItem: CoverItem | null = null;
                for (const L of layers) {
                    const c = centerOf(L);
                    if (c) {
                        const distAhead = fz - L.z;
                        if (distAhead > 1.5 && distAhead < minAheadDist) {
                            minAheadDist = distAhead;
                            nextCenterItem = c;
                        }
                    }
                }
                if (nextCenterItem && coversList[nextCenterItem.tex]) {
                    void preloadNextHeroCover(coversList[nextCenterItem.tex]);
                }
            }
        }

        if (goTo !== null) {
            travel = damp(travel, goTo, 2.4, dt);
            if (Math.abs(travel - goTo) < 0.02) {
                travel = goTo;
                goTo = null;
                idleTime = 0; // 成功到达目标层后，重置闲置计时，确保完整驻留欣赏
            }
        } else if (options.autoTravel && !isPausedState && idleTime > 4.5 && (!hovered || mouseMoveIdle >= 3.0) && !isDragging) {
            // 自动漫游展示节奏：在当前中心专辑驻留 4.5s 欣赏后，寻找隧道深处前方下一个拥有中心封面的层（严格向前，绝不后退）
            const fz = CAM0 - travel - FOCUS;
            let minAheadDist = 1e9;
            for (const L of layers) {
                if (centerOf(L)) {
                    const distAhead = fz - L.z;
                    // 必须严格在前方（距离大于 1.5），避开当前所在层
                    if (distAhead > 1.5 && distAhead < minAheadDist) {
                        minAheadDist = distAhead;
                    }
                }
            }
            // 棋盘格隧道中心封面每隔两层出现一次，前方下一层距离为 2 * D (约 11.0)
            goTo = travel + (minAheadDist < 1e8 ? minAheadDist : 2 * D);
            idleTime = 0;
        } else if (idleTime > 0.45 && Math.abs(vel) < 0.5) {
            // 鼠标拖拽或滚轮滚动松开后，磁吸对齐到最近的中心专辑层
            const fz = CAM0 - travel - FOCUS;
            let best: { z: number } | null = null;
            let bd = 1e9;
            for (const L of layers) {
                if (centerOf(L)) {
                    const d = L.z - fz;
                    if (Math.abs(d) < Math.abs(bd)) {
                        bd = d;
                        best = L;
                    }
                }
            }
            if (best && Math.abs(bd) > 0.02) travel = damp(travel, travel - bd, 3.2, dt);
        }

        camera.position.z = CAM0 - travel;
        if (isInside) look.copy(pointer);
        else look.multiplyScalar(Math.pow(0.1, dt));

        camera.position.x = damp(camera.position.x, Math.sin(t * 0.2) * 0.35 + look.x * 0.9, 2.5, dt);
        camera.position.y = damp(camera.position.y, Math.cos(t * 0.17) * 0.25 + look.y * 0.55, 2.5, dt);
        camera.lookAt(camera.position.x * 0.4, camera.position.y * 0.4, camera.position.z - 20);
        camera.updateMatrixWorld();

        const focusZ = camera.position.z - FOCUS;
        let focalCenter: CoverItem | null = null;
        let minCenterDist = 1e9;
        const len = Math.max(1, Math.min(MAX_TEXTURE_LAYERS, coversList.length));

        for (const L of layers) {
            let wrapped = false;
            while (L.z > camera.position.z - 1) {
                L.z -= NL * D;
                wrapped = true;
            }
            while (L.z < camera.position.z - 1 - NL * D) {
                L.z += NL * D;
                wrapped = true;
            }
            if (wrapped) {
                // 当层在隧道深处（雾气完全遮蔽处）发生回环重置时：
                // 1. 将层内所有卡片重置回标准网格位置，清除之前点击对焦产生的位移残留，杜绝重叠
                // 2. 根据其在无限隧道中的绝对层序 kAbs 重新映射封面纹理，彻底消除重复
                const kAbs = Math.max(0, Math.round(-L.z / D));
                for (const c of L.items) {
                    c.hx = c.gridX * G;
                    c.hy = c.gridY * G;
                    c.x = c.hx;
                    c.y = c.hy;
                    c.fl = null;
                    c.tex = keyAt(kAbs, c.slotIndex, len);
                }
            }
            const cCenter = centerOf(L);
            if (cCenter) {
                const dist = Math.abs(L.z - focusZ);
                if (dist < minCenterDist) {
                    minCenterDist = dist;
                    focalCenter = cCenter;
                }
            }
        }

        const inFlight = heroC && heroC.fl;
        if (!inFlight && focalCenter && focalCenter !== heroC && minCenterDist < 1.5) {
            heroC = focalCenter;
            if (coversList[heroC.tex]) {
                const active = coversList[heroC.tex];
                options.onSelect?.(active);
                void setHeroCoverHighRes(active);
            }
        }

        if (!isDragging) pick();
        else hovered = null;
        el.style.cursor = isDragging ? 'grabbing' : hovered && hovered !== heroC ? 'pointer' : 'grab';

        const order = covers.slice().sort((a, b) => a.L.z + a.zo - (b.L.z + b.zo));
        let n = 0;
        for (const c of order) {
            const L = c.L;
            const dz = L.z - focusZ;

            let lift = 0;
            let px = 0;
            let py = 0;
            if (hovered && hovered !== heroC) {
                if (c === hovered) lift = 1;
                else if (c.L === hovered.L) {
                    const dx = c.hx - hovered.hx;
                    const dy = c.hy - hovered.hy;
                    const r = Math.hypot(dx, dy);
                    if (r < 9) {
                        const f = 1 - r / 9;
                        px = (dx / r) * f * 0.7;
                        py = (dy / r) * f * 0.7;
                        lift = f * 0.2;
                    }
                }
            }
            c.lift = damp(c.lift, lift, 8, dt);

            let arcZ = 0;
            let rz = 0;
            let ryF = 0;
            let isHero = 0;
            if (c.fl) {
                const F = c.fl;
                F.p = Math.min(1, F.p + dt / F.dur);
                const e = ease(F.p);
                const bump = Math.sin(Math.PI * e);
                const dx = F.x1 - F.x0;
                const dy = F.y1 - F.y0;
                const len = Math.hypot(dx, dy) || 1;
                const amp = Math.min(3.2, len * 0.32) * F.side;
                c.x = F.x0 + dx * e + (-dy / len) * bump * amp;
                c.y = F.y0 + dy * e + (dx / len) * bump * amp;
                // 沿弧线飞跃：向镜头方向拱起与翻转（完全保留 LeiBox 原版极富冲击力的 3D 轨迹）
                arcZ = bump * (F.side > 0 ? 1.2 : 0.6);
                rz = bump * 0.22 * F.side;
                ryF = bump * 0.35 * Math.sign(dx || 1);

                // 点击或键盘切换时：飞入中心的卡片，其焦点系数随飞行进度 e 从 0 平滑单调递增至 1
                if (F.side > 0) {
                    isHero = e;
                    if (c === heroC) heroAmt = Math.max(heroAmt, e);
                } else {
                    isHero = 1 - e;
                }
                if (F.p >= 1) c.fl = null;
            } else {
                c.x = damp(c.x, c.hx + px, 4, dt);
                c.y = damp(c.y, c.hy + py, 4, dt);

                // 物理透视连续聚焦（彻底消除“等了一段时间直接原地变大”的突兀硬跳）：
                // 随着相机穿梭逼近目标层，中心封面在整个穿行过程中连续、有机地从 1.0 绽放至 1.7，
                // 到达停稳时已完美处于焦点状态，无任何停顿后原地二次跳大！
                if (c.hx === 0 && c.hy === 0) {
                    const distToFocus = Math.abs(dz);
                    if (distToFocus < D) {
                        isHero = smooth(D, 0.0, distToFocus);
                    } else {
                        isHero = 0;
                    }
                    if (c === heroC) {
                        isHero = Math.max(isHero, smooth(1.2, 0.0, distToFocus));
                    }
                }
            }

            const r = Math.hypot(c.x / 17, c.y / 10.5);
            const ahead = 1 - smooth(0.5, 2.4, dz);
            // 大气透视雾化：近景 2.5 层保持完全清澈剔透，深处逐渐融入星云背景，远景绝不突兀消失
            const fogDist = Math.max(0, -dz - 2.5 * D);
            const fog = Math.min(0.88, 1 - Math.exp(-fogDist / (8.5 * D)));
            // 深度光感衰减：宽广的动态范围，远景依然保留清晰通透的轮廓
            const depth = dz < 0 ? 1 - 0.4 * smooth(D, 11 * D, -dz) : 1;
            let b = 0.95 * depth * (1 - 0.5 * smooth(0.2, 1.2, r));
            b = b + (1.02 - b) * isHero;
            b = b + (1.0 - b) * c.lift * 0.85;

            c.b = b;
            c.o = ahead;
            c.fog = fog;
            const s = 1 + 0.7 * isHero + 0.14 * c.lift;
            c.s = s;
            c.z = L.z + 1.3 * isHero + 2.0 * c.lift + arcZ + Math.sin(t * 0.4 + c.ph) * 0.04;
            c.zo = c.z - L.z;

            const tgx = (c === hovered ? -look.y * 0.35 : 0) + c.y * 0.012;
            const tgy = (c === hovered ? look.x * 0.35 : 0) - c.x * 0.012;
            c.rx = damp(c.rx, tgx, 6, dt);
            c.ry = damp(c.ry, tgy, 6, dt);

            // 景深虚化：焦平面周围 8 个单位内（1.5层）保持绝对清晰，深处渐进柔焦，上限 1.8（约120px清晰度）绝无马赛克感
            const distFromFocus = Math.max(0, Math.abs(dz) - 8);
            const blur = Math.min(1.8, Math.pow(distFromFocus / 24, 1.2) * 1.8) * (1 - Math.max(isHero, c.lift));
            E.set(c.rx, c.ry + ryF, Math.sin(t * 0.3 + c.ph) * 0.012 + rz);
            Q.setFromEuler(E);
            P.set(c.x, c.y, c.z);
            const asp = getAspectScale(layerAspects[c.tex]);
            SC.set(s * asp.scaleX, s * asp.scaleY, s);
            M.compose(P, Q, SC);
            mesh.setMatrixAt(n, M);

            aLook.setXYZW(n, c.b, c.o, blur, Math.max(isHero, c.lift));
            aTex.setX(n, c.tex);
            aPh.setX(n, c.ph * 0.159);
            aFog.setX(n, c.fog);
            n++;
        }

        mesh.instanceMatrix.needsUpdate = true;
        aLook.needsUpdate = true;
        aTex.needsUpdate = true;
        aPh.needsUpdate = true;
        aFog.needsUpdate = true;

        if (heroBlendVal !== heroBlendTarget) {
            heroBlendVal = damp(heroBlendVal, heroBlendTarget, 4.0, dt);
            if (Math.abs(heroBlendVal - heroBlendTarget) < 0.01) {
                heroBlendVal = heroBlendTarget;
            }
            mat.uniforms.uHeroBlend.value = heroBlendVal;
        }
        if (heroC) {
            mat.uniforms.uHeroTexId.value = heroC.tex;
        }

        mat.uniforms.uTime.value = t;
        bgMat.uniforms.uTime.value = t;
        dust.rotation.z = t * 0.01;
    }

    /* ---------------- 渲染主循环与 FPS ---------------- */
    let lastTime = 0;
    let totalTime = 0;
    let accTime = 0;
    let frameCount = 0;
    let slowCount = 0;

    function render(now: number) {
        if (isDead || !isLoaded) return;
        const dt = lastTime ? Math.min(0.05, (now - lastTime) / 1000) : 1 / 60;
        lastTime = now;
        totalTime += dt;

        update(dt, totalTime);
        composer.render();

        accTime += dt;
        frameCount++;
        if (accTime > 1) {
            const currentFps = frameCount / accTime;
            options.onFps?.(Math.round(currentFps));
            const targetPR = Math.min(dpr, 2.0);
            if (currentFps < 30) {
                slowCount++;
                if (slowCount >= 3 && PR > 1.01) {
                    PR = Math.max(1.0, PR - 0.25);
                    resize();
                    slowCount = 0;
                }
            } else if (currentFps >= 55) {
                slowCount = 0;
                if (PR < targetPR) {
                    PR = Math.min(targetPR, PR + 0.25);
                    resize();
                }
            } else {
                slowCount = 0;
            }
            accTime = 0;
            frameCount = 0;
        }
    }

    function loop(now: number) {
        raf = 0;
        if (isDead || !isVisible || doc.hidden || !isLoaded) return;

        // 绿色环保节能调度：
        // 当处于暂停态，或者当前卡片已到达中心静止驻留欣赏（未拖拽、未悬停）且高清渐变已完成时，
        // 将渲染帧率从 60 FPS 降至 30 FPS，降低 50% 以上 GPU 计算频率与发热，彻底防止电脑风扇起飞！
        const isQuiescent = isPausedState || (goTo === null && !isDragging && idleTime > 1.0 && mouseMoveIdle >= 3.0 && heroBlendVal === heroBlendTarget);
        const targetInterval = isQuiescent ? 32 : 15;
        if (lastTime && now - lastTime < targetInterval) {
            raf = win.requestAnimationFrame(loop);
            return;
        }

        render(now);
        raf = win.requestAnimationFrame(loop);
    }

    function wake() {
        if (!isDead && isVisible && !doc.hidden && isLoaded && !raf) {
            raf = win.requestAnimationFrame(loop);
        }
    }

    function stop() {
        if (raf) {
            win.cancelAnimationFrame(raf);
            raf = 0;
        }
        lastTime = 0;
    }

    function syncVisibility() {
        isVisible = isInView && !doc.hidden;
        stop();
        wake();
    }

    const io = new win.IntersectionObserver((entries) => {
        isInView = entries[entries.length - 1].isIntersecting;
        syncVisibility();
    });
    io.observe(container);

    doc.addEventListener('visibilitychange', syncVisibility);

    /* ---------------- 纹理构建与增量更新 ---------------- */
    async function loadImg(src: string): Promise<HTMLImageElement | null> {
        try {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.src = src;
            await img.decode();
            return img;
        } catch {
            return null;
        }
    }

    async function buildArrayTexture(covers: TunnelCover[], version: number): Promise<THREE.DataArrayTexture> {
        const count = Math.min(MAX_TEXTURE_LAYERS, Math.max(1, covers.length));
        const data = new Uint8Array(TS * TS * 4 * count);
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = tempCanvas.height = TS;
        const g = tempCanvas.getContext('2d', { willReadFrequently: true })!;
        g.imageSmoothingEnabled = true;
        g.imageSmoothingQuality = 'high';

        layerAspects.fill(1.0);

        const BATCH_SIZE = 16;
        for (let b = 0; b < count; b += BATCH_SIZE) {
            if (isDead || version !== loadVersion) break;
            const batchEnd = Math.min(count, b + BATCH_SIZE);
            const batchItems = covers.slice(b, batchEnd);
            const loadedImgs = await Promise.all(
                batchItems.map((item) => (item?.src ? loadImg(item.src) : Promise.resolve(null))),
            );
            if (isDead || version !== loadVersion) break;

            for (let k = 0; k < loadedImgs.length; k++) {
                const i = b + k;
                const item = batchItems[k];
                const img = loadedImgs[k];
                if (img) {
                    if (img.naturalWidth && img.naturalHeight) {
                        layerAspects[i] = img.naturalWidth / img.naturalHeight;
                    }
                    g.clearRect(0, 0, TS, TS);
                    g.drawImage(img, 0, 0, TS, TS);
                    data.set(g.getImageData(0, 0, TS, TS).data, i * TS * TS * 4);
                } else {
                    const placeholder = createPlaceholderCanvas(i, item?.title || `Cover ${i + 1}`);
                    g.clearRect(0, 0, TS, TS);
                    g.drawImage(placeholder, 0, 0, TS, TS);
                    data.set(g.getImageData(0, 0, TS, TS).data, i * TS * TS * 4);
                }
            }
        }

        const t = new THREE.DataArrayTexture(data, TS, TS, count);
        t.colorSpace = THREE.SRGBColorSpace;
        t.minFilter = THREE.LinearMipmapLinearFilter;
        t.magFilter = THREE.LinearFilter;
        t.generateMipmaps = true;
        t.flipY = false;
        t.anisotropy = 8;
        t.needsUpdate = true;
        return t;
    }

    async function loadCovers(items: TunnelCover[]): Promise<void> {
        const version = ++loadVersion;
        coversList = items;

        try {
            const texture = await buildArrayTexture(items, version);
            if (isDead || version !== loadVersion) {
                texture.dispose();
                return;
            }
            const prev = mat.uniforms.map.value;
            mat.uniforms.map.value = texture;
            prev?.dispose();

            const textureLayers = Math.min(MAX_TEXTURE_LAYERS, items.length);
            const len = Math.max(1, textureLayers);
            covers.forEach((c) => {
                const kAbs = Math.max(0, Math.round(-c.L.z / D));
                c.tex = keyAt(kAbs, c.slotIndex, len);
            });

            isLoaded = true;
            resize();
            update(1 / 60, totalTime);
            composer.render();

            if (heroC && coversList[heroC.tex]) {
                const active = coversList[heroC.tex];
                options.onSelect?.(active);
                void setHeroCoverHighRes(active);
            }
            wake();
        } catch (e) {
            console.error('[TunnelEngine] Load covers failed:', e);
        }
    }

    function togglePause(): boolean {
        isPausedState = !isPausedState;
        syncVisibility();
        wake();
        return isPausedState;
    }

    function destroy() {
        isDead = true;
        stop();
        io.disconnect();
        ro.disconnect();
        doc.removeEventListener('visibilitychange', syncVisibility);
        el.removeEventListener('pointermove', onPointerMove);
        el.removeEventListener('pointerdown', onPointerDown);
        el.removeEventListener('pointerup', onPointerUp);
        el.removeEventListener('pointerleave', onPointerLeave);
        el.removeEventListener('wheel', onWheel);
        win.removeEventListener('keydown', onKeyDown);

        const geometries = new Set<THREE.BufferGeometry>();
        const materials = new Set<THREE.Material>();
        const textures = new Set<THREE.Texture>();

        scene.traverse((obj) => {
            if ((obj as THREE.Mesh).geometry) geometries.add((obj as THREE.Mesh).geometry);
            const m = (obj as THREE.Mesh).material;
            if (m) {
                const list = Array.isArray(m) ? m : [m];
                for (const item of list) {
                    materials.add(item);
                    for (const v of Object.values(item)) {
                        if (v && (v as THREE.Texture).isTexture) textures.add(v as THREE.Texture);
                    }
                    if ((item as THREE.ShaderMaterial).uniforms) {
                        for (const u of Object.values((item as THREE.ShaderMaterial).uniforms)) {
                            if (u?.value?.isTexture) textures.add(u.value as THREE.Texture);
                        }
                    }
                }
            }
        });

        if (currentHeroTexture) {
            currentHeroTexture.dispose();
            currentHeroTexture = null;
        }
        if (preloadedHeroTexture) {
            preloadedHeroTexture.dispose();
            preloadedHeroTexture = null;
        }
        if (emptyHeroTexture) {
            emptyHeroTexture.dispose();
        }

        textures.forEach((t) => t.dispose());
        geometries.forEach((g) => g.dispose());
        materials.forEach((m) => m.dispose());
        composer.passes.forEach((p: any) => p.dispose?.());
        composer.dispose();
        renderTarget.dispose();
        renderer.dispose();
        renderer.forceContextLoss();

        if (el.parentNode) {
            el.parentNode.removeChild(el);
        }
    }

    const readyPromise = loadCovers([]);

    return {
        ready: readyPromise,
        destroy,
        update: (next = {}) => {
            options = { ...options, ...next };
            if (next.theme) {
                PR = Math.min(dpr, 2.0);
                resize();
            }
            wake();
        },
        setCovers: loadCovers,
        togglePause,
        isPaused: () => isPausedState,
        setActive: (active: boolean) => {
            isVisible = active && isInView && !doc.hidden;
            if (active) {
                resize();
                wake();
            } else {
                stop();
            }
        },
        getActiveCover: () => (heroC && coversList[heroC.tex] ? coversList[heroC.tex] : null),
    };
}
