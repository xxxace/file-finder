/**
 * 管理助手 · 文件名解析 / 演员名归一化（纯函数，可单测）
 * ===========================================================================
 * 对应 PRD AC-2：把影片文件名解析成番号，分卷（CD1/CD2/part）归一到同一基础名，
 * 这样大片切成 3 份时只抓 1 次封面、共用一张。
 */

export interface ParsedName {
    /** 归一化后的番号，如 TST-218；抽不到则为 '' */
    id: string;
    /** 用于分组的基名（有番号用番号，否则用清洗后的原串） */
    base: string;
    /** 分卷号（CD1/part2/… 抽出则 >0） */
    part?: number;
}

/**
 * 番号识别：**有序候选模式**，不是一条万能正则。
 *
 * ⚠️ 这里曾经是一条 `([A-Za-z]{2,7})[-_ ]?(\d{2,6})`，2026-09-25 真机自测把它打穿了
 * （实测 **13/20**，而 AC-2 要求 ≥18/20）。两类错出自同一条正则：
 *
 *   ① `[-_ ]?` 把分隔符做成**可选** → "英文词 + 数字"的连写被误判成番号：
 *        `tst26 - 示例片商` → `TST-26`、`tst64 - 示例片商` → `TST-64`。
 *        这些根本不是番号，于是拿着一个不存在的号去站点白搜一遍；
 *        更坏的是万一那个号真实存在，就会**写错封面**（PRD 最在意的"误配"）。
 *   ② 字母段只吃纯字母 → FC2 / 数字开头系列被**从中间截断**：
 *        `FC2-PPV-1000001` → `PPV-100000`、`200GANA-1001` → `GANA-1001`、
 *        `1PONDO-100001_001` → `PONDO-100001`。
 *        这些是**真实存在**的番号，截断后必然搜不到 —— 对外表现为"抓不到封面"，
 *        用户完全看不出根因其实是"名字没解析对"。
 *
 * 修法：把"番号长什么样"显式列成**候选链**（和站点字段抽取同一思路，见 `rules.ts`），
 * 一条不中试下一条。顺序有意义：FC2 必须排在通用模式**前面**，否则又会被截成 `PPV-xxx`。
 *
 * 关于**连写（没有任何分隔符）**：`SSIS001` 这类一律**不识别**。
 * 因为没法把 `SSIS001`（真番号）和 `tst26`/`tst64`（作品名+序号）从形式上分开 ——
 * 唯一可用的区分信号是大小写，而 Windows 文件名的大小写不可靠。
 * 两侧代价不对称：**误判成番号 → 白搜 + 可能写错封面**；漏判 → 进"认不出番号"清单，
 * 用户可手动填，**零破坏**。所以按 PRD §9「解析失败进待处理，不自动写」取保守解：**宁可漏，不可错**。
 */
const ID_PATTERNS: { re: RegExp; build: (m: RegExpMatchArray) => string }[] = [
    // ① FC2 系列（多段，必须先于通用模式）：FC2-PPV-1234567 / FC2PPV-1234567
    { re: /\bFC2[-_ ]?PPV[-_ ]?(\d{3,8})(?![0-9A-Za-z])/i, build: m => `FC2-PPV-${m[1]}` },
    // ② 通用：字母段（允许 0–3 位数字前缀，覆盖 1PONDO / 200GANA）+ **必需的分隔符** + 数字段
    {
        re: /\b(\d{0,3}[A-Za-z]{2,8})[-_ ](\d{2,6})(?![0-9A-Za-z])/,
        build: m => `${m[1].toUpperCase()}-${m[2]}`,
    },
];

/**
 * 尾部用 `(?![0-9A-Za-z])` 而不是 `\b`：**下划线是词字符**，用 `\b` 会让
 * `1PONDO-100001_001` 这条整句匹配失败（数字段后面跟 `_` 时不构成词边界）。
 */
function extractId(s: string): string {
    for (const p of ID_PATTERNS) {
        const m = s.match(p.re);
        if (m) return p.build(m);
    }
    return '';
}

/**
 * 从文件基础名（不含扩展名）解析番号与分卷。
 * 例：
 *   'TST-218'                -> { id:'TST-218', base:'TST-218' }
 *   'TST-218-CD1'            -> { id:'TST-218', base:'TST-218', part:1 }
 *   '[javbus] abp-123 4K'     -> { id:'ABP-123', base:'ABP-123' }
 *   'FC2-PPV-1000001'         -> { id:'FC2-PPV-1000001' }        （多段，见 ①）
 *   '1PONDO-100001_001'       -> { id:'1PONDO-100001' }          （数字前缀，见 ②）
 *   'tst26 - 示例片商'   -> { id:'' }                        （连写 + 无番号 → 不识别）
 *   '无番号的片子'             -> { id:'', base:'无番号的片子' }
 *
 * ⚠️ 凡改动这条链路，先跑 `node docs/probes/parse-title/run.mjs`（20 例，含真机日志里的真实文件名）。
 */
export function parseTitle(fileBase: string): ParsedName {
    let s = fileBase.trim();
    // 去常见包裹符号与多余空格
    s = s.replace(/[[\]()【】]/g, ' ').replace(/\s+/g, ' ').trim();

    // 先剥分卷后缀（在抽番号之前，避免 part 数字被当成番号数字）
    let part: number | undefined;
    const partMatch = s.match(/[-_ ]?(?:cd|part|disc|disk)\s*([0-9]{1,2})$/i) || s.match(/[-_ ]([0-9])$/);
    if (partMatch && partMatch.index !== undefined) {
        part = Number(partMatch[1]);
        s = s.slice(0, partMatch.index).trim();
    }

    const id = extractId(s);
    const base = id || s.toUpperCase();
    return { id, base, part };
}

/** 演员名归一化：去空白/间隔号/标点并小写，用于"同名聚合" */
export function normalizeActorName(name: string): string {
    return name
        .replace(/[\s\u3000]+/g, '')
        .replace(/[·・.,，。!！?？~～\-—–_/\\()（）]/g, '')
        .toLowerCase();
}
