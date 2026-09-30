/**
 * 管理助手 · 路由工厂
 * ===========================================================================
 * 用依赖注入（sendJson / dataDir）而不是从 server/index.ts import，避免循环引用：
 * server/index.ts import 本模块拿路由、本模块 import server/index.ts 拿 sendJson，
 * 会形成环。所以把 sendJson 当参数传进来。
 *
 * 路由经 server/index.ts 的 `route()` 咽喉点注册 → 自动受 token 校验与统一兜底。
 * ⚠️ `route()` 是**精确匹配 pathname**（`server/index.ts:1106`），不支持 `/:id` 这类
 * 路径参数 —— 所以任务 id 一律走 query（`?id=`），不要往下加路径段。
 *
 *   GET    /assistant/rules     列出规则
 *   POST   /assistant/rules     新增/更新一条规则（body = SiteRule）
 *   DELETE /assistant/rules?id= 删除一条规则
 *   POST   /assistant/dryrun    单站试跑：{ siteId, query } → 抽出字段（不写盘）
 *   POST   /assistant/scan      找缺封面：{ serial, relPath } → 待补目标（**零读盘**）
 *   POST   /assistant/jobs      起长任务：{ kind, … } → { jobId }
 *   GET    /assistant/jobs      读进度：?id= → 单个快照；不带 id → 列表
 *   DELETE /assistant/jobs?id=  取消任务
 *   POST   /assistant/apply     写盘：{ serial, jobId }（把 grab job 的命中行写进盘）
 *
 * 长任务分三段的原因见 jobs.ts 顶部。**扫描（scan）不走 job**：
 * 它只读内存里的 nedb，快，且结果要立刻给用户看。
 */
import type http from 'node:http';
import { applyQueryTransform, buildExtractScript, deleteRule, loadRules, saveRule } from './rules';
import type { ExtractedFields, SiteRule } from './rules';
import { passChallenge, runExtract } from './siteFetch';
import { runGrab } from './grab';
import type { GrabRow } from './grab';
import { bumpProgress, cancelJob, createJob, finishJob, getJob, listJobs, snapshotJob } from './jobs';
import type { Job } from './jobs';
import { runApply, readWrittenDirs, download } from './apply';
import type { ApplyRow } from './apply';
import { scanMissingCovers, deepScanMissingCovers } from './scan';
import type { ScanTarget } from './scan';

type ReqLike = http.IncomingMessage & { params?: URLSearchParams; body?: any };
type SendJson = (res: http.ServerResponse, body: unknown, status?: number) => void;

export interface AssistantDeps {
    sendJson: SendJson;
    /** 数据目录（config.userBasePath，即 ~/.file-finder） */
    dataDir: string;
}

export type AssistantRoute = [string, (req: ReqLike, res: http.ServerResponse) => unknown];

export function createAssistantRoutes(deps: AssistantDeps): AssistantRoute[] {
    const { sendJson, dataDir } = deps;

    async function listRules(_req: ReqLike, res: http.ServerResponse) {
        sendJson(res, { code: 200, rules: await loadRules(dataDir) });
    }

    async function upsertRule(req: ReqLike, res: http.ServerResponse) {
        const rule = req.body as SiteRule | undefined;
        if (!rule || !rule.id || !rule.detailUrl) {
            sendJson(res, { code: 400, error: '缺少 rule.id / rule.detailUrl' });
            return;
        }
        sendJson(res, { code: 200, rules: await saveRule(dataDir, rule) });
    }

    async function removeRule(req: ReqLike, res: http.ServerResponse) {
        const id = req.params?.get('id') || '';
        if (!id) {
            sendJson(res, { code: 400, error: '缺少 id' });
            return;
        }
        sendJson(res, { code: 200, rules: await deleteRule(dataDir, id) });
    }

    async function dryRun(req: ReqLike, res: http.ServerResponse) {
        const body = (req.body || {}) as { siteId?: string; query?: string };
        const { siteId, query } = body;
        if (!siteId || !query) {
            sendJson(res, { code: 400, error: '缺少 siteId / query' });
            return;
        }
        const rule = (await loadRules(dataDir)).find(r => r.id === siteId);
        if (!rule) {
            sendJson(res, { code: 404, error: `未知站点：${siteId}` });
            return;
        }
        const q = applyQueryTransform(query, rule.queryTransform);
        const url = rule.detailUrl.replace('{q}', encodeURIComponent(q));
        const result = await runExtract<ExtractedFields>(url, buildExtractScript(rule.fields));
        sendJson(res, {
            code: 200,
            url,
            ok: result.ok,
            cf: result.cf,
            err: result.err ?? null,
            fields: result.data ?? null,
        });
    }

    /** 找缺封面：只读缓存，不碰盘，所以直接同步返回结果（不走 job） */
    async function scan(req: ReqLike, res: http.ServerResponse) {
        const body = (req.body || {}) as { serial?: string; relPath?: string };
        if (!body.serial) {
            sendJson(res, { code: 400, error: '缺少 serial（盘序列号，见 /getDisks）' });
            return;
        }
        const result = await scanMissingCovers(body.serial, body.relPath || '');
        sendJson(res, { code: 200, ...result });
    }

    async function startJob(req: ReqLike, res: http.ServerResponse) {
        const body = (req.body || {}) as {
            kind?: string;
            serial?: string;
            relPath?: string;
            siteIds?: string[];
            targets?: ScanTarget[];
            url?: string;
            siteId?: string;
        };

        if (body.kind === 'challenge') return startChallenge(body, res);
        if (body.kind === 'apply') return startApply(body, res);
        if (body.kind !== 'grab') {
            sendJson(res, { code: 400, error: `未知任务类型：${body.kind ?? '(空)'}` });
            return;
        }
        return startGrab(body, res);
    }

    async function startGrab(
        body: { serial?: string; relPath?: string; siteIds?: string[]; targets?: ScanTarget[] },
        res: http.ServerResponse,
    ) {
        // 同一时刻只允许一个抓取任务。重复点击起第二个只会多一条进度条、
        // 而且两条都在同一个串行队列里排队 —— 直接把已有任务还给前端，让它挂上去。
        const running = listJobs().find(j => j.kind === 'grab' && j.status === 'running');
        if (running) {
            sendJson(res, { code: 409, error: '已经有一个抓取任务在跑', jobId: running.id });
            return;
        }

        const targets = body.targets?.length
            ? body.targets
            : body.serial
              ? (await scanMissingCovers(body.serial, body.relPath || '')).targets
              : [];
        if (!targets.length) {
            sendJson(res, { code: 200, jobId: null, total: 0, message: '没有找到缺封面的视频' });
            return;
        }

        const rules = await loadRules(dataDir);
        // 前端点名了站点就按点名的来（并强制启用）；没点名就用规则里已启用的
        const picked = body.siteIds?.length
            ? rules.filter(r => body.siteIds!.includes(r.id)).map(r => ({ ...r, enabled: true }))
            : rules;

        const job = createJob<GrabRow>('grab', targets.length);
        void runGrab(targets, picked, job, dataDir);
        sendJson(res, { code: 200, jobId: job.id, total: targets.length });
    }

    /**
     * 写盘：把一个已完成 grab job 里的命中结果真正写进盘。
     * 输入 `{serial, jobId, picks?}` —— 封面 URL 在 grab 行里，不信任前端转发的第二份；
     * `picks` 是确认弹窗勾选的 writeRel 白名单（不传 = 全写）。
     */
    async function startApply(body: { serial?: string; jobId?: string; picks?: string[] }, res: http.ServerResponse) {
        if (!body.serial) {
            sendJson(res, { code: 400, error: '缺少 serial' });
            return;
        }
        const grabJob = body.jobId ? getJob(body.jobId) : undefined;
        if (!grabJob || grabJob.kind !== 'grab') {
            sendJson(res, { code: 404, error: '找不到这个抓取任务（任务可能在内存里被回收了，重新抓一次）' });
            return;
        }
        if (grabJob.status === 'running') {
            sendJson(res, { code: 409, error: '抓取还没跑完，等它结束再写入' });
            return;
        }
        // 只写命中的行。`ok` 行可能因为番号 memo 有重复（同一部片多个分卷共用一张），
        // 那是刻意的：每个 writeRel 都要有自己的文件。
        const rows = (grabJob.rows as GrabRow[]).filter(r => r.status === 'ok' && r.coverUrl);
        if (!rows.length) {
            sendJson(res, { code: 200, jobId: null, total: 0, message: '没有可写入的封面（这一批没有命中）' });
            return;
        }

        // 同一时刻只允许一个写盘任务 —— 它真的在动移动硬盘，更不能并发
        const running = listJobs().find(j => j.kind === 'apply' && j.status === 'running');
        if (running) {
            sendJson(res, { code: 409, error: '已经有一个写入任务在跑', jobId: running.id });
            return;
        }

        const job = createJob<ApplyRow>('apply', rows.length);
        void runApply(body.serial, rows, job, dataDir, body.picks);
        sendJson(res, { code: 200, jobId: job.id, total: rows.length });
    }

    async function startChallenge(body: { url?: string; siteId?: string }, res: http.ServerResponse) {
        const running = listJobs().find(j => j.kind === 'challenge' && j.status === 'running');
        if (running) {
            sendJson(res, { code: 409, error: '已经有一个验证窗口开着', jobId: running.id });
            return;
        }

        let url = body.url || '';
        if (!url && body.siteId) {
            const rule = (await loadRules(dataDir)).find(r => r.id === body.siteId);
            if (!rule) {
                sendJson(res, { code: 404, error: `未知站点：${body.siteId}` });
                return;
            }
            // cf_clearance 是**按主机**发的，所以拿站点根地址去挑战就够了
            try {
                url = `${new URL(rule.detailUrl.replace('{q}', '')).origin}/`;
            } catch {
                url = '';
            }
        }
        if (!url) {
            sendJson(res, { code: 400, error: '缺少 url 或 siteId' });
            return;
        }

        const job = createJob<unknown>('challenge', 1);
        void runChallenge(url, job);
        sendJson(res, { code: 200, jobId: job.id, url });
    }

    async function runChallenge(url: string, job: Job) {
        try {
            bumpProgress(job, { current: '等待你在弹出的窗口里完成验证…' });
            const r = await passChallenge(url, job.controller.signal);
            if (r.ok) {
                bumpProgress(job, { processed: 1, hits: 1 });
                finishJob(job, 'done', '验证已通过，之后的抓取会自动复用');
            } else if (r.timeout) {
                finishJob(job, 'error', '等太久还没通过，可以再试一次');
            } else {
                finishJob(job, 'cancelled', '验证窗口被关闭');
            }
        } catch (e) {
            finishJob(job, 'error', e instanceof Error ? e.message : String(e));
        }
    }

    function readJobs(req: ReqLike, res: http.ServerResponse) {
        const id = req.params?.get('id') || '';
        if (id) {
            const job = getJob(id);
            if (!job) {
                sendJson(res, { code: 404, error: '任务不存在或已被回收' }, 404);
                return;
            }
            sendJson(res, { code: 200, job: snapshotJob(job) });
            return;
        }
        sendJson(res, { code: 200, jobs: listJobs().map(snapshotJob) });
    }

    function removeJob(req: ReqLike, res: http.ServerResponse) {
        const id = req.params?.get('id') || '';
        if (!id) {
            sendJson(res, { code: 400, error: '缺少 id' });
            return;
        }
        sendJson(res, { code: 200, cancelled: cancelJob(id) });
    }

    /**
     * 深度重扫（**零抽帧**，用户 2026-09-25 拍板）：把 apply.log 里写过的层用
     * **纯 readdir+stat 的实时清单**替换掉缓存里的旧貌，再跑同一套"找没封面"规则。
     * 不生成缩略图、不抽帧、**不写缓存** —— 缓存永远只由 scanAndCache 这一条入口管。
     * 盘不在线时 refreshed=0，结果退化为普通缓存扫描。
     */
    async function deepScan(req: ReqLike, res: http.ServerResponse) {
        const body = (req.body || {}) as { serial?: string; relPath?: string };
        if (!body.serial) {
            sendJson(res, { code: 400, error: '缺少 serial（盘序列号，见 /getDisks）' });
            return;
        }
        const dirs = await readWrittenDirs(dataDir, body.serial);
        const result = await deepScanMissingCovers(body.serial, body.relPath || '', dirs);
        sendJson(res, { code: 200, ...result });
    }

    /**
     * 封面预览代理（GET，`?url=`）：渲染层直接 <img> 外站图片会被防盗链拦
     * （真机 2026-09-25），而写盘走的是带 session 的 Chromium 下载 —— 预览改走
     * **同一条通道**，预览能显示的就一定能写入，所见即所得。
     * 带 100 条的 FIFO 内存缓存：面板重渲染时同一张图不重复出网。
     */
    const previewCache = new Map<string, { buf: Buffer; type: string | null }>();

    async function preview(req: ReqLike, res: http.ServerResponse) {
        const raw = req.params?.get('url') || '';
        let parsed: URL;
        try {
            parsed = new URL(raw);
        } catch {
            sendJson(res, { code: 400, error: 'url 不合法' }, 400);
            return;
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            sendJson(res, { code: 400, error: '只支持 http/https' }, 400);
            return;
        }

        const cached = previewCache.get(raw);
        if (cached) {
            res.writeHead(200, { 'Content-Type': cached.type || 'image/jpeg', 'Content-Length': cached.buf.length });
            res.end(cached.buf);
            return;
        }

        const timeout = AbortSignal.timeout(20_000);
        try {
            const r = await download(raw, timeout);
            if (r.status !== 200 || !r.buf.length) {
                sendJson(res, { code: 404, error: `取不到预览图（HTTP ${r.status}）` }, 404);
                return;
            }
            // 上游给的 content-type 可能带 charset 之类的尾巴，只留主类型
            const type = r.type?.split(';')[0]?.trim() || 'image/jpeg';
            if (previewCache.size >= 100) {
                previewCache.delete(previewCache.keys().next().value as string);
            }
            previewCache.set(raw, { buf: r.buf, type });
            res.writeHead(200, { 'Content-Type': type, 'Content-Length': r.buf.length });
            res.end(r.buf);
        } catch {
            sendJson(res, { code: 502, error: '预览图下载失败' }, 502);
        }
    }

    return [
        ['/assistant/rules', (req, res) => {
            const method = req.method?.toUpperCase();
            if (method === 'GET') return listRules(req, res);
            if (method === 'POST') return upsertRule(req, res);
            if (method === 'DELETE') return removeRule(req, res);
            return sendJson(res, { code: 405, error: 'method not allowed' }, 405);
        }],
        ['/assistant/dryrun', (req, res) => {
            const method = req.method?.toUpperCase();
            if (method === 'POST') return dryRun(req, res);
            return sendJson(res, { code: 405, error: 'method not allowed' }, 405);
        }],
        ['/assistant/scan', (req, res) => {
            const method = req.method?.toUpperCase();
            if (method === 'POST') return scan(req, res);
            return sendJson(res, { code: 405, error: 'method not allowed' }, 405);
        }],
        ['/assistant/apply', (req, res) => {
            const method = req.method?.toUpperCase();
            // 这是**专用端点**，不走 startJob 的 kind 分发 —— /assistant/jobs 才需要 kind。
            // 曾经错接到 startJob 上：apply 的 body 只有 {serial, jobId} 没有 kind，
            // 落进分发器就报"未知任务类型：(空)"。端点自己就是类型，别再绕一层。
            if (method === 'POST') return startApply(req.body || {}, res);
            return sendJson(res, { code: 405, error: 'method not allowed' }, 405);
        }],
        ['/assistant/rebuild', (req, res) => {
            const method = req.method?.toUpperCase();
            if (method === 'POST') return deepScan(req, res);
            return sendJson(res, { code: 405, error: 'method not allowed' }, 405);
        }],
        ['/assistant/preview', (req, res) => {
            const method = req.method?.toUpperCase();
            if (method === 'GET') return preview(req, res);
            return sendJson(res, { code: 405, error: 'method not allowed' }, 405);
        }],
        ['/assistant/jobs', (req, res) => {
            const method = req.method?.toUpperCase();
            if (method === 'POST') return startJob(req, res);
            if (method === 'GET') return readJobs(req, res);
            if (method === 'DELETE') return removeJob(req, res);
            return sendJson(res, { code: 405, error: 'method not allowed' }, 405);
        }],
    ];
}
