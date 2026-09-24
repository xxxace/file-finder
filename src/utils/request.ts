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
 * 后端出错时也返回 HTTP 200，只靠 body 里的 code 区分；
 * 这里不检查就会让调用方拿到 {code:500} 还提示"成功"。
 *
 * **所有 HTTP 出入都必须过这里**（下面三个 action 是唯一入口）。
 * 历史教训：`FileFinder` 和 `HistoryTable` 里曾经各自手写裸 `fetch(...).then(res => res.json())`，
 * 于是"检查响应"这件事被复制成三份，其中两份漏掉了 —— 出错的响应一路走到
 * `tableData.value = undefined`，界面上一点提示都没有。
 * 检查散落多少份，就会漏多少份；收成一个咽喉点才不会再漏。
 */
function assertOk(response: Response, json: any) {
    if (!response.ok || (json && json.code && json.code !== 200)) {
        throw (json && json.error) ? json.error : `请求失败(${response.status})`
    }
    return json
}

export async function getAction(url: string) {
    const response = await fetch(apiUrl(url))

    const json = await response.json()
    return assertOk(response, json)
}

export async function postAction(url: string, data: object) {
    const response = await fetch(apiUrl(url), {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify(data)
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