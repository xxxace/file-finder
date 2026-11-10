/**
 * 导航历史 = **一个数组 + 一个游标**（不是"进一屏压一屏、返回就 pop"的栈）。
 *
 * 为什么要游标：栈一 pop，那一屏就连同它的 scrollY / 选择器 / 过滤词一起销毁了，
 * 于是"前进"无处可去。数组 + index 之后，后退只是 index--，那一屏还在 ⇒ 两个方向对称。
 *
 * ⚠️ 为什么**不用两个数组**（backStack + forwardStack）：2026-09-30 那次就是被
 *    "两个数组长度必须差 1"这个没有任何类型约束的隐式不变量坑的
 *    （`openStack` / `searchStack`，见 `docs/DESIGN-NAV-2026-09-30.md §2`）。
 *    一个数组 + 一个整数，错位在结构上不可能发生。
 * ⚠️ `index = -1` 与空数组**一一对应** = 「还没选文件夹」。别用 `length - 1` 推游标：
 *    那等于"当前屏由数组长度表达"，前进尾巴一存在就立刻错。
 * ⚠️ 本模块只认**导航**，不认界面：分屏取数（`loadScreen`）/ 恢复滚动 / 焦点意图
 *    都留在页面里 —— 那些要 DOM。这里只保证"哪一屏、什么顺序、记下的三样"。
 */
import { computed, ref } from 'vue';
import type { OpenMode } from 'electron/server/nedb';

/**
 * 一屏的历史条目。
 *
 * ⚠️ 这三样原来分散在**三个地方**：`openStack` 的元素（`name`/`mode`/`scrollY`）、
 * `searchStack` 数组（搜索词），以及"两个数组长度必须差 1"这个**没有任何类型约束的隐式不变量**。
 * 合并成一个对象之后，"索引对齐错"在结构上不可能发生。
 *
 * **位置不进这里** —— 面包屑由 `ancestorsOf(currentPath)` 现算（纯函数）。
 * 位置可推导、历史不可推导，两者共用一个数组时，逐层下钻看不出问题，
 * **一旦跳转就必然分叉**（详见 `docs/DESIGN-NAV-2026-09-30.md` §2）。
 */
export interface NavEntry {
    path: string;
    /**
     * 三层入口（选根 / 网格下钻 / 缓存跳转）**一律用 `'cover'`**。
     * 保留这个字段是为了不动 `fetchFolder` 的签名 —— 服务端的 `folder`（无封面收敛）模式
     * 是真实存在的能力，删它是删能力，不是删死代码。
     */
    mode: OpenMode;
    /** 坐在这一屏时搜索框里的词 —— 返回 / 前进时恢复 */
    searchText: string;
    /** 离开这一屏时的滚动位置 —— 返回 / 前进时恢复 */
    scrollY: number;
    /**
     * 离开这一屏时选择器停在哪一格（keyOf 值）—— 返回 / 前进时恢复。
     * ⚠️ 存 key 不存坐标：坐标随布局 / 列数变，存坐标得跟着窗口宽度同步（会漏）。
     * ⚠️ key 不在这一屏里 ⇒ cursorItem 为 undefined、不画高亮，
     * 下一次方向键自动重新激活 —— 这条派生链已经在了（`useGridCursor` 文件头）。
     */
    cursorKey: string;
    /**
     * 清单屏标识（2026-10-21 收藏分类）。非空 = 这一屏是某个清单的详情。
     *
     * 为什么不复用 `mode`：`OpenMode` 是**服务端缓存模式**的枚举（'cover' | 'folder'），
     * 清单不是一种缓存模式，混进去会污染那个类型、也会让 `fetchFolder` 的签名说谎。
     * path 同时写成 `@pl:<id>` —— 两者**同进同退**：取数按 `pl` 分派，
     * 面包屑/返回只认 path（nav 栈里流动的只有 path 一个字符串的既有纪律不变）。
     */
    pl?: { id: string; name: string };
}

/** 离开一屏时要记下的三样 */
export type NavSnapshot = Pick<NavEntry, 'scrollY' | 'searchText' | 'cursorKey'>;

export interface NavStackDeps {
    /**
     * 取"这一屏现在的样子"。
     *
     * ⚠️ **必须是函数**，不能传值：三样里的 `scrollY` 要读容器 DOM、另两样是页面的 ref，
     *    而本模块在页面里被创建的位置比那两个 ref 的声明**更靠前**（声明顺序由界面需要决定，
     *    不该为了导航模型去倒排）⇒ 传值会当场 TDZ。函数在"离开那一刻"才求值。
     */
    snapshot: () => NavSnapshot;
}

export function useNavStack(deps: NavStackDeps) {
    const entries = ref<NavEntry[]>([]);
    /** -1 = 空。见文件头：不许用 `length - 1` 推 */
    const index = ref(-1);

    /**
     * ⚠️ 别写 `entries.value.at(index.value)`：`.at(-1)` 是**最后一个元素**，
     *    空游标时会静默读到尾巴上那一屏（正是本模块要防的错）。
     */
    const current = computed<NavEntry | undefined>(
        () => (index.value >= 0 ? entries.value[index.value] : undefined),
    );
    const hasAny = computed(() => entries.value.length > 0);
    const canBack = computed(() => index.value > 0);
    const canForward = computed(() => index.value < entries.value.length - 1);

    /** 把"离开这一刻"的三样写到**当前这一屏自己**身上（不是写到要去的那一屏） */
    const snapshotCurrent = () => {
        const cur = current.value;
        if (cur) Object.assign(cur, deps.snapshot());
    };

    /**
     * 进新的一屏。**唯一压历史的入口**（选根 / 下钻 / 面包屑跳转 / 缓存跳转全走它）。
     * 在中间位置进新屏 ⇒ 先砍掉游标右边的尾巴（浏览器语义：走了新路，旧的前进方向作废）。
     */
    const push = (entry: NavEntry) => {
        snapshotCurrent();
        if (index.value < entries.value.length - 1) entries.value.splice(index.value + 1);
        entries.value.push(entry);
        index.value = entries.value.length - 1;
        return entry;
    };

    /**
     * 后退（-1）/ 前进（+1）。**唯一的移动入口** —— 两个方向共用这一处快照，
     * 于是"离开时记下这一屏"不需要在后退、前进里各写一遍（那两份必然漂移）。
     * 越界返回 `undefined`，调用方只判一次，不必自己算边界。
     */
    const step = (delta: 1 | -1) => {
        const next = index.value + delta;
        if (next < 0 || next >= entries.value.length) return undefined;
        snapshotCurrent();
        index.value = next;
        return entries.value[next];
    };

    /** 只换当前屏的字段、不动历史 —— 拔盘时把这一屏的地址换成离线锚点用 */
    const replaceCurrent = (patch: Partial<NavEntry>) => {
        const cur = current.value;
        if (cur) Object.assign(cur, patch);
    };

    /** 清空全部历史（选根 / 换根 / 清空导航）—— "重新开始"，与 push 不是一回事 */
    const reset = () => {
        entries.value = [];
        index.value = -1;
    };

    return { current, hasAny, canBack, canForward, push, step, replaceCurrent, reset };
}
