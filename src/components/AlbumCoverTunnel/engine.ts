import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { TunnelCover, TunnelOptions, TunnelController } from './types';

const TS = 384; // 纹理数组单层分辨率 (384x384 RGBA，96层约45MB显存，极致平衡画质与显存)
const MAX_TEXTURE_LAYERS = 96;

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

    let PR = Math.min(dpr, 1.5);

    let renderer: THREE.WebGLRenderer;
    try {
        renderer = new THREE.WebGLRenderer({
            antialias: false,
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
    renderer.toneMappingExposure = 1.05;

    const el = renderer.domElement;
    el.style.width = '100%';
    el.style.height = '100%';
    el.style.display = 'block';
    el.tabIndex = 0;
    container.appendChild(el);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(32, 16 / 9, 0.5, 200);
    scene.add(camera);

    /* ---------------- 背景：跟着相机走的星云渐变 ---------------- */
    const BGF = `vec3 bgCol(vec2 p, float tt){
        vec3 c=mix(vec3(.02,.03,.10),vec3(.10,.09,.34),smoothstep(.85,.3,p.y+(p.x-.5)*.25));
        c=mix(c,vec3(.30,.22,.62),smoothstep(.55,.15,p.y)*.3);
        c+=vec3(1.,.86,1.)*exp(-pow(length((p-vec2(.56,.2))*vec2(1.3,2.)),2.)*6.)*(.38+.03*sin(tt*.7));
        vec2 q=(p-.5)/.382+.5;
        vec2 cq=(q-vec2(.54,.5))*vec2(1.78,1.);
        float r2=dot(cq,cq);
        c*=1.-.72*smoothstep(.05,.75,sqrt(r2));
        c+=vec3(.52,.42,.95)*exp(-r2*5.)*.42;
        c+=vec3(.95,.86,1.)*exp(-r2*26.)*(.42+.05*sin(tt*.5));
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
                size: 0.09,
                color: 0xf4e8ff,
                transparent: true,
                opacity: 0.75,
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

    const keyAt = (i: number, j: number, k: number, len: number) => {
        if (len <= 1) return 0;
        return 1 + (((((i * 3 + j * 5 + k * 2) % (len - 1)) + len - 1) % (len - 1)));
    };

    for (let k = 0; k < NL; k++) {
        const L = { k, z: -k * D, items: [] as CoverItem[] };
        layers.push(L);
        for (let j = -5; j <= 5; j++) {
            for (let i = -7; i <= 7; i++) {
                if ((((i + j + k) % 2) + 2) % 2) continue; // 三维棋盘格
                const hh = Math.abs(Math.sin(i * 12.9898 + j * 78.233 + k * 37.719) * 43758.5453) % 1;
                if (Math.max(Math.abs(i), Math.abs(j)) > 1 && hh < 0.42) continue; // 随机镂空

                const c: CoverItem = {
                    L,
                    gridX: i,
                    gridY: j,
                    tex: i === 0 && j === 0 && k === 0 ? 0 : 0,
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

    const N = covers.length;
    const TH = S * 0.12;

    // 几何合并：软阴影面 + 盒子
    const shadowG = new THREE.PlaneGeometry(S * 1.6, S * 1.6);
    shadowG.translate(0.28, -0.42, -TH * 0.5 - 0.35);
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

    const mat = new THREE.ShaderMaterial({
        transparent: true,
        uniforms: {
            map: { value: null as THREE.DataArrayTexture | null },
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
            vec3 cover(vec2 uv, float bias){ return pow(texture(map, vec3(uv.x, 1. - uv.y, vTex), bias).rgb, vec3(2.2)); }
            void main(){
                if (vLook.y < .01 || vFog > .985) discard;
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
                    // 正面：封面 + 倒角 + 覆膜流光 + 纸张颗粒
                    c = cover(vUv, vLook.z);
                    vec2 e2 = min(vUv, 1. - vUv); float e = min(e2.x, e2.y);
                    float lip = 1. - smoothstep(.0, .014, e);
                    float tl = clamp(.5 + (vUv.y - vUv.x) * .9, 0., 1.);
                    c = mix(c, c * .55 + vec3(.55, .52, .70) * tl * .6, lip * .8);
                    c *= 1. - .35 * smoothstep(.022, .014, e) * smoothstep(.010, .016, e);
                    c *= .9 + .1 * smoothstep(.0, .35, e);
                    c += (h21(floor(vUv * 700.)) - .5) * .018;
                    float sweep = fract(uTime * .07 + vPh) * 2.6 - .8;
                    float band = exp(-pow((vUv.x * .7 + (1. - vUv.y) * .3) - sweep, 2.) * 90.);
                    c += vec3(1., .95, 1.) * band * (.06 + .22 * vLook.w);
                    c += uRim * fres * .25;
                } else if (vN.z < -.5) {
                    c = vec3(.025, .022, .045);
                } else {
                    // 侧面厚度：亚克力亮棱 + 纸芯微纹
                    float f = vN.x > .5 ? 1. - vUv.x : vN.x < -.5 ? vUv.x : vN.y > .5 ? 1. - vUv.y : vUv.y;
                    float along = abs(vN.x) > .5 ? vUv.y : vUv.x;
                    vec2 edgeUv = vN.x > .5 ? vec2(.985, along) : vN.x < -.5 ? vec2(.015, along) : vN.y > .5 ? vec2(along, .985) : vec2(along, .015);
                    vec3 ink = cover(edgeUv, 2.);
                    vec3 paper = vec3(.80, .77, .88) * (.86 + .14 * sin(f * 190.)) * (.94 + .06 * h21(vec2(floor(f * 60.), floor(along * 400.))));
                    vec3 back = vec3(.06, .055, .10);
                    c = back;
                    c = mix(c, paper, smoothstep(.13, .16, f));
                    c = mix(c, ink * .85, smoothstep(.74, .77, f));
                    c = mix(c, ink * .5 + vec3(.55, .55, .7) * .45, smoothstep(.90, .92, f));
                    c += vec3(.9, .85, 1.) * .35 * (smoothstep(.975, 1., f) + (1. - smoothstep(.0, .03, f)) * .4);
                    c *= .55 + .55 * max(dot(vN, L), 0.);
                    c += uRim * fres * .45;
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

    /* ---------------- 后期合成 ---------------- */
    const composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));

    const bloom = new UnrealBloomPass(new THREE.Vector2(960, 540), 0.5, 0.35, 0.9);
    const origSetSize = bloom.setSize.bind(bloom);
    bloom.setSize = (w: number, h: number) => origSetSize(w / 2, h / 2);
    composer.addPass(bloom);

    const grade = new ShaderPass({
        uniforms: {
            tDiffuse: { value: null },
            uTime: { value: 0 },
            uLight: { value: new THREE.Vector2(0.53, 0.47) },
        },
        vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }`,
        fragmentShader: `uniform sampler2D tDiffuse; uniform float uTime; uniform vec2 uLight; varying vec2 vUv;
            float h(vec2 p){ return fract(sin(dot(p,vec2(12.9898,78.233)))*43758.5453); }
            void main(){
                vec2 uv=vUv, d=uv-.5;
                vec3 c;
                c.r=texture2D(tDiffuse,uv+d*.003).r;
                c.g=texture2D(tDiffuse,uv).g;
                c.b=texture2D(tDiffuse,uv-d*.003).b;
                vec2 st=(uLight-uv)/18.; vec2 q=uv+st*h(gl_FragCoord.xy); float w=1., ray=0.;
                for(int i=0;i<18;i++){
                    vec3 s=texture2D(tDiffuse,q).rgb;
                    ray+=max(dot(s,vec3(.3,.5,.2))-.62,0.)*w;
                    w*=.9; q+=st;
                }
                c+=vec3(.70,.62,1.)*ray*.13*smoothstep(.2,.42,length((uv-uLight)*vec2(1.6,1.)));
                c*=1.-dot(d*vec2(1.,1.25),d*vec2(1.,1.25))*1.35;
                c+=(h(gl_FragCoord.xy+fract(uTime)*100.)-.5)*.022;
                gl_FragColor=vec4(c,1.);
            }`,
    });
    composer.addPass(grade);
    composer.addPass(new OutputPass());

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
    let lastY = 0;
    let movedDist = 0;
    let dragV = 0;
    let wheelDelta = 0;

    const onPointerMove = (e: PointerEvent) => {
        const r = el.getBoundingClientRect();
        isInside = true;
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
        goTo = travel + (camera.position.z - FOCUS - L.z);
        vel = 0;
        idleTime = 0;
        heroAmt = 0;
        if (notify && coversList[t.tex]) {
            options.onSelect?.(coversList[t.tex]);
        }
        wake();
    }

    const tanHalf = Math.tan(THREE.MathUtils.degToRad(16));
    const tmp = new THREE.Vector3();

    function pick() {
        hovered = null;
        if (!isInside) return;
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
                hovered = c;
            }
        }
        if (options.onHover) {
            const hCover = hovered && coversList[hovered.tex] ? coversList[hovered.tex] : null;
            options.onHover(hCover);
        }
    }

    const M = new THREE.Matrix4();
    const Q = new THREE.Quaternion();
    const E = new THREE.Euler();
    const P = new THREE.Vector3();
    const SC = new THREE.Vector3();

    function update(dt: number, t: number) {
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

        if (goTo !== null) {
            travel = damp(travel, goTo, 2.4, dt);
            if (Math.abs(travel - goTo) < 0.02) goTo = null;
        } else if (idleTime > 0.45 && Math.abs(vel) < 0.5) {
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
            if (best) travel = damp(travel, travel - bd, 3, dt);
        }

        if (options.autoTravel && !isPausedState && idleTime > 5 && !hovered && goTo === null) {
            vel += 5.6;
            idleTime = 0;
        }

        camera.position.z = CAM0 - travel;
        if (isInside) look.copy(pointer);
        else look.multiplyScalar(Math.pow(0.1, dt));

        camera.position.x = damp(camera.position.x, Math.sin(t * 0.2) * 0.35 + look.x * 0.9, 2.5, dt);
        camera.position.y = damp(camera.position.y, Math.cos(t * 0.17) * 0.25 + look.y * 0.55, 2.5, dt);
        camera.lookAt(camera.position.x * 0.4, camera.position.y * 0.4, camera.position.z - 20);
        camera.updateMatrixWorld();

        const focusZ = camera.position.z - FOCUS;
        let heroL: { k: number; z: number; items: CoverItem[] } | null = null;
        for (const L of layers) {
            while (L.z > camera.position.z - 1) L.z -= NL * D;
            while (L.z < camera.position.z - 1 - NL * D) L.z += NL * D;
            if (Math.abs(L.z - focusZ) < 1.2 && centerOf(L)) heroL = L;
        }

        const newHero = heroL ? centerOf(heroL) : null;
        const settled = newHero && Math.abs(vel) < 0.6 && Math.abs(heroL!.z - focusZ) < 0.25;
        if (newHero !== heroC && settled) {
            heroC = newHero;
            heroAmt = 0;
            if (heroC && coversList[heroC.tex]) {
                options.onSelect?.(coversList[heroC.tex]);
            }
        }
        heroAmt = damp(heroAmt, settled && newHero === heroC ? 1 : 0, settled ? 2.8 : 7, dt);

        if (!isDragging) pick();
        else hovered = null;
        el.style.cursor = isDragging ? 'grabbing' : hovered && hovered !== heroC ? 'pointer' : 'grab';

        const order = covers.slice().sort((a, b) => a.L.z + a.zo - (b.L.z + b.zo));
        let n = 0;
        for (const c of order) {
            const L = c.L;
            const dz = L.z - focusZ;
            const isHero = c === heroC ? heroAmt : 0;

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
                arcZ = bump * (F.side > 0 ? 2.6 : 1.2);
                rz = bump * 0.22 * F.side;
                ryF = bump * 0.35 * Math.sign(dx || 1);
                if (F.p >= 1) c.fl = null;
            } else {
                c.x = damp(c.x, c.hx + px, 4, dt);
                c.y = damp(c.y, c.hy + py, 4, dt);
            }

            const r = Math.hypot(c.x / 17, c.y / 10.5);
            const ahead = 1 - smooth(0.5, 2.4, dz);
            const fog = Math.min(1, (1 - Math.exp(-Math.max(0, -dz - 0.8 * D) / (4.6 * D))) / 0.96);
            const depth = dz < 0 ? 1 - 0.72 * smooth(0, 4 * D, -dz) : 1;
            let b = 0.86 * depth * (1 - 0.7 * smooth(0.15, 1, r));
            b = b + (1.02 - b) * isHero;
            b = b + (1.0 - b) * c.lift * 0.85;

            c.b = b;
            c.o = ahead;
            c.fog = fog;
            const s = 1 + 0.7 * isHero + 0.14 * c.lift;
            c.s = s;
            c.z = L.z + 1.3 * isHero + 2.0 * c.lift + arcZ + Math.sin(t * 0.6 + c.ph) * 0.06;
            c.zo = c.z - L.z;

            const tgx = (c === hovered ? -look.y * 0.35 : 0) + c.y * 0.012;
            const tgy = (c === hovered ? look.x * 0.35 : 0) - c.x * 0.012;
            c.rx = damp(c.rx, tgx, 6, dt);
            c.ry = damp(c.ry, tgy, 6, dt);

            const blur = Math.min(4.5, Math.abs(dz) * 0.3) * (1 - Math.max(isHero, c.lift));
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

        mat.uniforms.uTime.value = t;
        bgMat.uniforms.uTime.value = t;
        grade.uniforms.uTime.value = t;
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
            if (currentFps < 45) {
                slowCount++;
                if (slowCount >= 2 && PR > 0.76) {
                    PR = Math.max(0.75, PR - 0.25);
                    resize();
                    slowCount = 0;
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
    async function buildArrayTexture(covers: TunnelCover[], version: number): Promise<THREE.DataArrayTexture> {
        const count = Math.min(MAX_TEXTURE_LAYERS, Math.max(1, covers.length));
        const data = new Uint8Array(TS * TS * 4 * count);
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = tempCanvas.height = TS;
        const g = tempCanvas.getContext('2d', { willReadFrequently: true })!;

        layerAspects.fill(1.0);

        for (let i = 0; i < count; i++) {
            if (isDead || version !== loadVersion) break;
            const item = covers[i];
            if (item && item.src) {
                try {
                    const img = new Image();
                    img.crossOrigin = 'anonymous';
                    img.src = item.src;
                    await img.decode();
                    if (isDead || version !== loadVersion) break;
                    if (img.naturalWidth && img.naturalHeight) {
                        layerAspects[i] = img.naturalWidth / img.naturalHeight;
                    }
                    g.clearRect(0, 0, TS, TS);
                    g.drawImage(img, 0, 0, TS, TS);
                    data.set(g.getImageData(0, 0, TS, TS).data, i * TS * TS * 4);
                    continue;
                } catch {
                    if (isDead || version !== loadVersion) break;
                }
            }
            const placeholder = createPlaceholderCanvas(i, item?.title || `Cover ${i + 1}`);
            g.clearRect(0, 0, TS, TS);
            g.drawImage(placeholder, 0, 0, TS, TS);
            data.set(g.getImageData(0, 0, TS, TS).data, i * TS * TS * 4);
        }

        const t = new THREE.DataArrayTexture(data, TS, TS, count);
        t.minFilter = THREE.LinearMipmapLinearFilter;
        t.magFilter = THREE.LinearFilter;
        t.generateMipmaps = true;
        t.flipY = false;
        t.anisotropy = 4;
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
                c.tex = c.gridX === 0 && c.gridY === 0 && c.L.k === 0 ? 0 : keyAt(c.gridX, c.gridY, c.L.k, len);
            });

            isLoaded = true;
            resize();
            update(1 / 60, totalTime);
            composer.render();

            if (heroC && coversList[heroC.tex]) {
                options.onSelect?.(coversList[heroC.tex]);
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

        textures.forEach((t) => t.dispose());
        geometries.forEach((g) => g.dispose());
        materials.forEach((m) => m.dispose());
        composer.passes.forEach((p: any) => p.dispose?.());
        composer.dispose();
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
                PR = Math.min(dpr, next.theme === 'light' ? 0.75 : 1.5);
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
