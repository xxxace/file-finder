/** 字节数 → 人类可读。0 / 空 → '—'。 */
export function formatBytes(bytes: number | undefined | null): string {
    if (!bytes || bytes <= 0) return '—';
    const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
    let n = bytes;
    let i = 0;
    while (n >= 1024 && i < units.length - 1) {
        n /= 1024;
        i += 1;
    }
    // B / KB 用整数（"3 KB" 比 "3.00 KB" 好读），MB 以上两位小数
    return `${i <= 1 ? n.toFixed(0) : n.toFixed(2)} ${units[i]}`;
}

/**
 * ⚠️ 老的 `parseSize` 把 TB 截断了：`gb = bytes / 1G % 1024` 是**取模**，
 * 1.83 TB 会被渲染成 `850.xxGB`、2 TB 直接变 `0.00GB` —— 静默输出错误数字。
 * 它只被主界面的 `getSize` 用；`getSize` 已改成调用 `formatBytes`（支持 TB），
 * 所以这里**保留但不再使用**：留着是为了万一别处还引；真要用请用 `formatBytes`。
 * 先例与实测见 docs/DESIGN-CACHE-PANEL-2026-09-30.md §3.4。
 */
export function parseSize(bytes: number) {
    const s = {
        gb: bytes / 1024 / 1024 / 1024 % 1024,
        mb: bytes / 1024 / 1024 % 1024,
        kb: bytes / 1024 % 1024,
    }
    return s
}

interface file {
    name: string;
    children?: file[];
}


function getSpace(length: number, tab: number) {
    let space = ``;
    for (let j = 0; j < tab; j++) {
        space += ` `;
    }

    return space;
}

let level_stack: boolean[] = []
export function printTree(tree: file[], level: number, tab: number = 2, treeStr: string) {

    const length = tree.length - 1;
    for (let i = 0; i < tree.length; i++) {
        if (level === 0) level_stack = []
        const isLast = i === length;
        const sub = tree[i]

        for (let t = 0; t < level; t++) {
            let h_line = '│'
            if (level_stack[t] === true) {
                h_line = ` `
            }
            treeStr += `${h_line}${getSpace(level, tab)}`
        }

        treeStr += `${isLast ? '└──' : '├──'}${sub.name}\n`;

        if (sub.children) {
            level_stack.push(isLast)
            treeStr = printTree(sub.children, level + 1, tab, treeStr)
            level_stack.pop()
        }
    }

    return treeStr;
}

/* ────────────────────────────────────────────────────────────────────────────
 * 路径 → 面包屑（纯函数，零查询、零读盘）
 *
 * 为什么是纯函数而不是"导航栈记下来"：位置（我在哪）能从**当前路径**算出来，
 * 而历史（我刚在哪）算不出来、必须存。把位置也存进同一个数组，就会出现
 * "跳转到达的目录被当成某个父级的子级"——面包屑会渲染出一条**物理上不存在的路径**。
 * 详见 docs/DESIGN-NAV-2026-09-30.md §12.3 的反证推演。
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * 只读锚点的前缀。与 `electron/server/index.ts` 的 `ANCHOR_PREFIX` **必须同值**：
 * 离线盘的地址是 `#序列号/盘内路径`，渲染层不解析它的内容，只认这个前缀。
 */
export const ANCHOR_PREFIX = '#';

/**
 * 离线盘的显示名。**唯一实现** —— 原来只写在 `HistoryTable` 的 `diskLabel()` 里（本地实现），
 * 面包屑首段也要用同一个格式，所以收上来（否则以后改文案要改两处）。
 * 为什么用序列号后 4 位：`DriveInfo.label` 从来没被赋值（`driveIdentity.ts` 的 `probe()` 写死 `''`），
 * 只能靠序列号区分"是哪一块盘"；两块盘都不在时，笼统的「未插入」会变成两行一样的字。
 */
export const offlineLabel = (serial: string) => `离线(${String(serial || '').slice(-4)})`;

/** 面包屑的一段。`kind: 'root'` = 首段（盘符 / 离线锚点），**永远不可点** */
export interface PathCrumb { name: string; path: string; kind: 'root' | 'dir' }

/**
 * 把一条路径拆成"从起点到当前"的完整链。**纯函数、零查询、零读盘**。
 *
 * 三种形态（都是现有数据来源里真实会出现的）：
 *   E:/videos/a       → E: / videos / a              （在线）
 *   #CD72/videos/a    → 离线(CD72) / videos / a       （离线只读锚点）
 *   \\server\share\x  → server / share / x            （UNC / 网络位置兜底）
 *
 * 为什么它能替掉"导航栈"：跳转之后位置照样算得出来，所以跨盘跳转不会拼出假路径。
 */
export function ancestorsOf(fullPath: string): PathCrumb[] {
    const raw = String(fullPath || '');
    if (!raw) return [];

    // ① 离线只读锚点：#序列号/盘内路径
    if (raw.startsWith(ANCHOR_PREFIX)) {
        const segs = raw.slice(ANCHOR_PREFIX.length).split('/').filter(Boolean);
        const serial = segs.shift() || '';
        const root = `${ANCHOR_PREFIX}${serial}`;
        const out: PathCrumb[] = [{ name: offlineLabel(serial), path: root, kind: 'root' }];
        let acc = root;
        for (const s of segs) {
            acc += `/${s}`;
            out.push({ name: s, path: acc, kind: 'dir' });
        }
        return out;
    }

    // ② 盘符路径
    const m = /^([A-Za-z]):[\\/]?(.*)$/.exec(raw);
    if (m) {
        const drive = m[1].toUpperCase();
        const out: PathCrumb[] = [{ name: `${drive}:`, path: `${drive}:/`, kind: 'root' }];
        // ⚠️ `acc` 必须带冒号：漏了就会拼出 `E/videos` 这种不存在的路径，
        // 点面包屑就跳到错地方（探针 `docs/probes/crumbs/` 抓到过这一条）。
        let acc = `${drive}:`;
        for (const s of (m[2] || '').split(/[\\/]+/).filter(Boolean)) {
            acc += `/${s}`;
            out.push({ name: s, path: acc, kind: 'dir' });
        }
        return out;
    }

    // ③ UNC / 网络位置 / 虚拟盘：没有盘符，首段就是第一段（不做特殊处理，别的地方也不会为它开特例）
    const unc = /^[\\/]{2}/.test(raw);
    const out: PathCrumb[] = [];
    raw.split(/[\\/]+/).filter(Boolean).forEach((s, i) => {
        const p = i === 0 ? (unc ? `\\\\${s}` : s) : `${out[i - 1].path}/${s}`;
        out.push({ name: s, path: p, kind: i === 0 ? 'root' : 'dir' });
    });
    return out;
}

/**
 * 把长路径压成"首段 + … + 末 N 段"。给**单个字符串**用（根路径 chip）。
 *
 * ⚠️ 不用 CSS 的 `direction: rtl` 反向截断（那是"保尾部"的老技巧）——
 * 它会把 `E:/` 里的 `/` 排到错位置。算成字符串最稳，而且可单独验证。
 * 与 `foldCrumbList`（给**整条面包屑**用）是两件事，别混。
 */
export function foldPath(fullPath: string, keepTail = 2): string {
    const crumbs = ancestorsOf(fullPath);
    if (!crumbs.length) return '';
    if (crumbs.length <= keepTail + 1) return crumbs.map(c => c.name).join('/');
    return [crumbs[0].name, '…', ...crumbs.slice(-keepTail).map(c => c.name)].join('/');
}

export interface CrumbFold { head: PathCrumb; hidden: PathCrumb[]; tail: PathCrumb[] }

/**
 * 面包屑的折叠决策。返回 `null` = 全显。
 *
 * 规则：超过 `max` 段就折中间，**保首段 + `…` + 末 2 段（父 + 当前）**。
 * 依据：Apple HIG 的路径控件原文 "If the list is too long to fit within the control,
 * it hides names between the first and last items"；Fluent 2 的默认行为是"只显第一项和最后一项"。
 * 两家独立收敛到同一条规则。
 *
 * ⚠️ **`…` 至少代表 2 段才折** —— 否则 5 段路径会渲染成 `E: › … › 父 › 当前`，
 * 白白多一次点击（那一段本来可以直接显示）。
 */
export function foldCrumbList(crumbs: PathCrumb[], max = 4): CrumbFold | null {
    if (crumbs.length <= max) return null;
    const head = crumbs[0];
    const tail = crumbs.slice(-2);
    const hidden = crumbs.slice(1, crumbs.length - 2);
    if (hidden.length < 2) return null;
    return { head, hidden, tail };
}
