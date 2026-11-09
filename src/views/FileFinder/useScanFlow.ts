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
import { ref } from 'vue';
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

export function useScanFlow(deps: ScanFlowDeps) {

    /**
     * 批量扫描「这一片」（P1）。两个入口共用它，`rescan` 是唯一差别：
     *   · 「补全这一片」→ 只扫还没缓存的目录
     *   · 「重读这一片」→ 忽略缓存，整片重读一遍
     *
     * 一句话：把「还没缓存的目录」排队扫完 —— 串行、可取消、带进度、每批让一次。
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
    const fetchScanContext = async (targetDrive?: string, targetRootRel?: string) => {
        const disks = await getAction(`${API_BASE}/getDisks`);
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
    const startScan = async (rescan: boolean) => {
        const root = deps.currentPath.value;
        if (!root || scanning.value) return;

        scanning.value = true;
        scanCancelled = false;
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
        scanPending.value = 1;
        let processed = 0;

        const rootParts = splitDrive(root);
        const rootDrive = rootParts?.drive;
        const rootRel = rootParts?.relPath ?? '';
        const visitedRel = new Set<string>();
        const failedPrefixes: string[] = [];

        try {
            const { serialOf, keys, subtreeRecords } = await fetchScanContext(rootDrive, rootRel);
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

                const dir = queue.shift()!;
                // +1：正在扫的这个也算"待扫"，否则会短暂显示成"待扫 0"
                scanPending.value = queue.length + 1;

                try {
                    // 补全模式不带 noCache：命中缓存时服务端只回缓存，不碰盘
                    let items = await requestFolder(dir, rescan);
                    const dirParts = splitDrive(dir);
                    if (dirParts) {
                        visitedRel.add(dirParts.relPath);
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
                    if (!rescan && !retried.has(dir.toLowerCase())
                        && items.some(it => (it.thumb || it.avatar) && !it.previewReady)) {
                        retried.add(dir.toLowerCase());
                        items = await requestFolder(dir, true);
                        retouched = true;
                    }

                    const key = keyOf(dir);
                    if (rescan || key === null || !keys.has(key)) scanDone.value += 1;

                    for (const item of items) {
                        // 只认 `type`：是不是目录由服务端用 stat 判定过，不靠名字里有没有点猜
                        if (item.type !== 'folder') continue;

                        // 成环保护：见过的不再入队（见上面 visited）
                        const child = deps.fullPathOf(item);
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
            deps.notify('error', rescan ? '重读失败' : '补全失败', String(err));
        } finally {
            scanning.value = false;
            // 退场时把"正在取消"一起清掉：否则下次开扫前那几百毫秒里，
            // 状态条会先按"正在取消"的样子闪一下
            cancelling.value = false;
            scanPending.value = 0;

            // 「重读这一片」扫的恰好包含**你正在看的这一层** —— 不刷一下的话网格还是旧的，
            // 看起来像"这个按钮没生效"。
            // ⚠️ 这里**不带 noCache**：刚写好的新缓存就在库里，再真读一次盘是纯浪费，
            // 而"少碰移动硬盘"是这一整批的硬要求。补全模式下当前层本来就有缓存、不会变，所以不刷。
            // 「为了补大图而真扫过」也算内容变了 —— 当前屏不刷一下就看不到新的大图
            if (rescan || retouched) deps.refreshScreen();
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


    return { scanning, scanDone, scanPending, cancelling, glow, glowKey, startScan, onScanCancel };
}
