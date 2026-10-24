'use strict';

/**
 * 离屏 UI 冒烟测试：加载真实 renderer，用假 api 提供 30 张不同比例的 RAW 样片。
 * 验证：网格视觉顺序、缩略图请求顺序、灯箱双图层切换与计数器。
 *
 * 运行：electron.exe test/ui-harness.js
 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

app.disableHardwareAcceleration();

const outDir = process.env.MEDIEW_UI_OUT || __dirname;
fs.mkdirSync(outDir, { recursive: true });
const logFile = path.join(outDir, 'mediew-ui-harness.log');
fs.writeFileSync(logFile, '');
function log(message) {
  fs.appendFileSync(logFile, `${new Date().toISOString()} ${message}\n`);
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function run() {
  log('app ready');
  const watchdog = setTimeout(() => {
    log('WATCHDOG timeout');
    app.exit(3);
  }, 45000);
  const win = new BrowserWindow({
    width: 1500,
    height: 950,
    show: false,
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, 'ui-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      offscreen: true,
      backgroundThrottling: false
    }
  });

  log('window created');
  win.webContents.on('did-fail-load', (_event, code, description) => log(`did-fail-load ${code} ${description}`));
  win.webContents.on('render-process-gone', (_event, details) => log(`render-process-gone ${JSON.stringify(details)}`));
  win.webContents.on('console-message', (_event, level, message, line, source) => {
    log(`console[${level}] ${message} @${source}:${line}`);
  });
  win.webContents.on('preload-error', (_event, preloadPath, error) => {
    log(`preload-error ${preloadPath} ${error && error.stack ? error.stack : error}`);
  });
  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  log('loadFile done');
  const probe = await Promise.race([
    win.webContents.executeJavaScript('({ ok: true, value: 1 + 1, state: document.readyState })'),
    wait(6000).then(() => ({ timeout: true }))
  ]);
  log(`simple eval: ${JSON.stringify(probe)}`);
  const readyResult = await win.webContents.executeJavaScript(`
    new Promise((resolve) => {
      let ticks = 0;
      const timer = setInterval(() => {
        if (typeof App !== 'undefined' && typeof Waterfall !== 'undefined' && typeof Preview !== 'undefined' && document.readyState === 'complete') {
          clearInterval(timer);
          resolve({ ready: true });
        } else if (++ticks > 160) {
          clearInterval(timer);
          resolve({
            ready: false,
            hasApp: typeof App,
            hasWaterfall: typeof Waterfall,
            hasPreview: typeof Preview,
            hasApi: typeof window.api,
            hasMasonry: typeof window.MediewMasonry,
            hasOrientation: typeof window.MediewOrientation,
            hasSettings: typeof SettingsManager,
            scripts: Array.from(document.scripts).map((script) => script.getAttribute('src')),
            readyState: document.readyState
          });
        }
      }, 50);
    })
  `);
  log(`ready check: ${JSON.stringify(readyResult)}`);
  if (!readyResult.ready) {
    throw new Error(`渲染层未初始化完成：${JSON.stringify(readyResult)}`);
  }
  log('App/Waterfall/Preview ready');

  const gridResult = await win.webContents.executeJavaScript(`
    (async () => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      await App.loadDirectory('D:/Fake');
      for (let i = 0; i < 120; i += 1) {
        if (document.querySelectorAll('.image-card.thumbnail-loaded').length >= 30) break;
        await wait(50);
      }
      const cards = Array.from(document.querySelectorAll('.image-card'));
      const rects = cards.map((card, index) => {
        const rect = card.getBoundingClientRect();
        return { index, top: Math.round(rect.top), left: Math.round(rect.left), width: Math.round(rect.width), height: Math.round(rect.height) };
      });
      const readingOrderOk = rects.every((rect, index) => {
        if (index === 0) return true;
        const prev = rects[index - 1];
        return rect.top > prev.top + 1 || (Math.abs(rect.top - prev.top) <= 1 && rect.left > prev.left);
      });
      const rows = [];
      rects.forEach((rect) => {
        const row = rows[rows.length - 1];
        if (row && Math.abs(row.top - rect.top) <= 1) row.items.push(rect.index);
        else rows.push({ top: rect.top, items: [rect.index] });
      });
      const thumbOrder = window.api.getThumbnailOrder().map((filePath) => Number(filePath.match(/(\\d+)\\.cr2/)[1]));
      return {
        cardCount: cards.length,
        loadedCount: document.querySelectorAll('.image-card.thumbnail-loaded').length,
        readingOrderOk,
        rows: rows.map((row) => row.items),
        thumbOrder,
        thumbOrderAscending: thumbOrder.every((value, index) => index === 0 || value >= thumbOrder[index - 1]),
        gridStyle: {
          display: getComputedStyle(document.getElementById('image-grid')).display,
          autoRows: getComputedStyle(document.getElementById('image-grid')).gridAutoRows,
          columns: getComputedStyle(document.getElementById('image-grid')).gridTemplateColumns
        }
      };
    })()
  `);

  log(`grid measured: ${JSON.stringify(gridResult)}`);
  const gridShot = await win.webContents.capturePage();
  log('grid screenshot captured');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'mediew-ui-grid.png'), gridShot.toPNG());

  const previewResult = await win.webContents.executeJavaScript(`
    (async () => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      window.api.resetOrders();
      Preview.open(Waterfall.imageList, 0);
      for (let i = 0; i < 80; i += 1) {
        if (Preview.image.classList.contains('loaded')) break;
        await wait(30);
      }
      const firstLayer = Preview.image.id;
      const firstTransition = getComputedStyle(Preview.image).transitionProperty;
      const firstCounter = document.querySelector('.preview-counter').textContent;
      Preview.next();
      await wait(90);
      const mid = {
        index: Preview.currentIndex,
        activeLayer: Preview.image.id,
        loadedLayers: document.querySelectorAll('.preview-image-layer.loaded').length
      };
      await wait(650);
      const layers = Array.from(document.querySelectorAll('.preview-image-layer'));

      Preview.rotateBy(90);
      await wait(360);
      const rotated = {
        rotation: Preview.rotation,
        transform: Preview.image.style.transform,
        dimensions: document.getElementById('info-dimensions').textContent
      };

      await Preview.toggleOriginal();
      await wait(600);
      const original = {
        showing: Preview._showingOriginal,
        scale: Preview.scale,
        buttonText: document.getElementById('preview-original').textContent,
        buttonActive: document.getElementById('preview-original').classList.contains('active'),
        fullRequests: window.api.getPreviewFullRequests().length
      };

      // 还原到适应窗口 / 0°，截图保持常规预览状态
      await Preview.toggleOriginal();
      await wait(360);
      Preview.rotateBy(-90);
      await wait(360);

      return {
        rotated,
        original,
        firstLayer,
        firstTransition,
        firstCounter,
        mid,
        after: {
          index: Preview.currentIndex,
          activeLayer: Preview.image.id,
          loadedLayers: document.querySelectorAll('.preview-image-layer.loaded').length,
          counter: document.querySelector('.preview-counter').textContent,
          opacities: layers.map((layer) => layer.style.opacity),
          dimensions: document.getElementById('info-dimensions').textContent
        },
        previewOrder: window.api.getPreviewOrder().map((filePath) => Number(filePath.match(/(\\d+)\\.cr2/)[1]))
      };
    })()
  `);

  log(`preview measured: ${JSON.stringify(previewResult)}`);
  const previewShot = await win.webContents.capturePage();
  log('preview screenshot captured');
  fs.writeFileSync(path.join(outDir, 'mediew-ui-preview.png'), previewShot.toPNG());

  const result = { grid: gridResult, preview: previewResult, shots: [path.join(outDir, 'mediew-ui-grid.png'), path.join(outDir, 'mediew-ui-preview.png')] };
  clearTimeout(watchdog);
  console.log(JSON.stringify(result, null, 2));
  log('result written');
  win.destroy();
  app.quit();
  process.exit(0);
}

app.whenReady().then(run).catch((error) => {
  console.error('UI harness failed:', error && error.stack ? error.stack : error);
  app.exit(1);
});
