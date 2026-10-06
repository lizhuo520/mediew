'use strict';

const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  clipboard
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = fs.promises;

const { MediaService } = require('./services/media-service');

let win = null;
let mediaService = null;
let currentWatcher = null;
let watchedPath = null;
let debounceTimer = null;
let isReadyToQuit = false;

/**
 * 窗口状态迁移到 userData 目录，避免安装目录不可写时保存失败。
 */
function getStateFile() {
  return path.join(app.getPath('userData'), 'window-state.json');
}

/**
 * 启动时只读取一次窗口状态，属于轻量同步操作，不会影响渲染性能。
 */
function loadWindowState() {
  try {
    return JSON.parse(fs.readFileSync(getStateFile(), 'utf8'));
  } catch (_) {
    return { width: 1200, height: 800, x: undefined, y: undefined };
  }
}

/**
 * 关闭窗口时异步保存状态，不阻塞界面关闭流程。
 */
function saveWindowState() {
  if (!win || win.isDestroyed()) return;
  const state = { ...win.getBounds(), isMaximized: win.isMaximized() };
  fsp.mkdir(path.dirname(getStateFile()), { recursive: true })
    .then(() => fsp.writeFile(getStateFile(), JSON.stringify(state), 'utf8'))
    .catch(() => {});
}

function createWindow() {
  const state = loadWindowState();
  win = new BrowserWindow({
    width: state.width || 1200,
    height: state.height || 800,
    x: state.x,
    y: state.y,
    frame: false,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: '#15202b',
    icon: path.join(__dirname, 'build', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: true
    }
  });

  if (state.isMaximized) win.maximize();
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  win.on('close', () => {
    stopWatching();
    saveWindowState();
  });
}

/**
 * 按当前设置对主进程返回的快照排序。
 * EXIF 只在后台补充，因此排序始终基于可靠的 mtime 或文件名，不会因异步更新跳动。
 */
function sortMedia(items, sortMode, sortDir) {
  const list = Array.isArray(items) ? items : [];
  if (sortMode === 'filename') {
    list.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }));
    if (sortDir !== 'asc') list.reverse();
  } else {
    list.sort((a, b) => a.mtime - b.mtime);
    if (sortDir !== 'asc') list.reverse();
  }
  return list;
}

/**
 * 目录读取改为两阶段：立即返回基础文件信息，后台分批合并 EXIF。
 */
ipcMain.handle('read-directory', async (event, dirPath, sortMode, sortDir, recursive) => {
  if (!mediaService) return { scanId: null, items: [], pendingCount: 0 };
  const sender = event.sender;
  try {
    const result = await mediaService.startDirectoryScan(dirPath, {
      recursive: Boolean(recursive),
      onBatch: (payload) => {
        if (!sender.isDestroyed()) sender.send('media-metadata-updated', payload);
      },
      onComplete: (payload) => {
        if (!sender.isDestroyed()) sender.send('media-metadata-complete', payload);
      },
      onError: (error) => {
        if (!sender.isDestroyed()) {
          sender.send('media-scan-error', { message: error && error.message ? error.message : '目录读取失败' });
        }
      }
    });
    sortMedia(result.items, sortMode, sortDir);
    return result;
  } catch (error) {
    return { scanId: null, items: [], pendingCount: 0, error: error.message };
  }
});

ipcMain.handle('cancel-directory-scan', async () => {
  if (mediaService) mediaService.cancelActiveScan();
  return { success: true };
});

// 缩略图和 RAW/大格式预览由主进程生成并缓存，渲染层只接收 file:// 地址。
ipcMain.handle('get-thumbnail', async (event, filePath, size) => {
  return mediaService ? mediaService.getThumbnail(filePath, size) : { success: false, error: '服务尚未初始化' };
});

ipcMain.handle('get-preview', async (event, filePath) => {
  return mediaService ? mediaService.getPreview(filePath) : { success: false, error: '服务尚未初始化' };
});

ipcMain.handle('prepare-preview', async (event, filePath) => {
  if (mediaService) mediaService.preparePreview(filePath);
  return { success: true };
});

ipcMain.handle('get-subfolders', async (event, dirPath) => {
  try {
    return mediaService ? await mediaService.getSubfolders(dirPath) : [];
  } catch (_) {
    return [];
  }
});

ipcMain.handle('select-directory', async () => {
  const result = await dialog.showOpenDialog(win, {
    properties: ['openDirectory'],
    title: '选择媒体目录'
  });
  return result.canceled ? null : { path: result.filePaths[0] };
});

// 收藏状态持久化在 userData 目录，不修改用户媒体文件。
ipcMain.handle('toggle-favorite', async (event, filePath) => {
  return mediaService ? mediaService.toggleFavorite(filePath) : { success: false };
});

ipcMain.handle('copy-file-path', async (event, filePath) => {
  clipboard.writeText(filePath);
  return { success: true };
});

ipcMain.handle('show-file-in-explorer', async (event, filePath) => {
  shell.showItemInFolder(filePath);
  return { success: true };
});

// 目录监听仍采用 fs.watch，但将刷新消息合并到更短的 800ms 窗口。
function startWatching(dirPath) {
  stopWatching();
  try {
    currentWatcher = fs.watch(dirPath, (eventType) => {
      if (eventType !== 'rename' && eventType !== 'change') return;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        if (win && !win.isDestroyed()) win.webContents.send('directory-changed', dirPath);
      }, 800);
    });
    currentWatcher.on('error', stopWatching);
    watchedPath = dirPath;
  } catch (_) {
    currentWatcher = null;
    watchedPath = null;
  }
}

function stopWatching() {
  if (currentWatcher) {
    currentWatcher.close();
    currentWatcher = null;
  }
  watchedPath = null;
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
}

ipcMain.on('watch-directory', (event, dirPath) => startWatching(dirPath));
ipcMain.on('unwatch-directory', () => stopWatching());

// 文件操作统一使用异步 fs，避免大目录或网络盘操作造成主进程假死。
ipcMain.handle('delete-file', async (event, filePath) => {
  const result = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: ['删除', '取消'],
    defaultId: 1,
    title: '确认删除',
    message: '确定要删除这个文件吗？',
    detail: path.basename(filePath)
  });
  if (result.response !== 0) return { success: false };
  try {
    await shell.trashItem(filePath);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('delete-files', async (event, filePaths) => {
  const paths = Array.isArray(filePaths) ? filePaths : [];
  const result = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: ['删除', '取消'],
    defaultId: 1,
    title: '确认删除',
    message: `确定要删除这 ${paths.length} 个文件吗？`,
    detail: paths.map((item) => path.basename(item)).join('\n')
  });
  if (result.response !== 0) return { success: false };

  const outcomes = await Promise.allSettled(paths.map((filePath) => shell.trashItem(filePath)));
  const successCount = outcomes.filter((item) => item.status === 'fulfilled').length;
  return { success: successCount > 0, successCount };
});

ipcMain.handle('rename-file', async (event, filePath, newName) => {
  try {
    const dir = path.dirname(filePath);
    const ext = path.extname(filePath);
    const cleanName = String(newName || '').trim();
    if (!cleanName) return { success: false, error: '文件名不能为空' };
    const nameWithoutExt = cleanName.includes('.') ? cleanName.replace(/\.[^.]+$/, '') : cleanName;
    const finalName = `${nameWithoutExt}${ext}`;
    const newPath = path.join(dir, finalName);
    if (filePath === newPath) return { success: true, newPath: filePath };
    try {
      await fsp.access(newPath);
      return { success: false, error: '文件已存在' };
    } catch (_) {}
    await fsp.rename(filePath, newPath);
    return { success: true, newPath };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('move-file', async (event, filePath, destDir) => {
  try {
    const destPath = path.join(destDir, path.basename(filePath));
    if (filePath === destPath) return { success: false, error: '文件已在该目录' };
    try {
      await fsp.access(destPath);
      return { success: false, error: '目标文件夹已存在同名文件' };
    } catch (_) {}
    await fsp.rename(filePath, destPath);
    return { success: true, newPath: destPath };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('create-folder', async (event, parentDir, folderName) => {
  try {
    const newPath = path.join(parentDir, folderName);
    try {
      await fsp.access(newPath);
      return { success: false, error: '文件夹已存在' };
    } catch (_) {}
    await fsp.mkdir(newPath);
    return { success: true, path: newPath };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('delete-folder', async (event, dirPath) => {
  const result = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: ['删除', '取消'],
    defaultId: 1,
    title: '确认删除文件夹',
    message: '确定要删除这个文件夹吗？',
    detail: `${dirPath}\n\n文件夹内的所有内容都将被删除。`
  });
  if (result.response !== 0) return { success: false };
  if (watchedPath && (watchedPath === dirPath || watchedPath.startsWith(`${dirPath}${path.sep}`))) stopWatching();
  try {
    await shell.trashItem(dirPath);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('delete-folders', async (event, dirPaths) => {
  const paths = Array.isArray(dirPaths) ? dirPaths : [];
  const result = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: ['删除', '取消'],
    defaultId: 1,
    title: '确认删除文件夹',
    message: `确定要删除这 ${paths.length} 个文件夹吗？`,
    detail: `${paths.map((item) => path.basename(item)).join('\n')}\n\n文件夹内的所有内容都将被删除。`
  });
  if (result.response !== 0) return { success: false };
  if (watchedPath && paths.some((dirPath) => watchedPath === dirPath || watchedPath.startsWith(`${dirPath}${path.sep}`))) {
    stopWatching();
  }
  const outcomes = await Promise.allSettled(paths.map((dirPath) => shell.trashItem(dirPath)));
  const successCount = outcomes.filter((item) => item.status === 'fulfilled').length;
  return { success: successCount > 0, successCount };
});

ipcMain.handle('rename-folder', async (event, dirPath, newName) => {
  try {
    const newPath = path.join(path.dirname(dirPath), String(newName || '').trim());
    if (dirPath === newPath) return { success: true, newPath: dirPath };
    try {
      await fsp.access(newPath);
      return { success: false, error: '文件夹已存在' };
    } catch (_) {}
    await fsp.rename(dirPath, newPath);
    return { success: true, newPath };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('move-folder', async (event, srcPath, destDir) => {
  try {
    const destPath = path.join(destDir, path.basename(srcPath));
    if (srcPath === destPath) return { success: false, error: '不能移动到自身' };
    if (destPath.startsWith(`${srcPath}${path.sep}`)) return { success: false, error: '不能移动到自身子目录' };
    try {
      await fsp.access(destPath);
      return { success: false, error: '目标文件夹已存在同名文件夹' };
    } catch (_) {}
    await fsp.rename(srcPath, destPath);
    return { success: true, newPath: destPath };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('open-in-explorer', async (event, dirPath) => {
  try {
    await shell.openPath(dirPath);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// 自定义标题栏控制。
ipcMain.on('window-minimize', () => win && win.minimize());
ipcMain.on('window-maximize', () => {
  if (!win) return;
  win.isMaximized() ? win.unmaximize() : win.maximize();
});
ipcMain.on('window-close', () => win && win.close());

app.whenReady().then(async () => {
  mediaService = new MediaService({ userDataPath: app.getPath('userData') });
  await mediaService.initialize();
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// 退出前等待 ExifTool 子进程和缓存写入完成，避免遗留进程或缓存损坏。
app.on('will-quit', (event) => {
  if (isReadyToQuit || !mediaService) return;
  event.preventDefault();
  isReadyToQuit = true;
  stopWatching();
  mediaService.dispose().finally(() => app.exit(0));
});
