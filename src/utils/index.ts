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
 * 一块盘的"短标识" —— 卷序列号后 4 位。
 *
 * 为什么需要它：`DriveInfo.label` 从来没被赋值（`driveIdentity.ts` 的 `probe()` 写死 `''`），
 * 而盘符只在"盘插着"时存在（离线时 `drive` 是空串，注册表 `DiskRecord` 也不存盘符）——
 * 所以"这块盘是哪一块"在离线时只能靠序列号后 4 位。
 *
 * ⚠️ "取哪几位"这条规则**只有这一处**：离线 chip（`HistoryTable` 的盘条）与离线标签
 * 用的是同一个口径，各写一份的话以后改位数就会两边不一致。
 */
export const serialTail = (serial: string) => String(serial || '').slice(-4);

/**
 * 离线盘的显示名（面包屑首段用）。
 */
export const offlineLabel = (serial: string) => `离线(${serialTail(serial)})`;

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
 * 规则：超过 `max` 段就折中间，**保首段 + `…` + 当前段**。
 *
 * 依据（两家官方规范说的都是"首 + 末"，**没有"父"这一格**）：
 * - Apple HIG：*"If the list is too long to fit within the control, it hides names
 *   between the first and last items."*
 * - Fluent 2：*"The first and last item (i.e current page) are shown by default."*
 *
 * ⚠️ 2026-10-01 实测修正：原实现是"首 + `…` + **父 + 当前**"（末 2 段）。
 * 真机截图显示，长中文名（`示例作品标题B也很难短下来`）下即使 **1280px** 窗口，
 * 4 格也正好把导航区吃到 100% ⇒ 末段被压到 22px（**连自己的 padding 都被裁掉，看起来像坏了**）。
 * 去掉「父」这一格后，1280px 下留出 ~160px 余量，每格都不再被挤压；
 * 被折掉的层级仍可通过 `…` 点开（能力不减）。
 */
export function foldCrumbList(crumbs: PathCrumb[], max = 4): CrumbFold | null {
    if (crumbs.length <= max) return null;
    const head = crumbs[0];
    const tail = crumbs.slice(-1);
    const hidden = crumbs.slice(1, crumbs.length - 1);
    // 防御性不变量：`…` 只代表 1 段就干脆别折（把它直接显示出来更划算）。
    // ⚠️ 在默认 `max = 4` 下 `hidden` 恒 ≥ 3，所以这条**不可达**，别把它当成"修了一个活缺陷"。
    if (hidden.length < 2) return null;
    return { head, hidden, tail };
}

/**
 * 这次按键**不该**被网格的方向键 / 回车接管吗？
 *
 * ## 判据：焦点所在元素**会不会消费方向键**（白名单，不是黑名单）
 *
 * ⚠️⚠️ **这里换过一次判据对象**（2026-10-04，业主三次真机报"还是要点一下才生效"）。
 * 原来写的是 `target !== document.body` —— "焦点不在 body 上就归它"。**那是错的**：
 *
 * ### 为什么错的（业主自己诊断出来的，我核实后确认）
 *
 * 打开「缓存记录」弹层 ⇒ naive-ui 的 `VFocusTrap` 记住**打开它的那个按钮**；
 * 关闭弹层时 `returnFocusOnDeactivated`（**默认 true**）把焦点**还给那个按钮**
 * （vueuc `focus-trap/src/index.js:122-127`：`lastFocusedElement.focus()`）。
 * ⇒ **焦点永远回不到 body** ⇒ `target !== document.body` 恒为真 ⇒ **方向键永久被挡**。
 * 而"点一下网格"恰好把焦点变回 body ⇒ 这就是**"每次都要点一下"的确切机制**。
 *
 * ⇒ 判据必须问的是「**焦点在不在一个会吃方向键的东西上**」，
 * 而不是「焦点在不在 body 上」。**按钮不吃方向键**（它只吃 Enter / Space）⇒ 焦点在按钮上
 * 应当**放行**。
 *
 * ## 为什么用白名单（列出"要挡的"）而不是黑名单
 *
 * 黑名单要穷举"什么会吃方向键"，而这个列表是**开放的**（将来加个 slider、树选择、
 * 数字输入框…都会进来）⇒ 漏一个就是"那个控件里方向键失灵"这种**极难定位**的 bug。
 * 白名单只列**本项目真实存在的**三类（`input` / `select` / `contenteditable`）⇒ 稳。
 *
 * | 焦点在哪| 方向键被谁吃 | 放行？ |
 * |---|---|---|
 * | `body` / 网格卡片 | 没人（我们要接管） | ✅ |
 * | **按钮**（11 个 `n-button`）| **没人**（按钮只吃 Enter/Space）| ✅ ← 修的就是这条 |
 * | `<input>`（搜索框 / 弹层里的输入）| 输入法光标 | ❌ |
 * | `<textarea>` / `<select>` | 同上 | ❌ |
 * | `contenteditable` | 同上 | ❌ |
 * | **弹层内的可交互项**（`n-select` 的下拉等）| 弹层自己 | ❌ |
 *
 * ##⛔ 仍然**不能**用"弹层开没开"当判据
 *
 * 试过 `document.querySelector('.n-modal-mask, .n-popover')`，**行不通**：
 * `n-tooltip` 内部**就是** `n-popover`（naive-ui `Tooltip.mjs` 直接 import `Popover_default`），
 * 而 popover 关闭后 DOM **仍留在页面上**（走 `v-show` 不是 `v-if`）——
 * 工具条上 4 个 `n-tooltip` 只要被鼠标悬停过一次，方向键就**永久失灵**。
 * ⇒ **DOM 类名探测 = 猜状态。**
 *
 * ## 弹层里的情况怎么办（`n-select` 下拉这种"焦点在弹层内、但弹层自己在处理方向键"）
 *
 * 靠**焦点陷阱本身**：弹层开着时 `autoFocus` 把焦点打进弹层，
 * 而弹层内的输入框/选项**都在下面的白名单里** ⇒ 自动被挡。
 * 我们自己那个文件列表 popover 更直接：那一层用 `@keydown.stop`（事件到不了 window）
 * + 容器有 `tabindex="-1"`（焦点在它上面）。
 *
 * ## 探针记录（`docs/probes/grid-cursor-focus/`，真 Chromium）
 *
 * 这次换判据时补了**两条真机场景的断言**，它们是判据真正生效的原因：
 * - 「弹层关闭后焦点回到按钮 ⇒ 方向键仍可用」（改之前这里必 FAIL）
 * - 「焦点在搜索框 ⇒ 方向键被挡」
 */
export function isGridKeyBlocked(e: KeyboardEvent): boolean {
    // ⚠️ 读 **`e.target`**（这次事件的接收者），而不是 `document.activeElement`：
    // 二者在真事件里通常一致，但 `activeElement` 在**焦点陷阱还焦点的那一瞬**可能
    // 还没更新，而 `e.target` 是浏览器已经算好的这次事件真正落在谁身上。
    const t = e.target as HTMLElement | Document | Window | null;
    if (t == null) return false;
    // 合成事件（`dispatchEvent`、部分测试工具、iframe 内的派发）的 target 是
    // `window` / `document` / `body` ⇒ 都没有焦点元素 ⇒ 放行。
    if (t === document || t === window || t === document.body) return false;
    // `DocumentFragment` 等非 HTMLElement 的 target：没有 tagName，当作"不在控件里"。
    const el = t as HTMLElement;
    if (typeof el.tagName !== 'string') return false;

    // ── 白名单：这三类会消费方向键 ⇒ 键归它们 ──────────────────────────
    const tag = el.tagName.toUpperCase();
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (el.isContentEditable) return true;
    // `role` 也算：有些控件用 div + role 伪装（`n-select` 的触发器就是
    // `role="combobox"` 一类）。不列的话，方向键会在下拉里"穿透到网格"。
    const role = el.getAttribute?.('role');
    if (role === 'textbox' || role === 'combobox' || role === 'listbox' || role === 'slider'
        || role === 'spinbutton' || role === 'tree' || role === 'grid') return true;

    // 其余（按钮、卡片、div…）⇒ **放行**：它们不吃方向键，按键归网格。
    // ⚠️ 这条"放行"是修好"每次都要点一下"的关键：`n-button` 拿到焦点后
    // 方向键现在能直接用了，不需要用户去点网格把焦点"洗"回 body。
    return false;
}
