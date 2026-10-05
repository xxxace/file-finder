/**
 * 选择器生成器（纯函数，**自包含**）
 * ===========================================================================
 * ⚠️ 这个函数会被 `toString()` **内联**进页面脚本执行 ⇒
 *    **不许引用任何外部变量/常量**，也别用可选链 / `??` / 展开等会被编译改写的语法。
 *
 * 稳定性分级（越靠前，越不容易因站点改版失效）：
 *   `#id` > `meta[property]` > `tag[data-*]` > `tag.classA.classB` > `tag:nth-of-type`（兜底）
 * 会主动**排掉**这些噪声：构建产物类名（`css-1a2b3c`）、状态类（`active`/`hover`）、
 * 长哈希 id、哈希化 data 值 —— 它们每次发版都可能变，用它们写规则等于埋雷。
 */

export interface ElDesc {
    tag: string;
    id: string;
    cls: string[];
    attrs: Record<string, string>;
    /** 在同辈同标签中的位置（0 基） */
    idx: number;
    /** 同辈同标签的总数 */
    total: number;
}

export function selectorCandidates(d: ElDesc): string[] {
    var esc = function (v: string): string {
        return String(v).replace(/[^\w-]/g, function (c) { return '\\' + c; });
    };
    var noisy = function (c: string): boolean {
        if (!c) return true;
        if (c.length > 24) return true;
        if (/^[a-z]+-?[a-z0-9]{5,}$/i.test(c)) return true;
        return /(^|-)(active|hover|focus|selected|open|show|disabled)$/i.test(c);
    };
    var out: string[] = [];
    var tag = (d && d.tag) || '';
    if (!tag) return out;

    // 哈希 id（`a1b2c3d4e5` 这类字母数字混排的长串）每次构建都可能变 ⇒ 不用它
    var hashId = /^[a-z0-9]{8,}$/i.test(d.id) && /\d/.test(d.id) && /[a-z]/i.test(d.id);
    if (d.id && !hashId && !noisy(d.id)) out.push('#' + esc(d.id));

    var attrs = d.attrs || {};
    if (tag === 'meta' && attrs.property) out.push('meta[property="' + attrs.property + '"]');
    var keys = Object.keys(attrs);
    for (var i = 0; i < keys.length; i++) {
        var k = keys[i];
        if (!/^data-/.test(k)) continue;
        var v = attrs[k];
        if (!v || v.length > 40 || /\d{6,}/.test(v)) continue;
        out.push(tag + '[' + k + '="' + v + '"]');
    }

    var good = (d.cls || []).filter(function (c) { return !noisy(c); });
    if (good.length) {
        out.push(tag + '.' + good.slice(0, 3).map(esc).join('.'));
        if (good.length > 1) out.push(tag + '.' + esc(good[0]));
    }

    if (d.total > 0 && d.total <= 8 && d.idx >= 0) out.push(tag + ':nth-of-type(' + (d.idx + 1) + ')');
    return out;
}
