const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const svgFile = process.argv[2] || path.join(__dirname, 'test-icon.svg');
const outPng = process.argv[3] || path.join(__dirname, 'test-preview.png');

app.setPath('userData', path.join(os.tmpdir(), 'probe-icon-custom'));
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.disableHardwareAcceleration();

app.whenReady().then(async () => {
    const svg = fs.readFileSync(svgFile, 'utf8');
    const win = new BrowserWindow({
        show: false,
        width: 1024,
        height: 1024,
        useContentSize: true,
        frame: false,
        transparent: true,
        webPreferences: { offscreen: true, backgroundThrottling: false, contextIsolation: false },
    });

    const html = `<!doctype html><html><head><meta charset="utf-8"><style>
        html,body{margin:0;padding:0;background:transparent;overflow:hidden;width:1024px;height:1024px;}
        #box{width:1024px;height:1024px;}
        #box svg{display:block;width:100%;height:100%;}
    </style></head><body><div id="box">${svg}</div></body></html>`;

    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    await new Promise((r) => setTimeout(r, 600));

    const shot = await win.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 });
    fs.writeFileSync(outPng, shot.toPNG());
    console.log('Rendered to', outPng);
    win.destroy();
    app.quit();
}).catch((err) => {
    console.error(err);
    app.exit(1);
});
