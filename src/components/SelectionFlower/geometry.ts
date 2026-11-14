/**
 * 选区 → 字符清单。只读 DOM，不画、不存帧状态。
 *
 * ⚠️ 拆成两半，因为两者成本差一个量级：
 *    `scanSelection()` 只吐 key，便宜，可以每帧跑；
 *    `spotOf()` 要给一个字符建 Range 取矩形，贵，**每个字符一生只该调一次**。
 *    合成一个函数就得每帧为选区里所有字符取矩形（原版敢这么干是因为它只有一篇文章）。
 *
 * ⚠️ **绝不能按"选区总字数"抽稀**（曾用 `stride = ceil(n / 160)`）：
 *    选区一长 stride 就跳档，取/舍的字符整片翻转 ⇒ 全部重新播种，花整屏闪。
 *    上限交给调用方按"已种了几株"控制，这样集合**只增不减**，先长出来的花永远不动。
 *
 * ⚠️ 排除 input / textarea / contenteditable：输入法组词期间 `selectionchange` 会疯狂派发。
 * ⚠️ `commonAncestorContainer` 可能就是文本节点本身（在某段文字内部选一句），
 *    此时 TreeWalker 以文本为根、`nextNode()` 直接返回 null ⇒ 必须单独判这个分支。
 */

export interface SelectionHit {
    /** 跨帧稳定：文本节点编号 + 字符偏移。同一字符永远同一个 key，花才不会重生 */
    key: string;
    node: Text;
    offset: number;
}

export interface Spot {
    /** 字符横向中心 */
    x: number;
    /** 行盒上边缘：向上那株从这里出生 */
    top: number;
    /** 行盒下边缘：向下那株从这里出生 */
    bottom: number;
    /** 行盒高度：花的大小要跟着字走 */
    h: number;
}

const MAX_NODES = 3000;
const EDITABLE = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';
const SPACE = /\s/;

/** 文本节点 → 稳定编号。WeakMap 不拦 GC，节点被回收时编号跟着消失 */
const nodeIds = new WeakMap<Text, number>();
let nextNodeId = 1;

function idOf(node: Text): number {
    let id = nodeIds.get(node);
    if (!id) {
        id = nextNodeId++;
        nodeIds.set(node, id);
    }
    return id;
}

function editableInside(node: Node | null): boolean {
    const el = node instanceof Element ? node : node?.parentElement ?? null;
    return !!el?.closest(EDITABLE);
}

export function scanSelection(): SelectionHit[] | null {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;

    const range = selection.getRangeAt(0);
    // 两端任一落在可编辑区就整段放弃（只有半边在输入框里，同样会被组词骚扰）
    if (editableInside(range.startContainer) || editableInside(range.endContainer)) return null;

    const hits: SelectionHit[] = [];
    const collect = (node: Text) => {
        const text = node.data;
        if (!text || !range.intersectsNode(node)) return;
        const from = node === range.startContainer ? range.startOffset : 0;
        const to = node === range.endContainer ? range.endOffset : text.length;
        if (from >= to) return;
        const id = idOf(node);
        for (let i = from; i < to; i++) {
            if (SPACE.test(text[i])) continue;
            hits.push({ key: `${id}:${i}`, node, offset: i });
        }
    };

    const root = range.commonAncestorContainer;
    if (root.nodeType === Node.TEXT_NODE) {
        collect(root as Text);
    } else {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        for (let scanned = 0; scanned < MAX_NODES; scanned++) {
            const node = walker.nextNode();
            if (!node) break;
            collect(node as Text);
        }
    }
    return hits.length ? hits : null;
}

/** 单个字符的屏幕矩形。整块模块共用一个 Range 对象 —— 单线程改起止点比新建便宜得多 */
const charRange = document.createRange();

/**
 * ⚠️ **必须调**：Range 会一直吊着它最后指向的那个文本节点，节点即使从 DOM 删掉也回收不了。
 *    彩蛋关掉 / 组件卸载时把起止点挪到 `documentElement`（永远存在的那个），引用当场放开。
 */
export function releaseRange() {
    try {
        charRange.setStart(document.documentElement, 0);
        charRange.setEnd(document.documentElement, 0);
    } catch {
        // 卸载过程中 document 已不可用：那时也没有节点要放了
    }
}

export function spotOf(hit: SelectionHit): Spot | null {
    charRange.setStart(hit.node, hit.offset);
    charRange.setEnd(hit.node, hit.offset + 1);
    const rect = charRange.getBoundingClientRect();
    // 宽度 0 = 换行 / display:none 里的残字，种下去也是一株看不见的花
    if (rect.width <= 0) return null;
    return {
        x: rect.left + rect.width / 2,
        // ⚠️ 给的是**行盒的上下边缘**，不是字符中心：花从边缘往外长，选中的字一个像素都不碰
        //    （原版是"画在文字下面、根被字形和高亮遮住"，我们只有一层压在最上面的画布）。
        top: rect.top,
        bottom: rect.bottom,
        h: rect.height,
    };
}
