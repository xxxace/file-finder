/* Lightweight viewport-culled DOM snapshotter for WebGL lens sampling.
   Unlike full-tree SVG serialization, this culls any element outside the
   container's visible viewport rect, keeping large grids (500-2000+ cards)
   fast and bounded. */

const XHTML_NS = 'http://www.w3.org/1999/xhtml';
const SVG_NS = 'http://www.w3.org/2000/svg';

export interface ViewportSnapshotOptions {
    width: number;
    height: number;
    scale: number;
    background: string;
    skip?: (el: Element) => boolean;
    into?: HTMLCanvasElement;
    /** Hard cap on visited visible elements to prevent stalls on extreme DOM trees. */
    maxNodes?: number;
}

const SKIPPED_TAGS = new Set([
    'script',
    'style',
    'noscript',
    'template',
    'link',
    'meta',
    'title',
    'head',
    'base',
    'source',
    'track',
    'param',
    'datalist',
    'iframe',
    'object',
    'embed',
    'audio',
]);
const VOID_TAGS = new Set(['area', 'br', 'col', 'embed', 'hr', 'img', 'input', 'wbr']);
const NAME_RE = /^[A-Za-z_][\w.-]*$/;
const INVALID_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g;

const DROP_PROPS =
    /^(?:animation|transition|view-timeline|scroll-timeline|timeline-scope|view-transition|scroll-behavior|scroll-snap|scroll-margin|scroll-padding|overscroll-behavior|cursor$|pointer-events$|user-select$|-webkit-user-|will-change$|resize$)/;

const escapeText = (s: string) =>
    s.replace(INVALID_XML, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttr = (s: string) =>
    s.replace(INVALID_XML, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

const PERCENT: Record<string, string> = { '%': '%25', '#': '%23', '\n': '%0A', '\r': '%0D', '\t': '%09' };

/* Cache resampled image data URLs briefly by src+size so repeated captures reuse work. */
const imageCache = new Map<string, string>();
const CACHE_LIMIT = 120;

function cacheImage(key: string, dataUrl: string) {
    if (imageCache.size >= CACHE_LIMIT) {
        const first = imageCache.keys().next().value;
        if (first !== undefined) imageCache.delete(first);
    }
    imageCache.set(key, dataUrl);
}

/** Rasterize an already-decoded <img> at its displayed size to avoid re-fetching. */
function rasterizeLoadedImg(img: HTMLImageElement, scale: number): string | null {
    const src = img.currentSrc || img.src;
    if (!src) return null;
    if (src.startsWith('data:')) return src;
    if (!img.complete || !img.naturalWidth) return null;

    const w = Math.max(1, Math.round(Math.max(img.clientWidth, 1) * scale));
    const h = Math.max(1, Math.round(Math.max(img.clientHeight, 1) * scale));
    const key = `${src}|${w}x${h}`;
    const hit = imageCache.get(key);
    if (hit) return hit;

    try {
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        const ctx = c.getContext('2d');
        if (!ctx) return null;
        ctx.imageSmoothingQuality = 'medium';
        ctx.drawImage(img, 0, 0, w, h);
        const data = c.toDataURL('image/webp', 0.9);
        cacheImage(key, data);
        return data;
    } catch {
        return null;
    }
}

function inlineStyleString(cs: CSSStyleDeclaration, shift: string, isRoot: boolean, w: number, h: number): string {
    let css = '';
    for (let i = 0; i < cs.length; i++) {
        const prop = cs[i];
        if (prop.startsWith('--') || DROP_PROPS.test(prop)) continue;
        let val = cs.getPropertyValue(prop);
        if (!val) continue;
        if (prop === 'transform' && shift) {
            val = val === 'none' ? shift : `${shift} ${val}`;
        }
        css += `${prop}:${val};`;
    }
    if (isRoot) {
        css += `position:absolute;left:0;top:0;margin:0;width:${w}px;height:${h}px;box-sizing:border-box;transform:none;filter:none;opacity:1;visibility:visible;`;
    }
    return css;
}

function rectsOverlap(a: DOMRect, b: DOMRect): boolean {
    return a.right >= b.left && a.left <= b.right && a.bottom >= b.top && a.top <= b.bottom;
}

interface WalkState {
    root: HTMLElement;
    clipRect: DOMRect;
    scale: number;
    width: number;
    height: number;
    skip?: (el: Element) => boolean;
    out: string[];
    nodes: number;
    maxNodes: number;
}

function walkNode(el: Element, parentNS: string | null, shift: string, st: WalkState): void {
    if (st.nodes >= st.maxNodes) return;
    const isRoot = el === st.root;
    if (!isRoot && st.skip?.(el)) return;

    const ns = el.namespaceURI;
    const isSvg = ns === SVG_NS;
    if (!isSvg && ns !== XHTML_NS) return;
    const tag = el.localName;
    if (!isSvg && SKIPPED_TAGS.has(tag)) return;
    if (!NAME_RE.test(tag)) return;

    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return;

    // Viewport culling: skip off-screen branches (huge win for 1000-card grids)
    if (!isRoot) {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return;
        if (!rectsOverlap(rect, st.clipRect)) return;
    }

    st.nodes++;

    let outTag = tag;
    let attrs = '';
    if (!isSvg && tag === 'img') {
        const data = rasterizeLoadedImg(el as HTMLImageElement, st.scale);
        if (data) attrs += ` src="${escapeAttr(data)}"`;
    } else if (!isSvg && tag === 'canvas') {
        try {
            const c = el as HTMLCanvasElement;
            if (c.width && c.height) {
                outTag = 'img';
                attrs += ` src="${escapeAttr(c.toDataURL())}"`;
            }
        } catch {
            // ignore tainted canvas
        }
    } else if (isSvg) {
        for (let i = 0; i < el.attributes.length; i++) {
            const { name, value } = el.attributes[i];
            if (name === 'style' || name === 'class' || name === 'xmlns' || name.startsWith('on')) continue;
            attrs += ` ${name}="${escapeAttr(value)}"`;
        }
    }

    const css = inlineStyleString(cs, shift, isRoot, st.width, st.height);
    const nsAttr = ns !== parentNS ? ` xmlns="${ns}"` : '';
    const open = `<${outTag}${nsAttr} style="${escapeAttr(css)}"${attrs}`;

    if (!isSvg && VOID_TAGS.has(outTag)) {
        st.out.push(`${open}/>`);
        return;
    }

    st.out.push(`${open}>`);
    const sl = el.scrollLeft;
    const stTop = el.scrollTop;
    const childShift = sl || stTop ? `translate(${-sl}px,${-stTop}px)` : '';
    const kids = el.childNodes;
    for (let i = 0; i < kids.length; i++) {
        const kid = kids[i];
        if (kid.nodeType === 1) walkNode(kid as Element, ns, childShift, st);
        else if (kid.nodeType === 3) st.out.push(escapeText((kid as Text).data));
    }
    st.out.push(`</${outTag}>`);
}

function loadSvgImage(svg: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('DistortionWaves: snapshot image load failed'));
        img.src = 'data:image/svg+xml;charset=utf-8,' + svg.replace(/[%#\n\r\t]/g, (c) => PERCENT[c]);
    });
}

/**
 * Capture the visible viewport of `root` into a 2D Canvas.
 * Returns `null` if node budget is exceeded or rasterization fails so callers
 * can degrade gracefully to lens-free wave rendering.
 */
export async function captureViewportSnapshot(
    root: HTMLElement,
    o: ViewportSnapshotOptions,
): Promise<HTMLCanvasElement | null> {
    const clipRect = root.getBoundingClientRect();
    if (clipRect.width <= 0 || clipRect.height <= 0) return null;

    const st: WalkState = {
        root,
        clipRect,
        scale: o.scale,
        width: o.width,
        height: o.height,
        skip: o.skip,
        out: [],
        nodes: 0,
        maxNodes: o.maxNodes ?? 2400,
    };

    walkNode(root, XHTML_NS, '', st);
    if (!st.out.length) return null;

    const cw = +o.width.toFixed(3);
    const ch = +o.height.toFixed(3);
    const W = Math.max(1, Math.round(o.width * o.scale));
    const H = Math.max(1, Math.round(o.height * o.scale));
    const body = st.out.join('');

    const svg =
        `<svg xmlns="${SVG_NS}" xmlns:xlink="http://www.w3.org/1999/xlink" width="${cw}" height="${ch}" viewBox="0 0 ${cw} ${ch}">` +
        `<foreignObject x="0" y="0" width="${cw}" height="${ch}">` +
        `<div xmlns="${XHTML_NS}" style="position:relative;width:${cw}px;height:${ch}px;overflow:hidden;">` +
        body +
        `</div></foreignObject></svg>`;

    const img = await loadSvgImage(svg);
    try {
        await img.decode();
    } catch {
        // onload is sufficient if decode() rejects on SVG
    }

    const canvas = o.into ?? document.createElement('canvas');
    if (canvas.width !== W || canvas.height !== H) {
        canvas.width = W;
        canvas.height = H;
    }
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return null;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = o.background;
    ctx.fillRect(0, 0, W, H);
    ctx.drawImage(img, 0, 0, W, H);
    return canvas;
}
