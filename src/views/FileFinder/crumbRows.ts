/**
 * 面包屑的**渲染布局** —— 纯函数、零 DOM、零读盘。
 *
 * 抽出来有两个原因：
 * ① 折叠与不折叠原来是模板里 `v-if` / `v-else` 两棵互斥的树，层级跨过阈值时
 *    Vue 会销毁整棵子树重建另一棵 ⇒ 观感是"整排地址重新渲染"，而且 FLIP 拿不到
 *    "移动前的位置"，任何过渡都做不出来。**折叠只是列表多一项 `…`，不是换模板。**
 * ② 一放进模板就只能靠截图验；抽成纯函数之后 `docs/probes/crumbs/layout.mjs` 能直接跑。
 *
 * 模板为什么分三段（head / fold / tail）而不是一个 `v-for`：
 * `TransitionGroup` 的 FLIP 只认**元素**子节点，`<template v-for>` 产生的 fragment
 * 拿不到 `el`，位移会静默失效。
 */
import type { CrumbFold, PathCrumb } from '@/utils';

/** 一个可渲染的段。`key` 直接给 `TransitionGroup` 用，必须稳定且唯一 */
export interface CrumbRow {
    key: string;
    name: string;
    path: string;
    kind: 'root' | 'dir';
}

export interface CrumbLayout {
    /** 首段（盘符 / 离线锚点 / 清单根）。**不可点**，样式与其余段不同 */
    head: CrumbRow | null;
    /** 折叠占位 `…`；非 null 时它永远排在 head 之后 */
    fold: CrumbRow | null;
    /** 首段之外的所有段（含当前段）。折叠时只有一段 */
    tail: CrumbRow[];
    /** 首段自己就是当前段 —— 只在"整条只有一段"时成立（如 `F:/`） */
    headCurrent: boolean;
}

const FOLD_KEY = 'fold';
const FOLD_ROW: CrumbRow = { key: FOLD_KEY, name: '…', path: '', kind: 'dir' };

/**
 * @param crumbs `ancestorsOf(currentPath)` 的结果（已含首段）
 * @param fold   `foldCrumbList(crumbs)` 的结果；`null` = 全显
 *
 * ⚠️ `key` 加 `c:` 前缀：清单屏首段的 `path` 是**空串**，空 key 在列表里不安全；
 * 顺带与折叠占位的 `fold` 隔开。
 */
export function buildCrumbLayout(crumbs: PathCrumb[], fold: CrumbFold | null = null): CrumbLayout {
    const src = fold ? [fold.head, ...fold.tail] : crumbs;
    const rows = src.map<CrumbRow>((c) => ({
        key: `c:${c.path}`,
        name: c.name,
        path: c.path,
        kind: c.kind,
    }));

    // 占位永远插在首段之后、当前段之前 ⇒ 所以下面 head / fold / tail 的切法是定长的
    if (fold) rows.splice(1, 0, FOLD_ROW);

    const head = rows[0] ?? null;
    const foldRow = fold ? rows[1] ?? null : null;
    const tail = fold ? rows.slice(2) : rows.slice(1);

    return { head, fold: foldRow, tail, headCurrent: rows.length === 1 };
}
