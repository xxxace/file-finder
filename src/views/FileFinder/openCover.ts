/**
 * 「这张封面 → 播起来」—— **全项目唯一实现**。
 *
 * 2026-11-15 从 `Tunnel/index.vue` 的 `handleSelect` 里抽出来。抽的理由不是"想整洁"：
 * 抽卡页（`views/Lucky`）要**一模一样**的行为（挑视频 → 拼锚点 → 解析 → 交给系统），
 * 而这条链上有三个容易走偏的判据（见下）。第二份实现必然慢慢分叉。
 *
 * 三个判据：
 *  ① **挑哪个文件**：`files` 里的第一个视频；都没有就用第一个文件；再没有才用 `name+ext`。
 *     顺序不能换 —— 目录代言卡片的 `name`/`ext` 取的是封面图，直接用它拼会去开一张 jpg。
 *  ② **拼的是锚点**（`#序列号/盘内路径`），不是盘符路径：拔过盘之后盘符会变，
 *     序列号 + 盘内路径恒定。实时路径交给主进程的 `resolveAnchor` 解析。
 *  ③ **离线不是异常**：盘没插时 `resolveAnchor` 拿不到实时路径（或抛 `kind:'offline'`），
 *     这要能和"真的出错了"分开 —— 前者提示插盘，后者才是报错。
 */
import { ipcRenderer } from 'electron';
import { API_BASE, getAction } from '@/utils/request';
import { RENDER_VIDEO_EXT_RE } from '@/utils/videoExt';

/** 打开一张卡所需的全部信息（`TunnelCoverItem` / `DrawCard.src` 都满足） */
export interface OpenableCover {
    serial: string;
    dir: string;
    /** 显示名（封面条目是封面图名，不含扩展名） */
    name: string;
    ext?: string;
    files?: ReadonlyArray<{ name: string }>;
}

export type OpenCoverResult =
    | { ok: true }
    /** 盘不在线（拔了 / 盘符变了没重探）。`serial` 用于提示文案 */
    | { ok: false; reason: 'offline'; serial: string }
    /** 真失败。`stage` 告诉你失败在"解析路径"还是"启动播放器"—— 两处文案不同 */
    | { ok: false; reason: 'error'; stage: 'resolve' | 'open'; message: string };

/** 这一格里该打开哪个文件（判据①）。纯函数，无副作用。 */
export function pickFileName(src: OpenableCover): string {
    const video = src.files?.find(f => RENDER_VIDEO_EXT_RE.test(f.name));
    if (video) return video.name;
    const first = src.files?.[0]?.name;
    if (first) return first;
    return src.ext ? `${src.name}.${src.ext}` : src.name;
}

/** 拼只读锚点（判据②）。纯函数，无副作用。 */
export function anchorOf(src: OpenableCover): string {
    const file = pickFileName(src);
    return `#${src.serial}/${src.dir ? `${src.dir}/` : ''}${file}`;
}

/** 服务端抛的 `ApiError` 带 `kind`；没有就退回看文案（`resolveAnchor` 的旧写法）。 */
function looksOffline(e: unknown, message: string): boolean {
    const kind = (e as { kind?: string } | null)?.kind;
    return kind === 'offline' || message.includes('不在') || message.includes('offline');
}

/**
 * 打开一张卡。**不弹提示** —— 提示是界面层的事（三个页面各有各的措辞），
 * 这里只把"发生了什么"如实带回去。
 */
export async function openCover(src: OpenableCover): Promise<OpenCoverResult> {
    let livePath: string | undefined;
    try {
        const res = await getAction(
            `${API_BASE}/resolveAnchor?path=${encodeURIComponent(anchorOf(src))}`,
        );
        livePath = res?.path;
    } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (looksOffline(e, message)) return { ok: false, reason: 'offline', serial: src.serial };
        return { ok: false, reason: 'error', stage: 'resolve', message };
    }

    // 没抛错但没有路径 ⇒ 服务端查不到这块盘此刻的挂载点，等同于"盘不在"
    if (!livePath) return { ok: false, reason: 'offline', serial: src.serial };

    // `openPath` 契约：成功返回空串，失败返回错误描述
    const err = await ipcRenderer.invoke('openFile', livePath);
    if (err) return { ok: false, reason: 'error', stage: 'open', message: String(err) };
    return { ok: true };
}
