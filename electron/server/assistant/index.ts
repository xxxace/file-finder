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
 *   POST   /assistant/dryrun    单站试跑：{ siteId | rule, query, show? } → 抽出字段（不写盘）
 *   POST   /assistant/openPage  打开目标页给用户自己看（可见窗，不自动关）→ { id }
 *   POST   /assistant/windowUrl 读那个窗当前地址 + 反推入口模板
 *   POST   /assistant/pick      点选一张图 → 生成选择器（长请求，用户操作）
 *   POST   /assistant/record    录制用户的输入/点击 → 动作序列（长请求）
 *   POST   /assistant/scan      找缺封面：{ serial, relPath } → 待补目标（**零读盘**）
 *   POST   /assistant/faces     换封面：{ serial, picks } → 待换目标（**零读盘**；scan 的补集）
 *   POST   /assistant/jobs      起长任务：{ kind, … } → { jobId }
 *   POST   /assistant/jobs?id=&act=pause|resume  暂停 / 继续（保留队列与结果）
 *   GET    /assistant/jobs      读进度：?id= → 单个快照；不带 id → 列表
 *   DELETE /assistant/jobs?id=  终止任务（已产出的结果保留，可写入）
 *   POST   /assistant/apply     写盘：{ serial, jobId }（把 grab job 的命中行写进盘）
 *
 * 长任务分三段的原因见 jobs.ts 顶部。**扫描（scan）不走 job**：
 * 它只读内存里的 nedb，快，且结果要立刻给用户看。
 */
import type http from 'node:http';
import * as fsp from 'node:fs/promises';
import path from 'node:path';
import { applyQueryTransform, buildExtractScript, buildStepScript, deleteRule, loadRules, saveRule } from './rules';
import type { ExtractedFields, SiteRule } from './rules';
import { passChallenge, runExtract } from './siteFetch';
import type { PageSnapshot } from './siteFetch';
import { openVisiblePage, runSteps, visiblePageUrl } from './siteActions';
import { pickImageOnPage, recordOnPage } from './siteRecord';
import { deriveTemplate, expandUrl } from './urlTemplate';
import type { StepOutcome } from './siteActions';
import { runGrab } from './grab';
import type { GrabRow } from './grab';
import { bumpProgress, cancelJob, createJob, finishJob, getJob, listJobs, pauseJob, reopenJob, resumeJob, snapshotJob } from './jobs';
import type { Job } from './jobs';
import { loadMeta } from '../nedb';
import { runApply, readWrittenDirs, download } from './apply';
import type { ApplyRow } from './apply';
import { scanMissingCovers, deepScanMissingCovers, collectFaces } from './scan';
import type { ScanTarget, FacePick } from './scan';
import { getDrives } from '../../utils/driveIdentity';

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
        // 软校验：只挡明显写不通的规则（硬闸门「试跑通过才允许保存」在 UI 上，
        // 后端不强制 —— 否则脚本化调用与探针也会被挡住）。
        if (!/^https?:\/\//i.test(rule.detailUrl)) {
            sendJson(res, { code: 400, error: 'detailUrl 必须是 http(s) 地址' });
            return;
        }
        for (const s of rule.steps ?? []) {
            if (s.act !== 'wait' && !s.selector) {
                sendJson(res, { code: 400, error: '动作步骤缺少 selector' });
                return;
            }
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

    /**
     * 把失败现场落盘（**数据目录**，不碰移动硬盘），只留最近 5 份。
     *
     * 为什么必须给文件而不是只给一句话：界面说"被站点验证拦住了"，用户没法验证真假。
     * 有这份 HTML，挑战页（`Just a moment...` / `#challenge-form`）和正常页面一眼可分，
     * 也能直接看出"选择器到底在不在页面上"。
     */
    async function saveSnapshotFile(snap?: PageSnapshot): Promise<{
        file: string; title: string; url: string; size: number;
    } | null> {
        if (!snap) return null;
        try {
            const dir = path.join(dataDir, 'assistant', 'fail');
            await fsp.mkdir(dir, { recursive: true });
            const stamp = new Date().toISOString().replace(/[:.]/g, '-');
            const file = path.join(dir, `fail-${stamp}.html`);
            await fsp.writeFile(
                file,
                `<!-- url: ${snap.url} -->\n<!-- title: ${snap.title} -->\n${snap.html}`,
                'utf8',
            );
            const old = (await fsp.readdir(dir)).filter(f => f.startsWith('fail-')).sort();
            for (const f of old.slice(0, Math.max(0, old.length - 5))) {
                await fsp.unlink(path.join(dir, f)).catch(() => undefined);
            }
            return { file, title: snap.title, url: snap.url, size: snap.html.length };
        } catch {
            return null; // 落盘失败不能连累试跑结果
        }
    }

    async function dryRun(req: ReqLike, res: http.ServerResponse) {
        // 两种入参都支持（向后兼容 PRD §15 里那条自测命令）：
        //   { siteId, query }  试跑**已保存**的规则
        //   { rule,   query }  试跑**编辑器里的草稿**（尚未保存 ⇒ 不写盘）
        const body = (req.body || {}) as { siteId?: string; query?: string; rule?: SiteRule; show?: boolean };
        const { query } = body;
        /** 「显示窗口」：试跑时把抓取窗露出来，让用户看到访问过程（结束仍会自动关闭） */
        const show = !!body.show;
        if (!query || (!body.siteId && !body.rule)) {
            sendJson(res, { code: 400, error: '缺少 query，以及 siteId / rule 之一' });
            return;
        }
        const rule = body.rule ?? (await loadRules(dataDir)).find(r => r.id === body.siteId);
        if (!rule) {
            sendJson(res, { code: 404, error: `未知站点：${body.siteId}` });
            return;
        }
        const q = applyQueryTransform(query, rule.queryTransform);
        const url = expandUrl(rule.detailUrl, query, rule.queryTransform);
        const extract = buildExtractScript(rule.fields);
        // 试跑也必须是**可中断**的：前端点「取消」⇒ 连接断开 ⇒ 立刻销毁抓取窗。
        // 原来没接这根信号，一次试跑最长会白等到超时（用户 2026-10-22 反馈）。
        const signal = abortOnClose(res);

        // ⚠️ 有动作就必须走**动作通道**（每步只执行一次）；没有动作才走原来的幂等抽取通道。
        // 两条通道不能混：把 click 塞进 runExtract 的轮询循环会反复点击。
        const steps = rule.steps ?? [];
        if (steps.length) {
            const planned = steps.map(s => ({ act: s.act, script: buildStepScript(s, q) }));
            const r = await runSteps(url, planned, extract, { show, signal });
            const snap = r.ok ? null : await saveSnapshotFile(r.snapshot);
            if (!res.writableEnded) sendJson(res, {
                code: 200,
                url,
                ok: r.ok,
                cf: r.cf,
                err: r.err ?? null,
                fields: r.data ?? null,
                steps: r.steps,
                httpStatus: r.httpStatus ?? 0,
                pageTitle: r.pageTitle || snap?.title || '',
                snapshot: snap,
            });
            return;
        }

        const result = await runExtract<ExtractedFields>(url, extract, { show, signal });
        const snap = result.ok ? null : await saveSnapshotFile(result.snapshot);
        if (!res.writableEnded) sendJson(res, {
            code: 200,
            url,
            ok: result.ok,
            cf: result.cf,
            err: result.err ?? null,
            fields: result.data ?? null,
            steps: [] as StepOutcome[],
            httpStatus: 0,
            pageTitle: snap?.title || '',
            snapshot: snap,
        });
    }

    /**
     * 打开目标页给用户**自己研究**（可见窗，不自动关闭，用户看完自己关）。
     * 用户反馈「必须打开自己的浏览器去研究目标网站」⇒ 这件事由我们代劳，
     * 顺带两个好处：同一个 partition ⇒ 在这里过掉的验证后续抓取直接复用；
     * 用户看到的页面 = 抓取时看到的页面（不会出现"我浏览器能看、它抓不到"）。
     */
    async function openPage(req: ReqLike, res: http.ServerResponse) {
        const body = (req.body || {}) as { url?: string; rule?: SiteRule; query?: string };
        if (!body.url && !body.rule) {
            sendJson(res, { code: 400, error: '缺少 url 或 rule' });
            return;
        }
        // 传 rule 时由**后端**展开模板 —— 保证「打开看看」和真正的抓取用的是同一套拼法
        const target = body.url
            || expandUrl(body.rule!.detailUrl, body.query || '', body.rule!.queryTransform);
        const r = await openVisiblePage(target);
        sendJson(res, r.ok ? { code: 200, id: r.id } : { code: 500, error: r.err || '打不开这个地址' });
    }

    /**
     * 读某个浏览窗当前地址，并**反推入口模板**（把番号那一段换成占位符）。
     * 这就是「用户不知道 {q} 该写在地址哪里」的解法：让他先把作品页打开，我们从地址里认出来。
     */
    async function windowUrl(req: ReqLike, res: http.ServerResponse) {
        const body = (req.body || {}) as { id?: string; query?: string };
        if (!body.id) {
            sendJson(res, { code: 400, error: '缺少 id' });
            return;
        }
        const url = visiblePageUrl(body.id);
        if (!url) {
            sendJson(res, { code: 404, error: '那个窗口已经关掉了' });
            return;
        }
        const d = deriveTemplate(url, body.query || '');
        sendJson(res, { code: 200, url, ok: d.ok, template: d.template, hit: d.hit });
    }

    /** 目标地址：直接用 url，或由 rule+query 展开（前后端拼法永远一致） */
    function targetOf(body: { url?: string; rule?: SiteRule; query?: string }): string | null {
        if (body.url) return body.url;
        if (!body.rule) return null;
        return expandUrl(body.rule.detailUrl, body.query || '', body.rule.queryTransform);
    }

    /**
     * 长请求的取消信号：前端关弹窗 / 刷新页面 ⇒ 连接断开 ⇒ 立刻中止。
     * 否则那个可见窗与轮询循环会一直活到 10 分钟上限（用户已经不管了，窗口还杵在屏幕上）。
     * ⚠️ `close` 在**正常响应结束**时也会触发，所以要排除"已经写完"的情况。
     */
    function abortOnClose(res: http.ServerResponse): AbortSignal {
        const ac = new AbortController();
        res.on('close', () => {
            if (!res.writableEnded) ac.abort();
        });
        return ac.signal;
    }

    /**
     * 点选图片：开可见窗让用户点一下要抓的图，回传生成的选择器。
     * ⚠️ 这两个接口都是**长请求**（用户在窗里操作，最长 10 分钟）—— 不要给它加超时。
     */
    async function pickImage(req: ReqLike, res: http.ServerResponse) {
        const body = (req.body || {}) as { url?: string; rule?: SiteRule; query?: string };
        const target = targetOf(body);
        if (!target) {
            sendJson(res, { code: 400, error: '缺少 url 或 rule' });
            return;
        }
        const r = await pickImageOnPage(target, abortOnClose(res));
        if (!res.writableEnded) sendJson(res, { code: 200, ...r });
    }

    /** 录制动作：用户在可见窗里自己搜一次，我们把他做的「输入 / 点击」记成动作序列 */
    async function recordActions(req: ReqLike, res: http.ServerResponse) {
        const body = (req.body || {}) as { url?: string; rule?: SiteRule; query?: string };
        const target = targetOf(body);
        if (!target) {
            sendJson(res, { code: 400, error: '缺少 url 或 rule' });
            return;
        }
        const r = await recordOnPage(target, body.query || '', abortOnClose(res));
        if (!res.writableEnded) sendJson(res, { code: 200, ...r });
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

    /**
     * 从主界面选中的位置**反推这块盘的序列号**。
     *
     * 为什么需要：主界面渲染网格时手上只有路径（`H:/影片/演员A`），**拿不到序列号**
     * （那是"按盘查缓存"才需要的东西，只有服务端知道映射关系）。而换封面的清单
     * 必须按 `(serial, relPath)` 去查缓存 —— 所以这一步只能在服务端做。
     *
     * 两种形态都认：
     *   · 只读锚点 `#<serial>/…` —— **自带序列号**，直接取
     *   · 完整路径 `H:/…`       —— 取盘符，再去盘列表里换（**盘符不是身份、序列号才是**）
     *
     * ⚠️ 用 `getDrives()`（内存态）而不是实时 stat 盘符：这里只是"把盘符换成序列号"，
     * 猜错了最坏结果是查不到缓存、界面显示 0 条，**不会写错盘**（写盘那一步会再校验一次）。
     * 为这个去碰一次盘不划算。
     */
    async function serialOfPicks(picks: FacePick[]): Promise<string> {
        for (const p of picks) {
            const raw = p.dir || '';
            if (raw.startsWith('#')) {
                const rest = raw.slice(1);
                const cut = rest.indexOf('/');
                const s = cut === -1 ? rest : rest.slice(0, cut);
                if (s) return s;
            }
            const m = /^([A-Za-z]):/.exec(raw);
            if (!m) continue;
            const letter = m[1].toUpperCase();
            let drives = await getDrives();
            if (!drives.length) drives = await getDrives(true);
            const hit = drives.find(d => (d.drive || '').toUpperCase() === letter);
            if (hit?.serial) return hit.serial;
        }
        return '';
    }

    /**
     * 「换封面」：把主界面选中的位置展开成目标清单（**零读盘**，只读缓存）。
     *
     * body = `{ picks: FacePick[], serial? }` → `{ code, serial, targets }`
     *
     * 与 `/assistant/scan` 是**互补的两半**：scan 找"没有封面的"（让程序去补），
     * 这里找"有封面、但用户自己挑出来要换的"。两者的返回值形状**完全相同**
     * （都是 `ScanTarget[]`）⇒ 下游 grab / apply / 弹窗全链路零改动。
     *
     * ⚠️ 走 `picks` 而不是 `relPath`：用户在主界面里可以跨目录挑（选一个演员目录 =
     * 展开它下面全部），所以"选中的东西"是**一组位置**，不是一个范围。
     * ⚠️ `serial` 通常**不用传** —— 服务端从 picks 的路径/锚点自己反推，并把结果回给前端，
     * 前端顺手把盘选对上（多盘机器上这一步很关键：picks 来自哪块盘，界面就该查哪块）。
     */
    async function faces(req: ReqLike, res: http.ServerResponse) {
        const body = (req.body || {}) as { serial?: string; picks?: FacePick[] };
        const picks = body.picks ?? [];
        if (!picks.length) {
            sendJson(res, { code: 200, serial: body.serial ?? '', targets: [], probed: 0, received: 0 });
            return;
        }

        // ① 先按"显式给了序列号"或"从路径反推"来查 —— 快，且绝大多数情况都对
        let serial = body.serial || await serialOfPicks(picks);
        let targets = serial ? await collectFaces(serial, picks) : [];
        let probed = serial ? 1 : 0;

        // ② 兜底：推不出序列号（盘刚拔、盘符被复用、盘列表还没扫过），或者推出来的那块盘上
        //    匹配不到 —— 就**在每一块有缓存的盘上再找一遍**。
        //
        //    "这个位置在哪块盘的缓存里"是**可以直接查出来的事实**，不该因为推不出盘符就放弃。
        //    代价可控：所有盘的哈希表本来就在内存里（`loadMeta` 零读盘），一台机器也就几块盘。
        if (!targets.length) {
            const all = [...new Set((await loadMeta()).map(m => m.serial))];
            for (const s of all) {
                if (s === serial) continue;
                probed += 1;
                const t = await collectFaces(s, picks);
                if (t.length) { serial = s; targets = t; break; }
            }
        }

        // 找不到也返回 **200 + 空**（不是错误）：这是"确实没有这些东西"的正常结果。
        // `probed` / `received` 交给前端显示 —— 空态里说清"收到几个位置、查了几块盘"，
        // 用户一眼看得出是"没传过来"还是"位置没匹配上"，不用再来回猜。
        sendJson(res, { code: 200, serial: serial ?? '', targets, probed, received: picks.length });
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
            /** 只对 `kind:'grab'` 有意义：绕开命中缓存、真打站点（「换封面」用） */
            force?: boolean;
            /** 只对 `kind:'grab'` 有意义：把这一批追加到已有 job（重抓失败项用） */
            jobId?: string;
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
        body: {
            serial?: string; relPath?: string; siteIds?: string[]; targets?: ScanTarget[];
            force?: boolean;
            /** 把这一批**追加到已有 job**（重抓失败项 / 过验证后重抓） */
            jobId?: string;
        },
        res: http.ServerResponse,
    ) {
        const targets = body.targets?.length
            ? body.targets
            : body.serial
              ? (await scanMissingCovers(body.serial, body.relPath || '')).targets
              : [];

        const rules = await loadRules(dataDir);
        // 前端点名了站点就按点名的来（并强制启用）；没点名就用规则里已启用的
        const picked = body.siteIds?.length
            ? rules.filter(r => body.siteIds!.includes(r.id)).map(r => ({ ...r, enabled: true }))
            : rules;

        // ── 追加：结果必须并进同一个 job ───────────────────────────────────
        // 起新 job 会把原来命中/失败的行整批丢掉（前端的结果表、确认弹窗都是
        // `job.rows` 的函数）⇒ 重抓完成后用户之前抓到的那些会凭空消失。
        if (body.jobId) {
            const job = getJob<GrabRow>(body.jobId);
            if (!job || job.kind !== 'grab') {
                sendJson(res, { code: 404, error: '找不到那个抓取任务（可能已被回收），重新抓一次' });
                return;
            }
            if (job.status === 'running' || job.status === 'paused') {
                sendJson(res, { code: 409, error: '这个任务还在跑，先暂停或终止它再补抓' });
                return;
            }
            if (!targets.length) {
                sendJson(res, { code: 200, jobId: null, total: 0, message: '没有需要重抓的项' });
                return;
            }
            reopenJob(job);
            void runGrab(targets, picked, job, dataDir, body.force === true, true);
            sendJson(res, { code: 200, jobId: job.id, total: targets.length, appended: true });
            return;
        }

        if (!targets.length) {
            sendJson(res, { code: 200, jobId: null, total: 0, message: '没有找到缺封面的视频' });
            return;
        }

        // 同一时刻只允许一个抓取任务。重复点击起第二个只会多一条进度条、
        // 而且两条都在同一个串行队列里排队 ⇒ 把已有任务还给前端让它挂上去（200 而不是报错：
        // 前端的期望行为就是"接上正在跑的那个"，回 409 它只会弹一句看不懂的失败）。
        const running = listJobs().find(j => j.kind === 'grab' && (j.status === 'running' || j.status === 'paused'));
        if (running) {
            sendJson(res, {
                code: 200, jobId: running.id, total: running.progress.total, reused: true,
                message: running.status === 'paused' ? '这个任务正暂停着，先继续或终止它' : '',
            });
            return;
        }

        const job = createJob<GrabRow>('grab', targets.length);
        // `force` 只在「换封面」时为 true：用户已经表示"这张不好、换一张"，
        // 再去复用命中缓存就等于把同一张图拿回来（见 grab.ts 的形参注释）。
        void runGrab(targets, picked, job, dataDir, body.force === true);
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
                url = `${new URL(expandUrl(rule.detailUrl, '')).origin}/`;
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
     * 暂停 / 继续。`POST /assistant/jobs?id=<jobId>&act=pause|resume`。
     * 与「终止」（DELETE）分开：暂停不 abort、不丢结果，继续就从原地接着跑。
     */
    function controlJob(req: ReqLike, res: http.ServerResponse) {
        const id = req.params?.get('id') || '';
        const act = req.params?.get('act') || '';
        if (!id) {
            sendJson(res, { code: 400, error: '缺少 id' });
            return;
        }
        if (act !== 'pause' && act !== 'resume') {
            sendJson(res, { code: 400, error: `未知操作：${act || '(空)'}` });
            return;
        }
        const ok = act === 'pause' ? pauseJob(id) : resumeJob(id);
        // ok=false 表示它在你看这一眼的工夫已经换了状态（跑完了 / 没在跑）——
        // 不是错误，但必须如实回给前端，否则按钮会一直显示"暂停中"。
        sendJson(res, { code: 200, ok, status: getJob(id)?.status ?? '' });
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
        ['/assistant/openPage', (req, res) => {
            const method = req.method?.toUpperCase();
            if (method === 'POST') return openPage(req, res);
            return sendJson(res, { code: 405, error: 'method not allowed' }, 405);
        }],
        ['/assistant/windowUrl', (req, res) => {
            const method = req.method?.toUpperCase();
            if (method === 'POST') return windowUrl(req, res);
            return sendJson(res, { code: 405, error: 'method not allowed' }, 405);
        }],
        ['/assistant/pick', (req, res) => {
            const method = req.method?.toUpperCase();
            if (method === 'POST') return pickImage(req, res);
            return sendJson(res, { code: 405, error: 'method not allowed' }, 405);
        }],
        ['/assistant/record', (req, res) => {
            const method = req.method?.toUpperCase();
            if (method === 'POST') return recordActions(req, res);
            return sendJson(res, { code: 405, error: 'method not allowed' }, 405);
        }],
        ['/assistant/faces', (req, res) => {
            const method = req.method?.toUpperCase();
            if (method === 'POST') return faces(req, res);
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
            // 带 act 的 POST = 暂停/继续（与"起任务"共用路径，靠 query 区分 ——
            // `route()` 是精确匹配 pathname，不能再加路径段）
            if (method === 'POST' && req.params?.get('act')) return controlJob(req, res);
            if (method === 'POST') return startJob(req, res);
            if (method === 'GET') return readJobs(req, res);
            if (method === 'DELETE') return removeJob(req, res);
            return sendJson(res, { code: 405, error: 'method not allowed' }, 405);
        }],
    ];
}
