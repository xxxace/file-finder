import { ipcRenderer } from 'electron';

/**
 * 本地服务的访问口令，由主进程启动时随机生成，只通过 IPC 交给渲染层。
 *
 * 为什么需要：这是个裸 HTTP 服务，**任何网页**都能朝 127.0.0.1:3060 发请求。
 * 浏览器会拦掉"跨域读响应"，但**请求照样会打进来被执行** —— 光 `/getFileTree`
 * 一条就能让主进程递归遍历整块盘。
 *
 * 为什么不能用 `Origin` 名单代替：打包后应用自己就跑在 `file://`，Origin 是
 * 字面量 `'null'` —— 和任意恶意 `file://` / `data:` 页面**无法区分**。
 *
 * 用 `sendSync`：地址是同步拼出来的，异步会逼着每个请求都先 await 一个初始化 Promise。
 * 只在模块加载时发生一次。
 */
const TOKEN = ipcRenderer.sendSync('ff-token') as string | undefined;

// 拿不到口令 = 每个请求都会被服务端 403，而界面上只会显示"请求失败"。
// 那种断裂必须是**响的**：频道名在 electron/main/index.ts 里也写了一份，
// 改一处忘另一处就会走到这里。
if (!TOKEN) {
    console.error('[request] 没拿到本地服务口令 —— 检查 electron/main/index.ts 的 ipcMain.on(\'ff-token\')');
}

/**
 * 本地服务的地址 —— **所有对它的引用都从这里取**。
 *
 * 为什么收在这里：曾经 11 个文件各写一份字面量（页面一多就再抄一份），
 * 改端口要逐个找，漏一个的表现是"那个页面永远转圈"。
 *
 * 统一写 127.0.0.1 而不是 localhost：个别机器会把 localhost 解析到 ::1，
 * 而服务端只绑 IPv4 ⇒ 每个请求都要先失败一次再回落。
 */
export const API_BASE = 'http://127.0.0.1:3060';

/**
 * 拼一个带口令的接口地址。
 *
 * **所有对本地服务的 URL 都必须由这里产生。** 口令放在 URL 里而不是请求头，
 * 是因为缩略图/预览图是靠 `<img src>` 取的，而浏览器**不会给 `<img>` 加自定义请求头**。
 * 放 URL 里才能让 fetch 和 `<img>` 共用同一个机制、同一个出口。
 */
export function apiUrl(url: string): string {
    return `${url}${url.includes('?') ? '&' : '?'}t=${TOKEN ?? ''}`;
}

/**
 * 本地服务返回的业务错误。
 *
 * **为什么不让 `assertOk` 继续 `throw` 一个字符串**：前端要区分「盘不在」（插上盘再试）
 * 和「读不到」（只能等）—— 那是两种不同的用户动作，对应两套不同的提示。
 * 用字符串就得 match 文案，服务端改一个字，判别就静默失效、提示说错话。
 * 分类放进结构化字段，文案怎么改都不影响判别。
 *
 * `toString()` 覆盖成只返回 message：调用方一贯写 `String(err)` 直接当提示文案，
 * 覆盖之后行为和"抛字符串"**逐字一致**，它们一行都不用改。
 */
export class ApiError extends Error {
    /** 服务端给的机器可读分类（`kind`）：'offline' | 'unreadable' | 'unknown' … */
    readonly kind: string;
    constructor(message: string, kind: string) {
        super(message);
        this.kind = kind;
    }
    toString() {
        return this.message;
    }
}

/**
 * 后端出错也返回 HTTP 200，只靠 body 的 code 区分 —— 不检查会让调用方拿到 {code:500} 还提示"成功"。
 * ⚠️ 所有 HTTP 出入必须过这个唯一咽喉点：检查散落几份就会漏几份，收成一处才不会再漏。
 */
function assertOk(response: Response, json: any) {
    if (!response.ok || (json && json.code && json.code !== 200)) {
        const message = (json && json.error) ? json.error : `请求失败(${response.status})`
        throw new ApiError(message, (json && json.kind) || 'unknown')
    }
    return json
}

export async function getAction(url: string) {
    const response = await fetch(apiUrl(url))

    const json = await response.json()
    return assertOk(response, json)
}

/**
 * `opts.signal`：长请求（试跑 / 点选 / 录制）要能取消 —— abort 会断开连接，
 * 服务端据此销毁抓取窗（见服务端 `abortOnClose`），不用白等到超时。
 */
export async function postAction(url: string, data: object, opts?: { signal?: AbortSignal }) {
    const response = await fetch(apiUrl(url), {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify(data),
        signal: opts?.signal,
    })

    const json = await response.json()
    return assertOk(response, json)
}

export async function deletAction(url: string) {
    const response = await fetch(apiUrl(url), {
        method: "DELETE",
    })

    const json = await response.json()
    return assertOk(response, json)
}