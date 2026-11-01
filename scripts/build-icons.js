// Gera build/icon.png (1024) e build/icon.icns a partir de build/icon.svg.
// Uso: npm run icons
const { app, BrowserWindow } = require('electron');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const buildDir = path.join(__dirname, '..', 'build');
const svg = path.join(buildDir, 'icon.svg');
const png = path.join(buildDir, 'icon.png');

app.dock?.hide();

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1024,
    height: 1024,
    show: false,
    transparent: true,
    frame: false,
    useContentSize: true,
    webPreferences: { offscreen: true },
  });
  const html = `<html><body style="margin:0;background:transparent">${fs.readFileSync(svg, 'utf8')}</body></html>`;
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  await new Promise((r) => setTimeout(r, 300));
  const image = (await win.capturePage()).resize({ width: 1024, height: 1024, quality: 'best' });
  fs.writeFileSync(png, image.toPNG());
  console.log('ok', png);

  if (process.platform === 'darwin') {
    const iconset = path.join(buildDir, 'icon.iconset');
    fs.rmSync(iconset, { recursive: true, force: true });
    fs.mkdirSync(iconset);
    for (const size of [16, 32, 128, 256, 512]) {
      for (const scale of [1, 2]) {
        const px = size * scale;
        const name = `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`;
        execFileSync('sips', ['-z', String(px), String(px), png, '--out', path.join(iconset, name)], { stdio: 'ignore' });
      }
    }
    execFileSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(buildDir, 'icon.icns')]);
    fs.rmSync(iconset, { recursive: true, force: true });
    console.log('ok', path.join(buildDir, 'icon.icns'));
  }
  app.quit();
});
