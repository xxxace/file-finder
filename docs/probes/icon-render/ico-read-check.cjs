const { app, nativeImage } = require('electron');
const path = require('node:path');
app.whenReady().then(() => {
  const root = path.join(__dirname, '..', '..', '..');
  for (const p of ['build/icon.ico', 'public/favicon.ico', 'build/icon.png']) {
    const img = nativeImage.createFromPath(path.join(root, p));
    console.log(p + '  isEmpty=' + img.isEmpty() + '  size=' + JSON.stringify(img.getSize()));
  }
  app.quit();
});
