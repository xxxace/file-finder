/**
 * 主界面「首页盘列表」的数据层（空白区 → 这台电脑）。
 *
 * 判据：**只读缓存聚合，零读盘**。`/getDisks` 不带 `?refresh=true` ⇒ 服务端走
 * `getDrives()` 的进程内缓存（一次盘符都不扫），`folders/covers/lastScanAt/tops`
 * 全部是已载入内存的 `metas` 上算出来的（见服务端 `listDisksController`）。
 *
 * 为什么不在这里拉 `/getHistory` 再分组：盘列表与"顶层在哪"必须是同一份数据的两个字段，
 * 否则在线/离线切换时两边地址口径（实时路径 vs 只读锚点）必然漂 —— 那正是本仓库
 * 反复吃过的那类"两个写入口"的病。服务端 `diskTops` 是唯一计算点。
 *
 * ⚠️ 卡片集合**必须**与缓存记录页顶部那排 chip 同一规则（`folders > 0`）：
 * 同一块盘在两个页面里"算不算有缓存"给出不同答案，是最难解释的那类不一致。
 */
import { computed, ref } from 'vue';
import { API_BASE, getAction } from '@/utils/request';

/** 服务端 `/getDisks` 里每块盘的一条落点（缓存记录里**最上层**的那几条之一） */
export interface DiskTop {
    relPath: string;
    name: string;
    /** 可直接进屏的地址：在线 = 实时路径，离线 = 只读锚点 */
    path: string;
    count: number;
}

/** `/getDisks` 原始行（只挑本模块要用的字段，服务端还有 root/label 等） */
interface DiskRow {
    serial: string;
    drive: string;
    label: string;
    online: boolean;
    folders: number;
    /** ⚠️ 历史包袱名：它是**条目数**（服务端把每条记录的 count 累加），不是"封面数" */
    covers: number;
    lastScanAt: string;
    /** 上次真的探到这块盘的时间（服务端注册表；从没点过「刷新」时为空串） */
    lastSeenAt?: string;
    tops?: DiskTop[];
}

/** 卡片模型 —— 模板里零计算，名字/时间的格式化只在这里做一次 */
export interface HomeDisk {
    /** `serial|drive`：克隆盘会有一对同 serial 的盘符，key 不带盘符就重复了 */
    key: string;
    serial: string;
    /** 在线：`H:`；离线：`序列号 后四位` */
    name: string;
    online: boolean;
    folders: number;
    entries: number;
    /** 卡片第三行那一句（时间信息）。**在数据层拼好**，模板里零分支 —— 见 `timeLineOf` */
    timeLine: string;
    tops: DiskTop[];
}

/** `/getDisks` 回来的原始结构（只声明本模块用到的两项） */
interface DisksPayload {
    disks?: DiskRow[];
}

/**
 * 时间戳：只留 `MM-DD`（卡片上日期比分钟有用；精确到分反而占宽度）。
 * 不引 dayjs —— 这个页面上它是纯展示，少一个依赖比"格式统一"更值钱。
 */
function shortDate(t?: string): string {
    return t && t.length >= 10 ? t.slice(5, 10) : '';
}

/**
 * 卡片第三行。
 *
 * 在线盘：**上次扫描**（缓存里的时间，精确到天 —— 卡片上分钟没有用，还占宽度）。
 * 离线盘：**上次插入**（注册表的 lastSeenAt）。业主 2026-11-11 明确不要那句
 * 「未插入 · 缓存可看」—— 那不是信息，是替他解释；他要的是"这块盘我上次是什么时候插的"。
 * ⚠️ 从没点过「刷新」时 `lastSeenAt` 是空串（注册表只在 `?refresh=true` 时登记）
 *    ⇒ 退回「上次扫描」。标签跟着字段走，不硬套一个"上次插入"去说谎。
 */
function timeLineOf(d: DiskRow): string {
    const scan = shortDate(d.lastScanAt);
    if (d.online) return scan ? `上次扫描 ${scan}` : '';
    /**
     * 离线盘：取「上次探到它」与「上次扫过它」里**较晚**的那个。
     *
     * ⚠️ 为什么不直接写「上次插入」：`lastSeenAt` 只在 `/getDisks?refresh=true`（缓存记录页
     * 那颗刷新）时才登记，从没点过刷新就永远停在上一次 —— 拿它当"插入时间"会说谎。
     * `lastScanAt` 随每次扫描更新，两者取最晚 = 这块盘**最后一次真的在这台机器上被用到**。
     * ⇒ 标签写「上次使用」：既是他想知道的那件事，又不假装知道"什么时候插上的"。
     * ⚠️ `MM-DD` 字符串比较等于时间比较 —— 前提是同年；跨年那一条只差一个数，不值得为它引日期库。
     */
    const latest = [scan, shortDate(d.lastSeenAt)].filter(Boolean).sort().pop() || '';
    return latest ? `上次使用 ${latest}` : '';
}

export function useHomeDisks() {
    const disks = ref<HomeDisk[]>([]);
    /** 第一次响应回来之前保持 false —— 首页据此**不渲染**，避免闪一下"没有盘" */
    const ready = ref(false);

    /** 同一个响应可能因为连点被重取两次，只认最后一次 */
    let seq = 0;
    /**
     * 在飞闸门。
     * ⚠️ KeepAlive 的首次挂载会**先后触发** `onMounted` 与 `onActivated` ⇒ 两个调用点各发一次
     * `/getDisks`。`seq` 只保证"结果写对"，不省请求（2026-11-11 code review 抓到）。
     * 并发重取本来也没有意义（同一份内存快照），所以直接丢弃第二次。
     */
    let inFlight = false;

    const reload = async () => {
        if (inFlight) return;
        inFlight = true;
        const my = ++seq;
        try {
            const data = (await getAction(`${API_BASE}/getDisks`)) as DisksPayload;
            if (my !== seq) return;
            disks.value = (data?.disks ?? [])
                // 只留**有缓存**的盘（与缓存记录页 chip 同一规则）
                .filter(d => (d.folders || 0) > 0)
                .sort((a, b) => {
                    // 在线在前；同状态按盘符 / 序列号，和 chip 的排序逐字一致
                    if (a.online !== b.online) return a.online ? -1 : 1;
                    const ka = a.online ? a.drive : a.serial;
                    const kb = b.online ? b.drive : b.serial;
                    return String(ka).localeCompare(String(kb));
                })
                .map(d => ({
                    key: `${d.serial}|${d.drive || ''}`,
                    serial: d.serial,
                    name: d.online && d.drive ? `${d.drive}:` : `序列号 ${d.serial.slice(-4)}`,
                    online: d.online,
                    folders: d.folders || 0,
                    entries: d.covers || 0,
                    timeLine: timeLineOf(d),
                    tops: d.tops ?? [],
                }));
        } catch (e) {
            // 首页取不到盘列表**不弹通知**：它不是用户主动发起的动作，
            // 而且此时界面上还有"还没选文件夹"那条灰字兜底，弹窗只会更吵。
            if (my === seq) console.warn('[home-disks] 取盘列表失败', e);
        } finally {
            inFlight = false;
            if (my === seq) ready.value = true;
        }
    };

    /** 有没有可点的东西 —— 首页空态（一行灰字）据此决定要不要让位 */
    const hasCards = computed(() => disks.value.length > 0);

    return { disks, ready, hasCards, reload };
}
