// 探针里替代 electron：只需要 `ipcRenderer.sendSync('ff-token')` 不炸
export const ipcRenderer = {
    sendSync: () => '',
    send: () => undefined,
    invoke: () => Promise.resolve(undefined),
    on: () => undefined,
    removeListener: () => undefined,
};
export default { ipcRenderer };
