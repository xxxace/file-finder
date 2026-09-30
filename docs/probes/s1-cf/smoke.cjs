// 最小 smoke：验证沙箱里能否启动隐藏窗并尝试导航（仅用于环境探测，不进真实 spike 逻辑）
const { app, BrowserWindow } = require('electron');
app.whenReady().then(async () => {
  console.log('ELECTRON_READY');
  const w = new BrowserWindow({
    show: false,
    webPreferences: {
      partition: 'persist:assistant',
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    },
  });
  console.log('HIDDEN_WINDOW_CREATED');
  try {
    await w.loadURL('https://www.javbus.com/ABP-123', { timeout: 12000 });
    console.log('NAV_RESOLVED url=' + w.webContents.getURL());
  } catch (e) {
    console.log('NAV_TIMEOUT_OR_FAIL: ' + e.message);
  }
  setTimeout(() => { console.log('SMOKE_DONE'); app.quit(); }, 3000);
});
app.on('window-all-closed', () => {});
