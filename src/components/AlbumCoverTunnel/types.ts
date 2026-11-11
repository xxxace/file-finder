export interface TunnelCover {
    id: string;
    title: string;
    src: string;
    raw?: any;
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
