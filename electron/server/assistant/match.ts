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
 * 番号识别用**有序候选链**而非一条万能正则：FC2 必须排在通用模式前（否则被截成 `PPV-xxx`），② 之后才轮到 ③，日期型左段必须 6 位（与分卷唯一可分信号）。
 * ⚠️ 连写（`SSIS001`）一律不识别：大小写是唯一信号但 Windows 不可靠；误判 = 白搜 + 写错封面，漏判 = 零破坏 ⇒ 按 PRD §9 宁可漏不可错。
 * 放宽依据见 `docs/probes/parse-title/`（真实全库 A/B，差异集 + unmatched 聚类）。
 */
const ID_PATTERNS: { re: RegExp; build: (m: RegExpMatchArray) => string }[] = [
    // ① FC2 系列（多段，必须先于通用模式）：FC2-PPV-1234567 / FC2PPV-1234567
    { re: /\bFC2[-_ ]?PPV[-_ ]?(\d{3,8})(?![0-9A-Za-z])/i, build: m => `FC2-PPV-${m[1]}` },
    // ② 通用：字母段（首字符必须是字母，其后**允许混数字**，覆盖 X28-123 / TST2A3B-21）
    //    + **必需的分隔符** + 纯数字段（覆盖 200GANA / 1PONDO）
    {
        re: /\b(\d{0,3}[A-Za-z][A-Za-z0-9]{1,7})[-_](\d{2,6})(?![0-9A-Za-z])/,
        build: m => `${m[1].toUpperCase()}-${m[2]}`,
    },
    // ③ 数字段带**单个字母前缀**（TSK-S51 / -S01 / -C02 这类字母序号系列）
    //    ⚠️ 必须排在 ② 之后：② 认不出的才轮到这里
    {
        re: /\b([A-Za-z][A-Za-z0-9]{1,7})[-_]([A-Za-z]\d{1,5})(?![0-9A-Za-z])/,
        build: m => `${m[1].toUpperCase()}-${m[2].toUpperCase()}`,
    },
    // ④ 日期型：6 位数字 + 2~4 位序号（Caribbean / 1pondo 的 MMDDYY-NNN：991231-999）
    //    ⚠️ 左段**必须 6 位** —— 这是与分卷 `1-2` / `10-1` 唯一可分的信号，别放宽
    {
        re: /\b(\d{6})[-_](\d{2,4})(?![0-9A-Za-z])/,
        build: m => `${m[1]}-${m[2]}`,
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
 * ⚠️ 改动这条链路先跑 `node docs/probes/parse-title/run.mjs`（全绿为准）；收益/风险用 `node docs/probes/parse-title/ab.mjs` 在真实全库上量（零读盘）。
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
