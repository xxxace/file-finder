import { app, BrowserWindow, shell, ipcMain, dialog } from 'electron'
import { release } from 'os'
import { join, win32 } from 'path'
import '../server';
import '../utils/ffmpeg';
import { LOCAL_TOKEN } from '../server/token';
import config from '../config';

// Disable GPU Acceleration for Windows 7
if (release().startsWith('6.1')) app.disableHardwareAcceleration()

// Set application name for Windows 10+ notifications
if (process.platform === 'win32') app.setAppUserModelId(app.getName())

if (!app.requestSingleInstanceLock()) {
  app.quit()
  process.exit(0)
}

// Remove electron security warnings
// This warning only shows in development mode
// Read more on https://www.electronjs.org/docs/latest/tutorial/security
// process.env['ELECTRON_DISABLE_SECURITY_WARNINGS'] = 'true'

export const ROOT_PATH = {
  // /dist
  dist: join(__dirname, '../..'),
  // /dist or /public
  public: join(__dirname, app.isPackaged ? '../..' : '../../../public'),
}

let win: BrowserWindow | null = null
// Here, you can also use other preload
const preload = join(__dirname, '../preload/index.js')
const url = process.env.VITE_DEV_SERVER_URL as string
const indexHtml = join(ROOT_PATH.dist, 'index.html')

async function createWindow() {
  win = new BrowserWindow({
    title: 'Main window',
    icon: join(ROOT_PATH.public, 'favicon.ico'),
    height:860,
    autoHideMenuBar: true,
    webPreferences: {
      preload,
      // Warning: Enable nodeIntegration and disable contextIsolation is not secure in production
      // Consider using contextBridge.exposeInMainWorld
      // Read more on https://www.electronjs.org/docs/latest/tutorial/context-isolation
      nodeIntegration: true,
      contextIsolation: false,
    },
  })

  if (app.isPackaged) {
    win.loadFile(indexHtml)
  } else {
    win.loadURL(url)
    // Open devTool if the app is not packaged
    win.webContents.openDevTools()
  }

  // Make all links open with the browser, not with the application
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https:')) shell.openExternal(url)
    return { action: 'deny' }
  })
}

app.whenReady().then(createWindow)

app.on('window-all-closed', () => {
  win = null
  if (process.platform !== 'darwin') app.quit()
})

app.on('second-instance', () => {
  if (win) {
    // Focus on the main window if the user tried to open another
    if (win.isMinimized()) win.restore()
    win.focus()
  }
})

app.on('activate', () => {
  const allWindows = BrowserWindow.getAllWindows()
  if (allWindows.length) {
    allWindows[0].focus()
  } else {
    createWindow()
  }
})

/**
 * 把本地服务的访问口令交给渲染层（渲染层见 `src/utils/request.ts`）。
 *
 * 这条通道本身就是凭证的一部分：**网页拿不到 `ipcRenderer`**，
 * 所以"能通过 IPC 问出口令"这件事，只有我们自己窗口里的代码做得到。
 * 这也正是口令能挡住"任意网页 fetch 127.0.0.1"的原因 —— 它能发请求，但拿不到口令。
 *
 * 用 `sendSync` 而不是 `invoke`：请求层在**模块加载时**就要用到口令，
 * 异步会逼着每一个请求都先 `await` 一个初始化 Promise。同步只发生这一次。
 */
ipcMain.on('ff-token', function (e) {
  e.returnValue = LOCAL_TOKEN;
});

/**
 * 让用户选一个文件夹。
 *
 * 必须用异步版 `showOpenDialog`：主进程同时跑着 3060 上的本地服务，同步版在对话框
 * 开着的整段时间里会按住事件循环 —— 那期间渲染层任何 /openFolder、/thumb 都得不到
 * 响应，界面就是卡死的。这不是体验问题，是并发正确性问题。
 *
 * 取消时仍然发 `undefined`（渲染层靠 `value ? value[0] : ''` 清空输入框），语义与原来逐字一致。
 */
ipcMain.on('openDirectory', async function () {
  const target = win;
  if (!target) return;

  const { canceled, filePaths } = await dialog.showOpenDialog(target, {
    properties: ['openDirectory']
  });

  target.webContents.send('directory-changed', canceled ? undefined : filePaths);
});

/**
 * 用系统默认程序打开一个文件。
 *
 * 原来是 `child_process.exec(fullpath)` —— 把**路径**当**命令行**交给 cmd 执行。
 * 路径是数据不是命令：空格、中文、`&`、`(`、`)`、`'`、`#` 都会让它变成另一条命令行，
 * 而"给它补引号"是补不完的（渲染层为此写了一整段按 `/` 切开再包引号的 hack，仍然漏）。
 * `shell.openPath` 收的就是路径本身，这些问题从定义上不存在，命令注入面一起消失。
 *
 * 用 handle 而不是 on，是为了把失败回传：原来 exec 失败只 console.log，
 * 界面上一点动静都没有 —— 那些"双击没反应"其实就是静默失败。
 * openPath 用返回值表示结果：成功是空串，失败是错误描述。
 */
ipcMain.handle('openFile', async function (_e, target: string) {
  if (!target) return '';
  // 渲染层拼路径用的是 `/`，这里归一化成 Windows 形式再交给 ShellExecute
  return shell.openPath(win32.normalize(target));
});

/**
 * 打开缓存数据目录。
 *
 * 这就是这套缓存**全部**的「导出 / 导入」手段：数据就是 `searchCache.db` 一个文件，
 * 拷走 = 导出，覆盖回去 = 导入。所以这里只做"带你去那个文件夹"，复制/替换交给
 * 系统文件管理器 —— 它自带回收站和撤销，比在应用内做一个"覆盖全库"的按钮安全得多
 * （理由见 docs/DESIGN-CONVERGED-2026-09-24.md §三）。
 *
 * 复用 `shell.openPath`：它对目录会开资源管理器、对文件才用默认程序 ——
 * 和上面的 openFile 是同一条路，不新增机制。失败同样返回错误描述（成功是空串）。
 */
ipcMain.handle('openDataDir', async function () {
  return shell.openPath(config.userBasePath);
});

/**
 * 让用户挑一个「把缓存备份到哪」。
 *
 * 这里**只负责选路径**，复制由服务端的 `/backupToFile` 做 —— 主进程碰不到
 * nedb 那个模块的状态，硬在这里复制就等于把"库在哪 / 怎么改库"再抄一份出来。
 * 分工跟 `openDirectory`（IPC 选目录 → HTTP 真读）完全一致：**需要系统能力的那一步
 * 才进主进程，数据本身的操作留在服务端**。
 *
 * 用异步版 `showSaveDialog`：同步版会在对话框开着的整段时间按住事件循环，
 * 那期间 3060 上任何请求都得不到响应 —— 和 `openDirectory` 是同一个理由。
 *
 * `handle` 而不是 `send`：结果要**回传给点按钮的那一次调用**，
 * 否则渲染层只能靠一个全局事件去猜"这次对话框是给谁的"。
 */
ipcMain.handle('pickCacheSavePath', async function () {
  const target = win;
  if (!target) return { canceled: true, filePath: '' };

  const { canceled, filePath } = await dialog.showSaveDialog(target, {
    title: '把缓存备份到文件',
    defaultPath: join(config.userBasePath, 'searchCache.db'),
    filters: [{ name: '缓存库', extensions: ['db'] }],
  });

  return { canceled, filePath: canceled ? '' : filePath };
});

/**
 * 让用户挑一个「要读进来的缓存文件」。还原和合并共用它 ——
 * 两者的差别只在**读进来之后怎么办**，选文件这一步逐字相同，分成两个 handler
 * 只会多一份要同步维护的对话框配置。
 */
ipcMain.handle('pickCacheOpenPath', async function () {
  const target = win;
  if (!target) return { canceled: true, filePath: '' };

  const { canceled, filePaths } = await dialog.showOpenDialog(target, {
    title: '选择缓存文件',
    defaultPath: config.userBasePath,
    properties: ['openFile'],
    filters: [{ name: '缓存库', extensions: ['db'] }],
  });

  return { canceled, filePath: canceled ? '' : (filePaths[0] || '') };
});