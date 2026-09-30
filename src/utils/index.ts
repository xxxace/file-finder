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
