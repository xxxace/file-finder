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