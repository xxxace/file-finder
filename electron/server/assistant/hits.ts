/**
 * 管理助手 · 番号命中缓存（跨任务、跨重启）
 * ===========================================================================
 * 解决的问题（用户 2026-09-25 真机反馈）：抓取结果原来只活在单次 job 的内存里
 * （jobs.ts 是纯内存注册表），中断 / 重启 / 关面板太久之后，抓到过的番号就得
 * **重新开窗打一遍站点** —— 又慢又增加封禁风险。
 *
 * 设计（三个刻意的简单）：
 *  1. **JSONL 追加文件**（`~/.file-finder/assistant-hits.jsonl`），一行一条命中。
 *     追加不改写、不锁文件、崩溃最多丢最后一行 —— 比"整份 JSON 读改写"健壮得多。
 *  2. **只缓存命中，不缓存失败**。失败可能是暂时性的（网络抖、CF 拦），缓存失败
 *     等于把"这次没抓到"永久化；而失败的代价（重开一次窗）是可接受的。
 *  3. **失效用墓碑**：站点图片 URL 可能永久失效（404 / 返回乱码）。apply 下载
 *     遇到这种情况就追加一条 `coverUrl: ''` 的墓碑行 —— 读的时候把它当"没命中"，
 *     下次抓取会真抓一次新 URL。**永不物理删除**（与 searchCache 的铁律同一精神：
 *     缓存层只追加，不自动清）。
 *
 * 同番号多行时**后行覆盖前行**（读时去重），所以"重新抓到新 URL"自然生效。
 */
import * as fsasync from 'node:fs/promises';
import path from 'node:path';

export interface HitRecord {
    /** 番号（parseTitle 归一化后的），如 TST-218 */
    id: string;
    hitSite: string;
    coverUrl: string;
    title: string | null;
    actresses: { name: string; link?: string }[];
    /** 命中时间（ISO）。只给人看，不参与逻辑 */
    at: string;
}

const fileName = 'assistant-hits.jsonl';
const hitsLocks = new Map<string, Promise<unknown>>();

function filePath(dataDir: string): string {
    return path.join(dataDir, fileName);
}

function withHitsLock<T>(dataDir: string, fn: () => Promise<T>): Promise<T> {
    const key = path.resolve(dataDir);
    const prev = hitsLocks.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const cleanup = () => {
        if (hitsLocks.get(key) === next) {
            hitsLocks.delete(key);
        }
    };
    hitsLocks.set(key, next);
    next.then(cleanup, cleanup);
    return next;
}

interface HitsSnapshot {
    hits: Map<string, HitRecord>;
    totalLines: number;
    exists: boolean;
}

async function readHitsSnapshot(dataDir: string): Promise<HitsSnapshot> {
    const hits = new Map<string, HitRecord>();
    let text: string;
    try {
        text = await fsasync.readFile(filePath(dataDir), 'utf8');
    } catch {
        return { hits, totalLines: 0, exists: false }; // 文件还不存在 = 还没有任何命中
    }
    let totalLines = 0;
    for (const line of text.split('\n')) {
        const s = line.trim();
        if (!s) continue;
        totalLines++;
        let rec: HitRecord;
        try {
            rec = JSON.parse(s) as HitRecord;
        } catch {
            continue; // 半截行，跳过
        }
        if (!rec?.id) continue;
        if (!rec.coverUrl) {
            hits.delete(rec.id); // 墓碑
            continue;
        }
        hits.set(rec.id, rec);
    }
    return { hits, totalLines, exists: true };
}

async function writeHitsAtomic(dataDir: string, hits: Map<string, HitRecord>): Promise<void> {
    const target = filePath(dataDir);
    await fsasync.mkdir(dataDir, { recursive: true });
    const lines = Array.from(hits.values()).map(rec => JSON.stringify(rec));
    const content = lines.length > 0 ? `${lines.join('\n')}\n` : '';
    const tmp = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    await fsasync.writeFile(tmp, content, 'utf8');
    await fsasync.rename(tmp, target);
}

function isIncomingNewer(incomingAt: string | undefined, existingAt: string | undefined): boolean {
    const incomingMs = incomingAt ? Date.parse(incomingAt) : NaN;
    if (Number.isNaN(incomingMs)) return false;
    const existingMs = existingAt ? Date.parse(existingAt) : NaN;
    return Number.isNaN(existingMs) || incomingMs > existingMs;
}

/** 读全量命中表。坏行（半截写入）跳过；墓碑行（coverUrl 为空）= 删除该番号 */
export async function loadHits(dataDir: string): Promise<Map<string, HitRecord>> {
    const { hits, totalLines } = await readHitsSnapshot(dataDir);
    if (totalLines > hits.size * 1.2 + 20) {
        await compactHits(dataDir).catch(e => {
            console.error('[assistant/hits] 自动压缩命中缓存失败:', e);
        });
    }
    return hits;
}

/** 原子去重压缩：清理重复 id 与墓碑行，仅保留每条番号最新的活跃记录 */
export async function compactHits(
    dataDir: string
): Promise<{ beforeLines: number; afterLines: number }> {
    return withHitsLock(dataDir, async () => {
        const { hits, totalLines, exists } = await readHitsSnapshot(dataDir);
        if (!exists) {
            return { beforeLines: 0, afterLines: 0 };
        }
        const afterLines = hits.size;
        if (totalLines !== afterLines) {
            await writeHitsAtomic(dataDir, hits);
        }
        return { beforeLines: totalLines, afterLines };
    });
}

/** 导出当前所有活跃（非墓碑、已去重）的命中记录 */
export async function exportActiveHits(dataDir: string): Promise<HitRecord[]> {
    const { hits } = await readHitsSnapshot(dataDir);
    return Array.from(hits.values());
}

/**
 * 合并外部命中记录：按 id 取 at 较新且非墓碑的记录，不覆盖本机更新的记录。
 * 写入通过临时文件 + rename 原子替换。
 */
export async function mergeHits(
    dataDir: string,
    incoming: HitRecord[]
): Promise<{ added: number; updated: number }> {
    const dedupedIncoming = new Map<string, HitRecord>();
    for (const rec of incoming) {
        if (!rec?.id || !rec.coverUrl) continue;
        const prev = dedupedIncoming.get(rec.id);
        if (!prev || isIncomingNewer(rec.at, prev.at)) {
            dedupedIncoming.set(rec.id, rec);
        }
    }

    return withHitsLock(dataDir, async () => {
        const { hits } = await readHitsSnapshot(dataDir);
        let added = 0;
        let updated = 0;

        for (const [id, rec] of dedupedIncoming) {
            const existing = hits.get(id);
            if (!existing) {
                hits.set(id, rec);
                added++;
            } else if (isIncomingNewer(rec.at, existing.at)) {
                hits.set(id, rec);
                updated++;
            }
        }

        if (added > 0 || updated > 0) {
            await writeHitsAtomic(dataDir, hits);
        }
        return { added, updated };
    });
}

/** 追加一条命中。fire-and-forget：写缓存失败只打日志，绝不连累抓取本身 */
export function appendHit(dataDir: string, rec: HitRecord): void {
    withHitsLock(dataDir, () =>
        fsasync.appendFile(filePath(dataDir), `${JSON.stringify(rec)}\n`, 'utf8')
    ).catch(e => {
        console.error('[assistant/hits] 写命中缓存失败:', e);
    });
}

/** 追加一条墓碑：这个番号的旧 URL 已永久失效，下次抓取重新真抓 */
export function appendTombstone(dataDir: string, id: string): void {
    appendHit(dataDir, {
        id, hitSite: '', coverUrl: '', title: null, actresses: [],
        at: new Date().toISOString(),
    });
}
