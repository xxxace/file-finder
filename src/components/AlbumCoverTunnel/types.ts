export interface TunnelCover {
    id: string;
    title: string;
    src: string;
    sig?: string;
    raw?: any;
}

const GENERIC_COVER_NAMES = new Set([
    'cover', 'folder', 'front', 'avatar', 'thumb', 'thumbnail',
    'poster', 'default', 'preview', 'fanart', 'back', 'cd', 'disc',
]);

export function workKeyOf(item: { title?: string; name?: string; dir?: string; raw?: any }): string {
    const rawName = (item.title || item.name || item.raw?.name || '').trim();
    const base = rawName.replace(/\.[^./\\]+$/, '').trim().toLowerCase();
    if (base && !GENERIC_COVER_NAMES.has(base)) {
        return base;
    }
    const d = (item.dir || item.raw?.dir || '').trim().replace(/[\\/]+$/, '');
    if (!d) return base || 'untitled';
    const segs = d.split(/[\\/]/).filter(Boolean);
    const leaf = segs.length > 0 ? segs[segs.length - 1] : '';
    return leaf ? leaf.replace(/\.[^./\\]+$/, '').trim().toLowerCase() : base || 'untitled';
}

export function dedupeCovers(items: TunnelCover[]): TunnelCover[] {
    const seenSig = new Set<string>();
    const seenWork = new Set<string>();
    return items.filter((it) => {
        const sig = it.sig || it.raw?.sig;
        const wk = workKeyOf(it);
        if (sig && seenSig.has(sig)) return false;
        if (wk && wk !== 'untitled' && seenWork.has(wk)) return false;

        if (sig) seenSig.add(sig);
        if (wk && wk !== 'untitled') seenWork.add(wk);
        return true;
    });
}

export interface TunnelOptions {
    height?: number;
    theme?: 'dark' | 'light';
    autoTravel?: boolean;
    onSelect?: (cover: TunnelCover) => void;
    onHover?: (cover: TunnelCover | null) => void;
    onFps?: (fps: number) => void;
}

export interface TunnelController {
    ready: Promise<void>;
    destroy: () => void;
    update: (next?: Partial<TunnelOptions>) => void;
    setCovers: (covers: TunnelCover[]) => Promise<void>;
    togglePause: () => boolean;
    isPaused: () => boolean;
    setActive: (active: boolean) => void;
    getActiveCover: () => TunnelCover | null;
}
