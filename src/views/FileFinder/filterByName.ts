/**
 * 按关键词过滤条目（纯函数，零 DOM、零读盘）。
 *
 * 规则：命中"名字的子串"即算，另外**ASCII 前缀**还额外比拼音首字母
 * （输入 `zy` 能匹配"周星驰"这类）。取名字开头连续字母的个数当拼音段长度。
 *
 * ⚠️ `usePinYin()` 返回的是 `string[]`（一个字多读音就给多个），直接参与 `+` 会被隐式
 *    `join(',')` ⇒ 匹配串里凭空多一个逗号、再也搜不到。取第一个读音。
 *    平时看不出来是因为不含多音字时数组只有一个元素（20902 个汉字里 375 个多音字）。
 * ⚠️ 字符类写成 `[A-Za-z]` 而不是 `[a-z|A-Z]`：后者里的 `|` 是**字面量**，
 *    名字以竖线开头会被误判成字母。
 */
import type { WiredFileInfo } from '../../../electron/server/index';
import usePinYin from '@/hooks/usePinYin';

const ASCII_LETTER = /^[A-Za-z]/;

export function filterByName(list: WiredFileInfo[], value: string): WiredFileInfo[] {
    // 关键词以字母开头时，找出"开头的连续字母"有多长 —— 这一段按拼音比
    let prefixLen = 0;
    if (ASCII_LETTER.test(value)) {
        for (let i = 0; i < value.length; i++) {
            if (ASCII_LETTER.test(value[i])) prefixLen = i + 1;
            else break;
        }
    }

    const needle = value.toUpperCase();
    return list.filter((item) => {
        let haystack = item.name;
        if (prefixLen > 0 && !ASCII_LETTER.test(haystack)) {
            haystack = usePinYin(item.name.slice(0, prefixLen))[0] + item.name.slice(prefixLen);
        }
        return haystack.toUpperCase().includes(needle);
    });
}
