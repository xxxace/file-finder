/**
 * 批量扫描「这一片」—— 队列、串行让出、软取消、进度、动效。
 *
 * 硬件前提（不可改）：2.5″ 移动盘铭牌 5V/1A，USB 3.0 只给 0.9A ⇒ 必须**串行**、每批让出，
 * 否则长时间连续读会掉压掉盘（docs/UPGRADE-PLAN-2026-09-24.md §1.3）。
 *
 * ⚠️ 这里**绝不碰** dataSource / loading / loadingBar：那三个是"用户正在看的那一层"，
 * 后台扫到哪个目录就往那儿写一次，网格会被反复顶掉（方案 §16.1 第 1 条点名的坑）。
 * ⚠️ 与页面只通过 deps 交换：`refreshScreen` 是页面的事（它知道清单屏/目录屏怎么重取）。
 */
import { computed, ref } from 'vue';
import { API_BASE, getAction, postAction } from '@/utils/request';
import type { WiredFileInfo } from '../../../electron/server/index';
import type { OpenMode } from 'electron/server/nedb';
import type { OverlayKind } from '@/components/Overlay/store';

export interface ScanFlowDeps {
    currentPath: { readonly value: string };
    notify: (type: OverlayKind, title?: string, message?: string) => void;
    /** 扫描改了内容之后重取当前屏（页面实现：走 loadScreen 唯一出口） */
    refreshScreen: () => void;
    /** 条目的磁盘全路径（"name + ext" 那条规则归页面，不在这里再写一份） */
    fullPathOf: (item: WiredFileInfo) => string;
}

/** 绝对路径拼接（只用于把"缓存里的子目录名"变成待探测的路径，不参与下发给渲染层） */
const joinAbs = (base: string, name: string) =>
    `${base.replace(/[\\/]+$/, '')}${/[\\]/.test(base) ? '\\' : '/'}${name}`;

/** 三种扫描。见 `startScan` 的注释 */
export type ScanMode = 'update' | 'reload' | 'fill';

export function useScanFlow(deps: ScanFlowDeps) {
    /**
     * 批量扫描「这一片」（P1）。三个入口共用它，`mode` 是唯一差别：
     *   · `'update'`「更新读取」→ 当前层逐条精准比对；其余层先探测（每层 1 次 stat），变了才真读
     *   · `'reload'`「重新读取」→ 忽略缓存，整片每层都真读（改名/大改之后的兜底）
     *   · `'fill'`  → 已废弃的「补全这一片」，只为兼容旧调用点保留：整片缓存优先
     *
     * 一句话：把「还没缓存 / 已经变了的目录」排队扫完 —— 串行、可取消、带进度、每批让一次。
     *
     * ⚠️ 为什么 `'update'` 的当前层**总是**真读（noCache）：目录 mtime 只在"条目增删改名"时变，
     *    就地覆盖同名文件（重新下一个同名片）它是不动的。而当前层是用户此刻正盯着的那一层，
     *    盲区只在这一层被察觉 ⇒ 把"逐条 stat 对比"这份贵活儿只花在这里，其它层用便宜的 mtime。
     *
     * 为什么要有它：目标树是「80+ 子目录、还嵌套、合计 500–1000 部片子」，一个个点开不现实。
     * 但"主动读"必须**串行 + 分批** —— 这不是性能优化，是硬件保护：2.5″ 移动盘铭牌
     * 5V/1A，而 USB 3.0 口只有 0.9A，长时间连续读最容易掉压掉盘
     * （见 docs/UPGRADE-PLAN-2026-09-24.md §1.3）。
     *
     * ⚠️ 下面这一整块**绝不碰** `dataSource` / `loading` / `loadingBar`。那三个是
     * "用户眼下正在看的这一层"的状态；后台扫到哪个目录就往那里写一次，用户眼前的网格
     * 会被扫过的目录反复顶掉（方案 §16.1 第 1 条点名的坑）。
     */

    /** 扫描一律用 cover 模式：界面三条入口（选文件夹 / 缓存记录 / 网格下钻）全都用 cover */
    const SCAN_MODE: OpenMode = 'cover';

    /**
     * 每扫这么多个目录，主动让出一次事件循环。
     * 挡住 USB 供电峰值的主力是**串行**（一次一个目录）；让出是为了别让主进程长时间
     * 不给界面机会 —— 也才有响应"取消"的窗口。
     */
    const SCAN_BATCH = 20;

    const scanning = ref(false);
    /**
     * 本轮模式。状态条据此说"已扫"还是"已检查" —— 只 `stat` 一层和真读一层是两件事，
     * 混着说就是骗人（他会拿"已扫 37 个"当成"37 个目录都被重读过"）。
     */
    const scanMode = ref<ScanMode>('fill');
    const scanVerb = computed(() => (scanMode.value === 'update' ? '检查' : '扫'));
    /** 已真扫的目录数。**缓存命中的不算** —— 那种没有碰盘 */
    const scanDone = ref(0);
    /** 待扫的目录数。**动态的**：每展开一层，新发现的子目录就加进来 */
    const scanPending = ref(0);

    /**
     * 「已经按过取消，正在等当前这个目录扫完」。
     *
     * 取消是**软取消**：只在目录边界生效（`scanCancelled` 那条注释解释了为什么不做硬中断），
     * 而一个目录在冷态移动硬盘上可能要好几个 10 秒 —— 点击之后界面上毫无动静，
     * 用户只会得出"这个按钮没用"的结论。这个状态就是用来把那段时间**说出来**的：
     * 按钮当场变「正在取消…」并置灰（防重复点），旁边补一句"当前这个目录扫完就停"。
     *
     * 它是**渲染态**（要显示），所以是 ref —— 和纯循环标志 `scanCancelled` 分工不同。
     */
    const cancelling = ref(false);

    /**
     * 取消标志。
     * 用普通变量而不是 ref：它只在这个组件的扫描循环里读写，不参与渲染，
     * 而每个目录边界都要重新读一次 —— 用 ref 只是多一层解包。
     */
    let scanCancelled = false;

    /**
     * 上一轮**正常扫完**（没取消、没出错）。
     * 页面用它决定"动效向上扫完时要不要响那一声完成音"—— 取消/失败不该有完成音。
     */
    const scanOk = ref(false);

    /**
     * 批量扫描专用的取数：**只往返，不写任何界面状态**。
     *
     * 为什么不复用 `fetchFolder`（方案 §16.1 第 1 条）：那个函数会写
     * `dataSource` / `loading` / `loadingBar`。后台每扫一个目录就写一次，
     * 用户正在看的网格会被那个目录的内容顶掉，进度条也会跟着乱闪。
     */
    const requestFolder = (path: string, noCache: boolean) =>
        getAction(`${API_BASE}/openFolder?path=${encodeURIComponent(path)}&mode=${SCAN_MODE}${noCache ? '&noCache=true' : ''}`) as Promise<WiredFileInfo[]>;

    /**
     * 把 `盘符:路径` 拆成「盘符 + 盘内相对路径」。
     *
     * 渲染层不能从 `electron/utils/driveIdentity` 导入 `splitPath` —— 那会把 `node:fs`
     * 拖进渲染层（和上面 `VIDEO_EXT_RE` 不能从 server 导入值是同一个原因），所以这里重写一份。
     */
    const splitDrive = (fullPath: string) => {
        const m = /^([A-Za-z]):[\\/]?(.*)$/.exec(fullPath);
        return m ? { drive: m[1].toUpperCase(), relPath: (m[2] || '').replace(/\\/g, '/') } : null;
    };

    /**
     * 开扫之前先取两样东西：
     *   · 已缓存集合 —— `/getHistory` 分页取全，键是 `(serial, relPath)`
     *   · 盘符 → 卷序列号 —— 缓存键里存的是序列号，盘符只是"当前挂载点"
     *
     * 拼不出序列号（UNC / 网络位置 / 虚拟盘）的目录一律当"没缓存"处理，见下面 `keyOf`。
     */
    const fetchScanContext = async (targetDrive?: string, targetRootRel?: string, refreshDisks = false) => {
        const disks = await getAction(`${API_BASE}/getDisks${refreshDisks ? '?refresh=true' : ''}`);
        const serialOf: Record<string, string> = {};
        for (const d of disks?.disks ?? []) {
            if (d.drive) serialOf[String(d.drive).toUpperCase()] = d.serial;
        }

        const keys = new Set<string>();
        const subtreeRecords: { id: string; relPath: string }[] = [];
        const targetSerial = targetDrive ? serialOf[targetDrive.toUpperCase()] : null;
        const normRoot = (targetRootRel ?? '').toLowerCase();

        const PAGE = 200;
        for (let pageNo = 1; ; pageNo++) {
            const res = await getAction(`${API_BASE}/getHistory?pageNo=${pageNo}&pageSize=${PAGE}`);
            for (const r of res?.records ?? []) {
                const normRel = (r.relPath || '').toLowerCase();
                keys.add(`${r.serial}|${r.relPath}`.toLowerCase());

                if (targetSerial && r.serial === targetSerial && r._id) {
                    const inSubtree = normRoot === ''
                        ? true
                        : (normRel === normRoot || normRel.startsWith(normRoot + '/'));
                    if (inSubtree) {
                        subtreeRecords.push({ id: r._id, relPath: r.relPath });
                    }
                }
            }
            if (!res?.records?.length || pageNo * PAGE >= (Number(res?.total) || 0)) break;
        }

        return { serialOf, keys, subtreeRecords };
    };

    /**
     * 跑一轮扫描。`rescan` 就是两个模式的**全部**差别（方案 §16.1：同一套队列多一个 flag）。
     *   · false →「补全这一片」：不带 noCache，服务端命中有缓存就只回缓存、不碰盘
     *   · true  →「重读这一片」：每层都带 noCache=true，忽略缓存重新读一遍
     *     —— 这就是"目录增删改之后"的答案，不需要去做变更检测
     *
     * ⚠️ **"跳过已缓存"这件事由服务端那一个出口保证**（`openFolder` 里的 `findCache`），
     * 上面那份集合只用来把"已扫 n"数准。不在前端"看到已缓存就跳过整个子树"是有意的：
     * 已缓存的目录下面**仍然可能有没缓存的子目录**，把子树剪掉就永远补不全。
     * （实测：某一层已缓存，而它自己下面还有 2 个子目录从未被扫过。）
     */
    const startScan = async (mode: ScanMode) => {
        const rescan = mode === 'reload';
        const root = deps.currentPath.value;
        if (!root || scanning.value) return;

        scanning.value = true;
        scanMode.value = mode;
        scanCancelled = false;
        scanOk.value = false;
        cancelling.value = false;
        scanDone.value = 0;
        glow.value = rescan ? 'rescan' : 'fill';
        glowKey.value += 1;

        // 深度优先。队列里放**完整路径** —— 服务端要的就是这个（它自己会拆成盘内相对路径）
        const queue: string[] = [root];
        /**
         * 已入过队的目录（小写归一化）。
         *
         * 防的是**目录软链 / 联接点成环**：Windows 上 `stat` 会跟进重解析点，一个指回祖先的
         * junction 会让队列无限增长。手动点时最多是用户自己点晕，批量扫就变成**永不停机**。
         * 同一目录被两条路径指到也只会扫一次 —— 这正是想要的。
         */
        const visited = new Set<string>([root.toLowerCase()]);
        /**
         * 「补全」为"缺大图"的层补一手时用：已经为它真扫过的层不再扫第二次
         * （否则"就是生成不出大图"的那些条目会让它被反复重扫）。
         */
        const retried = new Set<string>();
        /**
         * 本轮有没有"因为缺大图而真扫过"某一层 —— 有的话当前屏要重新取一次（走缓存，不碰盘）。
         */
        let retouched = false;
        /** 本轮真正重读了几层（只有 update 用得上：结束时要报"更新了几个目录"） */
        let updatedLayers = 0;
        /**
         * "因为环境不对而中止"（盘不在 / 认不出盘）。与用户按取消分开：
         * 这时已经给过一条具体原因，收尾不该再叠一句"已终止"。
         */
        let aborted = false;
        scanPending.value = 1;
        let processed = 0;

        const rootParts = splitDrive(root);
        const rootDrive = rootParts?.drive;
        const rootRel = rootParts?.relPath ?? '';
        const visitedRel = new Set<string>();
        const failedPrefixes: string[] = [];

        try {
            const { serialOf, keys, subtreeRecords } = await fetchScanContext(rootDrive, rootRel);

            /**
             * 本盘根序列号。只有同一块盘上的目录才走"探针捷径"：跨盘的（junction 指到别的盘）
             * 序列号对不上，那边直接真读，免得拿错盘的身份去查缓存。
             */
            let rootSerial = rootDrive ? serialOf[rootDrive] ?? '' : '';

            /**
             * ⚠️ 拔插之后盘符会变，而 `getDisks` 默认用启动时的缓存 ⇒ 拿不到序列号时
             * 「更新读取」会**静默退化**成"每层都真读"，读盘量直接翻十几倍，而提示语还在说
             * "核对了 N 个目录"。所以这里先强制刷一次盘表再试；仍拿不到就明确中止。
             */
            if (mode === 'update' && rootDrive && !rootSerial) {
                const retry = await fetchScanContext(rootDrive, rootRel, true).catch(() => null);
                rootSerial = retry ? retry.serialOf[rootDrive] ?? '' : '';
                if (!rootSerial) {
                    deps.notify('warning', '认不出这块盘', '盘可能刚拔插过（盘符变了）。重新插好后再试，或用「重新读取」整片重扫');
                    aborted = true;
                    return;
                }
            }
            /** abs(小写) → 探测结果。批量预取，每次请求覆盖队列里接下来的一小批 */
            const probeCache = new Map<string, { changed: boolean; missing: boolean; offline?: boolean; dirs?: string[]; needsPreview?: boolean }>();
            const PROBE_BATCH = 24;

            /**
             * 预取接下来 `PROBE_BATCH` 个目录的"变没变"。
             * 一次请求探一批（本地回环一次往返几十微秒），比每层发一次请求省得多；
             * 而每一次探测在服务端只是**一个 stat**，不是读目录内容。
             */
            const prefetchProbes = async () => {
                if (mode !== 'update' || !rootSerial) return;
                const want: { abs: string; rel: string }[] = [];
                for (const d of queue) {
                    if (d === root || probeCache.has(d.toLowerCase())) continue;
                    const p = splitDrive(d);
                    if (!p || serialOf[p.drive] !== rootSerial) continue;
                    want.push({ abs: d, rel: p.relPath });
                    if (want.length >= PROBE_BATCH) break;
                }
                if (!want.length) return;
                try {
                    const res = await postAction(`${API_BASE}/probeLayers`, {
                        serial: rootSerial, mode: 'cover', rels: want.map(w => w.rel),
                    }) as { rel: string; changed: boolean; missing: boolean; offline?: boolean; dirs?: string[]; needsPreview?: boolean }[];
                    const byRel = new Map(want.map(w => [w.rel, w.abs.toLowerCase()]));
                    for (const r of res ?? []) {
                        const abs = byRel.get(r.rel);
                        if (abs) probeCache.set(abs, r);
                    }
                } catch {
                    // 探测失败不影响正确性：没探到就走真读那条路（只是慢一点）
                }
            };

            const keyOf = (dir: string) => {
                const parts = splitDrive(dir);
                if (!parts) return null;
                const serial = serialOf[parts.drive];
                return serial ? `${serial}|${parts.relPath}`.toLowerCase() : null;
            };

            while (queue.length) {
                // 取消只在**目录边界**检查：一个目录已经开始扫就让它扫完，
                // 半途中断只会留下一个写了一半的缓存
                if (scanCancelled) break;

                await prefetchProbes();
                const dir = queue.shift()!;
                // +1：正在扫的这个也算"待扫"，否则会短暂显示成"待扫 0"
                scanPending.value = queue.length + 1;

                try {
                    const dirParts = splitDrive(dir);
                    if (dirParts) {
                        visitedRel.add(dirParts.relPath);
                    }

                    /**
                     * 「更新读取」的深层捷径：先探一次（**每层 1 次 stat**），没变就连 readdir 都不做。
                     * 子目录名单从缓存里拿（服务端 probeLayers 顺带带回来），否则"跳过这一层"
                     * 就等于"跳过整棵子树"，下面那些没缓存的层永远补不到。
                     * 当前层不走这条：目录 mtime 探不到"就地覆盖同名文件"，那一层必须逐条比对。
                     */
                    const probe = mode === 'update' && dir !== root
                        ? probeCache.get(dir.toLowerCase())
                        : undefined;

                    /** 走捷径时它的子目录（绝对路径）；null = 这一层要真读 */
                    let childPaths: string[] | null = null;
                    /** 没变但缺大图：补扫一次（旧的「补全」职责，搬到 update 里，否则那批层永远是残的） */
                    const needPreviewFix = !probe?.changed && !probe?.missing && probe?.needsPreview
                        && !retried.has(dir.toLowerCase());
                    if (needPreviewFix) retried.add(dir.toLowerCase());

                    /** 这一层是否已经计入"核对过"—— 三个分支只许数一次，数两遍进度就虚高 */
                    let counted = false;
                    if (probe?.offline) {
                        // 盘不在（或盘符映射失效）：这不是"目录删了"，别静默跳过 —— 静默跳过
                        // 会让用户看到"没有需要更新的目录"，然后只能整片重扫一遍来找真相。
                        deps.notify('warning', '这块盘现在不在线', '插好盘再点「更新读取」');
                        aborted = true;
                        break;
                    }
                    if (probe && probe.missing) {
                        scanDone.value += 1; counted = true; // 目录已经不在，不算失败，只是没东西可扫
                    } else if (probe && !probe.changed) {
                        childPaths = (probe.dirs ?? []).map(n => joinAbs(dir, n));
                        scanDone.value += 1; counted = true; // 只 stat 过，但"核对过"这件事是真的
                    }

                    if (needPreviewFix) childPaths = null; // 缺大图 ⇒ 放弃捷径，真读这一层
                    let items: WiredFileInfo[] = [];
                    if (!childPaths && !(probe && probe.missing)) {
                        updatedLayers += 1;
                        // 更新模式/重读模式在这一层都要真读；只有旧的 'fill' 才允许吃缓存
                        items = await requestFolder(dir, rescan || mode === 'update');
                    }

                    // 「补全」现在还欠一样东西：**预览大图**。
                    // 2026-10-04 图片出库那次迁移只搬得走库里已有的**缩略图**，所以迁移来的那些层
                    // 是"缩略图在、大图不在"。而补全不碰已缓存的层（那正是它省读盘的地方）⇒
                    // 不在这里补一手的话，那几层的离线大图就永远是缺的（主人 2026-10-04 实测撞上）。
                    //
                    // 所以：**这一层里有"有图但还没大图"的条目，就为它真扫一次**（带 noCache）。
                    // 代价是一次读盘，换来这一层的大图齐全；扫过之后 `previewReady` 就是 true，
                    // 下一轮补全不会再盯上它（而服务端那道闸门也会因此不再重出）。
                    // ⚠️ 每层只补一次：否则"就是生成不出大图"的那些条目会让它被反复重扫。
                    if (needPreviewFix) retouched = true;
                    if (mode === 'fill' && !retried.has(dir.toLowerCase())
                        && items.some(it => (it.thumb || it.avatar) && !it.previewReady)) {
                        retried.add(dir.toLowerCase());
                        items = await requestFolder(dir, true);
                        retouched = true;
                    }

                    // 已经数过的（探针那两支）不再数第二遍
                    const key = keyOf(dir);
                    if (!counted && (rescan || key === null || !keys.has(key))) scanDone.value += 1;

                    /** 统一的入队口：走捷径时来自缓存名单，走读盘时来自 items */
                    const children = childPaths
                        ?? items.filter(it => it.type === 'folder').map(it => deps.fullPathOf(it));
                    for (const child of children) {
                        // 成环保护：见过的不再入队（见上面 visited）
                        const norm = child.toLowerCase();
                        if (visited.has(norm)) continue;
                        visited.add(norm);
                        queue.push(child);
                    }
                } catch (err: any) {
                    // 单个目录失败不中断整轮 —— 和 readFolder 里"逐项 try/catch"同一个原则
                    console.error('[批量扫描] 目录失败:', dir, err);
                    const dirParts = splitDrive(dir);
                    if (dirParts && err?.kind !== 'notFound') {
                        failedPrefixes.push(dirParts.relPath.toLowerCase());
                    }
                }

                scanPending.value = queue.length;

                processed += 1;
                if (processed % SCAN_BATCH === 0) await new Promise(r => setTimeout(r, 0));
            }

            if (rescan && !scanCancelled && queue.length === 0) {
                const visitedRelNorm = new Set<string>();
                for (const r of visitedRel) {
                    visitedRelNorm.add(r.toLowerCase());
                }

                const orphanIds = subtreeRecords
                    .filter(rec => {
                        const normRel = (rec.relPath || '').toLowerCase();
                        if (visitedRelNorm.has(normRel)) return false;
                        if (failedPrefixes.some(fp => normRel === fp || normRel.startsWith(fp + '/'))) {
                            return false;
                        }
                        return true;
                    })
                    .map(rec => rec.id);

                if (orphanIds.length > 0) {
                    console.log(`[重读这一片] 清理已在磁盘上删除的孤儿缓存: ${orphanIds.length} 条`);
                    await postAction(`${API_BASE}/removeHistoryBatch`, { ids: orphanIds }).catch((e: unknown) => {
                        console.error('[重读这一片] 清理孤儿缓存失败:', e);
                    });
                }
            }
        } catch (err) {
            // 连已缓存集合/盘列表都取不到（服务没起来）—— 再往下扫也没意义，直接报错收工
            console.error('[批量扫描] 准备失败:', err);
            deps.notify('error', rescan ? '重新读取失败' : (mode === 'update' ? '更新读取失败' : '补全失败'), String(err));
            scanOk.value = false;
        } finally {
            scanning.value = false;
            // 退场时把"正在取消"一起清掉：否则下次开扫前那几百毫秒里，
            // 状态条会先按"正在取消"的样子闪一下
            cancelling.value = false;
            scanPending.value = 0;
            // 只有"跑到底且没人按取消"才算完成 —— 这两件事在 finally 里都还读得到
            if (!scanCancelled && !aborted) scanOk.value = true;

            /**
             * 结束回音。三个动作里**只有「刷新」不需要**：它一层、很快，改完屏幕当场就变了，
             * 屏幕本身就是回音。另外两个要跑几秒到几分钟，不说话就等于没跑
             * （主人 2026-11-10：「点了不知道有没有执行」）。
             *
             * 三种结局都要说：跑完 / 零变化 / 被取消。零变化也是一句结论，不是没反应。
             */
            if (mode !== 'fill' && !aborted) {
                const isReload = mode === 'reload';
                if (scanCancelled) {
                    deps.notify('info', '已终止',
                        `${isReload ? '重读' : '核对'}了 ${scanDone.value} 个目录，剩下的没动`);
                } else if (scanOk.value) {
                    deps.notify(
                        !isReload && !updatedLayers ? 'info' : 'success',
                        isReload
                            ? `重读了 ${updatedLayers} 个目录`
                            : (updatedLayers ? `更新了 ${updatedLayers} 个目录` : '没有需要更新的目录'),
                        isReload
                            ? `整片共 ${scanDone.value} 个目录，已按盘上实况重写`
                            : `核对了 ${scanDone.value} 个目录${updatedLayers ? `，重读 ${updatedLayers} 个` : ''}`,
                    );
                }
            }

            // 「重读这一片」扫的恰好包含**你正在看的这一层** —— 不刷一下的话网格还是旧的，
            // 看起来像"这个按钮没生效"。
            // ⚠️ 这里**不带 noCache**：刚写好的新缓存就在库里，再真读一次盘是纯浪费，
            // 而"少碰移动硬盘"是这一整批的硬要求。补全模式下当前层本来就有缓存、不会变，所以不刷。
            // 「为了补大图而真扫过」也算内容变了 —— 当前屏不刷一下就看不到新的大图
            // 更新读取也刷：当前层是**逐条比对**过的，改名/覆盖同名盘之后视图必须对上。
            // 这一下不带 noCache（读的就是刚写好的缓存），零读盘。
            if (mode !== 'fill' || retouched) deps.refreshScreen();
        }
    };

    /**
     * 取消这一轮扫描。
     *
     * 只置两个标志，不做硬中断：`scanCancelled` 给循环读（目录边界），`cancelling` 给界面读
     * （按钮当场变「正在取消…」）。真正的收尾在 `startScan` 的 finally 里统一做。
     * 只置标志的另一个原因：中途掐断一个正在写的目录会留下写了一半的缓存。
     */
    const onScanCancel = () => {
        cancelling.value = true;
        scanCancelled = true;
    }

    /**
     * 「更多」下拉的项：disabled 条件与改造前平铺按钮逐条一致，不放宽门槛。
     * 扫描中整组不可用由触发按钮的 :disabled="scanning" 挡住（下拉不弹 = 三项都点不到）。
     */
    /**
     * 扫描动效（移植自 LeiBox `transfer-glow`）。**它跟随真实扫描**：
     * `startScan` 一开就把 `glow` 置成模式名，扫描结束（scanning 变 false）后
     * 由组件自己播完退场并回调 `closed` 清掉。
     * `glowKey` 每次扫描 +1 ⇒ 上一次的退场还没播完就又点了，也是重新起一个实例。
     */
    const glow = ref<'' | 'fill' | 'rescan'>('');
    const glowKey = ref(0);


    return { scanning, scanDone, scanPending, cancelling, scanOk, glow, glowKey, startScan, onScanCancel, scanVerb };
}
